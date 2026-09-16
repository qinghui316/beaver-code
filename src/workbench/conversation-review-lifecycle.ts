import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ProviderCapabilitySnapshot,
  ProviderRegistry,
  ProviderReviewResult,
  ProviderReviewTarget,
} from "../provider-runtime/index.js";
import { resolveStoredExecutionContract } from "../provider-runtime/execution-contract.js";
import type { ProjectRuntimeCoordinatorPort } from "../project-runtime/coordinator.js";
import type { ProjectRuntimePaths } from "../project-runtime/paths.js";
import type { ManagedProject } from "../types/index.js";
import { ConversationModelAdmissionOwner } from "./conversation-model-admission.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import { createConversationGraphScopeId } from "./conversation-graph-scope.js";
import type { ConversationContextLifecycleOwner } from "./conversation-context-lifecycle.js";
import type { ConversationModelAdmission } from "./conversation-turn-contract.js";
import type { ConversationTurnControlOwner, ConversationTurnRegistration } from "./conversation-turn-control.js";
import { createConversationExecutionRevision } from "./conversation-execution-revision.js";
import type { ConversationQueuedReviewDispatchPort, QueuedReviewDispatchRequest, QueuedReviewDispatchResult } from "./conversation-queued-review-dispatch.js";
import { admitProjectGitReview, sanitizeProjectReviewMarkdown, type ProjectGitReviewAdmission } from "./git-panel.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type { StoredConversationReviewOperation, StoredTopicMessageWrite } from "./persistence/contracts.js";
import { ProviderInteractionLifecycleOwner } from "./provider-input-lifecycle.js";
import { publishConversationReviewInvalidated, publishProjectLiveEvent } from "./project-live-events.js";

export interface ConversationReviewRequest {
  productMode: "agent";
  conversationId: string | null;
  providerId: string;
  target: ProviderReviewTarget;
  expectedTimelineRevision: number | null;
  expectedExecutionRevision: string | null;
  clientRequestId: string;
  source?: "direct" | "queue";
}

export interface ConversationReviewSnapshot {
  projectId: string;
  conversationId: string;
  graphScopeId: string;
  clientRequestId: string;
  attemptId: string;
  status: StoredConversationReviewOperation["status"];
  target: ProviderReviewTarget;
  source: "direct" | "queue";
  diagnostic?: string;
}

type PreparedReview = {
  conversationId: string;
  graphScopeId: string;
  createConversation: boolean;
  existingSessionId: string | null;
  completedTurnSequence: number;
  agentTurnMode: "default" | "plan";
  modelId: string | null;
  reasoningEffort: string | null;
};

export class ConversationReviewLifecycleOwner implements ConversationQueuedReviewDispatchPort {
  private readonly modelAdmission: ConversationModelAdmissionOwner;
  private readonly settlementRepairs = new Map<string, () => Promise<void>>();

  constructor(private readonly options: {
    providerRegistry: ProviderRegistry;
    projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve">;
    turnControl?: ConversationTurnControlOwner;
    contextLifecycle?: ConversationContextLifecycleOwner;
  }) {
    this.modelAdmission = new ConversationModelAdmissionOwner(options.providerRegistry);
  }

  async dispatchQueuedReview(project: ManagedProject, request: QueuedReviewDispatchRequest): Promise<QueuedReviewDispatchResult> {
    const snapshot = await this.start(project, {
      productMode: "agent",
      ...request,
      source: "queue",
    });
    return {
      conversationId: snapshot.conversationId,
      clientRequestId: snapshot.clientRequestId,
      status: snapshot.status,
    };
  }

  async start(project: ManagedProject, rawRequest: ConversationReviewRequest): Promise<ConversationReviewSnapshot> {
    const request = normalizeRequest(rawRequest);
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    if (project.id !== paths.projectId) throw conflict("Review project identity does not match the selected project.");
    const requestHash = requestDigest(project.id, request);
    const replay = await this.readReplay(paths, request.clientRequestId, requestHash);
    if (replay) {
      const repairKey = `${paths.projectId}\0${request.clientRequestId}`;
      const repair = this.settlementRepairs.get(repairKey);
      if (repair) {
        await repair();
        this.settlementRepairs.delete(repairKey);
        return (await this.readReplay(paths, request.clientRequestId, requestHash))!;
      }
      return replay;
    }

    const provider = this.options.providerRegistry.get(request.providerId);
    const capabilitySnapshot = await provider.capabilitySnapshot(project, "agent", project.path);
    if (!capabilitySnapshot.capabilities.some((item) => item.key === "turn.review" && item.runtime === "ready")) {
      throw conflict("Selected Provider does not support native Code Review.");
    }
    const gitAdmission = await admitProjectGitReview(project, request.target);
    const prepared = await this.prepare(paths, request);
    const modelAdmission = prepared.existingSessionId ? null : await this.modelAdmission.admit({
      project,
      providerId: request.providerId,
      requested: { providerId: request.providerId, modelId: prepared.modelId, reasoningEffort: prepared.reasoningEffort },
      requireResolvedModel: false,
    });
    const now = new Date().toISOString();
    const runId = `review-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const attemptId = `attempt-${randomUUID()}`;
    const runRoot = join(paths.runsRoot, "agent-conversations", prepared.conversationId, runId);
    const operation: StoredConversationReviewOperation = {
      projectId: paths.projectId,
      conversationId: prepared.conversationId,
      graphScopeId: prepared.graphScopeId,
      clientRequestId: request.clientRequestId,
      requestHash,
      providerId: request.providerId,
      reviewTargetJson: JSON.stringify(request.target),
      gitAdmissionJson: JSON.stringify(gitAdmission),
      attemptId,
      status: "pending",
      sessionBindingHash: prepared.existingSessionId ? bindingHash(request.providerId, prepared.existingSessionId) : null,
      turnIdentityHash: null,
      source: request.source ?? "direct",
      diagnostic: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistAdmission(paths, request, requestHash, prepared, modelAdmission, capabilitySnapshot, gitAdmission, operation, runId, now);
    await mkdir(runRoot, { recursive: true });
    if (prepared.createConversation) publishCreatedConversation(paths.projectId, prepared.conversationId, request, prepared);
    publishConversationReviewInvalidated(paths.projectId, { conversationId: prepared.conversationId });
    await this.execute(project, paths, operation, gitAdmission, capabilitySnapshot, prepared, modelAdmission, runId, runRoot);
    return (await this.readReplay(paths, request.clientRequestId, requestHash))!;
  }

  async reconcileProject(paths: ProjectRuntimePaths): Promise<number> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    let changed = 0;
    try {
      for (const operation of database.conversationReviews.listIncomplete(paths.projectId)) {
        const now = new Date().toISOString();
        database.transaction(() => {
          database.conversationReviews.update({
            projectId: paths.projectId,
            clientRequestId: operation.clientRequestId,
            expectedStatus: operation.status,
            status: "interrupted",
            diagnostic: "Review was interrupted by Workbench restart.",
            updatedAt: now,
          });
          database.providerAttempts.completeProviderAttempt(paths.projectId, operation.attemptId, "interrupted", null, now);
          updateReviewTimeline(database, operation, JSON.parse(operation.gitAdmissionJson) as ProjectGitReviewAdmission, {
            status: "interrupted",
            text: null,
            diagnostic: "Review was interrupted by Workbench restart.",
            runId: `recovery:${operation.attemptId}`,
            sessionId: null,
            turnId: null,
          });
        });
        publishConversationReviewInvalidated(paths.projectId, { conversationId: operation.conversationId });
        changed += 1;
      }
    } finally {
      database.close();
    }
    return changed;
  }

  private async prepare(paths: ProjectRuntimePaths, request: ConversationReviewRequest): Promise<PreparedReview> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      if (!request.conversationId) {
        const conversationId = `conv-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const draft = database.drafts.readDraft(paths.projectId, "agent");
        return {
          conversationId,
          graphScopeId: createConversationGraphScopeId(conversationId),
          createConversation: true,
          existingSessionId: null,
          completedTurnSequence: 0,
          agentTurnMode: draft?.agentTurnMode ?? "default",
          modelId: draft?.agentModelId ?? null,
          reasoningEffort: draft?.agentReasoningEffort ?? null,
        };
      }
      const conversation = database.conversations.readConversation(paths.projectId, request.conversationId);
      if (!conversation || conversation.deletedAt || conversation.state !== "active" || conversation.productMode !== "agent") {
        throw conflict("Review requires an active Agent Conversation.");
      }
      if (!conversation.currentGraphScopeId || conversation.selectedProviderId !== request.providerId) {
        throw conflict("Review Provider or graph identity changed.");
      }
      if (request.expectedTimelineRevision !== conversation.timelineRevision) throw conflict("Review Timeline revision is stale.");
      const active = database.providerAttempts.listProviderAttempts(paths.projectId, conversation.conversationId)
        .filter((attempt) => attempt.graphScopeId === conversation.currentGraphScopeId
          && (attempt.status === "queued" || attempt.status === "running"));
      if (active.length > 0) throw conflict("Conversation is busy; enqueue the Review as the next FIFO item.");
      const executionRevision = createConversationExecutionRevision(
        conversation.currentGraphScopeId,
        conversation.completedTurnSequence,
        active.map((attempt) => attempt.attemptId),
      );
      if (request.expectedExecutionRevision !== executionRevision) throw conflict("Review execution revision is stale.");
      assertReviewAdmissionIdle(database, paths.projectId, conversation.conversationId, request);
      if ((this.options.turnControl && this.options.turnControl.state(paths.projectId, conversation.conversationId).state !== "idle")
        || this.options.providerRegistry.findActiveTurn(conversation.conversationId)) {
        throw conflict("Conversation is busy; wait for the active Provider operation to finish.");
      }
      const binding = database.providerAttempts.readConversationProviderBinding(
        paths.projectId,
        conversation.conversationId,
        request.providerId,
      );
      if (binding?.bindingStatus === "stale") {
        throw conflict("Conversation Provider Session is stale; create a recovery branch before reviewing.");
      }
      if (!binding?.nativeSessionId || binding.bindingStatus !== "ready") {
        throw conflict("Code Review requires a ready Provider Session for the existing Conversation.");
      }
      return {
        conversationId: conversation.conversationId,
        graphScopeId: conversation.currentGraphScopeId,
        createConversation: false,
        existingSessionId: binding.nativeSessionId,
        completedTurnSequence: conversation.completedTurnSequence,
        agentTurnMode: conversation.agentTurnMode ?? "default",
        modelId: conversation.agentModelId,
        reasoningEffort: conversation.agentReasoningEffort,
      };
    } finally {
      database.close();
    }
  }

  private async persistAdmission(
    paths: ProjectRuntimePaths,
    request: ConversationReviewRequest,
    requestHash: string,
    prepared: PreparedReview,
    modelAdmission: ConversationModelAdmission | null,
    capabilitySnapshot: ProviderCapabilitySnapshot,
    gitAdmission: ProjectGitReviewAdmission,
    operation: StoredConversationReviewOperation,
    runId: string,
    now: string,
  ): Promise<void> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.immediateTransaction(() => {
        if (prepared.createConversation) {
          database.conversations.createConversation({
            projectId: paths.projectId,
            conversationId: prepared.conversationId,
            productMode: "agent",
            agentTurnMode: prepared.agentTurnMode,
            agentModelId: prepared.modelId,
            agentReasoningEffort: prepared.reasoningEffort,
            clientCreateRequestId: `review-create:${request.clientRequestId}`,
            clientCreateRequestHash: requestHash,
            title: "代码审查",
            state: "active",
            boundChangeId: null,
            currentGraphScopeId: prepared.graphScopeId,
            selectedProviderId: request.providerId,
            completedTurnSequence: 0,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });
          database.conversations.initializeConversationGraphScope(paths.projectId, prepared.conversationId, prepared.graphScopeId, now);
        } else {
          const conversation = database.conversations.readConversation(paths.projectId, prepared.conversationId);
          if (!conversation || conversation.deletedAt || conversation.state !== "active"
            || conversation.productMode !== "agent" || conversation.currentGraphScopeId !== prepared.graphScopeId
            || conversation.selectedProviderId !== request.providerId
            || conversation.timelineRevision !== request.expectedTimelineRevision) {
            throw conflict("Review Conversation identity changed before admission.");
          }
          const activeAttempts = database.providerAttempts.listProviderAttempts(paths.projectId, prepared.conversationId)
            .filter((attempt) => attempt.graphScopeId === prepared.graphScopeId
              && (attempt.status === "queued" || attempt.status === "running"));
          const executionRevision = createConversationExecutionRevision(
            prepared.graphScopeId,
            conversation.completedTurnSequence,
            activeAttempts.map((attempt) => attempt.attemptId),
          );
          if (executionRevision !== request.expectedExecutionRevision) throw conflict("Review execution identity changed before admission.");
          assertReviewAdmissionIdle(database, paths.projectId, prepared.conversationId, request);
        }
        database.providerAttempts.createProviderAttempt({
          projectId: paths.projectId,
          conversationId: prepared.conversationId,
          attemptId: operation.attemptId,
          productMode: "agent",
          agentTurnMode: null,
          operationKind: "review",
          graphScopeId: prepared.graphScopeId,
          changeId: null,
          agentTaskId: null,
          roleId: "main-agent",
          parentAgentSurfaceId: null,
          operationProfile: "agent",
          providerId: request.providerId,
          executionContract: resolveStoredExecutionContract({
            productMode: "agent",
            operationProfile: "agent",
            operationKind: "review",
            roleId: "main-agent",
            providerAdapterVersion: this.options.providerRegistry.get(request.providerId).adapter.version,
          }),
          nativeSessionId: prepared.existingSessionId,
          model: modelAdmission?.resolvedModelId
            ? { providerId: request.providerId, modelId: modelAdmission.resolvedModelId }
            : null,
          reasoningEffort: modelAdmission?.resolvedReasoningEffort ?? null,
          capabilitySnapshot,
          effectiveSkillInputs: [],
          handoffHash: reviewHandoffHash(request, gitAdmission, prepared, modelAdmission),
          deliveredThroughCompletedTurn: prepared.completedTurnSequence,
          worktreeId: null,
          status: "queued",
          createdAt: now,
          updatedAt: now,
        });
        database.conversationReviews.create(operation);
        database.timeline.appendMessage(reviewTimeline({
          operation,
          gitAdmission,
          status: "submitting",
          text: null,
          diagnostic: null,
          runId,
          sessionId: prepared.existingSessionId,
          turnId: null,
        }));
      });
    } finally {
      database.close();
    }
  }

  private async execute(
    project: ManagedProject,
    paths: ProjectRuntimePaths,
    operation: StoredConversationReviewOperation,
    gitAdmission: ProjectGitReviewAdmission,
    capabilitySnapshot: ProviderCapabilitySnapshot,
    prepared: PreparedReview,
    modelAdmission: ConversationModelAdmission | null,
    runId: string,
    runRoot: string,
  ): Promise<void> {
    const registration: ConversationTurnRegistration = {
      projectId: paths.projectId,
      productMode: "agent",
      conversationId: operation.conversationId,
      providerId: operation.providerId,
      expectedAttemptId: operation.attemptId,
      graphScopeId: operation.graphScopeId,
      runId,
      roleId: "main-agent",
      canSteer: false,
    };
    this.options.turnControl?.registerAttempt(registration);
    let sawStarted = false;
    let exitedText: string | null = null;
    let sessionId = prepared.existingSessionId;
    let turnId: string | null = null;
    let settlementPending = false;
    const interaction = new ProviderInteractionLifecycleOwner({
      runtime: paths,
      productMode: "agent",
      projectId: paths.projectId,
      conversationId: operation.conversationId,
      graphScopeId: operation.graphScopeId,
      runId,
      providerId: operation.providerId,
      attemptId: operation.attemptId,
      runtimeScopeId: operation.conversationId,
      agentTurnMode: "plan",
      resolveApprovalIdentity: () => ({ attemptId: operation.attemptId, roleId: "main-agent" }),
    });
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const attempt = database.providerAttempts.readProviderAttempt(paths.projectId, operation.attemptId);
      if (!attempt) throw new Error("Persisted Review Attempt is missing.");
      database.transaction(() => {
        database.providerAttempts.startQueuedProviderAttempt(paths.projectId, operation.attemptId, {
          capabilitySnapshot,
          effectiveSkillInputs: [],
          handoffHash: attempt.handoffHash,
          deliveredThroughCompletedTurn: prepared.completedTurnSequence,
          model: attempt.model,
          reasoningEffort: attempt.reasoningEffort,
          updatedAt: new Date().toISOString(),
        });
        database.conversationReviews.update({
          projectId: paths.projectId,
          clientRequestId: operation.clientRequestId,
          expectedStatus: "pending",
          status: "submitting",
          updatedAt: new Date().toISOString(),
        });
      });
      const result = await this.options.providerRegistry.get(operation.providerId).conversation.runReview({
        providerId: operation.providerId,
        projectId: paths.projectId,
        conversationId: operation.conversationId,
        graphScopeId: operation.graphScopeId,
        runtimeScopeId: operation.conversationId,
        runId,
        attemptId: operation.attemptId,
        cwd: project.path,
        target: gitAdmission.target,
        existingSession: prepared.existingSessionId
          ? { providerId: operation.providerId, sessionId: prepared.existingSessionId }
          : null,
        bootstrapModel: modelAdmission?.resolvedModelId
          ? { providerId: operation.providerId, modelId: modelAdmission.resolvedModelId }
          : null,
        bootstrapReasoningEffort: modelAdmission?.resolvedReasoningEffort ?? null,
        sandboxPolicy: "read-only",
        paths: providerArtifactPaths(runRoot),
        onTurnStarted: (identity) => {
          sessionId = identity.sessionId;
          turnId = identity.turnId;
          this.options.turnControl?.onTurnStarted(identity);
          const current = database.conversationReviews.read(paths.projectId, operation.clientRequestId);
          if (current?.status !== "submitting") return;
          database.transaction(() => {
            database.providerAttempts.bindProviderAttemptThread(paths.projectId, {
              attemptId: operation.attemptId,
              threadId: identity.sessionId,
              runId,
            }, new Date().toISOString());
            database.conversationReviews.update({
              projectId: paths.projectId,
              clientRequestId: operation.clientRequestId,
              expectedStatus: "submitting",
              status: "submitting",
              sessionBindingHash: bindingHash(operation.providerId, identity.sessionId),
              turnIdentityHash: digest(`${operation.providerId}\0${identity.sessionId}\0${identity.turnId}`),
              updatedAt: new Date().toISOString(),
            });
          });
        },
        onReviewEvent: (event) => {
          if (event.phase === "started") {
            sawStarted = true;
            const current = database.conversationReviews.read(paths.projectId, operation.clientRequestId);
            if (current?.status === "submitting") database.transaction(() => {
              database.conversationReviews.update({
                projectId: paths.projectId,
                clientRequestId: operation.clientRequestId,
                expectedStatus: "submitting",
                status: "reviewing",
                updatedAt: event.occurredAt,
              });
              updateReviewTimeline(database, operation, gitAdmission, {
                status: "reviewing",
                text: null,
                diagnostic: null,
                runId,
                sessionId,
                turnId,
              });
            });
          } else if (event.phase === "completed") {
            exitedText = event.reviewText;
          }
          publishConversationReviewInvalidated(paths.projectId, { conversationId: operation.conversationId });
        },
        onContextEvent: this.options.contextLifecycle?.listener({
          paths,
          productMode: "agent",
          conversationId: operation.conversationId,
          graphScopeId: operation.graphScopeId,
          providerId: operation.providerId,
        }),
        onApprovalRequest: interaction.onApprovalRequest,
        onApprovalResolved: interaction.onApprovalResolved,
      });
      const repairKey = `${paths.projectId}\0${operation.clientRequestId}`;
      this.settlementRepairs.set(repairKey, async () => {
        const repairDatabase = await openProjectRuntimeWorkbenchDatabase(paths);
        try {
          await this.settle(project, repairDatabase, operation, gitAdmission, result, sawStarted, exitedText, sessionId, turnId, runId);
        } finally {
          repairDatabase.close();
        }
      });
      settlementPending = true;
      await this.settle(project, database, operation, gitAdmission, result, sawStarted, exitedText, sessionId, turnId, runId);
      settlementPending = false;
      this.settlementRepairs.delete(repairKey);
    } catch (cause) {
      const current = database.conversationReviews.read(paths.projectId, operation.clientRequestId);
      const uncertainTransport = cause instanceof Error && cause.name === "ProviderReviewTransportUncertain";
      if (!settlementPending && !uncertainTransport && current && ["pending", "submitting", "reviewing"].includes(current.status)) {
        const now = new Date().toISOString();
        const diagnostic = boundedDiagnostic(cause);
        database.transaction(() => {
          database.conversationReviews.update({
            projectId: paths.projectId,
            clientRequestId: operation.clientRequestId,
            expectedStatus: current.status,
            status: "failed",
            diagnostic,
            updatedAt: now,
          });
          database.providerAttempts.completeProviderAttempt(paths.projectId, operation.attemptId, "failed", sessionId, now);
          updateReviewTimeline(database, operation, gitAdmission, {
            status: "failed",
            text: null,
            diagnostic,
            runId,
            sessionId,
            turnId,
          });
        });
      }
      throw cause;
    } finally {
      this.options.turnControl?.release(registration);
      database.close();
      publishConversationReviewInvalidated(paths.projectId, { conversationId: operation.conversationId });
    }
  }

  private async settle(
    project: ManagedProject,
    database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
    operation: StoredConversationReviewOperation,
    gitAdmission: ProjectGitReviewAdmission,
    result: ProviderReviewResult,
    sawStarted: boolean,
    exitedText: string | null,
    sessionId: string | null,
    turnId: string | null,
    runId: string,
  ): Promise<void> {
    const current = database.conversationReviews.read(operation.projectId, operation.clientRequestId);
    if (!current) throw new Error("Conversation Review operation disappeared before settlement.");
    const completed = result.status === "completed" && sawStarted && exitedText !== null;
    const status: StoredConversationReviewOperation["status"] = completed
      ? "completed"
      : result.status === "interrupted" ? "interrupted" : "failed";
    const diagnostic = completed
      ? null
      : result.error ?? (result.status === "completed"
        ? "Provider Review completion proof was incomplete."
        : "Code Review did not complete.");
    const safeText = exitedText ? await sanitizeProjectReviewMarkdown(project, exitedText) : "";
    const sessionRecovery = result.failureKind === "stale-session"
      ? latestCompletedTurnAnchor(database, operation.projectId, operation.conversationId, operation.providerId)
      : null;
    const now = new Date().toISOString();
    database.transaction(() => {
      database.conversationReviews.update({
        projectId: operation.projectId,
        clientRequestId: operation.clientRequestId,
        expectedStatus: current.status,
        status,
        diagnostic,
        updatedAt: now,
      });
      database.providerAttempts.completeProviderAttempt(
        operation.projectId,
        operation.attemptId,
        status === "completed" ? "completed" : status,
        sessionId,
        now,
      );
      const binding = database.providerAttempts.readConversationProviderBinding(
        operation.projectId,
        operation.conversationId,
        operation.providerId,
      );
      database.providerAttempts.writeConversationProviderBinding({
        projectId: operation.projectId,
        conversationId: operation.conversationId,
        providerId: operation.providerId,
        nativeSessionId: sessionId,
        lastDeliveredCompletedTurn: binding?.lastDeliveredCompletedTurn ?? 0,
        preferredModel: binding?.preferredModel ?? null,
        lastUsedAt: now,
        bindingStatus: result.failureKind === "stale-session" ? "stale" : sessionId ? "ready" : "unavailable",
      });
      updateReviewTimeline(database, operation, gitAdmission, {
        status,
        text: safeText || null,
        diagnostic,
        runId,
        sessionId,
        turnId,
        sessionRecovery,
      });
    });
  }

  private async readReplay(
    paths: ProjectRuntimePaths,
    clientRequestId: string,
    requestHash: string,
  ): Promise<ConversationReviewSnapshot | null> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const operation = database.conversationReviews.read(paths.projectId, clientRequestId);
      if (!operation) return null;
      if (operation.requestHash !== requestHash) throw conflict("Review clientRequestId was used for a different request.");
      return toSnapshot(operation);
    } finally {
      database.close();
    }
  }
}

function updateReviewTimeline(
  database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  operation: StoredConversationReviewOperation,
  gitAdmission: ProjectGitReviewAdmission,
  terminal: { status: string; text: string | null; diagnostic: string | null; runId: string; sessionId: string | null; turnId: string | null; sessionRecovery?: SessionRecoveryAnchor | null },
): void {
  const write = reviewTimeline({ operation, gitAdmission, ...terminal });
  if (database.timeline.readMessage(operation.projectId, operation.conversationId, write.id)) {
    database.timeline.updateMessage(write);
  } else {
    database.timeline.appendMessage(write);
  }
}

function reviewTimeline(input: {
  operation: StoredConversationReviewOperation;
  gitAdmission: ProjectGitReviewAdmission;
  status: string;
  text: string | null;
  diagnostic: string | null;
  runId: string;
  sessionId: string | null;
  turnId: string | null;
  sessionRecovery?: SessionRecoveryAnchor | null;
}): StoredTopicMessageWrite {
  return toCanonicalTimelineMessage(input.operation.projectId, input.operation.conversationId, {
    id: `review:${input.operation.attemptId}`,
    type: "provider.review",
    timestamp: new Date().toISOString(),
    conversationId: input.operation.conversationId,
    graphScopeId: input.operation.graphScopeId,
    changeId: "",
    text: input.text ?? undefined,
    status: input.status,
    runId: input.runId,
    providerId: input.operation.providerId,
    attemptId: input.operation.attemptId,
    agentRoleId: "main-agent",
    agentSurfaceId: "main-agent",
    error: input.diagnostic ?? undefined,
    providerReview: {
      target: JSON.parse(input.operation.reviewTargetJson) as ProviderReviewTarget,
      git: {
        headSha: input.gitAdmission.headSha,
        baseSha: input.gitAdmission.baseSha,
        commitSha: input.gitAdmission.commitSha,
        worktreeStatusDigest: input.gitAdmission.worktreeStatusDigest,
      },
      source: input.operation.source,
    },
    ...(input.sessionRecovery ? { sessionRecovery: input.sessionRecovery } : {}),
  });
}

type SessionRecoveryAnchor = {
  sourceMessageId: string;
  providerId: string;
  completedTurnSequence: number;
};

function latestCompletedTurnAnchor(
  database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  projectId: string,
  conversationId: string,
  providerId: string,
): SessionRecoveryAnchor | null {
  const candidates = database.timeline.listConversationMessages(projectId, conversationId).flatMap((row) => {
    if (row.type !== "assistant.message" || row.agentSurfaceId !== "main-agent" || row.status !== "completed") return [];
    try {
      const raw = JSON.parse(row.rawJson) as { completedTurnSequence?: unknown };
      return typeof raw.completedTurnSequence === "number" && Number.isSafeInteger(raw.completedTurnSequence)
        ? [{ sourceMessageId: row.id, providerId, completedTurnSequence: raw.completedTurnSequence }]
        : [];
    } catch {
      return [];
    }
  });
  return candidates.sort((left, right) => right.completedTurnSequence - left.completedTurnSequence)[0] ?? null;
}

function normalizeRequest(request: ConversationReviewRequest): ConversationReviewRequest {
  const clientRequestId = request.clientRequestId?.trim();
  const providerId = request.providerId?.trim();
  if (!clientRequestId || !providerId) throw badRequest("Code Review requires exact request and Provider identity.");
  if (request.productMode !== "agent") throw conflict("Native Code Review is available only in Agent mode.");
  return {
    ...request,
    clientRequestId,
    providerId,
    conversationId: request.conversationId?.trim() || null,
    target: normalizeReviewTarget(request.target),
  };
}

function normalizeReviewTarget(value: unknown): ProviderReviewTarget {
  if (!value || typeof value !== "object") throw badRequest("Code Review target is invalid.");
  const target = value as Partial<ProviderReviewTarget>;
  if (target.type === "uncommitted-changes") return { type: target.type };
  if (target.type === "base-branch" && "branch" in target && typeof target.branch === "string") {
    const branch = target.branch.trim();
    if (branch && branch.length <= 512) return { type: target.type, branch };
  }
  if (target.type === "commit" && "sha" in target && typeof target.sha === "string") {
    const sha = target.sha.trim();
    const title = "title" in target && typeof target.title === "string" ? target.title.trim() : "";
    if (sha && sha.length <= 512 && title.length <= 500) {
      return { type: target.type, sha, ...(title ? { title } : {}) };
    }
  }
  if (target.type === "custom" && "instructions" in target && typeof target.instructions === "string") {
    const instructions = target.instructions.trim();
    if (instructions && instructions.length <= 100_000) return { type: target.type, instructions };
  }
  throw badRequest("Code Review target is invalid.");
}

function assertReviewAdmissionIdle(
  database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  projectId: string,
  conversationId: string,
  request: ConversationReviewRequest,
): void {
  const queueItems = database.conversationTurnQueues.listItems(projectId, conversationId)
    .filter((item) => item.status === "queued" || item.status === "dispatching" || item.status === "blocked");
  if (request.source === "queue") {
    const head = queueItems[0];
    if (!head || head.itemKind !== "review" || head.status !== "dispatching"
      || head.dispatchRequestId !== request.clientRequestId) {
      throw conflict("Queued Review no longer owns the FIFO head.");
    }
  } else if (queueItems.length > 0) {
    throw conflict("Review cannot bypass the existing Conversation Turn queue.");
  }
  if (database.conversationForks.listIncomplete(projectId)
    .some((operation) => operation.sourceConversationId === conversationId)) {
    throw conflict("Review is unavailable while Conversation fork is in progress.");
  }
  if (database.conversationReviews.listIncomplete(projectId)
    .some((operation) => operation.conversationId === conversationId
      && operation.clientRequestId !== request.clientRequestId)) {
    throw conflict("Another Code Review is already in progress.");
  }
  for (const row of database.timeline.listConversationMessages(projectId, conversationId)) {
    if (row.type === "provider.context-compaction"
      && (row.status === "submitting" || row.status === "compacting")) {
      throw conflict("Review is unavailable while context compaction is in progress.");
    }
    try {
      const raw = JSON.parse(row.rawJson) as {
        providerUserInput?: { status?: string };
        providerApproval?: { status?: string };
        clarification?: { status?: string };
      };
      if ([raw.providerUserInput?.status, raw.providerApproval?.status, raw.clarification?.status]
        .some((status) => status === "pending" || status === "submitting")) {
        throw conflict("Review is unavailable while the Conversation awaits input or approval.");
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === "Conflict") throw cause;
    }
  }
}

function toSnapshot(operation: StoredConversationReviewOperation): ConversationReviewSnapshot {
  return {
    projectId: operation.projectId,
    conversationId: operation.conversationId,
    graphScopeId: operation.graphScopeId,
    clientRequestId: operation.clientRequestId,
    attemptId: operation.attemptId,
    status: operation.status,
    target: JSON.parse(operation.reviewTargetJson) as ProviderReviewTarget,
    source: operation.source,
    ...(operation.diagnostic ? { diagnostic: operation.diagnostic } : {}),
  };
}

function publishCreatedConversation(
  projectId: string,
  conversationId: string,
  request: ConversationReviewRequest,
  prepared: PreparedReview,
): void {
  publishProjectLiveEvent(projectId, {
    event: "topic.created",
    data: {
      projectId,
      productMode: "agent",
      conversationId,
      clientRequestId: `review-create:${request.clientRequestId}`,
      replayed: false,
      topic: {
        id: conversationId,
        conversationId,
        title: "代码审查",
        state: "active",
        selectedProviderId: request.providerId,
        productMode: "agent",
        agentTurnMode: prepared.agentTurnMode,
        agentModelId: prepared.modelId,
        agentReasoningEffort: prepared.reasoningEffort,
      },
    },
  });
}

function reviewHandoffHash(
  request: ConversationReviewRequest,
  gitAdmission: ProjectGitReviewAdmission,
  prepared: PreparedReview,
  modelAdmission: ConversationModelAdmission | null,
): string {
  return digest(JSON.stringify({
    version: 1,
    providerId: request.providerId,
    conversationId: prepared.conversationId,
    graphScopeId: prepared.graphScopeId,
    sessionBindingHash: prepared.existingSessionId ? bindingHash(request.providerId, prepared.existingSessionId) : null,
    target: gitAdmission.target,
    headSha: gitAdmission.headSha,
    baseSha: gitAdmission.baseSha,
    commitSha: gitAdmission.commitSha,
    worktreeStatusDigest: gitAdmission.worktreeStatusDigest,
    modelId: modelAdmission?.resolvedModelId ?? null,
    reasoningEffort: modelAdmission?.resolvedReasoningEffort ?? null,
  }));
}

function requestDigest(projectId: string, request: ConversationReviewRequest): string {
  return digest(JSON.stringify({
    version: 1,
    projectId,
    conversationId: request.conversationId,
    providerId: request.providerId,
    target: request.target,
    expectedTimelineRevision: request.expectedTimelineRevision,
    expectedExecutionRevision: request.expectedExecutionRevision,
    source: request.source ?? "direct",
  }));
}

function providerArtifactPaths(root: string) {
  return {
    events: join(root, "provider-events.jsonl"),
    stderr: join(root, "provider-stderr.log"),
    lastMessage: join(root, "last-message.md"),
    session: join(root, "provider-session.json"),
  };
}

function bindingHash(providerId: string, sessionId: string): string {
  return digest(`${providerId}\0${sessionId}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedDiagnostic(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}
