import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeWorkbenchAction as executeWorkbenchActionRaw } from "../../src/server/workbench-server.js";
import { getWorkbenchSnapshot } from "../../src/workbench/projections/read-model/implementation.js";
import { listAgentTasks } from "../../src/agent-task/manager.js";
import { listWorktreeStatuses } from "../../src/worktree/manager.js";
import { listTaskQueues } from "../../src/task-queue/manager.js";
import { listTaskRuns } from "../../src/task-run/manager.js";
import { listWorkflowRuns } from "../../src/workflow-run/manager.js";
import { readSchedulerRuntimeEvents } from "../../src/scheduler-runtime/manager.js";
import { listIntegrationChecks } from "../../src/integration-check/manager.js";
import { createTestConversationTurnRouter } from "../helpers/conversation-change-fixture.js";
import { prepareSkillNativeSchedulerFirstWorkerThroughResult } from "../helpers/skill-native-scheduler-fixture.js";
import { createFakeCodex, enterFakeCodexScope, execFileAsync, findSchedulerGateAction, getTempDir, project, unwrapWorkflowActionResult } from "../helpers/skill-native-test-environment.js";

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

describe("workbench scheduler two-worker integration slow flow", () => {
  it("carries a second scheduler worker through current-worker gates and hands refreshed ready targets to IntegrationCheck", async () => {
    const fakeCodex = await createFakeCodex();
    const closeFakeCodexScope = enterFakeCodexScope(fakeCodex);
    try {
      const prepared = await prepareSkillNativeSchedulerFirstWorkerThroughResult({
        title: "Scheduler Two Worker Acceptance",
        fakeCodex,
      });

      let snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      const firstValidationActions = snapshot.right.confirmationQueue.current.flatMap((item) => item.actions);
      const firstValidationAction = snapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.validate-first", (candidate) => candidate.schedulerWorkerResultId === prepared.workerResult.id));
      if (!firstValidationAction) {
        throw new Error(`Missing first worker validation action. workerResultId=${prepared.workerResult.id}; actions=${JSON.stringify(firstValidationActions.map((action) => ({
          actionType: action.actionType,
          schedulerWorkerResultId: action.schedulerWorkerResultId,
          schedulerWorkerStartId: action.schedulerWorkerStartId,
          schedulerWorkerValidationId: action.schedulerWorkerValidationId,
          enabled: action.enabled,
        })))}`);
      }
      const firstValidation = await executeWorkbenchAction({ project: project(), path: getTempDir() }, { ...firstValidationAction, confirm: true });
      const firstValidationResult = unwrapWorkflowActionResult(firstValidation.result) as {
        schedulerValidation?: { id?: string; validationRunId?: string };
      };

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      const firstAuditAction = snapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.audit-first", (candidate) => candidate.schedulerWorkerValidationId === firstValidationResult?.schedulerValidation?.id));
      if (!firstAuditAction) throw new Error("Missing first worker audit action.");
      const firstAudit = await executeWorkbenchAction({ project: project(), path: getTempDir() }, { ...firstAuditAction, confirm: true });
      const firstAuditResult = unwrapWorkflowActionResult(firstAudit.result) as {
        schedulerAudit?: { id?: string; status?: string; claimIntentId?: string; worktreeId?: string };
        auditResult?: { status?: string; artifacts?: { auditMarkdown?: string } };
      };
      expect(firstAuditResult.schedulerAudit).toMatchObject({
        id: expect.any(String),
        status: "approved",
        worktreeId: prepared.workerStart.worktreeId,
      });
      expect(firstAuditResult.auditResult).toMatchObject({ status: "approved" });
      const firstAuditMarkdown = firstAuditResult.auditResult?.artifacts?.auditMarkdown;
      if (!firstAuditMarkdown) throw new Error(`First audit has no response artifact: ${JSON.stringify(firstAuditResult)}`);
      expect(await readFile(resolve(prepared.runtimePaths.sidecarRoot, firstAuditMarkdown), "utf8")).toContain("Scheduler worker audit passed.");
      await rm(join(getTempDir(), "README.md"), { force: true });
      const firstSourceStatus = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: getTempDir() });
      if (firstSourceStatus.stdout.trim()) throw new Error(`source dirty before first candidate: ${firstSourceStatus.stdout}`);

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      const firstWorkerTerminalActions = snapshot.right.confirmationQueue.current.flatMap((item) => item.actions);
      const forbiddenBeforeSameWaveTerminal = new Set([
        "planning.scheduler.integration-candidate.compile",
        "planning.scheduler.integration-check.run",
        "planning.scheduler.run.complete",
        "planning.scheduler.run.close-blocked",
      ]);
      expect(firstWorkerTerminalActions.some((action) => action.actionType && forbiddenBeforeSameWaveTerminal.has(action.actionType))).toBe(false);

      const secondStart = { workerStart: prepared.secondWorkerStart };
      expect(secondStart.workerStart).toMatchObject({
        schedulerClaimReservationId: prepared.claimReservation.id,
      });
      expect(secondStart.workerStart?.id).not.toBe(prepared.workerStart.id);
      expect(secondStart.workerStart?.worktreeId).not.toBe(prepared.workerStart.worktreeId);

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      expect(snapshot.center.workpad.nextAction).toMatchObject({
        actionType: "planning.scheduler.worker.reconcile-result",
        label: "检查当前 worker 结果",
        schedulerWorkerStartId: secondStart.workerStart?.id,
      });
      const secondResultAction = snapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.reconcile-result", (candidate) => candidate.schedulerWorkerStartId === secondStart.workerStart?.id));
      if (!secondResultAction) throw new Error("Missing second worker result reconcile action.");
      const secondResult = await executeWorkbenchAction({ project: project(), path: getTempDir() }, { ...secondResultAction, confirm: true });
      const secondWorkerResult = unwrapWorkflowActionResult(secondResult.result) as {
        result?: {
          result?: { id?: string; status?: string };
          taskRun?: { id?: string; status?: string };
          lease?: { id?: string; status?: string };
        };
      };
      expect(secondWorkerResult).toMatchObject({
        result: { status: "evidence-ready", id: expect.any(String) },
        taskRun: { id: secondStart.workerStart?.taskRunId, status: "evidence-ready" },
        lease: { id: secondStart.workerStart?.workerLeaseId, status: "released" },
      });

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      const secondValidationAction = snapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.validate-first", (candidate) => candidate.schedulerWorkerResultId === secondWorkerResult?.result?.id));
      if (!secondValidationAction) throw new Error("Missing second worker validation action.");
      expect(secondValidationAction).toMatchObject({
        schedulerWorkerStartId: secondStart.workerStart?.id,
        taskRunId: secondStart.workerStart?.taskRunId,
        worktreeId: secondStart.workerStart?.worktreeId,
        runId: secondStart.workerStart?.runId,
      });
      const secondValidation = await executeWorkbenchAction({ project: project(), path: getTempDir() }, { ...secondValidationAction, confirm: true });
      const secondValidationResult = unwrapWorkflowActionResult(secondValidation.result) as {
        result?: {
          schedulerValidation?: { id?: string; status?: string; validationRunId?: string };
          taskRun?: { id?: string; status?: string };
        };
      };
      expect(secondValidationResult).toMatchObject({
        schedulerValidation: { status: "passed", id: expect.any(String) },
        taskRun: { id: secondStart.workerStart?.taskRunId, status: "evidence-ready" },
      });

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      const secondAuditAction = snapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.audit-first", (candidate) => candidate.schedulerWorkerValidationId === secondValidationResult?.schedulerValidation?.id));
      if (!secondAuditAction) throw new Error("Missing second worker audit action.");
      expect(secondAuditAction).toMatchObject({
        schedulerWorkerStartId: secondStart.workerStart?.id,
        schedulerWorkerResultId: secondWorkerResult?.result?.id,
        schedulerWorkerValidationId: secondValidationResult?.schedulerValidation?.id,
        validationRunId: secondValidationResult?.schedulerValidation?.validationRunId,
        worktreeId: secondStart.workerStart?.worktreeId,
      });
      const secondAudit = await executeWorkbenchAction({ project: project(), path: getTempDir() }, { ...secondAuditAction, confirm: true });
      const secondAuditResult = unwrapWorkflowActionResult(secondAudit.result) as {
        schedulerAudit?: { id?: string; status?: string; claimIntentId?: string; worktreeId?: string };
        taskRun?: { id?: string; status?: string };
      };
      expect(secondAuditResult).toMatchObject({
        schedulerAudit: {
          status: "approved",
          id: expect.any(String),
          worktreeId: secondStart.workerStart?.worktreeId,
        },
        taskRun: { id: secondStart.workerStart?.taskRunId, status: "completed" },
      });
      await rm(join(getTempDir(), "README.md"), { force: true });

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      expect(snapshot.center.workpad.nextAction).toMatchObject({
        actionType: "planning.scheduler.integration-candidate.compile",
        label: "生成 scheduler integration 候选",
        schedulerRunId: prepared.schedulerRun.id,
      });
      expect(snapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => action.actionType === "planning.scheduler.worker.start-next")).toBe(false);
      const refreshedCandidateAction = snapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.integration-candidate.compile", (candidate) => candidate.schedulerRunId === prepared.schedulerRun.id));
      if (!refreshedCandidateAction) throw new Error("Missing refreshed scheduler integration candidate action.");
      const refreshedCandidateResult = await executeWorkbenchAction({ project: project(), path: getTempDir() }, { ...refreshedCandidateAction, confirm: true });
      const refreshedCandidateWorkflow = refreshedCandidateResult.result as { status?: string; error?: string; result?: unknown };
      if (refreshedCandidateWorkflow.status === "failed") throw new Error(refreshedCandidateWorkflow.error ?? "refreshed candidate action failed");
      expect(refreshedCandidateWorkflow).toMatchObject({ status: "completed" });
      const refreshedCandidatePayload = unwrapWorkflowActionResult(refreshedCandidateResult.result) as {
        candidate?: {
          id?: string;
          status?: string;
          readyCount?: number;
          blockedCount?: number;
          readyWorktreeIds?: string[];
          outputs?: Array<{ claimIntentId?: string }>;
        };
      };
      const refreshedCandidate = refreshedCandidatePayload.candidate;
      expect(refreshedCandidate).toMatchObject({
        status: "ready",
        readyCount: 2,
        blockedCount: 0,
      });
      expect(refreshedCandidate?.readyWorktreeIds?.sort()).toEqual([prepared.workerStart.worktreeId, secondStart.workerStart?.worktreeId].sort());
      expect(refreshedCandidate?.outputs?.map((output) => output.claimIntentId).sort()).toEqual([prepared.workerStart.claimIntentId, secondStart.workerStart?.claimIntentId].sort());

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      expect(snapshot.center.workpad.nextAction).toMatchObject({
        actionType: "planning.scheduler.integration-check.run",
        schedulerIntegrationCandidateId: refreshedCandidate?.id,
        schedulerRunId: prepared.schedulerRun.id,
      });
      const handoffAction = snapshot.right.confirmationQueue.current
        .flatMap((item) => item.actions)
        .find((action) => findSchedulerGateAction([action], "planning.scheduler.integration-check.run", (candidate) => candidate.schedulerIntegrationCandidateId === refreshedCandidate?.id));
      if (!handoffAction) throw new Error("Missing scheduler IntegrationCheck handoff action.");
      expect(handoffAction).toMatchObject({
        schedulerRunId: prepared.schedulerRun.id,
        schedulerIntegrationCandidateId: refreshedCandidate?.id,
        worktreeIds: expect.arrayContaining(refreshedCandidate?.readyWorktreeIds ?? []),
      });

      await expect(executeWorkbenchAction({ project: project(), path: getTempDir() }, {
        ...handoffAction,
        worktreeIds: [...(handoffAction.worktreeIds ?? []), "forged-worktree"],
        confirm: true,
      })).rejects.toThrow(/stale|scope mismatch|worktreeIds target scope mismatch|forged-worktree/i);
      await expect(listIntegrationChecks(prepared.runtimePaths)).resolves.toHaveLength(0);

      const handoffResult = await executeWorkbenchAction({ project: project(), path: getTempDir() }, { ...handoffAction, confirm: true });
      const handoffWorkflow = handoffResult.result as { status?: string; error?: string; result?: unknown };
      if (handoffWorkflow.status === "failed") throw new Error(handoffWorkflow.error ?? "handoff action failed");
      expect(handoffWorkflow).toMatchObject({ status: "completed" });
      const handoff = unwrapWorkflowActionResult(handoffResult.result) as {
        handoff?: {
          id?: string;
          schedulerIntegrationCandidateId?: string;
          readyWorktreeIds?: string[];
          resultTargetWorktreeIds?: string[];
          integrationCheckId?: string;
        };
        integrationCheck?: { id?: string; status?: string; summary?: string; blockingIssues?: string[]; resultTargets?: Array<{ worktreeId?: string }> };
      };
      if (handoff.integrationCheck?.status !== "passed") {
        throw new Error(`Scheduler IntegrationCheck did not pass: ${JSON.stringify(handoff.integrationCheck)}`);
      }
      expect(handoff.handoff).toMatchObject({
        schedulerIntegrationCandidateId: refreshedCandidate?.id,
        readyWorktreeIds: expect.arrayContaining(refreshedCandidate?.readyWorktreeIds ?? []),
        resultTargetWorktreeIds: expect.arrayContaining(refreshedCandidate?.readyWorktreeIds ?? []),
        integrationCheckId: handoff.integrationCheck?.id,
      });
      expect(handoff.integrationCheck?.resultTargets?.map((target) => target.worktreeId).sort()).toEqual(refreshedCandidate?.readyWorktreeIds?.sort());
      const sourceStatusAfterHandoff = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: getTempDir() });
      expect(sourceStatusAfterHandoff.stdout.trim()).toBe("");

      expect(await listWorkflowRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listTaskQueues(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listAgentTasks(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(0);
      expect(await listTaskRuns(prepared.runtimePaths, prepared.topic.changeId)).toHaveLength(2);
      expect(await listWorktreeStatuses(prepared.runtimePaths)).toHaveLength(2);
      expect(await listIntegrationChecks(prepared.runtimePaths)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: handoff.handoff?.integrationCheckId,
          resultTargets: expect.arrayContaining([
            expect.objectContaining({ worktreeId: prepared.workerStart.worktreeId }),
            expect.objectContaining({ worktreeId: secondStart.workerStart?.worktreeId }),
          ]),
        }),
      ]));

      snapshot = await getWorkbenchSnapshot({ project: project(), path: getTempDir() }, { topicId: prepared.topic.conversationId });
      expect(snapshot.right.confirmationQueue.primary).toMatchObject({
        kind: "integration-apply",
        applyCheckId: handoff.handoff?.integrationCheckId,
      });
      const applyAction = snapshot.right.confirmationQueue.primary?.actions.find((action) => action.action?.actionId === "apply-check.apply")?.action;
      const discardAction = snapshot.right.confirmationQueue.primary?.actions.find((action) => action.action?.actionId === "apply-check.discard")?.action;
      expect(applyAction).toMatchObject({ actionId: "apply-check.apply", command: "apply-check" });
      expect(discardAction).toMatchObject({ actionId: "apply-check.discard", command: "apply-check" });
      expect(snapshot.right.confirmationQueue.primary?.actions.some((action) => action.actionType?.includes("scheduler") || action.action?.actionId?.includes("scheduler"))).toBe(false);
      if (!applyAction || !discardAction) throw new Error("Missing IntegrationCheck apply/discard barrier actions.");
      expect(snapshot.center.workpad.nextAction).toMatchObject({
        kind: "approval",
        enabled: true,
        requiresConfirmation: true,
      });
      expect(snapshot.right.confirmationQueue.current.flatMap((item) => item.actions).some((action) => (
        action.actionType === "planning.scheduler.integration-outcome.reconcile"
        || action.actionType === "planning.scheduler.run.complete"
      ))).toBe(false);
      const schedulerRuntimeEvents = await readSchedulerRuntimeEvents(
        prepared.schedulerArtifacts,
        `state/changes/active/${prepared.topic.changeId}`,
        prepared.schedulerRun.id,
      );
      expect(schedulerRuntimeEvents.filter((event) => event.type === "scheduler-runtime.integration-candidate-compiled")).toHaveLength(1);
      expect(schedulerRuntimeEvents.some((event) => (
        event.type === "scheduler-runtime.integration-check-handoff-completed"
        && event.payload?.schedulerIntegrationCheckHandoffId === handoff.handoff?.id
        && event.payload?.integrationCheckId === handoff.handoff?.integrationCheckId
      ))).toBe(true);
      expect(schedulerRuntimeEvents.some((event) => event.type === "scheduler-runtime.integration-outcome-recorded")).toBe(false);
      expect(schedulerRuntimeEvents.some((event) => event.type === "scheduler-runtime.run-completed")).toBe(false);

      const statusBeforeApply = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: getTempDir() });
      expect(statusBeforeApply.stdout.trim()).toBe("");
      const appliedAction = await executeWorkbenchAction(
        { project: project(), path: getTempDir() },
        { action: applyAction, confirm: true },
      );
      expect(unwrapWorkflowActionResult(appliedAction.result)).toMatchObject({
        check: { id: handoff.handoff?.integrationCheckId, status: "applied" },
      });
      expect((await readFile(join(getTempDir(), "README.md"), "utf8")).trim()).toContain("Scheduler worker fake coder");
      const statusAfterApply = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], { cwd: getTempDir() });
      expect(statusAfterApply.stdout.trim()).not.toBe("");
      expect(await listWorktreeStatuses(prepared.runtimePaths)).toEqual(expect.arrayContaining([
        expect.objectContaining({ worktreeId: prepared.workerStart.worktreeId, status: "applied" }),
        expect.objectContaining({ worktreeId: secondStart.workerStart?.worktreeId, status: "applied" }),
      ]));
      await expect(executeWorkbenchAction(
        { project: project(), path: getTempDir() },
        { action: applyAction, confirm: true },
      )).rejects.toThrow(/stale|available|completed|already/i);
    } finally {
      await closeFakeCodexScope();
    }
  }, 600000);
});
