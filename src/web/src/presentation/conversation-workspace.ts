import type {
  AgentTurnMode,
  ConversationContextSnapshot,
  ConversationTurnQueueSnapshot,
  ProductMode,
  ProjectGitReviewOptions,
  ProjectStatus,
  ProviderModelCatalogGroup,
  ProviderReviewTarget,
  SkillListItem,
  TopicAttachment,
  TopicFileReference,
  WorkpadRuntimeStatus,
} from "../types.js";
import type { FeatureSurface } from "./feature-surface.js";

interface ComposerConfigurationViewModel {
  providerDisplayName?: string;
  modelLabel: string;
  selectedProviderId?: string;
  productMode?: ProductMode;
  agentTurnMode?: AgentTurnMode;
  agentTurnModeDisabledReason?: string | null;
  agentModelId?: string | null;
  agentReasoningEffort?: string | null;
  providerModelCatalogs?: ProviderModelCatalogGroup[];
  providerModelCatalogsBusy?: boolean;
  skills?: SkillListItem[];
  activeSkillIds?: string[];
  reviewOpen?: boolean;
  reviewOptions?: ProjectGitReviewOptions | null;
  reviewLoading?: boolean;
  reviewSubmitting?: boolean;
}

interface ComposerConfigurationActions {
  onSelectAgentTurnMode?: (mode: AgentTurnMode) => void | Promise<void>;
  onSelectAgentProviderModel?: (providerId: string, modelId: string | null) => void | Promise<void>;
  onSelectAgentReasoningEffort?: (effort: string | null) => void | Promise<void>;
  onRefreshProviderModels?: () => void | Promise<void>;
  onToggleSkill?: (skillId: string) => void | Promise<void>;
  onOpenReview?: (capturedCommand?: string) => void | Promise<void>;
  onCloseReview?: () => void;
  onStartReview?: (target: ProviderReviewTarget, capturedCommand?: string) => void | Promise<void>;
  onStartReviewCommand?: (target: ProviderReviewTarget, capturedCommand: string) => void | Promise<void>;
  onReviewCommandError?: (message: string) => void;
}

export interface ProjectReadinessComposerViewModel extends ComposerConfigurationViewModel {
  project: ProjectStatus;
  projects: ProjectStatus[];
  selectedProjectId: string | null;
  draft: string;
  draftFileRefs: TopicFileReference[];
  draftAttachments: TopicAttachment[];
  enabledSkillCount?: number;
  resetToken?: number;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
}

export interface ProjectReadinessComposerActions extends ComposerConfigurationActions {
  onCreateDemand: (body: string, fileRefs?: TopicFileReference[], attachmentIds?: string[], attachmentFiles?: File[]) => Promise<void>;
  onDraftChange: (value: string) => void;
  onDraftFileRefsChange: (refs: TopicFileReference[]) => void;
  onAttachFiles: (files: File[]) => Promise<TopicAttachment[]>;
  onRemoveAttachment: (attachmentId: string) => Promise<void>;
  onSelectAgentTurnMode: (mode: AgentTurnMode) => void | Promise<void>;
  onSelectAgentProviderModel: (providerId: string, modelId: string | null) => void | Promise<void>;
  onSelectAgentReasoningEffort: (effort: string | null) => void | Promise<void>;
  onOpenProject: (projectId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export interface TopicComposerViewModel extends ComposerConfigurationViewModel {
  value: string;
  enabledSkillCount?: number;
  projectId: string | null;
  selectedFileRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
  disabledReason?: string;
  actionRunning: string | null;
  currentWorkpadStatus?: WorkpadRuntimeStatus;
  runControlState?: {
    state?: "idle" | "running" | "stopping";
    canStop: boolean;
    canSteer?: boolean;
    steerState?: "idle" | "submitting";
    providerId?: string;
    attemptId?: string;
    runId?: string;
  };
  conversationContext?: ConversationContextSnapshot | null;
  contextSubmitting?: boolean;
  turnQueue?: ConversationTurnQueueSnapshot | null;
  queueAvailable?: boolean;
  queueBusy?: boolean;
}

export interface TopicComposerActions extends ComposerConfigurationActions {
  onChange: (value: string) => void;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemoveAttachment?: (id: string) => void | Promise<void>;
  onSelectedFileRefsChange?: (refs: TopicFileReference[]) => void;
  onSend: () => Promise<void>;
  onStopAndContinue?: () => Promise<void>;
  onCompactContext?: () => void | Promise<void>;
  onEnqueue?: () => void | Promise<void>;
  onReclaimQueuedTurn?: (queueItemId: string) => void | Promise<void>;
  onRemoveQueuedTurn?: (queueItemId: string) => void | Promise<void>;
  onRetryQueuedTurn?: (queueItemId: string) => void | Promise<void>;
  onConfirmQueuedTurnExecution?: (queueItemId: string) => void | Promise<void>;
}

export type ProjectReadinessComposerFeatureSurface = FeatureSurface<ProjectReadinessComposerViewModel, ProjectReadinessComposerActions>;
export type TopicComposerFeatureSurface = FeatureSurface<TopicComposerViewModel, TopicComposerActions>;

export function projectReadinessComposerSurface(
  view: ProjectReadinessComposerViewModel,
  actions: ProjectReadinessComposerActions,
): ProjectReadinessComposerFeatureSurface {
  return { view, actions };
}

export function topicComposerSurface(
  view: TopicComposerViewModel,
  actions: TopicComposerActions,
): TopicComposerFeatureSurface {
  return { view, actions };
}

export interface ConversationWorkspaceChromeInput {
  readonly governanceVisible: boolean;
  readonly primaryConfirmationPresent: boolean;
  readonly otherConfirmationCount: number;
  readonly maintenanceConfirmationCount: number;
  readonly providerDiagnosticName?: string | null;
  readonly selectedProviderId: string | null;
  readonly providerOptions: readonly { readonly id: string; readonly label: string }[];
}

export interface ConversationWorkspaceChromeViewModel {
  readonly pendingConfirmationCount: number;
  readonly providerDisplayName: string;
}

export function projectConversationWorkspaceChrome(
  input: ConversationWorkspaceChromeInput,
): ConversationWorkspaceChromeViewModel {
  const pendingConfirmationCount = input.governanceVisible
    ? (input.primaryConfirmationPresent ? 1 : 0)
      + input.otherConfirmationCount
      + input.maintenanceConfirmationCount
    : 0;
  const providerDisplayName = input.providerDiagnosticName?.trim()
    || input.providerOptions.find((provider) => provider.id === input.selectedProviderId)?.label
    || (input.providerOptions.length === 1 ? input.providerOptions[0]!.label : "正在加载");
  return { pendingConfirmationCount, providerDisplayName };
}
