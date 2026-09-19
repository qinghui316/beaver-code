import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ProviderRealtimeEvent,
  type ProviderRegistry,
  type ProviderTurnResult,
} from "../provider-runtime/index.js";
import { resolveStoredExecutionContract } from "../provider-runtime/execution-contract.js";
import { parseAgentAccessPolicy } from "../provider-runtime/agent-access-policy.js";
import { defaultProjectRuntimeActivityRegistry } from "../project-runtime/activity.js";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../project-runtime/paths.js";
import { buildCanonicalCaptureWrites } from "./provider-capture-persistence.js";
import { forwardProviderRealtimeEvent } from "./provider-live-events.js";
import { createAssistantTranscriptCapture } from "./live-transcript.js";
import { CanonicalTimelineDelivery, publishCanonicalTimelineEnvelope, publishCommittedCanonicalTimelineRow } from "./canonical-timeline-delivery.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import { fromStoredThreadMessage } from "./conversation-thread-log.js";
import { AgentNativeChildLifecycleService, NATIVE_CHILD_AGENT_ROLE_ID } from "./agent-native-child-lifecycle-service.js";
import { buildConversationInteractionQueue } from "./conversation-interactions.js";
import { ProviderInteractionLifecycleOwner } from "./provider-input-lifecycle.js";
import { publishAgentSurfacesInvalidated } from "./project-live-events.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type { StoredTopicMessage, StoredTopicMessageWrite } from "./persistence/contracts.js";
import type { WorkbenchDatabase } from "./persistence/database.js";
import type {
  ConversationTurnExecutionPorts,
  ConversationTurnStrategy,
  ConversationTurnStrategyInput,
  ConversationTurnStrategyPreflightInput,
  TurnSkillContextResolution,
} from "./conversation-turn-contract.js";
import type { TopicMessageResult, TopicThreadEntry } from "./types.js";
import { TurnAttachmentResolver } from "./turn-attachment-resolver.js";
import type { ConversationTurnControlOwner, ConversationTurnRegistration } from "./conversation-turn-control.js";
import type { ConversationContextLifecycleOwner } from "./conversation-context-lifecycle.js";

type DirectAgentProviderRegistry = Pick<ProviderRegistry, "findActiveTurn" | "get">;
type OpenWorkbenchDatabase = typeof openProjectRuntimeWorkbenchDatabase;

const activeDirectAgentConversations = new Set<string>();

export interface DirectAgentConversationTurnStrategyOptions {
  providerRegistry: DirectAgentProviderRegistry;
  openDatabase?: OpenWorkbenchDatabase;
  resolveRuntimePaths?: (projectId: string) => ProjectRuntimePaths;
  attachmentResolver?: TurnAttachmentResolver;
  turnControl?: ConversationTurnControlOwner;
  contextLifecycle?: ConversationContextLifecycleOwner;
}

export class DirectAgentConversationTurnStrategy implements ConversationTurnStrategy {
  readonly productMode = "agent" as const;

  private readonly providerRegistry: DirectAgentProviderRegistry;
  private readonly openDatabase: OpenWorkbenchDatabase;
  private readonly resolveRuntimePaths: (projectId: string) => ProjectRuntimePaths;
  private readonly attachmentResolver: TurnAttachmentResolver;
  private readonly turnControl?: ConversationTurnControlOwner;
  private readonly contextLifecycle?: ConversationContextLifecycleOwner;

  constructor(options: DirectAgentConversationTurnStrategyOptions) {
    this.providerRegistry = options.providerRegistry;
    this.openDatabase = options.openDatabase ?? openProjectRuntimeWorkbenchDatabase;
    this.resolveRuntimePaths = options.resolveRuntimePaths ?? ((projectId) => resolveProjectRuntimePaths(projectId));
    this.attachmentResolver = options.attachmentResolver ?? new TurnAttachmentResolver({
      resolveRuntimePaths: this.resolveRuntimePaths,
    });
    this.turnControl = options.turnControl;
    this.contextLifecycle = options.contextLifecycle;
  }

  preflight(input: ConversationTurnStrategyPreflightInput): void {
    validateTurnIdentity(input);
  }

  async execute(
    input: ConversationTurnStrategyInput,
    ports: ConversationTurnExecutionPorts,
  ): Promise<TopicMessageResult> {
    this.preflight(input);
    const accessPolicy = parseAgentAccessPolicy(input.admission.accessPolicy);
    if (!accessPolicy || accessPolicy.sandboxPolicy !== input.admission.sandboxPolicy
      || JSON.stringify(accessPolicy.writableRoots) !== JSON.stringify(input.admission.writableRoots)
      || (input.admission.agentTurnMode === "plan" && accessPolicy.sandboxPolicy !== "read-only")) {
      throw conflict("Agent Turn requires consistent admitted access evidence.");
    }
    const activityKey = `${input.project.id}:${input.conversation.conversationId}`;
    if (activeDirectAgentConversations.has(activityKey)) {
      throw conflict("Direct Agent Conversation already has an active Turn.");
    }
    activeDirectAgentConversations.add(activityKey);
    return defaultProjectRuntimeActivityRegistry
      .run(input.project.id, () => this.executeActivity(input, ports, accessPolicy))
      .finally(() => activeDirectAgentConversations.delete(activityKey));
  }

  private async executeActivity(
    input: ConversationTurnStrategyInput,
    _ports: ConversationTurnExecutionPorts,
    accessPolicy: import("../provider-runtime/agent-access-policy.js").AgentAccessPolicy,
  ): Promise<TopicMessageResult> {
    const user = fromStoredThreadMessage(input.committedMessage);

    const skillContext = input.turnSkillResolution;
    if (!skillContext) throw new Error("Direct Agent Turn Skill resolution is not composed.");
    const paths = this.resolveRuntimePaths(input.project.id);
    if (paths.projectId !== input.project.id) {
      throw new Error("Direct Agent runtime paths do not match the selected project identity.");
    }
    const capabilitySnapshot = input.admission.capabilitySnapshot;
    if (!capabilitySnapshot) throw new Error("Direct Agent Turn admission is missing its Provider capability snapshot.");
    const attachmentResolution = input.admission.attachmentResolution
      ?? (input.attachments.length === 0 ? await this.attachmentResolver.resolve(input.project, []) : null);
    if (!attachmentResolution) throw conflict("Direct Agent Turn admission is missing its attachment resolution.");

    const graphScopeId = input.conversation.currentGraphScopeId;
    if (!graphScopeId) throw new Error("Direct Agent Conversation requires a current graph scope.");
    const runId = input.executionIdentity?.runId ?? `agent-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const attemptId = input.executionIdentity?.attemptId ?? `attempt-${randomUUID()}`;
    const runRoot = join(paths.runsRoot, "agent-conversations", input.conversation.conversationId, runId);
    await mkdir(runRoot, { recursive: true });

    const database = await this.openDatabase(paths);
    let attemptCreated = false;
    const terminalLifecycle: { state: "idle" | "committing" | "settled" } = { state: "idle" };
    let canonicalPersistenceError: Error | null = null;
    let liveMainThreadId: string | null = null;
    let providerInputTerminalized = false;
    let terminalRecoveryWrites: StoredTopicMessageWrite[] = [];
    const terminalRows: StoredTopicMessage[] = [];
    const conversation = assertCurrentConversation(database, input);
    const binding = database.providerAttempts.readConversationProviderBinding(
      paths.projectId,
      conversation.conversationId,
      input.providerId,
    );
    const existingSessionId = binding?.bindingStatus === "ready" && binding.nativeSessionId
      ? binding.nativeSessionId
      : null;
    const startedAt = new Date().toISOString();
    const model = input.admission.model;
    const reasoningEffort = input.admission.modelAdmission?.resolvedReasoningEffort ?? null;
    const skillInputs = [...skillContext.skillInputs];
    const handoffHash = directAgentHandoffHash(input, skillContext, attachmentResolution);
    const mainTimelineId = `assistant:${conversation.conversationId}:${input.providerId}:${runId}:main`;
    const turnRegistration: ConversationTurnRegistration = {
      projectId: paths.projectId,
      productMode: "agent",
      conversationId: conversation.conversationId,
      providerId: input.providerId,
      expectedAttemptId: attemptId,
      graphScopeId,
      runId,
      roleId: "main-agent",
      canSteer: capabilitySnapshot.capabilities.some((capability) => capability.key === "turn.steer" && capability.runtime === "ready"),
    };
    const delivery = new CanonicalTimelineDelivery(database, "agent", input.live);
    const capture = createAssistantTranscriptCapture(input.live, (snapshot) => {
      try {
        for (const write of buildCanonicalCaptureWrites({
          projectId: paths.projectId,
          conversationId: conversation.conversationId,
          graphScopeId,
          runId,
          providerId: input.providerId,
          attemptId,
          mainTimelineId,
          mainSessionId: liveMainThreadId ?? existingSessionId,
          snapshot,
        })) {
          if (write.agentSurfaceId === "main-agent") {
            delivery.upsert(write);
            continue;
          }
          if (!write.threadId) continue;
          const childLink = database.providerAttempts.listProviderThreads(paths.projectId, conversation.conversationId)
            .find((link) => link.providerId === input.providerId
              && link.providerThreadId === write.threadId
              && link.graphScopeId === graphScopeId
              && link.roleId === NATIVE_CHILD_AGENT_ROLE_ID);
          if (!childLink) continue;
          const childAttempt = database.providerAttempts.readProviderAttempt(paths.projectId, childLink.attemptId);
          if (!childAttempt) continue;
          const rows = childAttempt.status === "queued" || childAttempt.status === "running"
            ? database.unitOfWork.commitProviderCallback({
              projectId: paths.projectId,
              conversationId: conversation.conversationId,
              attemptId: childLink.attemptId,
              expectedGraphScopeId: graphScopeId,
              updatedAt: new Date().toISOString(),
              timelineMessages: [write],
            })
            : database.unitOfWork.commitProviderTerminalSupplement({
              projectId: paths.projectId,
              conversationId: conversation.conversationId,
              attemptId: childLink.attemptId,
              expectedGraphScopeId: graphScopeId,
              timelineMessages: [write],
            });
          delivery.publishCommittedMany(rows);
        }
        return true;
      } catch (error) {
        canonicalPersistenceError = asError(error);
        return false;
      }
    });
    const childLifecycle = new AgentNativeChildLifecycleService({
      database,
      projectId: paths.projectId,
      conversationId: conversation.conversationId,
      graphScopeId,
      runId,
      parentAttemptId: attemptId,
      providerId: input.providerId,
      providerAdapterVersion: this.providerRegistry.get(input.providerId).adapter.version,
      capabilitySnapshot,
      model,
      reasoningEffort,
      parentHandoffHash: handoffHash,
      deliveredThroughCompletedTurn: conversation.completedTurnSequence,
      capture,
      publish: (rows) => {
        for (const row of rows) publishCommittedCanonicalTimelineRow(input.live, row, "agent");
      },
      onInvalidated: () => undefined,
    });
    const providerInputLifecycle = new ProviderInteractionLifecycleOwner({
      runtime: paths,
      productMode: "agent",
      projectId: paths.projectId,
      conversationId: conversation.conversationId,
      graphScopeId,
      runId,
      providerId: input.providerId,
      attemptId,
      runtimeScopeId: conversation.conversationId,
      agentTurnMode: input.admission.agentTurnMode ?? "default",
      resolveApprovalIdentity: (threadId) => {
        const active = this.providerRegistry.findActiveTurn(conversation.conversationId);
        if (threadId === liveMainThreadId || threadId === existingSessionId || active?.session.sessionId === threadId) {
          return { attemptId, roleId: "main-agent" };
        }
        const child = childLifecycle.registeredForThread(threadId);
        return child ? { attemptId: child.attemptId, roleId: NATIVE_CHILD_AGENT_ROLE_ID } : null;
      },
      publisher: (envelope) => publishCanonicalTimelineEnvelope(input.live, envelope),
      onUpdated: async () => {
        input.live?.emit({
          event: "conversation.interactions.updated",
          data: await buildConversationInteractionQueue(paths, conversation.conversationId, graphScopeId, "agent"),
        });
        publishAgentSurfacesInvalidated(paths.projectId, {
          conversationId: conversation.conversationId,
          graphScopeId,
          reason: "interaction-updated",
        });
      },
      onError: (error) => {
        canonicalPersistenceError ??= error;
        const active = this.providerRegistry.findActiveTurn(conversation.conversationId);
        if (active?.attemptId === attemptId) void active.interrupt("provider-input-persistence-failed").catch(() => undefined);
      },
    });

    const terminalize = (result: ProviderTurnResult | null, status: "completed" | "interrupted" | "failed", failure?: Error): TopicThreadEntry | null => {
      if (terminalLifecycle.state !== "idle") throw new Error(`Direct Agent attempt already entered terminalization: ${attemptId}.`);
      terminalLifecycle.state = "committing";
      const completedAt = new Date().toISOString();
      const sessionId = result?.session?.sessionId ?? liveMainThreadId ?? existingSessionId;
      if (sessionId && liveMainThreadId !== sessionId) {
        bindMainThread(database, paths.projectId, attemptId, sessionId, runId);
        liveMainThreadId = sessionId;
      }
      const sessionRecoveryAnchor = result?.failureKind === "stale-session"
        ? resolveSessionRecoveryAnchor(database, paths.projectId, conversation.conversationId, graphScopeId, input.providerId, conversation.completedTurnSequence)
        : undefined;
      const writes = terminalCaptureWrites({
        projectId: paths.projectId,
        conversationId: conversation.conversationId,
        graphScopeId,
        runId,
        providerId: input.providerId,
        attemptId,
        mainTimelineId,
        sessionId,
        capture,
        result,
        status,
        failure,
        agentTurnMode: input.admission.agentTurnMode,
        modelId: input.admission.modelAdmission?.requested.modelId ?? null,
        reasoningEffort: input.admission.modelAdmission?.requested.reasoningEffort ?? null,
        sourceMessageId: input.committedMessage.id,
        completedTurnSequence: status === "completed" ? conversation.completedTurnSequence + 1 : undefined,
        retryLineage: input.retryLineage,
        sessionRecoveryAnchor,
      });
      terminalRecoveryWrites = writes;
      const terminal = database.unitOfWork.commitProviderTurnTerminal({
        projectId: paths.projectId,
        conversationId: conversation.conversationId,
        runId,
        mainAttemptId: attemptId,
        expectedGraphScopeId: graphScopeId,
        mainStatus: status,
        mainNativeSessionId: sessionId,
        childAttempts: childLifecycle.terminalAttempts(status === "interrupted" ? "interrupted" : "failed"),
        expectedCompletedTurnSequence: conversation.completedTurnSequence,
        advanceCompletedTurn: status === "completed",
        binding: {
          projectId: paths.projectId,
          conversationId: conversation.conversationId,
          providerId: input.providerId,
          nativeSessionId: sessionId,
          preferredModel: model,
          lastUsedAt: completedAt,
          bindingStatus: status === "completed" || (status === "interrupted" && Boolean(sessionId))
            ? "ready"
            : "stale",
        },
        updatedAt: completedAt,
        timelineMessages: writes,
      });
      terminalLifecycle.state = "settled";
      this.turnControl?.release(turnRegistration);
      terminalRows.push(...terminal.timelineRows, ...terminal.interactionRows);
      const assistantRow = [...terminal.timelineRows].reverse().find((row) => row.agentSurfaceId === "main-agent") ?? null;
      return assistantRow ? fromStoredThreadMessage(assistantRow) : null;
    };

    try {
      await this.attachmentResolver.revalidate(input.project, attachmentResolution);
      database.providerAttempts.createProviderAttempt({
        projectId: paths.projectId,
        conversationId: conversation.conversationId,
        attemptId,
        productMode: "agent",
        agentTurnMode: input.admission.agentTurnMode,
        graphScopeId,
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        parentAgentSurfaceId: null,
        operationProfile: "agent",
        providerId: input.providerId,
        executionContract: resolveStoredExecutionContract({
          productMode: "agent",
          operationProfile: "agent",
          operationKind: "conversation-turn",
          roleId: "main-agent",
          providerAdapterVersion: this.providerRegistry.get(input.providerId).adapter.version,
        }),
        nativeSessionId: existingSessionId,
        model,
        reasoningEffort,
        capabilitySnapshot,
        effectiveSkillInputs: skillInputs,
        accessPolicy,
        handoffHash,
        deliveredThroughCompletedTurn: conversation.completedTurnSequence,
        worktreeId: null,
        status: "running",
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      attemptCreated = true;
      this.turnControl?.registerAttempt(turnRegistration);
      if (existingSessionId) {
        bindMainThread(database, paths.projectId, attemptId, existingSessionId, runId);
        liveMainThreadId = existingSessionId;
      }

      input.live?.emit({
        event: "run.started",
        data: {
          projectId: paths.projectId,
          productMode: "agent",
          conversationId: conversation.conversationId,
          graphScopeId,
          runId,
          providerId: input.providerId,
          attemptId,
          actionType: "chat.ask",
        },
      });
      input.live?.emit({
        event: "run.status",
        data: {
          projectId: paths.projectId,
          productMode: "agent",
          conversationId: conversation.conversationId,
          graphScopeId,
          runId,
          providerId: input.providerId,
          attemptId,
          status: "connecting",
          label: "正在连接 Agent",
        },
      });

      const result = await this.providerRegistry.get(input.providerId).conversation.runTurn({
        providerId: input.providerId,
        operationProfile: "agent",
        projectId: paths.projectId,
        conversationId: conversation.conversationId,
        graphScopeId,
        runtimeScopeId: conversation.conversationId,
        roleId: "main-agent",
        runId,
        attemptId,
        cwd: input.project.path,
        prompt: user.text ?? "",
        agentTurnMode: input.admission.agentTurnMode ?? undefined,
        sandboxPolicy: input.admission.sandboxPolicy,
        paths: providerArtifactPaths(runRoot),
        existingSession: existingSessionId
          ? { providerId: input.providerId, sessionId: existingSessionId }
          : null,
        onRealtimeEvent: (event) => {
          if (event.parentThreadId) {
            try {
              if (!liveMainThreadId) {
                bindMainThread(database, paths.projectId, attemptId, event.parentThreadId, runId);
                liveMainThreadId = event.parentThreadId;
              }
              const childEvent = childLifecycle.onRealtime(event);
              if (!childEvent) return;
              forwardProviderRealtimeEvent(childEvent, capture.sink, { productMode: "agent", graphScopeId });
            } catch (error) {
              canonicalPersistenceError ??= asError(error);
            }
            return;
          }
          if (!isCurrentTopLevelEvent(event, paths.projectId, conversation.conversationId, runId, attemptId, input.providerId)) {
            canonicalPersistenceError ??= new Error("Provider realtime event does not match the Direct Agent Turn identity.");
            return;
          }
          if (event.threadId && liveMainThreadId !== event.threadId) {
            try {
              bindMainThread(database, paths.projectId, attemptId, event.threadId, runId, event.displayName);
              liveMainThreadId = event.threadId;
            } catch (error) {
              canonicalPersistenceError ??= asError(error);
              return;
            }
          }
          forwardProviderRealtimeEvent(event, capture.sink, { productMode: "agent", graphScopeId });
        },
        onContextEvent: this.contextLifecycle?.listener({
          paths,
          productMode: "agent",
          conversationId: conversation.conversationId,
          graphScopeId,
          providerId: input.providerId,
        }),
        onTurnStarted: this.turnControl?.onTurnStarted,
        onChildLifecycleEvent: (event) => {
          try {
            if (!liveMainThreadId) {
              bindMainThread(database, paths.projectId, attemptId, event.parentSession.sessionId, runId);
              liveMainThreadId = event.parentSession.sessionId;
            }
            childLifecycle.onLifecycle(event);
          } catch (error) {
            canonicalPersistenceError ??= asError(error);
          }
        },
        onChildThreadResult: (child) => {
          try {
            if (!liveMainThreadId) {
              bindMainThread(database, paths.projectId, attemptId, child.parentThreadId, runId);
              liveMainThreadId = child.parentThreadId;
            }
            childLifecycle.onResult(child);
          } catch (error) {
            canonicalPersistenceError ??= asError(error);
          }
        },
        onUserInputRequest: providerInputLifecycle.onRequest,
        onUserInputResolved: providerInputLifecycle.onResolved,
        approvalMode: accessPolicy.approvalMode,
        onApprovalRequest: providerInputLifecycle.onApprovalRequest,
        onApprovalResolved: providerInputLifecycle.onApprovalResolved,
        onError: (error) => {
          input.live?.emit({
            event: "error",
            data: {
              projectId: paths.projectId,
              productMode: "agent",
              conversationId: conversation.conversationId,
              graphScopeId,
              runId,
              providerId: input.providerId,
              attemptId,
              message: asError(error).message,
            },
          });
        },
        model,
        reasoningEffort,
        imageInputs: [...attachmentResolution.imageInputs],
        fileInputs: [...attachmentResolution.fileInputs],
        skillInputs,
        runtimeWorkspaceRoots: [input.project.path, ...attachmentResolution.runtimeReadRoots],
        writableRoots: [...input.admission.writableRoots],
      });
      if (result.session && liveMainThreadId !== result.session.sessionId) {
        bindMainThread(database, paths.projectId, attemptId, result.session.sessionId, runId);
        liveMainThreadId = result.session.sessionId;
      }
      for (const child of result.childThreads) {
        try {
          childLifecycle.onResult(child);
        } catch (error) {
          canonicalPersistenceError ??= asError(error);
        }
      }
      await providerInputLifecycle.terminalize();
      providerInputTerminalized = true;
      const persistenceFailure = canonicalPersistenceError;
      const status = persistenceFailure ? "failed" : result.status;
      const assistant = terminalize(result, status, persistenceFailure ?? undefined);
      for (const row of terminalRows) publishCommittedCanonicalTimelineRow(input.live, row, "agent");
      input.live?.emit({
        event: "run.status",
        data: {
          projectId: paths.projectId,
          productMode: "agent",
          conversationId: conversation.conversationId,
          graphScopeId,
          runId,
          providerId: input.providerId,
          attemptId,
          status,
        },
      });
      if (status === "failed") {
        throw persistenceFailure ?? new Error(result.error || "Direct Agent provider Turn failed.");
      }
      return {
        user,
        assistant,
        run: null,
        providerSessionId: result.session?.sessionId ?? liveMainThreadId,
        mode: "chat",
        assistantMessage: assistant?.text ?? "",
      };
    } catch (error) {
      const failure = asError(error);
      if (!providerInputTerminalized) {
        await providerInputLifecycle.terminalize().catch((terminalizeError) => {
          canonicalPersistenceError ??= asError(terminalizeError);
        });
        providerInputTerminalized = true;
      }
      let terminalFailure: Error | null = null;
      if (attemptCreated && terminalLifecycle.state !== "settled") {
        if (terminalLifecycle.state === "idle") {
          try {
            void terminalize(null, "failed", failure);
          } catch (terminalError) {
            terminalFailure = asError(terminalError);
          }
        }
        if (terminalLifecycle.state === "committing") {
          try {
            const currentAttempt = database.providerAttempts.readProviderAttempt(paths.projectId, attemptId);
            if (currentAttempt?.status === "running") {
              const updatedAt = new Date().toISOString();
              const terminal = {
                status: "failed" as const,
                nativeSessionId: liveMainThreadId ?? existingSessionId,
              };
              try {
                const rows = database.unitOfWork.commitProviderCallback({
                  projectId: paths.projectId,
                  conversationId: conversation.conversationId,
                  attemptId,
                  expectedGraphScopeId: graphScopeId,
                  updatedAt,
                  terminal,
                  timelineMessages: terminalRecoveryWrites.map((write) => updateCanonicalWrite(write, {
                    status: "failed",
                    error: failure.message,
                  })),
                });
                terminalRows.push(...rows);
              } catch (timelineRecoveryError) {
                database.unitOfWork.commitProviderCallback({
                  projectId: paths.projectId,
                  conversationId: conversation.conversationId,
                  attemptId,
                  expectedGraphScopeId: graphScopeId,
                  updatedAt,
                  terminal,
                });
                terminalFailure = new AggregateError(
                  [terminalFailure, asError(timelineRecoveryError)].filter((item): item is Error => Boolean(item)),
                  `Direct Agent Timeline recovery failed before the Attempt-only fallback: ${attemptId}.`,
                );
              }
            }
            terminalLifecycle.state = "settled";
            this.turnControl?.release(turnRegistration);
          } catch (recoveryError) {
            terminalFailure = new AggregateError(
              [terminalFailure, asError(recoveryError)].filter((item): item is Error => Boolean(item)),
              `Direct Agent attempt could not be recovered after terminal persistence failed: ${attemptId}.`,
            );
          }
        }
        for (const row of terminalRows) publishCommittedCanonicalTimelineRow(input.live, row, "agent");
      }
      if (terminalFailure) throw new AggregateError([failure, terminalFailure], "Direct Agent Turn and terminal recovery both failed.");
      throw failure;
    } finally {
      this.turnControl?.release(turnRegistration);
      database.close();
    }
  }
}

function validateTurnIdentity(input: ConversationTurnStrategyPreflightInput): void {
  if (input.conversation.productMode !== "agent") throw conflict("Direct Agent Strategy requires an Agent Conversation.");
  if (input.project.id !== input.conversation.projectId
    || input.committedMessage.projectId !== input.conversation.projectId
    || input.committedMessage.conversationId !== input.conversation.conversationId) {
    throw conflict("Direct Agent Turn identity does not match the selected project and Conversation.");
  }
  if (input.providerId !== input.conversation.selectedProviderId) {
    throw conflict("Direct Agent provider does not match the committed Conversation selection.");
  }
  if (input.harnessHandoff) throw conflict("Agent mode does not accept AHO planning handoffs.");
}

function assertCurrentConversation(database: WorkbenchDatabase, input: ConversationTurnStrategyInput) {
  const stored = database.conversations.readConversation(input.project.id, input.conversation.conversationId);
  if (!stored || stored.deletedAt || stored.state !== "active") throw conflict("Direct Agent Conversation is no longer active.");
  if (stored.productMode !== "agent"
    || stored.selectedProviderId !== input.providerId
    || stored.currentGraphScopeId !== input.conversation.currentGraphScopeId
    || stored.completedTurnSequence !== input.conversation.completedTurnSequence) {
    throw conflict("Direct Agent Conversation identity changed before provider execution.");
  }
  const message = database.timeline.readMessage(stored.projectId, stored.conversationId, input.committedMessage.id);
  if (!message || message.revision !== input.committedMessage.revision || message.type !== "user.message") {
    throw conflict("Direct Agent committed user message no longer matches canonical Timeline state.");
  }
  return stored;
}

function directAgentHandoffHash(
  input: ConversationTurnStrategyInput,
  skills: TurnSkillContextResolution,
  attachments: import("./conversation-turn-contract.js").TurnAttachmentResolution,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 4,
    projectId: input.project.id,
    conversationId: input.conversation.conversationId,
    graphScopeId: input.conversation.currentGraphScopeId,
    messageId: input.committedMessage.id,
    messageRevision: input.committedMessage.revision,
    providerId: input.providerId,
    agentTurnMode: input.admission.agentTurnMode,
    resolvedModelId: input.admission.modelAdmission?.resolvedModelId ?? null,
    resolvedReasoningEffort: input.admission.modelAdmission?.resolvedReasoningEffort ?? null,
    capabilitySnapshotHash: input.admission.capabilitySnapshot?.snapshotHash ?? null,
    attachmentHandoffHash: attachments.handoffHash,
    attachments: attachments.evidence,
    skillInputs: skills.skillInputs.map((skill) => ({
      id: skill.id,
      path: skill.path,
      source: skill.source,
      contentHash: skill.contentHash,
      required: skill.required,
    })),
  })).digest("hex");
}

function terminalCaptureWrites(input: {
  projectId: string;
  conversationId: string;
  graphScopeId: string;
  runId: string;
  providerId: string;
  attemptId: string;
  mainTimelineId: string;
  sessionId: string | null;
  capture: ReturnType<typeof createAssistantTranscriptCapture>;
  result: ProviderTurnResult | null;
  status: "completed" | "interrupted" | "failed";
  failure?: Error;
  agentTurnMode: "default" | "plan" | null;
  modelId: string | null;
  reasoningEffort: string | null;
  sourceMessageId: string;
  completedTurnSequence?: number;
  retryLineage?: Readonly<import("./types.js").ConversationRetryLineageEvidence>;
  sessionRecoveryAnchor?: Pick<import("./types.js").ConversationForkTargetEvidence, "sourceMessageId" | "providerId" | "completedTurnSequence">;
}): StoredTopicMessageWrite[] {
  const writes = buildCanonicalCaptureWrites({
    projectId: input.projectId,
    conversationId: input.conversationId,
    graphScopeId: input.graphScopeId,
    runId: input.runId,
    providerId: input.providerId,
    attemptId: input.attemptId,
    mainTimelineId: input.mainTimelineId,
    mainSessionId: input.sessionId,
    snapshot: input.capture,
  }).filter((write) => write.agentSurfaceId === "main-agent");
  const authoritativePlanText = input.agentTurnMode === "plan" ? input.result?.planText?.trim() ?? "" : "";
  const fallbackText = input.capture.text.trim()
    ? ""
    : authoritativePlanText || input.result?.lastMessage.trim() || input.failure?.message || input.result?.error?.trim() || "";
  if (writes.length === 0 && (fallbackText || input.capture.blocks.length > 0 || input.capture.activity.length > 0)) {
    writes.push(toCanonicalTimelineMessage(input.projectId, input.conversationId, {
      id: input.mainTimelineId,
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      conversationId: input.conversationId,
      graphScopeId: input.graphScopeId,
      changeId: "",
      text: fallbackText || undefined,
      status: input.status,
      runId: input.runId,
      providerId: input.providerId,
      sessionId: input.sessionId ?? undefined,
      attemptId: input.attemptId,
      threadId: input.sessionId ?? undefined,
      turnId: input.result?.turnId ?? undefined,
      agentRoleId: "main-agent",
      agentSurfaceId: "main-agent",
      activity: input.capture.activity,
      blocks: input.capture.blocks,
      error: input.status === "failed" ? input.failure?.message ?? input.result?.error : undefined,
    }));
  } else if (authoritativePlanText) {
    const last = writes.at(-1)!;
    writes[writes.length - 1] = replaceCanonicalText(last, authoritativePlanText);
  } else if (fallbackText) {
    const last = writes.at(-1)!;
    writes[writes.length - 1] = addFallbackProse(last, fallbackText);
  }
  const retryTarget = input.status === "failed" ? {
    failedAttemptId: input.attemptId,
    sourceMessageId: input.retryLineage?.rootSourceMessageId ?? input.sourceMessageId,
    rootSourceMessageId: input.retryLineage?.rootSourceMessageId ?? input.sourceMessageId,
    providerId: input.providerId,
    agentTurnMode: input.agentTurnMode ?? "default" as const,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
  } : undefined;
  const updated = writes.map((write) => updateCanonicalWrite(write, {
    status: input.status,
    error: input.status === "failed" ? input.failure?.message ?? input.result?.error : undefined,
    ...(input.retryLineage ? { retryLineage: input.retryLineage } : {}),
    ...(retryTarget?.sourceMessageId ? { retryTarget } : {}),
    ...(input.completedTurnSequence !== undefined ? { completedTurnSequence: input.completedTurnSequence } : {}),
  }));
  if (input.status === "failed" && input.result?.failureKind === "stale-session" && input.sessionRecoveryAnchor) {
    let index = -1;
    for (let candidate = updated.length - 1; candidate >= 0; candidate -= 1) {
      const write = updated[candidate];
      if (write?.agentSurfaceId === "main-agent" && write.type === "assistant.message") {
        index = candidate;
        break;
      }
    }
    if (index >= 0) {
      updated[index] = updateCanonicalWrite(updated[index]!, {
        sessionRecovery: input.sessionRecoveryAnchor,
      });
    }
  }
  return updated;
}

function replaceCanonicalText(write: StoredTopicMessageWrite, text: string): StoredTopicMessageWrite {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(write.rawJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // The canonical text column remains authoritative if legacy raw evidence is malformed.
  }
  return { ...write, text, rawJson: JSON.stringify({ ...raw, text }) };
}

function addFallbackProse(write: StoredTopicMessageWrite, text: string): StoredTopicMessageWrite {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(write.rawJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // A typed fallback message remains recoverable even if diagnostic JSON was malformed.
  }
  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object" && !Array.isArray(block))
    : [];
  const sequence = Math.max(0, ...blocks.map((block) => typeof block.sequence === "number" ? block.sequence : 0)) + 1;
  const fallbackBlock = {
    id: `${write.id}:fallback-prose`,
    providerId: write.providerId ?? undefined,
    attemptId: typeof raw.attemptId === "string" ? raw.attemptId : undefined,
    runId: write.runId ?? undefined,
    threadId: write.threadId ?? undefined,
    turnId: write.turnId ?? undefined,
    itemId: `${write.id}:fallback-prose`,
    sequence,
    kind: "prose",
    timestamp: new Date().toISOString(),
    source: "provider",
    text,
  };
  return {
    ...write,
    text,
    rawJson: JSON.stringify({ ...raw, text, blocks: [...blocks, fallbackBlock] }),
  };
}

function updateCanonicalWrite(
  write: StoredTopicMessageWrite,
  patch: {
    text?: string;
    status?: string;
    error?: string;
    retryLineage?: Readonly<import("./types.js").ConversationRetryLineageEvidence>;
    retryTarget?: import("./types.js").ConversationRetryTargetEvidence;
    completedTurnSequence?: number;
    sessionRecovery?: Pick<import("./types.js").ConversationForkTargetEvidence, "sourceMessageId" | "providerId" | "completedTurnSequence">;
  },
): StoredTopicMessageWrite {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(write.rawJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Preserve the typed columns when legacy diagnostic JSON cannot be parsed.
  }
  return {
    ...write,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    rawJson: JSON.stringify({ ...raw, ...patch }),
  };
}

function resolveSessionRecoveryAnchor(
  database: WorkbenchDatabase,
  projectId: string,
  conversationId: string,
  graphScopeId: string,
  providerId: string,
  completedTurnSequence: number,
): Pick<import("./types.js").ConversationForkTargetEvidence, "sourceMessageId" | "providerId" | "completedTurnSequence"> | undefined {
  if (completedTurnSequence < 1) return undefined;
  const anchor = [...database.timeline.listConversationMessages(projectId, conversationId)].reverse().find((message) => {
    if (message.agentSurfaceId !== "main-agent" || message.type !== "assistant.message" || message.status !== "completed") return false;
    const entry = fromStoredThreadMessage(message);
    return entry.graphScopeId === graphScopeId
      && entry.providerId === providerId
      && entry.completedTurnSequence === completedTurnSequence
      && Boolean(message.turnId);
  });
  return anchor ? { sourceMessageId: anchor.id, providerId, completedTurnSequence } : undefined;
}

function bindMainThread(
  database: WorkbenchDatabase,
  projectId: string,
  attemptId: string,
  threadId: string,
  runId: string,
  displayName?: string,
): void {
  database.providerAttempts.bindProviderAttemptThread(projectId, {
    attemptId,
    threadId,
    parentThreadId: null,
    parentAgentSurfaceId: null,
    displayName,
    runId,
  }, new Date().toISOString());
}

function isCurrentTopLevelEvent(
  event: ProviderRealtimeEvent,
  projectId: string,
  conversationId: string,
  runId: string,
  attemptId: string,
  providerId: string,
): boolean {
  return event.projectId === projectId
    && event.conversationId === conversationId
    && event.runId === runId
    && event.attemptId === attemptId
    && event.providerId === providerId
    && event.roleId === "main-agent";
}

function providerArtifactPaths(root: string) {
  return {
    events: join(root, "provider-events.jsonl"),
    stderr: join(root, "provider-stderr.log"),
    lastMessage: join(root, "last-message.md"),
    session: join(root, "provider-session.json"),
  };
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
