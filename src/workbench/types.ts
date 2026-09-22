import type { AgentTurnMode, ProductMode, ProviderApprovalDecision, ProviderApprovalKind, ProviderApprovalSummary, ProviderId, ProviderReadableEvent, ProviderUserInputQuestion } from "../provider-runtime/index.js";
import type { ConversationInteractionQueue } from "./conversation-interaction-contract.js";
import type { HarnessExecutionMode, RunMetadata } from "../types/index.js";
import type { WorkflowActionType } from "../workflow-actions/registry.js";
import type { CanonicalTimelineEnvelope } from "./canonical-timeline-contract.js";
import type { AgentSurfacesInvalidated } from "./agent-surface-contract.js";

export type TopicThreadEventType =
  | "user.message"
  | "assistant.message"
  | "provider.review"
  | "orchestrator.plan"
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "intake.scan"
  | "intake.iteration"
  | "clarification.request"
  | "clarification.answer"
  | "clarification.skip";

export type WorkbenchMessageMode = "chat";
export type WorkbenchWorkflowActionType = WorkflowActionType;

export interface TopicThreadEntry {
  id: string;
  clientRequestId?: string;
  requestHash?: string;
  type: TopicThreadEventType;
  timestamp: string;
  conversationId?: string;
  graphScopeId?: string;
  changeId: string;
  position?: number;
  completedTurnSequence?: number;
  text?: string;
  actionRunId?: string;
  actionType?: string;
  status?: string;
  runId?: string;
  agentSurfaceId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  itemId?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  initialThreadInput?: boolean;
  artifact?: string;
  error?: string;
  resultSummary?: string;
  activity?: AssistantTurnActivity[];
  blocks?: AssistantTurnBlock[];
  intake?: unknown;
  clarification?: unknown;
  providerId?: ProviderId;
  sessionId?: string;
  attemptId?: string;
  providerUserInput?: WorkbenchProviderUserInputRequest;
  providerApproval?: WorkbenchProviderApprovalRequest;
  contextRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
  planHandoff?: ValidatedPlanHandoffIntent;
  agentTurnMode?: AgentTurnMode;
  agentModelId?: string | null;
  agentReasoningEffort?: string | null;
  retryTarget?: ConversationRetryTargetEvidence;
  retryLineage?: ConversationRetryLineageEvidence;
  forkTarget?: ConversationForkTargetEvidence;
  forkBoundary?: ConversationForkBoundaryEvidence;
  queuedTurnDispatch?: ConversationQueuedTurnDispatchEvidence;
  providerReview?: ConversationReviewEvidence;
  document?: CanonicalPlanDocument;
}

export interface ConversationReviewEvidence {
  target: import("../provider-runtime/index.js").ProviderReviewTarget;
  git: { headSha: string; baseSha: string | null; commitSha: string | null; worktreeStatusDigest: string };
  source: "direct" | "queue";
}

export interface ConversationQueuedTurnDispatchEvidence {
  queueItemId: string;
  dispatchRequestId: string;
  requestHash: string;
}

export interface ConversationRetryTargetEvidence {
  failedAttemptId: string;
  sourceMessageId: string;
  rootSourceMessageId: string;
  providerId: ProviderId;
  agentTurnMode: AgentTurnMode;
  modelId: string | null;
  reasoningEffort: string | null;
}

export interface ConversationRetryLineageEvidence {
  clientRequestId: string;
  requestHash: string;
  sourceMessageId: string;
  rootSourceMessageId: string;
  failedAttemptId: string;
}

export interface ConversationForkTargetEvidence {
  sourceMessageId: string;
  providerId: ProviderId;
  completedTurnSequence: number;
  timelineRevision: number;
  contextRevision: string;
  recovery?: true;
}

export interface ConversationForkBoundaryEvidence {
  sourceConversationId: string;
  sourceMessageId: string;
  completedTurnSequence: number;
  sourceDeleted: boolean;
}

export interface CanonicalPlanDocument {
  documentId: string;
  documentKind: "plan";
  title: string;
  sourceMessageId: string;
  sourceCanonicalItemId: string;
  proposalId: string;
  proposalHash: string;
  proposalArtifact: string;
  contentHash: string;
  agentSurfaceId: string;
}

export interface CanonicalDocumentReference {
  documentId: string;
  documentKind: "plan";
  title: string;
  sourceMessageId: string;
  sourceCanonicalItemId: string;
  proposalHash: string;
}

export interface TopicFileReference {
  relativePath: string;
  name: string;
  kind: "file" | "directory";
  extension?: string;
  size?: number;
  source?: "composer";
}

export type TopicAttachmentKind = "image" | "text" | "unsupported";
export type TopicAttachmentRuntimeMode = "provider-image-input" | "provider-file-reference" | "bounded-text-preview" | "metadata-only";

export interface TopicAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  kind: TopicAttachmentKind;
  size: number;
  hash: string;
  source: "composer";
  createdAt: string;
  runtimeMode: TopicAttachmentRuntimeMode;
}

export type AssistantTurnBlockKind =
  | "prose"
  | "status"
  | "command-group"
  | "command"
  | "tool-result"
  | "file-change"
  | "reasoning-summary"
  | "workflow-evidence"
  | "usage"
  | "error";

export interface AssistantTurnBlock {
  id: string;
  providerId?: ProviderId;
  attemptId?: string;
  runId?: string;
  threadId?: string;
  turnId?: string;
  sequence: number;
  kind: AssistantTurnBlockKind;
  timestamp: string;
  source: "provider" | "aho" | "workflow" | "validation" | "audit" | "decision";
  status?: string;
  title?: string;
  text?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  preview?: string;
  artifactRef?: string;
  isError?: boolean;
  truncated?: boolean;
  itemId?: string;
  targetAgentSurfaceId?: string;
  targetAgentDisplayName?: string;
  children?: AssistantTurnBlock[];
  document?: CanonicalPlanDocument;
  documentRef?: CanonicalDocumentReference;
}

export type AssistantTurnActivity =
  | { kind: "status"; label: string; detail?: string; timestamp: string }
  | { kind: "assistant-event"; event: WorkbenchAssistantEvent; timestamp: string }
  | { kind: "tool"; tool: WorkbenchLiveToolEvent; timestamp: string }
  | { kind: "usage"; usage: Record<string, unknown>; timestamp: string }
  | { kind: "error"; message: string; timestamp: string };

export type WorkbenchProviderUserInputQuestion = ProviderUserInputQuestion;

export interface WorkbenchProviderUserInputRequest {
  providerId: ProviderId;
  requestKey: string;
  requestId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  runId: string;
  runtimeScopeId: string;
  changeId?: string;
  conversationId?: string;
  graphScopeId?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  attemptId: string;
  questions: WorkbenchProviderUserInputQuestion[];
  expiresAt?: string;
  status: "pending" | "submitting" | "submitted" | "interrupted" | "superseded";
  publicAnswers?: Record<string, string | string[]>;
  skippedQuestionIds?: string[];
  disposition?: "answered" | "skipped";
  submittedAt?: string;
}

export interface WorkbenchProviderApprovalRequest {
  providerId: ProviderId;
  requestKey: string;
  requestId: string;
  kind: ProviderApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  runId: string;
  runtimeScopeId: string;
  conversationId: string;
  graphScopeId: string;
  attemptId: string;
  agentRoleId: string;
  agentTurnMode: AgentTurnMode;
  reason?: string;
  summary: ProviderApprovalSummary;
  availableDecisions: ProviderApprovalDecision[];
  status: "pending" | "submitting" | "submitted" | "interrupted" | "superseded";
  decision?: ProviderApprovalDecision;
  submittedAt?: string;
}

export interface TopicMessageResult {
  user: TopicThreadEntry;
  assistant: TopicThreadEntry | null;
  run: RunMetadata | null;
  providerSessionId: string | null;
  mode?: WorkbenchMessageMode;
  assistantMessage?: string;
}

export interface WorkbenchLiveIdentity {
  projectId?: string;
  productMode?: ProductMode;
  conversationId?: string;
  graphScopeId?: string;
  changeId?: string;
  runId?: string;
  providerId?: ProviderId;
  attemptId?: string;
  sessionId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  itemId?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  agentSurfaceId?: string;
  agentDisplayName?: string;
  targetAgentSurfaceId?: string;
  targetAgentDisplayName?: string;
}

export type WorkbenchLiveEvent =
  | { event: "topic.created"; data: {
    projectId: string;
    productMode: ProductMode;
    conversationId: string;
    clientRequestId: string;
    replayed: boolean;
    topic: {
      id?: string;
      conversationId?: string;
      changeId?: string;
      title: string;
      state: "active" | "archive";
      selectedProviderId?: string;
      productMode: ProductMode;
      agentTurnMode?: AgentTurnMode | null;
      agentModelId?: string | null;
      agentReasoningEffort?: string | null;
    };
  } }
  | { event: "topic.updated"; data: { conversation: { id: string; productMode: ProductMode; title: string; state: string; updatedAt?: string; selectedProviderId?: string } } }
  | { event: "timeline.patch"; data: CanonicalTimelineEnvelope }
  | { event: "conversation.interactions.updated"; data: ConversationInteractionQueue }
  | { event: "agent-surfaces.invalidated"; data: AgentSurfacesInvalidated }
  | { event: "conversation.turn-control.invalidated"; data: { conversationId: string; attemptId: string } }
  | { event: "conversation.context.invalidated"; data: { conversationId: string } }
  | { event: "conversation.fork.completed"; data: { sourceConversationId: string; targetConversationId: string } }
  | { event: "conversation.turn-queue.invalidated"; data: { conversationId: string } }
  | { event: "conversation.lifecycle.invalidated"; data: { conversationId: string; productMode: ProductMode; state: "active" | "archived" | "deleted"; lifecycleRevision: string } }
  | { event: "conversation.lifecycle.sync-updated"; data: { conversationId: string; productMode: ProductMode; providerSyncStatus: "not-required" | "unsupported" | "submitting" | "completed" | "failed" | "uncertain" } }
  | { event: "conversation.review.invalidated"; data: { conversationId: string } }
  | { event: "run.started"; data: WorkbenchLiveIdentity & { runId: string; actionType?: string; runtime?: string; taskIds?: string[] } }
  | { event: "run.status"; data: WorkbenchLiveIdentity & { actionRunId?: string; status: string; label?: string } }
  | { event: "assistant.delta"; data: WorkbenchLiveIdentity & { delta: string } }
  | { event: "assistant.event"; data: WorkbenchAssistantEvent }
  | { event: "tool.event"; data: WorkbenchLiveToolEvent }
  | { event: "usage"; data: WorkbenchLiveIdentity & { usage?: Record<string, unknown> } }
  | { event: "snapshot"; data: unknown }
  | { event: "error"; data: WorkbenchLiveIdentity & { message: string; runId?: string; actionRunId?: string } }
  | { event: "done"; data: Pick<WorkbenchLiveIdentity, "projectId" | "productMode" | "conversationId"> & { status: "completed" | "failed" } };

export interface WorkbenchLiveSink {
  emit(event: WorkbenchLiveEvent): void;
  isClosed?(): boolean;
}

export interface WorkbenchLiveToolEvent {
  runId: string;
  productMode?: ProductMode;
  providerId?: ProviderId;
  attemptId?: string;
  sessionId?: string;
  projectId?: string;
  conversationId?: string;
  changeId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  itemId?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  agentSurfaceId?: string;
  agentDisplayName?: string;
  targetAgentSurfaceId?: string;
  targetAgentDisplayName?: string;
  phase: "started" | "updated" | "completed" | "stderr" | "status";
  name?: string;
  command?: string;
  outputTail?: string;
  isError?: boolean;
  exitCode?: number;
  status?: string;
}

export interface WorkbenchAssistantEvent extends Omit<ProviderReadableEvent, "itemId"> {
  itemId?: string;
  runId: string;
  productMode?: ProductMode;
  providerId?: ProviderId;
  attemptId?: string;
  sessionId?: string;
  projectId?: string;
  conversationId?: string;
  changeId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  timestamp?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  agentSurfaceId?: string;
  agentDisplayName?: string;
  targetAgentSurfaceId?: string;
  targetAgentDisplayName?: string;
}

export interface TopicMessageInput {
  agentAccessMode?: import("../provider-runtime/agent-access-policy.js").AgentAccessMode;
  expectedAccessRevision?: number;
  clientRequestId?: string;
  mode?: WorkbenchMessageMode;
  message?: string;
  text?: string;
  contextRefs?: TopicFileReference[];
  attachmentIds?: string[];
  planHandoffIntent?: PlanHandoffIntent;
  providerId?: ProviderId;
  providerSwitchIntent?: "resume-workflow" | "conversation-only";
  agentSurfaceId?: string;
  productMode?: ProductMode;
  agentTurnMode?: AgentTurnMode;
  modelId?: string | null;
  reasoningEffort?: string | null;
  skillOverrides?: NewConversationSkillOverride[];
  queuedTurnDispatch?: ConversationQueuedTurnDispatchEvidence;
}

export interface NewConversationSkillOverride {
  skillId: string;
  enabled: boolean;
}

export type PlanHandoffAgentRoleId = "planning-agent";
export type PlanHandoffIntentKind = "execute-plan" | "revise-plan" | "skip-plan";

export interface PlanHandoffIntent {
  sourceRunId: string;
  sourceAgentRoleId: PlanHandoffAgentRoleId;
  sourceArtifact?: string;
  sourceDocumentId?: string;
  sourceCanonicalItemId?: string;
  sourceProposalHash?: string;
  kind: PlanHandoffIntentKind;
  executionMode?: HarnessExecutionMode;
  feedback?: string;
}

export interface ValidatedPlanHandoffIntent extends PlanHandoffIntent {
  planText: string;
  sourceArtifact: string;
  sourceDocumentId: string;
  sourceCanonicalItemId: string;
  sourceProposalHash: string;
}

export interface WorkbenchWorkflowActionRequest {
  actionType: WorkbenchWorkflowActionType;
  clientRequestId?: string;
  changeId?: string;
  graphScopeId?: string;
  prompt?: string;
  feedback?: string;
  proposalId?: string;
  workflowGraphPlanId?: string;
  finalizationRequestId?: string;
  schedulerContractId?: string;
  schedulerDispatchDryRunId?: string;
  schedulerWorkerPlanId?: string;
  schedulerClaimReconcilePlanId?: string;
  schedulerLaunchPreflightId?: string;
  schedulerRunId?: string;
  schedulerReconcileSnapshotId?: string;
  schedulerClaimReservationId?: string;
  schedulerWorkerStartId?: string;
  schedulerWorkerResultId?: string;
  schedulerWorkerValidationId?: string;
  schedulerWorkerAuditId?: string;
  schedulerWorkerReworkPlanId?: string;
  schedulerWorkerReworkStartId?: string;
  schedulerWorkerReworkResultId?: string;
  schedulerWorkerReworkValidationId?: string;
  schedulerWorkerReworkAuditId?: string;
  schedulerIntegrationCandidateId?: string;
  schedulerIntegrationCheckHandoffId?: string;
  schedulerIntegrationOutcomeId?: string;
  schedulerRunCompletionId?: string;
  schedulerRunBlockedCloseoutId?: string;
  reservationIntentId?: string;
  claimIntentId?: string;
  workflowRunId?: string;
  queueRunId?: string;
  worktreeId?: string;
  taskIds?: string[];
  worktreeIds?: string[];
  taskRunId?: string;
  workerLeaseId?: string;
  runId?: string;
  validationRunId?: string;
  reworkValidationRunId?: string;
  auditRunId?: string;
  reworkAuditRunId?: string;
  specTestEvidenceFingerprint?: string;
  specTestAcIds?: string[];
  specTestMissing?: boolean;
  applyCheckId?: string;
  landingPackageId?: string;
  remoteLandingResultId?: string;
}

export interface WorkbenchWorkflowActionResult {
  actionRunId: string;
  actionType: WorkbenchWorkflowActionType;
  status: "completed" | "failed";
  result?: unknown;
  runId?: string;
  error?: string;
}
