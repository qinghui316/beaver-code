import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readBundledAgentCatalog } from "../agent/catalog.js";
import { evaluateToolPolicy } from "../agent-task/tool-policy.js";
import type { ProviderModelRef, ProviderRegistry, ProviderTurnResult } from "../provider-runtime/index.js";
import { resolveStoredExecutionContract } from "../provider-runtime/execution-contract.js";
import { agentThreadSurfaceId } from "../provider-runtime/agent-surface-id.js";
import { writeJsonFile } from "../fs/json.js";
import { getGitCommit, getGitStatusShort } from "../project/git.js";
import { hashWorkflowGraphPlan } from "../workflow-artifacts/hashes.js";
import { resolveWithinPhysicalRoot } from "../project-harness/path-safety.js";
import {
  projectHarnessPlanningStartManifestHash,
  readProjectHarnessPlanningGate,
} from "../project-harness/planning-gate-query.js";
import {
  parseMainPlanningAcceptanceEvidence,
  type MainPlanningAcceptanceEvidence,
} from "../project-harness/planning-publication.js";
import { projectHarnessSharedWriterRoot, withProjectHarnessWriterLock } from "../project-harness/writer-lock.js";
import type { ProjectRuntimeResolution } from "../project-runtime/context.js";
import type { ProjectRuntimeState } from "../project-runtime/coordinator.js";
import { requestSkillNativeProjectHarnessChangeFinalization } from "../project-runtime/change-finalization.js";
import { getSystemSkillsRoot } from "../template-source/paths.js";
import { combineTurnSkillHandoffHash } from "../skill/project-skill-runtime-context-resolver.js";
import {
  issueLocalExecutionAuthorization,
  revokeLocalExecutionAuthorization,
} from "../workflow-runtime/execution-authorization.js";
import type { LocalExecutionAuthorization, ManagedProject } from "../types/index.js";
import { buildMainAgentExecutionContext } from "./main-agent-context.js";
import { childTranscriptCapturesForThread, createAssistantTranscriptCapture } from "./live-transcript.js";
import { forwardProviderRealtimeEvent } from "./provider-live-events.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import { publishAgentSurfacesInvalidated } from "./project-live-events.js";
import type { WorkbenchDatabase } from "./persistence/database.js";
import type { StoredConversation, StoredTopicMessage } from "./persistence/contracts.js";
import { CanonicalTimelineDelivery, publishCanonicalTimelineEnvelope, publishCommittedCanonicalTimelineRow } from "./canonical-timeline-delivery.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import {
  buildCanonicalCaptureWrites as buildCaptureWrites,
  childCaptureTimelineStatus as captureChildStatus,
  childProcessMessage as buildChildProcessMessage,
} from "./provider-capture-persistence.js";
import { ProviderChildLifecycleOwner } from "./provider-child-lifecycle-owner.js";
import { listClosableChildAgents, runExactChildAgentClose } from "./provider-child-turn-coordinator.js";
import { ProviderInteractionLifecycleOwner } from "./provider-input-lifecycle.js";
import { assembleSharedConversationContext } from "./shared-conversation-context.js";
import { buildConversationInteractionQueue } from "./conversation-interactions.js";
import { acceptCurrentConversationPlanningPackage, readPlannerChildProposal } from "./planning/planner-child-proposal.js";
import { finalizePlanningChild, PLANNING_AGENT_ROLE_ID } from "./planning-child-lifecycle.js";
import { runProjectHarnessOnboardingTurn } from "./project-harness-onboarding-turn.js";
import type {
  AssistantTurnBlock,
  ValidatedPlanHandoffIntent,
  TopicThreadEntry,
  WorkbenchLiveSink,
} from "./types.js";
import { defaultProjectRuntimeActivityRegistry } from "../project-runtime/activity.js";
import type { ConversationTurnControlOwner, ConversationTurnRegistration } from "./conversation-turn-control.js";
import type { ConversationContextLifecycleOwner } from "./conversation-context-lifecycle.js";
export function buildProjectScopedMainAgentPrompt(userMessage: string): string {
  return userMessage;
}

export function runProjectScopedMainAgentTurn(
  project: ManagedProject,
  conversationId: string,
  userMessage: string,
  live: WorkbenchLiveSink | undefined,
  planHandoff: ValidatedPlanHandoffIntent | undefined,
  options: {
    goalResume?: { deliveryKey: string; contextText: string };
    graphScopeId?: string;
    providerRegistry: ProviderRegistry;
    runtimeState: ProjectRuntimeState;
    turnSkillResolution: import("./conversation-turn-contract.js").TurnSkillContextResolution | null;
    model: ProviderModelRef | null;
    reasoningEffort: string | null;
    turnControl?: ConversationTurnControlOwner;
    contextLifecycle?: ConversationContextLifecycleOwner;
  },
): Promise<TopicThreadEntry> {
  return defaultProjectRuntimeActivityRegistry.run(project.id, () => runProjectScopedMainAgentTurnActivity(
    project,
    conversationId,
    userMessage,
    live,
    planHandoff,
    options,
  ));
}

async function runProjectScopedMainAgentTurnActivity(
  project: ManagedProject,
  conversationId: string,
  userMessage: string,
  live: WorkbenchLiveSink | undefined,
  planHandoff: ValidatedPlanHandoffIntent | undefined,
  options: {
    goalResume?: { deliveryKey: string; contextText: string };
    graphScopeId?: string;
    providerRegistry: ProviderRegistry;
    runtimeState: ProjectRuntimeState;
    turnSkillResolution: import("./conversation-turn-contract.js").TurnSkillContextResolution | null;
    model: ProviderModelRef | null;
    reasoningEffort: string | null;
    turnControl?: ConversationTurnControlOwner;
    contextLifecycle?: ConversationContextLifecycleOwner;
  },
): Promise<TopicThreadEntry> {
  const runtimeState = options.runtimeState;
  if (runtimeState.state === "onboarding") {
    return runProjectHarnessOnboardingTurn(project, runtimeState, conversationId, userMessage, {
      providerRegistry: options.providerRegistry,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    }, live);
  }
  if (runtimeState.state === "repair-required") {
    throw new Error("Project Harness requires repair before planning or source execution.");
  }
  const resolution = runtimeState.resolution;
  const projectId = resolution.harness.projectId;
  const agentCatalog = readBundledAgentCatalog();
  let graphScopeId = options.graphScopeId ?? await currentConversationGraphScope(resolution, conversationId);
  const runId = buildProjectConversationRunId(conversationId);
  const directory = join(resolution.paths.workbenchRoot, "conversations", conversationId, "runs", runId);
  let mainTimelineId = `assistant:${conversationId}:pending:${runId}:main`;
  let canonicalStore: WorkbenchDatabase | null = null;
  let canonicalDelivery: CanonicalTimelineDelivery | null = null;
  let canonicalPersistenceError: Error | null = null;
  let providerId = "";
  let attemptId = "";
  let mainSessionId: string | null = null;
  let completedTurnSequence = 0;
  let boundChangeId: string | null = null;
  let expectedResumeAttemptId: string | null = null;
  const terminalCommittedRows: StoredTopicMessage[] = [];
  const publishTerminalRows = (): number => {
    const count = terminalCommittedRows.length;
    for (const row of terminalCommittedRows.splice(0)) {
      publishCommittedCanonicalTimelineRow(live, row, "harness");
    }
    return count;
  };
  let providerInputLifecycle: ProviderInteractionLifecycleOwner | null = null;
  await mkdir(directory, { recursive: true });
  const capture = createAssistantTranscriptCapture(live, (snapshot) => {
    if (!canonicalDelivery) return true;
    try {
      const writes = buildCaptureWrites({
        projectId,
        conversationId,
        graphScopeId,
        runId,
        providerId,
        attemptId,
        mainTimelineId,
        mainSessionId,
        snapshot,
      });
      for (const write of writes) canonicalDelivery.upsert(write);
      return true;
    } catch (error) {
      canonicalPersistenceError = error instanceof Error ? error : new Error(String(error));
      return false;
    }
  });
  const emitInteractionUpdate = async (sink: WorkbenchLiveSink | undefined = capture.sink): Promise<void> => {
    sink?.emit({ event: "conversation.interactions.updated", data: await buildConversationInteractionQueue(resolution.paths, conversationId, graphScopeId, "harness") });
    publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "interaction-updated" });
  };
  const proposalDirectory = join(directory, "planner-proposal");
  await mkdir(proposalDirectory, { recursive: true });
  const prompt = buildProjectScopedMainAgentPrompt(userMessage);
  const additionalContext: Record<string, { kind: "untrusted" | "application"; value: string }> = {
    "aho.project": {
      kind: "application",
      value: JSON.stringify({
        projectRoot: resolution.projectRoot,
        projectId,
        projectHarnessSkill: resolution.harness.skillName,
        projectHarnessRevision: resolution.harness.skillRevision,
      }),
    },
    "aho.proposal-workspace": {
      kind: "application",
      value: JSON.stringify({ path: proposalDirectory, files: ["spec.md", "plan.md", "tasks.md", "notes.md"] }),
    },
    ...(planHandoff ? {
      "aho.plan-handoff": {
        kind: "application" as const,
        value: JSON.stringify({
          kind: planHandoff.kind,
          executionMode: planHandoff.executionMode,
          sourceRunId: planHandoff.sourceRunId,
          sourceArtifact: planHandoff.sourceArtifact,
          sourceProposalHash: planHandoff.sourceProposalHash,
          graphScopeId,
          feedback: planHandoff.feedback ?? null,
          planText: planHandoff.planText,
        }),
      },
    } : {}),
  };
  const planHandoffResume = planHandoff ? {
    deliveryKey: `plan-handoff:${createHash("sha256").update(JSON.stringify({
      conversationId,
      kind: planHandoff.kind,
      executionMode: planHandoff.executionMode ?? "scoped-auto",
      sourceRunId: planHandoff.sourceRunId,
      sourceArtifact: planHandoff.sourceArtifact,
      feedback: planHandoff.feedback ?? null,
    })).digest("hex")}`,
    contextText: prompt,
  } : undefined;
  await writeFile(join(directory, "prompt.md"), prompt, "utf8");
  let acceptedPlanMarker: TopicThreadEntry | null = null;
  let planDocumentCreated = false;
  let acceptedPlanning: Awaited<ReturnType<typeof acceptCurrentConversationPlanningPackage>> | null = null;
  const sessionStore = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  let conversation: StoredConversation;
  try {
    const storedConversation = sessionStore.conversations.readConversation(projectId, conversationId);
    if (!storedConversation) throw new Error(`Conversation not found: ${conversationId}.`);
    conversation = storedConversation;
    providerId = conversation.selectedProviderId;
    completedTurnSequence = conversation.completedTurnSequence;
    boundChangeId = conversation?.boundChangeId ?? null;
    const binding = sessionStore.providerAttempts.readConversationProviderBinding(projectId, conversationId, providerId);
    mainSessionId = binding?.nativeSessionId ?? null;
    const resumePoint = sessionStore.providerAttempts.readLatestProviderResumePoint(projectId, conversationId);
    expectedResumeAttemptId = resumePoint
      && resumePoint.targetProviderId === providerId
      && resumePoint.graphScopeId === graphScopeId
      && resumePoint.changeId === boundChangeId
      ? `attempt-${resumePoint.resumePointId}`
      : null;
  } finally {
    sessionStore.close();
  }
  const turnSkillResolution = options.turnSkillResolution;
  if (!turnSkillResolution) throw new Error("Workbench Main Agent Turn Skill resolution is not composed.");
  const closableChildAgents = mainSessionId
    ? await listClosableChildAgents({ project, conversationId, graphScopeId, parentThreadId: mainSessionId })
    : [];
  if (closableChildAgents.length > 0) {
    additionalContext["aho.agent-control"] = {
      kind: "application",
      value: JSON.stringify({
        closeTool: "aho_close_agent",
        agents: closableChildAgents,
        rule: "Only call aho_close_agent when the user explicitly asks to close one listed Agent. Do not substitute interrupt_agent.",
      }),
    };
  }
  if (boundChangeId) {
    additionalContext["aho.change-finalization"] = {
      kind: "application",
      value: JSON.stringify({
        finalizeTool: "aho_finalize_current_change",
        changeId: boundChangeId,
        rule: "Only call aho_finalize_current_change after the user explicitly asks to finish the exact current Change. The tool requests a separate human confirmation, revalidates terminal evidence, and accepts no caller-selected target.",
      }),
    };
  }
  const handoff = await assembleSharedConversationContext({
    resolution,
    conversationId,
    providerId: providerId!,
    currentUserMessage: userMessage,
  });
  Object.assign(additionalContext, handoff.context);
  mainTimelineId = `assistant:${conversationId}:${providerId}:${runId}:main`;
  const providerAttempts = await readProviderAttempts(resolution, conversationId);
  const queuedResumeAttempt = attemptStoreCandidate(
    providerAttempts,
    providerId!,
    graphScopeId,
    boundChangeId,
    expectedResumeAttemptId,
  );
  const turnHandoffHash = combineTurnSkillHandoffHash(handoff.hash, turnSkillResolution);
  attemptId = queuedResumeAttempt?.attemptId ?? `attempt-${randomUUID()}`;
  capture.sink.emit({ event: "run.started", data: { projectId, productMode: "harness", runId, conversationId, graphScopeId, providerId, attemptId, actionType: "chat.ask" } });
  capture.sink.emit({ event: "run.status", data: { projectId, productMode: "harness", runId, conversationId, graphScopeId, providerId, attemptId, status: "connecting", label: "正在连接 Agent" } });
  const resolvedProvider = await options.providerRegistry.requireProfiles(providerId!, ["main"], "harness", project, project.path);
  const provider = resolvedProvider.descriptor;
  const capabilitySnapshot = resolvedProvider.snapshot;
  const attemptStartedAt = new Date().toISOString();
  const attemptStore = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    const attemptRecord = {
      projectId,
      conversationId,
      attemptId,
      graphScopeId,
      changeId: boundChangeId,
      agentTaskId: null,
      roleId: "main-agent",
      operationProfile: "main",
      providerId: providerId!,
      executionContract: resolveStoredExecutionContract({
        productMode: "harness",
        operationProfile: "main",
        operationKind: "conversation-turn",
        roleId: "main-agent",
        providerAdapterVersion: provider.adapter.version,
      }),
      nativeSessionId: mainSessionId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      capabilitySnapshot,
      effectiveSkillInputs: [...turnSkillResolution.skillInputs],
      handoffHash: turnHandoffHash,
      deliveredThroughCompletedTurn: completedTurnSequence,
      worktreeId: null,
      status: "running" as const,
      createdAt: attemptStartedAt,
      updatedAt: attemptStartedAt,
    };
    for (const stale of providerAttempts.filter((candidate) =>
      candidate.status === "queued"
      && candidate.attemptId !== queuedResumeAttempt?.attemptId
      && candidate.providerId === providerId
      && candidate.roleId === "main-agent"
      && candidate.operationProfile === "main")) {
      attemptStore.providerAttempts.completeProviderAttempt(projectId, stale.attemptId, "interrupted", stale.nativeSessionId, attemptStartedAt);
    }
    if (queuedResumeAttempt) {
      attemptStore.providerAttempts.startQueuedProviderAttempt(projectId, attemptId, {
        capabilitySnapshot,
        effectiveSkillInputs: [...turnSkillResolution.skillInputs],
        handoffHash: turnHandoffHash,
        deliveredThroughCompletedTurn: completedTurnSequence,
        model: attemptRecord.model,
        updatedAt: attemptStartedAt,
      });
    } else {
      attemptStore.providerAttempts.createProviderAttempt(attemptRecord);
    }
  } finally {
    attemptStore.close();
  }
  publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "attempt-updated" });
  const turnRegistration: ConversationTurnRegistration = {
    projectId,
    productMode: "harness",
    conversationId,
    providerId: providerId!,
    expectedAttemptId: attemptId,
    graphScopeId,
    runId,
    roleId: "main-agent",
    canSteer: capabilitySnapshot.capabilities.some((capability) => capability.key === "turn.steer" && capability.runtime === "ready"),
  };
  canonicalStore = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  canonicalDelivery = new CanonicalTimelineDelivery(canonicalStore, "harness", live);
  if (mainSessionId) {
    canonicalStore.providerAttempts.bindProviderAttemptThread(projectId, {
      attemptId,
      threadId: mainSessionId,
      parentThreadId: null,
      parentAgentSurfaceId: null,
      runId,
    }, attemptStartedAt);
    publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "thread-bound" });
  }
  let liveMainThreadId: string | null = mainSessionId;
  const childLifecycleOwner = new ProviderChildLifecycleOwner({
    database: canonicalStore,
    delivery: canonicalDelivery,
    catalog: agentCatalog,
    projectId,
    conversationId,
    graphScopeId,
    changeId: boundChangeId,
    runId,
    parentAttemptId: attemptId,
    providerId,
    providerAdapterVersion: provider.adapter.version,
    capabilitySnapshot,
    model: capabilitySnapshot.effectiveModel ? { providerId, modelId: capabilitySnapshot.effectiveModel } : null,
    parentHandoffHash: turnHandoffHash,
    deliveredThroughCompletedTurn: completedTurnSequence,
    onInvalidated: () => publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "attempt-updated" }),
  });
  const commitFailedProviderTurn = (database: WorkbenchDatabase, nativeSessionId: string | null): void => {
    const failedAt = new Date().toISOString();
    const timelineMessages = buildCaptureWrites({
      projectId,
      conversationId,
      graphScopeId,
      runId,
      providerId,
      attemptId,
      mainTimelineId,
      mainSessionId: nativeSessionId ?? mainSessionId,
      snapshot: capture,
    }).map((message) => {
      const terminalStatus = message.agentSurfaceId === "main-agent" || message.status === "running" ? "failed" : message.status;
      if (terminalStatus === message.status) return message;
      let raw: Record<string, unknown> = {};
      try { raw = JSON.parse(message.rawJson) as Record<string, unknown>; } catch { /* Keep diagnostic content bounded. */ }
      return { ...message, status: terminalStatus, rawJson: JSON.stringify({ ...raw, status: terminalStatus }) };
    });
    const terminal = database.unitOfWork.commitProviderTurnTerminal({
      projectId,
      conversationId,
      runId,
      mainAttemptId: attemptId,
      expectedGraphScopeId: graphScopeId,
      mainStatus: "failed",
      mainNativeSessionId: nativeSessionId,
      childAttempts: childLifecycleOwner.terminalAttempts("failed"),
      expectedCompletedTurnSequence: completedTurnSequence,
      advanceCompletedTurn: false,
      binding: {
        projectId,
        conversationId,
        providerId,
        nativeSessionId: nativeSessionId ?? mainSessionId,
        preferredModel: options.model,
        lastUsedAt: failedAt,
        bindingStatus: "stale",
      },
      updatedAt: failedAt,
      timelineMessages,
    });
    options.turnControl?.release(turnRegistration);
    publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "attempt-updated" });
    terminalCommittedRows.push(...terminal.timelineRows);
    terminalCommittedRows.push(...terminal.interactionRows);
  };
  let result: ProviderTurnResult;
  providerInputLifecycle = new ProviderInteractionLifecycleOwner({
    runtime: resolution.paths,
    productMode: "harness",
    projectId,
    conversationId,
    graphScopeId,
    runId,
    providerId,
    attemptId,
    runtimeScopeId: conversationId,
    changeId: boundChangeId ?? undefined,
    publisher: (envelope) => publishCanonicalTimelineEnvelope(live, envelope),
    onUpdated: () => emitInteractionUpdate(),
    onError: (error) => {
      canonicalPersistenceError ??= error;
    },
    onUnexpectedApproval: async () => {
      const active = provider.conversation.getActiveTurn(conversationId);
      await active?.interrupt("provider-approval-forbidden-in-harness");
    },
  });
  options.turnControl?.registerAttempt(turnRegistration);
  try {
    try {
      result = await provider.conversation.runTurn({
    providerId: providerId!,
    operationProfile: "main",
    approvalMode: "never",
    attemptId,
    projectId: project.id,
    conversationId,
    runtimeScopeId: conversationId,
    roleId: "main-agent",
    runId,
    cwd: project.path,
    prompt,
    sandboxPolicy: "workspace-write",
    writableRoots: [proposalDirectory],
    runtimeWorkspaceRoots: [resolution.projectRoot, proposalDirectory],
    additionalContext,
    nativeSkillRoots: [...(turnSkillResolution.nativeSkillRoots ?? [getSystemSkillsRoot()])],
    requiredNativeSkills: [...(turnSkillResolution.requiredNativeSkills ?? [])],
    skillInputs: [...turnSkillResolution.skillInputs],
    existingSession: mainSessionId ? { providerId: providerId!, sessionId: mainSessionId } : null,
    objectiveSession: true,
    objectiveResume: options.goalResume ?? planHandoffResume,
    tools: [
      {
        name: "aho_goal_yield",
        description: "Yield the current native Goal at the current AHO human gate. This tool never executes an action.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "aho_accept_current_plan",
        description: "Accept the exact current user-confirmed planner-child proposal with Main-owned Registry contract evidence. This never starts execution.",
        inputSchema: mainPlanningAcceptanceToolInputSchema,
      },
      {
        name: "aho_finalize_current_change",
        description: "Request human confirmation to close the exact current authorized Change after an explicit user request. This tool never closes the Change directly and accepts no target or authority arguments.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "aho_close_agent",
        description: "Permanently close one currently registered Agent after the user explicitly requests it. Use the exact Agent Surface id supplied by AHO for the current turn; never substitute interrupt_agent.",
        inputSchema: {
          type: "object",
          properties: {
            agentSurfaceId: { type: "string" },
          },
          required: ["agentSurfaceId"],
          additionalProperties: false,
        },
      },
    ],
    onToolCall: async (call) => {
      if (call.tool === "aho_close_agent") {
        const keys = Object.keys(call.arguments);
        const targetSurfaceId = call.arguments.agentSurfaceId;
        if (keys.length !== 1
          || typeof targetSurfaceId !== "string"
          || !closableChildAgents.some((agent) => agent.agentSurfaceId === targetSurfaceId)) {
          return { contentItems: [{ type: "inputText", text: "The selected Agent is not an exact current registered Agent target." }], success: false };
        }
        const closed = await runExactChildAgentClose({
          project,
          conversationId,
          graphScopeId,
          parentThreadId: call.threadId,
          agentSurfaceId: targetSurfaceId,
          onLifecycleEvent: (event) => { childLifecycleOwner.onLifecycle(event); },
        });
        return {
          contentItems: [{
            type: "inputText",
            text: `Closed ${closed.displayName ?? closed.roleId} through the Provider-native Child close path. The historical Agent workspace is now read-only.`,
          }],
          success: true,
        };
      }
      if (call.tool === "aho_accept_current_plan") {
        if (planHandoff?.kind !== "execute-plan") {
          return toolCallFailure("Plan acceptance is available only for the exact current human-approved plan handoff.");
        }
        if (!liveMainThreadId || call.threadId !== liveMainThreadId) {
          return toolCallFailure("Only the exact current Main Agent thread may accept planning evidence.");
        }
        const policy = evaluateToolPolicy({
          actionType: "planning.accept",
          actorRoleId: "main-agent",
          conversationId,
          targetId: planHandoff.sourceProposalHash,
        });
        if (policy.status !== "allowed") return toolCallFailure(policy.readableMessage);
        let mainAcceptance: MainPlanningAcceptanceEvidence;
        try {
          mainAcceptance = parseMainPlanningAcceptanceToolInput(call.arguments);
        } catch (error) {
          return toolCallFailure(error instanceof Error ? error.message : String(error));
        }
        if (mainAcceptance.proposalHash !== planHandoff.sourceProposalHash
          || mainAcceptance.graphScopeId !== graphScopeId) {
          return toolCallFailure("Main planning acceptance does not match the exact current proposal and graph scope.");
        }
        await assertCurrentMainAttempt(resolution, conversationId, graphScopeId, attemptId, liveMainThreadId);
        const acceptedProposal = await readPlannerChildProposal(planHandoff.sourceArtifact);
        if (acceptedProposal.hash !== mainAcceptance.proposalHash) {
          return toolCallFailure("Main planning acceptance does not match the current planner proposal artifact.");
        }
        const accepted = await acceptCurrentConversationPlanningPackage(
          project,
          conversationId,
          planHandoff.sourceArtifact,
          mainAcceptance,
          { expectedMainAttemptId: attemptId },
        );
        graphScopeId = accepted.graphScopeId;
        await assertCurrentMainAttempt(resolution, conversationId, graphScopeId, attemptId, liveMainThreadId);
        canonicalDelivery?.publishCommittedMany(accepted.timelineRows);
        acceptedPlanning = accepted;
        boundChangeId = accepted.changeId;
        const acceptedStore = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
        try {
          const row = acceptedStore.interactions.updatePlanningMessageStatus(projectId, conversationId, planHandoff.sourceArtifact, "accepted");
          new CanonicalTimelineDelivery(acceptedStore, "harness", capture.sink).publishCommitted(row);
        } finally {
          acceptedStore.close();
        }
        acceptedPlanMarker = {
          ...projectScopedPlanningStatusMessage(conversationId, graphScopeId, runId, `Accepted proposal ${accepted.proposalId}.`, acceptedProposal.childThreadId, providerId!),
          status: "accepted",
        };
        return {
          contentItems: [{
            type: "inputText",
            text: `Accepted planning package ${accepted.proposalId} for Change ${accepted.changeId}. Compiled WorkflowGraphPlan ${accepted.workflowGraphPlan.id}. No execution leaf was started.`,
          }],
          success: true,
        };
      }
      if (call.tool === "aho_finalize_current_change") {
        if (Object.keys(call.arguments).length > 0) {
          return toolCallFailure("Change finalization does not accept caller-selected targets or authority.");
        }
        if (!boundChangeId) {
          return toolCallFailure("No active Change is bound to this Main Agent conversation.");
        }
        if (!liveMainThreadId || call.threadId !== liveMainThreadId) {
          return toolCallFailure("Only the exact current Main Agent thread may finalize this Change.");
        }
        const policy = evaluateToolPolicy({
          actionType: "change.finalize",
          actorRoleId: "main-agent",
          changeId: boundChangeId,
          conversationId,
          targetId: boundChangeId,
        });
        if (policy.status !== "allowed") return toolCallFailure(policy.readableMessage);
        await assertCurrentMainAttempt(resolution, conversationId, graphScopeId, attemptId, liveMainThreadId);
        const request = await requestSkillNativeProjectHarnessChangeFinalization(project, resolution, {
          changeId: boundChangeId,
          conversationId,
          graphScopeId,
          mainAttemptId: attemptId,
          providerThreadId: liveMainThreadId,
          turnId: call.turnId,
        });
        return {
          contentItems: [{
            type: "inputText",
            text: `Change ${request.changeId} finalization request ${request.id} is waiting for explicit human confirmation. The Change remains active.`,
          }],
          success: true,
        };
      }
      if (Object.keys(call.arguments).length > 0) {
        return { contentItems: [{ type: "inputText", text: "AHO conversation tools do not accept caller-selected targets." }], success: false };
      }
      if (call.tool !== "aho_goal_yield") {
        return { contentItems: [{ type: "inputText", text: "The requested AHO conversation tool is not available in this turn." }], success: false };
      }
      const context = boundChangeId
        ? await buildMainAgentExecutionContext(
          project,
          resolution,
          conversationId,
          graphScopeId,
          boundChangeId,
          "Native Goal yielded for the current gate.",
        )
        : "No accepted Change or executable workflow gate exists yet. Wait for plan review or further user input.";
      return { contentItems: [{ type: "inputText", text: context }], success: true, yieldAfterResponse: true };
    },
    paths: {
      events: join(directory, "provider-events.jsonl"),
      stderr: join(directory, "app-server-stderr.log"),
      lastMessage: join(directory, "last-message.md"),
      session: join(directory, "provider-session.json"),
    },
    onRealtimeEvent: (event) => {
      if (event.roleId === "main-agent" && !event.parentThreadId && event.threadId && liveMainThreadId !== event.threadId) {
        canonicalStore!.providerAttempts.bindProviderAttemptThread(projectId, {
          attemptId,
          threadId: event.threadId,
          parentThreadId: null,
          parentAgentSurfaceId: null,
          displayName: event.displayName,
          runId,
        }, new Date().toISOString());
        liveMainThreadId = event.threadId;
        publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "thread-bound" });
      }
      const registeredChild = event.parentThreadId
        ? childLifecycleOwner.registeredForThread(event.threadId)
        : null;
      const canonicalEvent = registeredChild
        ? { ...event, roleId: registeredChild.roleId, attemptId: registeredChild.attemptId }
        : event;
      forwardProviderRealtimeEvent(canonicalEvent, capture.sink, { productMode: "harness", graphScopeId });
    },
    onContextEvent: options.contextLifecycle?.listener({
      paths: resolution.paths,
      productMode: "harness",
      conversationId,
      graphScopeId,
      providerId: providerId!,
    }),
    onTurnStarted: options.turnControl?.onTurnStarted,
    onChildLifecycleEvent: (event) => {
      const child = childLifecycleOwner.onLifecycle(event);
      if (!child) return;
      capture.updateTargetAgent(
        agentThreadSurfaceId(providerId!, child.threadId),
        child.roleId,
        child.displayName,
        child.status,
      );
    },
    onChildThreadResult: (child) => {
      const registered = childLifecycleOwner.onResult(child);
      if (!registered) return;
      capture.updateTargetAgent(
        agentThreadSurfaceId(providerId!, registered.threadId),
        registered.roleId,
        child.displayName ?? registered.displayName,
        registered.status,
      );
    },
    onUserInputRequest: providerInputLifecycle.onRequest,
    onUserInputResolved: providerInputLifecycle.onResolved,
    onApprovalRequest: providerInputLifecycle.onApprovalRequest,
    onApprovalResolved: providerInputLifecycle.onApprovalResolved,
    onError: (error) => capture.sink.emit({ event: "error", data: { projectId, productMode: "harness", conversationId, runId, message: error instanceof Error ? error.message : String(error) } }),
    model: options.model,
    reasoningEffort: options.reasoningEffort,
      });
      await providerInputLifecycle.terminalize();
    } catch (error) {
      canonicalStore?.close();
      canonicalStore = null;
      canonicalDelivery = null;
      await providerInputLifecycle?.terminalize().catch(() => undefined);
      const failedAttemptStore = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
      try {
        commitFailedProviderTurn(failedAttemptStore, null);
      } finally {
        failedAttemptStore.close();
      }
      if (publishTerminalRows() > 0) {
        await emitInteractionUpdate();
      }
      throw error;
    }
  if (canonicalPersistenceError) {
    canonicalStore.close();
    canonicalStore = null;
    canonicalDelivery = null;
    await providerInputLifecycle?.terminalize().catch(() => undefined);
    const failedAttemptStore = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
    try {
      commitFailedProviderTurn(failedAttemptStore, result.session?.sessionId ?? null);
    } finally {
      failedAttemptStore.close();
    }
    if (publishTerminalRows() > 0) {
      await emitInteractionUpdate();
    }
    throw canonicalPersistenceError;
  }
  const plannerChildren = result.childThreads.filter((child) =>
    childLifecycleOwner.registeredForThread(child.threadId)?.roleId === PLANNING_AGENT_ROLE_ID);
  const postRunInvariantError = result.childThreads.length > 0 && plannerChildren.length !== 1
    ? new Error("Main Agent planning requires exactly one identifiable real planner child.")
    : (plannerChildren.length > 0 || planHandoff?.kind === "execute-plan") && !result.objective
      ? new Error("Main Agent planning and execution handoff requires a native Goal on the provider thread.")
      : null;
  if (postRunInvariantError) {
    capture.sink.emit({ event: "error", data: { projectId, productMode: "harness", conversationId, runId, message: postRunInvariantError.message } });
  }
  if (acceptedPlanning && !postRunInvariantError) {
    await issueAcceptedPlanningAuthorization(project, resolution, conversationId, attemptId, result, acceptedPlanning, planHandoff);
  }
  const rawParentText = capture.text.trim()
    || stripProjectScopedPromptEcho(result.lastMessage, userMessage).trim()
    || result.error
    || "";
  const assistantText = capture.text.trim();
  const latestMainCapture = [...capture.mainCaptures.values()].at(-1);
  if (latestMainCapture) {
    const hasTerminal = latestMainCapture.activity.some((item) => item.kind === "status"
      && (item.label === "completed" || item.label === "failed" || item.label === "blocked" || item.label === "cancelled"));
    if (!hasTerminal) {
      latestMainCapture.activity.push({
        kind: "status",
        label: result.status === "interrupted" ? "cancelled" : result.status,
        timestamp: new Date().toISOString(),
      });
    }
  }
  await writeFile(join(directory, "last-message.md"), rawParentText.trim(), "utf8");
  const assistantLineageBlock = [...capture.blocks].reverse().find((block) => block.kind !== "usage" && (block.threadId || block.turnId));
  const assistant: TopicThreadEntry | null = assistantText || capture.blocks.length > 0 || capture.activity.length > 0 ? {
    id: mainTimelineId,
    type: "assistant.message",
    timestamp: new Date().toISOString(),
    conversationId,
    graphScopeId,
    changeId: "",
    text: assistantText || undefined,
    runId,
    providerId,
    sessionId: result.session?.sessionId,
    attemptId,
    threadId: result.session?.sessionId ?? assistantLineageBlock?.threadId,
    turnId: assistantLineageBlock?.turnId,
    artifact: `workbench/conversations/${conversationId}/runs/${runId}/last-message.md`,
    activity: capture.activity,
    blocks: capture.blocks,
  } : null;
  let latestChildMessage: TopicThreadEntry | null = null;
  let planReferenceMarker: TopicThreadEntry | null = null;
  if (!canonicalStore) throw new Error("Canonical conversation store closed before turn completion.");
  const store = canonicalStore;
  try {
    if (result.session) store.providerAttempts.bindProviderAttemptThread(projectId, {
      attemptId,
      threadId: result.session.sessionId,
      parentThreadId: null,
      parentAgentSurfaceId: null,
      runId,
    }, new Date().toISOString());
    if (result.session) publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "thread-bound" });
    for (const child of result.childThreads) {
      const registeredChild = childLifecycleOwner.onResult(child);
      if (!registeredChild) continue;
      const childRoleId = registeredChild.roleId;
      const isPlannerChild = childRoleId === PLANNING_AGENT_ROLE_ID;
      capture.updateTargetAgent(
        agentThreadSurfaceId(providerId, child.threadId),
        childRoleId,
        child.displayName,
        child.status === "failed" ? "failed" : "completed",
      );
      const terminalChildCaptures = childTranscriptCapturesForThread(capture.childCaptures, child.threadId);
      for (const childCapture of terminalChildCaptures) {
        childCapture.roleId = childRoleId;
        childCapture.displayName = child.displayName ?? childCapture.displayName;
      }
      for (const childCapture of terminalChildCaptures) {
        const childProcessMessage = buildChildProcessMessage({
          conversationId,
          graphScopeId,
          runId,
          roleId: childRoleId,
          childThreadId: child.threadId,
          parentThreadId: child.parentThreadId,
          providerId: providerId!,
          capture: childCapture,
        });
        if (childProcessMessage) {
          childProcessMessage.providerId = providerId;
          childProcessMessage.sessionId = child.threadId;
          childProcessMessage.attemptId = registeredChild.attemptId;
          childProcessMessage.agentSurfaceId = agentThreadSurfaceId(providerId!, child.threadId);
          childProcessMessage.status = captureChildStatus(childCapture);
          latestChildMessage = childProcessMessage;
        }
      }
      if (!isPlannerChild) continue;
      try {
        const planning = await finalizePlanningChild({
          directory,
          projectId,
          conversationId,
          runId,
          providerId: providerId!,
          mainAttemptId: attemptId,
          childAttemptId: registeredChild.attemptId,
          parentTurnId: assistant?.turnId ?? result.turnId ?? undefined,
          referenceSequence: (assistant?.blocks?.at(-1)?.sequence ?? 0) + 1,
          child,
          captures: terminalChildCaptures,
        });
        planDocumentCreated = true;
        const planReferenceBlock = planning.referenceBlock;
        const latestMainCapture = [...capture.mainCaptures.values()].at(-1);
        if (latestMainCapture) {
          latestMainCapture.blocks.push(planReferenceBlock);
        } else if (assistant) {
          assistant.blocks = [...(assistant.blocks ?? []), planReferenceBlock];
          assistant.threadId ??= result.session?.sessionId;
          assistant.turnId ??= result.turnId ?? undefined;
        } else {
          planReferenceMarker = {
            id: `assistant:${conversationId}:${providerId}:${runId}:document-reference:${planning.documentId}`,
            type: "assistant.message",
            timestamp: planReferenceBlock.timestamp,
            conversationId,
            graphScopeId,
            changeId: "",
            runId,
            providerId,
            threadId: result.session?.sessionId,
            turnId: result.turnId ?? undefined,
            blocks: [planReferenceBlock],
          };
        }
      } catch (cause) {
        capture.sink.emit({ event: "error", data: { projectId, productMode: "harness", conversationId, runId, message: cause instanceof Error ? cause.message : String(cause) } });
      }
    }
    const terminalTimelineMessages = buildCaptureWrites({
      projectId,
      conversationId,
      graphScopeId,
      runId,
      providerId,
      attemptId,
      mainTimelineId,
      mainSessionId: result.session?.sessionId ?? mainSessionId,
      snapshot: capture,
    });
    if (acceptedPlanMarker) terminalTimelineMessages.push(toCanonicalTimelineMessage(projectId, conversationId, acceptedPlanMarker, completedTurnSequence + 1));
    if (planReferenceMarker) terminalTimelineMessages.push(toCanonicalTimelineMessage(projectId, conversationId, planReferenceMarker, completedTurnSequence + 1));
    if (assistant && capture.mainCaptures.size === 0) {
      terminalTimelineMessages.push(toCanonicalTimelineMessage(projectId, conversationId, assistant, completedTurnSequence + 1));
    }
    const terminalAt = new Date().toISOString();
    const uniqueTerminalMessages = [...new Map(terminalTimelineMessages.map((message) => [message.id, message])).values()];
    const terminalCommit = store.unitOfWork.commitProviderTurnTerminal({
      projectId,
      conversationId,
      runId,
      mainAttemptId: attemptId,
      expectedGraphScopeId: graphScopeId,
      mainStatus: result.status,
      mainNativeSessionId: result.session?.sessionId ?? null,
      childAttempts: childLifecycleOwner.terminalAttempts(result.status === "interrupted" ? "interrupted" : "failed"),
      expectedCompletedTurnSequence: completedTurnSequence,
      advanceCompletedTurn: result.status === "completed",
      binding: {
        projectId,
        conversationId,
        providerId,
        nativeSessionId: result.session?.sessionId ?? mainSessionId,
        preferredModel: options.model,
        lastUsedAt: terminalAt,
        bindingStatus: result.status === "failed" ? "stale" : "ready",
      },
      updatedAt: terminalAt,
      timelineMessages: uniqueTerminalMessages,
    });
    options.turnControl?.release(turnRegistration);
    publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "attempt-updated" });
    terminalCommittedRows.push(...terminalCommit.timelineRows);
    terminalCommittedRows.push(...terminalCommit.interactionRows);
    completedTurnSequence = terminalCommit.completedTurnSequence;
  } catch (error) {
    try {
      commitFailedProviderTurn(store, result.session?.sessionId ?? null);
    } catch {
      // Preserve the original canonical persistence error.
    }
    if (publishTerminalRows() > 0) {
      await emitInteractionUpdate();
    }
    throw error;
  } finally {
    store.close();
    canonicalStore = null;
    canonicalDelivery = null;
  }
  if (publishTerminalRows() > 0) {
    await emitInteractionUpdate();
  }
  if (planDocumentCreated) {
    await emitInteractionUpdate(live);
  }
  if (postRunInvariantError) throw postRunInvariantError;
  if (result.objective?.status === "complete") {
    const terminalStore = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
    let terminalizedInteractionCount = 0;
    try {
      const rows = terminalStore.unitOfWork.terminalizeConversationGraphScope(
        projectId,
        conversationId,
        graphScopeId,
        new Date().toISOString(),
      );
      publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "scope-changed" });
      terminalizedInteractionCount = rows.length;
      new CanonicalTimelineDelivery(terminalStore, "harness", live).publishCommittedMany(rows);
    } finally {
      terminalStore.close();
    }
    if (terminalizedInteractionCount > 0) {
      await emitInteractionUpdate();
    }
  }
    return assistant ?? planReferenceMarker ?? latestChildMessage ?? {
      id: `assistant:${conversationId}:${runId}:empty`,
      type: "assistant.message",
      timestamp: new Date().toISOString(),
      conversationId,
      graphScopeId,
      changeId: "",
      text: "",
      runId,
      blocks: [],
    };
  } finally {
    options.turnControl?.release(turnRegistration);
  }
}

function projectScopedPlanningStatusMessage(conversationId: string, graphScopeId: string, runId: string, text: string, childThreadId: string, providerId: string): TopicThreadEntry {
  const timestamp = new Date().toISOString();
  const block: AssistantTurnBlock = {
    id: `planning-status:${providerId}:${runId}:${childThreadId}`,
    runId,
    sequence: 1,
    kind: "status",
    timestamp,
    source: "aho",
    status: "completed",
    title: "计划状态",
    text: text.trim(),
  };
  return {
    id: `assistant:${conversationId}:${providerId}:${runId}:planning-status:${childThreadId}`,
    type: "assistant.message",
    timestamp,
    conversationId,
    graphScopeId,
    changeId: "",
    text: text.trim(),
    runId,
    providerId,
    threadId: childThreadId,
    agentSurfaceId: agentThreadSurfaceId(providerId, childThreadId),
    agentRoleId: PLANNING_AGENT_ROLE_ID,
    blocks: [block],
  };
}

async function readProviderAttempts(resolution: ProjectRuntimeResolution, conversationId: string) {
  const store = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    return store.providerAttempts.listProviderAttempts(resolution.harness.projectId, conversationId);
  } finally {
    store.close();
  }
}

function attemptStoreCandidate(
  attempts: Awaited<ReturnType<typeof readProviderAttempts>>,
  providerId: string,
  graphScopeId: string,
  changeId: string | null,
  expectedAttemptId: string | null,
) {
  if (!expectedAttemptId) return undefined;
  return [...attempts].reverse().find((attempt) =>
    attempt.status === "queued"
    && attempt.attemptId === expectedAttemptId
    && attempt.providerId === providerId
    && attempt.roleId === "main-agent"
    && attempt.operationProfile === "main"
    && attempt.graphScopeId === graphScopeId
    && attempt.changeId === changeId);
}

function stripProjectScopedPromptEcho(message: string, userMessage: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "";
  const userMarker = `User message:\n${userMessage}`;
  const markerIndex = trimmed.indexOf(userMarker);
  if (markerIndex >= 0) {
    return trimmed.slice(markerIndex + userMarker.length).trim();
  }
  return trimmed
    .replace(/^You are the main Agent for this project\.[\s\S]*?User message:\s*/i, "")
    .trim();
}

function buildProjectConversationRunId(conversationId: string): string {
  return `chat-${conversationId}-${Date.now().toString(36)}`;
}

async function currentConversationGraphScope(resolution: ProjectRuntimeResolution, conversationId: string): Promise<string> {
  const store = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    const graphScopeId = store.conversations.readConversation(resolution.harness.projectId, conversationId)?.currentGraphScopeId;
    if (!graphScopeId) throw new Error("The current conversation has no Agent graph scope.");
    return graphScopeId;
  } finally {
    store.close();
  }
}

async function issueAcceptedPlanningAuthorization(
  project: ManagedProject,
  resolution: ProjectRuntimeResolution,
  conversationId: string,
  attemptId: string,
  result: ProviderTurnResult,
  accepted: Awaited<ReturnType<typeof acceptCurrentConversationPlanningPackage>>,
  handoff: ValidatedPlanHandoffIntent | null | undefined,
): Promise<LocalExecutionAuthorization | null> {
  if (!result.session || !result.objective || handoff?.kind !== "execute-plan") {
    throw new Error("Accepted planning authorization requires the current Main thread, native Goal, and execute intent.");
  }
  const session = result.session;
  const objective = result.objective;
  const sourceHead = await getGitCommit(project.path);
  const intentPath = await resolveWithinPhysicalRoot(
    resolution.harness.skillRoot,
    accepted.authorizationIntentArtifact,
    "planning authorization intent",
  );
  if (!sourceHead) {
    await writeJsonFile(intentPath, {
      version: "1.0",
      status: "blocked",
      changeId: accepted.changeId,
      conversationId,
      proposalId: accepted.proposalId,
      proposalHash: accepted.proposalHash,
      graphId: accepted.workflowGraphPlan.id,
      authorizationId: null,
      projectHarnessContentFingerprint: null,
      startManifestHash: null,
      reason: "Execution authorization requires a Git source commit.",
      updatedAt: new Date().toISOString(),
    });
    return null;
  }
  const sourceStatus = await getGitStatusShort(project.path);
  const graphHash = hashWorkflowGraphPlan(accepted.workflowGraphPlan);
  const artifactManifestHash = hashJson(accepted.workflowGraphPlan.sourceArtifactHashes);
  const gateEvidence = await readProjectHarnessPlanningGate({
    projectId: resolution.harness.projectId,
    projectRoot: resolution.projectRoot,
    skillRoot: resolution.harness.skillRoot,
    conversationId,
    graphScopeId: accepted.graphScopeId,
    changeId: accepted.changeId,
  });
  const startManifestHash = projectHarnessPlanningStartManifestHash(
    gateEvidence,
    resolution.harness.contentFingerprint,
  );
  const targets = accepted.workflowGraphPlan.nodes.map((node) => ({
    transition: "workflow.node.execute",
    targetId: node.id,
    manifestHash: hashJson({ graphHash, node }),
  }));
  targets.unshift({
    transition: "workflow.run.start",
    targetId: accepted.workflowGraphPlan.id,
    manifestHash: startManifestHash,
  });
  targets.push({
    transition: "change.finalize",
    targetId: accepted.changeId,
    manifestHash: hashJson({ graphHash, changeId: accepted.changeId, kind: "finalize" }),
  });
  const now = new Date();
  return withProjectHarnessWriterLock(projectHarnessSharedWriterRoot(resolution.paths.sidecarRoot), {
    projectId: resolution.harness.projectId,
    ownerId: `planning-authorization-${conversationId}`,
    operation: "change-publish",
  }, async () => {
    await assertCurrentMainAttempt(resolution, conversationId, accepted.graphScopeId, attemptId, session.sessionId);
    const authorization = await issueLocalExecutionAuthorization(resolution.paths, {
    projectId: resolution.harness.projectId,
    changeId: accepted.changeId,
    conversationId,
    providerThreadId: session.sessionId,
    goalIdentityHash: hashJson({ objective: objective.objective, createdAt: objective.createdAt }),
    mode: handoff.executionMode ?? "scoped-auto",
    acceptedPlanId: accepted.proposalId,
    acceptedPlanHash: accepted.proposalHash,
    graphId: accepted.workflowGraphPlan.id,
    graphHash,
    artifactManifestHash,
    sourceHead,
    sourceStateHash: hashJson(sourceStatus),
    providerScopeHash: hashJson({ projectId: project.id, conversationId, providerId: result.providerId, sessionId: session.sessionId }),
    permissionProfileHash: hashJson({ approvalPolicy: "never", sandbox: "runtime-owned-scoped-write", network: false }),
    policyHash: hashJson("local-execution-authorization-policy-v1"),
    targets,
    budget: {
      maxCompletedOperations: Math.max(16, accepted.workflowGraphPlan.nodes.length * 8 + 8),
      maxReworks: 1,
      maxChangedFiles: 100,
      maxChangedBytes: 10 * 1024 * 1024,
    },
    userDecision: {
      decisionId: `execute-plan:${handoff.sourceRunId}`,
      actorId: "workbench-user",
      decidedAt: now.toISOString(),
    },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    try {
      await writeJsonFile(intentPath, {
        version: "1.0",
        status: "issued",
        changeId: accepted.changeId,
        conversationId,
        proposalId: accepted.proposalId,
        proposalHash: accepted.proposalHash,
        graphId: accepted.workflowGraphPlan.id,
        authorizationId: authorization.id,
        projectHarnessContentFingerprint: resolution.harness.contentFingerprint,
        startManifestHash,
        reason: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await revokeLocalExecutionAuthorization(
        resolution.paths,
        authorization.id,
        "Project Harness authorization intent publication failed.",
      ).catch(() => undefined);
      throw error;
    }
    return authorization;
  });
}

async function assertCurrentMainAttempt(
  resolution: ProjectRuntimeResolution,
  conversationId: string,
  graphScopeId: string,
  attemptId: string,
  expectedThreadId?: string,
): Promise<void> {
  const store = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
  try {
    const conversation = store.conversations.readConversation(resolution.harness.projectId, conversationId);
    const attempt = store.providerAttempts.readProviderAttempt(resolution.harness.projectId, attemptId);
    const thread = store.providerAttempts.listProviderThreads(resolution.harness.projectId, conversationId)
      .find((candidate) => candidate.attemptId === attemptId && candidate.roleId === "main-agent");
    if (!conversation
      || conversation.currentGraphScopeId !== graphScopeId
      || !attempt
      || attempt.conversationId !== conversationId
      || attempt.graphScopeId !== graphScopeId
      || attempt.status !== "running"
      || !thread
      || thread.graphScopeId !== graphScopeId
      || (expectedThreadId !== undefined && thread.providerThreadId !== expectedThreadId)) {
      throw new Error("Main Agent callback no longer owns the current conversation graph.");
    }
  } finally {
    store.close();
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const mainPlanningAcceptanceToolInputSchema = {
  type: "object",
  properties: {
    proposalHash: { type: "string" },
    graphScopeId: { type: "string" },
    contractRequired: { type: "boolean" },
    contract: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["api", "schema", "event", "config", "permission", "module_boundary"] },
            subject: { type: "string" },
            operation: { type: "string" },
            owner_module: { type: "string" },
            affected_paths: { type: "array", items: { type: "string" } },
            consumers: { type: "array", items: { type: "string" } },
            depends_on: { type: "array", items: { type: "string" } },
            depends_on_changes: { type: "array", items: { type: "string" } },
            compatibility: { type: "string" },
            status: { type: "string" },
          },
          required: [
            "kind",
            "subject",
            "operation",
            "owner_module",
            "affected_paths",
            "consumers",
            "depends_on",
            "depends_on_changes",
            "compatibility",
            "status",
          ],
          additionalProperties: false,
        },
      ],
    },
    validation: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["proposalHash", "graphScopeId", "contractRequired", "contract", "validation"],
  additionalProperties: false,
} as const;

const mainPlanningAcceptanceToolCallSchema = z.object({
  proposalHash: z.string().trim().min(1),
  graphScopeId: z.string().trim().min(1),
  contractRequired: z.boolean(),
  contract: z.unknown().nullable(),
  validation: z.array(z.string().trim().min(1)).min(1),
}).strict();

function parseMainPlanningAcceptanceToolInput(input: unknown): MainPlanningAcceptanceEvidence {
  return parseMainPlanningAcceptanceEvidence({
    version: "1.0",
    ...mainPlanningAcceptanceToolCallSchema.parse(input),
  });
}

function toolCallFailure(message: string) {
  return { contentItems: [{ type: "inputText" as const, text: message }], success: false };
}
