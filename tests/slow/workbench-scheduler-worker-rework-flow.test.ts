import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns } from "../../src/run/manager.js";
import { executeWorkbenchAction as executeWorkbenchActionRaw } from "../../src/server/workbench-server.js";
import { getWorkbenchSchedulerWorkerReworkPlanProjection, getWorkbenchSchedulerWorkerReworkResultProjection, getWorkbenchSchedulerWorkerReworkStartProjection, getWorkbenchSchedulerWorkerReworkValidationProjection, getWorkbenchSnapshot } from "../../src/workbench/projections/read-model/implementation.js";
import { listAgentTasks } from "../../src/agent-task/manager.js";
import { listWorktreeStatuses } from "../../src/worktree/manager.js";
import { listTaskQueues } from "../../src/task-queue/manager.js";
import { listTaskRuns, listWorkerLeases } from "../../src/task-run/manager.js";
import { listWorkflowRuns } from "../../src/workflow-run/manager.js";
import { prepareSkillNativeSchedulerFirstWorkerThroughResult } from "../helpers/skill-native-scheduler-fixture.js";
import { createTestConversationTurnRouter } from "../helpers/conversation-change-fixture.js";
import { createFakeCodex, enterFakeCodexScope, findSchedulerGateAction, getTempDir, project, unwrapWorkflowActionResult } from "../helpers/skill-native-test-environment.js";

let originalAhoHome: string | undefined;
let turnRouter: ReturnType<typeof createTestConversationTurnRouter>;

beforeEach(() => {
  originalAhoHome = process.env.AHO_HOME;
  turnRouter = createTestConversationTurnRouter();
});

function executeWorkbenchAction(
  input: Parameters<typeof executeWorkbenchActionRaw>[0],
  body: Parameters<typeof executeWorkbenchActionRaw>[1],
): ReturnType<typeof executeWorkbenchActionRaw> {
  return executeWorkbenchActionRaw(input, body, undefined, turnRouter);
}

afterEach(() => {
  if (originalAhoHome === undefined) delete process.env.AHO_HOME;
  else process.env.AHO_HOME = originalAhoHome;
});

describe("workbench scheduler worker rework slow flow", () => {
  it("compiles a scheduler worker rework plan after first worker validation fails and starts bounded same-worktree rework", async () => {
    const fakeCodex = await createFakeCodex();
    const closeFakeCodexScope = enterFakeCodexScope(fakeCodex);
    try {
    const prepared = await prepareSkillNativeSchedulerFirstWorkerThroughResult({
      title: "Scheduler Worker Rework Plan",
      packageTestScript: "node -e \"process.exit(1)\"",
      fakeCodex,
    });

    const postResultSnapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
    const validationAction = postResultSnapshot.right.confirmationQueue.current
      .flatMap((item) => item.actions)
      .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.validate-first", (candidate) => candidate.schedulerWorkerResultId === prepared.workerResult.id));
    if (!validationAction) {
      throw new Error(`Missing scheduler first worker validation action for ${prepared.workerResult.id}. Visible actions: ${JSON.stringify(postResultSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).map((action) => ({
        actionType: action.actionType,
        schedulerWorkerResultId: action.schedulerWorkerResultId,
        schedulerWorkerValidationId: action.schedulerWorkerValidationId,
      })))}`);
    }
    const validated = await executeWorkbenchAction({ project: project(), path: getTempDir() }, {
      ...validationAction,
      confirm: true,
    });
    const validatedResult = unwrapWorkflowActionResult(validated.result) as {
        status?: "passed" | "failed";
        schedulerValidation?: {
          id?: string;
          status?: string;
          schedulerWorkerResultId?: string;
          schedulerWorkerStartId?: string;
          taskRunId?: string;
          workerLeaseId?: string;
          worktreeId?: string;
          codeRunId?: string;
          validationRunId?: string;
        };
        taskRun?: { id?: string; status?: string; blockedReason?: string };
        validationResult?: { id?: string; status?: string; worktreeId?: string };
      };
    expect(validatedResult).toMatchObject({
      status: "failed",
      schedulerValidation: {
        status: "failed",
        schedulerWorkerResultId: prepared.workerResult.id,
        schedulerWorkerStartId: prepared.workerStart.id,
        taskRunId: prepared.workerStart.taskRunId,
        workerLeaseId: prepared.workerStart.workerLeaseId,
        worktreeId: prepared.workerStart.worktreeId,
        codeRunId: prepared.workerStart.runId,
      },
      taskRun: { id: prepared.workerStart.taskRunId, status: "blocked" },
      validationResult: { status: "failed", worktreeId: prepared.workerStart.worktreeId },
    });

    expect((await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).find((taskRun) => taskRun.id === prepared.workerStart.taskRunId)).toMatchObject({
      id: prepared.workerStart.taskRunId,
      status: "blocked",
    });
    const afterValidationRunCount = (await listRuns(prepared.runtimePaths)).filter((run) => run.changeId === prepared.topic.changeId).length;
    const afterValidationWorktreeCount = (await listWorktreeStatuses(prepared.runtimePaths)).length;
    const afterValidationTaskRunCount = (await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).length;
    const afterValidationLeaseCount = (await listWorkerLeases(prepared.runtimePaths, prepared.topic.changeId)).length;

    const reworkSnapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
    expect(reworkSnapshot.center.workpad.schedulerWorkerValidation).toMatchObject({
      id: validatedResult?.schedulerValidation?.id,
      status: "failed",
      schedulerWorkerResultId: prepared.workerResult.id,
    });
    expect(reworkSnapshot.center.workpad.nextAction).toMatchObject({
      actionType: "planning.scheduler.worker.rework-plan.compile",
      label: "生成当前 worker rework 计划",
      schedulerRunId: prepared.schedulerRun.id,
      schedulerClaimReservationId: prepared.claimReservation.id,
      schedulerWorkerStartId: prepared.workerStart.id,
      schedulerWorkerResultId: prepared.workerResult.id,
      schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
      enabled: true,
    });
    expect(reworkSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.audit-first")).toBe(false);
    const reworkAction = reworkSnapshot.right.confirmationQueue.current
      .flatMap((item) => item.actions)
      .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.rework-plan.compile", (candidate) => candidate.schedulerWorkerValidationId === validatedResult?.schedulerValidation?.id));
    if (!reworkAction) throw new Error("Missing scheduler first worker rework plan action.");
    expect(reworkAction).toMatchObject({
      schedulerRunId: prepared.schedulerRun.id,
      schedulerClaimReservationId: prepared.claimReservation.id,
      schedulerWorkerStartId: prepared.workerStart.id,
      schedulerWorkerResultId: prepared.workerResult.id,
      schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
      taskRunId: prepared.workerStart.taskRunId,
      workerLeaseId: prepared.workerStart.workerLeaseId,
      worktreeId: prepared.workerStart.worktreeId,
      runId: prepared.workerStart.runId,
      validationRunId: validatedResult?.schedulerValidation?.validationRunId,
    });

    const compiled = await executeWorkbenchAction({ project: project(), path: getTempDir() }, {
      ...reworkAction,
      confirm: true,
    });
    const reworkResult = unwrapWorkflowActionResult(compiled.result) as {
      existing?: boolean;
      executionStarted?: boolean;
      reworkPlan?: {
        id?: string;
        status?: string;
        blockingSource?: string;
        schedulerRunId?: string;
        schedulerClaimReservationId?: string;
        schedulerWorkerStartId?: string;
        schedulerWorkerResultId?: string;
        schedulerWorkerValidationId?: string;
        schedulerWorkerAuditId?: string;
        taskRunId?: string;
        workerLeaseId?: string;
        targetWorktreeId?: string;
        targetCodeRunId?: string;
        validationRunId?: string;
        futureCodeGateMode?: string;
      };
    };
    expect(reworkResult).toMatchObject({
      existing: false,
      executionStarted: false,
      reworkPlan: {
        status: "planned",
        blockingSource: "validation-failed",
        schedulerRunId: prepared.schedulerRun.id,
        schedulerClaimReservationId: prepared.claimReservation.id,
        schedulerWorkerStartId: prepared.workerStart.id,
        schedulerWorkerResultId: prepared.workerResult.id,
        schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
        taskRunId: prepared.workerStart.taskRunId,
        workerLeaseId: prepared.workerStart.workerLeaseId,
        targetWorktreeId: prepared.workerStart.worktreeId,
        targetCodeRunId: prepared.workerStart.runId,
        validationRunId: validatedResult?.schedulerValidation?.validationRunId,
        futureCodeGateMode: "scheduler-claim-rework",
      },
    });
    expect(reworkResult.reworkPlan?.schedulerWorkerAuditId).toBeUndefined();
    const reworkPlanPath = join(prepared.schedulerRunRoot, "scheduler-worker-rework-plans", `${reworkResult.reworkPlan?.id}.json`);
    expect(JSON.parse(await readFile(reworkPlanPath, "utf8"))).toMatchObject({
      id: reworkResult.reworkPlan?.id,
      changeId: prepared.topic.changeId,
      schedulerRunId: prepared.schedulerRun.id,
      blockingSource: "validation-failed",
      targetWorktreeId: prepared.workerStart.worktreeId,
      futureCodeGateMode: "scheduler-claim-rework",
    });
    const fullReworkPlan = await getWorkbenchSchedulerWorkerReworkPlanProjection(
      { project: project(), path: getTempDir() },
      prepared.topic.changeId,
      prepared.schedulerRun.id,
      reworkResult.reworkPlan?.id,
    );
    expect(fullReworkPlan).toMatchObject({
      id: reworkResult.reworkPlan?.id,
      blockingSource: "validation-failed",
      schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
    });
    const runtimeEvents = (await readFile(prepared.runtimeEventsPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schedulerRunId: prepared.schedulerRun.id,
        changeId: prepared.topic.changeId,
        type: "scheduler-runtime.worker-rework-planned",
        payload: expect.objectContaining({
          schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
          schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
          blockingSource: "validation-failed",
          worktreeId: prepared.workerStart.worktreeId,
        }),
      }),
    ]));

    expect((await listRuns(prepared.runtimePaths)).filter((run) => run.changeId === prepared.topic.changeId)).toHaveLength(afterValidationRunCount);
    expect(await listWorktreeStatuses(prepared.runtimePaths)).toHaveLength(afterValidationWorktreeCount);
    expect(await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationTaskRunCount);
    expect(await listWorkerLeases(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationLeaseCount);
    expect(await listTaskQueues(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
    expect(await listWorkflowRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
    expect(await listAgentTasks(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);

    const afterPlanSnapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
    expect(afterPlanSnapshot.center.workpad.schedulerWorkerReworkPlan).toMatchObject({
      id: reworkResult.reworkPlan?.id,
      status: "planned",
      blockingSource: "validation-failed",
    });
    expect(afterPlanSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.rework-plan.compile")).toBe(false);
    const reworkStartAction = afterPlanSnapshot.right.confirmationQueue.current
      .flatMap((item) => item.actions)
      .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.rework-start-first", (candidate) => candidate.schedulerWorkerReworkPlanId === reworkResult.reworkPlan?.id));
    if (!reworkStartAction) throw new Error("Missing scheduler first worker rework start action.");
    expect(reworkStartAction).toMatchObject({
      schedulerRunId: prepared.schedulerRun.id,
      schedulerClaimReservationId: prepared.claimReservation.id,
      schedulerWorkerStartId: prepared.workerStart.id,
      schedulerWorkerResultId: prepared.workerResult.id,
      schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
      schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
      taskRunId: prepared.workerStart.taskRunId,
      workerLeaseId: prepared.workerStart.workerLeaseId,
      worktreeId: prepared.workerStart.worktreeId,
      runId: prepared.workerStart.runId,
      validationRunId: validatedResult?.schedulerValidation?.validationRunId,
    });

    // Rework execution uses the same fake Codex as the first worker.
    {
      const startedRework = await executeWorkbenchAction({ project: project(), path: getTempDir() }, {
        ...reworkStartAction,
        confirm: true,
      });
      const reworkStartResult = unwrapWorkflowActionResult(startedRework.result) as {
        executionStarted?: boolean;
        reworkStart?: {
          id?: string;
          status?: string;
          schedulerWorkerReworkPlanId?: string;
          reworkTaskRunId?: string;
          reworkWorkerLeaseId?: string;
          worktreeId?: string;
          originalCodeRunId?: string;
          reworkRunId?: string;
        };
        code?: { run?: { id?: string; worktree?: { worktreeId?: string } } };
      };
      expect(reworkStartResult).toMatchObject({
        executionStarted: true,
        reworkStart: {
          status: "started",
          schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
          worktreeId: prepared.workerStart.worktreeId,
          originalCodeRunId: prepared.workerStart.runId,
        },
        code: {
          run: { worktree: { worktreeId: prepared.workerStart.worktreeId } },
        },
      });
      expect(reworkStartResult.reworkStart?.reworkRunId).toBe(reworkStartResult.code?.run?.id);
      const reworkStartPath = join(prepared.schedulerRunRoot, "scheduler-worker-rework-starts", `${reworkStartResult.reworkStart?.id}.json`);
      const reworkStartJson = JSON.parse(await readFile(reworkStartPath, "utf8"));
      expect(reworkStartJson).toMatchObject({
        id: reworkStartResult.reworkStart?.id,
        changeId: prepared.topic.changeId,
        schedulerRunId: prepared.schedulerRun.id,
        schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
        worktreeId: prepared.workerStart.worktreeId,
        originalCodeRunId: prepared.workerStart.runId,
        reworkRunId: reworkStartResult.code?.run?.id,
      });
      const fullReworkStart = await getWorkbenchSchedulerWorkerReworkStartProjection(
        { project: project(), path: getTempDir() },
        prepared.topic.changeId,
        prepared.schedulerRun.id,
        reworkStartResult.reworkStart?.id,
      );
      expect(fullReworkStart).toMatchObject({
        id: reworkStartResult.reworkStart?.id,
        schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
        worktreeId: prepared.workerStart.worktreeId,
      });
      expect((await listRuns(prepared.runtimePaths)).filter((run) => run.changeId === prepared.topic.changeId)).toHaveLength(afterValidationRunCount + 1);
      expect(await listWorktreeStatuses(prepared.runtimePaths)).toHaveLength(afterValidationWorktreeCount);
      expect(await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationTaskRunCount + 1);
      expect(await listWorkerLeases(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationLeaseCount + 1);
      expect(await listTaskQueues(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listWorkflowRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listAgentTasks(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      const reworkRun = (await listRuns(prepared.runtimePaths)).find((run) => run.id === reworkStartResult.code?.run?.id);
      expect(reworkRun).toMatchObject({
        changeId: prepared.topic.changeId,
        agent: { roleId: "rework-coder" },
        executionGate: expect.objectContaining({
          mode: "scheduler-claim-rework",
          schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
          schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
        }),
      });
      const afterStartSnapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      expect(afterStartSnapshot.center.workpad.schedulerWorkerReworkStart).toMatchObject({
        id: reworkStartResult.reworkStart?.id,
        status: "started",
        worktreeId: prepared.workerStart.worktreeId,
      });
      expect(afterStartSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.rework-start-first")).toBe(false);
      const reworkResultAction = afterStartSnapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.rework-reconcile-result", (candidate) => candidate.schedulerWorkerReworkStartId === reworkStartResult.reworkStart?.id));
      if (!reworkResultAction) throw new Error("Missing scheduler first worker rework result reconcile action.");
      expect(reworkResultAction).toMatchObject({
        schedulerRunId: prepared.schedulerRun.id,
        schedulerClaimReservationId: prepared.claimReservation.id,
        schedulerWorkerStartId: prepared.workerStart.id,
        schedulerWorkerResultId: prepared.workerResult.id,
        schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
        schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
        schedulerWorkerReworkStartId: reworkStartResult.reworkStart?.id,
        taskRunId: reworkStartResult.reworkStart?.reworkTaskRunId,
        workerLeaseId: reworkStartResult.reworkStart?.reworkWorkerLeaseId,
        worktreeId: prepared.workerStart.worktreeId,
        runId: reworkStartResult.reworkStart?.reworkRunId,
      });

      const reconciledRework = await executeWorkbenchAction({ project: project(), path: getTempDir() }, {
        ...reworkResultAction,
        confirm: true,
      });
      const reconciledReworkResult = unwrapWorkflowActionResult(reconciledRework.result) as {
        status?: string;
        result?: {
          id?: string;
          status?: string;
          schedulerWorkerReworkStartId?: string;
          reworkTaskRunId?: string;
          reworkWorkerLeaseId?: string;
          worktreeId?: string;
          reworkRunId?: string;
          taskRunStatus?: string;
          workerLeaseStatus?: string;
        };
      };
      expect(reconciledReworkResult).toMatchObject({
        status: "terminal",
        result: {
          status: "evidence-ready",
          schedulerWorkerReworkStartId: reworkStartResult.reworkStart?.id,
          reworkTaskRunId: reworkStartResult.reworkStart?.reworkTaskRunId,
          reworkWorkerLeaseId: reworkStartResult.reworkStart?.reworkWorkerLeaseId,
          worktreeId: prepared.workerStart.worktreeId,
          reworkRunId: reworkStartResult.reworkStart?.reworkRunId,
          taskRunStatus: "evidence-ready",
          workerLeaseStatus: "released",
        },
      });
      const reworkResultPath = join(prepared.schedulerRunRoot, "scheduler-worker-rework-results", `${reconciledReworkResult.result?.id}.json`);
      const reworkResultJson = JSON.parse(await readFile(reworkResultPath, "utf8"));
      expect(reworkResultJson).toMatchObject({
        id: reconciledReworkResult.result?.id,
        changeId: prepared.topic.changeId,
        schedulerRunId: prepared.schedulerRun.id,
        schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
        schedulerWorkerReworkStartId: reworkStartResult.reworkStart?.id,
        worktreeId: prepared.workerStart.worktreeId,
        reworkRunId: reworkStartResult.reworkStart?.reworkRunId,
        status: "evidence-ready",
      });
      const fullReworkResult = await getWorkbenchSchedulerWorkerReworkResultProjection(
        { project: project(), path: getTempDir() },
        prepared.topic.changeId,
        prepared.schedulerRun.id,
        reconciledReworkResult.result?.id,
      );
      expect(fullReworkResult).toMatchObject({
        id: reconciledReworkResult.result?.id,
        status: "evidence-ready",
        schedulerWorkerReworkStartId: reworkStartResult.reworkStart?.id,
      });
      expect((await listRuns(prepared.runtimePaths)).filter((run) => run.changeId === prepared.topic.changeId)).toHaveLength(afterValidationRunCount + 1);
      expect(await listWorktreeStatuses(prepared.runtimePaths)).toHaveLength(afterValidationWorktreeCount);
      expect(await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationTaskRunCount + 1);
      expect((await listWorkerLeases(prepared.runtimePaths, prepared.topic.changeId)).find((lease) => lease.id === reworkStartResult.reworkStart?.reworkWorkerLeaseId)).toMatchObject({ status: "released" });
      expect(await listTaskQueues(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listWorkflowRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listAgentTasks(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      const afterReworkResultSnapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      expect(afterReworkResultSnapshot.center.workpad.schedulerWorkerReworkResult).toMatchObject({
        id: reconciledReworkResult.result?.id,
        status: "evidence-ready",
        worktreeId: prepared.workerStart.worktreeId,
      });
      expect(afterReworkResultSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.rework-reconcile-result")).toBe(false);
      expect(afterReworkResultSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.validate-first" || action.actionType === "planning.scheduler.worker.audit-first")).toBe(false);
      const reworkValidationAction = afterReworkResultSnapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.rework-validate-first", (candidate) => candidate.schedulerWorkerReworkResultId === reconciledReworkResult.result?.id));
      if (!reworkValidationAction) throw new Error("Missing scheduler first worker rework validation action.");
      expect(reworkValidationAction).toMatchObject({
        schedulerRunId: prepared.schedulerRun.id,
        schedulerClaimReservationId: prepared.claimReservation.id,
        schedulerWorkerStartId: prepared.workerStart.id,
        schedulerWorkerResultId: prepared.workerResult.id,
        schedulerWorkerValidationId: validatedResult?.schedulerValidation?.id,
        schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
        schedulerWorkerReworkStartId: reworkStartResult.reworkStart?.id,
        schedulerWorkerReworkResultId: reconciledReworkResult.result?.id,
        taskRunId: reworkStartResult.reworkStart?.reworkTaskRunId,
        workerLeaseId: reworkStartResult.reworkStart?.reworkWorkerLeaseId,
        worktreeId: prepared.workerStart.worktreeId,
        runId: reworkStartResult.reworkStart?.reworkRunId,
      });

      const validatedRework = await executeWorkbenchAction({ project: project(), path: getTempDir() }, {
        ...reworkValidationAction,
        confirm: true,
      });
      const validatedReworkResult = unwrapWorkflowActionResult(validatedRework.result) as {
        existing?: boolean;
        status?: "passed" | "failed";
        schedulerReworkValidation?: {
          id?: string;
          status?: string;
          schedulerWorkerReworkResultId?: string;
          schedulerWorkerReworkStartId?: string;
          schedulerWorkerReworkPlanId?: string;
          reworkTaskRunId?: string;
          reworkWorkerLeaseId?: string;
          worktreeId?: string;
          reworkRunId?: string;
          validationRunId?: string;
        };
        taskRun?: { id?: string; status?: string; blockedReason?: string };
        validationResult?: { id?: string; status?: string; worktreeId?: string };
      };
      expect(validatedReworkResult).toMatchObject({
        status: "failed",
        schedulerReworkValidation: {
          status: "failed",
          schedulerWorkerReworkResultId: reconciledReworkResult.result?.id,
          schedulerWorkerReworkStartId: reworkStartResult.reworkStart?.id,
          schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
          reworkTaskRunId: reworkStartResult.reworkStart?.reworkTaskRunId,
          reworkWorkerLeaseId: reworkStartResult.reworkStart?.reworkWorkerLeaseId,
          worktreeId: prepared.workerStart.worktreeId,
          reworkRunId: reworkStartResult.reworkStart?.reworkRunId,
        },
        taskRun: { id: reworkStartResult.reworkStart?.reworkTaskRunId, status: "blocked", blockedReason: "Rework validation failed." },
        validationResult: { status: "failed", worktreeId: prepared.workerStart.worktreeId },
      });
      const reworkValidationPath = join(prepared.schedulerRunRoot, "scheduler-worker-rework-validations", `${validatedReworkResult.schedulerReworkValidation?.id}.json`);
      const reworkValidationJson = JSON.parse(await readFile(reworkValidationPath, "utf8"));
      expect(reworkValidationJson).toMatchObject({
        id: validatedReworkResult.schedulerReworkValidation?.id,
        changeId: prepared.topic.changeId,
        schedulerRunId: prepared.schedulerRun.id,
        schedulerWorkerReworkResultId: reconciledReworkResult.result?.id,
        schedulerWorkerReworkStartId: reworkStartResult.reworkStart?.id,
        schedulerWorkerReworkPlanId: reworkResult.reworkPlan?.id,
        worktreeId: prepared.workerStart.worktreeId,
        reworkRunId: reworkStartResult.reworkStart?.reworkRunId,
        validationRunId: validatedReworkResult.schedulerReworkValidation?.validationRunId,
        status: "failed",
      });
      const fullReworkValidation = await getWorkbenchSchedulerWorkerReworkValidationProjection(
        { project: project(), path: getTempDir() },
        prepared.topic.changeId,
        prepared.schedulerRun.id,
        validatedReworkResult.schedulerReworkValidation?.id,
      );
      expect(fullReworkValidation).toMatchObject({
        id: validatedReworkResult.schedulerReworkValidation?.id,
        status: "failed",
        schedulerWorkerReworkResultId: reconciledReworkResult.result?.id,
      });
      expect((await listRuns(prepared.runtimePaths)).filter((run) => run.changeId === prepared.topic.changeId)).toHaveLength(afterValidationRunCount + 2);
      expect(await listWorktreeStatuses(prepared.runtimePaths)).toHaveLength(afterValidationWorktreeCount);
      expect(await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationTaskRunCount + 1);
      expect((await listWorkerLeases(prepared.runtimePaths, prepared.topic.changeId)).find((lease) => lease.id === reworkStartResult.reworkStart?.reworkWorkerLeaseId)).toMatchObject({ status: "released" });
      expect(await listTaskQueues(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listWorkflowRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listAgentTasks(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      const afterReworkValidationSnapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      expect(afterReworkValidationSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.rework-validate-first")).toBe(false);
      expect(afterReworkValidationSnapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.audit-first" || action.actionType === "planning.scheduler.worker.rework-start-first")).toBe(false);

      await expect(executeWorkbenchAction({ project: project(), path: getTempDir() }, {
        ...reworkValidationAction,
        confirm: true,
      })).rejects.toThrow(/stale|no longer available/i);
    }

    await expect(executeWorkbenchAction({ project: project(), path: getTempDir() }, {
      ...reworkAction,
      confirm: true,
    })).rejects.toThrow(/stale|no longer available/i);
    expect((await listRuns(prepared.runtimePaths)).filter((run) => run.changeId === prepared.topic.changeId)).toHaveLength(afterValidationRunCount + 2);
    expect(await listWorktreeStatuses(prepared.runtimePaths)).toHaveLength(afterValidationWorktreeCount);
    expect(await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationTaskRunCount + 1);
    expect(await listWorkerLeases(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(afterValidationLeaseCount + 1);
    } finally {
      await closeFakeCodexScope();
    }
  }, 180000);
});
