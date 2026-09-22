import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConversationChangeFixture, createTestConversationTurnRouter } from "./conversation-change-fixture.js";
import { createReadyProjectHarnessFixture } from "./project-harness-fixture.js";
import { writeJsonFile } from "../../src/fs/json.js";
import {
  projectHarnessPlanningStartManifestHash,
  readProjectHarnessPlanningGate,
} from "../../src/project-harness/planning-gate-query.js";
import { resolveProjectRuntimeState } from "../../src/project-runtime/coordinator.js";
import { publishProjectRuntimePlanningPackage } from "../../src/project-runtime/planning-publication.js";
import { getGitCommit, getGitStatusShort } from "../../src/project/git.js";
import type { ProviderCapabilitySnapshot } from "../../src/provider-runtime/index.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../../src/provider-runtime/project-harness-discovery.js";
import { executeWorkbenchAction as executeWorkbenchActionRaw } from "../../src/server/workbench-server.js";
import type { ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import type { ReadySetWorkflowGraphPlan } from "../../src/types/index.js";
import {
  skillNativeSchedulerRunArtifactPaths,
  type SchedulerArtifactStore,
} from "../../src/scheduler-runtime/artifact-store.js";
import { hashWorkflowGraphPlan } from "../../src/workflow-artifacts/hashes.js";
import {
  issueLocalExecutionAuthorization,
} from "../../src/workflow-runtime/execution-authorization.js";
import {
  listSkillNativeSchedulerRuns,
  readSkillNativeReadySetInitialization,
} from "../../src/workflow-runtime/skill-native-ready-set.js";
import { getWorkbenchSnapshot } from "../../src/workbench/projections/read-model/implementation.js";
import { bindProviderAttemptThread, startProviderAttempt } from "../../src/workbench/provider-attempts.js";
import {
  assertFakeCodexSelected,
  findSchedulerGateAction,
  getTempDir,
  git,
  initGitRepository,
  project,
  unwrapWorkflowActionResult,
} from "./skill-native-test-environment.js";

export interface SkillNativePreparedSchedulerWorker {
  id?: string;
  schedulerClaimReservationId?: string;
  reservationIntentId?: string;
  claimIntentId?: string;
  taskRunId?: string;
  workerLeaseId?: string;
  worktreeId?: string;
  runId?: string;
}

export interface SkillNativePreparedSchedulerFlow {
  topic: { changeId: string; conversationId: string };
  graphScopeId: string;
  evidenceRoot: string;
  schedulerRunRoot: string;
  runtimeEventsPath: string;
  runtimePaths: ProjectRuntimePaths;
  schedulerArtifacts: SchedulerArtifactStore;
  skillRoot: string;
  graph: ReadySetWorkflowGraphPlan;
  schedulerRun: { id: string };
  claimReservation: { id: string };
  workerStart: SkillNativePreparedSchedulerWorker;
  secondWorkerStart: SkillNativePreparedSchedulerWorker;
  workerResult: { id?: string; status?: string };
}

export async function prepareSkillNativeSchedulerFirstWorkerThroughResult(options: {
  fakeCodex: { executable: string };
  packageTestScript?: string;
  title?: string;
}): Promise<SkillNativePreparedSchedulerFlow> {
  const projectRoot = getTempDir();
  const ahoHome = join(projectRoot, ".aho-home");
  process.env.AHO_HOME = ahoHome;
  const turnRouter = createTestConversationTurnRouter();
  const executeWorkbenchAction = (
    input: Parameters<typeof executeWorkbenchActionRaw>[0],
    body: Parameters<typeof executeWorkbenchActionRaw>[1],
  ) => executeWorkbenchActionRaw(input, body, undefined, turnRouter);

  await initGitRepository(projectRoot);
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, ".gitignore"), ".aho-home/\n.agents/\n.claude/\nfake-codex-bin/\n", "utf8");
  await writeFile(join(projectRoot, "package.json"), JSON.stringify({
    scripts: { test: options.packageTestScript ?? "node -e \"process.exit(0)\"" },
  }), "utf8");
  await writeFile(join(projectRoot, "src", "module-a.ts"), "export const moduleA = 1;\n", "utf8");
  await writeFile(join(projectRoot, "src", "module-b.ts"), "export const moduleB = 1;\n", "utf8");
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "fixture baseline"]);

  const harness = await createReadyProjectHarnessFixture({
    projectRoot,
    ahoHome,
    projectId: project().id,
    projectName: project().name,
  });
  const topic = await createConversationChangeFixture(harness.project, {
    title: options.title ?? "Parallel Scheduler Worker",
    body: "Split this into independent parallel work across multiple modules.",
  });
  const graphScopeId = `graph:${topic.conversationId}`;
  const specMd = [
    "# Spec",
    "",
    "## Acceptance Criteria",
    "",
    "- AC-001: Update module A and module B through same-wave Scheduler workers.",
    "",
  ].join("\n");
  const tasksMd = [
    "# Tasks",
    "",
    "- [ ] T-001: Update module A.",
    "  - Covers: AC-001",
    "- [ ] T-002: Update module B.",
    "  - Covers: AC-001",
    "",
  ].join("\n");
  const workflowPlan = {
    version: "1.0" as const,
    mode: "ready-set-v1" as const,
    nodes: [{
      id: "module-a",
      title: "Update module A",
      taskIds: ["T-001"],
      acIds: ["AC-001"],
      prompt: "Objective: Update src/module-a.ts. Required behavior: Complete T-001. Constraints: Modify only module A. Expected evidence: Return implementation and verification evidence.",
      dependsOn: [],
      sourceScopes: ["src/module-a.ts"],
    }, {
      id: "module-b",
      title: "Update module B",
      taskIds: ["T-002"],
      acIds: ["AC-001"],
      prompt: "Objective: Update src/module-b.ts. Required behavior: Complete T-002. Constraints: Modify only module B. Expected evidence: Return implementation and verification evidence.",
      dependsOn: [],
      sourceScopes: ["src/module-b.ts"],
    }],
  };
  const planMd = [
    "# Plan",
    "",
    "Run two independent same-wave worker leaves, then stop at the IntegrationCheck apply/discard barrier.",
    "",
    "## Workflow",
    "",
    "```json",
    JSON.stringify(workflowPlan, null, 2),
    "```",
    "",
  ].join("\n");
  const proposalHash = sha256(`${specMd}\n${planMd}\n${tasksMd}`);
  const runtimeState = await resolveProjectRuntimeState(harness.project, {
    ahoHome,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  });
  if (runtimeState.state !== "ready") {
    throw new Error(`Skill-native Scheduler fixture requires a ready runtime: ${runtimeState.state}.`);
  }
  const commitIds = new Set<string>();
  const accepted = await publishProjectRuntimePlanningPackage(runtimeState.resolution, {
    conversationId: topic.conversationId,
    conversationTitle: topic.title,
    boundChangeId: topic.changeId,
    currentGraphScopeId: graphScopeId,
    proposal: {
      id: `proposal-${topic.changeId}`,
      hash: proposalHash,
      artifact: `planner-proposals/${topic.changeId}/plan.md`,
      specMd,
      planMd,
      tasksMd,
    },
    acceptance: {
      version: "1.0",
      proposalHash,
      graphScopeId,
      contractRequired: false,
      contract: null,
      validation: ["Fixture Main accepted the exact ready-set proposal without a Registry contract."],
    },
  }, {
    hasCommit: (transactionId) => commitIds.has(transactionId),
    commit: ({ transactionId }) => { commitIds.add(transactionId); },
    deleteCommit: (transactionId) => { commitIds.delete(transactionId); },
  }, () => graphScopeId);
  if (accepted.workflowGraphPlan.graphMode !== "ready-set-v1") {
    throw new Error("Skill-native Scheduler fixture did not publish a ready-set graph.");
  }

  const refreshed = await resolveProjectRuntimeState(harness.project, {
    ahoHome,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  });
  if (refreshed.state !== "ready") throw new Error(`Published Scheduler fixture is not ready: ${refreshed.state}.`);
  const mainAttemptId = `attempt-main-${topic.conversationId}`;
  const mainThreadId = `fixture-thread-${topic.conversationId}`;
  await startProviderAttempt(refreshed.resolution.paths, {
    attemptId: mainAttemptId,
    providerId: "codex",
    capabilitySnapshot: { providerId: "codex", effectiveModel: null } as unknown as ProviderCapabilitySnapshot,
    operationProfile: "main",
    roleId: "main-agent",
    handoffHash: sha256(`fixture-main-handoff:${topic.conversationId}`),
    conversationId: topic.conversationId,
    changeId: accepted.changeId,
    graphScopeId,
  });
  await bindProviderAttemptThread(refreshed.resolution.paths, {
    attemptId: mainAttemptId,
    threadId: mainThreadId,
    parentThreadId: null,
    parentAgentSurfaceId: null,
  });
  const evidence = await readProjectHarnessPlanningGate({
    projectId: refreshed.resolution.harness.projectId,
    projectRoot,
    skillRoot: harness.skillRoot,
    conversationId: topic.conversationId,
    graphScopeId,
    changeId: accepted.changeId,
  });
  const startManifestHash = projectHarnessPlanningStartManifestHash(
    evidence,
    refreshed.resolution.harness.contentFingerprint,
  );
  const [sourceHead, sourceStatus] = await Promise.all([
    getGitCommit(projectRoot),
    getGitStatusShort(projectRoot),
  ]);
  if (!sourceHead || sourceStatus.length > 0) {
    throw new Error(`Skill-native Scheduler fixture source is not clean: ${sourceStatus.join(", ")}`);
  }
  const graph = accepted.workflowGraphPlan;
  const graphHash = hashWorkflowGraphPlan(graph);
  const authorization = await issueLocalExecutionAuthorization(refreshed.resolution.paths, {
    projectId: refreshed.resolution.harness.projectId,
    changeId: accepted.changeId,
    conversationId: topic.conversationId,
    providerThreadId: mainThreadId,
    goalIdentityHash: sha256(`fixture-goal:${topic.conversationId}`),
    mode: "stepwise",
    acceptedPlanId: accepted.proposalId,
    acceptedPlanHash: accepted.proposalHash,
    graphId: graph.id,
    graphHash,
    artifactManifestHash: hashJson(graph.sourceArtifactHashes),
    sourceHead,
    sourceStateHash: hashJson(sourceStatus),
    providerScopeHash: hashJson({ projectId: harness.project.id, conversationId: topic.conversationId, providerId: "codex" }),
    permissionProfileHash: hashJson({ approvalPolicy: "never", sandbox: "runtime-owned-scoped-write", network: false }),
    policyHash: hashJson("local-execution-authorization-policy-v1"),
    targets: [{
      transition: "workflow.run.start",
      targetId: graph.id,
      manifestHash: startManifestHash,
    }],
    budget: {
      maxCompletedOperations: 32,
      maxReworks: 1,
      maxChangedFiles: 100,
      maxChangedBytes: 10 * 1024 * 1024,
    },
    userDecision: {
      decisionId: `fixture-execute:${topic.conversationId}`,
      actorId: "workbench-user",
      decidedAt: new Date().toISOString(),
    },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const evidenceRoot = join(harness.skillRoot, "state", "changes", "active", accepted.changeId);
  await writeJsonFile(join(evidenceRoot, "planning", "execution-authorization-intent.json"), {
    version: "1.0",
    status: "issued",
    changeId: accepted.changeId,
    conversationId: topic.conversationId,
    proposalId: accepted.proposalId,
    proposalHash: accepted.proposalHash,
    graphId: graph.id,
    authorizationId: authorization.id,
    projectHarnessContentFingerprint: refreshed.resolution.harness.contentFingerprint,
    startManifestHash,
    reason: null,
    updatedAt: new Date().toISOString(),
  });

  let snapshot = await getWorkbenchSnapshot({ project: harness.project, path: projectRoot }, { topicId: topic.conversationId });
  const runAction = snapshot.right.confirmationQueue.current
    .flatMap((item) => item.actions)
    .find((action) => action.actionType === "workflow.run.start");
  if (!runAction) throw new Error("Skill-native Scheduler fixture is missing workflow.run.start.");
  await executeWorkbenchAction({ project: harness.project, path: projectRoot }, { ...runAction, confirm: true });
  const [schedulerRun] = await listSkillNativeSchedulerRuns(refreshed.resolution.paths, accepted.changeId);
  if (!schedulerRun) throw new Error("Skill-native Scheduler fixture did not initialize a SchedulerRun.");
  const initialized = await readSkillNativeReadySetInitialization(
    refreshed.resolution.paths,
    accepted.changeId,
    schedulerRun.id,
    graph,
  );

  snapshot = await getWorkbenchSnapshot({ project: harness.project, path: projectRoot }, { topicId: topic.conversationId });
  const startAction = snapshot.right.confirmationQueue.current
    .flatMap((item) => item.actions)
    .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.start-first", (candidate) => candidate.schedulerClaimReservationId === initialized.claimReservation.id));
  if (!startAction) {
    throw new Error(`Skill-native Scheduler fixture is missing the first worker start action: ${JSON.stringify({
      warnings: snapshot.warnings,
      nextAction: snapshot.center.workpad.nextAction,
      actions: snapshot.right.confirmationQueue.current.flatMap((item) => item.actions),
    })}`);
  }

  assertFakeCodexSelected(options.fakeCodex);
  // The caller owns this runtime scope through preparation and the remaining test actions.
  {
    const started = await executeWorkbenchAction({ project: harness.project, path: projectRoot }, { ...startAction, confirm: true });
    const workerStart = (unwrapWorkflowActionResult(started.result) as { workerStart?: SkillNativePreparedSchedulerWorker }).workerStart ?? {};
    snapshot = await getWorkbenchSnapshot({ project: harness.project, path: projectRoot }, { topicId: topic.conversationId });
    const secondStartAction = snapshot.right.confirmationQueue.current
      .flatMap((item) => item.actions)
      .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.start-next", (candidate) => candidate.schedulerRunId === schedulerRun.id));
    if (!secondStartAction) throw new Error("Skill-native Scheduler fixture is missing the second worker start action.");
    const secondStarted = await executeWorkbenchAction({ project: harness.project, path: projectRoot }, { ...secondStartAction, confirm: true });
    const secondWorkerStart = (unwrapWorkflowActionResult(secondStarted.result) as { workerStart?: SkillNativePreparedSchedulerWorker }).workerStart ?? {};
    snapshot = await getWorkbenchSnapshot({ project: harness.project, path: projectRoot }, { topicId: topic.conversationId });
    const resultAction = snapshot.right.confirmationQueue.current
      .flatMap((item) => item.actions)
      .find((action) => findSchedulerGateAction([action], "planning.scheduler.worker.reconcile-result", (candidate) => candidate.schedulerWorkerStartId === workerStart.id));
    if (!resultAction) {
      throw new Error(`Skill-native Scheduler fixture is missing the first worker result action: ${JSON.stringify({
        warnings: snapshot.warnings,
        nextAction: snapshot.center.workpad.nextAction,
        workerStart,
        secondWorkerStart,
        started: started.result,
        secondStarted: secondStarted.result,
        actions: snapshot.right.confirmationQueue.current.flatMap((item) => item.actions),
      })}`);
    }
    const reconciled = await executeWorkbenchAction({ project: harness.project, path: projectRoot }, { ...resultAction, confirm: true });
    const result = (unwrapWorkflowActionResult(reconciled.result) as { result?: { id?: string; status?: string } }).result ?? {};
    const schedulerRunRoot = join(refreshed.resolution.paths.runsRoot, "scheduler-runs", accepted.changeId, schedulerRun.id);
    return {
      topic: { changeId: accepted.changeId, conversationId: topic.conversationId },
      graphScopeId,
      evidenceRoot,
      schedulerRunRoot,
      runtimeEventsPath: join(schedulerRunRoot, "scheduler-runtime-events.jsonl"),
      runtimePaths: refreshed.resolution.paths,
      schedulerArtifacts: {
        changeId: accepted.changeId,
        changeEvidenceRoot: evidenceRoot,
        planningRoot: join(evidenceRoot, "planning"),
        runtimeRoot: join(refreshed.resolution.paths.runsRoot, "scheduler-runs", accepted.changeId),
        artifactRoots: [harness.skillRoot, refreshed.resolution.paths.sidecarRoot],
        runArtifacts: skillNativeSchedulerRunArtifactPaths(
          join(refreshed.resolution.paths.runsRoot, "scheduler-runs", accepted.changeId),
          schedulerRun.id,
        ),
      },
      skillRoot: harness.skillRoot,
      graph,
      schedulerRun: { id: schedulerRun.id },
      claimReservation: { id: initialized.claimReservation.id },
      workerStart,
      secondWorkerStart,
      workerResult: result,
    };
  }
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
