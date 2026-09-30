import type { AgentAccessMode } from "../provider-runtime/agent-access-policy.js";
import type { AgentTurnMode, ProductMode, ProviderId, ProviderReviewTarget } from "../provider-runtime/index.js";
import type { TopicFileReference } from "./types.js";

export interface ConversationQueuedTurnInput {
  agentAccessMode?: AgentAccessMode | null;
  itemKind?: "conversation-turn" | "review";
  reviewTarget?: ProviderReviewTarget | null;
  text: string;
  contextRefs: TopicFileReference[];
  attachmentIds: string[];
  skillOverrides: Record<string, boolean>;
  providerId: ProviderId;
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
}

export interface ConversationQueuedTurn extends ConversationQueuedTurnInput {
  itemKind: "conversation-turn" | "review";
  reviewTarget: ProviderReviewTarget | null;
  attachments?: Array<{ id: string; fileName: string; previewUrl?: string }>;
  queueItemId: string;
  clientRequestId: string;
  position: number;
  status: "queued" | "dispatching" | "blocked" | "dispatched" | "cancelled";
  retryCount: number;
  diagnostic?: string;
  createdAt: string;
  updatedAt: string;
  executionCompatibility: ConversationQueueExecutionCompatibility;
  guideMode?: ConversationGuideMode;
  guideDisabledReason?: string;
  deliveryPhase?: ConversationDeliveryPhase;
  deliveryUncertain?: boolean;
}

export interface ConversationQueueExecutionContractRef {
  family: string;
  epoch: number;
}

export type ConversationQueueExecutionCompatibility =
  | { state: "compatible" }
  | {
      state: "confirmation-required" | "legacy-confirmation-required";
      created: ConversationQueueExecutionContractRef;
      target: ConversationQueueExecutionContractRef;
      summary: string;
    };

export interface ConversationTurnQueueSnapshot {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  revision: string;
  executionRevision: string | null;
  items: ConversationQueuedTurn[];
  canEnqueue: boolean;
  canDispatch: boolean;
  guideMode?: ConversationGuideMode;
  guideDisabledReason?: string;
  guideTarget?: { providerId: ProviderId; attemptId: string };
  disabledReason?: string;
}

export interface ConversationTurnEnqueueRequest extends ConversationQueuedTurnInput {
  expectedAccessRevision?: number;
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  clientRequestId: string;
  expectedRevision: string;
  expectedExecutionRevision: string;
  expectedDraftUpdatedAt: string | null;
}

export interface ConversationTurnQueueContractConfirmationRequest {
  productMode: ProductMode;
  conversationId: string;
  queueItemId: string;
  expectedRevision: string;
  clientRequestId: string;
  expectedCreatedContract: ConversationQueueExecutionContractRef;
  expectedTargetContract: ConversationQueueExecutionContractRef;
}

export type ConversationGuideMode = "steer" | "cutover" | "unavailable";
export type ConversationDeliveryPhase = "claimed" | "invoking" | "waiting-terminal" | "accepted" | "rejected" | "uncertain" | "completed";

export interface ConversationQueueGuideRequest {
  productMode: ProductMode;
  conversationId: string;
  queueItemId: string;
  expectedRevision: string;
  expectedExecutionRevision: string;
  providerId: ProviderId;
  expectedAttemptId: string;
  clientRequestId: string;
}

export interface ConversationDeliveryOperation {
  projectId: string;
  conversationId: string;
  productMode: ProductMode;
  clientRequestId: string;
  queueItemId: string | null;
  requestHash: string;
  mode: "next-turn" | "steer" | "cutover";
  providerId: ProviderId;
  attemptId: string | null;
  executionRevision: string;
  phase: ConversationDeliveryPhase;
  messageId: string | null;
  diagnostic: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ConversationQueueAdmissionRejection {
  status: "not-accepted";
  action: "enqueue" | "guide";
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  clientRequestId: string;
  queueItemId?: string;
}
