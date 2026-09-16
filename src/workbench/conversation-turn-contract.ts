import type { ProviderSkillInput } from "../project-harness/contracts.js";
import type {
  AgentTurnMode,
  ProductMode,
  ProviderCapabilitySnapshot,
  ProviderId,
  ProviderModelRef,
} from "../provider-runtime/index.js";
import type { ProviderFileInput, ProviderImageInput } from "../provider-runtime/contracts.js";
import type { ProjectRuntimeState } from "../project-runtime/coordinator.js";
import type { ProjectRuntimeResolution } from "../project-runtime/context.js";
import type { ManagedProject } from "../types/index.js";
import type { StoredConversation, StoredTopicMessage } from "./persistence/contracts.js";
import type { TopicAttachment } from "./attachments.js";
import type {
  TopicMessageResult,
  TopicThreadEntry,
  ValidatedPlanHandoffIntent,
  WorkbenchLiveSink,
} from "./types.js";

export interface TurnSkillContextRequest {
  project: ManagedProject;
  conversation: StoredConversation;
  requiredSkillIds: readonly string[];
  runtimeState?: ProjectRuntimeState;
}

export interface TurnSkillContextPreparation {
  paths: import("../project-runtime/paths.js").ProjectRuntimePaths;
  identityInputs?: readonly ProviderSkillInput[];
  extraRoots?: readonly string[];
  requiredSkillIds?: readonly string[];
  isSkillVisible?: (skill: { name: string; skillId: string; sourceKind: string }) => boolean;
  nativeSkillRoots?: readonly string[];
}

export interface TurnSkillContextDiagnostic {
  code: string;
  message: string;
  skillId?: string;
}

export interface TurnSkillContextResolution {
  skillInputs: readonly ProviderSkillInput[];
  diagnostics: readonly TurnSkillContextDiagnostic[];
  nativeSkillRoots?: readonly string[];
  requiredNativeSkills?: readonly string[];
  resolutionHash?: string;
}

export interface TurnSkillContextPort {
  resolve(request: TurnSkillContextRequest): Promise<TurnSkillContextResolution>;
}

export interface AttachmentDiagnostic {
  code: string;
  message: string;
  attachmentId?: string;
}

export interface TurnAttachmentEvidence {
  id: string;
  fileName: string;
  mediaType: string;
  size: number;
  contentHash: string;
  kind: "image" | "text";
  runtimeMode: "provider-image-input" | "provider-file-reference";
}

export interface TurnAttachmentResolution {
  attachmentIds: readonly string[];
  attachments: readonly TopicAttachment[];
  imageInputs: readonly ProviderImageInput[];
  fileInputs: readonly ProviderFileInput[];
  runtimeReadRoots: readonly string[];
  evidence: readonly TurnAttachmentEvidence[];
  diagnostics: readonly AttachmentDiagnostic[];
  handoffHash: string;
}

export interface ConversationTurnRequest {
  project: ManagedProject;
  conversation: StoredConversation;
  committedMessage: StoredTopicMessage;
  attachments: readonly TopicAttachment[];
  providerId: ProviderId;
  live?: WorkbenchLiveSink;
  harnessHandoff?: ValidatedPlanHandoffIntent;
  requiredSkillIds?: readonly string[];
  expectedSkillInputs?: readonly ProviderSkillInput[];
  preparedSkillResolution?: TurnSkillContextResolution | null;
  actualAgentTurnMode?: AgentTurnMode | null;
  executionIdentity?: Readonly<{ runId: string; attemptId: string }>;
  retryLineage?: Readonly<import("./types.js").ConversationRetryLineageEvidence>;
  admission: ConversationTurnAdmission;
}

export interface ConversationTurnAdmissionRequest {
  project: ManagedProject;
  productMode: ProductMode;
  conversationId: string;
  providerId: ProviderId;
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
  attachments: readonly TopicAttachment[];
}

export interface ConversationModelSelection {
  providerId: ProviderId;
  modelId: string | null;
  reasoningEffort: string | null;
}

export interface ConversationModelAdmission {
  providerId: ProviderId;
  requested: ConversationModelSelection;
  resolvedModelId: string | null;
  resolvedReasoningEffort: string | null;
  modelSource: "explicit" | "provider-configuration";
  effortSource: "explicit" | "model-default" | "provider-default";
  catalogGeneration: string;
}

export interface ConversationTurnAdmission {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  providerId: ProviderId;
  agentTurnMode: AgentTurnMode | null;
  capabilitySnapshot: ProviderCapabilitySnapshot | null;
  model: ProviderModelRef | null;
  modelAdmission: ConversationModelAdmission | null;
  sandboxPolicy: "read-only" | "workspace-write";
  writableRoots: readonly string[];
  runtimeState: ProjectRuntimeState;
  attachmentResolution: TurnAttachmentResolution | null;
}

/** Internal input created only by ConversationTurnRouter after composition. */
export interface ConversationTurnStrategyInput extends ConversationTurnRequest {
  runtimeState: ProjectRuntimeState;
  turnSkillResolution: TurnSkillContextResolution | null;
}

/** Internal side-effect-free validation input created before Turn Skill discovery. */
export interface ConversationTurnStrategyPreflightInput extends ConversationTurnRequest {
  runtimeState: ProjectRuntimeState;
}

export interface ConversationTurnExecutionPorts {
  skillContext: TurnSkillContextPort;
}

export interface ConversationTurnContinuationOptions {
  goalResume?: { deliveryKey: string; contextText: string };
  graphScopeId?: string;
}

export type ConversationTurnContinuationPort = (
  project: ManagedProject,
  conversationId: string,
  message: string,
  live?: WorkbenchLiveSink,
  planHandoff?: ValidatedPlanHandoffIntent,
  options?: ConversationTurnContinuationOptions,
) => Promise<TopicThreadEntry>;

export interface ConversationTurnRoutingPort {
  assertRequestedMode(conversation: StoredConversation, requestedMode?: ProductMode): void;
  admit(input: ConversationTurnAdmissionRequest): Promise<ConversationTurnAdmission>;
  resolveAttachments(project: ManagedProject, attachmentIds?: readonly string[]): Promise<readonly TopicAttachment[]>;
  route(input: ConversationTurnRequest, requestedMode?: ProductMode): Promise<TopicMessageResult>;
  resolveProviderId: (project: ManagedProject, requestedProviderId?: ProviderId) => ProviderId;
  resolveRuntimeState: (project: ManagedProject) => Promise<ProjectRuntimeState>;
  resolveTurnSkills?: (
    project: ManagedProject,
    conversation: StoredConversation,
    requiredSkillIds?: readonly string[],
  ) => Promise<TurnSkillContextResolution | null>;
  switchProviderAtSafePoint?: (input: {
    project: ManagedProject;
    resolution: ProjectRuntimeResolution;
    conversationId: string;
    targetProviderId: ProviderId;
  }) => Promise<import("./provider-switch.js").ProviderSwitchResult>;
  interruptMainAgentTurn?: (
    project: ManagedProject,
    conversationId: string,
  ) => Promise<import("./conversation-turn-control.js").ConversationTurnInterruptReceipt | null>;
  steerMainAgentTurn?: (
    project: ManagedProject,
    conversationId: string,
    clientRequestId: string,
    text: string,
  ) => Promise<import("./conversation-turn-control.js").ConversationTurnSteerReceipt | null>;
  continueMainAgentTurn?: ConversationTurnContinuationPort;
  runAgentNativeChildFollowup?: (input: {
    project: ManagedProject;
    conversationId: string;
    agentSurfaceId: string;
    message: string;
    live?: WorkbenchLiveSink;
  }) => Promise<TopicMessageResult>;
  runExactChildAgentTurn?: (input: {
    project: ManagedProject;
    conversationId: string;
    agentSurfaceId: string;
    message: string;
    live?: WorkbenchLiveSink;
  }) => Promise<TopicMessageResult>;
}

export interface ConversationTurnStrategy {
  readonly productMode: ProductMode;
  preflight?(input: ConversationTurnStrategyPreflightInput): void | Promise<void>;
  execute(
    input: ConversationTurnStrategyInput,
    ports: ConversationTurnExecutionPorts,
  ): Promise<TopicMessageResult>;
}

export interface ModeActivitySummary {
  runningCount: number;
  failedCount: number;
  attentionCount: number;
}
