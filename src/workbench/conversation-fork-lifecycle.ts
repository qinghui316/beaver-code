import { createHash, randomUUID } from "node:crypto";
import type { ManagedProject } from "../types/index.js";
import type { ProductMode, ProviderId, ProviderModelRef, ProviderSessionForkResult, ProviderSessionForkTransportDiagnostic, ProviderSessionForkTransportStage } from "../provider-runtime/index.js";
import type { ProviderRegistry } from "../provider-runtime/registry.js";
import type { ProjectRuntimeCoordinatorPort } from "../project-runtime/coordinator.js";
import type { ProjectRuntimePaths } from "../project-runtime/paths.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type { StoredConversation, StoredConversationForkOperation, StoredTopicMessage, StoredTopicMessageWrite } from "./persistence/contracts.js";
import type { ConversationTurnControlOwner } from "./conversation-turn-control.js";
import type { ConversationContextLifecycleOwner } from "./conversation-context-lifecycle.js";
import { publishConversationForkCompleted } from "./project-live-events.js";

export interface ConversationForkRequest {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  providerId: ProviderId;
  sourceMessageId: string;
  expectedCompletedTurnSequence: number;
  expectedTimelineRevision: number;
  contextRevision: string;
  clientRequestId: string;
}

export interface ConversationForkReceipt {
  status: "forked" | "replayed";
  sourceConversationId: string;
  targetConversationId: string;
}

type PreparedFork = {
  paths: ProjectRuntimePaths;
  conversation: StoredConversation;
  operation: StoredConversationForkOperation;
  anchor: StoredTopicMessage;
  sourceRows: StoredTopicMessage[];
  sourceSessionId: string;
  anchorTurnId: string;
  preferredModel: ProviderModelRef | null;
  recovery: boolean;
};

export class ConversationForkLifecycleOwner {
  private readonly submissions = new Map<string, { requestHash: string; promise: Promise<ConversationForkReceipt> }>();
  private readonly accepted = new Map<string, {
    requestHash: string;
    prepared: PreparedFork;
    result: ProviderSessionForkResult;
  }>();

  constructor(private readonly options: {
    providerRegistry: ProviderRegistry;
    projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve">;
    turnControl: ConversationTurnControlOwner;
    conversationContext: ConversationContextLifecycleOwner;
  }) {}

  async fork(project: ManagedProject, request: ConversationForkRequest): Promise<ConversationForkReceipt> {
    const normalized = normalizeRequest(request);
    if (normalized.projectId !== project.id) throw conflict("Conversation fork project identity does not match.");
    if (normalized.productMode !== "agent") throw conflict("Conversation fork is available only in Agent mode.");
    const requestHash = forkRequestHash(normalized);
    const key = `${normalized.projectId}\0${normalized.clientRequestId}`;
    const existingSubmission = this.submissions.get(key);
    if (existingSubmission) {
      if (existingSubmission.requestHash !== requestHash) throw conflict("Conversation fork clientRequestId is bound to another request.");
      return existingSubmission.promise;
    }
    const promise = this.submit(project, normalized, requestHash).finally(() => this.submissions.delete(key));
    this.submissions.set(key, { requestHash, promise });
    return promise;
  }

  async reconcileProject(paths: ProjectRuntimePaths): Promise<number> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const now = new Date().toISOString();
      let changed = 0;
      for (const operation of database.conversationForks.listIncomplete(paths.projectId)) {
        database.conversationForks.update({
          projectId: paths.projectId,
          clientRequestId: operation.clientRequestId,
          expectedStatus: operation.status,
          status: "interrupted",
          diagnostic: "Fork operation was interrupted because no exact live Provider proof survived restart.",
          updatedAt: now,
        });
        changed += 1;
      }
      return changed;
    } finally {
      database.close();
    }
  }

  private async submit(project: ManagedProject, request: ConversationForkRequest, requestHash: string): Promise<ConversationForkReceipt> {
    const retainedKey = `${request.projectId}\0${request.clientRequestId}`;
    const retained = this.accepted.get(retainedKey);
    if (retained) {
      if (retained.requestHash !== requestHash) throw conflict("Conversation fork clientRequestId conflicts with accepted Provider evidence.");
      return this.materialize(retained.prepared, retained.result, true);
    }
    const prepared = await this.prepare(project, request, requestHash);
    if (prepared.operation.status === "completed" && prepared.operation.targetConversationId) {
      return replayReceipt(prepared.operation);
    }
    if (prepared.operation.status === "submitting") {
      throw uncertain("Conversation fork outcome is uncertain and cannot be sent again automatically.");
    }
    if (prepared.operation.status === "failed" || prepared.operation.status === "interrupted") {
      throw conflict("Conversation fork request is terminal; retry with a new clientRequestId.");
    }
    await this.transition(prepared.paths, prepared.operation, "pending", "submitting");
    const provider = this.options.providerRegistry.get(request.providerId);
    let result: ProviderSessionForkResult;
    try {
      result = await provider.conversation.forkSession({
        providerId: request.providerId,
        projectId: request.projectId,
        cwd: project.path,
        sourceSession: { providerId: request.providerId, sessionId: prepared.sourceSessionId },
        anchorTurn: { providerId: request.providerId, sessionId: prepared.sourceSessionId, turnId: prepared.anchorTurnId },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ProviderSessionForkRejected") {
        const message = prepared.recovery
          ? "Provider 无法从失效 Session 创建恢复分支，请创建全新会话。"
          : "Provider rejected the conversation fork.";
        await this.transition(prepared.paths, prepared.operation, "submitting", "failed", message);
        throw conflict(message);
      }
      const diagnostic = forkTransportDiagnostic(error);
      await this.transition(prepared.paths, prepared.operation, "submitting", "submitting", diagnostic);
      throw uncertain(`${diagnostic} The request was not retried.`, error);
    }
    if (result.session.providerId !== request.providerId
      || result.inheritedThroughTurn.providerId !== request.providerId
      || result.inheritedThroughTurn.sessionId !== result.session.sessionId
      || result.inheritedThroughTurn.turnId !== prepared.anchorTurnId
      || result.session.sessionId === prepared.sourceSessionId) {
      throw uncertain("Provider returned fork evidence that does not match the admitted anchor.");
    }
    this.accepted.set(retainedKey, { requestHash, prepared, result });
    return this.materialize(prepared, result, false);
  }

  private async prepare(project: ManagedProject, request: ConversationForkRequest, requestHash: string): Promise<PreparedFork> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const replayDatabase = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const replay = replayDatabase.conversationForks.read(paths.projectId, request.clientRequestId);
      if (replay && replay.requestHash !== requestHash) throw conflict("Conversation fork clientRequestId is bound to another request.");
      if (replay?.status === "completed" && replay.targetConversationId) {
        const conversation = replayDatabase.conversations.readConversation(paths.projectId, request.conversationId);
        const anchor = replayDatabase.timeline.readMessage(paths.projectId, request.conversationId, request.sourceMessageId);
        if (!conversation || !anchor) throw conflict("Conversation fork replay evidence is incomplete.");
        return { paths, conversation, operation: replay, anchor, sourceRows: [], sourceSessionId: "", anchorTurnId: "", preferredModel: null, recovery: false };
      }
    } finally {
      replayDatabase.close();
    }
    const contextSnapshot = await this.options.conversationContext.read(project, request.productMode, request.conversationId);
    if (contextSnapshot.contextRevision !== request.contextRevision) throw conflict("Conversation fork context revision is stale.");
    if (contextSnapshot.lifecycle === "submitting" || contextSnapshot.lifecycle === "compacting") {
      throw conflict("Conversation fork is unavailable while context compaction is in progress.");
    }
    const turnControl = this.options.turnControl.state(request.projectId, request.conversationId);
    if (turnControl.state !== "idle") throw conflict("Conversation fork is unavailable while Stop, Steer, or a Provider Turn is active.");
    if (this.options.providerRegistry.findActiveTurn(request.conversationId)) {
      throw conflict("Conversation fork is unavailable while the Provider session is active.");
    }
    const capability = await this.options.providerRegistry.get(request.providerId)
      .capabilitySnapshot(project, request.productMode, project.path);
    if (!capability.capabilities.some((item) => item.key === "session.fork" && item.runtime === "ready")) {
      throw conflict("The selected Provider does not support conversation fork.");
    }
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    let operation: StoredConversationForkOperation | null = null;
    try {
      operation = database.conversationForks.read(paths.projectId, request.clientRequestId);
      if (operation && operation.requestHash !== requestHash) throw conflict("Conversation fork clientRequestId is bound to another request.");
      const conversation = database.conversations.readConversation(paths.projectId, request.conversationId);
      if (!conversation || conversation.deletedAt || conversation.state !== "active") throw conflict("Conversation fork source is not active.");
      if (conversation.productMode !== "agent" || conversation.productMode !== request.productMode) throw conflict("Conversation fork source is not an Agent Conversation.");
      if (conversation.selectedProviderId !== request.providerId) throw conflict("Conversation fork Provider identity does not match.");
      if (!conversation.currentGraphScopeId) throw conflict("Conversation fork source has no active graph scope.");
      if (conversation.timelineRevision !== request.expectedTimelineRevision) throw conflict("Conversation fork Timeline revision is stale.");
      const anchor = database.timeline.readMessage(paths.projectId, request.conversationId, request.sourceMessageId);
      const raw = anchor ? safeRecord(anchor.rawJson) : {};
      if (!anchor
        || anchor.agentSurfaceId !== "main-agent"
        || anchor.type !== "assistant.message"
        || anchor.status !== "completed"
        || typeof anchor.turnId !== "string"
        || typeof raw.attemptId !== "string"
        || raw.graphScopeId !== conversation.currentGraphScopeId
        || raw.completedTurnSequence !== request.expectedCompletedTurnSequence) {
        throw conflict("Conversation fork anchor is not the exact completed top-level Main Turn.");
      }
      if (!Number.isSafeInteger(request.expectedCompletedTurnSequence)
        || request.expectedCompletedTurnSequence < 1
        || request.expectedCompletedTurnSequence > conversation.completedTurnSequence) {
        throw conflict("Conversation fork completed Turn sequence is invalid.");
      }
      const attempt = database.providerAttempts.readProviderAttempt(paths.projectId, raw.attemptId);
      const binding = database.providerAttempts.readConversationProviderBinding(paths.projectId, request.conversationId, request.providerId);
      const sourceRows = database.timeline.listConversationMessages(paths.projectId, request.conversationId);
      const attempts = database.providerAttempts.listProviderAttempts(paths.projectId, request.conversationId);
      const latestAttempt = attempts.filter((candidate) => candidate.graphScopeId === conversation.currentGraphScopeId && candidate.roleId === "main-agent").at(-1);
      const recovery = isExactSessionRecoveryRequest(sourceRows, latestAttempt, request.sourceMessageId, request.providerId, request.expectedCompletedTurnSequence);
      if (!attempt
        || attempt.productMode !== "agent"
        || attempt.roleId !== "main-agent"
        || attempt.operationProfile !== "agent"
        || attempt.status !== "completed"
        || attempt.providerId !== request.providerId
        || attempt.graphScopeId !== conversation.currentGraphScopeId
        || !binding?.nativeSessionId
        || (binding.bindingStatus !== "ready" && !(binding.bindingStatus === "stale" && recovery))
        || attempt.nativeSessionId !== binding.nativeSessionId
        || anchor.threadId !== binding.nativeSessionId) {
        throw conflict("Conversation fork source Provider lineage cannot be proved.");
      }
      if (attempts.some((candidate) =>
        candidate.graphScopeId === conversation.currentGraphScopeId && (candidate.status === "queued" || candidate.status === "running"))) {
        throw conflict("Conversation fork is unavailable while a Provider Turn is active.");
      }
      if (hasPendingInteraction(sourceRows)) {
        throw conflict("Conversation fork is unavailable while Provider input or approval is pending.");
      }
      const now = new Date().toISOString();
      operation ??= {
        projectId: paths.projectId,
        clientRequestId: request.clientRequestId,
        requestHash,
        sourceConversationId: request.conversationId,
        targetConversationId: null,
        providerId: request.providerId,
        sourceMessageId: request.sourceMessageId,
        anchorCompletedTurnSequence: request.expectedCompletedTurnSequence,
        expectedTimelineRevision: request.expectedTimelineRevision,
        contextRevision: request.contextRevision,
        sourceGraphScopeId: conversation.currentGraphScopeId,
        status: "pending",
        diagnostic: null,
        createdAt: now,
        updatedAt: now,
      };
      if (!database.conversationForks.read(paths.projectId, request.clientRequestId)) database.conversationForks.create(operation);
      return {
        paths,
        conversation,
        operation,
        anchor,
        sourceRows: sourceRows.filter((row) => row.position <= Math.max(anchor.position, ...sourceRows.filter((candidate) => {
          const evidence = safeRecord(candidate.rawJson);
          return evidence.attemptId === raw.attemptId && (candidate.type === "user.message" || candidate.type === "assistant.transcript-segment");
        }).map((candidate) => candidate.position))),
        sourceSessionId: binding.nativeSessionId,
        anchorTurnId: anchor.turnId,
        preferredModel: binding.preferredModel,
        recovery,
      };
    } finally {
      database.close();
    }
  }

  private async materialize(prepared: PreparedFork, result: ProviderSessionForkResult, replayed: boolean): Promise<ConversationForkReceipt> {
    const targetConversationId = `conversation-${randomUUID()}`;
    const targetGraphScopeId = `graph-${randomUUID()}`;
    const now = new Date().toISOString();
    const database = await openProjectRuntimeWorkbenchDatabase(prepared.paths);
    try {
      const operation = database.transaction(() => {
        const current = database.conversationForks.read(prepared.paths.projectId, prepared.operation.clientRequestId);
        if (!current || current.requestHash !== prepared.operation.requestHash) throw conflict("Conversation fork operation identity changed before persistence.");
        if (current.status === "completed" && current.targetConversationId) return current;
        if (current.status !== "submitting") throw conflict("Conversation fork operation is no longer submitting.");
        database.conversations.createConversation({
          projectId: prepared.paths.projectId,
          conversationId: targetConversationId,
          productMode: "agent",
          agentTurnMode: prepared.conversation.agentTurnMode ?? "default",
          agentModelId: prepared.conversation.agentModelId,
          agentReasoningEffort: prepared.conversation.agentReasoningEffort,
          clientCreateRequestId: null,
          clientCreateRequestHash: null,
          title: `${prepared.conversation.title} · 分支`,
          state: "active",
          surfaceKind: "user",
          boundChangeId: null,
          currentGraphScopeId: targetGraphScopeId,
          selectedProviderId: prepared.conversation.selectedProviderId,
          completedTurnSequence: prepared.operation.anchorCompletedTurnSequence,
          timelinePosition: 0,
          timelineRevision: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        database.conversations.initializeConversationGraphScope(prepared.paths.projectId, targetConversationId, targetGraphScopeId, now);
        for (const row of prepared.sourceRows) database.timeline.appendMessage(copyTimelineRow(row, targetConversationId, targetGraphScopeId));
        database.timeline.appendMessage(forkBoundaryMessage(prepared, targetConversationId, targetGraphScopeId, now));
        database.providerAttempts.writeConversationProviderBinding({
          projectId: prepared.paths.projectId,
          conversationId: targetConversationId,
          providerId: prepared.conversation.selectedProviderId,
          nativeSessionId: result.session.sessionId,
          lastDeliveredCompletedTurn: prepared.operation.anchorCompletedTurnSequence,
          preferredModel: prepared.preferredModel,
          lastUsedAt: now,
          bindingStatus: "ready",
        });
        for (const skill of database.skills.listSkillEnablement(prepared.paths.projectId)) {
          if (skill.scope !== "topic" || skill.changeId !== prepared.conversation.conversationId) continue;
          database.skills.setSkillEnablement({ ...skill, changeId: targetConversationId, updatedAt: now });
        }
        return database.conversationForks.update({
          projectId: prepared.paths.projectId,
          clientRequestId: prepared.operation.clientRequestId,
          expectedStatus: "submitting",
          status: "completed",
          targetConversationId,
          updatedAt: now,
        });
      });
      const retainedKey = `${prepared.paths.projectId}\0${prepared.operation.clientRequestId}`;
      this.accepted.delete(retainedKey);
      publishConversationForkCompleted(prepared.paths.projectId, {
        sourceConversationId: prepared.conversation.conversationId,
        targetConversationId: operation.targetConversationId!,
      });
      return {
        status: replayed || operation.targetConversationId !== targetConversationId ? "replayed" : "forked",
        sourceConversationId: prepared.conversation.conversationId,
        targetConversationId: operation.targetConversationId!,
      };
    } finally {
      database.close();
    }
  }

  private async transition(paths: ProjectRuntimePaths, operation: StoredConversationForkOperation, expectedStatus: StoredConversationForkOperation["status"], status: StoredConversationForkOperation["status"], diagnostic: string | null = null): Promise<void> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.conversationForks.update({
        projectId: paths.projectId,
        clientRequestId: operation.clientRequestId,
        expectedStatus,
        status,
        diagnostic,
        updatedAt: new Date().toISOString(),
      });
      operation.status = status;
    } finally {
      database.close();
    }
  }
}

function normalizeRequest(request: ConversationForkRequest): ConversationForkRequest {
  const normalized = {
    ...request,
    conversationId: request.conversationId.trim(),
    providerId: request.providerId.trim(),
    sourceMessageId: request.sourceMessageId.trim(),
    contextRevision: request.contextRevision.trim(),
    clientRequestId: request.clientRequestId.trim(),
  };
  if (!normalized.conversationId || !normalized.providerId || !normalized.sourceMessageId
    || !normalized.contextRevision || !normalized.clientRequestId || normalized.clientRequestId.length > 200
    || !Number.isSafeInteger(normalized.expectedTimelineRevision) || normalized.expectedTimelineRevision < 0) {
    throw badRequest("Conversation fork request is incomplete or invalid.");
  }
  return normalized;
}

function forkRequestHash(request: ConversationForkRequest): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: request.projectId,
    productMode: request.productMode,
    conversationId: request.conversationId,
    providerId: request.providerId,
    sourceMessageId: request.sourceMessageId,
    expectedCompletedTurnSequence: request.expectedCompletedTurnSequence,
    expectedTimelineRevision: request.expectedTimelineRevision,
    contextRevision: request.contextRevision,
  })).digest("hex");
}

function replayReceipt(operation: StoredConversationForkOperation): ConversationForkReceipt {
  return {
    status: "replayed",
    sourceConversationId: operation.sourceConversationId,
    targetConversationId: operation.targetConversationId!,
  };
}

function copyTimelineRow(row: StoredTopicMessage, targetConversationId: string, targetGraphScopeId: string): StoredTopicMessageWrite {
  const raw = sanitizeForkEvidence(safeRecord(row.rawJson));
  const reading = raw.transcriptReading as Record<string, unknown> | undefined;
  if (typeof raw.sourceMessageId === "string") raw.sourceMessageId = `fork-copy-${shortHash(`${targetConversationId}\0${raw.sourceMessageId}`)}`;
  if (reading && typeof reading.sourceMessageId === "string") reading.sourceMessageId = `fork-copy-${shortHash(`${targetConversationId}\0${reading.sourceMessageId}`)}`;
  return {
    id: `fork-copy-${shortHash(`${targetConversationId}\0${row.id}`)}`,
    projectId: row.projectId,
    conversationId: targetConversationId,
    changeId: "",
    agentSurfaceId: row.agentSurfaceId,
    initialThreadInput: row.initialThreadInput,
    type: row.type,
    timestamp: row.timestamp,
    text: row.text,
    actionRunId: null,
    actionType: null,
    status: row.status,
    runId: null,
    providerId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    artifact: row.artifact,
    error: null,
    rawJson: JSON.stringify({ ...raw, graphScopeId: targetGraphScopeId, forkedHistory: true }),
  };
}

function forkBoundaryMessage(prepared: PreparedFork, targetConversationId: string, targetGraphScopeId: string, timestamp: string): StoredTopicMessageWrite {
  return {
    id: `fork-boundary-${shortHash(targetConversationId)}`,
    projectId: prepared.paths.projectId,
    conversationId: targetConversationId,
    changeId: "",
    agentSurfaceId: "main-agent",
    type: "assistant.message",
    timestamp,
    text: "此会话从源会话的已完成回合创建。源会话保持不变，项目文件没有被恢复或修改。",
    actionRunId: null,
    actionType: null,
    status: "fork-boundary",
    runId: null,
    providerId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    artifact: null,
    error: null,
    rawJson: JSON.stringify({
      graphScopeId: targetGraphScopeId,
      conversationForkBoundary: {
        sourceConversationId: prepared.conversation.conversationId,
        sourceMessageId: prepared.operation.sourceMessageId,
        completedTurnSequence: prepared.operation.anchorCompletedTurnSequence,
      },
    }),
  };
}

const PRIVATE_FORK_KEYS = new Set([
  "attemptId", "runId", "sessionId", "sourceSessionId", "targetSessionId", "nativeSessionId", "providerSessionId",
  "threadId", "parentThreadId", "childThreadId", "providerThreadId", "turnId", "itemId", "requestId", "requestKey",
  "providerUserInput", "providerApproval", "retryTarget", "retryLineage", "runtimeScopeId", "agentTaskId",
]);

function sanitizeForkEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_FORK_KEYS.has(key)) continue;
    result[key] = sanitizeForkEvidenceValue(nested);
  }
  return result;
}

function sanitizeForkEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForkEvidenceValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_FORK_KEYS.has(key)) continue;
    result[key] = sanitizeForkEvidenceValue(nested);
  }
  return result;
}

function safeRecord(rawJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function hasPendingInteraction(rows: StoredTopicMessage[]): boolean {
  return rows.some((row) => {
    const raw = safeRecord(row.rawJson);
    const input = raw.providerUserInput as Record<string, unknown> | undefined;
    const approval = raw.providerApproval as Record<string, unknown> | undefined;
    return [input?.status, approval?.status].some((status) => status === "pending" || status === "submitting");
  });
}

function isExactSessionRecoveryRequest(
  rows: StoredTopicMessage[],
  latestAttempt: import("./persistence/contracts.js").StoredProviderAttempt | undefined,
  sourceMessageId: string,
  providerId: string,
  completedTurnSequence: number,
): boolean {
  if (!latestAttempt || latestAttempt.status !== "failed" || latestAttempt.providerId !== providerId || latestAttempt.roleId !== "main-agent") return false;
  return rows.some((row) => {
    if (row.agentSurfaceId !== "main-agent"
      || (row.type !== "assistant.message" && row.type !== "provider.review")
      || row.status !== "failed") return false;
    const raw = safeRecord(row.rawJson);
    const recovery = raw.sessionRecovery && typeof raw.sessionRecovery === "object" && !Array.isArray(raw.sessionRecovery)
      ? raw.sessionRecovery as Record<string, unknown>
      : null;
    return raw.attemptId === latestAttempt.attemptId
      && recovery?.sourceMessageId === sourceMessageId
      && recovery.providerId === providerId
      && recovery.completedTurnSequence === completedTurnSequence;
  });
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function uncertain(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ProviderSessionForkUncertain";
  return error;
}

const FORK_TRANSPORT_STAGES = new Set<ProviderSessionForkTransportStage>([
  "source-resume",
  "source-read",
  "child-create",
  "child-rollback",
  "child-verify",
]);

function forkTransportDiagnostic(error: unknown): string {
  if (!isForkTransportDiagnostic(error)) return "Conversation fork transport outcome is uncertain.";
  const timeout = Number.isSafeInteger(error.timeoutMs) && (error.timeoutMs ?? 0) > 0
    ? ` after ${error.timeoutMs}ms`
    : "";
  return `Conversation fork transport outcome is uncertain during ${error.stage}${timeout}.`;
}

function isForkTransportDiagnostic(error: unknown): error is ProviderSessionForkTransportDiagnostic {
  if (!(error instanceof Error) || error.name !== "ProviderSessionForkTransportUncertain") return false;
  const candidate = error as Error & Partial<ProviderSessionForkTransportDiagnostic>;
  return typeof candidate.stage === "string" && FORK_TRANSPORT_STAGES.has(candidate.stage as ProviderSessionForkTransportStage)
    && (candidate.timeoutMs === undefined || Number.isSafeInteger(candidate.timeoutMs));
}
