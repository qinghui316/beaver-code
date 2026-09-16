import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../provider-runtime/project-harness-discovery.js";
import type { ProviderRegistry } from "../provider-runtime/registry.js";
import type { ProviderTurnResult } from "../provider-runtime/contracts.js";
import type { ProviderModelRef } from "../provider-runtime/types.js";
import { resolveStoredExecutionContract } from "../provider-runtime/execution-contract.js";
import { createProjectHarnessRuntime, type ProjectHarnessCommandPort } from "../project-harness/runtime.js";
import {
  ensureProjectHarnessOnboardingWorkspace,
  recoverProjectHarnessOnboarding,
  type ProjectHarnessOnboardingResult,
} from "../project-harness/onboarding.js";
import { getCompiledProjectHarnessRuntimeEntry, getProjectHarnessSkillScaffoldRoot, getSystemSkillsRoot } from "../template-source/paths.js";
import { hashNativeSkillPackageContent } from "../skill/content-hash.js";
import type { ManagedProject } from "../types/index.js";
import type { ProjectRuntimeState } from "../project-runtime/coordinator.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import { publishAgentSurfacesInvalidated } from "./project-live-events.js";
import { forwardProviderRealtimeEvent } from "./provider-live-events.js";
import { WorkbenchProjectHarnessOnboardingExecutionStore } from "./project-harness-onboarding-execution.js";
import { publishCommittedCanonicalTimelineRow } from "./canonical-timeline-delivery.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import type { TopicThreadEntry, WorkbenchLiveSink } from "./types.js";
import { defaultProjectRuntimeActivityRegistry } from "../project-runtime/activity.js";

export interface RunProjectHarnessOnboardingTurnOptions {
  providerRegistry: Pick<ProviderRegistry, "requireProfiles">;
  model: ProviderModelRef | null;
  reasoningEffort: string | null;
  compiledRuntimeEntry?: string;
}

export function runProjectHarnessOnboardingTurn(
  project: ManagedProject,
  state: Extract<ProjectRuntimeState, { state: "onboarding" }>,
  conversationId: string,
  userMessage: string,
  options: RunProjectHarnessOnboardingTurnOptions,
  live?: WorkbenchLiveSink,
): Promise<TopicThreadEntry> {
  return defaultProjectRuntimeActivityRegistry.run(project.id, () => runProjectHarnessOnboardingTurnActivity(
    project,
    state,
    conversationId,
    userMessage,
    live,
    options,
  ));
}

async function runProjectHarnessOnboardingTurnActivity(
  project: ManagedProject,
  state: Extract<ProjectRuntimeState, { state: "onboarding" }>,
  conversationId: string,
  userMessage: string,
  live: WorkbenchLiveSink | undefined,
  options: RunProjectHarnessOnboardingTurnOptions,
): Promise<TopicThreadEntry> {
  const registry = options.providerRegistry;
  const workspace = await createOnboardingRuntime(project, state, options.compiledRuntimeEntry);
  const database = await openProjectRuntimeWorkbenchDatabase(state.paths);
  const conversation = database.conversations.readConversation(project.id, conversationId);
  if (!conversation) {
    database.close();
    throw new Error(`Conversation not found: ${conversationId}.`);
  }
  const providerId = conversation.selectedProviderId;
  let resolvedProvider: Awaited<ReturnType<ProviderRegistry["requireProfiles"]>>;
  try {
    resolvedProvider = await registry.requireProfiles(providerId, ["main"], "harness", project, project.path);
  } catch (error) {
    database.close();
    throw error;
  }
  const runId = `onboarding-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const attemptId = `attempt-${randomUUID()}`;
  const runRoot = join(state.paths.runsRoot, runId);
  let attemptCreated = false;
  try {
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "prompt.md"), userMessage, "utf8");
    const now = new Date().toISOString();
    database.providerAttempts.createProviderAttempt({
      projectId: project.id,
      conversationId,
      attemptId,
      graphScopeId: conversation.currentGraphScopeId,
      changeId: null,
      agentTaskId: null,
      roleId: "main-agent",
      operationProfile: "main",
      providerId,
      executionContract: resolveStoredExecutionContract({
        productMode: "harness",
        operationProfile: "main",
        operationKind: "conversation-turn",
        roleId: "main-agent",
        providerAdapterVersion: resolvedProvider.descriptor.adapter.version,
      }),
      nativeSessionId: null,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      capabilitySnapshot: resolvedProvider.snapshot,
      handoffHash: createHash("sha256").update(userMessage).digest("hex"),
      deliveredThroughCompletedTurn: conversation.completedTurnSequence,
      worktreeId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    attemptCreated = true;
    await workspace.executions.assign({ attemptId, roleId: "main-agent" });
  } catch (error) {
    try {
      if (attemptCreated) {
        database.providerAttempts.completeProviderAttempt(project.id, attemptId, "failed", null, new Date().toISOString());
      }
    } finally {
      database.close();
    }
    throw error;
  }
  live?.emit({ event: "run.started", data: { projectId: project.id, productMode: "harness", runId, conversationId, providerId, attemptId, actionType: "project.harness.onboard" } });

  let publication: ProjectHarnessOnboardingResult | null = null;
  let publicationAttempt: Promise<ProjectHarnessOnboardingResult> | null = null;
  let publicationFailure: string | null = null;
  const mainSkillRoot = getSystemSkillsRoot();
  const mainSkillPath = join(mainSkillRoot, "aho-main-orchestration", "SKILL.md");
  const engineeringSkillPath = join(mainSkillRoot, "aho-harness-engineering", "SKILL.md");
  if (!existsSync(mainSkillPath) || !existsSync(engineeringSkillPath)) {
    try {
      database.providerAttempts.completeProviderAttempt(project.id, attemptId, "failed", null, new Date().toISOString());
    } finally {
      database.close();
    }
    throw new Error("AHO bundled Main or Harness Engineering Skill is unavailable.");
  }
  const [mainSkillHash, engineeringSkillHash] = await Promise.all([
    hashNativeSkillPackageContent(dirname(mainSkillPath)),
    hashNativeSkillPackageContent(dirname(engineeringSkillPath)),
  ]);
  const existingBinding = database.providerAttempts.readConversationProviderBinding(project.id, conversationId, providerId);

  let result: ProviderTurnResult;
  let liveMainThreadId: string | null = null;
  try {
    result = await resolvedProvider.descriptor.conversation.runTurn({
      providerId,
      operationProfile: "main",
      projectId: project.id,
      conversationId,
      graphScopeId: conversation.currentGraphScopeId ?? undefined,
      runtimeScopeId: conversationId,
      roleId: "main-agent",
      runId,
      attemptId,
      cwd: project.path,
      prompt: userMessage,
      sandboxPolicy: "workspace-write",
      writableRoots: [workspace.workspace.bundleRoot],
      runtimeWorkspaceRoots: [project.path, workspace.workspace.bundleRoot],
      additionalContext: {
        "aho.project": {
          kind: "application",
          value: JSON.stringify({ projectId: project.id, projectRoot: project.path }),
        },
        "aho.harness-onboarding": {
          kind: "application",
          value: JSON.stringify({
            mode: "onboard",
            state: "missing",
            bundleRoot: workspace.workspace.bundleRoot,
            requiredFiles: ["project-profile.json", "architecture.json", "audit.json", "creation-delta.json"],
            prepareTool: "aho_prepare_project_harness",
            sourceWritesAllowed: false,
          }),
        },
      },
      nativeSkillRoots: [mainSkillRoot],
      requiredNativeSkills: ["aho-main-orchestration", "aho-harness-engineering"],
      skillInputs: [
        { id: "aho-main-orchestration", path: mainSkillPath, contentHash: mainSkillHash, source: "aho-system", required: true },
        { id: "aho-harness-engineering", path: engineeringSkillPath, contentHash: engineeringSkillHash, source: "aho-system", required: true },
      ],
      tools: [{
        name: "aho_prepare_project_harness",
        description: "Validate the complete bundle assigned to this Main attempt, request an independent Auditor review, and atomically publish the initial project Harness. This tool accepts no caller-selected target.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      onToolCall: async (call) => {
        if (call.tool !== "aho_prepare_project_harness" || Object.keys(call.arguments).length > 0) {
          return { contentItems: [{ type: "inputText", text: "Only the exact project Harness onboarding tool is available before doctor and audit are healthy." }], success: false };
        }
        publicationAttempt ??= (async () => {
          const recovered = await recoverProjectHarnessOnboarding(
            project.id,
            project.path,
            state.paths.sidecarRoot,
            DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
          );
          if (!recovered || recovered.stage === "rolled-back") {
            await workspace.runtime.project.init.prepare(attemptId);
          }
          const prepared = await recoverProjectHarnessOnboarding(
            project.id,
            project.path,
            state.paths.sidecarRoot,
            DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
          );
          if (!prepared || prepared.stage === "completed") {
            throw new Error("Project Harness onboarding has no reviewable prepared candidate.");
          }
          const reviewerAttemptId = await runIndependentBundleReview({
            project,
            state,
            conversationId,
            graphScopeId: conversation.currentGraphScopeId,
            providerId,
            authorAttemptId: prepared.author_id,
            record: prepared,
            workspace,
            registry,
          });
          publication = await workspace.runtime.project.init.publish(reviewerAttemptId);
          return publication;
        })();
        try {
          const published = await publicationAttempt;
          return {
            contentItems: [{
              type: "inputText",
              text: `Project Harness revision ${published.record.stage === "completed" ? published.discovery.handle.skillRevision : 1} is published and doctor/audit are healthy.`,
            }],
            success: true,
          };
        } catch (error) {
          publicationFailure = message(error);
          return { contentItems: [{ type: "inputText", text: publicationFailure }], success: false };
        }
      },
      existingSession: existingBinding?.nativeSessionId
        ? {
            providerId,
            sessionId: existingBinding.nativeSessionId,
          }
        : null,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      paths: providerPaths(runRoot),
      onRealtimeEvent: (event) => {
        if (!event.parentThreadId && event.threadId && liveMainThreadId !== event.threadId) {
          database.providerAttempts.bindProviderAttemptThread(project.id, {
            attemptId,
            threadId: event.threadId,
            parentThreadId: null,
            parentAgentSurfaceId: null,
            displayName: event.displayName,
          }, new Date().toISOString());
          liveMainThreadId = event.threadId;
          publishAgentSurfacesInvalidated(project.id, { conversationId, graphScopeId: conversation.currentGraphScopeId ?? undefined, reason: "thread-bound" });
        }
        forwardProviderRealtimeEvent(event, live, { productMode: "harness" });
      },
    });
  } catch (error) {
    try {
      database.providerAttempts.completeProviderAttempt(project.id, attemptId, "failed", liveMainThreadId, new Date().toISOString());
    } finally {
      database.close();
    }
    throw error;
  }

  const completedAt = new Date().toISOString();
  const terminalStatus = publicationFailure ? "failed" : result.status;
  const text = publicationFailure ?? (
    result.lastMessage.trim()
    || (publication ? "Project Harness onboarding completed." : "Project Harness onboarding still needs a complete reviewed bundle.")
  );
  const assistant: TopicThreadEntry = {
    id: `assistant:${conversationId}:${attemptId}`,
    type: "assistant.message",
    timestamp: completedAt,
    conversationId,
    graphScopeId: conversation.currentGraphScopeId ?? undefined,
    changeId: "",
    runId,
    providerId,
    threadId: result.session?.sessionId,
    turnId: result.turnId ?? undefined,
    agentRoleId: "main-agent",
    agentSurfaceId: "main-agent",
    text,
    status: terminalStatus,
  };
  let terminal: ReturnType<typeof database.unitOfWork.commitProviderTurnTerminal>;
  try {
    terminal = database.unitOfWork.commitProviderTurnTerminal({
      projectId: project.id,
      conversationId,
      runId,
      mainAttemptId: attemptId,
      expectedGraphScopeId: conversation.currentGraphScopeId!,
      mainStatus: terminalStatus,
      mainNativeSessionId: result.session?.sessionId ?? null,
      childAttempts: [],
      expectedCompletedTurnSequence: conversation.completedTurnSequence,
      advanceCompletedTurn: terminalStatus === "completed",
      binding: {
        projectId: project.id,
        conversationId,
        providerId,
        nativeSessionId: result.session?.sessionId ?? null,
        preferredModel: options.model,
        lastUsedAt: completedAt,
        bindingStatus: terminalStatus === "completed" ? "ready" : "stale",
      },
      updatedAt: completedAt,
      timelineMessages: [toCanonicalTimelineMessage(project.id, conversationId, assistant)],
    });
  } catch (error) {
    try {
      database.providerAttempts.completeProviderAttempt(project.id, attemptId, "failed", result.session?.sessionId ?? null, completedAt);
    } finally {
      database.close();
    }
    throw error;
  }
  database.close();
  for (const row of terminal.timelineRows) publishCommittedCanonicalTimelineRow(live, row, "harness");
  publishAgentSurfacesInvalidated(project.id, { conversationId, graphScopeId: conversation.currentGraphScopeId ?? undefined, reason: "attempt-updated" });
  return assistant;
}

async function createOnboardingRuntime(
  project: ManagedProject,
  state: Extract<ProjectRuntimeState, { state: "onboarding" }>,
  compiledRuntimeEntry?: string,
) {
  const executions = new WorkbenchProjectHarnessOnboardingExecutionStore(project.id, project.path, state.paths);
  const unavailable: ProjectHarnessCommandPort = {
    async run() {
      throw new Error("Daily project Harness commands are unavailable until onboarding completes.");
    },
  };
  await recoverProjectHarnessOnboarding(
    project.id,
    project.path,
    state.paths.sidecarRoot,
    DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  );
  const workspace = await ensureProjectHarnessOnboardingWorkspace(project.id, project.path, state.paths.sidecarRoot);
  const runtime = createProjectHarnessRuntime({
    projectId: project.id,
    projectRoot: project.path,
    skillRoot: join(project.path, ".agents", "skills", `${project.id}-harness`),
    sidecarRoot: state.paths.sidecarRoot,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    change: unavailable,
    registry: { async preflight() { throw new Error("Registry is unavailable until onboarding completes."); } },
    integration: unavailable,
    evolution: unavailable,
    onboarding: {
      executions,
      scaffoldRoot: getProjectHarnessSkillScaffoldRoot(),
      compiledRuntimeEntry: compiledRuntimeEntry ?? getCompiledProjectHarnessRuntimeEntry(),
    },
  });
  return { executions, runtime, workspace };
}

async function runIndependentBundleReview(input: {
  project: ManagedProject;
  state: Extract<ProjectRuntimeState, { state: "onboarding" }>;
  conversationId: string;
  graphScopeId: string | null;
  providerId: string;
  authorAttemptId: string;
  record: NonNullable<Awaited<ReturnType<typeof recoverProjectHarnessOnboarding>>>;
  workspace: Awaited<ReturnType<typeof createOnboardingRuntime>>;
  registry: Pick<ProviderRegistry, "requireProfiles">;
}): Promise<string> {
  const resolved = await input.registry.requireProfiles(input.providerId, ["auditor"], "harness", input.project, input.project.path);
  const attemptId = `attempt-${randomUUID()}`;
  const runId = `onboarding-review-${randomUUID()}`;
  const runRoot = join(input.state.paths.runsRoot, runId);
  await mkdir(runRoot, { recursive: true });
  const now = new Date().toISOString();
  const database = await openProjectRuntimeWorkbenchDatabase(input.state.paths);
  try {
    database.providerAttempts.createProviderAttempt({
      projectId: input.project.id,
      conversationId: input.conversationId,
      attemptId,
      graphScopeId: input.graphScopeId,
      changeId: null,
      agentTaskId: null,
      roleId: "auditor-agent",
      operationProfile: "auditor",
      providerId: input.providerId,
      executionContract: resolveStoredExecutionContract({
        productMode: "harness",
        operationProfile: "auditor",
        operationKind: "conversation-turn",
        roleId: "auditor-agent",
        providerAdapterVersion: resolved.descriptor.adapter.version,
      }),
      nativeSessionId: null,
      model: resolved.snapshot.effectiveModel ? { providerId: input.providerId, modelId: resolved.snapshot.effectiveModel } : null,
      capabilitySnapshot: resolved.snapshot,
      handoffHash: input.record.candidate_fingerprint,
      deliveredThroughCompletedTurn: 0,
      worktreeId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    database.close();
  }
  try {
    await input.workspace.executions.assign({ attemptId, roleId: "auditor-agent" });
    const prompt = [
      "Independently review the prepared project Harness candidate against the complete bundle and current project source.",
      "Do not modify the candidate, bundle, or project source.",
      `Write exactly one JSON report to: ${input.workspace.workspace.reviewPath}`,
      `schema_version=1.0, kind=full-bundle-review, candidate_fingerprint=${input.record.candidate_fingerprint}`,
      `source_snapshot_digest=${input.record.source_snapshot_digest}, author_id=${input.authorAttemptId}, reviewer_id=${attemptId}`,
      "decision must be approve or block; findings entries require severity, area, evidence, recommendation, and text; reviewed_at must be an offset datetime.",
    ].join("\n");
    await writeFile(join(runRoot, "prompt.md"), prompt, "utf8");
    const result = await resolved.descriptor.leafExecution.runTurn({
      providerId: input.providerId,
      operationProfile: "auditor",
      projectId: input.project.id,
      conversationId: input.conversationId,
      graphScopeId: input.graphScopeId ?? undefined,
      runtimeScopeId: runId,
      roleId: "auditor-agent",
      runId,
      attemptId,
      cwd: input.project.path,
      prompt,
      sandboxPolicy: "workspace-write",
      writableRoots: [input.workspace.workspace.reviewRoot],
      runtimeWorkspaceRoots: [
        input.project.path,
        input.workspace.workspace.bundleRoot,
        input.record.candidate_root,
        input.workspace.workspace.reviewRoot,
      ],
      skillInputs: [{
        id: input.record.skill_name,
        path: join(input.record.candidate_root, "SKILL.md"),
        contentHash: input.record.candidate_fingerprint,
        source: "project-harness",
        required: true,
      }],
      nativeSkillRoots: [dirname(input.record.candidate_root)],
      requiredNativeSkills: [input.record.skill_name],
      paths: providerPaths(runRoot),
    });
    if (result.status !== "completed") {
      throw new Error(`Independent project Harness review did not complete: ${result.error ?? result.status}`);
    }
    if (!existsSync(input.workspace.workspace.reviewPath)) {
      throw new Error("Independent project Harness review did not produce the assigned report.");
    }
    await completeOnboardingAttempt(
      input.state,
      input.project.id,
      attemptId,
      "completed",
      result.session?.sessionId ?? null,
    );
    return attemptId;
  } catch (error) {
    await completeOnboardingAttempt(input.state, input.project.id, attemptId, "failed", null);
    throw error;
  }
}

async function completeOnboardingAttempt(
  state: Extract<ProjectRuntimeState, { state: "onboarding" }>,
  projectId: string,
  attemptId: string,
  status: "completed" | "interrupted" | "failed",
  sessionId: string | null,
): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(state.paths);
  try {
    database.providerAttempts.completeProviderAttempt(projectId, attemptId, status, sessionId, new Date().toISOString());
  } finally {
    database.close();
  }
}

function providerPaths(root: string) {
  return {
    events: join(root, "provider-events.jsonl"),
    stderr: join(root, "provider-stderr.log"),
    lastMessage: join(root, "last-message.md"),
    session: join(root, "provider-session.json"),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
