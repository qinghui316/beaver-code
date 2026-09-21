import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canApplyResultFromGate, classifyApplyReadiness, evaluateSkillNativeApplyGate } from "../../../apply/gate.js";
import { worktreeApplyManifestHash } from "../../../apply/gate.js";
import { projectApplyActionScope, resolveProjectApplyExecutionScope } from "../../../apply/execution-scope.js";
import { listCompletedWorktreeDispositions } from "../../../apply/manager.js";
import { listDemandWorkers } from "../../../demand-worker/manager.js";
import type { HighImpactApprovalScope } from "../../../workflow-actions/high-impact-approval.js";
import { integrationCheckActionManifestHash } from "../../../integration-check/manager.js";
import { listAuditResults, summarizeAudit } from "../../../audit/repository.js";
import { getProjectStatus } from "../../../project/status.js";
import { readProjectHarnessEvolutionState } from "../../../project-harness/evolution.js";
import { readProjectHarnessPlanningGate } from "../../../project-harness/planning-gate-query.js";
import { projectExecutionRuntimePort, projectHarnessArchivedChangeReadPort, projectHarnessExecutionPort } from "../../../project-runtime/execution-ports.js";
import { skillNativeSchedulerExecutionPort } from "../../../scheduler-runtime/execution-port.js";
import { listPendingSkillNativeProjectHarnessChangeFinalizations } from "../../../project-runtime/change-finalization.js";
import type { ProjectRuntimeResolution } from "../../../project-runtime/context.js";
import { listRuns } from "../../../run/repository.js";
import { listTaskQueueItems, listTaskQueues } from "../../../task-queue/repository.js";
import { listTaskRuns, listWorkerLeases } from "../../../task-run/repository.js";
import { listValidationResults, summarizeValidation } from "../../../validation/repository.js";
import { listWorktreesForChange } from "../../../worktree/status.js";
import { listWorkflowRuns } from "../../../workflow-run/manager.js";
import { summarizeWorkflowRun } from "../../../workflow-run/summary.js";
import { readExecutionAuthorization } from "../../../workflow-runtime/execution-authorization.js";
import { readLatestSchedulerCurrentTransitionView } from "../../../workflow-runtime/scheduler-current-transition-view.js";
import { listSkillNativeSchedulerRuns } from "../../../workflow-runtime/skill-native-ready-set.js";
import { getSpecTestDriftReport } from "../../../spec-test/drift.js";
import { getSpecTestContextForChange, getSpecTestEvidenceFingerprint, getSpecTestStatus, requireActiveSpecTestExecutionAuthorization } from "../../../spec-test/manager.js";
import { listSpecTestProposalSummaries, showSpecTestProposal, specTestProposalManifestHash } from "../../../spec-test/proposal.js";
import type { AuditResult, ManagedProject, ValidationResult, WorkflowGraphPlan, WorkflowRun } from "../../../types/index.js";
import { buildConversationInteractionQueue } from "../../conversation-interactions.js";
import { fromStoredThreadMessage } from "../../conversation-thread-log.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../persistence/open-workbench-database.js";
import type { StoredDecisionRecord } from "../../persistence/contracts.js";
import type {
  HarnessGap,
  WorkbenchConfirmationQueue,
  WorkbenchApprovalItem,
  WorkbenchProjectHarnessStatus,
  WorkbenchSnapshot,
  WorkbenchDecisionContext,
  WorkbenchDecisionItem,
  WorkbenchResultReview,
  WorkbenchTopicDetail,
  WorkbenchTopicSummary,
  WorkbenchWorkpad,
  WorkbenchWorkpadSummary,
} from "../../read-model-types.js";
import type { WorkbenchWorkflowGraphPlanSummary } from "../../workflow-projection.js";
import {
  buildSchedulerCurrentTransitionProjection,
  buildTypedWorkflowNextAction,
  type WorkbenchSchedulerCurrentTransitionProjection,
} from "../../workflow-projection.js";
import { integrationCheckNeedsActionQueueItem, integrationCheckNeedsUserAction, integrationCheckQueueItem } from "./confirmation/integration.js";
import { sequentialWorkflowToConfirmationItems } from "./confirmation/typed-workflow.js";
import { schedulerNextActionToConfirmationItems } from "./confirmation/typed-workflow.js";
import { changeFinalizationToConfirmationItems } from "./confirmation/change-finalization.js";
import { decisionContextToConfirmationItems } from "./confirmation/decision-context.js";
import { alignDecisionInspectorWithConfirmationPrimary, buildDecisionInspector, emptyDecisionInspector } from "./decision-inspector.js";
import { approvalAction } from "./confirmation/shared.js";
import { buildHarnessGaps, buildRepoSummary } from "./support.js";
import { buildDiagnosticWorkpad, buildMultiWorkpadSummaries, buildRolePipelineSummary, buildWorkpadBackground, buildWorkpadNextAction } from "./workpad.js";
import { buildAgentTaskSummaries } from "./agent-task-summary.js";
import { buildCodingPackages, buildTaskGraph, buildTaskQueueSummary, taskNodeToPreview } from "./task-graph.js";
import { listWorkbenchRoles } from "./roles.js";
import { buildThreadStreamFromMessages } from "./thread-stream.js";
import { readIntakeState } from "../../intake.js";
import { mergeSkillNativeProjectWideConfirmations } from "./skill-native-project-wide-confirmations.js";

export function demandWorkerSummaryState(status: string | undefined): Pick<WorkbenchWorkpadSummary, "runtimeStatus" | "userStatus" | "userStatusLabel"> | null {
  if (status === "claimed" || status === "running") {
    return { runtimeStatus: "running", userStatus: "processing", userStatusLabel: "处理中" };
  }
  if (status === "queued") {
    return { runtimeStatus: "queued", userStatus: "later", userStatusLabel: "稍后处理" };
  }
  if (status === "needs-user-input" || status === "failed") {
    return { runtimeStatus: "blocked", userStatus: "waiting-confirmation", userStatusLabel: "等待确认" };
  }
  if (status === "result-ready") {
    return { runtimeStatus: "waiting-decision", userStatus: "waiting-confirmation", userStatusLabel: "等待确认" };
  }
  return null;
}

export async function tryBuildSkillNativePlanningSnapshot(input: {
  project: ManagedProject;
  resolution: ProjectRuntimeResolution;
  topicId?: string;
  compactThread?: boolean;
}): Promise<WorkbenchSnapshot | null> {
  const conversations = await readPlanningConversations(input.resolution);
  const status = projectHarnessStatus(input.resolution);
  const gaps = buildHarnessGaps();
  const selected = input.topicId
    ? conversations.find((item) => item.conversationId === input.topicId || item.boundChangeId === input.topicId)
    : conversations.find((item) => item.state === "active" && item.boundChangeId)
      ?? conversations.find((item) => item.state === "active");
  if (!selected) {
    return input.topicId
      ? null
      : buildEmptySkillNativeSnapshot(input.project, input.resolution, status, gaps, conversations);
  }
  const existingWorkflowRun = selected.boundChangeId
    ? (await listWorkflowRuns(input.resolution.paths, selected.boundChangeId))[0] ?? null
    : null;
  const existingSchedulerRun = selected.boundChangeId
    ? (await listSkillNativeSchedulerRuns(input.resolution.paths, selected.boundChangeId))[0] ?? null
    : null;
  let topic = conversationTopic(selected);
  topic = { ...topic, threadItems: input.compactThread ? [] : await readPlanningThread(input.resolution, topic) };
  const warnings: string[] = [];
  let graph: WorkflowGraphPlan | null = null;
  let planningEvidence: Awaited<ReturnType<typeof readProjectHarnessPlanningGate>> | null = null;
  let schedulerProjection: WorkbenchSchedulerCurrentTransitionProjection | null = null;
  let schedulerIntegrationBarrier: WorkbenchConfirmationQueue["current"][number] | null = null;
  let gateReady = false;
  let planningAgentTasks: Awaited<ReturnType<typeof buildAgentTaskSummaries>> = [];
  let auditApprovals: WorkbenchApprovalItem[] = [];
  let currentValidations: ValidationResult[] = [];
  let currentAudits: AuditResult[] = [];
  let executionHarness: Awaited<ReturnType<typeof projectHarnessExecutionPort>> | null = null;
  let archivedHarness: Awaited<ReturnType<typeof projectHarnessArchivedChangeReadPort>> | null = null;
  if (selected.state === "archive" && selected.boundChangeId) {
    try {
      archivedHarness = await projectHarnessArchivedChangeReadPort(
        input.project,
        input.resolution.harness.skillRoot,
        selected.boundChangeId,
      );
      graph = archivedHarness.graph;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  } else if (!selected.boundChangeId || !selected.currentGraphScopeId) {
    warnings.push("Planning gate requires an exact Change and current Conversation graph scope.");
  } else try {
    const evidence = await readProjectHarnessPlanningGate({
      projectId: input.resolution.harness.projectId,
      projectRoot: input.resolution.projectRoot,
      skillRoot: input.resolution.harness.skillRoot,
      conversationId: selected.conversationId,
      graphScopeId: selected.currentGraphScopeId,
      changeId: selected.boundChangeId,
    });
    planningEvidence = evidence;
    graph = evidence.graph;
    if (evidence.authorizationIntent.status === "issued" && evidence.authorizationIntent.authorizationId) {
      const authorization = await readExecutionAuthorization(
        input.resolution.paths,
        evidence.authorizationIntent.authorizationId,
      );
      if (authorization.status !== "active"
        || Date.parse(authorization.expiresAt) <= Date.now()
        || authorization.projectId !== input.resolution.harness.projectId
        || authorization.changeId !== selected.boundChangeId
        || authorization.conversationId !== selected.conversationId
        || authorization.acceptedPlanHash !== evidence.authorizationIntent.proposalHash
        || authorization.graphId !== graph.id) {
        throw new Error("Planning gate execution authorization lineage is stale.");
      }
      gateReady = true;
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  if (existingSchedulerRun && graph?.graphMode === "ready-set-v1" && selected.boundChangeId) {
    try {
      const runtime = projectExecutionRuntimePort(input.project, input.resolution);
      const evidenceRoot = join(
        input.resolution.harness.skillRoot,
        "state",
        "changes",
        "active",
        selected.boundChangeId,
      );
      const harness = await projectHarnessExecutionPort(input.project, evidenceRoot, planningEvidence!);
      const execution = skillNativeSchedulerExecutionPort({
        runtime,
        harness,
        skillRoot: input.resolution.harness.skillRoot,
        sidecarRoot: input.resolution.paths.sidecarRoot,
        schedulerRunId: existingSchedulerRun.id,
      });
      const changePath = harness.changeStatus.activeChanges.find((item) => item.name === selected.boundChangeId)?.path;
      if (!changePath) throw new Error("Skill-native Scheduler projection cannot resolve the active Change path.");
      const view = await readLatestSchedulerCurrentTransitionView(
        execution.artifacts,
        execution.runtime,
        graph,
        changePath,
        existingSchedulerRun.id,
        "Workbench ready-set projection",
      );
      schedulerProjection = buildSchedulerCurrentTransitionProjection({
        topic: conversationTopic(selected),
        workflowGraphPlan: workflowGraphSummary(graph),
        view,
      });
      if (view.currentIntegrationCheck?.status === "passed" || (view.currentIntegrationCheck && integrationCheckNeedsUserAction(view.currentIntegrationCheck.status))) {
        const target = view.currentIntegrationCheck.resultTargets.find((item) => item.changeId === selected.boundChangeId)
          ?? view.currentIntegrationCheck.resultTargets[0];
        const applyScope = target
          ? await resolveProjectApplyExecutionScope(input.project, target.worktreeId)
            .then((scope) => projectApplyActionScope(scope, integrationCheckActionManifestHash(view.currentIntegrationCheck!)))
          : undefined;
        const item = view.currentIntegrationCheck.status === "passed"
          ? integrationCheckQueueItem(input.project, view.currentIntegrationCheck, selected.boundChangeId, applyScope)
          : integrationCheckNeedsActionQueueItem(input.project, view.currentIntegrationCheck, selected.boundChangeId, applyScope);
        schedulerIntegrationBarrier = {
          ...item,
          conversationId: selected.conversationId,
        };
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
    gateReady = false;
  }

  const specTestProjection = selected.boundChangeId && planningEvidence
    ? await buildSkillNativeSpecTestProjection(input.project, selected.boundChangeId, planningEvidence)
      .catch((error) => {
        warnings.push(error instanceof Error ? error.message : String(error));
        return null;
      })
    : null;
  if (specTestProjection) topic = { ...topic, specTest: specTestProjection.status, drift: specTestProjection.drift };

  if (archivedHarness && selected.boundChangeId) {
    topic = {
      ...topic,
      path: `state/changes/archive/${selected.boundChangeId}`,
      change: archivedHarness.changeStatus.change,
      reviewStatus: archivedHarness.changeStatus.reviewStatus,
      closeGate: archivedHarness.changeStatus.closeGate,
      acMap: archivedHarness.changeStatus.acMap,
      acCount: archivedHarness.changeStatus.acMap?.acceptanceCriteria.length,
      taskCount: archivedHarness.changeStatus.acMap?.tasks.length,
    };
  }

  if (selected.boundChangeId && planningEvidence) {
    const runtime = projectExecutionRuntimePort(input.project, input.resolution);
    const evidenceRoot = join(input.resolution.harness.skillRoot, "state", "changes", "active", selected.boundChangeId);
    const harness = await projectHarnessExecutionPort(input.project, evidenceRoot, planningEvidence);
    executionHarness = harness;
    const [runs, taskQueues, taskQueueItems, taskRuns, workerLeases, worktrees, validations, audits, agentTasks] = await Promise.all([
      listRuns(runtime).then((items) => items.filter((item) => item.changeId === selected.boundChangeId)),
      listTaskQueues(runtime, selected.boundChangeId),
      listTaskQueueItems(runtime, selected.boundChangeId),
      listTaskRuns(runtime, selected.boundChangeId),
      listWorkerLeases(runtime, selected.boundChangeId),
      listWorktreesForChange(runtime, selected.boundChangeId),
      listValidationResults(runtime, selected.boundChangeId),
      listAuditResults(runtime, selected.boundChangeId),
      buildAgentTaskSummaries(runtime, selected.boundChangeId),
    ]);
    planningAgentTasks = agentTasks;
    currentValidations = validations;
    currentAudits = audits;
    auditApprovals = await buildSkillNativeAuditApprovals(
      input.project,
      join(input.resolution.harness.skillRoot, "state", "changes", "active", selected.boundChangeId),
      audits,
    );
    topic = {
      ...topic,
      path: `state/changes/active/${selected.boundChangeId}`,
      change: harness.changeStatus.change,
      reviewStatus: harness.changeStatus.reviewStatus,
      closeGate: harness.changeStatus.closeGate,
      acMap: harness.changeStatus.acMap,
      acCount: harness.changeStatus.acMap?.acceptanceCriteria.length,
      taskCount: harness.changeStatus.acMap?.tasks.length,
      runs,
      taskQueues,
      taskQueueItems,
      taskRuns,
      workerLeases,
      worktrees,
      validations: validations.map(summarizeValidation),
      audits: audits.map(summarizeAudit),
    };
  }

  if (existingWorkflowRun && graph && planningEvidence && selected.boundChangeId) {
    return buildSkillNativeExecutionSnapshot({
      ...input,
      conversations,
      selected: { ...selected, boundChangeId: selected.boundChangeId },
      status,
      gaps,
      graph,
      planningEvidence,
      workflowRun: existingWorkflowRun,
      warnings,
    });
  }

  const approvals = [
    ...(specTestProjection?.approvals ?? []),
    ...auditApprovals,
    ...buildSkillNativeBlockingApprovals(selected.boundChangeId, currentValidations, currentAudits),
    ...await buildSkillNativeEvolutionApprovals(input.resolution),
  ];
  const graphSummary = graph ? workflowGraphSummary(graph) : undefined;
  const readiness = {
    specReady: Boolean(topic.acMap),
    planReady: Boolean(graphSummary),
    tasksReady: Boolean(topic.acMap?.tasks.length),
  };
  const taskQueue = buildTaskQueueSummary(topic, readiness);
  const taskGraph = buildTaskGraph(topic, readiness, taskQueue);
  const basePlanningWorkpad = planningWorkpad(input.project, topic, graphSummary, gateReady, warnings, gaps);
  const executionEvidenceAction = buildWorkpadNextAction(
    topic,
    specTestProjection?.approvals ?? [],
    readiness,
    basePlanningWorkpad.intake,
    taskQueue,
    taskGraph,
    graphSummary,
  );
  const baseWorkpad = {
    ...basePlanningWorkpad,
    taskQueue,
    taskGraph,
    mainAgentExecution: buildRolePipelineSummary(topic, planningAgentTasks),
    nextAction: taskGraph.nodes.some((node) => node.autoRework?.available)
      || (taskQueue && ["blocked", "failed"].includes(taskQueue.status))
      ? executionEvidenceAction
      : basePlanningWorkpad.nextAction,
  };
  const workpad = schedulerProjection && graph?.graphMode === "ready-set-v1" && graphSummary
    ? {
        ...baseWorkpad,
        ...schedulerProjection,
        userStatus: "waiting-confirmation" as const,
        userStatusLabel: "等待确认",
        nextAction: schedulerIntegrationBarrier
          ? {
              id: `apply-check:${schedulerIntegrationBarrier.applyCheckId}`,
              label: "处理 IntegrationCheck 结果",
              description: schedulerIntegrationBarrier.summary,
              kind: "approval" as const,
              approvalId: schedulerIntegrationBarrier.applyCheckId,
              enabled: true,
              requiresConfirmation: true,
            }
          : schedulerProjection.nextAction,
      }
    : baseWorkpad;
  const gateItems = gateReady ? sequentialWorkflowToConfirmationItems(input.project, topic, workpad) : [];
  const schedulerItems = schedulerProjection && !schedulerIntegrationBarrier
    ? schedulerNextActionToConfirmationItems(input.project, topic, workpad)
    : [];
  const currentItems = schedulerIntegrationBarrier ? [schedulerIntegrationBarrier] : schedulerItems.length ? schedulerItems : gateItems;
  let confirmationQueue: WorkbenchConfirmationQueue = {
    primary: currentItems[0] ?? null,
    current: currentItems,
    otherDemands: [],
    maintenance: [],
    history: [],
  };
  const topics = conversations.map(conversationTopicSummary);
  const runtime = projectExecutionRuntimePort(input.project, input.resolution);
  if (executionHarness) {
    confirmationQueue = await mergeSkillNativeProjectWideConfirmations({
      project: input.project,
      runtime,
      harness: executionHarness,
      topic,
      base: confirmationQueue,
    });
  }
  const [demandWorkers, agentTasks] = await Promise.all([
    listDemandWorkers(runtime).catch(() => []),
    planningAgentTasks.length > 0
      ? Promise.resolve(planningAgentTasks)
      : selected.boundChangeId ? buildAgentTaskSummaries(runtime, selected.boundChangeId) : Promise.resolve([]),
  ]);
  const workpads = topics.map((item): WorkbenchWorkpadSummary => {
    const demandWorker = demandWorkers.find((worker) => worker.changeId === item.boundChangeId);
    const demandState = demandWorkerSummaryState(demandWorker?.status);
    const archived = item.state === "archive";
    return {
      id: item.id,
      title: item.title,
      state: item.state,
      runtimeStatus: archived ? "archived" : demandState?.runtimeStatus ?? (item.id === topic.id ? "waiting-decision" : "active"),
      userStatus: archived ? "completed" : demandState?.userStatus ?? (item.id === topic.id ? "waiting-confirmation" : "processing"),
      userStatusLabel: archived ? "已完成" : demandState?.userStatusLabel ?? (item.id === topic.id ? "等待确认" : "处理中"),
      conversationLifecycle: item.state === "active" ? "active" : "archived-readonly",
      linkedFromChangeId: item.boundChangeId ?? undefined,
      selected: item.id === topic.id,
      waitingDecisionCount: demandState ? 0 : item.id === topic.id && currentItems.length ? 1 : 0,
      updatedAt: demandWorker?.updatedAt ?? item.updatedAt,
    };
  });
  const [projectStatus, roles, conversationInteractions, queuedTurnCount] = await Promise.all([
    getProjectStatus(input.project, input.project.path),
    listWorkbenchRoles(),
    selected.currentGraphScopeId
      ? buildConversationInteractionQueue(input.resolution.paths, selected.conversationId, selected.currentGraphScopeId, "harness")
      : Promise.resolve({ productMode: "harness" as const, items: [] }),
    readConversationTurnQueueCount(input.resolution, selected.conversationId),
  ]);
  const projectedWorkpad = {
    ...applySkillNativeWorkpadEvidence(workpad, topic, taskGraph, agentTasks, existingWorkflowRun, queuedTurnCount),
    mainAgentExecution: buildRolePipelineSummary(topic, agentTasks),
    background: buildWorkpadBackground(workpads, topic.id),
  };
  if (selected.boundChangeId) {
    const intakeState = await readIntakeState(input.resolution.paths, selected.boundChangeId);
    projectedWorkpad.intake = projectSkillNativeIntake(
      projectedWorkpad.intake,
      intakeState,
    );
    if (!graph && intakeState.latestIteration && projectedWorkpad.intake.pendingClarifications.length === 0) {
      projectedWorkpad.nextAction = {
        id: `intake-reanalyze:${selected.boundChangeId}`,
        label: "继续需求分析",
        description: "当前需求分析已完成一轮，等待新的用户信息再重新分析。",
        kind: "workflow-action",
        actionType: "intake.reanalyze",
        enabled: false,
        requiresConfirmation: false,
        disabledReason: "当前没有待处理的需求确认。",
      };
    }
  }
  return {
    productMode: "harness",
    project: input.project,
    harness: status,
    left: {
      project: input.project,
      harness: status,
      topics,
      workpads,
      repo: buildRepoSummary(projectStatus),
    },
    center: {
      selectedTopic: topic,
      workpad: projectedWorkpad,
      thread: { items: topic.threadItems },
      conversationInteractions,
      activeTab: "conversation",
      agentLoop: { runs: [] },
    },
    right: {
      approvals,
      decisions: [],
      decisionInspector: alignDecisionInspectorWithConfirmationPrimary(buildDecisionInspector({
        selectedTopic: topic,
        workpad: projectedWorkpad,
        approvals,
        decisions: [],
      }), confirmationQueue.primary, topic.id),
      confirmationQueue,
    },
    roles,
    harnessGaps: gaps,
    warnings,
  };
}

async function buildSkillNativeExecutionSnapshot(input: {
  project: ManagedProject;
  resolution: ProjectRuntimeResolution;
  topicId?: string;
  compactThread?: boolean;
  conversations: PlanningConversation[];
  selected: PlanningConversation & { boundChangeId: string };
  status: WorkbenchProjectHarnessStatus;
  gaps: HarnessGap[];
  graph: WorkflowGraphPlan;
  planningEvidence: Awaited<ReturnType<typeof readProjectHarnessPlanningGate>>;
  workflowRun: WorkflowRun;
  warnings: string[];
}): Promise<WorkbenchSnapshot> {
  const runtime = projectExecutionRuntimePort(input.project, input.resolution);
  const evidenceRoot = join(
    input.resolution.harness.skillRoot,
    "state",
    "changes",
    "active",
    input.selected.boundChangeId,
  );
  const harness = await projectHarnessExecutionPort(input.project, evidenceRoot, input.planningEvidence);
  const specTestProjection = await buildSkillNativeSpecTestProjection(
    input.project,
    input.selected.boundChangeId,
    input.planningEvidence,
  ).catch((error) => {
    input.warnings.push(error instanceof Error ? error.message : String(error));
    return null;
  });
  const [runs, taskQueues, taskQueueItems, taskRuns, workerLeases, worktrees, validations, audits, finalizationRequests, decisionRecords, worktreeDispositions] = await Promise.all([
    listRuns(runtime).then((items) => items.filter((item) => item.changeId === input.selected.boundChangeId)),
    listTaskQueues(runtime, input.selected.boundChangeId),
    listTaskQueueItems(runtime, input.selected.boundChangeId),
    listTaskRuns(runtime, input.selected.boundChangeId),
    listWorkerLeases(runtime, input.selected.boundChangeId),
    listWorktreesForChange(runtime, input.selected.boundChangeId),
    listValidationResults(runtime, input.selected.boundChangeId),
    listAuditResults(runtime, input.selected.boundChangeId),
    listPendingSkillNativeProjectHarnessChangeFinalizations(input.resolution, input.selected.boundChangeId),
    listSkillNativeDecisionRecords(input.resolution, input.selected.boundChangeId),
    listCompletedWorktreeDispositions(runtime, input.selected.boundChangeId),
  ]);
  const decisions = decisionRecords.map(mapSkillNativeDecisionRecord);
  const baseApprovals = [
    ...(specTestProjection?.approvals ?? []),
    ...await buildSkillNativeAuditApprovals(input.project, evidenceRoot, audits),
  ];
  const terminalWorktreeIds = new Set([
    ...worktrees.filter((worktree) => worktree.status === "applied").map((worktree) => worktree.worktreeId),
    ...worktreeDispositions.map((disposition) => disposition.worktreeId),
  ]);
  const topic: WorkbenchTopicDetail = {
    ...conversationTopic(input.selected),
    path: `state/changes/active/${input.selected.boundChangeId}`,
    change: harness.changeStatus.change,
    reviewStatus: harness.changeStatus.reviewStatus,
    closeGate: harness.changeStatus.closeGate,
    acMap: harness.changeStatus.acMap,
    acCount: harness.changeStatus.acMap?.acceptanceCriteria.length,
    taskCount: harness.changeStatus.acMap?.tasks.length,
    runs,
    taskQueues,
    taskQueueItems,
    taskRuns,
    workerLeases,
    worktrees,
    validations: validations.map(summarizeValidation),
    audits: audits.map(summarizeAudit),
    specTest: specTestProjection?.status ?? null,
    drift: specTestProjection?.drift ?? null,
    threadItems: input.compactThread ? [] : await readPlanningThread(input.resolution, conversationTopic(input.selected)),
  };
  const resultReview = await buildSkillNativeResultReview(
    input.project,
    runtime,
    harness,
    worktrees,
    validations,
    audits,
    terminalWorktreeIds,
  );
  const resultTerminal = !resultReview && terminalWorktreeIds.size > 0;
  let applyActionScope: HighImpactApprovalScope | undefined;
  if (resultReview?.worktreeId && resultReview.status === "ready-to-apply") {
    const executionScope = await resolveProjectApplyExecutionScope(input.project, resultReview.worktreeId);
    const gate = await evaluateSkillNativeApplyGate(input.project, executionScope.runtime, executionScope.harness, resultReview.worktreeId);
    applyActionScope = projectApplyActionScope(executionScope, worktreeApplyManifestHash(gate));
  }
  const approvals = [
    ...baseApprovals,
    ...buildSkillNativeBlockingApprovals(input.selected.boundChangeId, validations, audits),
    ...buildSkillNativeApplyApproval(input.project, input.selected.boundChangeId, resultReview, applyActionScope),
    ...await buildSkillNativeEvolutionApprovals(input.resolution),
  ];
  const graphSummary = workflowGraphSummary(input.graph);
  const base = planningWorkpad(input.project, topic, graphSummary, false, input.warnings, input.gaps);
  const readiness = { specReady: true, planReady: true, tasksReady: true };
  const taskQueue = buildTaskQueueSummary(topic, readiness);
  const taskGraph = buildTaskGraph(topic, readiness, taskQueue);
  const agentTasks = await buildAgentTaskSummaries(runtime, input.selected.boundChangeId);
  const queuedTurnCount = await readConversationTurnQueueCount(input.resolution, input.selected.conversationId);
  const executionNextAction = buildWorkpadNextAction(
    topic,
    approvals,
    readiness,
    base.intake,
    taskQueue,
    taskGraph,
    graphSummary,
  );
  const queueOrReworkAction = taskGraph.nodes.some((node) => node.autoRework?.available)
    || (taskQueue && ["blocked", "failed"].includes(taskQueue.status))
    ? executionNextAction
    : null;
  const workpad: WorkbenchWorkpad = {
    ...applySkillNativeWorkpadEvidence(base, topic, taskGraph, agentTasks, input.workflowRun, queuedTurnCount),
    userStatus: resultTerminal ? "completed" : "waiting-confirmation",
    userStatusLabel: resultTerminal ? "结果处理完成" : "等待确认",
    workflowRun: summarizeWorkflowRun(input.workflowRun),
    mainAgentExecution: buildRolePipelineSummary(topic, agentTasks),
    resultReview,
    taskQueue,
    taskGraph,
    evidence: resultReview?.evidence ?? [],
    nextAction: queueOrReworkAction ?? (resultTerminal
      ? {
          id: "result-terminal",
          label: "结果处理完成",
          description: "已按确认结果完成应用或放弃，不再提供旧的审查或应用动作。",
          kind: "none",
          enabled: false,
          requiresConfirmation: false,
        }
      : resultReview?.status === "ready-to-apply"
      ? {
          id: "result-apply-ready",
          label: "应用到项目",
          description: "验证、审查和人工接受证据已完整。",
          kind: "approval",
          approvalId: `apply:${resultReview.worktreeId}`,
          enabled: true,
          requiresConfirmation: true,
        }
      : {
          id: "audit-accept-required",
          label: "接受审查结果",
          description: "审查已通过，等待人工接受后才可进入 apply gate。",
          kind: "approval",
          approvalId: resultReview?.audit ? `audit:${resultReview.audit.id}` : undefined,
          enabled: Boolean(resultReview?.audit),
          requiresConfirmation: true,
        }),
  };
  const decision = resultDecisionContext(input.project, topic, resultReview, applyActionScope);
  const finalizationItems = changeFinalizationToConfirmationItems(input.project, finalizationRequests);
  const current = finalizationItems.length
    ? finalizationItems
    : decisionContextToConfirmationItems(decision, true, topic.id);
  const confirmationQueue = await mergeSkillNativeProjectWideConfirmations({
    project: input.project,
    runtime,
    harness,
    topic,
    base: {
    primary: current[0] ?? null,
    current,
    otherDemands: [],
    maintenance: [],
    history: [],
    },
  });
  const topics = input.conversations.map(conversationTopicSummary);
  const workpads = await buildMultiWorkpadSummaries(
    runtime,
    topics,
    specTestProjection?.approvals ?? [],
    topic.id,
  );
  workpad.background = buildWorkpadBackground(workpads, topic.id);
  workpad.memoryIsolation = {
    ...workpad.memoryIsolation,
    runNamespaces: runs.slice(0, 5).map((run) => `run/${run.id}`),
    relatedWorkpads: workpads
      .filter((item) => item.id !== topic.id && ["running", "queued", "blocked", "waiting-decision"].includes(item.runtimeStatus))
      .slice(0, 6)
      .map((item) => ({
        changeId: item.linkedFromChangeId ?? item.id,
        title: item.title,
        status: item.runtimeStatus,
        factBoundary: item.runtimeStatus === "running" || item.runtimeStatus === "queued"
          ? "local-evidence-only"
          : "summary-only",
      })),
  };
  const [projectStatus, roles, conversationInteractions] = await Promise.all([
    getProjectStatus(input.project, input.project.path),
    listWorkbenchRoles(),
    input.selected.currentGraphScopeId
      ? buildConversationInteractionQueue(input.resolution.paths, input.selected.conversationId, input.selected.currentGraphScopeId, "harness")
      : Promise.resolve({ productMode: "harness" as const, items: [] }),
  ]);
  const decisionInspector = buildDecisionInspector({
    selectedTopic: topic,
    workpad,
    approvals,
    decisions,
  });
  const alignedDecisionInspector = alignDecisionInspectorWithConfirmationPrimary(
    decision ? { ...decisionInspector, primary: null } : decisionInspector,
    confirmationQueue.primary,
    topic.id,
  );
  return {
    productMode: "harness",
    project: input.project,
    harness: input.status,
    left: { project: input.project, harness: input.status, topics, workpads, repo: buildRepoSummary(projectStatus) },
    center: {
      selectedTopic: topic,
      workpad,
      thread: { items: topic.threadItems },
      conversationInteractions,
      activeTab: "conversation",
      agentLoop: { runs },
    },
    right: {
      approvals,
      decisions,
      decisionInspector: alignedDecisionInspector,
      confirmationQueue,
    },
    roles,
    harnessGaps: input.gaps,
    warnings: input.warnings,
  };
}

function applySkillNativeWorkpadEvidence(
  workpad: WorkbenchWorkpad,
  topic: WorkbenchTopicDetail,
  taskGraph: ReturnType<typeof buildTaskGraph>,
  agentTasks: Awaited<ReturnType<typeof buildAgentTaskSummaries>>,
  workflowRun: WorkflowRun | null,
  queuedTurnCount: number,
): WorkbenchWorkpad {
  const latestRun = [...topic.runs].sort((left, right) =>
    (right.finishedAt ?? right.startedAt).localeCompare(left.finishedAt ?? left.startedAt))[0];
  const latestValidationStatus = latestProjectedStatus(topic.validations);
  const latestAuditStatus = latestProjectedStatus(topic.audits);
  const active = topic.runs.some((run) => run.status === "created" || run.status === "running")
    || agentTasks.some((task) => ["queued", "claimed", "running"].includes(task.status))
    || workflowRun?.status === "created"
    || workflowRun?.status === "running";
  return {
    ...workpad,
    progress: {
      topicState: topic.state,
      spec: topic.acMap ? "ready" : "missing",
      plan: workpad.workflowGraphPlan ? "ready" : "missing",
      tasks: topic.acMap?.tasks.length ? "ready" : "missing",
      acCount: topic.acCount ?? 0,
      taskCount: topic.taskCount ?? 0,
      runCount: topic.runs.length,
      latestRunStatus: latestRun?.status,
      validationStatus: latestValidationStatus,
      auditStatus: latestAuditStatus,
    },
    tasks: taskGraph.nodes.map(taskNodeToPreview),
    codingPackages: buildCodingPackages(topic, taskGraph),
    runControlState: {
      canStop: active,
      canSteer: active,
      steerState: "idle",
      stopActionType: active ? "conversation.interrupt" : undefined,
      pendingFeedbackCount: queuedTurnCount,
      explanation: active
        ? "支持实时引导时，纯文本会发送给当前执行；完整的后续要求进入下一回合队列。停止不会清除输入或队列。"
        : "当前没有正在执行的需求。",
    },
  };
}

async function readConversationTurnQueueCount(
  resolution: ProjectRuntimeResolution,
  conversationId: string,
): Promise<number> {
  const database = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    return database.conversationTurnQueues.listItems(resolution.harness.projectId, conversationId).length;
  } finally {
    database.close();
  }
}

function latestProjectedStatus(items: readonly unknown[]): string | undefined {
  return items
    .filter((item): item is { status: string; finishedAt?: string } => Boolean(
      item && typeof item === "object" && "status" in item && typeof (item as { status?: unknown }).status === "string",
    ))
    .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))[0]?.status;
}

function projectSkillNativeIntake(
  current: WorkbenchWorkpad["intake"],
  state: Awaited<ReturnType<typeof readIntakeState>>,
): WorkbenchWorkpad["intake"] {
  return {
    ...current,
    currentUnderstanding: state.latestIteration?.currentUnderstanding ?? current.currentUnderstanding,
    relatedArtifacts: state.latestScan ? [state.latestScan.runId ? `runs/${state.latestScan.runId}/scan.md` : ""] : current.relatedArtifacts,
    missingInfo: state.latestScan?.missingInfo ?? current.missingInfo,
    confirmedConstraints: state.latestIteration?.confirmedConstraints ?? current.confirmedConstraints,
    openQuestions: state.latestIteration?.openQuestions ?? current.openQuestions,
    assumptions: state.latestIteration?.assumptions ?? current.assumptions,
    pendingClarifications: state.clarifications.filter((item) => item.status === "pending"),
  };
}

async function buildSkillNativeSpecTestProjection(
  project: ManagedProject,
  changeId: string,
  planning: Awaited<ReturnType<typeof readProjectHarnessPlanningGate>>,
): Promise<{ status: unknown; drift: unknown; approvals: WorkbenchApprovalItem[] }> {
  const [status, drift, proposals, evidenceDigest] = await Promise.all([
    getSpecTestStatus(project, { changeId }),
    getSpecTestDriftReport(project, { changeId }),
    listSpecTestProposalSummaries(project),
    getSpecTestEvidenceFingerprint(project, changeId),
  ]);
  const authorizationId = planning.authorizationIntent.authorizationId;
  const approvals: WorkbenchApprovalItem[] = [];
  if (planning.authorizationIntent.status === "issued" && authorizationId) {
    const context = await getSpecTestContextForChange(project, changeId);
    await requireActiveSpecTestExecutionAuthorization(context);
    for (const summary of proposals.filter((item) => item.changeId === changeId
      && item.status === "proposed"
      && item.acceptedSourceRootCount > 0)) {
      const proposal = await showSpecTestProposal(project, summary.id);
      const scope: HighImpactApprovalScope = {
        projectId: planning.mainAcceptance.projectId,
        changeId,
        conversationId: planning.mainAcceptance.conversationId,
        graphScopeId: planning.mainAcceptance.graphScopeId,
        workflowGraphPlanId: planning.graph.id,
        acceptedProposalHash: planning.mainAcceptance.proposalHash,
        authorizationId,
        evidenceDigest,
        targetManifestHash: specTestProposalManifestHash(proposal),
      };
      approvals.push({
        id: `spec-test:${proposal.id}`,
        kind: "spec-test-proposal",
        label: "Accept source-root spec-test evidence",
        changeId,
        runId: proposal.runId,
        targetId: proposal.id,
        severity: "info",
        action: approvalAction(
          "spec-test.proposal.accept-all-existing",
          "Accept source-root spec-test evidence",
          "spec-test",
          ["proposal", "accept", project.id, proposal.id, "--all-existing"],
          true,
          scope,
        ),
        artifact: proposal.artifacts.proposalMarkdown,
        reason: `${summary.acceptedSourceRootCount} source-root evidence candidate(s) await explicit acceptance.`,
      });
    }
  }
  return { status, drift, approvals };
}

async function buildSkillNativeResultReview(
  project: ManagedProject,
  runtime: ReturnType<typeof projectExecutionRuntimePort>,
  harness: Awaited<ReturnType<typeof projectHarnessExecutionPort>>,
  worktrees: Awaited<ReturnType<typeof listWorktreesForChange>>,
  validations: ValidationResult[],
  audits: AuditResult[],
  terminalWorktreeIds: ReadonlySet<string>,
): Promise<WorkbenchResultReview | undefined> {
  const worktree = worktrees.find((item) => item.status === "active" && !terminalWorktreeIds.has(item.worktreeId))
    ?? worktrees.find((item) => !terminalWorktreeIds.has(item.worktreeId));
  if (!worktree && terminalWorktreeIds.size > 0) return undefined;
  const validation = latestForWorktree(validations, worktree?.worktreeId);
  const audit = latestForWorktree(audits, worktree?.worktreeId);
  if (!worktree && !validation && !audit) return undefined;
  const auditAccepted = audit ? await reviewAcceptsAudit(harness.evidenceRoot, audit.id) : false;
  const gate = worktree ? await evaluateSkillNativeApplyGate(project, runtime, harness, worktree.worktreeId).catch(() => null) : null;
  const failed = validation?.status === "failed" || audit?.status === "blocked" || audit?.status === "failed";
  const readiness = gate && auditAccepted ? classifyApplyReadiness(gate) : null;
  const ready = Boolean(gate && auditAccepted && canApplyResultFromGate(gate));
  const status = failed ? "needs-rework" : ready ? "ready-to-apply" : "not-ready";
  const notes = audit?.findings.filter((finding) => finding.severity === "note").map((finding) => finding.text) ?? [];
  return {
    status,
    title: ready ? "结果可应用到项目" : failed ? "结果需要修改" : "结果证据尚未完整",
    summary: ready ? "验证和审查已通过，可以由你确认应用到项目。" : "验证和审查已完成，等待人工接受审查结果。",
    worktreeId: worktree?.worktreeId,
    changedFiles: gate?.changedPaths.slice(0, 8) ?? [],
    diffStat: gate?.diffStat ?? audit?.artifacts.diffStat,
    validation: validation ? { id: validation.id, status: validation.status, runId: validation.runId } : undefined,
    audit: audit ? {
      id: audit.id,
      status: audit.status,
      runId: audit.runId,
      findingCount: audit.findings.length,
      notes,
      artifact: audit.artifacts.audit,
    } : undefined,
    applyReadiness: {
      ready,
      kind: readiness?.kind ?? "not-approved",
      label: readiness?.message ?? "等待人工接受审查结果",
      message: readiness?.message ?? "等待人工接受审查结果",
      blockingIssues: auditAccepted ? gate?.blockingIssues ?? [] : [],
      warnings: auditAccepted ? gate?.warnings ?? [] : [],
    },
    evidence: [
      ...(validation ? [{ id: `result-validation:${validation.id}`, label: `验证 ${validation.status}`, source: "validation" as const, status: validation.status, timestamp: validation.finishedAt }] : []),
      ...(audit ? [{ id: `result-audit:${audit.id}`, label: `审查 ${audit.status}`, source: "audit" as const, status: audit.status, artifact: audit.artifacts.audit, timestamp: audit.finishedAt }] : []),
    ],
  };
}

function resultDecisionContext(
  project: ManagedProject,
  topic: WorkbenchTopicDetail,
  review: WorkbenchResultReview | undefined,
  actionScope?: HighImpactApprovalScope,
): WorkbenchDecisionContext | null {
  const changeId = topic.boundChangeId ?? topic.id;
  if (!review?.audit) return null;
  if (review.status === "ready-to-apply" && review.worktreeId) {
    return {
      id: `apply:${review.worktreeId}`,
      kind: "apply-gate",
      title: "结果已满足 apply gate",
      summary: review.summary,
      severity: "info",
      changeId,
      targetId: review.worktreeId,
      actions: [{
        id: `result.apply:${review.worktreeId}`,
        label: "应用到项目",
        kind: "approval",
        enabled: true,
        requiresConfirmation: true,
        changeId,
        worktreeId: review.worktreeId,
        action: {
          actionId: "result.apply",
          label: "应用到项目",
          command: "result",
          args: ["apply", project.id, changeId, review.worktreeId],
          mutates: true,
          requiresConfirmation: true,
          scope: actionScope,
        },
      }, {
        id: `worktree.discard:${review.worktreeId}`,
        label: "放弃这次结果",
        kind: "approval",
        enabled: true,
        requiresConfirmation: true,
        changeId,
        worktreeId: review.worktreeId,
        action: {
          actionId: "worktree.discard",
          label: "放弃这次结果",
          command: "worktree",
          args: ["discard", project.id, changeId, review.worktreeId],
          mutates: true,
          requiresConfirmation: true,
          scope: actionScope,
        },
      }],
    };
  }
  const recovery = skillNativeResultRecoveryDecision(changeId, review);
  if (recovery) return recovery;
  return {
    id: `approval:audit:${review.audit.id}`,
    kind: "audit-approved",
    title: "审查结果等待接受",
    summary: review.summary,
    severity: "info",
    changeId,
    runId: review.audit.runId,
    targetId: review.audit.id,
    artifact: review.audit.artifact,
    actions: [{
      id: `audit.accept:${review.audit.id}`,
      label: "接受审查",
      kind: "approval",
      enabled: true,
      requiresConfirmation: true,
      changeId,
      approvalId: `audit:${review.audit.id}`,
      action: {
        actionId: "audit.accept",
        label: "接受审查",
        command: "audit",
        args: ["accept", project.id, review.audit.id],
        mutates: true,
        requiresConfirmation: true,
      },
    }],
  };
}

function skillNativeResultRecoveryDecision(
  changeId: string,
  review: WorkbenchResultReview,
): WorkbenchDecisionContext | null {
  if (!review.worktreeId) return null;
  const recovery = (() => {
    switch (review.applyReadiness.kind) {
    case "source-drift": return {
      id: `refresh-rework:${review.worktreeId}`,
      label: "重新处理这个结果",
      actionType: "result.refresh-rework" as const,
      requiresConfirmation: true,
    };
    case "dirty-source": return {
      id: `refresh-status:${review.worktreeId}`,
      label: "刷新状态",
      actionType: "result.refresh-status" as const,
      requiresConfirmation: false,
    };
    case "stale-validation": return {
      id: `revalidate:${review.worktreeId}`,
      label: "重新验证",
      actionType: "result.revalidate" as const,
      requiresConfirmation: true,
    };
    case "stale-audit": return {
      id: `reaudit:${review.worktreeId}`,
      label: "重新审查",
      actionType: "result.reaudit" as const,
      requiresConfirmation: true,
    };
    default: return null;
    }
  })();
  if (!recovery) return null;
  return {
    id: `result:${changeId}:${review.worktreeId}:${review.applyReadiness.kind}`,
    kind: "apply-gate",
    title: review.applyReadiness.message,
    summary: review.summary,
    severity: review.applyReadiness.kind === "dirty-source" ? "warning" : "blocking",
    changeId,
    targetId: review.worktreeId,
    artifact: review.audit?.artifact,
    actions: [{
      ...recovery,
      kind: "workflow-action",
      changeId,
      worktreeId: review.worktreeId,
      enabled: true,
    }],
  };
}

async function listSkillNativeDecisionRecords(
  resolution: ProjectRuntimeResolution,
  changeId: string,
): Promise<StoredDecisionRecord[]> {
  const database = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    return database.decisions.listDecisions(resolution.harness.projectId, changeId);
  } finally {
    database.close();
  }
}

function mapSkillNativeDecisionRecord(record: StoredDecisionRecord): WorkbenchDecisionItem {
  return {
    id: record.id,
    kind: record.decisionType,
    label: record.label,
    status: record.status,
    changeId: record.changeId ?? undefined,
    runId: record.runId ?? undefined,
    targetId: record.targetId ?? undefined,
    artifact: record.artifact ?? undefined,
    summary: record.summary,
    feedback: record.feedback ?? undefined,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt ?? undefined,
  };
}

function latestForWorktree<T extends { worktreeId?: string; finishedAt: string }>(items: T[], worktreeId: string | undefined): T | undefined {
  return items
    .filter((item) => !worktreeId || item.worktreeId === worktreeId)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))[0];
}

function buildSkillNativeBlockingApprovals(
  changeId: string | null,
  validations: ValidationResult[],
  audits: AuditResult[],
): WorkbenchApprovalItem[] {
  if (!changeId) return [];
  const approvals: WorkbenchApprovalItem[] = [];
  const validation = latestForWorktree(validations, undefined);
  if (validation?.status === "failed") {
    approvals.push({
      id: `attention:validation:${changeId}:${validation.id}`,
      kind: "attention",
      label: `Latest validation failed: ${validation.id}`,
      changeId,
      targetId: validation.id,
      severity: "blocking",
      reason: "Failed validation blocks close.",
    });
  }
  const audit = latestForWorktree(audits, undefined);
  if (audit?.status === "blocked" || audit?.status === "failed") {
    approvals.push({
      id: `attention:audit:${changeId}:${audit.id}`,
      kind: "attention",
      label: `Latest audit ${audit.status}: ${audit.id}`,
      changeId,
      targetId: audit.id,
      severity: "blocking",
      reason: "Blocked or failed audit prevents safe close.",
    });
  }
  return approvals;
}

function buildSkillNativeApplyApproval(
  project: ManagedProject,
  changeId: string,
  review: WorkbenchResultReview | undefined,
  scope: HighImpactApprovalScope | undefined,
): WorkbenchApprovalItem[] {
  if (review?.status !== "ready-to-apply" || !review.worktreeId || !scope) return [];
  return [{
    id: `apply:${review.worktreeId}`,
    kind: "worktree-apply",
    label: `结果可应用到项目：${review.worktreeId}`,
    changeId,
    targetId: review.worktreeId,
    severity: "info",
    action: approvalAction(
      "result.apply",
      "应用到项目",
      "result",
      ["apply", project.id, changeId, review.worktreeId],
      true,
      scope,
    ),
    artifact: review.audit?.artifact,
  }];
}

async function buildSkillNativeEvolutionApprovals(
  resolution: ProjectRuntimeResolution,
): Promise<WorkbenchApprovalItem[]> {
  const state = await readProjectHarnessEvolutionState(resolution.harness.skillRoot).catch(() => null);
  if (!state?.pending) return [];
  return [{
    id: "evolution:pending",
    kind: "evolution",
    label: "Harness evolution pending",
    severity: "warning",
    action: approvalAction("evolution.handle", "Handle Harness evolution", "harness-evolve", ["status"], false),
    artifact: "state/evolution/pending.json",
    reason: "Handle through proposal, independent review, validation, results, and mark-complete.",
  }];
}

async function reviewAcceptsAudit(evidenceRoot: string, auditId: string): Promise<boolean> {
  const path = join(evidenceRoot, "reviews", "review.md");
  if (!existsSync(path)) return false;
  return (await readFile(path, "utf8")).includes(`Audit ID: ${auditId}`);
}

async function buildSkillNativeAuditApprovals(
  project: ManagedProject,
  evidenceRoot: string,
  audits: AuditResult[],
): Promise<WorkbenchApprovalItem[]> {
  const approvals: WorkbenchApprovalItem[] = [];
  for (const audit of audits
    .filter((item) => item.status === "approved" || item.status === "approved-with-notes")
    .slice(0, 3)) {
    if (await reviewAcceptsAudit(evidenceRoot, audit.id)) continue;
    approvals.push({
      id: `audit:${audit.id}`,
      kind: "audit-proposal",
      label: `Audit proposal can be accepted: ${audit.id}`,
      changeId: audit.changeId,
      runId: audit.runId,
      targetId: audit.id,
      severity: "info",
      action: approvalAction(
        "audit.accept",
        "Accept audit",
        "audit",
        ["accept", project.id, audit.id],
        true,
      ),
      artifact: audit.artifacts.audit,
      reason: audit.status === "approved" ? undefined : "Audit approved with notes requires manual acceptance.",
    });
  }
  return approvals;
}

interface PlanningConversation {
  projectId: string;
  conversationId: string;
  title: string;
  state: "active" | "archive";
  boundChangeId: string | null;
  currentGraphScopeId: string | null;
  selectedProviderId: string;
  createdAt: string;
  updatedAt: string;
  archiveOrigin: "agent-user" | "harness-workflow" | null;
  lifecycleRevision: number;
}

async function readPlanningConversations(resolution: ProjectRuntimeResolution): Promise<PlanningConversation[]> {
  const store = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    return store.conversations.listConversations(resolution.harness.projectId, "harness").map((conversation) => ({
      projectId: conversation.projectId,
      conversationId: conversation.conversationId,
      title: conversation.title,
      state: conversation.state,
      boundChangeId: conversation.boundChangeId,
      currentGraphScopeId: conversation.currentGraphScopeId,
      selectedProviderId: conversation.selectedProviderId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archiveOrigin: conversation.archiveOrigin,
      lifecycleRevision: conversation.lifecycleRevision,
    }));
  } finally {
    store.close();
  }
}

async function readPlanningThread(
  resolution: ProjectRuntimeResolution,
  topic: WorkbenchTopicDetail,
): Promise<WorkbenchTopicDetail["threadItems"]> {
  const store = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    return buildThreadStreamFromMessages(
      topic,
      store.timeline
        .listConversationMessages(resolution.harness.projectId, topic.id)
        .map(fromStoredThreadMessage),
      { includeChangeState: false },
    );
  } finally {
    store.close();
  }
}

function conversationTopicSummary(conversation: PlanningConversation): WorkbenchTopicSummary {
  const active = conversation.state === "active";
  return {
    id: conversation.conversationId,
    productMode: "harness",
    kind: "conversation",
    name: conversation.conversationId,
    title: conversation.title,
    state: conversation.state,
    path: `runtime-sidecar:conversation/${conversation.conversationId}`,
    boundChangeId: conversation.boundChangeId,
    graphScopeId: conversation.currentGraphScopeId ?? undefined,
    selectedProviderId: conversation.selectedProviderId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lifecycle: {
      projectId: conversation.projectId,
      productMode: "harness",
      conversationId: conversation.conversationId,
      state: active ? "active" : "archived",
      archiveOrigin: conversation.archiveOrigin,
      lifecycleRevision: `conversation-lifecycle:${conversation.lifecycleRevision}`,
      updatedAt: conversation.updatedAt,
      canArchive: false,
      canRestore: false,
      canDelete: !active,
      activity: null,
      ...(active ? { disabledReason: "AHO 会话仅由治理流程归档。" } : {}),
    },
  };
}

function conversationTopic(conversation: PlanningConversation): WorkbenchTopicDetail {
  return {
    ...conversationTopicSummary(conversation),
    change: null,
    runs: [],
    taskQueues: [],
    taskQueueItems: [],
    taskRuns: [],
    workerLeases: [],
    worktrees: [],
    validations: [],
    audits: [],
    threadItems: [],
  };
}

function workflowGraphSummary(graph: WorkflowGraphPlan): WorkbenchWorkflowGraphPlanSummary {
  return {
    id: graph.id,
    changeId: graph.changeId,
    status: graph.status,
    graphMode: graph.graphMode,
    authoringContractVersion: graph.authoringContractVersion,
    schedulerContractId: graph.graphMode === "ready-set-v1" ? graph.schedulerContractId : undefined,
    schedulerWorkerPlanId: graph.graphMode === "ready-set-v1" ? graph.schedulerWorkerPlanId : undefined,
    schedulerClaimReconcilePlanId: graph.graphMode === "ready-set-v1" ? graph.schedulerClaimReconcilePlanId : undefined,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    waveCount: graph.graphMode === "ready-set-v1" ? graph.waves.length : undefined,
    artifact: graph.artifact,
    markdownArtifact: graph.markdownArtifact,
    updatedAt: graph.updatedAt,
  };
}

function planningWorkpad(
  project: ManagedProject,
  topic: WorkbenchTopicDetail,
  graph: WorkbenchWorkflowGraphPlanSummary | undefined,
  gateReady: boolean,
  warnings: string[],
  gaps: HarnessGap[],
): WorkbenchWorkpad {
  const base = buildDiagnosticWorkpad(project.name, warnings, gaps);
  const nextAction = graph && gateReady
    ? buildTypedWorkflowNextAction({
        topic: { runs: [] },
        readiness: { specReady: true, planReady: true, tasksReady: true },
        workflowGraphPlan: graph,
        workflowRun: null,
      })
    : {
        id: "planning-gate-unavailable",
        label: "等待计划就绪",
        description: warnings[0] ?? "当前计划尚未形成可确认的执行门禁。",
        kind: "read-only" as const,
        enabled: false,
        requiresConfirmation: false,
        disabledReason: warnings[0] ?? "执行授权尚未就绪。",
      };
  return {
    ...base,
    title: topic.title,
    subtitle: topic.boundChangeId ?? topic.id,
    state: topic.state === "active" ? "active" : "readonly",
    userStatus: topic.state === "archive" ? "completed" : gateReady ? "waiting-confirmation" : "processing",
    userStatusLabel: topic.state === "archive" ? "已完成" : gateReady ? "等待确认" : "处理中",
    conversationId: topic.id,
    demandId: topic.id,
    boundChangeId: topic.boundChangeId ?? undefined,
    conversationLifecycle: topic.state === "active" ? "active" : "archived-readonly",
    workflowGraphPlan: graph,
    intake: {
      ...base.intake,
      goal: topic.title,
      currentUnderstanding: graph ? "计划已接受并绑定当前项目 Harness Change。" : "正在核对当前计划证据。",
      source: "topic",
      relatedArtifacts: graph?.artifact ? [graph.artifact] : [],
      missingInfo: [],
    },
    blockers: warnings,
    warnings: [],
    nextAction,
    memoryIsolation: {
      projectStableNamespace: "project/stable",
      currentChangeNamespace: topic.boundChangeId ? `project/change/${topic.boundChangeId}` : undefined,
      providerSessionNamespace: "agent/{roleId}/session/{sessionId}",
      runNamespaces: [],
      relatedWorkpads: [],
      stableFactSources: ["project-harness"],
      writeBoundaries: ["runtime-sidecar", "project-skill"],
      warnings: [],
    },
  };
}

async function buildEmptySkillNativeSnapshot(
  project: ManagedProject,
  resolution: ProjectRuntimeResolution,
  status: WorkbenchProjectHarnessStatus,
  gaps: HarnessGap[],
  conversations: PlanningConversation[],
): Promise<WorkbenchSnapshot> {
  const base = buildDiagnosticWorkpad(project.name, [], gaps);
  const workpad: WorkbenchWorkpad = {
    ...base,
    title: "项目需求",
    subtitle: project.name,
    state: "empty",
    userStatus: "later",
    userStatusLabel: "稍后处理",
    intake: {
      ...base.intake,
      goal: "暂无需求对话。",
      currentUnderstanding: "项目 Harness 已就绪，可以从 Main 对话开始新的需求。",
      missingInfo: [],
    },
    blockers: [],
    warnings: [],
    nextAction: {
      id: "start-conversation",
      label: "等待新需求",
      description: "使用对话输入开始新的项目需求。",
      kind: "read-only",
      enabled: false,
      requiresConfirmation: false,
      disabledReason: "新需求从对话输入开始，不需要单独的 Workflow action。",
    },
    memoryIsolation: {
      ...base.memoryIsolation,
      stableFactSources: ["project-harness"],
      writeBoundaries: ["runtime-sidecar", "project-skill"],
      warnings: [],
    },
  };
  const [projectStatus, roles, approvals] = await Promise.all([
    getProjectStatus(project, project.path),
    listWorkbenchRoles(),
    buildSkillNativeEvolutionApprovals(resolution),
  ]);
  return {
    productMode: "harness",
    project,
    harness: status,
    left: {
      project,
      harness: status,
      topics: conversations.map(conversationTopicSummary),
      workpads: [],
      repo: buildRepoSummary(projectStatus),
    },
    center: {
      selectedTopic: null,
      workpad,
      thread: { items: [] },
      conversationInteractions: { productMode: "harness", items: [] },
      activeTab: "conversation",
      agentLoop: { runs: [] },
    },
    right: {
      approvals,
      decisions: [],
      decisionInspector: emptyDecisionInspector(),
      confirmationQueue: { primary: null, current: [], otherDemands: [], maintenance: [], history: [] },
    },
    roles,
    harnessGaps: gaps,
    warnings: [],
  };
}

function projectHarnessStatus(resolution: ProjectRuntimeResolution): WorkbenchProjectHarnessStatus {
  return {
    kind: "project-skill",
    registered: true,
    managed: true,
    harnessReady: true,
    projectId: resolution.harness.projectId,
    skillName: resolution.harness.skillName,
    skillRevision: resolution.harness.skillRevision,
    contentFingerprint: resolution.harness.contentFingerprint,
    runtimeAvailable: true,
  };
}
