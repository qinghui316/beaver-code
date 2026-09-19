import type { ProviderSkillInput } from "../../project-harness/contracts.js";
import type { AgentTurnMode, ProductMode, ProviderCapabilitySnapshot, ProviderId, ProviderModelRef, StoredExecutionContractIdentity } from "../../provider-runtime/index.js";

export interface StoredTopicMessage {
  id: string;
  projectId: string;
  conversationId: string;
  changeId: string;
  position: number;
  revision: number;
  agentSurfaceId: string;
  initialThreadInput: boolean;
  type: string;
  timestamp: string;
  text: string | null;
  actionRunId: string | null;
  actionType: string | null;
  status: string | null;
  runId: string | null;
  providerId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  artifact: string | null;
  error: string | null;
  rawJson: string;
}

export type StoredTopicMessageWrite = Omit<StoredTopicMessage, "position" | "revision" | "initialThreadInput"> & {
  initialThreadInput?: boolean;
};

export interface StoredConversation {
  agentAccessMode?: import("../../provider-runtime/agent-access-policy.js").AgentAccessMode | null;
  agentAccessRevision?: number;
  projectId: string;
  conversationId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  clientCreateRequestId: string | null;
  clientCreateRequestHash: string | null;
  title: string;
  state: "active" | "archive";
  archiveOrigin: "agent-user" | "harness-workflow" | null;
  archivedAt: string | null;
  lifecycleRevision: number;
  surfaceKind?: "user" | "runtime";
  boundChangeId: string | null;
  currentGraphScopeId: string | null;
  selectedProviderId: ProviderId;
  completedTurnSequence: number;
  timelinePosition: number;
  timelineRevision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type StoredConversationLifecycleAction = "archive" | "restore" | "delete";
export type StoredConversationLifecycleOperationStatus = "pending" | "submitting" | "completed" | "failed" | "interrupted";
export type StoredConversationProviderSyncStatus = "not-required" | "unsupported" | "submitting" | "completed" | "failed" | "uncertain";

export interface StoredConversationLifecycleOperation {
  projectId: string;
  conversationId: string;
  productMode: ProductMode;
  clientRequestId: string;
  requestHash: string;
  action: StoredConversationLifecycleAction;
  expectedLifecycleRevision: number;
  status: StoredConversationLifecycleOperationStatus;
  providerId: ProviderId | null;
  providerBindingHash: string | null;
  providerSyncStatus: StoredConversationProviderSyncStatus;
  diagnostic: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredConversationGraphScope {
  projectId: string;
  conversationId: string;
  graphScopeId: string;
  status: "active" | "terminal";
  updatedAt: string;
}

export interface StoredProviderThreadLink {
  projectId: string;
  conversationId: string;
  attemptId: string;
  providerId: ProviderId;
  providerThreadId: string;
  roleId: string;
  parentThreadId: string | null;
  parentAgentSurfaceId: string | null;
  changeId: string | null;
  graphScopeId: string | null;
  capabilityProfile: string | null;
  displayName?: string | null;
  runId?: string | null;
  updatedAt: string;
}

export interface StoredConversationProviderBinding {
  projectId: string;
  conversationId: string;
  providerId: ProviderId;
  nativeSessionId: string | null;
  lastDeliveredCompletedTurn: number;
  preferredModel: ProviderModelRef | null;
  lastUsedAt: string | null;
  bindingStatus: "ready" | "unavailable" | "stale";
}

export interface StoredProviderAttempt {
  accessPolicy?: import("../../provider-runtime/agent-access-policy.js").AgentAccessPolicy | null;
  projectId: string;
  conversationId: string | null;
  attemptId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  graphScopeId: string | null;
  changeId: string | null;
  agentTaskId: string | null;
  roleId: string;
  parentAgentSurfaceId?: string | null;
  operationProfile: string;
  operationKind: "conversation-turn" | "review";
  executionContract: StoredExecutionContractIdentity;
  providerId: ProviderId;
  nativeSessionId: string | null;
  model: ProviderModelRef | null;
  reasoningEffort: string | null;
  capabilitySnapshot: ProviderCapabilitySnapshot;
  effectiveSkillInputs: ProviderSkillInput[];
  handoffHash: string;
  deliveredThroughCompletedTurn: number;
  worktreeId: string | null;
  status: "queued" | "running" | "completed" | "interrupted" | "failed" | "blocked" | "terminated";
  createdAt: string;
  updatedAt: string;
}

export interface StoredConversationForkOperation {
  projectId: string;
  clientRequestId: string;
  requestHash: string;
  sourceConversationId: string;
  targetConversationId: string | null;
  providerId: ProviderId;
  sourceMessageId: string;
  anchorCompletedTurnSequence: number;
  expectedTimelineRevision: number;
  contextRevision: string;
  sourceGraphScopeId: string;
  status: "pending" | "submitting" | "completed" | "failed" | "interrupted";
  diagnostic: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StoredConversationQueuedTurnStatus = "queued" | "dispatching" | "blocked" | "dispatched" | "cancelled";

export interface StoredConversationTurnQueue {
  projectId: string;
  conversationId: string;
  productMode: ProductMode;
  revision: number;
  updatedAt: string;
}

export interface StoredConversationQueuedTurn {
  agentAccessMode?: import("../../provider-runtime/agent-access-policy.js").AgentAccessMode | null;
  projectId: string;
  conversationId: string;
  productMode: ProductMode;
  queueItemId: string;
  clientRequestId: string;
  requestHash: string;
  position: number;
  status: StoredConversationQueuedTurnStatus;
  retryCount: number;
  predecessorExecutionRevision: string;
  dispatchRequestId: string;
  executionContractFamily: string;
  executionContractEpoch: number;
  itemKind: "conversation-turn" | "review";
  reviewTargetJson: string | null;
  text: string;
  contextRefsJson: string;
  attachmentIdsJson: string;
  skillOverridesJson: string;
  providerId: ProviderId;
  agentTurnMode: AgentTurnMode | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  diagnostic: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
}

export interface StoredConversationTurnQueueContractConfirmation {
  projectId: string;
  conversationId: string;
  queueItemId: string;
  priorFamily: string;
  priorEpoch: number;
  targetFamily: string;
  targetEpoch: number;
  clientRequestId: string;
  expectedRevision: string;
  requestHash: string;
  confirmedAt: string;
}

export interface StoredConversationReviewOperation {
  projectId: string;
  conversationId: string;
  graphScopeId: string;
  clientRequestId: string;
  requestHash: string;
  providerId: ProviderId;
  reviewTargetJson: string;
  gitAdmissionJson: string;
  attemptId: string;
  status: "pending" | "submitting" | "reviewing" | "completed" | "failed" | "interrupted";
  sessionBindingHash: string | null;
  turnIdentityHash: string | null;
  source: "direct" | "queue";
  diagnostic: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredComposerDraft {
  projectId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  text: string;
  contextRefsJson: string;
  attachmentIdsJson: string;
  skillOverridesJson: string;
  selectedProviderId: ProviderId | null;
  updatedAt: string;
}

export interface StoredProviderResumePoint {
  projectId: string;
  conversationId: string;
  resumePointId: string;
  graphScopeId: string | null;
  changeId: string | null;
  previousProviderId: ProviderId;
  targetProviderId: ProviderId;
  snapshotJson: string;
  snapshotHash: string;
  createdAt: string;
}

export interface StoredSkillRoot {
  projectId: string;
  rootPath: string;
  sourceKind: string;
  updatedAt: string;
}

export type SkillEnablementScope = "project" | "topic";

export interface StoredSkillEnablement {
  projectId: string;
  changeId: string | null;
  skillId: string;
  scope: SkillEnablementScope;
  enabled: boolean;
  updatedAt: string;
}

export type StoredDecisionStatus = "pending" | "accepted" | "requested-changes" | "dismissed" | "completed" | "failed";

export interface StoredDecisionRecord {
  id: string;
  projectId: string;
  changeId: string | null;
  decisionType: string;
  status: StoredDecisionStatus;
  label: string;
  summary: string;
  targetId: string | null;
  runId: string | null;
  artifact: string | null;
  actionId: string | null;
  feedback: string | null;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
