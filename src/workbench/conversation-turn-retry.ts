import { createHash } from "node:crypto";
import type { ProviderId } from "../provider-runtime/index.js";
import type { ManagedProject } from "../types/index.js";
import { resolveTopicFileReferences } from "./file-references.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import { fromStoredThreadMessage } from "./conversation-thread-log.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type { StoredConversation, StoredProviderAttempt, StoredTopicMessage } from "./persistence/contracts.js";
import type {
  ConversationTurnAdmission,
  ConversationTurnRoutingPort,
  TurnSkillContextResolution,
} from "./conversation-turn-contract.js";
import type { TopicAttachment } from "./attachments.js";
import type {
  ConversationRetryLineageEvidence,
  ConversationRetryTargetEvidence,
  TopicMessageResult,
  WorkbenchLiveSink,
} from "./types.js";

const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

export interface ConversationTurnRetryRequest {
  conversationId: string;
  productMode: "agent";
  providerId: ProviderId;
  expectedAttemptId: string;
  sourceMessageId: string;
  clientRequestId: string;
}

export interface PreparedConversationTurnRetry {
  project: ManagedProject;
  conversation: StoredConversation;
  sourceMessage: StoredTopicMessage;
  attachments: readonly TopicAttachment[];
  target: ConversationRetryTargetEvidence;
  lineage: ConversationRetryLineageEvidence;
  admission: ConversationTurnAdmission | null;
  skillResolution: TurnSkillContextResolution | null;
  expectedSkillInputs: readonly StoredProviderAttempt["effectiveSkillInputs"][number][];
  executionIdentity: Readonly<{ runId: string; attemptId: string }>;
  markerId: string;
  replayed: boolean;
}

export interface ConversationTurnRetryResult {
  status: "completed" | "replayed";
  attemptId: string;
  result: TopicMessageResult | null;
}

export class ConversationTurnRetryOwner {
  private readonly pendingTargets = new Map<string, {
    clientRequestId: string;
    promise: Promise<ConversationTurnRetryResult>;
  }>();

  constructor(private readonly turnRouter: ConversationTurnRoutingPort) {}

  async prepare(project: ManagedProject, rawRequest: ConversationTurnRetryRequest): Promise<PreparedConversationTurnRetry> {
    const request = normalizeRequest(rawRequest);
    if (!this.turnRouter.resolveTurnSkills) throw new Error("Conversation Retry Skill resolution is not composed.");
    const runtime = await this.turnRouter.resolveRuntimeState(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const executionIdentity = retryExecutionIdentity(project.id, request);
    const markerId = `retry-request:${executionIdentity.attemptId}`;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    let conversation: StoredConversation;
    let sourceMessage: StoredTopicMessage;
    let failedAttempt: StoredProviderAttempt;
    let rootSourceMessageId: string;
    let existingMarker: StoredTopicMessage | null;
    try {
      const storedConversation = database.conversations.readConversation(paths.projectId, request.conversationId);
      if (!storedConversation || storedConversation.deletedAt || storedConversation.state !== "active") {
        throw notFound("Conversation not found.");
      }
      if (storedConversation.productMode !== "agent") throw conflict("Conversation Retry is available only in Agent mode.");
      if (storedConversation.selectedProviderId !== request.providerId) throw conflict("Conversation Retry Provider identity is stale.");
      conversation = storedConversation;
      existingMarker = database.timeline.readMessage(paths.projectId, conversation.conversationId, markerId);
      if (existingMarker) {
        const existing = readRetryLineage(existingMarker);
        if (!existing
          || existing.clientRequestId !== request.clientRequestId
          || existing.failedAttemptId !== request.expectedAttemptId
          || existing.sourceMessageId !== request.sourceMessageId) {
          throw conflict("clientRequestId was already used for a different Retry request.");
        }
        const existingAttempt = database.providerAttempts.readProviderAttempt(paths.projectId, executionIdentity.attemptId);
        if (existingAttempt) {
          if (existingAttempt.conversationId !== conversation.conversationId
            || existingAttempt.productMode !== "agent"
            || existingAttempt.providerId !== request.providerId
            || existingAttempt.roleId !== "main-agent") {
            throw conflict("Retry Attempt identity is inconsistent with its durable request.");
          }
          const source = database.timeline.readMessage(paths.projectId, conversation.conversationId, existing.rootSourceMessageId);
          if (!source || source.type !== "user.message") throw conflict("Retry source evidence is unavailable.");
          const sourceEntry = fromStoredThreadMessage(source);
          return freezePrepared({
            project,
            conversation,
            sourceMessage: source,
            attachments: [],
            target: {
              failedAttemptId: request.expectedAttemptId,
              sourceMessageId: existing.rootSourceMessageId,
              rootSourceMessageId: existing.rootSourceMessageId,
              providerId: request.providerId,
              agentTurnMode: existingAttempt.agentTurnMode ?? "default",
              modelId: sourceEntry.agentModelId ?? null,
              reasoningEffort: sourceEntry.agentReasoningEffort ?? null,
            },
            lineage: existing,
            admission: null,
            skillResolution: null,
            expectedSkillInputs: [],
            executionIdentity,
            markerId,
            replayed: true,
          });
        }
      }

      const attempts = database.providerAttempts.listProviderAttempts(paths.projectId, conversation.conversationId)
        .filter((attempt) => attempt.productMode === "agent"
          && attempt.operationProfile === "agent"
          && attempt.roleId === "main-agent"
          && attempt.graphScopeId === conversation.currentGraphScopeId)
        .sort(compareAttempts);
      const latest = attempts.at(-1);
      if (!latest || latest.attemptId !== request.expectedAttemptId || latest.status !== "failed") {
        throw conflict("Only the latest failed Agent Turn can be retried.");
      }
      failedAttempt = latest;
      if (failedAttempt.providerId !== request.providerId) {
        throw conflict("Conversation Retry Provider does not match the failed Agent Turn.");
      }
      const messages = database.timeline.listConversationMessages(paths.projectId, conversation.conversationId);
      const failedMessage = [...messages].reverse().find((message) => {
        const entry = fromStoredThreadMessage(message);
        return message.agentSurfaceId === "main-agent"
          && entry.type === "assistant.message"
          && entry.attemptId === failedAttempt.attemptId
          && entry.status === "failed";
      });
      if (!failedMessage) throw conflict("Failed Agent Turn canonical evidence is incomplete.");
      const failedEntry = fromStoredThreadMessage(failedMessage);
      rootSourceMessageId = failedEntry.retryLineage?.rootSourceMessageId
        ?? failedEntry.retryTarget?.rootSourceMessageId
        ?? "";
      const source = rootSourceMessageId
        ? database.timeline.readMessage(paths.projectId, conversation.conversationId, rootSourceMessageId)
        : [...messages].reverse().find((message) => {
          const entry = fromStoredThreadMessage(message);
          return message.position < failedMessage.position
            && entry.type === "user.message"
            && entry.graphScopeId === conversation.currentGraphScopeId
            && entry.completedTurnSequence === failedAttempt.deliveredThroughCompletedTurn + 1
            && hasRetryableInput(entry);
        }) ?? null;
      if (!source || source.type !== "user.message" || !hasRetryableInput(fromStoredThreadMessage(source))) {
        throw conflict("Failed Agent Turn source message is unavailable.");
      }
      sourceMessage = source;
      rootSourceMessageId = source.id;
      if (request.sourceMessageId !== rootSourceMessageId) throw conflict("Retry source message identity is stale.");
    } finally {
      database.close();
    }

    const sourceEntry = fromStoredThreadMessage(sourceMessage);
    await resolveTopicFileReferences(project, sourceEntry.text ?? "", sourceEntry.contextRefs ?? []);
    const attachments = [...await this.turnRouter.resolveAttachments(
      project,
      sourceEntry.attachments?.map((attachment) => attachment.id) ?? [],
    )];
    assertAttachmentEvidence(sourceEntry.attachments ?? [], attachments);
    const agentTurnMode = failedAttempt.agentTurnMode ?? sourceEntry.agentTurnMode ?? "default";
    const modelId = sourceEntry.agentModelId ?? null;
    const reasoningEffort = sourceEntry.agentReasoningEffort ?? null;
    const target: ConversationRetryTargetEvidence = {
      failedAttemptId: failedAttempt.attemptId,
      sourceMessageId: rootSourceMessageId,
      rootSourceMessageId,
      providerId: failedAttempt.providerId,
      agentTurnMode,
      modelId,
      reasoningEffort,
    };
    const requestHash = retryRequestHash(project.id, conversation, target, sourceEntry, failedAttempt);
    const lineage: ConversationRetryLineageEvidence = {
      clientRequestId: request.clientRequestId,
      requestHash,
      sourceMessageId: rootSourceMessageId,
      rootSourceMessageId,
      failedAttemptId: failedAttempt.attemptId,
    };
    if (existingMarker) {
      const existing = readRetryLineage(existingMarker);
      if (!existing || existing.requestHash !== requestHash) {
        throw conflict("Retry source evidence changed after the durable request was recorded.");
      }
    }
    const admission = await this.turnRouter.admit({
      project,
      productMode: "agent",
      conversationId: conversation.conversationId,
      providerId: failedAttempt.providerId,
      agentTurnMode,
      modelId,
      reasoningEffort,
      attachments,
      agentAccessMode: failedAttempt.accessPolicy?.requestedAccess ?? "default",
    });
    if (failedAttempt.accessPolicy && JSON.stringify(admission.accessPolicy) !== JSON.stringify(failedAttempt.accessPolicy)) {
      throw conflict("The failed Turn access policy cannot be reproduced safely. Start a new Turn.");
    }
    const skillResolution = await this.turnRouter.resolveTurnSkills(project, conversation, []);
    assertSkillEvidence(failedAttempt.effectiveSkillInputs, skillResolution);
    return freezePrepared({
      project,
      conversation,
      sourceMessage,
      attachments,
      target,
      lineage,
      admission,
      skillResolution,
      expectedSkillInputs: [...failedAttempt.effectiveSkillInputs],
      executionIdentity,
      markerId,
      replayed: false,
    });
  }

  execute(prepared: PreparedConversationTurnRetry, live?: WorkbenchLiveSink): Promise<ConversationTurnRetryResult> {
    if (prepared.replayed) {
      return Promise.resolve({ status: "replayed", attemptId: prepared.executionIdentity.attemptId, result: null });
    }
    const targetKey = `${prepared.project.id}\0${prepared.conversation.conversationId}\0${prepared.target.failedAttemptId}`;
    const pending = this.pendingTargets.get(targetKey);
    if (pending) {
      if (pending.clientRequestId !== prepared.lineage.clientRequestId) {
        throw conflict("The failed Agent Turn already has a different Retry request in progress.");
      }
      return pending.promise;
    }
    const execution = this.executePrepared(prepared, live).finally(() => {
      if (this.pendingTargets.get(targetKey)?.promise === execution) this.pendingTargets.delete(targetKey);
    });
    this.pendingTargets.set(targetKey, { clientRequestId: prepared.lineage.clientRequestId, promise: execution });
    return execution;
  }

  private async executePrepared(
    prepared: PreparedConversationTurnRetry,
    live?: WorkbenchLiveSink,
  ): Promise<ConversationTurnRetryResult> {
    if (!prepared.admission) throw new Error("Prepared Retry admission is unavailable.");
    const runtime = prepared.admission.runtimeState;
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const current = database.conversations.readConversation(paths.projectId, prepared.conversation.conversationId);
      const latest = current ? database.providerAttempts.listProviderAttempts(paths.projectId, current.conversationId)
        .filter((attempt) => attempt.productMode === "agent"
          && attempt.operationProfile === "agent"
          && attempt.roleId === "main-agent"
          && attempt.graphScopeId === current.currentGraphScopeId)
        .sort(compareAttempts)
        .at(-1) : null;
      if (!current
        || current.deletedAt
        || current.productMode !== "agent"
        || current.currentGraphScopeId !== prepared.conversation.currentGraphScopeId
        || current.selectedProviderId !== prepared.target.providerId
        || latest?.attemptId !== prepared.target.failedAttemptId
        || latest.status !== "failed") {
        throw conflict("Retry target was superseded before execution.");
      }
      const marker = database.unitOfWork.commitConversationRetryClaim(
        toCanonicalTimelineMessage(paths.projectId, current.conversationId, {
          id: prepared.markerId,
          type: "assistant.message",
          timestamp: new Date().toISOString(),
          conversationId: current.conversationId,
          graphScopeId: current.currentGraphScopeId ?? undefined,
          changeId: "",
          status: "retry-requested",
          providerId: prepared.target.providerId,
          agentSurfaceId: "main-agent",
          retryLineage: prepared.lineage,
        }),
      ).message;
      if (readRetryLineage(marker)?.requestHash !== prepared.lineage.requestHash) {
        throw conflict("Retry durable claim does not match the prepared request.");
      }
    } finally {
      database.close();
    }
    const result = await this.turnRouter.route({
      project: prepared.project,
      conversation: prepared.conversation,
      committedMessage: prepared.sourceMessage,
      attachments: prepared.attachments,
      providerId: prepared.target.providerId,
      live,
      admission: prepared.admission,
      actualAgentTurnMode: prepared.target.agentTurnMode,
      expectedSkillInputs: prepared.expectedSkillInputs,
      preparedSkillResolution: prepared.skillResolution,
      executionIdentity: prepared.executionIdentity,
      retryLineage: prepared.lineage,
    }, "agent");
    return { status: "completed", attemptId: prepared.executionIdentity.attemptId, result };
  }
}

function normalizeRequest(request: ConversationTurnRetryRequest): ConversationTurnRetryRequest {
  const conversationId = request.conversationId?.trim();
  const providerId = request.providerId?.trim();
  const expectedAttemptId = request.expectedAttemptId?.trim();
  const sourceMessageId = request.sourceMessageId?.trim();
  const clientRequestId = request.clientRequestId?.trim();
  if (request.productMode !== "agent") throw conflict("Conversation Retry is available only in Agent mode.");
  if (!conversationId || !providerId || !expectedAttemptId || !sourceMessageId || !clientRequestId
    || clientRequestId.length > MAX_CLIENT_REQUEST_ID_LENGTH
    || !/^[A-Za-z0-9._:-]+$/.test(clientRequestId)) {
    throw badRequest("Conversation Retry requires valid Provider, Attempt, source message, and client request identities.");
  }
  return { ...request, conversationId, providerId, expectedAttemptId, sourceMessageId, clientRequestId };
}

function retryExecutionIdentity(projectId: string, request: ConversationTurnRetryRequest): { runId: string; attemptId: string } {
  const identity = createHash("sha256").update(`${projectId}\0${request.conversationId}\0${request.clientRequestId}`).digest("hex").slice(0, 24);
  return { runId: `agent-retry-${identity}`, attemptId: `attempt-retry-${identity}` };
}

function retryRequestHash(
  projectId: string,
  conversation: StoredConversation,
  target: ConversationRetryTargetEvidence,
  source: ReturnType<typeof fromStoredThreadMessage>,
  attempt: StoredProviderAttempt,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    projectId,
    conversationId: conversation.conversationId,
    graphScopeId: conversation.currentGraphScopeId,
    target,
    text: source.text ?? "",
    contextRefs: source.contextRefs ?? [],
    attachments: (source.attachments ?? []).map((item) => ({ id: item.id, hash: item.hash, size: item.size, kind: item.kind, mediaType: item.mediaType })).sort((a, b) => a.id.localeCompare(b.id)),
    skills: stableSkillInputs(attempt.effectiveSkillInputs),
    ...(attempt.accessPolicy ? { accessPolicy: attempt.accessPolicy } : {}),
  })).digest("hex");
}

function assertAttachmentEvidence(source: readonly import("./types.js").TopicAttachment[], resolved: readonly TopicAttachment[]): void {
  const stable = (items: readonly import("./types.js").TopicAttachment[]) => items
    .map((item) => ({ id: item.id, hash: item.hash, size: item.size, kind: item.kind, mediaType: item.mediaType }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(stable(source)) !== JSON.stringify(stable(resolved))) {
    throw conflict("Retry attachment evidence no longer matches the failed Agent Turn.");
  }
}

function assertSkillEvidence(
  expected: readonly StoredProviderAttempt["effectiveSkillInputs"][number][],
  resolution: TurnSkillContextResolution | null,
): void {
  if (!resolution || JSON.stringify(stableSkillInputs(expected)) !== JSON.stringify(stableSkillInputs(resolution.skillInputs))) {
    throw conflict("Retry Skill inputs no longer match the failed Agent Turn.");
  }
}

function stableSkillInputs(items: readonly StoredProviderAttempt["effectiveSkillInputs"][number][]) {
  return items.map((item) => ({ id: item.id, path: item.path, source: item.source, contentHash: item.contentHash, required: item.required }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

function hasRetryableInput(entry: ReturnType<typeof fromStoredThreadMessage>): boolean {
  return Boolean(entry.text?.trim()) || Boolean(entry.contextRefs?.length) || Boolean(entry.attachments?.length);
}

function readRetryLineage(message: StoredTopicMessage): ConversationRetryLineageEvidence | null {
  try {
    const raw = JSON.parse(message.rawJson) as { retryLineage?: unknown };
    const value = raw.retryLineage;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Partial<ConversationRetryLineageEvidence>;
    return typeof candidate.clientRequestId === "string"
      && typeof candidate.requestHash === "string"
      && typeof candidate.sourceMessageId === "string"
      && typeof candidate.rootSourceMessageId === "string"
      && typeof candidate.failedAttemptId === "string"
      ? candidate as ConversationRetryLineageEvidence
      : null;
  } catch {
    return null;
  }
}

function compareAttempts(left: StoredProviderAttempt, right: StoredProviderAttempt): number {
  return left.createdAt.localeCompare(right.createdAt) || left.attemptId.localeCompare(right.attemptId);
}

function freezePrepared(prepared: PreparedConversationTurnRetry): PreparedConversationTurnRetry {
  Object.freeze(prepared.attachments);
  Object.freeze(prepared.expectedSkillInputs);
  return Object.freeze(prepared);
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

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFound";
  return error;
}
