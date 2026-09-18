import type { WorkbenchThreadActionType } from "./workflow-actions.js";
import type { ConversationInteractionQueue, InteractionHistoryRecord } from "../../workbench/conversation-interaction-contract.js";
import type { AgentSurfacesInvalidated } from "../../workbench/agent-surface-contract.js";
export type { ProductModeActivityIndicator, ProductModeActivityState, ProjectProductModeActivitySnapshot } from "../../workbench/product-mode-activity.js";
export type { ConversationContextSnapshot, ProviderContextLifecycleState } from "../../workbench/conversation-context-lifecycle.js";
export type { ConversationQueuedTurn, ConversationQueuedTurnInput, ConversationTurnQueueSnapshot } from "../../workbench/conversation-turn-queue.js";
export type { ConversationDeleteConfirmation, ConversationLifecycleReceipt, ConversationLifecycleSnapshot } from "../../workbench/conversation-lifecycle.js";
export type { ProviderReviewTarget } from "../../provider-runtime/index.js";
import type { ConversationContextSnapshot } from "../../workbench/conversation-context-lifecycle.js";
import type { DesktopShellCapability } from "../../types/desktop-shell.js";
import type {
  ProviderCapabilityItem as RuntimeProviderCapabilityItem,
  ProviderCapabilityKey as RuntimeProviderCapabilityKey,
  ProviderCapabilitySnapshot as RuntimeProviderCapabilitySnapshot,
  ProviderDiagnosticsSnapshot,
} from "../../provider-runtime/index.js";
export type { ConversationInteraction, ConversationInteractionQuestion, ConversationInteractionQueue, ConversationInteractionSettlement, InteractionHistoryRecord } from "../../workbench/conversation-interaction-contract.js";
export type { AgentSurfaceProjection, AgentSurfaceProjectionItem, AgentSurfaceStatus, AgentSurfacesInvalidated, AgentSurfacesInvalidationReason } from "../../workbench/agent-surface-contract.js";
export type { AgentCatalogDisplayProjection, AgentCatalogDisplayRole } from "../../workbench/agent-catalog-display-contract.js";

export type AppStatus = { mode: "app" | "project"; directProjectId: string | null; desktopShell?: DesktopShellCapability };
export type ProjectGitReviewOptions = {
  isGitRepository: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  branches: Array<{ name: string; sha: string }>;
  commits: Array<{ sha: string; shortSha: string; summary: string; timestamp: string }>;
  generation: string;
  message?: string;
};
export type ProviderDiagnostics = ProviderDiagnosticsSnapshot;
export type ProviderEffectiveModelSource = "selected" | "config" | "provider-default";
export type ProviderModelCandidate = {
  providerId: string;
  modelId: string;
  label: string;
  source: string;
  isDefault?: boolean;
  supportedReasoningEfforts: Array<{ value: string; label: string; description?: string }>;
  defaultReasoningEffort: string | null;
};
export type ProviderModelSettingsSnapshot = {
  providerId: string;
  selectedModel: { providerId: string; modelId: string } | null;
  effectiveModel: { providerId: string; modelId: string } | null;
  effectiveModelSource: ProviderEffectiveModelSource;
  candidates: ProviderModelCandidate[];
  available: boolean;
  degradedReason?: string;
};

export type ProviderModelCatalogGroup = {
  providerId: string;
  displayName: string;
  status: "loading" | "ready" | "error";
  snapshot: ProviderModelSettingsSnapshot | null;
  message?: string;
};
export type ProviderCapabilityKey = RuntimeProviderCapabilityKey;
export type ProviderCapabilityItem = RuntimeProviderCapabilityItem;
export type ProviderId = string;
export type ProductMode = "harness" | "agent";
export type AgentTurnMode = "default" | "plan";
export type HarnessExecutionMode = "stepwise" | "scoped-auto";
export type ProviderCapabilitySnapshot = RuntimeProviderCapabilitySnapshot;
export type ProviderRuntimeSummary = {
  providerId: ProviderId;
  productMode: ProductMode;
  harnessExecutionModes: HarnessExecutionMode[];
  snapshot: ProviderCapabilitySnapshot;
};
export type ProjectStatus = {
  project: { id: string; name: string; path: string; defaultProviderId?: string } | null;
  path: string;
  pathExists: boolean;
  isGitRepo: boolean;
  branch?: string | null;
  dirty?: boolean | null;
  managed: boolean;
  harness: {
    projectPath: string;
    managed: boolean;
    readiness: "missing" | "partial" | "ready" | "unavailable";
    activeChanges: Array<{ name: string; path: string }>;
    pendingEvolution: boolean;
    components: Array<{
      name: string;
      path: string;
      location: "project";
      exists: boolean;
      required: boolean;
    }>;
  };
  runtimeAvailability?: {
    state: "ready" | "upgrade-required" | "upgrading" | "onboarding" | "repair-required" | "unavailable";
    summary: string | null;
    recovery: string | null;
  };
};

export type SkillSourceKind = "custom" | "system-aho" | "provider-native" | "project-harness";
export type SkillProviderBinding = {
  providerId: string;
  bindingKind: "native";
  status: "ready" | "disabled";
  contentHash: string;
  scope: "user" | "repo" | "system" | "admin";
};
export type SkillListItem = {
  skillId: string;
  name: string;
  description: string;
  sourcePath: string;
  sourceKind: SkillSourceKind;
  scope: "user" | "repo" | "system" | "admin";
  contentHash: string;
  compatibility: { requiredCapabilities: string[] };
  providerBindings: SkillProviderBinding[];
  providerEnabled: boolean;
  required: boolean;
  runtimeAssigned: boolean;
  enabledProject: boolean;
  enabledTopics: string[];
  disabledTopics: string[];
};
export type SkillRootListItem = {
  rootPath: string;
  sourceKind: "custom";
  updatedAt: string;
};
export type TopicFileReference = {
  relativePath: string;
  name: string;
  kind: "file" | "directory";
  extension?: string;
  size?: number;
  source?: "composer";
};

export type TopicAttachment = {
  id: string;
  fileName: string;
  mediaType: string;
  kind: "image" | "text" | "unsupported";
  size: number;
  hash: string;
  source: "composer";
  createdAt: string;
  runtimeMode: "provider-image-input" | "provider-file-reference" | "bounded-text-preview" | "metadata-only";
  previewUrl?: string;
};
export type ComposerDraftDiagnostic = {
  code: "invalid-field" | "unavailable-reference" | "unavailable-attachment" | "unavailable-provider" | "unavailable-skill";
  message: string;
};
export type ComposerDraftSnapshot = {
  projectId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  text: string;
  contextRefs: TopicFileReference[];
  attachments: TopicAttachment[];
  skillOverrides: Record<string, boolean>;
  selectedProviderId: string | null;
  updatedAt: string;
  diagnostics: ComposerDraftDiagnostic[];
};
export type ComposerDraftWrite = Omit<ComposerDraftSnapshot, "attachments" | "updatedAt" | "diagnostics"> & {
  attachmentIds: string[];
  expectedUpdatedAt: string | null;
};
export type ProjectFileTreeResult = {
  path: string;
  parentPath: string | null;
  entries: TopicFileReference[];
};
export type ProjectFilePreviewResult = {
  path: string;
  name: string;
  kind: "file" | "directory" | "unknown";
  status: "text" | "binary" | "too-large" | "directory" | "not-found";
  extension?: string;
  size?: number;
  content?: string;
  truncated?: boolean;
  message?: string;
};
export type ProjectGitFileGroup = "staged" | "unstaged" | "untracked";
export type ProjectGitFileStatus = {
  relativePath: string;
  name: string;
  group: ProjectGitFileGroup;
  indexStatus: string;
  worktreeStatus: string;
  statusLabel: string;
  additions?: number;
  deletions?: number;
};
export type ProjectGitStatusResult = {
  isGitRepository: boolean;
  branch: string | null;
  dirty: boolean;
  staged: ProjectGitFileStatus[];
  unstaged: ProjectGitFileStatus[];
  untracked: ProjectGitFileStatus[];
  totalAdditions: number;
  totalDeletions: number;
  message?: string;
};
export type ProjectGitDiffSection = {
  label: string;
  kind: "staged" | "unstaged";
  patch: string;
  truncated: boolean;
};
export type ProjectGitDiffResult = {
  relativePath: string;
  name: string;
  status: "text" | "binary" | "too-large" | "not-found" | "not-git-repository" | "no-diff";
  sections: ProjectGitDiffSection[];
  additions?: number;
  deletions?: number;
  message?: string;
};
export type ProjectGitHistoryCommit = {
  sha: string;
  shortSha: string;
  summary: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  parents: string[];
  refs: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
};
export type ProjectGitHistoryResult = {
  status: "ok" | "not-git-repository" | "error";
  branch: string | null;
  head: string | null;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  commits: ProjectGitHistoryCommit[];
  message?: string;
};
export type ProjectGitCommitFileChange = {
  relativePath: string;
  oldPath?: string | null;
  name: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
};
export type ProjectGitCommitDetailResult = {
  status: "ok" | "not-found" | "not-git-repository" | "error";
  sha: string;
  shortSha?: string;
  summary?: string;
  message?: string;
  author?: string;
  authorEmail?: string;
  committer?: string;
  committerEmail?: string;
  timestamp?: string;
  parents?: string[];
  refs?: string[];
  files: ProjectGitCommitFileChange[];
  totalAdditions?: number;
  totalDeletions?: number;
};
export type ProjectGitCommitDiffResult = {
  relativePath: string;
  name: string;
  status: "text" | "binary" | "too-large" | "not-found" | "not-git-repository" | "no-diff";
  patch: string;
  truncated: boolean;
  additions?: number;
  deletions?: number;
  message?: string;
};
export type RuntimeDiagnosticStatus = "ok" | "warning" | "error" | "info";
export type RuntimeDiagnosticItem = {
  id: string;
  title: string;
  status: RuntimeDiagnosticStatus;
  summary: string;
  detail?: string;
};
export type RuntimeDiagnosticsSnapshot = {
  generatedAt: string;
  summary: {
    status: "ok" | "degraded" | "error";
    issueCount: number;
    degradedCount: number;
  };
  items: RuntimeDiagnosticItem[];
};
export type RuntimeActivitySeverity = "info" | "ok" | "warning" | "error";
export type RuntimeActivityType =
  | "provider"
  | "run"
  | "run-event"
  | "validation"
  | "audit"
  | "message-context"
  | "terminal"
  | "action-error";
export type RuntimeActivityRef = {
  kind: "run" | "artifact" | "topic" | "validation" | "audit" | "provider" | "diagnostic";
  label: string;
  id?: string;
  path?: string;
};
export type RuntimeActivityItem = {
  id: string;
  timestamp: string;
  type: RuntimeActivityType;
  severity: RuntimeActivitySeverity;
  status?: string;
  title: string;
  summary: string;
  refs: RuntimeActivityRef[];
  details?: string[];
};
export type RuntimeActivityLogSnapshot = {
  generatedAt: string;
  projectId: string;
  topicId: string | null;
  limit: number;
  truncated: boolean;
  items: RuntimeActivityItem[];
};
export type Snapshot = {
  productMode: ProductMode;
  project: { id: string; name: string; path: string } | null;
  harness: { harnessReady?: boolean };
  left: {
    topics: Topic[];
    workpads?: WorkpadSummary[];
    repo?: { branch?: string; dirty?: boolean; path?: string; git?: boolean };
  };
  center: {
    selectedTopic: TopicDetail | null;
    workpad: Workpad;
    agentLoop: { runs: RunSummary[] };
    thread: { items: ThreadStreamItem[] };
    conversationInteractions: ConversationInteractionQueue;
    conversationContext?: ConversationContextSnapshot | null;
    activeTab?: CenterTab;
  };
  right: { approvals: Approval[]; decisions: Decision[]; decisionInspector: DecisionInspector; confirmationQueue: ConfirmationQueue };
  harnessGaps: Array<{ id: string; status: string; summary: string }>;
  warnings: string[];
};

export type Topic = { id: string; productMode: ProductMode; agentTurnMode?: AgentTurnMode | null; agentModelId?: string | null; agentReasoningEffort?: string | null; title: string; state: string; updatedAt?: string; kind?: "conversation" | "change"; boundChangeId?: string | null; graphScopeId?: string; selectedProviderId?: string; completedTurnSequence?: number; timelineRevision?: number; forkBoundary?: { sourceConversationId: string; sourceMessageId: string; completedTurnSequence: number; sourceDeleted: boolean }; lifecycle?: import("../../workbench/conversation-lifecycle.js").ConversationLifecycleSnapshot };
export type WorkpadRuntimeStatus = "active" | "running" | "queued" | "blocked" | "waiting-decision" | "archived" | "readonly";
export type WorkpadUserStatus = "processing" | "waiting-confirmation" | "needs-rework" | "later" | "completed" | "abandoned";
export type ConversationLifecycle = "active" | "running" | "waiting-user" | "archived-readonly" | "abandoned";
export type WorkpadSummary = {
  id: string;
  title: string;
  state: string;
  runtimeStatus: WorkpadRuntimeStatus;
  userStatus?: WorkpadUserStatus;
  userStatusLabel?: string;
  conversationLifecycle?: ConversationLifecycle;
  linkedFromChangeId?: string;
  selected: boolean;
  waitingDecisionCount: number;
  latestRunStatus?: string;
  latestRunId?: string;
  queueStatus?: string;
  blocker?: string;
  updatedAt?: string;
};
export type AgentEvidenceRef = { label: string; ref: string; kind: "artifact" | "run" | "task" | "decision" | "remote" | "maintenance" };
export type CenterTab = "conversation" | "workpad" | "agentOffice";
export type ParentAgentTranscriptBlock = {
  id: string;
  kind: "prose" | "process" | "tool-result" | "evidence";
  source: "user" | "provider-runtime" | "aho-orchestration" | "workflow-evidence" | "maintenance";
  title?: string;
  text: string;
  status?: string;
  evidenceRefs?: Array<{ label: string; ref: string; kind: "artifact" | "run" | "decision" | "remote" | "maintenance" }>;
  isError?: boolean;
};
export type ParentAgentTranscriptCell = {
  id: string;
  kind: "user-message" | "assistant-message" | "review-card" | "process-row" | "evidence-row" | "user-input" | "document-preview" | "detail-only";
  source: "user" | "provider-runtime" | "aho-orchestration" | "workflow-evidence" | "maintenance";
  agentRoleId?: string;
  agentTaskId?: string;
  initialThreadInput?: boolean;
  runId?: string;
  providerId?: string;
  attemptId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  itemId?: string;
  agentSurfaceId?: string;
  agentDisplayName?: string;
  targetAgentSurfaceId?: string;
  targetAgentDisplayName?: string;
  timestamp?: string;
  title?: string;
  text: string;
  status?: string;
  evidenceRefs?: ParentAgentTranscriptBlock["evidenceRefs"];
  isError?: boolean;
    realtime?: boolean;
    activityKind?: "turn" | "reasoning" | "command" | "file" | "search" | "tool" | "agent" | "status";
    detailText?: string;
  pendingIntent?: {
    clientRequestId: string;
    canRetry: boolean;
    canRestore: boolean;
  };
  contextRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
  interactionHistory?: InteractionHistoryRecord;
  documentRef?: CanonicalDocumentReference;
  providerReview?: import("../../workbench/types.js").ConversationReviewEvidence;
  retryTarget?: {
    failedAttemptId: string;
    sourceMessageId: string;
    rootSourceMessageId: string;
    providerId: string;
    agentTurnMode: AgentTurnMode;
    modelId: string | null;
    reasoningEffort: string | null;
  };
  forkTarget?: {
    sourceMessageId: string;
    providerId: string;
    completedTurnSequence: number;
    timelineRevision: number;
    contextRevision: string;
    recovery?: true;
  };
};

export type CanonicalDocumentReference = {
  documentId: string;
  documentKind: "plan";
  title: string;
  sourceMessageId: string;
  sourceCanonicalItemId: string;
  proposalHash: string;
};

export type WorkspaceResourceTarget =
  | { kind: "agent"; conversationId: string; agentSurfaceId: string }
  | { kind: "document"; conversationId: string; documentId: string }
  | { kind: "project-file"; relativePath: string };

export type TextDocumentResource = {
  resourceId: string;
  kind: "plan" | "markdown-file" | "text-file";
  title: string;
  language: "markdown" | "text";
  content: string;
  revision: string;
  readOnly: true;
  target: Extract<WorkspaceResourceTarget, { kind: "document" | "project-file" }>;
};

export type WorkspaceResourceTab = {
  resourceId: string;
  target: WorkspaceResourceTarget;
};
export type ParentAgentTranscriptItem = {
  id: string;
  actor: "user" | "parent-agent";
  timestamp?: string;
  blocks: ParentAgentTranscriptBlock[];
  derived?: boolean;
};
export type ParentAgentTranscript = {
  conversationId?: string;
  changeId?: string;
  title: string;
  cells?: ParentAgentTranscriptCell[];
  items: ParentAgentTranscriptItem[];
  emptyMessage?: string;
  paging?: {
    limit: number;
    totalCount: number;
    hasMoreBefore: boolean;
    nextBeforeCursor?: string;
  };
};

export type TopicDetail = Topic & {
  closeGate?: { ready: boolean; warnings: string[]; blockingIssues: string[] };
  reviewStatus?: string | null;
  acCount?: number;
  taskCount?: number;
};
export type WorkpadNextAction = {
  id: string;
  label: string;
  description: string;
  kind: "workflow-action" | "approval" | "read-only" | "none";
  enabled: boolean;
  requiresConfirmation: boolean;
  actionType?: ThreadStreamAction["actionType"];
  approvalId?: string;
  workflowGraphPlanId?: string;
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
  taskIds?: string[];
  taskRunId?: string;
  workerLeaseId?: string;
  runId?: string;
  validationRunId?: string;
  reworkValidationRunId?: string;
  auditRunId?: string;
  reworkAuditRunId?: string;
  disabledReason?: string;
};
export type DecisionActionKind = "approval" | "workflow-action" | "feedback" | "evidence" | "abandon" | "none";
export type WorkbenchTaskEvidence = {
  id: string;
  label: string;
  source: "run" | "validation" | "audit";
  status?: string;
  runId?: string;
  worktreeId?: string;
  artifact?: string;
  timestamp?: string;
};
export type WorkbenchTaskNextAction = {
  id: string;
  label: string;
  actionType?: ThreadStreamAction["actionType"];
  taskIds?: string[];
  taskRunId?: string;
  workflowGraphPlanId?: string;
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
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
};
export type WorkbenchTaskRunSummary = {
  id: string;
  status: string;
  attempt: number;
  roleId: string;
  runId?: string;
  worktreeId?: string;
  blockedReason?: string;
  failureReason?: string;
  officialReworkAttempt?: number;
  autoReworkAvailable?: boolean;
  reworkBudget?: number;
};
export type WorkbenchWorkerLeaseSummary = {
  id: string;
  status: string;
  workerId: string;
  claimedAt: string;
  expiresAt: string;
};
export type WorkbenchTaskNode = {
  taskId: string;
  title: string;
  acIds: string[];
  checked: boolean;
  status: "planned" | "running" | "evidence-ready" | "blocked" | "checked";
  taskRun?: WorkbenchTaskRunSummary;
  workerLease?: WorkbenchWorkerLeaseSummary;
  latestEvidence: WorkbenchTaskEvidence[];
  blockers: string[];
  nextAction: WorkbenchTaskNextAction;
  autoRework?: { available: boolean; attempt: number; budget: number; reason: string; failureClassification: string };
};
export type WorkbenchTaskGraph = {
  source: "accepted-tasks" | "missing";
  nodes: WorkbenchTaskNode[];
  changeLevelEvidence: WorkbenchTaskEvidence[];
  warnings: string[];
};
export type WorkbenchCodingPackage = {
  id: string;
  title: string;
  summary: string;
  taskIds: string[];
  completedTaskIds: string[];
  acIds: string[];
  coveredAcIds: string[];
  missingEvidenceAcIds: string[];
  recommendedRoleId: string;
  assignmentStatus: "suggested" | "not-assigned";
  status: "missing" | "suggested" | "blocked" | "evidence-ready" | "readonly";
};
export type WorkbenchTaskQueueSummary = {
  id: string;
  status: string;
  currentTaskId?: string;
  totalCount: number;
  completedCount: number;
  blockedReason?: string;
  failureReason?: string;
  pausedReason?: string;
  workflowRunId?: string;
  workflowGraphPlanId?: string;
  nextAction?: WorkbenchTaskNextAction;
  items: Array<{
    id: string;
    taskId: string;
    order: number;
    status: string;
    taskRunId?: string;
    blockedReason?: string;
    failureReason?: string;
  }>;
};
export type WorkpadMainAgentExecutionSummary = {
  stage: "planning" | "coding" | "validation" | "audit" | "rework" | "done" | "needs-user-input";
  status: "draft" | "running" | "completed" | "needs-user-input" | "stopped";
  runs: Array<{ roleId: string; status: string; runId?: string; summary: string; artifact?: string }>;
  agentTasks: Array<{
    id: string;
    roleId: string;
    kind: "foreground" | "background";
    status: string;
    changeId?: string;
    runId?: string;
    summary: string;
    resultSummary?: string;
    evidenceRefs: string[];
    createdAt: string;
    completedAt?: string;
  }>;
  reworkUsed: number;
  reworkBudget: number;
};
export type Workpad = {
  title: string;
  subtitle: string;
  state: "diagnostic" | "empty" | "active" | "readonly";
  userStatus?: WorkpadUserStatus;
  userStatusLabel?: string;
  conversationId?: string;
  demandId?: string;
  boundChangeId?: string;
  conversationLifecycle?: ConversationLifecycle;
  linkedFromChangeId?: string;
  pendingFeedback?: Array<{ id: string; text: string; timestamp: string; runId?: string; status: "pending-next-turn" | "applied" }>;
  coderSelfTestSummary?: string;
  officialValidationResult?: string;
  officialAuditResult?: string;
  officialReworkAttempt?: number;
  reworkBudget?: number;
  failureClassification?: string;
  requiresUserInputReason?: string;
  scopedFeedbackTarget?: Record<string, unknown>;
  workflowGraphPlan?: WorkflowGraphPlanSummary;
  schedulerContract?: SchedulerContractSummary;
  schedulerDispatchDryRun?: SchedulerDispatchDryRunSummary;
  schedulerWorkerSessionPlan?: SchedulerWorkerSessionPlanSummary;
  schedulerClaimReconcilePlan?: SchedulerClaimReconcilePlanSummary;
  schedulerLaunchPreflight?: SchedulerLaunchPreflightSummary;
  schedulerRun?: SchedulerRunSummary;
  schedulerRuntime?: SchedulerRuntimeSummary;
  schedulerReconcileSnapshot?: SchedulerReconcileSnapshotSummary;
  schedulerClaimReservation?: SchedulerClaimReservationSummary;
  schedulerWorkerStart?: SchedulerWorkerStartSummary;
  schedulerWorkerResult?: SchedulerWorkerResultSummary;
  schedulerWorkerValidation?: SchedulerWorkerValidationSummary;
  schedulerWorkerAudit?: SchedulerWorkerAuditSummary;
  schedulerWorkerReworkPlan?: SchedulerWorkerReworkPlanSummary;
  schedulerWorkerReworkStart?: SchedulerWorkerReworkStartSummary;
  schedulerWorkerReworkResult?: SchedulerWorkerReworkResultSummary;
  schedulerWorkerReworkValidation?: SchedulerWorkerReworkValidationSummary;
  schedulerWorkerReworkAudit?: SchedulerWorkerReworkAuditSummary;
  schedulerWorkerPaths?: SchedulerWorkerPathSummary[];
  schedulerIntegrationCandidate?: SchedulerIntegrationCandidateSummary;
  schedulerIntegrationCheckHandoff?: SchedulerIntegrationCheckHandoffSummary;
  schedulerIntegrationOutcome?: SchedulerIntegrationOutcomeSummary;
  schedulerRunCompletion?: SchedulerRunCompletionSummary;
  schedulerRunBlockedCloseout?: SchedulerRunBlockedCloseoutSummary;
  mainAgentExecution?: WorkpadMainAgentExecutionSummary;
  resultReview?: {
    status: "not-ready" | "ready-to-apply" | "needs-rework" | "applied-clean" | "applied-source-dirty";
    title: string;
    summary: string;
    worktreeId?: string;
    changedFiles: string[];
    diffStat?: string;
    validation?: { id: string; status: string; runId: string };
    audit?: { id: string; status: string; runId: string; findingCount: number; notes: string[]; artifact?: string };
    applyReadiness: { ready: boolean; kind?: string; label: string; message?: string; blockingIssues: string[]; warnings: string[] };
    evidence: Array<{ id: string; label: string; source: string; status?: string; artifact?: string; timestamp?: string }>;
  };
  runControlState?: { state?: "idle" | "running" | "stopping"; canStop: boolean; canSteer?: boolean; steerState?: "idle" | "submitting"; providerId?: ProviderId; attemptId?: string; runId?: string; stopActionType?: ThreadStreamAction["actionType"]; pendingFeedbackCount: number; explanation: string };
  intake: {
    goal: string;
    currentUnderstanding: string;
    source: "project" | "topic" | "thread" | "diagnostic";
    relatedArtifacts: string[];
    missingInfo: string[];
    confirmedConstraints: string[];
    openQuestions: string[];
    assumptions: string[];
    pendingClarifications: ClarificationRequest[];
  };
  progress: {
    topicState: string;
    spec: "missing" | "ready" | "unknown";
    plan: "missing" | "ready" | "unknown";
    tasks: "missing" | "ready" | "unknown";
    acCount: number;
    taskCount: number;
    runCount: number;
    latestRunStatus?: string;
    validationStatus?: string;
    auditStatus?: string;
  };
  tasks: Array<{ id: string; title: string; done: boolean; acIds: string[]; warnings: string[] }>;
  codingPackages: WorkbenchCodingPackage[];
  taskGraph: WorkbenchTaskGraph;
  taskQueue?: WorkbenchTaskQueueSummary;
  evidence: Array<{ id: string; label: string; source: string; status?: string; artifact?: string; timestamp?: string }>;
  blockers: string[];
  warnings: string[];
  nextAction: WorkpadNextAction;
  background?: {
    totalCount: number;
    runningCount: number;
    queuedCount: number;
    blockedCount: number;
    waitingDecisionCount: number;
    items: WorkpadSummary[];
  };
  memoryIsolation?: {
    projectStableNamespace: "project/stable";
    currentChangeNamespace?: string;
    runNamespaces: string[];
    providerSessionNamespace: "agent/{roleId}/session/{sessionId}";
    relatedWorkpads: Array<{ changeId: string; title: string; status: WorkpadRuntimeStatus; factBoundary: "summary-only" | "local-evidence-only" }>;
    stableFactSources: string[];
    writeBoundaries: string[];
    warnings: string[];
  };
};
export type WorkflowGraphPlanSummary = {
  id: string;
  changeId: string;
  schedulerContractId?: string;
  schedulerWorkerPlanId?: string;
  schedulerClaimReconcilePlanId?: string;
  status: "compiled" | "superseded" | "rejected";
  graphMode: "sequential-v1" | "ready-set-v1";
  nodeCount: number;
  edgeCount: number;
  waveCount?: number;
  stageCount: number;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerContractSummary = {
  id: string;
  changeId: string;
  status: "compiled" | "superseded" | "rejected";
  schedulerMode: "parallel-readiness-v1";
  nodeCount: number;
  waveCount: number;
  dependencyCount: number;
  conflictCount: number;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerDispatchDryRunSummary = {
  id: string;
  changeId: string;
  schedulerContractId: string;
  status: "generated" | "superseded" | "rejected";
  schedulerMode: "parallel-readiness-v1";
  waveCount: number;
  nodeCount: number;
  blockedCount: number;
  estimatedMaxWaveWidth: number;
  prerequisiteCount: number;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerSessionPlanSummary = {
  id: string;
  changeId: string;
  schedulerContractId: string;
  schedulerDispatchDryRunId: string;
  status: "planned" | "superseded" | "rejected";
  schedulerMode: "parallel-readiness-v1";
  plannedWorkerCount: number;
  stageCount: number;
  blockedCount: number;
  warningCount: number;
  recoveryKeyCoverage: "complete" | "partial";
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerClaimReconcilePlanSummary = {
  id: string;
  changeId: string;
  schedulerContractId: string;
  schedulerDispatchDryRunId: string;
  schedulerWorkerPlanId: string;
  status: "planned" | "superseded" | "rejected";
  schedulerMode: "parallel-readiness-v1";
  waveCount: number;
  claimIntentCount: number;
  plannedSlotDemand: number;
  maxPlannedWaveWidth: number;
  blockedCount: number;
  recoveryKeyCoverage: "complete" | "partial";
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerLaunchPreflightSummary = {
  id: string;
  changeId: string;
  schedulerContractId: string;
  schedulerDispatchDryRunId: string;
  schedulerWorkerPlanId: string;
  schedulerClaimReconcilePlanId: string;
  status: "checked" | "blocked" | "rejected";
  schedulerMode: "parallel-readiness-v1";
  claimIntentCount: number;
  plannedSlotDemand: number;
  maxPlannedWaveWidth: number;
  blockedCount: number;
  humanGateRequired: boolean;
  toolPolicyGateRequired: boolean;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerRunSummary = {
  id: string;
  changeId: string;
  schedulerContractId: string;
  schedulerDispatchDryRunId: string;
  schedulerWorkerPlanId: string;
  schedulerClaimReconcilePlanId: string;
  schedulerLaunchPreflightId: string;
  status: "prepared" | "blocked" | "abandoned";
  schedulerMode: "parallel-readiness-v1";
  claimIntentCount: number;
  plannedSlotDemand: number;
  maxPlannedWaveWidth: number;
  blockedCount: number;
  humanConfirmed: boolean;
  futureToolPolicyGateRequired: boolean;
  futureHumanGateRequired: boolean;
  journalEventCount: number;
  artifact?: string;
  markdownArtifact?: string;
  journalArtifact?: string;
  updatedAt: string;
};
export type SchedulerRuntimeSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  status: "initialized" | "blocked";
  schedulerMode: "parallel-readiness-v1";
  claimIntentCount: number;
  waveCount: number;
  plannedSlotDemand: number;
  maxPlannedWaveWidth: number;
  blockedCount: number;
  lastReconcileSnapshotId?: string;
  lastClaimReservationId?: string;
  lastClaimReservationSnapshotId?: string;
  artifact?: string;
  eventsArtifact?: string;
  updatedAt: string;
};
export type SchedulerClaimReservationSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerReconcileSnapshotId: string;
  status: "reserved" | "blocked" | "rejected";
  schedulerMode: "parallel-readiness-v1";
  reservedCount: number;
  blockedCount: number;
  sourceLockCount: number;
  waveIndex: number;
  reservationIntents: SchedulerClaimReservationIntentSummary[];
  launchConfirmed?: boolean;
  supersedesReservationId?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerClaimReservationIntentSummary = {
  reservationIntentId: string;
  claimIntentId: string;
  plannedWorkerKey: string;
  nodeId: string;
  unitId: string;
  waveIndex: number;
  status: "reserved" | "blocked";
};
export type SchedulerWorkerStartSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerReconcileSnapshotId: string;
  status: "started" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "coder";
  taskRunId: string;
  workerLeaseId: string;
  worktreeId?: string;
  runId?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerPathStatus =
  | "start-failed"
  | "result-pending"
  | "result-failed"
  | "validation-pending"
  | "validation-failed"
  | "audit-pending"
  | "audit-approved"
  | "audit-blocked"
  | "audit-failed"
  | "rework-plan-pending"
  | "rework-start-pending"
  | "rework-start-failed"
  | "rework-result-pending"
  | "rework-result-failed"
  | "rework-validation-pending"
  | "rework-validation-failed"
  | "rework-audit-pending"
  | "rework-audit-approved"
  | "rework-audit-blocked"
  | "rework-audit-failed";
export type SchedulerWorkerPathSummary = {
  start: SchedulerWorkerStartSummary;
  result?: SchedulerWorkerResultSummary;
  validation?: SchedulerWorkerValidationSummary;
  audit?: SchedulerWorkerAuditSummary;
  reworkPlan?: SchedulerWorkerReworkPlanSummary;
  reworkStart?: SchedulerWorkerReworkStartSummary;
  reworkResult?: SchedulerWorkerReworkResultSummary;
  reworkValidation?: SchedulerWorkerReworkValidationSummary;
  reworkAudit?: SchedulerWorkerReworkAuditSummary;
  status: SchedulerWorkerPathStatus;
  terminal: boolean;
};
export type SchedulerWorkerResultSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  status: "evidence-ready" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "coder";
  taskRunId: string;
  workerLeaseId: string;
  taskRunStatus: string;
  workerLeaseStatus: string;
  worktreeId?: string;
  runId?: string;
  runStatus?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerValidationSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  schedulerWorkerResultId: string;
  status: "passed" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "validation";
  taskRunId: string;
  workerLeaseId: string;
  taskRunStatus: string;
  worktreeId: string;
  codeRunId: string;
  validationRunId: string;
  validationStatus: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerAuditSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  schedulerWorkerResultId: string;
  schedulerWorkerValidationId: string;
  status: "approved" | "approved-with-notes" | "blocked" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "audit";
  taskRunId: string;
  workerLeaseId: string;
  taskRunStatus: string;
  worktreeId: string;
  codeRunId: string;
  validationRunId: string;
  validationStatus: string;
  auditRunId: string;
  auditStatus: "approved" | "approved-with-notes" | "blocked" | "failed";
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerReworkPlanSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  schedulerWorkerResultId: string;
  schedulerWorkerValidationId: string;
  schedulerWorkerAuditId?: string;
  status: "planned";
  blockingSource: "validation-failed" | "audit-blocked" | "audit-failed";
  reworkReason: string;
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "bounded-rework";
  taskRunId: string;
  workerLeaseId: string;
  taskRunStatus: string;
  targetWorktreeId: string;
  targetCodeRunId: string;
  validationRunId: string;
  auditRunId?: string;
  futureCodeGateMode: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerReworkStartSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  schedulerWorkerResultId: string;
  schedulerWorkerValidationId: string;
  schedulerWorkerAuditId?: string;
  schedulerWorkerReworkPlanId: string;
  status: "started" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "bounded-rework";
  originalTaskRunId: string;
  originalWorkerLeaseId: string;
  reworkTaskRunId: string;
  reworkWorkerLeaseId: string;
  worktreeId: string;
  originalCodeRunId: string;
  reworkRunId?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerReworkResultSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  schedulerWorkerResultId: string;
  schedulerWorkerValidationId: string;
  schedulerWorkerAuditId?: string;
  schedulerWorkerReworkPlanId: string;
  schedulerWorkerReworkStartId: string;
  status: "evidence-ready" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "bounded-rework";
  originalTaskRunId: string;
  originalWorkerLeaseId: string;
  originalCodeRunId: string;
  reworkTaskRunId: string;
  reworkWorkerLeaseId: string;
  taskRunStatus: string;
  workerLeaseStatus: string;
  worktreeId: string;
  reworkRunId?: string;
  reworkRunStatus?: string;
  failureReason?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerReworkValidationSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  schedulerWorkerResultId: string;
  schedulerWorkerValidationId: string;
  schedulerWorkerAuditId?: string;
  schedulerWorkerReworkPlanId: string;
  schedulerWorkerReworkStartId: string;
  schedulerWorkerReworkResultId: string;
  status: "passed" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "validation";
  originalTaskRunId: string;
  originalWorkerLeaseId: string;
  originalCodeRunId: string;
  reworkTaskRunId: string;
  reworkWorkerLeaseId: string;
  taskRunStatus: string;
  worktreeId: string;
  reworkRunId: string;
  validationRunId: string;
  validationStatus: "passed" | "failed";
  failureReason?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerWorkerReworkAuditSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerWorkerStartId: string;
  schedulerWorkerResultId: string;
  schedulerWorkerValidationId: string;
  schedulerWorkerAuditId?: string;
  schedulerWorkerReworkPlanId: string;
  schedulerWorkerReworkStartId: string;
  schedulerWorkerReworkResultId: string;
  schedulerWorkerReworkValidationId: string;
  status: "approved" | "approved-with-notes" | "blocked" | "failed";
  reservationIntentId: string;
  claimIntentId: string;
  nodeId: string;
  unitId: string;
  stageId: string;
  stage: "audit";
  originalTaskRunId: string;
  originalWorkerLeaseId: string;
  originalCodeRunId: string;
  reworkTaskRunId: string;
  reworkWorkerLeaseId: string;
  taskRunStatus: string;
  worktreeId: string;
  reworkRunId: string;
  validationRunId: string;
  auditRunId: string;
  auditStatus: "approved" | "approved-with-notes" | "blocked" | "failed";
  failureReason?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerIntegrationCandidateSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerReconcileSnapshotId: string;
  status: "ready" | "waiting" | "blocked";
  readyCount: number;
  blockedCount: number;
  readyWorktreeIds: string[];
  waitingReason?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerIntegrationCheckHandoffSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerReconcileSnapshotId: string;
  schedulerIntegrationCandidateId: string;
  status: "completed";
  integrationCheckId: string;
  integrationCheckStatus: string;
  currentIntegrationCheckStatus?: string;
  readyCount: number;
  readyWorktreeIds: string[];
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerIntegrationOutcomeSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerReconcileSnapshotId: string;
  schedulerIntegrationCandidateId: string;
  schedulerIntegrationCheckHandoffId: string;
  status: "applied" | "discarded" | "blocked";
  integrationCheckId: string;
  integrationCheckStatus: string;
  readyCount: number;
  resultTargetCount: number;
  outcomeReason: string;
  appliedAt?: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerRunCompletionSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerReconcileSnapshotId: string;
  schedulerIntegrationCandidateId: string;
  schedulerIntegrationCheckHandoffId: string;
  schedulerIntegrationOutcomeId: string;
  status: "completed-applied" | "completed-discarded" | "completed-blocked";
  outcomeStatus: "applied" | "discarded" | "blocked";
  integrationCheckId: string;
  integrationCheckStatus: string;
  readyCount: number;
  resultTargetCount: number;
  outcomeReason: string;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerRunBlockedCloseoutSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  schedulerClaimReservationId: string;
  schedulerReconcileSnapshotId: string;
  schedulerIntegrationCandidateId: string;
  schedulerContractId: string;
  schedulerDispatchDryRunId: string;
  schedulerWorkerPlanId: string;
  schedulerClaimReconcilePlanId: string;
  schedulerLaunchPreflightId: string;
  status: "blocked" | "exhausted" | "stopped";
  reason: "candidate-waiting-exhausted" | "candidate-blocked" | "candidate-inconsistent" | "user-stopped";
  closeoutReason: string;
  readyCount: number;
  blockedCount: number;
  readyWorktreeIds: string[];
  blockedReasons: string[];
  unstartedReservedIntentIds: string[];
  sourceMutated: boolean;
  executionStarted: boolean;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type SchedulerReconcileSnapshotSummary = {
  id: string;
  changeId: string;
  schedulerRunId: string;
  status: "generated" | "blocked";
  schedulerMode: "parallel-readiness-v1";
  claimIntentCount: number;
  waveCount: number;
  plannedSlotDemand: number;
  maxPlannedWaveWidth: number;
  blockedCount: number;
  warningCount: number;
  artifact?: string;
  markdownArtifact?: string;
  updatedAt: string;
};
export type ThreadEvent = { id: string; type: string; label: string; timestamp?: string; status?: string; runId?: string };
export type ThreadStreamAction = {
  actionType: WorkbenchThreadActionType;
  label: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
  workflowGraphPlanId?: string;
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
  taskIds?: string[];
  taskRunId?: string;
  worktreeId?: string;
  worktreeIds?: string[];
  applyCheckId?: string;
  landingPackageId?: string;
  remoteLandingResultId?: string;
  validationRunId?: string;
  reworkValidationRunId?: string;
  auditRunId?: string;
  reworkAuditRunId?: string;
};
export type ThreadStreamItem = {
  id: string;
  kind: "user-message" | "assistant-turn" | "assistant-message" | "workflow-summary" | "evidence" | "decision" | "change-state" | "intake-summary" | "clarification";
  label: string;
  timestamp?: string;
  body?: string;
  source: string;
  artifact?: string;
  status?: string;
    graphScopeId?: string;
    providerId?: ProviderId;
    attemptId?: string;
    runId?: string;
  threadId?: string;
  parentThreadId?: string;
    turnId?: string;
    itemId?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  actionType?: string;
  actionRunId?: string;
  actions?: ThreadStreamAction[];
  activity?: LiveTurnEvent[];
  evidence?: ThreadStreamEvidence[];
  blocks?: AssistantTurnBlock[];
  intake?: {
    scan?: { runId: string; candidateFiles?: string[]; scripts?: Array<{ name: string; command: string }>; missingInfo?: string[] };
    iteration?: { currentUnderstanding: string; confirmedConstraints: string[]; openQuestions: string[]; assumptions: string[] };
  };
  clarification?: ClarificationRequest;
  interactionHistory?: InteractionHistoryRecord;
  contextRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
};
export type ClarificationRequest = {
  id: string;
  status: "pending" | "answered" | "skipped" | "expired";
  source: "aho";
  stage: "intake" | "spec" | "plan" | "run";
  questions: Array<{ id: string; header?: string; question: string; options?: Array<{ label: string; description?: string }>; allowFreeform: boolean }>;
  answers?: Array<{ questionId: string; answer: string }>;
};
export type ThreadStreamEvidence = {
  id: string;
  label: string;
  source: "workflow" | "validation" | "audit" | "decision";
  timestamp?: string;
  body?: string;
  artifact?: string;
  status?: string;
  runId?: string;
  actionType?: string;
  actionRunId?: string;
};
export type RunSummary = { id: string; runtime: string; status: string; startedAt?: string; finishedAt?: string };
export type Approval = {
  id: string;
  kind: string;
  label: string;
  severity: string;
  changeId?: string;
  reason?: string;
  action?: { actionId: string; label: string; command: string; args: string[]; mutates: boolean; requiresConfirmation: boolean };
};
export type DecisionAction = {
  id: string;
  label: string;
  kind: DecisionActionKind;
  enabled: boolean;
  requiresConfirmation: boolean;
  changeId?: string;
  approvalId?: string;
  action?: { actionId: string; label: string; command: string; args: string[]; mutates: boolean; requiresConfirmation: boolean };
  options?: {
    commit?: boolean;
    message?: string;
  };
  actionType?: ThreadStreamAction["actionType"];
  workflowGraphPlanId?: string;
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
  reservationIntentId?: string;
  claimIntentId?: string;
  workflowRunId?: string;
  queueRunId?: string;
  taskIds?: string[];
  taskRunId?: string;
  worktreeId?: string;
  worktreeIds?: string[];
  applyCheckId?: string;
  landingPackageId?: string;
  remoteLandingResultId?: string;
  validationRunId?: string;
  auditRunId?: string;
  artifact?: string;
  disabledReason?: string;
};
export type DecisionContext = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  userStatus?: WorkpadUserStatus;
  resultSummary?: string;
  recommendation?: string;
  explanation?: string;
  severity: "info" | "warning" | "blocking";
  changeId?: string;
  taskId?: string;
  taskRunId?: string;
  queueRunId?: string;
  runId?: string;
  targetId?: string;
  artifact?: string;
  evidenceRefs?: string[];
  timestamp?: string;
  actions: DecisionAction[];
  rework?: { mode: "inline-feedback" | "record-feedback"; label: string; placeholder: string };
};
export type DecisionInspector = {
  primary: DecisionContext | null;
  related: DecisionContext[];
  history: DecisionContext[];
  selectedContextId?: string;
};
export type ConfirmationQueueItem = {
  id: string;
  kind: string;
  projectId?: string | null;
  conversationId?: string;
  changeId?: string;
  resultId?: string;
  runId?: string;
  worktreeId?: string;
  applyCheckId?: string;
  landingPackageId?: string;
  schedulerRunId?: string;
  schedulerReconcileSnapshotId?: string;
  schedulerClaimReservationId?: string;
  schedulerWorkerStartId?: string;
  schedulerWorkerResultId?: string;
  schedulerWorkerValidationId?: string;
  schedulerWorkerAuditId?: string;
  schedulerWorkerReworkPlanId?: string;
  schedulerWorkerReworkStartId?: string;
  reservationIntentId?: string;
  claimIntentId?: string;
  taskRunId?: string;
  workerLeaseId?: string;
  validationRunId?: string;
  auditRunId?: string;
  summary: string;
  whyNeedsConfirmation: string;
  confirmEffect: string;
  riskSummary: string;
  evidenceRefs: string[];
  actions: DecisionAction[];
  primary: boolean;
  status?: string;
};
export type ConfirmationQueue = {
  primary: ConfirmationQueueItem | null;
  current: ConfirmationQueueItem[];
  otherDemands: ConfirmationQueueItem[];
  maintenance: ConfirmationQueueItem[];
  history: ConfirmationQueueItem[];
};
export type Decision = {
  id: string;
  kind: string;
  label: string;
  status: string;
  changeId?: string;
  runId?: string;
  targetId?: string;
  artifact?: string;
  summary: string;
  feedback?: string;
  updatedAt: string;
  completedAt?: string;
};
export type StreamPacket = {
  run: RunSummary;
  live: boolean;
  events: ThreadEvent[];
  artifacts: Array<{ key: string; path: string; kind: string; exists: boolean; preview?: string; tail?: string; truncated?: boolean; diagnostic?: string }>;
  diagnostics: string[];
};
export type FolderDialogResult = { path: string | null; canceled: boolean; supported: boolean; error?: string };
export type CanonicalTimelineScope = {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  agentSurfaceId: string;
};
export type CanonicalTimelineEnvelope = {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  graphScopeId?: string;
  agentSurfaceId: string;
  messageId: string;
  clientRequestId?: string;
  position: number;
  revision: number;
  orderClass: "sequence" | "thread-start";
  cells: ParentAgentTranscriptCell[];
};
export type CanonicalTimelinePage = {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  agentSurfaceId: string;
  watermark: number;
  pinned: CanonicalTimelineEnvelope[];
  entries: CanonicalTimelineEnvelope[];
  paging: {
    limit: number;
    totalCount: number;
    hasMoreBefore: boolean;
    nextBeforeCursor?: string;
  };
};
export type WorkbenchLiveEvent =
  | { event: "topic.created"; data: { projectId: string; productMode: ProductMode; conversationId: string; clientRequestId: string; replayed: boolean; topic: { id?: string; conversationId?: string; changeId?: string; title: string; state: "active" | "archive"; selectedProviderId?: string; productMode: ProductMode; agentTurnMode?: AgentTurnMode | null; agentModelId?: string | null; agentReasoningEffort?: string | null } } }
  | { event: "topic.updated"; data: { conversation: Topic } }
  | { event: "timeline.patch"; data: CanonicalTimelineEnvelope }
  | { event: "conversation.interactions.updated"; data: ConversationInteractionQueue }
  | { event: "agent-surfaces.invalidated"; data: AgentSurfacesInvalidated }
  | { event: "conversation.turn-control.invalidated"; data: { conversationId: string; attemptId: string } }
  | { event: "conversation.context.invalidated"; data: { conversationId: string } }
  | { event: "conversation.turn-queue.invalidated"; data: { conversationId: string } }
  | { event: "conversation.lifecycle.invalidated"; data: { conversationId: string } }
  | { event: "conversation.review.invalidated"; data: { conversationId: string } }
  | { event: "conversation.fork.completed"; data: { sourceConversationId: string; targetConversationId: string } }
  | { event: "run.started"; data: WorkbenchLiveIdentity & { runId: string; actionType?: string; runtime?: string; taskIds?: string[] } }
  | { event: "run.status"; data: WorkbenchLiveIdentity & { actionRunId?: string; status: string; label?: string } }
  | { event: "assistant.delta"; data: WorkbenchLiveIdentity & { delta: string } }
  | { event: "assistant.event"; data: AssistantReadableEvent }
  | { event: "tool.event"; data: WorkbenchLiveToolEvent }
  | { event: "usage"; data: WorkbenchLiveIdentity & { usage?: Record<string, unknown> } }
  | { event: "snapshot"; data: Snapshot }
  | { event: "error"; data: WorkbenchLiveIdentity & { message: string; runId?: string; actionRunId?: string } }
  | { event: "done"; data: Pick<WorkbenchLiveIdentity, "projectId" | "productMode" | "conversationId"> & { status: "completed" | "failed" } };
export type WorkbenchLiveToolEvent = {
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
};
export type AssistantReadableEvent = {
  runId: string;
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
  kind: "status" | "reasoning-summary" | "command" | "file-change" | "mcp-tool" | "web-search" | "plan-update" | "tool-result" | "usage" | "error";
  phase?: string;
  status?: "processing" | "completed" | "failed";
  title?: string;
  summary?: string;
  preview?: string;
  artifactRef?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  isError?: boolean;
  truncated?: boolean;
  timestamp?: string;
};
export type AssistantTurnBlock = {
  id: string;
  providerId?: ProviderId;
  attemptId?: string;
  runId?: string;
  threadId?: string;
  turnId?: string;
  sequence: number;
  kind: "prose" | "status" | "command-group" | "command" | "tool-result" | "file-change" | "reasoning-summary" | "workflow-evidence" | "usage" | "error";
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
};
export type LiveTurnEvent =
  | { kind: "status"; label: string; detail?: string }
  | { kind: "assistant-event"; event: AssistantReadableEvent }
  | { kind: "tool"; tool: WorkbenchLiveToolEvent }
  | { kind: "usage"; usage: Record<string, unknown> }
  | { kind: "error"; message: string };
export type LiveAssistantTurn = {
  id: string;
  runId: string;
  providerId?: ProviderId;
  attemptId?: string;
  sessionId?: string;
  projectId?: string;
  conversationId?: string;
  graphScopeId?: string;
  changeId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  agentSurfaceId?: string;
  agentDisplayName?: string;
  targetAgentSurfaceId?: string;
  targetAgentDisplayName?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  runtime?: string;
  actionType?: string;
  status: string;
  text: string;
  events: LiveTurnEvent[];
  blocks: AssistantTurnBlock[];
  startedAt: string;
  endedAt?: string;
};

export type WorkbenchLiveIdentity = {
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
};
export type TopicMessageEntry = {
  id: string;
  type: "user.message" | "assistant.message" | "orchestrator.plan" | "workflow.started" | "workflow.completed" | "workflow.failed" | "intake.scan" | "intake.iteration" | "clarification.request" | "clarification.answer" | "clarification.skip";
  timestamp?: string;
  graphScopeId?: string;
  changeId: string;
  text?: string;
  actionRunId?: string;
  actionType?: string;
  status?: string;
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
  artifact?: string;
  error?: string;
  resultSummary?: string;
  activity?: LiveTurnEvent[];
  blocks?: AssistantTurnBlock[];
  intake?: ThreadStreamItem["intake"];
  clarification?: ClarificationRequest;
  interactionHistory?: InteractionHistoryRecord;
  contextRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
};
