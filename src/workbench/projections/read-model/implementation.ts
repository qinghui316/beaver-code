import { latestLandingQueueSnapshot } from "../../../landing-queue/manager.js";
import { listDemandWorkers } from "../../../demand-worker/manager.js";
import { projectExecutionRuntimePort } from "../../../project-runtime/execution-ports.js";
import { getProjectStatus } from "../../../project/status.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../../../provider-runtime/project-harness-discovery.js";
import { resolveProjectRuntimeState } from "../../../project-runtime/coordinator.js";
import type { ProjectRuntimeResolution } from "../../../project-runtime/context.js";
import { readRun } from "../../../run/manager.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../persistence/open-workbench-database.js";
import { summarizeRunArtifacts } from "../artifact-preview.js";
import { readRunEvents } from "./thread-stream.js";
import { emptyConfirmationQueue } from "./confirmation-queue.js";
import { CurrentProjectConversationUnavailableError } from "./errors.js";
import { emptyDecisionInspector } from "./decision-inspector.js";
import { demandWorkerSummaryState, tryBuildSkillNativePlanningSnapshot } from "./skill-native-planning-snapshot.js";
import { listWorkbenchRoles } from "./roles.js";
import { buildHarnessGaps, buildRepoSummary } from "./support.js";
import { buildDiagnosticWorkpad } from "./workpad.js";
import { buildThreadStreamFromMessages } from "./thread-stream.js";
import { fromStoredThreadMessage } from "../../conversation-thread-log.js";
import { buildConversationInteractionQueue } from "../../conversation-interactions.js";
import type { ProductMode } from "../../../provider-runtime/index.js";
import type { LandingQueueSnapshot, ManagedProject } from "../../../types/index.js";
import type {
  WorkbenchApprovalItem,
  WorkbenchProjectHarnessDiagnosticStatus,
  WorkbenchProjectInput,
  WorkbenchSnapshot,
  WorkbenchStreamPacket,
  WorkbenchTopicDetail,
  WorkbenchTopicSummary,
  WorkbenchWorkpad,
  WorkpadEvidenceSummary,
} from "../../read-model-types.js";

export type {
  HarnessGap,
  HarnessGapSeverity,
  HarnessGapStatus,
  ThreadStreamAction,
  ThreadStreamEvidence,
  ThreadStreamItem,
  WorkbenchAgentTaskSummary,
  WorkbenchApprovalAction,
  WorkbenchApprovalItem,
  WorkbenchApprovalKind,
  WorkbenchAutoReworkSummary,
  WorkbenchCodingPackage,
  WorkbenchCodingPackageAssignmentStatus,
  WorkbenchCodingPackageStatus,
  WorkbenchConfirmationQueue,
  WorkbenchConfirmationQueueItem,
  WorkbenchConfirmationQueueItemKind,
  WorkbenchConversationLifecycle,
  WorkbenchDecisionAction,
  WorkbenchDecisionContext,
  WorkbenchDecisionContextKind,
  WorkbenchDecisionInspector,
  WorkbenchDecisionItem,
  WorkbenchFailureClassification,
  WorkbenchPendingFeedback,
  ProviderAttemptReadModel,
  WorkbenchProjectInput,
  WorkbenchResultReview,
  WorkbenchResultReviewStatus,
  WorkbenchReworkPrompt,
  WorkbenchRolePipelineSummary,
  WorkbenchRoleRunSummary,
  WorkbenchRoleSummary,
  WorkbenchRunControlState,
  WorkbenchScopedFeedbackTarget,
  WorkbenchSnapshot,
  WorkbenchStreamPacket,
  WorkbenchTaskEvidence,
  WorkbenchTaskGraph,
  WorkbenchTaskNextAction,
  WorkbenchTaskNode,
  WorkbenchTaskNodeStatus,
  WorkbenchTaskQueueItemSummary,
  WorkbenchTaskQueueSummary,
  WorkbenchTaskRunSummary,
  WorkbenchThreadEvent,
  WorkbenchTopicDetail,
  WorkbenchTopicState,
  WorkbenchTopicSummary,
  WorkbenchUserDecisionState,
  WorkbenchWorkerLeaseSummary,
  WorkbenchWorkpad,
  WorkbenchWorkpadRuntimeStatus,
  WorkbenchWorkpadSummary,
  WorkpadBackgroundActivitySummary,
  WorkpadEvidenceSummary,
  WorkpadIntakeSummary,
  WorkpadMemoryIsolationSummary,
  WorkpadNextAction,
  WorkpadProgress,
  WorkpadRelatedMemorySummary,
  WorkpadTaskPreview,
} from "../../read-model-types.js";

export { listWorkbenchRoles } from "./roles.js";
export {
  getWorkbenchWorkflowGraphPlanProjection,
  getWorkbenchSchedulerContractProjection,
  getWorkbenchSchedulerDispatchDryRunProjection,
  getWorkbenchSchedulerWorkerSessionPlanProjection,
  getWorkbenchSchedulerClaimReconcilePlanProjection,
  getWorkbenchSchedulerLaunchPreflightProjection,
  getWorkbenchSchedulerRunProjection,
  getWorkbenchSchedulerRuntimeProjection,
  getWorkbenchSchedulerReconcileSnapshotProjection,
  getWorkbenchSchedulerClaimReservationProjection,
  getWorkbenchSchedulerWorkerAuditProjection,
  getWorkbenchSchedulerWorkerReworkPlanProjection,
  getWorkbenchSchedulerWorkerReworkAuditProjection,
  getWorkbenchSchedulerWorkerReworkResultProjection,
  getWorkbenchSchedulerWorkerReworkValidationProjection,
  getWorkbenchSchedulerWorkerReworkStartProjection,
  getWorkbenchSchedulerWorkerValidationProjection,
  getWorkbenchSchedulerIntegrationCandidateProjection,
  getWorkbenchSchedulerIntegrationCheckHandoffProjection,
  getWorkbenchSchedulerIntegrationOutcomeProjection,
  getWorkbenchSchedulerRunBlockedCloseoutProjection,
  getWorkbenchSchedulerRunCompletionProjection,
  getWorkbenchWorkflowRunProjection,
} from "./lazy-projections.js";

export async function getWorkbenchSnapshot(input: WorkbenchProjectInput, options: {
  topicId?: string;
  productMode?: ProductMode;
  ignoreActiveWorkflowActions?: boolean;
  ignoreActiveWorkflowActionTypes?: string[];
  compactThread?: boolean;
} = {}): Promise<WorkbenchSnapshot> {
  const productMode = options.productMode ?? "harness";
  let runtimeState: Awaited<ReturnType<typeof resolveProjectRuntimeState>> | null = null;
  if (input.project) {
    runtimeState = input.runtimeStateResolver
      ? await input.runtimeStateResolver(input.project)
      : await resolveProjectRuntimeState(input.project, { discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY });
    const runtimePaths = runtimeState.state === "onboarding"
      ? runtimeState.paths
      : runtimeState.resolution.paths;
    await assertRequestedConversationMode(
      runtimePaths,
      runtimePaths.projectId,
      options.topicId,
      productMode,
    );
    if (productMode === "agent") {
      return buildAgentModeSnapshot(input, input.project, runtimeState, options.topicId, options.compactThread);
    }
    if (runtimeState.state === "ready") {
      const planningSnapshot = await tryBuildSkillNativePlanningSnapshot({
        project: input.project,
        resolution: runtimeState.resolution,
        topicId: options.topicId,
        compactThread: options.compactThread,
      });
      if (planningSnapshot) {
        await calibrateHarnessTurnControl(input, runtimeState.resolution, planningSnapshot);
        return planningSnapshot;
      }
      throw new CurrentProjectConversationUnavailableError();
    }
  }
  const projectStatus = await getProjectStatus(input.project, input.path);
  const roles = await listWorkbenchRoles();
  const gaps = buildHarnessGaps();
  const status = diagnosticProjectHarnessStatus(input, runtimeState);
  const warnings = [status.reason];
  const diagnosticWorkpad = buildDiagnosticWorkpad(input.project?.name ?? "未选择项目", warnings, gaps);
  return {
    productMode,
    project: input.project,
    harness: status,
    left: {
      project: input.project,
      harness: status,
      topics: [],
      workpads: [],
      repo: buildRepoSummary(projectStatus),
    },
    center: {
      selectedTopic: null,
      workpad: diagnosticWorkpad,
      thread: { items: [] },
      conversationInteractions: { productMode, items: [] },
      activeTab: "conversation",
      agentLoop: { runs: [] },
    },
    right: { approvals: [], decisions: [], decisionInspector: emptyDecisionInspector(), confirmationQueue: emptyConfirmationQueue() },
    roles,
    harnessGaps: gaps,
    warnings,
  };
}

async function calibrateHarnessTurnControl(
  input: WorkbenchProjectInput,
  resolution: ProjectRuntimeResolution,
  snapshot: WorkbenchSnapshot,
): Promise<void> {
  const conversationId = snapshot.center.selectedTopic?.id;
  const graphScopeId = snapshot.center.selectedTopic?.graphScopeId;
  if (!conversationId || !graphScopeId) return;
  if (input.project && input.conversationContextSnapshotResolver) {
    snapshot.center.conversationContext = await input.conversationContextSnapshotResolver(input.project, "harness", conversationId);
  }
  if (!snapshot.center.workpad.runControlState) return;
  const database = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    const attempt = [...database.providerAttempts.listProviderAttempts(resolution.paths.projectId, conversationId)]
      .reverse()
      .find((candidate) => candidate.productMode === "harness"
        && candidate.operationProfile === "main"
        && candidate.roleId === "main-agent"
        && candidate.graphScopeId === graphScopeId
        && (candidate.status === "queued" || candidate.status === "running"));
    if (!attempt) return;
    const control = input.turnControlStateResolver?.(resolution.paths.projectId, conversationId, attempt.attemptId);
    snapshot.center.workpad.runControlState = {
      ...snapshot.center.workpad.runControlState,
      state: control?.state ?? "running",
      canStop: control?.canInterrupt ?? false,
      canSteer: control?.canSteer ?? false,
      steerState: control?.steerState ?? "idle",
      providerId: attempt.providerId,
      attemptId: attempt.attemptId,
      ...(control?.runId ? { runId: control.runId } : {}),
      explanation: control?.state === "stopping"
        ? "正在停止当前 Harness Provider 回合。"
        : control?.canSteer
          ? "可以向当前 Harness Provider 回合发送文本补充，也可以停止当前执行。"
          : "当前 Harness Provider 回合没有可用的实时控制身份。",
    };
  } finally {
    database.close();
  }
}

async function requireReadyProjectRuntime(input: WorkbenchProjectInput): Promise<ProjectRuntimeResolution> {
  if (!input.project) throw new Error("Project Harness runtime is unavailable for Workbench read models.");
  const state = input.runtimeStateResolver
    ? await input.runtimeStateResolver(input.project)
    : await resolveProjectRuntimeState(input.project, { discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY });
  if (state.state !== "ready") {
    throw new Error(`Project Harness is not ready for Workbench read models: ${state.state}.`);
  }
  return state.resolution;
}

export async function getWorkbenchWorkpadProjection(input: WorkbenchProjectInput, changeId: string): Promise<WorkbenchWorkpad> {
  return (await getWorkbenchSnapshot(input, { topicId: changeId, productMode: "harness" })).center.workpad;
}

export async function getWorkbenchEvidenceProjection(input: WorkbenchProjectInput, changeId: string): Promise<{
  changeId: string;
  evidence: WorkpadEvidenceSummary[];
}> {
  const workpad = await getWorkbenchWorkpadProjection(input, changeId);
  return {
    changeId,
    evidence: workpad.evidence,
  };
}

export async function getWorkbenchLandingQueueProjection(input: WorkbenchProjectInput): Promise<LandingQueueSnapshot | null> {
  if (!input.project) return null;
  const runtime = await requireReadyProjectRuntime(input);
  return latestLandingQueueSnapshot(runtime.paths).catch(() => null);
}

export async function listWorkbenchTopics(input: WorkbenchProjectInput, productMode: ProductMode): Promise<WorkbenchTopicSummary[]> {
  if (!input.project) return [];
  const runtime = input.runtimeStateResolver
    ? await input.runtimeStateResolver(input.project)
    : await resolveProjectRuntimeState(input.project, { discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY });
  if (runtime.state !== "ready" && productMode === "harness") return [];
  const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
  const store = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const lifecycleById = input.conversationLifecycleSnapshotsResolver
      ? new Map((await input.conversationLifecycleSnapshotsResolver(input.project, productMode))
        .map((item) => [item.conversationId, item]))
      : null;
    return await Promise.all(store.conversations.listConversations(paths.projectId, productMode).map(async (conversation) => {
      const forkOperation = store.conversationForks.readByTargetConversation(paths.projectId, conversation.conversationId);
      const lifecycle = lifecycleById?.get(conversation.conversationId) ?? (input.conversationLifecycleSnapshotResolver
        ? await input.conversationLifecycleSnapshotResolver(input.project!, productMode, conversation.conversationId)
        : basicLifecycleSnapshot(conversation));
      return {
      id: conversation.conversationId,
      productMode: conversation.productMode,
      agentTurnMode: conversation.agentTurnMode,
      agentModelId: conversation.agentModelId,
      agentReasoningEffort: conversation.agentReasoningEffort,
      kind: "conversation",
      name: conversation.conversationId,
      title: conversation.title,
      state: conversation.state,
      path: `runtime-sidecar:conversation/${conversation.conversationId}`,
      boundChangeId: conversation.boundChangeId,
      graphScopeId: conversation.currentGraphScopeId ?? undefined,
      selectedProviderId: conversation.selectedProviderId,
      completedTurnSequence: conversation.completedTurnSequence,
      timelineRevision: conversation.timelineRevision,
      forkBoundary: forkOperation ? forkBoundaryFromOperation(
        forkOperation,
        Boolean(store.conversations.readConversation(paths.projectId, forkOperation.sourceConversationId, { includeDeleted: true })?.deletedAt),
      ) : undefined,
      lifecycle,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      };
    }));
  } finally {
    store.close();
  }
}

export async function getWorkbenchNavigation(
  input: WorkbenchProjectInput,
  productMode: ProductMode,
  state: "active" | "archive" | "all" = "all",
) {
  if (!input.project) return { productMode, conversations: [] };
  const runtime = input.runtimeStateResolver
    ? await input.runtimeStateResolver(input.project)
    : await resolveProjectRuntimeState(input.project, { discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY });
  if (runtime.state !== "ready" && productMode === "harness") return { productMode, conversations: [] };
  const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  let entries: ReturnType<typeof database.conversations.listNavigationEntries>;
  try {
    entries = database.conversations.listNavigationEntries(paths.projectId, productMode, state);
  } finally {
    database.close();
  }
  const workerStatuses = new Map<string, string>();
  if (productMode === "harness") {
    if (runtime.state === "ready") {
      for (const worker of await listDemandWorkers(projectExecutionRuntimePort(input.project, runtime.resolution)).catch(() => [])) {
        workerStatuses.set(worker.changeId, worker.status);
      }
    }
  }
  return { productMode, conversations: entries.map((entry) => {
    const { conversation } = entry;
    const controlState = input.turnControlStateResolver?.(paths.projectId, conversation.conversationId);
    const turnActive = (controlState !== undefined && controlState.state !== "idle")
      || input.activeProviderTurnResolver?.(conversation.conversationId) === true;
    const blocker = navigationLifecycleBlocker(entry, turnActive);
    const basic = basicLifecycleSnapshot(conversation);
    const lifecycle = {
      ...basic,
      canArchive: basic.canArchive && !blocker,
      canRestore: basic.canRestore && !blocker,
      canDelete: basic.canDelete && !blocker,
      activity: blocker?.activity ?? null,
      ...(blocker ? { disabledReason: blocker.reason } : {}),
    };
    const worker = conversation.boundChangeId ? demandWorkerSummaryState(workerStatuses.get(conversation.boundChangeId)) : null;
    const archived = conversation.state === "archive";
    const awaitingInput = lifecycle.activity === "awaiting-input";
    const running = lifecycle.activity === "running";
    return {
      id: conversation.conversationId,
      title: conversation.title,
      state: conversation.state,
      updatedAt: conversation.updatedAt,
      userStatusLabel: archived ? "已完成" : awaitingInput ? "等待确认" : worker?.userStatusLabel
        ?? (running ? "处理中" : productMode === "agent" || !conversation.boundChangeId ? "稍后处理" : "等你确认"),
      waitingDecisionCount: worker?.userStatus === "waiting-confirmation" || awaitingInput ? 1 : 0,
      lifecycle,
    };
  }) };
}

function navigationLifecycleBlocker(
  entry: {
    runningAttempt: boolean;
    queuedTurn: boolean;
    incompleteFork: boolean;
    incompleteLifecycle: boolean;
    compacting: boolean;
    awaitingInput: boolean;
  },
  turnActive: boolean,
): { reason: string; activity: "running" | "awaiting-input" | null } | null {
  const pendingActivity = entry.awaitingInput ? "awaiting-input" as const : null;
  if (turnActive || entry.runningAttempt) {
    return { reason: "当前会话仍在运行、停止或实时引导中。", activity: pendingActivity ?? "running" };
  }
  if (entry.queuedTurn) return { reason: "请先处理待发送队列，再归档或删除会话。", activity: pendingActivity };
  if (entry.incompleteFork) return { reason: "会话分叉仍在处理。", activity: pendingActivity };
  if (entry.incompleteLifecycle) return { reason: "另一个会话生命周期操作仍在处理。", activity: pendingActivity };
  if (entry.compacting) return { reason: "上下文压缩仍在处理。", activity: pendingActivity };
  if (entry.awaitingInput) return { reason: "当前会话仍在等待用户输入、审批或确认。", activity: "awaiting-input" };
  return null;
}

async function buildAgentModeSnapshot(
  input: WorkbenchProjectInput,
  project: ManagedProject,
  runtime: Awaited<ReturnType<typeof resolveProjectRuntimeState>>,
  topicId?: string,
  compactThread = false,
): Promise<WorkbenchSnapshot> {
  const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const conversations = database.conversations.listConversations(paths.projectId, "agent");
    const selected = topicId
      ? conversations.find((conversation) => conversation.conversationId === topicId)
      : conversations.find((conversation) => conversation.state === "active");
    if (topicId && !selected) {
      const other = database.conversations.readConversation(paths.projectId, topicId);
      const error = new Error(other
        ? `Conversation ${topicId} belongs to ${other.productMode} mode, not agent.`
        : `Conversation not found: ${topicId}.`);
      error.name = other ? "Conflict" : "NotFound";
      throw error;
    }
    const lifecycleById = input.conversationLifecycleSnapshotsResolver
      ? new Map((await input.conversationLifecycleSnapshotsResolver(project, "agent"))
        .map((item) => [item.conversationId, item]))
      : null;
    const topics: WorkbenchTopicSummary[] = await Promise.all(conversations.map(async (conversation) => {
      const forkOperation = database.conversationForks.readByTargetConversation(paths.projectId, conversation.conversationId);
      const lifecycle = lifecycleById?.get(conversation.conversationId) ?? (input.conversationLifecycleSnapshotResolver
        ? await input.conversationLifecycleSnapshotResolver(project, "agent", conversation.conversationId)
        : basicLifecycleSnapshot(conversation));
      return {
      id: conversation.conversationId,
      productMode: "agent",
      agentTurnMode: conversation.agentTurnMode,
      agentModelId: conversation.agentModelId,
      agentReasoningEffort: conversation.agentReasoningEffort,
      kind: "conversation",
      name: conversation.conversationId,
      title: conversation.title,
      state: conversation.state,
      path: `runtime-sidecar:conversation/${conversation.conversationId}`,
      boundChangeId: conversation.boundChangeId,
      graphScopeId: conversation.currentGraphScopeId ?? undefined,
      selectedProviderId: conversation.selectedProviderId,
      completedTurnSequence: conversation.completedTurnSequence,
      timelineRevision: conversation.timelineRevision,
      forkBoundary: forkOperation ? forkBoundaryFromOperation(
        forkOperation,
        Boolean(database.conversations.readConversation(paths.projectId, forkOperation.sourceConversationId, { includeDeleted: true })?.deletedAt),
      ) : undefined,
      lifecycle,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      };
    }));
    let selectedTopic: WorkbenchTopicDetail | null = null;
    if (selected) {
      const topic = topics.find((candidate) => candidate.id === selected.conversationId)!;
      selectedTopic = {
        ...topic,
        change: null,
        runs: [],
        taskQueues: [],
        taskQueueItems: [],
        taskRuns: [],
        workerLeases: [],
        worktrees: [],
        validations: [],
        audits: [],
        threadItems: compactThread ? [] : await buildThreadStreamFromMessages(
          topic,
          database.timeline.listConversationMessages(paths.projectId, selected.conversationId).map(fromStoredThreadMessage),
          { includeChangeState: false },
        ),
      };
    }
    const [projectStatus, roles] = await Promise.all([
      getProjectStatus(project, project.path),
      listWorkbenchRoles(),
    ]);
    const harness = runtime.state === "ready" ? {
      kind: "project-skill" as const,
      registered: true as const,
      managed: true as const,
      harnessReady: true as const,
      projectId: runtime.resolution.harness.projectId,
      skillName: runtime.resolution.harness.skillName,
      skillRevision: runtime.resolution.harness.skillRevision,
      contentFingerprint: runtime.resolution.harness.contentFingerprint,
      runtimeAvailable: true as const,
    } : diagnosticProjectHarnessStatus({ project, path: project.path }, runtime);
    const workpad: WorkbenchWorkpad = {
      ...buildDiagnosticWorkpad(project.name, [], []),
      title: selectedTopic?.title ?? "Agent",
      subtitle: project.name,
      state: selected?.state === "archive" ? "readonly" as const : selectedTopic ? "active" as const : "empty" as const,
      userStatus: selected?.state === "archive" ? "completed" as const : "later" as const,
      userStatusLabel: selected?.state === "archive" ? "已归档" : "稍后处理",
      conversationLifecycle: selected?.state === "archive" ? "archived-readonly" as const : "active" as const,
      conversationId: selectedTopic?.id,
      demandId: selectedTopic?.id,
      blockers: [],
      warnings: [],
    };
    const runningMainAttempt = selected?.state === "active" && selected.currentGraphScopeId
      ? [...database.providerAttempts.listProviderAttempts(paths.projectId, selected.conversationId)]
        .reverse()
        .find((attempt) => attempt.productMode === "agent"
          && attempt.operationProfile === "agent"
          && attempt.roleId === "main-agent"
          && attempt.graphScopeId === selected.currentGraphScopeId
          && attempt.status === "running")
      : undefined;
    const turnControl = selected && runningMainAttempt
      ? input.turnControlStateResolver?.(paths.projectId, selected.conversationId, runningMainAttempt.attemptId)
      : undefined;
    if (runningMainAttempt) {
      workpad.conversationLifecycle = "running" as const;
      workpad.runControlState = {
        state: turnControl?.state ?? "running",
        canStop: turnControl?.canInterrupt ?? false,
        canSteer: turnControl?.canSteer ?? false,
        steerState: turnControl?.steerState ?? "idle",
        providerId: runningMainAttempt.providerId,
        attemptId: runningMainAttempt.attemptId,
        ...(turnControl?.runId ? { runId: turnControl.runId } : {}),
        pendingFeedbackCount: 0,
        explanation: turnControl?.state === "stopping"
          ? "正在停止当前 Agent 回合。"
          : turnControl?.canSteer
            ? "可以向当前 Agent 回合发送文本补充，也可以停止当前执行。"
            : turnControl?.canInterrupt
              ? "可以停止当前 Agent 回合；当前 Provider 暂不支持实时引导。"
            : "当前 Agent 回合正在启动，等待精确控制身份。",
      };
    }
    const conversationInteractions = selected?.state === "active" && selected.currentGraphScopeId
      ? await buildConversationInteractionQueue(
          paths,
          selected.conversationId,
          selected.currentGraphScopeId,
          "agent",
        )
      : { productMode: "agent" as const, items: [] };
    const conversationContext = selected?.state === "active" && input.conversationContextSnapshotResolver
      ? await input.conversationContextSnapshotResolver(project, "agent", selected.conversationId)
      : null;
    return {
      productMode: "agent",
      project,
      harness,
      left: { project, harness, topics, workpads: [], repo: buildRepoSummary(projectStatus) },
      center: {
        selectedTopic,
        workpad,
        thread: { items: selectedTopic?.threadItems ?? [] },
        conversationInteractions,
        conversationContext,
        activeTab: "conversation",
        agentLoop: { runs: [] },
      },
      right: {
        approvals: [],
        decisions: [],
        decisionInspector: emptyDecisionInspector(),
        confirmationQueue: emptyConfirmationQueue(),
      },
      roles,
      harnessGaps: [],
      warnings: [],
    };
  } finally {
    database.close();
  }
}

function forkBoundaryFromOperation(
  operation: import("../../persistence/contracts.js").StoredConversationForkOperation,
  sourceDeleted: boolean,
): import("../../types.js").ConversationForkBoundaryEvidence {
  return {
    sourceConversationId: operation.sourceConversationId,
    sourceMessageId: operation.sourceMessageId,
    completedTurnSequence: operation.anchorCompletedTurnSequence,
    sourceDeleted,
  };
}

function basicLifecycleSnapshot(conversation: import("../../persistence/contracts.js").StoredConversation): import("../../conversation-lifecycle.js").ConversationLifecycleSnapshot {
  const active = conversation.state === "active";
  return {
    projectId: conversation.projectId,
    productMode: conversation.productMode,
    conversationId: conversation.conversationId,
    state: active ? "active" : "archived",
    archiveOrigin: conversation.archiveOrigin,
    lifecycleRevision: `conversation-lifecycle:${conversation.lifecycleRevision}`,
    updatedAt: conversation.updatedAt,
    canArchive: active && conversation.productMode === "agent",
    canRestore: !active && conversation.productMode === "agent" && conversation.archiveOrigin === "agent-user",
    canDelete: !active,
    activity: null,
  };
}

async function assertRequestedConversationMode(
  paths: ProjectRuntimeResolution["paths"],
  projectId: string,
  topicId: string | undefined,
  productMode: ProductMode,
): Promise<void> {
  if (!topicId) return;
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const conversation = database.conversations.readConversation(projectId, topicId);
    if (conversation && conversation.productMode !== productMode) {
      const error = new Error("Conversation productMode does not match the requested mode.");
      error.name = "Conflict";
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function getWorkbenchTopic(input: WorkbenchProjectInput, topicId: string, productMode: ProductMode): Promise<WorkbenchTopicDetail> {
  if (!input.project) throw new Error(`Topic not found: ${topicId}.`);
  const detail = (await getWorkbenchSnapshot(input, { topicId, productMode })).center.selectedTopic;
  if (!detail) throw new Error(`Topic not found: ${topicId}.`);
  return detail;
}

export async function getWorkbenchStream(input: WorkbenchProjectInput, runId: string): Promise<WorkbenchStreamPacket> {
  if (!input.project) {
    throw new Error("Project Harness runtime is unavailable; cannot replay run stream.");
  }
  const runtime = input.runtimeStateResolver
    ? await input.runtimeStateResolver(input.project)
    : await resolveProjectRuntimeState(input.project, { discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY });
  if (runtime.state !== "ready") {
    throw new Error("Project Harness is not ready; cannot replay run stream.");
  }
  const run = await readRun(runtime.resolution.paths, runId);
  const events = await readRunEvents(runtime.resolution.paths, run);
  const { artifacts, diagnostics, warnings } = await summarizeRunArtifacts({
    projectRoot: runtime.resolution.projectRoot,
    runArtifactRoot: runtime.resolution.paths.sidecarRoot,
  }, run);
  return {
    run,
    live: false,
    events,
    artifacts,
    diagnostics,
    warnings,
  };
}

export async function listWorkbenchApprovals(input: WorkbenchProjectInput, options: { topicId?: string; productMode: ProductMode }): Promise<WorkbenchApprovalItem[]> {
  if (!input.project) return [];
  return (await getWorkbenchSnapshot(input, { topicId: options.topicId, productMode: options.productMode })).right.approvals;
}

function diagnosticProjectHarnessStatus(
  input: WorkbenchProjectInput,
  state: Awaited<ReturnType<typeof resolveProjectRuntimeState>> | null,
): WorkbenchProjectHarnessDiagnosticStatus {
  if (!input.project || !state) {
    return {
      kind: "project-skill",
      registered: false,
      managed: false,
      harnessReady: false,
      runtimeAvailable: false,
      state: "unregistered",
      reason: "Project is not registered; Workbench will not infer project history.",
    };
  }
  if (state.state === "onboarding") {
    return {
      kind: "project-skill",
      registered: true,
      managed: true,
      harnessReady: false,
      runtimeAvailable: true,
      projectId: state.reservedProjectId,
      state: "onboarding",
      reason: "Project Harness onboarding is incomplete; Workbench will not infer project history.",
    };
  }
  return {
    kind: "project-skill",
    registered: true,
    managed: true,
    harnessReady: false,
    runtimeAvailable: true,
    projectId: state.resolution.harness.projectId,
    state: "repair-required",
    reason: "Project Harness doctor or audit requires repair before Workbench can read project history.",
  };
}



