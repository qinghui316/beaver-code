import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentAccessPolicy } from "../provider-runtime/agent-access-policy.js";
import type {
  ProviderCapabilitySnapshot,
  ProviderChildLifecycleEvent,
  ProviderChildThreadResult,
  ProviderModelRef,
  ProviderRealtimeEvent,
  ProviderRegistry,
} from "../provider-runtime/index.js";
import { defaultProviderRegistry } from "../provider-runtime/index.js";
import { resolveStoredExecutionContract } from "../provider-runtime/execution-contract.js";
import { agentThreadSurfaceId } from "../provider-runtime/agent-surface-id.js";
import type { ManagedProject } from "../types/index.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../provider-runtime/project-harness-discovery.js";
import { resolveProjectRuntimeState } from "../project-runtime/coordinator.js";
import { createAssistantTranscriptCapture, type AssistantTranscriptCapture } from "./live-transcript.js";
import { buildCanonicalCaptureWrites, childInitialInputMessage } from "./provider-capture-persistence.js";
import type { WorkbenchDatabase } from "./persistence/database.js";
import type { StoredProviderAttempt, StoredProviderThreadLink, StoredTopicMessage, StoredTopicMessageWrite } from "./persistence/contracts.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import { CanonicalTimelineDelivery } from "./canonical-timeline-delivery.js";
import { forwardProviderRealtimeEvent } from "./provider-live-events.js";
import type { TopicMessageResult, TopicThreadEntry, WorkbenchLiveSink } from "./types.js";

export const NATIVE_CHILD_AGENT_ROLE_ID = "native-child-agent";
export const NATIVE_CHILD_OPERATION_PROFILE = "agent";

type ChildTerminalStatus = "completed" | "interrupted" | "failed" | "terminated";

export interface AgentNativeChildRecord {
  activityId: string;
  attemptId: string;
  threadId: string;
  parentThreadId: string;
  displayName?: string;
  status: "running" | ChildTerminalStatus;
}

export class AgentNativeChildLifecycleService {
  private readonly byActivity = new Map<string, AgentNativeChildRecord>();
  private readonly byThread = new Map<string, AgentNativeChildRecord>();

  constructor(private readonly input: {
    database: WorkbenchDatabase;
    projectId: string;
    conversationId: string;
    graphScopeId: string;
    runId: string;
    parentAttemptId: string;
    followupAccessPolicy?: import("../provider-runtime/agent-access-policy.js").AgentAccessPolicy;
    providerId: string;
    providerAdapterVersion: string;
    capabilitySnapshot: ProviderCapabilitySnapshot;
    model: ProviderModelRef | null;
    reasoningEffort: string | null;
    parentHandoffHash: string;
    deliveredThroughCompletedTurn: number;
    capture: AssistantTranscriptCapture;
    requireRunningParent?: boolean;
    initialTimelineMessages?: (child: AgentNativeChildRecord) => StoredTopicMessageWrite[];
    publish(rows: StoredTopicMessage[]): void;
    onInvalidated(): void;
  }) {}

  onLifecycle(event: ProviderChildLifecycleEvent): AgentNativeChildRecord | null {
    this.assertProvider(event.providerId, event.parentSession.providerId, event.childSession.providerId);
    const activityKey = this.callbackKey(event.parentSession.sessionId, event.childSession.sessionId, event.activityId);
    const existing = this.byActivity.get(activityKey) ?? this.readPersistedActivity(
      event.activityId,
      event.childSession.sessionId,
      event.parentSession.sessionId,
    );
    if (existing) {
      this.assertLineage(existing, event.parentSession.sessionId, event.childSession.sessionId);
      this.byActivity.set(activityKey, existing);
      if (event.kind === "closed") this.complete(existing, "terminated", event.activityId, "Provider closed native child.");
      return existing;
    }
    const activeThread = this.byThread.get(event.childSession.sessionId);
    if (event.kind === "continued" && activeThread?.status === "running") {
      this.assertLineage(activeThread, event.parentSession.sessionId, event.childSession.sessionId);
      this.byActivity.set(activityKey, activeThread);
      return activeThread;
    }
    const child = this.createChild({
      activityId: event.activityId,
      parentThreadId: event.parentSession.sessionId,
      childThreadId: event.childSession.sessionId,
      displayName: event.displayName,
      model: null,
      reasoningEffort: null,
    });
    this.byActivity.set(activityKey, child);
    this.byThread.set(child.threadId, child);
    if (event.kind === "closed") this.complete(child, "terminated", event.activityId, "Provider closed native child.");
    return child;
  }

  onRealtime(event: ProviderRealtimeEvent): ProviderRealtimeEvent | null {
    if (!event.parentThreadId) return null;
    if (event.projectId !== this.input.projectId
      || event.conversationId !== this.input.conversationId
      || event.graphScopeId !== this.input.graphScopeId
      || event.runId !== this.input.runId
      || event.providerId !== this.input.providerId) return null;
    const child = this.byThread.get(event.threadId) ?? this.readLatestPersisted(event.threadId, event.parentThreadId);
    if (!child) return null;
    if (child.parentThreadId !== event.parentThreadId || child.threadId !== event.threadId) return null;
    if (!this.readPersistedActivity(child.activityId, child.threadId, child.parentThreadId)) return null;
    return {
      ...event,
      attemptId: child.attemptId,
      runId: this.input.runId,
      roleId: NATIVE_CHILD_AGENT_ROLE_ID,
      displayName: child.displayName ?? event.displayName,
    };
  }

  onResult(result: ProviderChildThreadResult): AgentNativeChildRecord | null {
    this.assertProvider(result.providerId);
    const activityId = result.activityId ?? `result:${result.threadId}`;
    const activityKey = this.callbackKey(result.parentThreadId, result.threadId, activityId);
    let child = this.byActivity.get(activityKey)
      ?? (result.activityId
        ? this.readPersistedActivity(result.activityId, result.threadId, result.parentThreadId)
        : this.byThread.get(result.threadId) ?? this.readLatestPersisted(result.threadId, result.parentThreadId));
    if (!child) {
      if (result.activityId && this.input.database.providerAttempts.readProviderAttempt(
        this.input.projectId,
        nativeChildAttemptId(this.input.projectId, this.input.conversationId, this.input.providerId, result.parentThreadId, result.threadId, result.activityId),
      )) throw conflict("Native child activity callback lineage is missing or mismatched.");
      child = this.createChild({
        activityId,
        parentThreadId: result.parentThreadId,
        childThreadId: result.threadId,
        displayName: result.displayName,
        model: result.model ? { providerId: result.providerId, modelId: result.model } : null,
        reasoningEffort: result.reasoningEffort ?? null,
      });
    }
    this.assertLineage(child, result.parentThreadId, result.threadId);
    this.byActivity.set(activityKey, child);
    this.byThread.set(child.threadId, child);
    const terminalStatus = childResultStatus(result.status);
    const writes: StoredTopicMessageWrite[] = [];
    if (result.initialInput) {
      const entry = childInitialInputMessage({
        conversationId: this.input.conversationId,
        graphScopeId: this.input.graphScopeId,
        runId: this.input.runId,
        providerId: this.input.providerId,
        attemptId: child.attemptId,
        roleId: NATIVE_CHILD_AGENT_ROLE_ID,
        threadId: child.threadId,
        parentThreadId: child.parentThreadId,
        turnId: result.initialInput.turnId,
        itemId: result.initialInput.itemId,
        text: result.initialInput.text,
      });
      entry.agentSurfaceId = agentThreadSurfaceId(this.input.providerId, child.threadId);
      writes.push(toCanonicalTimelineMessage(this.input.projectId, this.input.conversationId, entry));
    }
    const resultStatus = terminalStatus ?? (child.status === "running" ? null : child.status);
    const resultMessage = resultStatus ? this.resultMessage(child, activityId, result, resultStatus) : null;
    const persistedResult = resultMessage ? this.input.database.timeline.readMessage(
      this.input.projectId,
      this.input.conversationId,
      resultMessage.id,
    ) : null;
    const terminalConflict = child.status !== "running"
      && terminalStatus !== null
      && terminalStatus !== child.status
      && terminalStatus !== "terminated";
    const maySupplementResult = !persistedResult && !terminalConflict;
    if (result.finalText.trim() && terminalStatus && maySupplementResult && resultMessage) writes.push(resultMessage);
    const updatedAt = new Date().toISOString();
    if (child.status !== "running") {
      if (terminalConflict) {
        writes.push(this.terminalConflictMessage(child, activityId, child.status, terminalStatus));
      }
      if (terminalStatus === "terminated" && child.status !== "terminated") {
        this.complete(child, "terminated", activityId, "Provider closed native child.", writes);
        return child;
      }
      if (writes.length > 0) {
        const rows = this.input.database.unitOfWork.commitProviderTerminalSupplement({
          projectId: this.input.projectId,
          conversationId: this.input.conversationId,
          attemptId: child.attemptId,
          expectedGraphScopeId: this.input.graphScopeId,
          timelineMessages: writes,
        });
        this.input.publish(rows);
      }
      return child;
    }
    if (!terminalStatus) {
      if (writes.length === 0 && !result.displayName) return child;
      const lineage = resolveNativeChildLineage(this.input.database, {
        projectId: this.input.projectId,
        conversationId: this.input.conversationId,
        providerId: this.input.providerId,
        graphScopeId: this.input.graphScopeId,
        parentThreadId: child.parentThreadId,
      });
      const rows = this.input.database.unitOfWork.commitProviderCallback({
        projectId: this.input.projectId,
        conversationId: this.input.conversationId,
        attemptId: child.attemptId,
        expectedGraphScopeId: this.input.graphScopeId,
        updatedAt,
        thread: {
          threadId: child.threadId,
          parentThreadId: child.parentThreadId,
          parentAgentSurfaceId: lineage.parentAgentSurfaceId,
          displayName: result.displayName ?? child.displayName,
          runId: this.input.runId,
        },
        timelineMessages: writes,
      });
      child.displayName = result.displayName ?? child.displayName;
      this.input.publish(rows);
      this.input.onInvalidated();
      return child;
    }
    const lineage = resolveNativeChildLineage(this.input.database, {
      projectId: this.input.projectId,
      conversationId: this.input.conversationId,
      providerId: this.input.providerId,
      graphScopeId: this.input.graphScopeId,
      parentThreadId: child.parentThreadId,
    });
    const rows = this.input.database.unitOfWork.commitProviderCallback({
      projectId: this.input.projectId,
      conversationId: this.input.conversationId,
      attemptId: child.attemptId,
      expectedGraphScopeId: this.input.graphScopeId,
      updatedAt,
      terminal: { status: terminalStatus, nativeSessionId: child.threadId },
      thread: {
        threadId: child.threadId,
        parentThreadId: child.parentThreadId,
        parentAgentSurfaceId: lineage.parentAgentSurfaceId,
        displayName: result.displayName ?? child.displayName,
        runId: this.input.runId,
      },
      timelineMessages: writes,
    });
    child.status = terminalStatus;
    child.displayName = result.displayName ?? child.displayName;
    this.input.publish(rows);
    this.input.onInvalidated();
    return child;
  }

  terminalAttempts(fallback: "failed" | "interrupted"): Array<{ attemptId: string; status: ChildTerminalStatus; nativeSessionId: string }> {
    return [...this.byThread.values()].map((child) => ({
      attemptId: child.attemptId,
      status: child.status === "running" ? fallback : child.status,
      nativeSessionId: child.threadId,
    }));
  }

  registeredForThread(threadId: string): AgentNativeChildRecord | null {
    return this.byThread.get(threadId) ?? null;
  }

  failCanonicalPersistence(child: AgentNativeChildRecord, activityId: string, error: Error): void {
    const row = this.input.database.unitOfWork.commitNativeChildPersistenceFailure({
      projectId: this.input.projectId,
      conversationId: this.input.conversationId,
      attemptId: child.attemptId,
      providerId: this.input.providerId,
      graphScopeId: this.input.graphScopeId,
      nativeSessionId: child.threadId,
      updatedAt: new Date().toISOString(),
      timelineMessage: this.statusMessage(
        child,
        `${activityId}:persistence-failure`,
        "failed",
        `Native child canonical persistence failed: ${boundedError(error)}`,
      ),
    });
    child.status = "failed";
    this.input.publish([row]);
    this.input.onInvalidated();
  }

  private createChild(input: {
    activityId: string;
    parentThreadId: string;
    childThreadId: string;
    displayName?: string;
    model: ProviderModelRef | null;
    reasoningEffort: string | null;
  }): AgentNativeChildRecord {
    const lineage = resolveNativeChildLineage(this.input.database, {
      projectId: this.input.projectId,
      conversationId: this.input.conversationId,
      providerId: this.input.providerId,
      graphScopeId: this.input.graphScopeId,
      parentThreadId: input.parentThreadId,
    });
    const attemptId = nativeChildAttemptId(
      this.input.projectId,
      this.input.conversationId,
      this.input.providerId,
      input.parentThreadId,
      input.childThreadId,
      input.activityId,
    );
    const now = new Date().toISOString();
    const child: AgentNativeChildRecord = {
      activityId: input.activityId,
      attemptId,
      threadId: input.childThreadId,
      parentThreadId: input.parentThreadId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      status: "running",
    };
    const statusMessage = this.statusMessage(child, input.activityId, "running", "Provider started native child.");
    const rows = this.input.database.unitOfWork.createProviderChildCallback({
      parentAttemptId: lineage.parentAttempt.attemptId,
      attempt: {
        accessPolicy: this.input.followupAccessPolicy ?? null,
        projectId: this.input.projectId,
        conversationId: this.input.conversationId,
        attemptId,
        productMode: "agent",
        agentTurnMode: lineage.parentAttempt.agentTurnMode ?? "default",
        graphScopeId: this.input.graphScopeId,
        changeId: null,
        agentTaskId: null,
        roleId: NATIVE_CHILD_AGENT_ROLE_ID,
        parentAgentSurfaceId: lineage.parentAgentSurfaceId,
        operationProfile: NATIVE_CHILD_OPERATION_PROFILE,
        operationKind: "conversation-turn",
        providerId: this.input.providerId,
        executionContract: resolveStoredExecutionContract({
          productMode: "agent",
          operationProfile: NATIVE_CHILD_OPERATION_PROFILE,
          operationKind: "conversation-turn",
          roleId: NATIVE_CHILD_AGENT_ROLE_ID,
          providerAdapterVersion: this.input.providerAdapterVersion,
        }),
        nativeSessionId: input.childThreadId,
        model: input.model ?? this.input.model,
        reasoningEffort: input.reasoningEffort ?? this.input.reasoningEffort,
        capabilitySnapshot: this.input.capabilitySnapshot,
        effectiveSkillInputs: [],
        handoffHash: childHandoffHash(this.input.parentHandoffHash, child),
        deliveredThroughCompletedTurn: this.input.deliveredThroughCompletedTurn,
        worktreeId: null,
        status: "running",
        createdAt: now,
        updatedAt: now,
      },
      requireRunningParent: this.input.requireRunningParent,
      thread: {
        threadId: input.childThreadId,
        parentThreadId: input.parentThreadId,
        parentAgentSurfaceId: lineage.parentAgentSurfaceId,
        displayName: input.displayName,
        runId: this.input.runId,
      },
      timelineMessages: [statusMessage, ...(this.input.initialTimelineMessages?.(child) ?? [])],
    });
    this.input.publish(rows);
    this.input.onInvalidated();
    return child;
  }

  private complete(
    child: AgentNativeChildRecord,
    status: ChildTerminalStatus,
    activityId: string,
    diagnostic: string,
    additionalTimelineMessages: StoredTopicMessageWrite[] = [],
  ): void {
    if (child.status === "terminated" || (child.status !== "running" && status !== "terminated")) return;
    const rows = this.input.database.unitOfWork.commitProviderCallback({
      projectId: this.input.projectId,
      conversationId: this.input.conversationId,
      attemptId: child.attemptId,
      expectedGraphScopeId: this.input.graphScopeId,
      updatedAt: new Date().toISOString(),
      terminal: { status, nativeSessionId: child.threadId },
      timelineMessages: [this.statusMessage(child, activityId, status, diagnostic), ...additionalTimelineMessages],
    });
    child.status = status;
    this.input.publish(rows);
    this.input.onInvalidated();
  }

  private readPersistedActivity(activityId: string, childThreadId: string, parentThreadId: string): AgentNativeChildRecord | null {
    const attemptId = nativeChildAttemptId(
      this.input.projectId,
      this.input.conversationId,
      this.input.providerId,
      parentThreadId,
      childThreadId,
      activityId,
    );
    const attempt = this.input.database.providerAttempts.readProviderAttempt(this.input.projectId, attemptId);
    if (!attempt) return null;
    const statusId = `status:${this.input.conversationId}:${this.input.providerId}:${childThreadId}:${stableHash(activityId)}`;
    const lineage = this.input.database.timeline.readMessage(this.input.projectId, this.input.conversationId, statusId);
    if (!lineage || lineage.threadId !== childThreadId) return null;
    const raw = JSON.parse(lineage.rawJson) as { attemptId?: string; parentThreadId?: string };
    if (raw.attemptId !== attemptId || raw.parentThreadId !== parentThreadId) return null;
    return this.recordFromAttempt(attempt, childThreadId, parentThreadId, activityId);
  }

  private readLatestPersisted(childThreadId: string, parentThreadId: string): AgentNativeChildRecord | null {
    const link = this.input.database.providerAttempts.listProviderThreads(this.input.projectId, this.input.conversationId)
      .find((candidate) => candidate.providerId === this.input.providerId
        && candidate.providerThreadId === childThreadId
        && candidate.parentThreadId === parentThreadId
        && candidate.graphScopeId === this.input.graphScopeId
        && candidate.roleId === NATIVE_CHILD_AGENT_ROLE_ID
        && candidate.capabilityProfile === NATIVE_CHILD_OPERATION_PROFILE);
    if (!link) return null;
    const attempt = this.input.database.providerAttempts.readProviderAttempt(this.input.projectId, link.attemptId);
    return attempt ? this.readPersistedAttempt(attempt, childThreadId, parentThreadId, `persisted:${childThreadId}`) : null;
  }

  private readPersistedAttempt(
    attempt: StoredProviderAttempt,
    childThreadId: string,
    parentThreadId: string,
    activityId: string,
  ): AgentNativeChildRecord | null {
    if (attempt.productMode !== "agent"
      || attempt.conversationId !== this.input.conversationId
      || attempt.providerId !== this.input.providerId
      || attempt.roleId !== NATIVE_CHILD_AGENT_ROLE_ID
      || attempt.operationProfile !== NATIVE_CHILD_OPERATION_PROFILE
      || attempt.graphScopeId !== this.input.graphScopeId
      || attempt.nativeSessionId !== childThreadId) return null;
    const link = this.input.database.providerAttempts.listProviderThreads(this.input.projectId, this.input.conversationId)
      .find((candidate) => candidate.attemptId === attempt.attemptId
        && candidate.providerThreadId === childThreadId
        && candidate.parentThreadId === parentThreadId);
    if (!link) return null;
    return this.recordFromAttempt(attempt, childThreadId, parentThreadId, activityId, link.displayName);
  }

  private recordFromAttempt(
    attempt: StoredProviderAttempt,
    childThreadId: string,
    parentThreadId: string,
    activityId: string,
    displayName?: string | null,
  ): AgentNativeChildRecord | null {
    if (attempt.productMode !== "agent"
      || attempt.conversationId !== this.input.conversationId
      || attempt.providerId !== this.input.providerId
      || attempt.roleId !== NATIVE_CHILD_AGENT_ROLE_ID
      || attempt.operationProfile !== NATIVE_CHILD_OPERATION_PROFILE
      || attempt.graphScopeId !== this.input.graphScopeId
      || attempt.nativeSessionId !== childThreadId) return null;
    const child: AgentNativeChildRecord = {
      activityId,
      attemptId: attempt.attemptId,
      threadId: childThreadId,
      parentThreadId,
      ...(displayName ? { displayName } : {}),
      status: attempt.status === "queued" || attempt.status === "running" ? "running"
        : attempt.status === "blocked" ? "failed" : attempt.status,
    };
    this.byThread.set(childThreadId, child);
    return child;
  }

  private resultMessage(child: AgentNativeChildRecord, activityId: string, result: ProviderChildThreadResult, status: ChildTerminalStatus): StoredTopicMessageWrite {
    return toCanonicalTimelineMessage(this.input.projectId, this.input.conversationId, {
      id: `assistant:${this.input.conversationId}:${this.input.providerId}:${child.threadId}:${stableHash(activityId)}:result`,
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      conversationId: this.input.conversationId,
      graphScopeId: this.input.graphScopeId,
      changeId: "",
      text: result.finalText,
      status,
      runId: this.input.runId,
      providerId: this.input.providerId,
      sessionId: child.threadId,
      attemptId: child.attemptId,
      threadId: child.threadId,
      parentThreadId: child.parentThreadId,
      agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
      agentSurfaceId: agentThreadSurfaceId(this.input.providerId, child.threadId),
    });
  }

  private terminalConflictMessage(
    child: AgentNativeChildRecord,
    activityId: string,
    canonicalStatus: ChildTerminalStatus,
    receivedStatus: ChildTerminalStatus,
  ): StoredTopicMessageWrite {
    return toCanonicalTimelineMessage(this.input.projectId, this.input.conversationId, {
      id: `status:${this.input.conversationId}:${this.input.providerId}:${child.threadId}:${stableHash(activityId)}:terminal-conflict`,
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      conversationId: this.input.conversationId,
      graphScopeId: this.input.graphScopeId,
      changeId: "",
      text: `Ignored conflicting native child terminal result (${receivedStatus}); canonical status remains ${canonicalStatus}.`.slice(0, 240),
      status: canonicalStatus,
      runId: this.input.runId,
      providerId: this.input.providerId,
      attemptId: child.attemptId,
      threadId: child.threadId,
      parentThreadId: child.parentThreadId,
      agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
      agentSurfaceId: agentThreadSurfaceId(this.input.providerId, child.threadId),
    });
  }

  private statusMessage(child: AgentNativeChildRecord, activityId: string, status: string, diagnostic: string): StoredTopicMessageWrite {
    return toCanonicalTimelineMessage(this.input.projectId, this.input.conversationId, {
      id: `status:${this.input.conversationId}:${this.input.providerId}:${child.threadId}:${stableHash(activityId)}`,
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      conversationId: this.input.conversationId,
      graphScopeId: this.input.graphScopeId,
      changeId: "",
      text: diagnostic.slice(0, 240),
      status,
      runId: this.input.runId,
      providerId: this.input.providerId,
      attemptId: child.attemptId,
      threadId: child.threadId,
      parentThreadId: child.parentThreadId,
      agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
      agentSurfaceId: agentThreadSurfaceId(this.input.providerId, child.threadId),
    });
  }

  private callbackKey(parentThreadId: string, childThreadId: string, activityId: string): string {
    return [this.input.projectId, this.input.conversationId, this.input.providerId, parentThreadId, childThreadId, activityId].join("\0");
  }

  private assertProvider(...providerIds: string[]): void {
    if (providerIds.some((providerId) => providerId !== this.input.providerId)) throw conflict("Native child Provider identity does not match the parent Agent Turn.");
  }

  private assertLineage(child: AgentNativeChildRecord, parentThreadId: string, childThreadId: string): void {
    if (child.parentThreadId !== parentThreadId || child.threadId !== childThreadId) throw conflict("Native child parent-child lineage is immutable.");
  }
}

export async function runAgentNativeChildFollowup(input: {
  project: ManagedProject;
  conversationId: string;
  agentSurfaceId: string;
  message: string;
  live?: WorkbenchLiveSink;
  providerRegistry?: ProviderRegistry;
}): Promise<TopicMessageResult> {
  const providerRegistry = input.providerRegistry ?? defaultProviderRegistry;
  const runtimeState = await resolveProjectRuntimeState(input.project, {
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  });
  const paths = runtimeState.state === "onboarding" ? runtimeState.paths : runtimeState.resolution.paths;
  const parsedSurface = parseAgentThreadSurfaceId(input.agentSurfaceId);
  const database = await openProjectRuntimeWorkbenchDatabase(paths, { providerRegistry });
  const delivery = new CanonicalTimelineDelivery(database, "agent", input.live);
  try {
    const conversation = database.conversations.readConversation(paths.projectId, input.conversationId);
    if (!conversation || conversation.deletedAt || conversation.state !== "active" || conversation.productMode !== "agent") {
      throw conflict("Native child follow-up requires an active Agent Conversation.");
    }
    if (!conversation.currentGraphScopeId
      || database.conversations.isConversationGraphScopeTerminal(paths.projectId, conversation.currentGraphScopeId)) {
      throw conflict("Native child follow-up requires the current active Conversation scope.");
    }
    if (parsedSurface.providerId !== conversation.selectedProviderId) {
      throw conflict("Native child Provider does not match the Agent Conversation selection.");
    }
    const links = database.providerAttempts.listProviderThreads(paths.projectId, conversation.conversationId);
    const childLink = links.find((link) => link.providerId === parsedSurface.providerId
      && link.providerThreadId === parsedSurface.threadId
      && link.graphScopeId === conversation.currentGraphScopeId
      && link.roleId === NATIVE_CHILD_AGENT_ROLE_ID
      && link.capabilityProfile === NATIVE_CHILD_OPERATION_PROFILE);
    if (!childLink?.parentThreadId) {
      throw conflict("Native child lineage does not match the selected Agent Conversation.");
    }
    const lineage = resolveNativeChildLineage(database, {
      projectId: paths.projectId,
      conversationId: conversation.conversationId,
      providerId: conversation.selectedProviderId,
      graphScopeId: conversation.currentGraphScopeId,
      parentThreadId: childLink.parentThreadId,
    });
    if (childLink.parentAgentSurfaceId !== lineage.parentAgentSurfaceId) {
      throw conflict("Native child persisted parent Agent surface is mismatched.");
    }
    const previousAttempt = database.providerAttempts.readProviderAttempt(paths.projectId, childLink.attemptId);
    const parentAttempt = lineage.parentAttempt;
    if (!previousAttempt || !parentAttempt
      || previousAttempt.productMode !== "agent"
      || previousAttempt.conversationId !== conversation.conversationId
      || previousAttempt.providerId !== conversation.selectedProviderId
      || previousAttempt.nativeSessionId !== childLink.providerThreadId
      || parentAttempt.conversationId !== conversation.conversationId
      || parentAttempt.providerId !== conversation.selectedProviderId
      || parentAttempt.graphScopeId !== conversation.currentGraphScopeId
      || parentAttempt.nativeSessionId !== childLink.parentThreadId) {
      throw conflict("Native child persisted lineage is incomplete or mismatched.");
    }
    if (previousAttempt.status === "queued" || previousAttempt.status === "running") {
      throw conflict("Native child already has an active activity and cannot receive concurrent follow-up.");
    }
    if (previousAttempt.status === "terminated") throw conflict("Native child is closed and cannot receive follow-up.");

    const provider = providerRegistry.get(conversation.selectedProviderId);
    const inspected = await provider.conversation.inspectChild({
      providerId: conversation.selectedProviderId,
      projectId: input.project.id,
      cwd: input.project.path,
      parentSession: { providerId: conversation.selectedProviderId, sessionId: childLink.parentThreadId },
      targetSession: { providerId: conversation.selectedProviderId, sessionId: childLink.providerThreadId },
    });
    if (inspected !== "available") throw conflict("Native child is stale and cannot receive follow-up.");
    const resolvedProvider = await providerRegistry.requireProfiles(
      conversation.selectedProviderId,
      [NATIVE_CHILD_OPERATION_PROFILE],
      "agent",
      input.project,
      input.project.path,
    );
    const runId = `agent-child-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    // Follow-up remains within the existing child workspace ceiling and its parent's read-only constraint.
    const followupAccessPolicy = resolveAgentAccessPolicy({ productMode: "agent", accessMode: "default",
      turnMode: parentAttempt.agentTurnMode ?? "default", projectRoot: input.project.path,
      readOnlyRole: parentAttempt.accessPolicy?.sandboxPolicy === "read-only" || previousAttempt.accessPolicy?.sandboxPolicy === "read-only",
      supportsFullAccess: false, supportsApproval: false,
    });
    const activityId = `followup:${runId}`;
    const runRoot = join(paths.runsRoot, "agent-conversations", conversation.conversationId, runId);
    await mkdir(runRoot, { recursive: true });
    let lifecycle: AgentNativeChildLifecycleService | null = null;
    let canonicalPersistenceError: Error | null = null;
    const capture = createAssistantTranscriptCapture(input.live, (snapshot) => {
      if (canonicalPersistenceError) return false;
      try {
        const writes = buildCanonicalCaptureWrites({
          projectId: paths.projectId,
          conversationId: conversation.conversationId,
          graphScopeId: conversation.currentGraphScopeId!,
          runId,
          providerId: conversation.selectedProviderId,
          attemptId: childLink.attemptId,
          mainTimelineId: `assistant:${conversation.conversationId}:${runId}:unused-main`,
          mainSessionId: null,
          snapshot,
        }).filter((write) => write.agentSurfaceId === input.agentSurfaceId);
        if (writes.length > 0) delivery.publishCommittedMany(database.unitOfWork.commitProviderCallback({
          projectId: paths.projectId,
          conversationId: conversation.conversationId,
            attemptId: lifecycle?.registeredForThread(parsedSurface.threadId)?.attemptId ?? childLink.attemptId,
          expectedGraphScopeId: conversation.currentGraphScopeId!,
          updatedAt: new Date().toISOString(),
          timelineMessages: writes,
        }));
        return true;
      } catch (error) {
        canonicalPersistenceError ??= asError(error);
        return false;
      }
    });
    lifecycle = new AgentNativeChildLifecycleService({
      database,
      projectId: paths.projectId,
      conversationId: conversation.conversationId,
      graphScopeId: conversation.currentGraphScopeId,
      runId,
      parentAttemptId: parentAttempt.attemptId,
      followupAccessPolicy,
      providerId: conversation.selectedProviderId,
      providerAdapterVersion: resolvedProvider.descriptor.adapter.version,
      capabilitySnapshot: resolvedProvider.snapshot,
      model: previousAttempt.model,
      reasoningEffort: previousAttempt.reasoningEffort,
      parentHandoffHash: parentAttempt.handoffHash,
      deliveredThroughCompletedTurn: conversation.completedTurnSequence,
      capture,
      requireRunningParent: false,
      initialTimelineMessages: (createdChild) => [toCanonicalTimelineMessage(paths.projectId, conversation.conversationId, {
        id: `user:${conversation.conversationId}:${conversation.selectedProviderId}:${runId}`,
        type: "user.message",
        timestamp: new Date().toISOString(),
        conversationId: conversation.conversationId,
        graphScopeId: conversation.currentGraphScopeId!,
        changeId: "",
        text: input.message,
        runId,
        providerId: conversation.selectedProviderId,
        sessionId: createdChild.threadId,
        attemptId: createdChild.attemptId,
        threadId: createdChild.threadId,
        parentThreadId: createdChild.parentThreadId,
        agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
        agentSurfaceId: input.agentSurfaceId,
      })],
      publish: (rows) => delivery.publishCommittedMany(rows),
      onInvalidated: () => undefined,
    });
    const child = lifecycle.onLifecycle({
      providerId: conversation.selectedProviderId,
      kind: "continued",
      activityId,
      parentSession: { providerId: conversation.selectedProviderId, sessionId: childLink.parentThreadId },
      childSession: { providerId: conversation.selectedProviderId, sessionId: childLink.providerThreadId },
      displayName: childLink.displayName ?? undefined,
    });
    if (!child) throw new Error("Native child follow-up Attempt could not be created.");
    const user: TopicThreadEntry = {
      id: `user:${conversation.conversationId}:${conversation.selectedProviderId}:${runId}`,
      type: "user.message",
      timestamp: new Date().toISOString(),
      conversationId: conversation.conversationId,
      graphScopeId: conversation.currentGraphScopeId,
      changeId: "",
      text: input.message,
      runId,
      providerId: conversation.selectedProviderId,
      sessionId: child.threadId,
      attemptId: child.attemptId,
      threadId: child.threadId,
      parentThreadId: child.parentThreadId,
      agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
      agentSurfaceId: input.agentSurfaceId,
    };
    let result;
    try {
      result = await resolvedProvider.descriptor.conversation.continueChild({
      providerId: conversation.selectedProviderId,
      operationProfile: NATIVE_CHILD_OPERATION_PROFILE,
      projectId: input.project.id,
      conversationId: conversation.conversationId,
      graphScopeId: conversation.currentGraphScopeId,
      runtimeScopeId: `${conversation.conversationId}:${input.agentSurfaceId}:${runId}`,
      roleId: NATIVE_CHILD_AGENT_ROLE_ID,
      runId,
      attemptId: child.attemptId,
      cwd: input.project.path,
      prompt: input.message,
      sandboxPolicy: followupAccessPolicy.sandboxPolicy,
      writableRoots: [...followupAccessPolicy.writableRoots],
      approvalMode: followupAccessPolicy.approvalMode,
      runtimeWorkspaceRoots: [input.project.path],
      paths: providerArtifactPaths(runRoot),
      parentSession: { providerId: conversation.selectedProviderId, sessionId: child.parentThreadId },
      targetSession: { providerId: conversation.selectedProviderId, sessionId: child.threadId },
      targetDisplayName: child.displayName,
      onRealtimeEvent: (event) => {
        const normalized = lifecycle.onRealtime(event);
        if (normalized) forwardProviderRealtimeEvent(normalized, capture.sink, { productMode: "agent", graphScopeId: conversation.currentGraphScopeId! });
      },
      onChildLifecycleEvent: (event) => { lifecycle.onLifecycle(event); },
      onError: (error) => input.live?.emit({ event: "error", data: {
        projectId: paths.projectId,
        productMode: "agent",
        conversationId: conversation.conversationId,
        graphScopeId: conversation.currentGraphScopeId!,
        providerId: conversation.selectedProviderId,
        attemptId: child.attemptId,
        threadId: child.threadId,
        parentThreadId: child.parentThreadId,
        agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
        agentSurfaceId: input.agentSurfaceId,
        runId,
        message: error instanceof Error ? error.message : String(error),
      } }),
      model: previousAttempt.model,
      reasoningEffort: previousAttempt.reasoningEffort,
      });
    } catch (error) {
      lifecycle.onResult({
        providerId: conversation.selectedProviderId,
        activityId,
        parentThreadId: child.parentThreadId,
        threadId: child.threadId,
        status: "failed",
        displayName: child.displayName,
        finalText: "",
        changedFiles: [],
      });
      throw error;
    }
    if (canonicalPersistenceError) {
      lifecycle.failCanonicalPersistence(child, activityId, canonicalPersistenceError);
      throw canonicalPersistenceError;
    }
    lifecycle.onResult({
      providerId: conversation.selectedProviderId,
      activityId,
      parentThreadId: child.parentThreadId,
      threadId: child.threadId,
      status: result.status,
      displayName: child.displayName,
      finalText: result.lastMessage,
      changedFiles: result.changedFiles,
    });
    if (result.status === "failed") {
      throw new Error(`Native child follow-up failed: ${String(result.error ?? "Provider returned failed status.").slice(0, 240)}`);
    }
    const assistant = result.lastMessage ? {
      id: `assistant:${conversation.conversationId}:${conversation.selectedProviderId}:${child.threadId}:${stableHash(activityId)}:result`,
      type: "assistant.message" as const,
      timestamp: new Date().toISOString(),
      conversationId: conversation.conversationId,
      graphScopeId: conversation.currentGraphScopeId,
      changeId: "",
      text: result.lastMessage,
      status: result.status,
      runId,
      providerId: conversation.selectedProviderId,
      attemptId: child.attemptId,
      threadId: child.threadId,
      parentThreadId: child.parentThreadId,
      turnId: result.turnId ?? undefined,
      agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
      agentSurfaceId: input.agentSurfaceId,
    } : null;
    return { user, assistant, run: null, providerSessionId: child.threadId, mode: "chat", assistantMessage: result.lastMessage };
  } finally {
    database.close();
  }
}

export async function reconcileStaleAgentNativeChildren(input: {
  project: ManagedProject;
  providerRegistry?: ProviderRegistry;
}): Promise<number> {
  const runtimeState = await resolveProjectRuntimeState(input.project, { discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY });
  const paths = runtimeState.state === "onboarding" ? runtimeState.paths : runtimeState.resolution.paths;
  const database = await openProjectRuntimeWorkbenchDatabase(paths, { providerRegistry: input.providerRegistry });
  let reconciled = 0;
  try {
    for (const conversation of database.conversations.listConversations(paths.projectId, "agent")) {
      for (const attempt of database.providerAttempts.listProviderAttempts(paths.projectId, conversation.conversationId)) {
        if (attempt.productMode !== "agent"
          || attempt.roleId !== NATIVE_CHILD_AGENT_ROLE_ID
          || attempt.operationProfile !== NATIVE_CHILD_OPERATION_PROFILE
          || (attempt.status !== "queued" && attempt.status !== "running")) continue;
        const link = database.providerAttempts.listProviderThreads(paths.projectId, conversation.conversationId)
          .find((candidate) => candidate.attemptId === attempt.attemptId && candidate.parentThreadId);
        const recoveryIdentity = nativeChildRecoveryIdentity(attempt);
        if (!attempt.graphScopeId || !attempt.nativeSessionId) {
          const diagnostic = toCanonicalTimelineMessage(paths.projectId, conversation.conversationId, {
            id: `status:${conversation.conversationId}:${attempt.providerId}:${stableHash(attempt.attemptId)}:restart-missing-identity`,
            type: "assistant.message",
            timestamp: new Date().toISOString(),
            conversationId: conversation.conversationId,
            ...(attempt.graphScopeId ? { graphScopeId: attempt.graphScopeId } : {}),
            changeId: "",
            text: "Native child activity was quarantined after Workbench restart because its persisted Provider identity was incomplete.",
            status: "failed",
            providerId: attempt.providerId,
            attemptId: attempt.attemptId,
            ...(attempt.nativeSessionId ? { threadId: attempt.nativeSessionId } : {}),
            parentThreadId: link?.parentThreadId ?? undefined,
            agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
            agentSurfaceId: recoveryIdentity.agentSurfaceId,
          });
          try {
            database.unitOfWork.commitNativeChildRecoveryQuarantine({
              projectId: paths.projectId,
              conversationId: conversation.conversationId,
              attemptId: attempt.attemptId,
              providerId: attempt.providerId,
              graphScopeId: attempt.graphScopeId,
              nativeSessionId: attempt.nativeSessionId,
              updatedAt: new Date().toISOString(),
              timelineMessage: diagnostic,
            });
            reconciled += 1;
          } catch {
            // A corrupt row is isolated so recovery can continue with other Attempts and projects.
          }
          continue;
        }
        let activeProof = false;
        try {
          if (!link?.parentThreadId) throw new Error("Native child lineage is missing.");
          activeProof = await (input.providerRegistry ?? defaultProviderRegistry).get(attempt.providerId).conversation.inspectChild({
            providerId: attempt.providerId,
            projectId: paths.projectId,
            cwd: input.project.path,
            parentSession: { providerId: attempt.providerId, sessionId: link.parentThreadId },
            targetSession: { providerId: attempt.providerId, sessionId: attempt.nativeSessionId },
          }) === "available";
        } catch {
          // Restart recovery treats missing Provider proof as stale, never as live activity.
        }
        if (activeProof) continue;
        const diagnostic = toCanonicalTimelineMessage(paths.projectId, conversation.conversationId, {
          id: `status:${conversation.conversationId}:${attempt.providerId}:${attempt.nativeSessionId}:restart-stale`,
          type: "assistant.message",
          timestamp: new Date().toISOString(),
          conversationId: conversation.conversationId,
          graphScopeId: attempt.graphScopeId,
          changeId: "",
          text: "Native child activity was marked stale after Workbench restart because no active Provider proof was available.",
          status: "failed",
          providerId: attempt.providerId,
          attemptId: attempt.attemptId,
          threadId: attempt.nativeSessionId,
          parentThreadId: link?.parentThreadId ?? undefined,
          agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
          agentSurfaceId: agentThreadSurfaceId(attempt.providerId, attempt.nativeSessionId),
        });
        try {
          database.unitOfWork.commitHistoricalNativeChildRecovery({
            projectId: paths.projectId,
            conversationId: conversation.conversationId,
            attemptId: attempt.attemptId,
            providerId: attempt.providerId,
            graphScopeId: attempt.graphScopeId,
            nativeSessionId: attempt.nativeSessionId,
            parentThreadId: link?.parentThreadId ?? null,
            updatedAt: new Date().toISOString(),
            timelineMessage: diagnostic,
          });
          reconciled += 1;
        } catch (error) {
          const quarantineDiagnostic = toCanonicalTimelineMessage(paths.projectId, conversation.conversationId, {
            id: `status:${conversation.conversationId}:${attempt.providerId}:${attempt.nativeSessionId}:restart-malformed`,
            type: "assistant.message",
            timestamp: new Date().toISOString(),
            conversationId: conversation.conversationId,
            graphScopeId: attempt.graphScopeId,
            changeId: "",
            text: `Native child activity was quarantined after malformed persisted lineage: ${boundedError(error)}`,
            status: "failed",
            providerId: attempt.providerId,
            attemptId: attempt.attemptId,
            threadId: attempt.nativeSessionId,
            parentThreadId: link?.parentThreadId ?? undefined,
            agentRoleId: NATIVE_CHILD_AGENT_ROLE_ID,
            agentSurfaceId: agentThreadSurfaceId(attempt.providerId, attempt.nativeSessionId),
          });
          try {
            database.unitOfWork.commitNativeChildRecoveryQuarantine({
              projectId: paths.projectId,
              conversationId: conversation.conversationId,
              attemptId: attempt.attemptId,
              providerId: attempt.providerId,
              graphScopeId: attempt.graphScopeId,
              nativeSessionId: attempt.nativeSessionId,
              updatedAt: new Date().toISOString(),
              timelineMessage: quarantineDiagnostic,
            });
            reconciled += 1;
          } catch {
            // A corrupt row is isolated so recovery can continue with other Attempts and projects.
          }
        }
      }
    }
    return reconciled;
  } finally {
    database.close();
  }
}

function nativeChildRecoveryIdentity(attempt: StoredProviderAttempt): { agentSurfaceId: string } {
  return {
    agentSurfaceId: attempt.nativeSessionId
      ? agentThreadSurfaceId(attempt.providerId, attempt.nativeSessionId)
      : `agent:${encodeURIComponent(attempt.providerId)}:recovery-attempt:${encodeURIComponent(attempt.attemptId)}`,
  };
}

function parseAgentThreadSurfaceId(surfaceId: string): { providerId: string; threadId: string } {
  const match = /^agent:([^:]+):thread:(.+)$/.exec(surfaceId);
  if (!match?.[1] || !match[2]) throw conflict("Native child Agent surface identity is malformed.");
  try {
    return { providerId: decodeURIComponent(match[1]), threadId: decodeURIComponent(match[2]) };
  } catch {
    throw conflict("Native child Agent surface identity is malformed.");
  }
}

function providerArtifactPaths(root: string) {
  return {
    events: join(root, "provider-events.jsonl"),
    stderr: join(root, "provider-stderr.log"),
    lastMessage: join(root, "last-message.md"),
    session: join(root, "provider-session.json"),
  };
}

export function nativeChildAttemptId(
  projectId: string,
  conversationId: string,
  providerId: string,
  parentThreadId: string,
  childThreadId: string,
  activityId: string,
): string {
  return `native-child:${stableHash([
    projectId,
    conversationId,
    providerId,
    parentThreadId,
    childThreadId,
    activityId,
  ].join("\0"))}`;
}

function childHandoffHash(parentHandoffHash: string, child: AgentNativeChildRecord): string {
  return createHash("sha256").update(JSON.stringify({
    parentHandoffHash,
    parentThreadId: child.parentThreadId,
    childThreadId: child.threadId,
    activityId: child.activityId,
    roleId: NATIVE_CHILD_AGENT_ROLE_ID,
    operationProfile: NATIVE_CHILD_OPERATION_PROFILE,
  })).digest("hex");
}

function resolveNativeChildLineage(database: WorkbenchDatabase, input: {
  projectId: string;
  conversationId: string;
  providerId: string;
  graphScopeId: string;
  parentThreadId: string;
}): { parentAttempt: StoredProviderAttempt; parentAgentSurfaceId: string; rootMainLink: StoredProviderThreadLink } {
  const links = database.providerAttempts.listProviderThreads(input.projectId, input.conversationId);
  const linksByThread = new Map<string, StoredProviderThreadLink>();
  for (const link of links) {
    if (link.providerId !== input.providerId || link.graphScopeId !== input.graphScopeId) continue;
    if (linksByThread.has(link.providerThreadId)) throw conflict(`Native child lineage has duplicate ThreadLink identity: ${link.providerThreadId}.`);
    linksByThread.set(link.providerThreadId, link);
  }
  const directParent = linksByThread.get(input.parentThreadId);
  if (!directParent) throw conflict(`Native child parent Thread is orphaned: ${input.parentThreadId}.`);
  const parentAttempt = assertNativeLineageAttempt(database, input, directParent);
  const parentAgentSurfaceId = directParent.roleId === "main-agent"
    ? "main-agent"
    : agentThreadSurfaceId(input.providerId, directParent.providerThreadId);
  const visited = new Set<string>();
  let current = directParent;
  for (;;) {
    if (visited.has(current.providerThreadId)) throw conflict("Native child lineage contains a cycle.");
    visited.add(current.providerThreadId);
    assertNativeLineageAttempt(database, input, current);
    if (current.roleId === "main-agent") {
      if (current.parentThreadId !== null || current.parentAgentSurfaceId !== null) {
        throw conflict("Native child lineage root Main Agent is malformed.");
      }
      return { parentAttempt, parentAgentSurfaceId, rootMainLink: current };
    }
    if (current.roleId !== NATIVE_CHILD_AGENT_ROLE_ID
      || current.capabilityProfile !== NATIVE_CHILD_OPERATION_PROFILE
      || !current.parentThreadId) {
      throw conflict("Native child lineage contains a mismatched or orphaned ancestor.");
    }
    const ancestor = linksByThread.get(current.parentThreadId);
    if (!ancestor) throw conflict(`Native child ancestor Thread is orphaned: ${current.parentThreadId}.`);
    const canonicalSurface = ancestor.roleId === "main-agent"
      ? "main-agent"
      : agentThreadSurfaceId(input.providerId, ancestor.providerThreadId);
    if (current.parentAgentSurfaceId !== canonicalSurface) {
      throw conflict("Native child lineage has mismatched parent Agent surface identity.");
    }
    current = ancestor;
  }
}

function assertNativeLineageAttempt(database: WorkbenchDatabase, input: {
  projectId: string;
  conversationId: string;
  providerId: string;
  graphScopeId: string;
}, link: StoredProviderThreadLink): StoredProviderAttempt {
  const attempt = database.providerAttempts.readProviderAttempt(input.projectId, link.attemptId);
  if (!attempt
    || link.conversationId !== input.conversationId
    || link.providerId !== input.providerId
    || link.graphScopeId !== input.graphScopeId
    || attempt.conversationId !== input.conversationId
    || attempt.providerId !== input.providerId
    || attempt.graphScopeId !== input.graphScopeId
    || attempt.nativeSessionId !== link.providerThreadId
    || attempt.roleId !== link.roleId
    || attempt.operationProfile !== link.capabilityProfile) {
    throw conflict("Native child persisted lineage is incomplete or mismatched.");
  }
  return attempt;
}

function childResultStatus(status: string | undefined): ChildTerminalStatus | null {
  if (status === "completed" || status === "failed" || status === "interrupted" || status === "terminated") return status;
  return null;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}
