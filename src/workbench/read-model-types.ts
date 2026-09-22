import type { AssistantTurnActivity, AssistantTurnBlock, ConversationRetryTargetEvidence } from "./types.js";
import type { ClarificationRequest, WorkbenchIntakeIteration, WorkbenchIntakeScan } from "./intake.js";
import type { TopicAttachment, TopicFileReference } from "./types.js";
import type { ConversationInteractionQueue, InteractionHistoryRecord } from "./conversation-interaction-contract.js";
import type { WorkbenchArtifactPreview } from "./artifact-types.js";
import type { WorkbenchThreadActionType } from "../workflow-actions/registry.js";
import type {
  AcMap,
  ChangeMetadata,
  ManagedProject,
  RunMetadata,
  TaskQueueItem,
  TaskQueueRun,
  TaskRun,
  WorkerLease,
  WorkflowRunSummary,
} from "../types/index.js";
import type { ApplyReadinessKind } from "../apply/manager.js";
import type { HighImpactApprovalScope } from "../workflow-actions/high-impact-approval.js";
import type { AgentTurnMode, ProductMode, ProviderId } from "../provider-runtime/index.js";
import type { StoredProviderAttempt } from "./persistence/contracts.js";
import type {
  WorkbenchSchedulerClaimReconcilePlanSummary,
  WorkbenchSchedulerContractSummary,
  WorkbenchSchedulerDispatchDryRunSummary,
  WorkbenchSchedulerLaunchPreflightSummary,
  WorkbenchSchedulerClaimReservationSummary,
  WorkbenchSchedulerIntegrationCheckHandoffSummary,
  WorkbenchSchedulerIntegrationCandidateSummary,
  WorkbenchSchedulerIntegrationOutcomeSummary,
  WorkbenchSchedulerRunCompletionSummary,
  WorkbenchSchedulerRunBlockedCloseoutSummary,
  WorkbenchSchedulerReconcileSnapshotSummary,
  WorkbenchSchedulerRunSummary,
  WorkbenchSchedulerRuntimeSummary,
  WorkbenchSchedulerWorkerAuditSummary,
  WorkbenchSchedulerWorkerReworkPlanSummary,
  WorkbenchSchedulerWorkerReworkAuditSummary,
  WorkbenchSchedulerWorkerReworkResultSummary,
  WorkbenchSchedulerWorkerReworkValidationSummary,
  WorkbenchSchedulerWorkerReworkStartSummary,
  WorkbenchSchedulerWorkerResultSummary,
  WorkbenchSchedulerWorkerStartSummary,
  WorkbenchSchedulerWorkerPathSummary,
  WorkbenchSchedulerWorkerValidationSummary,
  WorkbenchSchedulerWorkerSessionPlanSummary,
  WorkbenchWorkflowGraphPlanSummary,
} from "./workflow-projection.js";
export type WorkbenchTopicState = "active" | "archive";
export type WorkbenchApprovalKind =
  | "spec-proposal"
  | "plan-proposal"
  | "spec-test-proposal"
  | "audit-proposal"
  | "worktree-apply"
  | "evolution"
  | "attention";
export type HarnessGapStatus = "missing" | "partial" | "available";
export type HarnessGapSeverity = "info" | "warning";

export interface WorkbenchProjectInput {
  project: ManagedProject | null;
  path: string;
  runtimeStateResolver?: (project: ManagedProject) => Promise<import("../project-runtime/coordinator.js").ProjectRuntimeState>;
  turnControlStateResolver?: (projectId: string, conversationId: string, attemptId?: string) => import("./conversation-turn-control.js").ConversationTurnControlState;
  activeProviderTurnResolver?: (conversationId: string) => boolean;
  conversationContextSnapshotResolver?: (project: ManagedProject, productMode: ProductMode, conversationId: string) => Promise<import("./conversation-context-lifecycle.js").ConversationContextSnapshot>;
  conversationLifecycleSnapshotResolver?: (project: ManagedProject, productMode: ProductMode, conversationId: string) => Promise<import("./conversation-lifecycle.js").ConversationLifecycleSnapshot>;
  conversationLifecycleSnapshotsResolver?: (project: ManagedProject, productMode: ProductMode) => Promise<import("./conversation-lifecycle.js").ConversationLifecycleSnapshot[]>;
}

export interface WorkbenchProjectHarnessStatus {
  kind: "project-skill";
  registered: true;
  managed: true;
  harnessReady: true;
  projectId: string;
  skillName: string;
  skillRevision: number;
  contentFingerprint: string;
  runtimeAvailable: true;
}

export interface WorkbenchProjectHarnessDiagnosticStatus {
  kind: "project-skill";
  registered: boolean;
  managed: boolean;
  harnessReady: false;
  runtimeAvailable: boolean;
  projectId?: string;
  state: "unregistered" | "onboarding" | "repair-required";
  reason: string;
}

export type WorkbenchRuntimeStatus = WorkbenchProjectHarnessStatus | WorkbenchProjectHarnessDiagnosticStatus;

export interface WorkbenchTopicSummary {
  id: string;
  productMode: ProductMode;
  agentTurnMode?: AgentTurnMode | null;
  agentModelId?: string | null;
  agentReasoningEffort?: string | null;
  kind?: "conversation" | "change";
  name: string;
  title: string;
  state: WorkbenchTopicState;
  path: string;
  boundChangeId?: string | null;
  graphScopeId?: string;
  selectedProviderId?: string;
  completedTurnSequence?: number;
  timelineRevision?: number;
  forkBoundary?: import("./types.js").ConversationForkBoundaryEvidence;
  lifecycle?: import("./conversation-lifecycle.js").ConversationLifecycleSnapshot;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  archivePath?: string | null;
}

export type ProviderAttemptReadModel = Pick<StoredProviderAttempt,
  | "projectId"
  | "conversationId"
  | "attemptId"
  | "productMode"
  | "graphScopeId"
  | "providerId"
  | "roleId"
  | "operationProfile"
  | "nativeSessionId"
  | "model"
  | "effectiveSkillInputs"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

export type WorkbenchWorkpadRuntimeStatus = "active" | "running" | "queued" | "blocked" | "waiting-decision" | "archived" | "readonly";
export type WorkbenchUserDecisionState = "processing" | "waiting-confirmation" | "needs-rework" | "later" | "completed" | "abandoned";
export type WorkbenchConversationLifecycle = "active" | "running" | "waiting-user" | "archived-readonly" | "abandoned";

export interface WorkbenchWorkpadSummary {
  id: string;
  title: string;
  state: WorkbenchTopicState;
  runtimeStatus: WorkbenchWorkpadRuntimeStatus;
  userStatus: WorkbenchUserDecisionState;
  userStatusLabel: string;
  conversationLifecycle: WorkbenchConversationLifecycle;
  linkedFromChangeId?: string;
  selected: boolean;
  waitingDecisionCount: number;
  latestRunStatus?: string;
  latestRunId?: string;
  queueStatus?: string;
  blocker?: string;
  updatedAt?: string;
}

export interface WorkbenchThreadEvent {
  id: string;
  type: string;
  label: string;
  timestamp?: string;
  source: "change" | "run" | "proposal" | "validation" | "audit" | "worktree" | "spec-test" | "evolution" | "chat" | "workflow";
  artifact?: string;
  status?: string;
  runId?: string;
}

export interface ThreadStreamAction {
  actionType: WorkbenchThreadActionType;
  label: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
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
  taskIds?: string[];
  taskRunId?: string;
  workerLeaseId?: string;
  runId?: string;
  validationRunId?: string;
  reworkValidationRunId?: string;
  auditRunId?: string;
  reworkAuditRunId?: string;
}

export interface ThreadStreamEvidence {
  id: string;
  label: string;
  source: "workflow" | "validation" | "audit" | "decision";
  timestamp?: string;
  body?: string;
  artifact?: string;
  status?: string;
  graphScopeId?: string;
  runId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  actionRunId?: string;
  actionType?: string;
}

export interface ThreadStreamItem {
  id: string;
  kind: "user-message" | "assistant-turn" | "assistant-message" | "workflow-summary" | "evidence" | "decision" | "change-state" | "intake-summary" | "clarification";
  label: string;
  timestamp?: string;
  body?: string;
  source: "change" | "chat" | "workflow" | "validation" | "audit" | "decision" | "intake";
  artifact?: string;
  status?: string;
  graphScopeId?: string;
  providerId?: string;
  attemptId?: string;
  runId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  itemId?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  initialThreadInput?: boolean;
  actionRunId?: string;
  actionType?: string;
  actions?: ThreadStreamAction[];
  activity?: AssistantTurnActivity[];
  evidence?: ThreadStreamEvidence[];
  blocks?: AssistantTurnBlock[];
  intake?: {
    scan?: WorkbenchIntakeScan;
    iteration?: WorkbenchIntakeIteration;
  };
  clarification?: ClarificationRequest;
  providerUserInput?: import("./types.js").WorkbenchProviderUserInputRequest;
  interactionHistory?: InteractionHistoryRecord;
  contextRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
  retryTarget?: ConversationRetryTargetEvidence;
  forkTarget?: import("./types.js").ConversationForkTargetEvidence;
}

export interface WorkbenchApprovalItem {
  id: string;
  kind: WorkbenchApprovalKind;
  label: string;
  changeId?: string;
  runId?: string;
  targetId?: string;
  severity: "info" | "warning" | "blocking";
  action?: WorkbenchApprovalAction;
  artifact?: string;
  reason?: string;
}

export interface WorkbenchDecisionItem {
  id: string;
  kind: string;
  label: string;
  status: "pending" | "accepted" | "requested-changes" | "dismissed" | "completed" | "failed";
  changeId?: string;
  runId?: string;
  targetId?: string;
  artifact?: string;
  summary: string;
  feedback?: string;
  updatedAt: string;
  completedAt?: string;
}

export type WorkbenchDecisionContextKind =
  | "queue-blocker"
  | "task-blocker"
  | "validation-failed"
  | "audit-blocked"
  | "spec-proposal"
  | "plan-proposal"
  | "audit-approved"
  | "apply-gate"
  | "workflow-gate"
  | "evolution-pending"
  | "history";

export interface WorkbenchDecisionAction {
  id: string;
  label: string;
  kind: "approval" | "workflow-action" | "feedback" | "evidence" | "abandon" | "none";
  enabled: boolean;
  requiresConfirmation: boolean;
  changeId?: string;
  graphScopeId?: string;
  approvalId?: string;
  action?: WorkbenchApprovalAction;
  options?: {
    commit?: boolean;
    message?: string;
  };
  actionType?: ThreadStreamAction["actionType"];
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
  taskIds?: string[];
  taskRunId?: string;
  workerLeaseId?: string;
  runId?: string;
  validationRunId?: string;
  reworkValidationRunId?: string;
  auditRunId?: string;
  reworkAuditRunId?: string;
  worktreeId?: string;
  worktreeIds?: string[];
  applyCheckId?: string;
  landingPackageId?: string;
  remoteLandingResultId?: string;
  artifact?: string;
  disabledReason?: string;
}

export interface WorkbenchReworkPrompt {
  mode: "inline-feedback" | "record-feedback";
  label: string;
  placeholder: string;
}

export interface WorkbenchDecisionContext {
  id: string;
  kind: WorkbenchDecisionContextKind;
  title: string;
  summary: string;
  userStatus?: WorkbenchUserDecisionState;
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
  actions: WorkbenchDecisionAction[];
  rework?: WorkbenchReworkPrompt;
}

export interface WorkbenchDecisionInspector {
  primary: WorkbenchDecisionContext | null;
  related: WorkbenchDecisionContext[];
  history: WorkbenchDecisionContext[];
  selectedContextId?: string;
}

export type WorkbenchConfirmationQueueItemKind =
  | "change-finalization"
  | "planning-confirm"
  | "single-result-apply"
  | "integration-check"
  | "integration-apply"
  | "landing-readiness"
  | "landing-queue"
  | "pr-draft"
  | "pr-review"
  | "remote-landing"
  | "post-merge"
  | "request-changes"
  | "discard-result"
  | "maintenance";

export interface WorkbenchConfirmationQueueItem {
  id: string;
  kind: WorkbenchConfirmationQueueItemKind;
  projectId?: string | null;
  conversationId?: string;
  changeId?: string;
  graphScopeId?: string;
  finalizationRequestId?: string;
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
  taskRunId?: string;
  workerLeaseId?: string;
  validationRunId?: string;
  reworkValidationRunId?: string;
  auditRunId?: string;
  reworkAuditRunId?: string;
  summary: string;
  whyNeedsConfirmation: string;
  confirmEffect: string;
  riskSummary: string;
  evidenceRefs: string[];
  actions: WorkbenchDecisionAction[];
  primary: boolean;
  status?: "pending" | "passed" | "failed" | "applied" | "discarded";
}

export interface WorkbenchConfirmationQueue {
  primary: WorkbenchConfirmationQueueItem | null;
  current: WorkbenchConfirmationQueueItem[];
  otherDemands: WorkbenchConfirmationQueueItem[];
  maintenance: WorkbenchConfirmationQueueItem[];
  history: WorkbenchConfirmationQueueItem[];
}

export interface WorkpadIntakeSummary {
  goal: string;
  currentUnderstanding: string;
  source: "project" | "topic" | "thread" | "diagnostic";
  relatedArtifacts: string[];
  missingInfo: string[];
  confirmedConstraints: string[];
  openQuestions: string[];
  assumptions: string[];
  pendingClarifications: ClarificationRequest[];
}

export interface WorkpadProgress {
  topicState: WorkbenchTopicState | "none";
  spec: "missing" | "ready" | "unknown";
  plan: "missing" | "ready" | "unknown";
  tasks: "missing" | "ready" | "unknown";
  acCount: number;
  taskCount: number;
  runCount: number;
  latestRunStatus?: string;
  validationStatus?: string;
  auditStatus?: string;
}

export interface WorkpadEvidenceSummary {
  id: string;
  label: string;
  source: "run" | "validation" | "audit" | "decision" | "approval";
  status?: string;
  artifact?: string;
  timestamp?: string;
}

export interface WorkpadNextAction {
  id: string;
  label: string;
  description: string;
  kind: "workflow-action" | "approval" | "read-only" | "none";
  enabled: boolean;
  requiresConfirmation: boolean;
  actionType?: ThreadStreamAction["actionType"];
  changeId?: string;
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
  worktreeId?: string;
  worktreeIds?: string[];
  applyCheckId?: string;
  landingPackageId?: string;
  remoteLandingResultId?: string;
  validationRunId?: string;
  reworkValidationRunId?: string;
  auditRunId?: string;
  reworkAuditRunId?: string;
  disabledReason?: string;
}

export interface WorkpadBackgroundActivitySummary {
  totalCount: number;
  runningCount: number;
  queuedCount: number;
  blockedCount: number;
  waitingDecisionCount: number;
  items: WorkbenchWorkpadSummary[];
}

export interface WorkpadRelatedMemorySummary {
  changeId: string;
  title: string;
  status: WorkbenchWorkpadRuntimeStatus;
  factBoundary: "summary-only" | "local-evidence-only";
}

export interface WorkpadMemoryIsolationSummary {
  projectStableNamespace: "project/stable";
  currentChangeNamespace?: string;
  runNamespaces: string[];
  providerSessionNamespace: "agent/{roleId}/session/{sessionId}";
  relatedWorkpads: WorkpadRelatedMemorySummary[];
  stableFactSources: string[];
  writeBoundaries: string[];
  warnings: string[];
}

export interface WorkpadTaskPreview {
  id: string;
  title: string;
  done: boolean;
  acIds: string[];
  warnings: string[];
}

export type WorkbenchTaskNodeStatus = "planned" | "running" | "evidence-ready" | "blocked" | "checked";

export interface WorkbenchTaskEvidence {
  id: string;
  label: string;
  source: "run" | "validation" | "audit";
  status?: string;
  runId?: string;
  worktreeId?: string;
  artifact?: string;
  timestamp?: string;
}

export interface WorkbenchTaskNextAction {
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
  reservationIntentId?: string;
  claimIntentId?: string;
  workflowRunId?: string;
  queueRunId?: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
}

export interface WorkbenchTaskRunSummary {
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
}

export interface WorkbenchWorkerLeaseSummary {
  id: string;
  status: string;
  workerId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface WorkbenchTaskNode {
  taskId: string;
  title: string;
  acIds: string[];
  checked: boolean;
  status: WorkbenchTaskNodeStatus;
  taskRun?: WorkbenchTaskRunSummary;
  workerLease?: WorkbenchWorkerLeaseSummary;
  latestEvidence: WorkbenchTaskEvidence[];
  blockers: string[];
  nextAction: WorkbenchTaskNextAction;
  autoRework?: WorkbenchAutoReworkSummary;
}

export interface WorkbenchAutoReworkSummary {
  available: boolean;
  attempt: number;
  budget: number;
  reason: string;
  failureClassification: WorkbenchFailureClassification;
}

export type WorkbenchFailureClassification =
  | "code-test-failure"
  | "audit-semantic-failure"
  | "ambiguous-requirement"
  | "environment-failure"
  | "unknown";

export interface WorkbenchTaskGraph {
  source: "accepted-tasks" | "missing";
  nodes: WorkbenchTaskNode[];
  changeLevelEvidence: WorkbenchTaskEvidence[];
  warnings: string[];
}

export type WorkbenchCodingPackageAssignmentStatus = "suggested" | "not-assigned";
export type WorkbenchCodingPackageStatus = "missing" | "suggested" | "blocked" | "evidence-ready" | "readonly";

export interface WorkbenchCodingPackage {
  id: string;
  title: string;
  summary: string;
  taskIds: string[];
  completedTaskIds: string[];
  acIds: string[];
  coveredAcIds: string[];
  missingEvidenceAcIds: string[];
  recommendedRoleId: string;
  assignmentStatus: WorkbenchCodingPackageAssignmentStatus;
  status: WorkbenchCodingPackageStatus;
}

export interface WorkbenchTaskQueueItemSummary {
  id: string;
  taskId: string;
  order: number;
  status: string;
  taskRunId?: string;
  blockedReason?: string;
  failureReason?: string;
}

export interface WorkbenchTaskQueueSummary {
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
  items: WorkbenchTaskQueueItemSummary[];
}

export interface WorkbenchWorkpad {
  title: string;
  subtitle: string;
  state: "diagnostic" | "empty" | "active" | "readonly";
  userStatus: WorkbenchUserDecisionState;
  userStatusLabel: string;
  conversationId?: string;
  demandId?: string;
  boundChangeId?: string;
  conversationLifecycle: WorkbenchConversationLifecycle;
  linkedFromChangeId?: string;
  pendingFeedback: WorkbenchPendingFeedback[];
  coderSelfTestSummary?: string;
  officialValidationResult?: string;
  officialAuditResult?: string;
  officialReworkAttempt?: number;
  reworkBudget?: number;
  failureClassification?: WorkbenchFailureClassification;
  requiresUserInputReason?: string;
  scopedFeedbackTarget?: WorkbenchScopedFeedbackTarget;
  workflowGraphPlan?: WorkbenchWorkflowGraphPlanSummary;
  schedulerContract?: WorkbenchSchedulerContractSummary;
  schedulerDispatchDryRun?: WorkbenchSchedulerDispatchDryRunSummary;
  schedulerWorkerSessionPlan?: WorkbenchSchedulerWorkerSessionPlanSummary;
  schedulerClaimReconcilePlan?: WorkbenchSchedulerClaimReconcilePlanSummary;
  schedulerLaunchPreflight?: WorkbenchSchedulerLaunchPreflightSummary;
  schedulerRun?: WorkbenchSchedulerRunSummary;
  schedulerRuntime?: WorkbenchSchedulerRuntimeSummary;
  schedulerReconcileSnapshot?: WorkbenchSchedulerReconcileSnapshotSummary;
  schedulerClaimReservation?: WorkbenchSchedulerClaimReservationSummary;
  schedulerWorkerStart?: WorkbenchSchedulerWorkerStartSummary;
  schedulerWorkerResult?: WorkbenchSchedulerWorkerResultSummary;
  schedulerWorkerValidation?: WorkbenchSchedulerWorkerValidationSummary;
  schedulerWorkerAudit?: WorkbenchSchedulerWorkerAuditSummary;
  schedulerWorkerReworkPlan?: WorkbenchSchedulerWorkerReworkPlanSummary;
  schedulerWorkerReworkStart?: WorkbenchSchedulerWorkerReworkStartSummary;
  schedulerWorkerReworkResult?: WorkbenchSchedulerWorkerReworkResultSummary;
  schedulerWorkerReworkValidation?: WorkbenchSchedulerWorkerReworkValidationSummary;
  schedulerWorkerReworkAudit?: WorkbenchSchedulerWorkerReworkAuditSummary;
  schedulerWorkerPaths?: WorkbenchSchedulerWorkerPathSummary[];
  schedulerIntegrationCandidate?: WorkbenchSchedulerIntegrationCandidateSummary;
  schedulerIntegrationCheckHandoff?: WorkbenchSchedulerIntegrationCheckHandoffSummary;
  schedulerIntegrationOutcome?: WorkbenchSchedulerIntegrationOutcomeSummary;
  schedulerRunCompletion?: WorkbenchSchedulerRunCompletionSummary;
  schedulerRunBlockedCloseout?: WorkbenchSchedulerRunBlockedCloseoutSummary;
  workflowRun?: WorkflowRunSummary;
  mainAgentExecution?: WorkbenchMainAgentExecutionSummary;
  resultReview?: WorkbenchResultReview;
  runControlState?: WorkbenchRunControlState;
  intake: WorkpadIntakeSummary;
  progress: WorkpadProgress;
  tasks: WorkpadTaskPreview[];
  codingPackages: WorkbenchCodingPackage[];
  taskGraph: WorkbenchTaskGraph;
  taskQueue?: WorkbenchTaskQueueSummary;
  evidence: WorkpadEvidenceSummary[];
  blockers: string[];
  warnings: string[];
  nextAction: WorkpadNextAction;
  background: WorkpadBackgroundActivitySummary;
  memoryIsolation: WorkpadMemoryIsolationSummary;
}

export interface WorkbenchRoleRunSummary {
  roleId: "planning-agent" | "coder-agent" | "validator" | "auditor-agent" | "rework-coder" | string;
  status: string;
  runId?: string;
  summary: string;
  artifact?: string;
}

export interface WorkbenchAgentTaskSummary {
  id: string;
  conversationId: string;
  roleId: string;
  kind: "foreground" | "background";
  status: string;
  changeId?: string;
  runId?: string;
  summary: string;
  resultSummary?: string;
  evidenceRefs: string[];
  policyAuditRefs: string[];
  boundaryAuditRefs: string[];
  boundaryViolations: string[];
  createdAt: string;
  completedAt?: string;
}

export interface WorkbenchRolePipelineSummary {
  stage: "planning" | "coding" | "validation" | "audit" | "rework" | "done" | "needs-user-input";
  status: "draft" | "running" | "completed" | "needs-user-input" | "stopped";
  runs: WorkbenchRoleRunSummary[];
  agentTasks: WorkbenchAgentTaskSummary[];
  reworkUsed: number;
  reworkBudget: number;
}

export type WorkbenchMainAgentExecutionSummary = WorkbenchRolePipelineSummary;

export interface AgentEvidenceRef {
  label: string;
  ref: string;
  kind: "artifact" | "run" | "task" | "decision" | "remote" | "maintenance";
}

export type WorkbenchResultReviewStatus =
  | "not-ready"
  | "ready-to-apply"
  | "needs-rework"
  | "applied-clean"
  | "applied-source-dirty";

export interface WorkbenchResultReview {
  status: WorkbenchResultReviewStatus;
  title: string;
  summary: string;
  worktreeId?: string;
  changedFiles: string[];
  diffStat?: string;
  validation?: {
    id: string;
    status: string;
    runId: string;
  };
  audit?: {
    id: string;
    status: string;
    runId: string;
    findingCount: number;
    notes: string[];
    artifact?: string;
  };
  applyReadiness: {
    ready: boolean;
    kind: ApplyReadinessKind;
    label: string;
    message: string;
    blockingIssues: string[];
    warnings: string[];
  };
  evidence: WorkpadEvidenceSummary[];
}

export interface WorkbenchRunControlState {
  state?: "idle" | "running" | "stopping";
  canStop: boolean;
  canSteer?: boolean;
  steerState?: "idle" | "submitting";
  providerId?: ProviderId;
  attemptId?: string;
  runId?: string;
  stopActionType?: ThreadStreamAction["actionType"];
  pendingFeedbackCount: number;
  explanation: string;
}

export interface WorkbenchPendingFeedback {
  id: string;
  text: string;
  timestamp: string;
  runId?: string;
  status: "pending-next-turn" | "applied";
}

export interface WorkbenchScopedFeedbackTarget {
  changeId: string;
  taskId?: string;
  taskRunId?: string;
  runId?: string;
  roleId?: string;
  evidenceRef?: string;
}

export interface WorkbenchApprovalAction {
  actionId: string;
  label: string;
  command: string;
  args: string[];
  mutates: boolean;
  requiresConfirmation: boolean;
  scope?: HighImpactApprovalScope;
}

export interface WorkbenchStreamPacket {
  run: RunMetadata;
  live: false;
  events: WorkbenchThreadEvent[];
  artifacts: WorkbenchArtifactPreview[];
  diagnostics: string[];
  warnings: string[];
}

export interface WorkbenchRoleSummary {
  id: string;
  name: string;
  profilePath: string;
  writeCapability: "read-only" | "proposal-write" | "worktree-write" | "canonical-doc-write" | "deterministic-writer";
  preferredRuntime: string;
  delegatable: boolean;
  humanConfirmation: string;
  sections: string[];
}

export interface HarnessGap {
  id: string;
  severity: HarnessGapSeverity;
  status: HarnessGapStatus;
  recommendedPhase: string;
  summary: string;
}

export interface WorkbenchTopicDetail extends WorkbenchTopicSummary {
  change: ChangeMetadata | null;
  reviewStatus?: string;
  closeGate?: {
    ready: boolean;
    warnings: string[];
    blockingIssues: string[];
  };
  acMap?: AcMap | null;
  acCount?: number;
  taskCount?: number;
  specTest?: unknown;
  drift?: unknown;
  runs: RunMetadata[];
  taskQueues: TaskQueueRun[];
  taskQueueItems: TaskQueueItem[];
  taskRuns: TaskRun[];
  workerLeases: WorkerLease[];
  worktrees: unknown[];
  validations: unknown[];
  audits: unknown[];
  threadItems: ThreadStreamItem[];
}

export interface WorkbenchSnapshot {
  productMode: ProductMode;
  project: unknown;
  harness: WorkbenchRuntimeStatus;
  left: {
    project: unknown;
    harness: WorkbenchRuntimeStatus;
    topics: WorkbenchTopicSummary[];
    workpads: WorkbenchWorkpadSummary[];
    repo: {
      path: string;
      exists?: boolean;
      git?: boolean;
      branch?: string | null;
      dirty?: boolean | null;
    };
  };
  center: {
    selectedTopic: WorkbenchTopicDetail | null;
    workpad: WorkbenchWorkpad;
    thread: {
      items: ThreadStreamItem[];
    };
    conversationInteractions: ConversationInteractionQueue;
    conversationContext?: import("./conversation-context-lifecycle.js").ConversationContextSnapshot | null;
    activeTab: "conversation";
    agentLoop: {
      runs: RunMetadata[];
    };
  };
  right: {
    approvals: WorkbenchApprovalItem[];
    decisions: WorkbenchDecisionItem[];
    decisionInspector: WorkbenchDecisionInspector;
    confirmationQueue: WorkbenchConfirmationQueue;
  };
  roles: WorkbenchRoleSummary[];
  harnessGaps: HarnessGap[];
  warnings: string[];
}
