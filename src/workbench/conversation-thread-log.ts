import type { ProjectWorkbenchPathPort } from "../project-runtime/paths.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import { type StoredTopicMessage } from "./persistence/contracts.js";
import type {
  AssistantTurnActivity,
  AssistantTurnBlock,
  AssistantTurnBlockKind,
  TopicFileReference,
  TopicAttachment,
  TopicThreadEntry,
  TopicThreadEventType,
  WorkbenchAssistantEvent,
} from "./types.js";

export async function readConversationThread(
  runtime: ProjectWorkbenchPathPort,
  changeId: string,
): Promise<TopicThreadEntry[]> {
  const store = await openProjectRuntimeWorkbenchDatabase(runtime);
  try {
    const conversation = store.conversations.readConversation(runtime.projectId, changeId)
      ?? store.conversations.findConversationForChange(runtime.projectId, changeId);
    if (!conversation) return [];
    return store.timeline.listConversationMessages(runtime.projectId, conversation.conversationId).map(fromStoredThreadMessage);
  } finally {
    store.close();
  }
}

export async function readRecentConversationThread(
  runtime: ProjectWorkbenchPathPort,
  changeId: string,
  limit = 100,
): Promise<TopicThreadEntry[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const store = await openProjectRuntimeWorkbenchDatabase(runtime);
  try {
    const conversation = store.conversations.readConversation(runtime.projectId, changeId)
      ?? store.conversations.findConversationForChange(runtime.projectId, changeId);
    if (!conversation) return [];
    return store.timeline.listRecentSemanticMessages(
      runtime.projectId,
      conversation.conversationId,
      boundedLimit,
    ).map(fromStoredThreadMessage);
  } finally {
    store.close();
  }
}

export async function collectAllConversationThreadEntries(
  runtime: ProjectWorkbenchPathPort,
): Promise<TopicThreadEntry[]> {
  const store = await openProjectRuntimeWorkbenchDatabase(runtime);
  try {
    return store.timeline.listAllMessages(runtime.projectId).map(fromStoredThreadMessage);
  } finally {
    store.close();
  }
}

export function fromStoredThreadMessage(row: StoredTopicMessage): TopicThreadEntry {
  const raw = parseStoredRawJson(row.rawJson);
  return {
    id: row.id,
    sourceMessageId: typeof raw.sourceMessageId === "string" ? raw.sourceMessageId : undefined,
    transcriptReading: isAssistantTranscriptReading(raw.transcriptReading) ? raw.transcriptReading : undefined,
    clientRequestId: typeof raw.clientRequestId === "string" ? raw.clientRequestId : undefined,
    requestHash: typeof raw.requestHash === "string" ? raw.requestHash : undefined,
    type: row.type as TopicThreadEventType,
    timestamp: row.timestamp,
    conversationId: row.conversationId,
    graphScopeId: typeof raw.graphScopeId === "string" ? raw.graphScopeId : undefined,
    changeId: row.changeId,
    text: row.text ?? undefined,
    actionRunId: row.actionRunId ?? undefined,
    actionType: row.actionType ?? undefined,
    status: row.status ?? undefined,
    runId: row.runId ?? undefined,
    agentSurfaceId: row.agentSurfaceId,
    threadId: row.threadId ?? undefined,
    parentThreadId: typeof raw.parentThreadId === "string" ? raw.parentThreadId : undefined,
    turnId: row.turnId ?? undefined,
    itemId: row.itemId ?? undefined,
    agentRoleId: typeof raw.agentRoleId === "string" ? raw.agentRoleId : undefined,
    agentTaskId: typeof raw.agentTaskId === "string" ? raw.agentTaskId : undefined,
    initialThreadInput: row.initialThreadInput ? true : undefined,
    artifact: row.artifact ?? undefined,
    error: row.error ?? undefined,
    resultSummary: typeof raw.resultSummary === "string" ? raw.resultSummary : undefined,
    activity: Array.isArray(raw.activity) ? raw.activity.filter(isAssistantTurnActivity) : undefined,
    blocks: Array.isArray(raw.blocks) ? raw.blocks.filter(isAssistantTurnBlock) : undefined,
    intake: raw.intake,
    clarification: raw.clarification,
    providerId: row.providerId ?? undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    attemptId: typeof raw.attemptId === "string" ? raw.attemptId : undefined,
    providerUserInput: isWorkbenchProviderUserInputRequest(raw.providerUserInput) ? raw.providerUserInput : undefined,
    providerApproval: isWorkbenchProviderApprovalRequest(raw.providerApproval) ? raw.providerApproval : undefined,
    contextRefs: Array.isArray(raw.contextRefs) ? raw.contextRefs.filter(isTopicFileReference) : undefined,
    attachments: Array.isArray(raw.attachments) ? raw.attachments.filter(isTopicAttachment) : undefined,
    planHandoff: isValidatedPlanHandoffIntent(raw.planHandoff) ? raw.planHandoff : undefined,
    agentTurnMode: raw.agentTurnMode === "default" || raw.agentTurnMode === "plan" ? raw.agentTurnMode : undefined,
    agentModelId: typeof raw.agentModelId === "string" || raw.agentModelId === null ? raw.agentModelId : undefined,
    agentReasoningEffort: typeof raw.agentReasoningEffort === "string" || raw.agentReasoningEffort === null ? raw.agentReasoningEffort : undefined,
    retryTarget: isConversationRetryTargetEvidence(raw.retryTarget) ? raw.retryTarget : undefined,
    retryLineage: isConversationRetryLineageEvidence(raw.retryLineage) ? raw.retryLineage : undefined,
    forkTarget: conversationForkTarget(row, raw),
    forkBoundary: isConversationForkBoundary(raw.conversationForkBoundary) ? raw.conversationForkBoundary : undefined,
    providerReview: isConversationReviewEvidence(raw.providerReview) ? raw.providerReview : undefined,
    document: isCanonicalPlanDocument(raw.document) ? raw.document : undefined,
    position: row.position,
    completedTurnSequence: typeof raw.completedTurnSequence === "number" ? raw.completedTurnSequence : undefined,
  };
}

function isAssistantTranscriptReading(value: unknown): value is import("./types.js").AssistantTranscriptReading {
  if (!isRecord(value)) return false;
  return typeof value.sourceMessageId === "string" && Number.isSafeInteger(value.segmentIndex) && Number(value.segmentIndex) >= 0
    && typeof value.final === "boolean" && typeof value.text === "string"
    && Array.isArray(value.blocks) && value.blocks.every(isAssistantTurnBlock);
}

function isConversationReviewEvidence(value: unknown): value is import("./types.js").ConversationReviewEvidence {
  if (!value || typeof value !== "object") return false;
  const review = value as { target?: { type?: unknown }; git?: { headSha?: unknown; worktreeStatusDigest?: unknown }; source?: unknown };
  return ["uncommitted-changes", "base-branch", "commit", "custom"].includes(String(review.target?.type))
    && typeof review.git?.headSha === "string" && typeof review.git.worktreeStatusDigest === "string"
    && (review.source === "direct" || review.source === "queue");
}

function conversationForkTarget(row: StoredTopicMessage, raw: Record<string, unknown>): import("./types.js").ConversationForkTargetEvidence | undefined {
  if ((row.type !== "assistant.message" && row.type !== "provider.review") || row.agentSurfaceId !== "main-agent") return undefined;
  if (row.type === "assistant.message" && row.status === "completed" && typeof raw.completedTurnSequence === "number" && typeof row.providerId === "string") {
    return {
      sourceMessageId: row.id,
      providerId: row.providerId,
      completedTurnSequence: raw.completedTurnSequence,
      timelineRevision: row.revision,
      contextRevision: "",
    };
  }
  const recovery = isRecord(raw.sessionRecovery) ? raw.sessionRecovery : null;
  if (row.status !== "failed" || !recovery
    || typeof recovery.sourceMessageId !== "string"
    || typeof recovery.providerId !== "string"
    || typeof recovery.completedTurnSequence !== "number") return undefined;
  return {
    sourceMessageId: recovery.sourceMessageId,
    providerId: recovery.providerId,
    completedTurnSequence: recovery.completedTurnSequence,
    timelineRevision: row.revision,
    contextRevision: "",
    recovery: true,
  };
}

function isConversationForkBoundary(value: unknown): value is import("./types.js").ConversationForkBoundaryEvidence {
  return isRecord(value)
    && typeof value.sourceConversationId === "string"
    && typeof value.sourceMessageId === "string"
    && typeof value.completedTurnSequence === "number";
}

function isConversationRetryTargetEvidence(value: unknown): value is import("./types.js").ConversationRetryTargetEvidence {
  return isRecord(value)
    && typeof value.failedAttemptId === "string"
    && typeof value.sourceMessageId === "string"
    && typeof value.rootSourceMessageId === "string"
    && typeof value.providerId === "string"
    && (value.agentTurnMode === "default" || value.agentTurnMode === "plan")
    && (typeof value.modelId === "string" || value.modelId === null)
    && (typeof value.reasoningEffort === "string" || value.reasoningEffort === null);
}

function isConversationRetryLineageEvidence(value: unknown): value is import("./types.js").ConversationRetryLineageEvidence {
  return isRecord(value)
    && typeof value.clientRequestId === "string"
    && typeof value.requestHash === "string"
    && typeof value.sourceMessageId === "string"
    && typeof value.rootSourceMessageId === "string"
    && typeof value.failedAttemptId === "string";
}

function parseStoredRawJson(rawJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isValidatedPlanHandoffIntent(value: unknown): value is import("./types.js").ValidatedPlanHandoffIntent {
  return isRecord(value)
    && value.sourceAgentRoleId === "planning-agent"
    && (value.kind === "execute-plan" || value.kind === "revise-plan" || value.kind === "skip-plan")
    && typeof value.sourceRunId === "string"
    && typeof value.sourceDocumentId === "string"
    && typeof value.sourceCanonicalItemId === "string"
    && typeof value.sourceProposalHash === "string"
    && typeof value.planText === "string"
    && (value.executionMode === undefined || value.executionMode === "stepwise" || value.executionMode === "scoped-auto");
}

function isCanonicalPlanDocument(value: unknown): value is import("./types.js").CanonicalPlanDocument {
  return isRecord(value)
    && value.documentKind === "plan"
    && typeof value.documentId === "string"
    && typeof value.title === "string"
    && typeof value.sourceMessageId === "string"
    && typeof value.sourceCanonicalItemId === "string"
    && typeof value.proposalId === "string"
    && typeof value.proposalHash === "string"
    && typeof value.proposalArtifact === "string"
    && typeof value.contentHash === "string"
    && typeof value.agentSurfaceId === "string";
}

function isAssistantTurnActivity(value: unknown): value is AssistantTurnActivity {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.timestamp !== "string") return false;
  if (value.kind === "status") return typeof value.label === "string";
  if (value.kind === "assistant-event") return isWorkbenchAssistantEvent(value.event);
  if (value.kind === "tool") return isRecord(value.tool) && typeof value.tool.runId === "string";
  if (value.kind === "usage") return isRecord(value.usage);
  if (value.kind === "error") return typeof value.message === "string";
  return false;
}

function isAssistantTurnBlock(value: unknown): value is AssistantTurnBlock {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.sequence !== "number" || typeof value.timestamp !== "string") return false;
  if (!isAssistantTurnBlockKind(value.kind) || typeof value.source !== "string") return false;
  if (value.children !== undefined && (!Array.isArray(value.children) || !value.children.every(isAssistantTurnBlock))) return false;
  return true;
}

function isAssistantTurnBlockKind(value: unknown): value is AssistantTurnBlockKind {
  return typeof value === "string" && [
    "prose", "status", "command-group", "command", "tool-result", "file-change",
    "reasoning-summary", "workflow-evidence", "usage", "error",
  ].includes(value);
}

function isTopicFileReference(value: unknown): value is TopicFileReference {
  return isRecord(value)
    && typeof value.relativePath === "string"
    && typeof value.name === "string"
    && (value.kind === "file" || value.kind === "directory");
}

function isTopicAttachment(value: unknown): value is TopicAttachment {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.fileName === "string"
    && typeof value.mediaType === "string"
    && (value.kind === "image" || value.kind === "text" || value.kind === "unsupported")
    && typeof value.size === "number"
    && typeof value.hash === "string"
    && value.source === "composer"
    && typeof value.createdAt === "string"
    && (value.runtimeMode === "provider-image-input"
      || value.runtimeMode === "provider-file-reference"
      || value.runtimeMode === "bounded-text-preview"
      || value.runtimeMode === "metadata-only");
}

function isWorkbenchAssistantEvent(value: unknown): value is WorkbenchAssistantEvent {
  return isRecord(value) && typeof value.runId === "string" && typeof value.kind === "string";
}

function isWorkbenchProviderUserInputRequest(
  value: unknown,
): value is import("./types.js").WorkbenchProviderUserInputRequest {
  return isRecord(value)
    && typeof value.providerId === "string"
    && typeof value.attemptId === "string"
    && typeof value.requestKey === "string"
    && typeof value.requestId === "string"
    && typeof value.runId === "string"
    && typeof value.runtimeScopeId === "string"
    && Array.isArray(value.questions)
    && (value.status === "pending"
      || value.status === "submitting"
      || value.status === "submitted"
      || value.status === "interrupted"
      || value.status === "superseded");
}

function isWorkbenchProviderApprovalRequest(value: unknown): value is import("./types.js").WorkbenchProviderApprovalRequest {
  return isRecord(value)
    && typeof value.providerId === "string"
    && typeof value.requestKey === "string"
    && typeof value.requestId === "string"
    && (value.kind === "command-execution" || value.kind === "file-change" || value.kind === "permissions")
    && typeof value.threadId === "string"
    && typeof value.turnId === "string"
    && typeof value.itemId === "string"
    && typeof value.runId === "string"
    && typeof value.runtimeScopeId === "string"
    && typeof value.attemptId === "string"
    && typeof value.agentRoleId === "string"
    && isRecord(value.summary)
    && Array.isArray(value.availableDecisions)
    && ["pending", "submitting", "submitted", "interrupted", "superseded"].includes(String(value.status));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
