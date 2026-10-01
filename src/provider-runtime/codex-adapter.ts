import { getActiveCodexAppServerTurn, isCodexAppServerChildAvailable, listActiveCodexAppServerTurns, runCodexAppServerChildClose, runCodexAppServerChildTurn, runCodexAppServerReview, runCodexAppServerTurn, type ActiveCodexAppServerTurn, type CodexAppServerReviewTarget, type CodexAppServerThreadGoalStatus } from "../codex/app-server.js";
import { normalizeCodexContextEvent, type CodexAppServerRealtimeEvent, type CodexContextEvent } from "../codex/app-server-realtime.js";
import { getCodexProviderCapabilitySnapshot, getCodexProviderRuntimeSummary } from "./codex.js";
import { CODEX_PROVIDER_ADAPTER, executeCodexProjectAction, getCodexDiagnostics, listCodexProjectActions } from "./codex-diagnostics.js";
import { codexModelSettings, selectCodexModel } from "./codex-models.js";
import { codexSkillConfigurationKey, listCodexGlobalSkills, listCodexNativeSkills, setCodexGlobalSkillEnabled, setCodexNativeSkillEnabled } from "../codex/native-skills.js";
import { CodexAppServerJsonRpcError, CodexAppServerRequestTimeoutError, defaultCodexAppServerHostRegistry } from "../codex/app-server-host.js";
import { defaultProjectRemovalFence } from "../project-runtime/removal.js";
import type { ActiveProviderTurn, ProviderApprovalRequest, ProviderChildCloseRequest, ProviderChildLifecycleEvent, ProviderChildSessionRequest, ProviderChildThreadResult, ProviderChildTurnRequest, ProviderContextCompactRequest, ProviderContextEvent, ProviderDescriptor, ProviderObjectiveState, ProviderRealtimeEvent, ProviderReviewRequest, ProviderReviewResult, ProviderReviewTarget, ProviderSessionArchiveRequest, ProviderSessionForkRequest, ProviderSessionForkResult, ProviderSessionForkTransportStage, ProviderTurnRequest, ProviderTurnResult, ProviderUserInputRequest } from "./contracts.js";
import { agentThreadSurfaceId } from "./agent-surface-id.js";

export const CODEX_PROVIDER_ID = "codex" as const;
const activeAttemptByScope = new Map<string, string>();

export const codexProviderDescriptor: ProviderDescriptor = {
  id: CODEX_PROVIDER_ID,
  displayName: "Codex",
  adapter: CODEX_PROVIDER_ADAPTER,
  runtime: {
    liveness: () => ({
      providerId: CODEX_PROVIDER_ID,
      liveHostCount: defaultCodexAppServerHostRegistry.liveProcessCount(),
    }),
    shutdown: (reason) => defaultCodexAppServerHostRegistry.disposeAll(reason),
    shutdownProject: (project, reason) => defaultCodexAppServerHostRegistry.disposeProject(project.projectId, reason),
  },
  capabilitySnapshot: getCodexProviderCapabilitySnapshot,
  runtimeSummary: getCodexProviderRuntimeSummary,
  models: { read: codexModelSettings, select: selectCodexModel },
  diagnostics: getCodexDiagnostics,
  projectActions: { list: listCodexProjectActions, execute: executeCodexProjectAction },
  skills: {
    listGlobal: listCodexGlobalSkills,
    configurationKey: codexSkillConfigurationKey,
    setGlobalEnabled: setCodexGlobalSkillEnabled,
    list: listCodexNativeSkills,
    setEnabled: setCodexNativeSkillEnabled,
  },
  conversation: { runTurn: runCodexTurn, runReview: runCodexReview, inspectChild: inspectCodexChild, continueChild: runCodexChildTurn, closeChild: closeCodexChild, getActiveTurn: activeCodexTurn, listActiveTurns: activeCodexTurns, compactContext: compactCodexContext, forkSession: forkCodexSession, setSessionArchived: setCodexSessionArchived },
  leafExecution: { runTurn: runCodexTurn },
};

export async function runCodexReview(request: ProviderReviewRequest): Promise<ProviderReviewResult> {
  if (request.providerId !== CODEX_PROVIDER_ID) throw new Error(`Codex adapter cannot run provider ${request.providerId}`);
  const projectGeneration = defaultProjectRemovalFence.capture(request.projectId);
  activeAttemptByScope.set(request.runtimeScopeId, request.attemptId);
  try {
    const result = await runCodexAppServerReview({
      projectId: request.projectId,
      conversationId: request.conversationId,
      runtimeScopeId: request.runtimeScopeId,
      roleId: "main-agent",
      runId: request.runId,
      cwd: request.cwd,
      prompt: "",
      sandboxPolicy: "read-only",
      paths: request.paths,
      existingThreadId: request.existingSession?.sessionId,
      model: request.existingSession ? null : request.bootstrapModel?.modelId ?? null,
      reasoningEffort: request.existingSession ? null : request.bootstrapReasoningEffort,
      approvalMode: "on-request",
      reviewTarget: toCodexReviewTarget(request.target),
      timeoutMs: request.timeoutMs,
      onTurnStarted: request.onTurnStarted ? ({ threadId, turnId }) => request.onTurnStarted?.({
        projectId: request.projectId, conversationId: request.conversationId,
        runtimeScopeId: request.runtimeScopeId, providerId: CODEX_PROVIDER_ID,
        attemptId: request.attemptId, runId: request.runId, roleId: "main-agent",
        sessionId: threadId, turnId,
      }) : undefined,
      onReviewEvent: guardedProjectNotification(request.projectId, projectGeneration, request.onReviewEvent),
      onContextEvent: guardedProjectNotification(request.projectId, projectGeneration, request.onContextEvent
        ? (event) => request.onContextEvent?.(mapContextEvent(event)) : undefined),
      onApprovalRequest: guardedProjectNotification(request.projectId, projectGeneration, request.onApprovalRequest
        ? (approval) => request.onApprovalRequest?.(mapApproval(request, approval)) : undefined),
      onApprovalResolved: guardedProjectNotification(request.projectId, projectGeneration, request.onApprovalResolved
        ? (approval) => request.onApprovalResolved?.({ providerId: CODEX_PROVIDER_ID, requestId: approval.requestId,
          attemptId: request.attemptId, runId: request.runId, runtimeScopeId: request.runtimeScopeId,
          threadId: approval.threadId, turnId: approval.turnId }) : undefined),
    });
    if (result.failureKind === "review-transport-uncertain") {
      const error = new Error("Provider Review transport outcome is uncertain.");
      error.name = "ProviderReviewTransportUncertain";
      throw error;
    }
    return { providerId: CODEX_PROVIDER_ID, status: result.status,
      session: result.threadId ? { providerId: CODEX_PROVIDER_ID, sessionId: result.threadId } : null,
      turnId: result.turnId, reviewText: result.lastMessage,
      ...(result.failureKind === "stale-session" ? { failureKind: result.failureKind } : {}), ...(result.error ? { error: result.error } : {}) };
  } finally {
    if (activeAttemptByScope.get(request.runtimeScopeId) === request.attemptId) activeAttemptByScope.delete(request.runtimeScopeId);
  }
}

function toCodexReviewTarget(target: ProviderReviewTarget): CodexAppServerReviewTarget {
  if (target.type === "uncommitted-changes") return { type: "uncommittedChanges" };
  if (target.type === "base-branch") return { type: "baseBranch", branch: target.branch };
  if (target.type === "commit") return { type: "commit", sha: target.sha, ...(target.title ? { title: target.title } : {}) };
  return { type: "custom", instructions: target.instructions };
}

export async function runCodexTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
  if (request.providerId !== CODEX_PROVIDER_ID) throw new Error(`Codex adapter cannot run provider ${request.providerId}`);
  const projectGeneration = defaultProjectRemovalFence.capture(request.projectId);
  const runtimeScopeId = request.runtimeScopeId ?? request.changeId ?? request.runId;
  activeAttemptByScope.set(runtimeScopeId, request.attemptId);
  let result: Awaited<ReturnType<typeof runCodexAppServerTurn>>;
  try {
    result = await runCodexAppServerTurn({
    projectId: request.projectId,
    conversationId: request.conversationId,
    changeId: request.changeId,
    runtimeScopeId: request.runtimeScopeId,
    roleId: request.roleId,
    agentTaskId: request.agentTaskId,
    runId: request.runId,
    cwd: request.cwd,
    prompt: request.prompt,
    sandboxPolicy: request.sandboxPolicy,
    paths: request.paths,
    existingThreadId: request.existingSession?.sessionId,
    goalSession: request.objectiveSession,
    goalResume: request.objectiveResume,
    timeoutMs: request.timeoutMs,
    onRealtimeEvent: request.onRealtimeEvent ? (event) => {
      if (!isProjectGenerationCurrent(request.projectId, projectGeneration)) return;
      const mapped = mapRealtime(request, event);
      if (mapped) request.onRealtimeEvent?.(mapped);
    } : undefined,
    onContextEvent: guardedProjectNotification(request.projectId, projectGeneration, request.onContextEvent
      ? (event) => request.onContextEvent?.(mapContextEvent(event))
      : undefined),
    onTurnStarted: request.onTurnStarted ? ({ threadId, turnId }) => {
      if (!isProjectGenerationCurrent(request.projectId, projectGeneration)) return;
      request.onTurnStarted?.({
        projectId: request.projectId,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        runtimeScopeId,
        providerId: CODEX_PROVIDER_ID,
        attemptId: request.attemptId,
        runId: request.runId,
        roleId: request.roleId,
        sessionId: threadId,
        turnId,
      });
    } : undefined,
    onChildLifecycleEvent: request.onChildLifecycleEvent
      ? (event) => {
        if (isProjectGenerationCurrent(request.projectId, projectGeneration)) {
          request.onChildLifecycleEvent?.(mapChildLifecycle(event));
        }
      }
      : undefined,
    onChildThreadResult: guardedProjectNotification(request.projectId, projectGeneration, request.onChildThreadResult
      ? (child) => request.onChildThreadResult?.(mapChild(child))
      : undefined),
    onUserInputRequest: guardedProjectNotification(request.projectId, projectGeneration, request.onUserInputRequest
      ? (input) => request.onUserInputRequest?.(mapUserInput(request, input))
      : undefined),
    onUserInputResolved: guardedProjectNotification(request.projectId, projectGeneration, request.onUserInputResolved ? (input) => request.onUserInputResolved?.({
      providerId: CODEX_PROVIDER_ID,
      requestId: input.requestId,
      runtimeScopeId,
      runId: request.runId,
      attemptId: request.attemptId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    }) : undefined),
    approvalMode: request.approvalMode ?? "never",
    onApprovalRequest: guardedProjectNotification(request.projectId, projectGeneration, request.onApprovalRequest
      ? (approval) => request.onApprovalRequest?.(mapApproval(request, approval))
      : undefined),
    onApprovalResolved: guardedProjectNotification(request.projectId, projectGeneration, request.onApprovalResolved
      ? (approval) => request.onApprovalResolved?.({
        providerId: CODEX_PROVIDER_ID,
        requestId: approval.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        runtimeScopeId,
        threadId: approval.threadId,
        turnId: approval.turnId,
      })
      : undefined),
    dynamicTools: request.tools,
    onDynamicToolCall: request.onToolCall ? async (call) => {
      defaultProjectRemovalFence.assertCurrent(request.projectId, projectGeneration);
      return request.onToolCall?.({ ...call, providerId: CODEX_PROVIDER_ID }) as Promise<import("./contracts.js").ProviderToolResult>;
    } : undefined,
    onGoalUpdate: guardedProjectNotification(request.projectId, projectGeneration, request.onObjectiveUpdate
      ? (goal) => request.onObjectiveUpdate?.(mapObjective(goal))
      : undefined),
    onTextDelta: guardedProjectNotification(request.projectId, projectGeneration, request.onTextDelta),
    onPlanDelta: guardedProjectNotification(request.projectId, projectGeneration, request.onPlanDelta),
    onPlanUpdate: guardedProjectNotification(request.projectId, projectGeneration, request.onPlanUpdate),
    onError: guardedProjectNotification(request.projectId, projectGeneration, request.onError),
    model: request.model?.modelId,
    reasoningEffort: request.reasoningEffort,
    imageInputs: request.imageInputs,
    fileInputs: request.fileInputs,
    skillInputs: request.skillInputs?.map((skill) => ({ name: skill.id, path: skill.path })),
    nativeSkillRoots: request.nativeSkillRoots,
    requiredNativeSkills: request.requiredNativeSkills,
    runtimeWorkspaceRoots: request.runtimeWorkspaceRoots,
    additionalContext: request.additionalContext,
    writableRoots: request.writableRoots,
    developerInstructions: request.developerInstructions,
    enableDefaultModeUserInput: request.operationProfile === "agent" || request.operationProfile === "main" || request.operationProfile === "planning",
    collaborationMode: request.agentTurnMode === "plan"
      ? codexPlanCollaborationMode(request)
      : undefined,
    outputSchema: request.outputSchema,
    });
  } finally {
    activeAttemptByScope.delete(runtimeScopeId);
  }
  return {
    providerId: CODEX_PROVIDER_ID,
    status: result.status,
    session: result.threadId ? { providerId: CODEX_PROVIDER_ID, sessionId: result.threadId } : null,
    turnId: result.turnId,
    lastMessageItemId: result.lastMessageItemId,
    lastMessage: result.lastMessage,
    planText: result.planText,
    objective: result.goal ? mapObjective(result.goal) : result.goal,
    childThreads: result.childThreads.map(mapChild),
    changedFiles: result.changedFiles,
    ...(result.host ? { runtimeHost: result.host } : {}),
    ...(result.failureKind === "stale-session" ? { failureKind: result.failureKind } : {}),
    error: result.error,
  };
}

export async function compactCodexContext(request: ProviderContextCompactRequest): Promise<{ status: "accepted" }> {
  if (request.providerId !== CODEX_PROVIDER_ID || request.session.providerId !== CODEX_PROVIDER_ID) {
    throw new Error("Codex context compaction requires a Codex session.");
  }
  const generation = defaultProjectRemovalFence.capture(request.projectId);
  const host = defaultCodexAppServerHostRegistry.hostForProject(request.projectId, request.cwd);
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let released = false;
  let lease: Awaited<ReturnType<typeof host.acquire>> | null = null;
  const release = (): void => {
    if (released) return;
    released = true;
    if (expiry) clearTimeout(expiry);
    lease?.release();
  };
  try {
    lease = await host.acquire({
      onLine(line) {
        if (!isProjectGenerationCurrent(request.projectId, generation)) return;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (typeof payload.method !== "string" || !payload.params || typeof payload.params !== "object") return;
        const event = normalizeCodexContextEvent(payload.method, payload.params as Record<string, unknown>);
        if (!event || event.threadId !== request.session.sessionId) return;
        if (event.type === "compaction" && event.phase === "started" && expiry) {
          clearTimeout(expiry);
          expiry = null;
        }
        try {
          request.onContextEvent?.(mapContextEvent(event));
        } finally {
          if (event.type === "compaction" && event.phase !== "started") release();
        }
      },
      onStderr() {},
      onExit() {
        release();
      },
    });
    expiry = setTimeout(release, 5 * 60_000);
    const resumed = await lease.request("thread/resume", { threadId: request.session.sessionId }, { timeoutMs: 5_000 });
    if (codexThreadId(resumed) !== request.session.sessionId) {
      const error = new Error("Codex context compaction could not prove the requested Provider session.");
      error.name = "StaleProviderSession";
      throw error;
    }
    await lease.request("thread/compact/start", { threadId: request.session.sessionId }, { timeoutMs: 5_000 });
    return { status: "accepted" };
  } catch (error) {
    if (error instanceof CodexAppServerJsonRpcError
      || (error instanceof Error && (error.name === "Conflict" || error.name === "StaleProviderSession"))) {
      const rejection = new Error("Provider rejected context compaction.", { cause: error });
      rejection.name = "ProviderContextCompactRejected";
      release();
      throw rejection;
    }
    if (!(error instanceof Error) || error.name !== "CodexAppServerRequestTimeout") release();
    throw error;
  }
}

export async function forkCodexSession(request: ProviderSessionForkRequest): Promise<ProviderSessionForkResult> {
  if (request.providerId !== CODEX_PROVIDER_ID
    || request.sourceSession.providerId !== CODEX_PROVIDER_ID
    || request.anchorTurn.providerId !== CODEX_PROVIDER_ID
    || request.anchorTurn.sessionId !== request.sourceSession.sessionId) {
    throw providerForkRejected("Codex session fork requires one exact Codex source session and anchor Turn.");
  }
  const generation = defaultProjectRemovalFence.capture(request.projectId);
  const host = defaultCodexAppServerHostRegistry.hostForProject(request.projectId, request.cwd);
  const lease = await host.acquire({ onLine() {}, onStderr() {}, onExit() {} });
  let childSessionId: string | null = null;
  let stage: ProviderSessionForkTransportStage = "source-resume";
  try {
    defaultProjectRemovalFence.assertCurrent(request.projectId, generation);
    const resumed = await lease.request("thread/resume", { threadId: request.sourceSession.sessionId }, { timeoutMs: 20_000 });
    const resumedThread = codexThread(resumed);
    assertForkSourceThread(resumedThread, request.sourceSession.sessionId);
    stage = "source-read";
    const sourceRead = await lease.request("thread/read", { threadId: request.sourceSession.sessionId, includeTurns: true }, { timeoutMs: 20_000 });
    const sourceThread = codexThread(sourceRead);
    assertForkSourceThread(sourceThread, request.sourceSession.sessionId);
    const sourceTurns = codexThreadTurnIds(sourceThread);
    const anchorIndex = sourceTurns.indexOf(request.anchorTurn.turnId);
    if (anchorIndex < 0) throw providerForkRejected("The requested anchor Turn is not present in the source Provider session.");

    stage = "child-create";
    const forked = await lease.request("thread/fork", {
      threadId: request.sourceSession.sessionId,
      cwd: request.cwd,
      threadSource: "user",
    }, { timeoutMs: 30_000 });
    const forkedThread = codexThread(forked);
    childSessionId = codexThreadIdentity(forkedThread);
    if (!childSessionId || childSessionId === request.sourceSession.sessionId) {
      throw providerForkRejected("Provider did not return a distinct forked session.");
    }
    const dropCount = sourceTurns.length - anchorIndex - 1;
    if (dropCount > 0) {
      stage = "child-rollback";
      await lease.request("thread/rollback", { threadId: childSessionId, numTurns: dropCount }, { timeoutMs: 30_000 });
    }
    stage = "child-verify";
    const childRead = await lease.request("thread/read", { threadId: childSessionId, includeTurns: true }, { timeoutMs: 20_000 });
    const childThread = codexThread(childRead);
    assertForkSourceThread(childThread, childSessionId);
    const childTurns = codexThreadTurnIds(childThread);
    if (childTurns.at(-1) !== request.anchorTurn.turnId || childTurns.length !== anchorIndex + 1) {
      throw providerForkRejected("Forked Provider history does not end at the requested anchor Turn.");
    }
    return {
      session: { providerId: CODEX_PROVIDER_ID, sessionId: childSessionId },
      inheritedThroughTurn: { providerId: CODEX_PROVIDER_ID, sessionId: childSessionId, turnId: request.anchorTurn.turnId },
    };
  } catch (error) {
    if (childSessionId) {
      await lease.request("thread/archive", { threadId: childSessionId }, { timeoutMs: 5_000 }).catch(() => undefined);
    }
    if (error instanceof CodexAppServerJsonRpcError
      || (error instanceof Error && ["Conflict", "StaleProviderSession", "ProviderSessionForkRejected"].includes(error.name))) {
      throw providerForkRejected(error instanceof Error ? error.message : "Provider rejected session fork.", error);
    }
    throw providerForkTransportUncertain(stage, error);
  } finally {
    lease.release();
  }
}

export async function setCodexSessionArchived(
  request: ProviderSessionArchiveRequest,
): Promise<{ status: "completed" | "already-matched" }> {
  if (request.providerId !== CODEX_PROVIDER_ID || request.session.providerId !== CODEX_PROVIDER_ID) {
    const error = new Error("Codex session archive requires one exact Codex Provider session.");
    error.name = "ProviderSessionArchiveRejected";
    throw error;
  }
  const generation = defaultProjectRemovalFence.capture(request.projectId);
  const host = defaultCodexAppServerHostRegistry.hostForProject(request.projectId, request.cwd);
  const expectedMethod = request.archived ? "thread/archived" : "thread/unarchived";
  let notificationSettled = false;
  let resolveNotification!: () => void;
  let rejectNotification!: (error: Error) => void;
  const notification = new Promise<void>((resolve, reject) => {
    resolveNotification = resolve;
    rejectNotification = reject;
  });
  void notification.catch(() => undefined);
  const notificationTimeout = setTimeout(() => {
    if (notificationSettled) return;
    notificationSettled = true;
    rejectNotification(new Error(`Codex session lifecycle notification timed out for ${expectedMethod}.`));
  }, 10_000);
  let lease: Awaited<ReturnType<typeof host.acquire>> | null = null;
  try {
    lease = await host.acquire({
      onLine(line) {
        if (notificationSettled || !isProjectGenerationCurrent(request.projectId, generation)) return;
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (payload.method !== expectedMethod || !payload.params || typeof payload.params !== "object") return;
        const params = payload.params as Record<string, unknown>;
        const threadId = typeof params.threadId === "string"
          ? params.threadId
          : typeof params.thread_id === "string" ? params.thread_id : null;
        if (threadId !== request.session.sessionId) return;
        notificationSettled = true;
        clearTimeout(notificationTimeout);
        resolveNotification();
      },
      onStderr() {},
      onExit(error) {
        if (notificationSettled) return;
        notificationSettled = true;
        clearTimeout(notificationTimeout);
        rejectNotification(error);
      },
    });
    defaultProjectRemovalFence.assertCurrent(request.projectId, generation);
    if (request.archived) {
      await lease.request("thread/archive", { threadId: request.session.sessionId }, { timeoutMs: 10_000 });
    } else {
      const response = await lease.request("thread/unarchive", { threadId: request.session.sessionId }, { timeoutMs: 10_000 });
      if (codexThreadId(response) !== request.session.sessionId) {
        const error = new Error("Codex did not return the exact restored Provider session.");
        error.name = "StaleProviderSession";
        throw error;
      }
    }
    await notification;
    return { status: "completed" };
  } catch (error) {
    if (error instanceof CodexAppServerJsonRpcError
      || (error instanceof Error && ["Conflict", "StaleProviderSession"].includes(error.name))) {
      const rejection = new Error("Provider rejected session lifecycle synchronization.", { cause: error });
      rejection.name = "ProviderSessionArchiveRejected";
      throw rejection;
    }
    throw error;
  } finally {
    if (!notificationSettled) {
      notificationSettled = true;
      clearTimeout(notificationTimeout);
    }
    lease?.release();
  }
}

function codexThread(response: Record<string, unknown>): Record<string, unknown> | null {
  return response.thread && typeof response.thread === "object" && !Array.isArray(response.thread)
    ? response.thread as Record<string, unknown>
    : null;
}

function codexThreadIdentity(thread: Record<string, unknown> | null): string | null {
  return thread && typeof thread.id === "string" ? thread.id : null;
}

function codexThreadTurnIds(thread: Record<string, unknown> | null): string[] {
  if (!thread || !Array.isArray(thread.turns)) return [];
  return thread.turns.flatMap((turn) => turn && typeof turn === "object" && !Array.isArray(turn)
    && typeof (turn as Record<string, unknown>).id === "string"
    ? [(turn as Record<string, unknown>).id as string]
    : []);
}

function assertForkSourceThread(thread: Record<string, unknown> | null, expectedSessionId: string): void {
  if (codexThreadIdentity(thread) !== expectedSessionId) {
    throw providerForkRejected("Provider could not prove the requested session identity.");
  }
  const status = thread?.status;
  const type = typeof status === "string"
    ? status
    : status && typeof status === "object" && !Array.isArray(status) && typeof (status as Record<string, unknown>).type === "string"
      ? (status as Record<string, unknown>).type as string
      : null;
  if (type && type.toLowerCase() !== "idle") {
    throw providerForkRejected("Provider session must be idle before it can be forked.");
  }
}

function providerForkRejected(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ProviderSessionForkRejected";
  return error;
}

function providerForkTransportUncertain(stage: ProviderSessionForkTransportStage, cause: unknown): Error {
  const error = new Error("Provider session fork transport outcome is uncertain.", { cause });
  error.name = "ProviderSessionForkTransportUncertain";
  Object.assign(error, {
    stage,
    ...(cause instanceof CodexAppServerRequestTimeoutError ? { timeoutMs: cause.timeoutMs } : {}),
  });
  return error;
}

function codexThreadId(response: Record<string, unknown>): string | null {
  const thread = response.thread;
  return thread && typeof thread === "object" && !Array.isArray(thread)
    && typeof (thread as Record<string, unknown>).id === "string"
    ? (thread as Record<string, unknown>).id as string
    : null;
}

export function codexPlanCollaborationMode(request: ProviderTurnRequest): NonNullable<import("../codex/app-server.js").CodexAppServerTurnOptions["collaborationMode"]> {
  const model = request.model?.modelId?.trim();
  if (!model) throw new Error("Codex Plan Turn requires the admitted effective model.");
  return {
    mode: "plan",
    settings: {
      model,
      reasoning_effort: request.reasoningEffort ?? null,
      developer_instructions: null,
    },
  };
}

export async function runCodexChildTurn(request: ProviderChildTurnRequest): Promise<ProviderTurnResult> {
  if (request.providerId !== CODEX_PROVIDER_ID || request.parentSession.providerId !== CODEX_PROVIDER_ID || request.targetSession.providerId !== CODEX_PROVIDER_ID) {
    throw new Error("Codex Child continuation requires Codex parent and Child sessions.");
  }
  const projectGeneration = defaultProjectRemovalFence.capture(request.projectId);
  const result = await runCodexAppServerChildTurn({
    projectId: request.projectId,
    conversationId: request.conversationId,
    changeId: request.changeId,
    runtimeScopeId: request.runtimeScopeId,
    roleId: request.roleId,
    agentTaskId: request.agentTaskId,
    runId: request.runId,
    cwd: request.cwd,
    prompt: request.prompt,
    sandboxPolicy: request.sandboxPolicy,
    paths: request.paths,
    parentThreadId: request.parentSession.sessionId,
    targetThreadId: request.targetSession.sessionId,
    targetDisplayName: request.targetDisplayName,
    timeoutMs: request.timeoutMs,
    onRealtimeEvent: request.onRealtimeEvent ? (event) => {
      if (!isProjectGenerationCurrent(request.projectId, projectGeneration)) return;
      const mapped = mapRealtime(request, event);
      if (mapped) request.onRealtimeEvent?.(mapped);
    } : undefined,
    onChildLifecycleEvent: request.onChildLifecycleEvent
      ? (event) => {
        if (isProjectGenerationCurrent(request.projectId, projectGeneration)) {
          request.onChildLifecycleEvent?.(mapChildLifecycle(event));
        }
      }
      : undefined,
    onChildThreadResult: guardedProjectNotification(request.projectId, projectGeneration, request.onChildThreadResult
      ? (child) => request.onChildThreadResult?.(mapChild(child))
      : undefined),
    approvalMode: request.approvalMode ?? "never",
    onApprovalRequest: guardedProjectNotification(request.projectId, projectGeneration, request.onApprovalRequest
      ? (approval) => request.onApprovalRequest?.(mapApproval(request, approval))
      : undefined),
    onApprovalResolved: guardedProjectNotification(request.projectId, projectGeneration, request.onApprovalResolved
      ? (approval) => request.onApprovalResolved?.({
        providerId: CODEX_PROVIDER_ID,
        requestId: approval.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        runtimeScopeId: request.runtimeScopeId ?? request.changeId ?? request.runId,
        threadId: approval.threadId,
        turnId: approval.turnId,
      })
      : undefined),
    onError: guardedProjectNotification(request.projectId, projectGeneration, request.onError),
    model: request.model?.modelId,
    reasoningEffort: request.reasoningEffort,
    skillInputs: request.skillInputs?.map((skill) => ({ name: skill.id, path: skill.path })),
    requiredNativeSkills: request.skillInputs?.filter((skill) => skill.required).map((skill) => skill.id),
    runtimeWorkspaceRoots: request.runtimeWorkspaceRoots,
    additionalContext: request.additionalContext,
    writableRoots: request.writableRoots,
  });
  const child = [...result.childThreads].reverse()
    .find((candidate) => candidate.threadId === request.targetSession.sessionId && candidate.finalText.trim());
  return {
    providerId: CODEX_PROVIDER_ID,
    status: child ? child.status === "failed" ? "failed" : child.status === "interrupted" ? "interrupted" : "completed" : "failed",
    session: request.targetSession,
    turnId: child ? latestThreadTurnId(child.snapshot) : null,
    lastMessage: child?.finalText ?? "",
    childThreads: result.childThreads.map(mapChild),
    changedFiles: child?.changedFiles ?? [],
    ...(result.host ? { runtimeHost: result.host } : {}),
    ...(!child ? { error: result.error ?? "Codex did not complete the selected native Child follow-up." } : {}),
  };
}

async function inspectCodexChild(request: ProviderChildSessionRequest): Promise<"available" | "stale"> {
  if (request.providerId !== CODEX_PROVIDER_ID || request.parentSession.providerId !== CODEX_PROVIDER_ID || request.targetSession.providerId !== CODEX_PROVIDER_ID) {
    return "stale";
  }
  return isCodexAppServerChildAvailable(request.projectId, request.cwd, request.parentSession.sessionId, request.targetSession.sessionId)
    ? "available"
    : "stale";
}

async function closeCodexChild(request: ProviderChildCloseRequest): Promise<ProviderTurnResult> {
  if (request.providerId !== CODEX_PROVIDER_ID || request.parentSession.providerId !== CODEX_PROVIDER_ID || request.targetSession.providerId !== CODEX_PROVIDER_ID) {
    throw new Error("Codex Child close requires Codex parent and Child sessions.");
  }
  const projectGeneration = defaultProjectRemovalFence.capture(request.projectId);
  const result = await runCodexAppServerChildClose({
    projectId: request.projectId,
    conversationId: request.conversationId,
    changeId: request.changeId,
    runtimeScopeId: request.runtimeScopeId,
    roleId: request.roleId,
    runId: request.runId,
    cwd: request.cwd,
    sandboxPolicy: "read-only",
    paths: request.paths,
    parentThreadId: request.parentSession.sessionId,
    targetThreadId: request.targetSession.sessionId,
    targetDisplayName: request.targetDisplayName,
    timeoutMs: request.timeoutMs,
    onRealtimeEvent: request.onRealtimeEvent ? (event) => {
      if (!isProjectGenerationCurrent(request.projectId, projectGeneration)) return;
      const mapped = mapRealtime(request, event);
      if (mapped) request.onRealtimeEvent?.(mapped);
    } : undefined,
    onChildLifecycleEvent: request.onChildLifecycleEvent
      ? (event) => {
        if (isProjectGenerationCurrent(request.projectId, projectGeneration)) {
          request.onChildLifecycleEvent?.(mapChildLifecycle(event));
        }
      }
      : undefined,
    onError: guardedProjectNotification(request.projectId, projectGeneration, request.onError),
  });
  return {
    providerId: CODEX_PROVIDER_ID,
    status: result.status,
    session: request.targetSession,
    turnId: result.turnId,
    lastMessage: "",
    childThreads: [],
    changedFiles: [],
    ...(result.host ? { runtimeHost: result.host } : {}),
    error: result.error,
  };
}

function guardedProjectNotification<TArgs extends unknown[]>(
  projectId: string,
  generation: number,
  callback: ((...args: TArgs) => void) | undefined,
): ((...args: TArgs) => void) | undefined {
  if (!callback) return undefined;
  return (...args) => {
    if (!isProjectGenerationCurrent(projectId, generation)) return;
    callback(...args);
  };
}

function isProjectGenerationCurrent(projectId: string, generation: number): boolean {
  try {
    defaultProjectRemovalFence.assertCurrent(projectId, generation);
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "Conflict") return false;
    throw error;
  }
}

function latestThreadTurnId(snapshot: Record<string, unknown>): string | null {
  const thread = snapshot.thread;
  if (!thread || typeof thread !== "object") return null;
  const turns = (thread as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn && typeof turn === "object" && typeof (turn as { id?: unknown }).id === "string") return (turn as { id: string }).id;
  }
  return null;
}

function activeCodexTurn(runtimeScopeId: string): ActiveProviderTurn | null {
  const active = getActiveCodexAppServerTurn(runtimeScopeId);
  if (!active) return null;
  return mapActiveCodexTurn(active);
}

function activeCodexTurns(): ActiveProviderTurn[] {
  return listActiveCodexAppServerTurns().map(mapActiveCodexTurn);
}

function mapActiveCodexTurn(active: ActiveCodexAppServerTurn): ActiveProviderTurn {
  return {
    providerId: CODEX_PROVIDER_ID,
    turnKind: active.turnKind,
    attemptId: activeAttemptByScope.get(active.runtimeScopeId) ?? active.runId,
    changeId: active.changeId,
    runtimeScopeId: active.runtimeScopeId,
    roleId: active.roleId,
    runId: active.runId,
    session: { providerId: CODEX_PROVIDER_ID, sessionId: active.threadId },
    turnId: active.turnId,
    startedAt: active.startedAt,
    steer: active.steer,
    interrupt: active.interrupt,
    respondToUserInput: (requestId, response, expected) => active.respondToUserInput(requestId, { answers: response.answers }, { runId: expected?.runId ?? active.runId, threadId: expected?.sessionId, turnId: expected?.turnId }),
    respondToApproval: (requestId, decision, expected) => active.respondToApproval(requestId, decision, { runId: expected.runId, threadId: expected.sessionId, turnId: expected.turnId }),
  };
}

function mapRealtime(request: Pick<ProviderTurnRequest, "attemptId" | "graphScopeId">, event: CodexAppServerRealtimeEvent): ProviderRealtimeEvent | null {
  if (isCodexProtocolNoise(event)) return null;
  if (!event.threadId || !event.turnId) return null;
  const itemId = canonicalItemId(event);
  if (requiresCanonicalItem(event.streamEvent) && !itemId) return null;
  const targetThreadId = event.targetThreadId ?? null;
  return {
    ...event,
    providerId: CODEX_PROVIDER_ID,
    attemptId: request.attemptId,
    sessionId: event.threadId,
    turnId: event.turnId,
    ...(itemId ? { itemId } : {}),
    graphScopeId: request.graphScopeId,
    targetAgentSurfaceId: targetThreadId ? agentThreadSurfaceId(CODEX_PROVIDER_ID, targetThreadId) : undefined,
    streamEvent: canonicalStreamEvent(event.streamEvent, itemId),
  };
}

function mapContextEvent(event: CodexContextEvent): ProviderContextEvent {
  if (event.type === "compaction") {
    return {
      type: "compaction",
      session: { providerId: CODEX_PROVIDER_ID, sessionId: event.threadId },
      ...(event.turnId ? { turnId: event.turnId } : {}),
      itemId: event.itemId,
      phase: event.phase,
      occurredAt: event.occurredAt,
    };
  }
  const contextUsedTokens = safeContextSum(event.usage.last.inputTokens, event.usage.last.cachedInputTokens);
  return {
    type: "usage",
    session: { providerId: CODEX_PROVIDER_ID, sessionId: event.threadId },
    ...(event.turnId ? { turnId: event.turnId } : {}),
    usage: {
      total: event.usage.total,
      last: event.usage.last,
      contextUsedTokens,
      modelContextWindow: event.usage.modelContextWindow,
      updatedAt: event.occurredAt,
    },
  };
}

function safeContextSum(inputTokens: number, cachedInputTokens: number): number | null {
  const result = inputTokens + cachedInputTokens;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function canonicalStreamEvent(
  event: CodexAppServerRealtimeEvent["streamEvent"],
  itemId: string | undefined,
): ProviderRealtimeEvent["streamEvent"] {
  if (event.type === "tool_event") return { ...event, id: itemId! };
  if (event.type === "readable_event") return { ...event, event: { ...event.event, itemId: itemId! } };
  return event;
}

function requiresCanonicalItem(event: CodexAppServerRealtimeEvent["streamEvent"]): boolean {
  return event.type === "text_delta" || event.type === "tool_event" || event.type === "readable_event";
}

function canonicalItemId(event: CodexAppServerRealtimeEvent): string | undefined {
  if (event.streamEvent.type === "tool_event") return event.streamEvent.id ?? event.itemId;
  if (event.streamEvent.type === "readable_event") return event.streamEvent.event.itemId ?? event.itemId;
  return event.itemId;
}

function isCodexProtocolNoise(event: CodexAppServerRealtimeEvent): boolean {
  if (event.streamEvent.type !== "status") return false;
  const label = event.streamEvent.label.toLowerCase();
  return label.includes("codex thread started")
    || label.includes("codex initialized the thread")
    || label.includes("codex turn running")
    || label.includes("codex started processing the turn")
    || label.includes("codex turn completed")
    || label.includes("codex completed the turn");
}

function mapChild(child: import("../codex/app-server.js").CodexAppServerChildThreadResult): ProviderChildThreadResult {
  return {
    providerId: CODEX_PROVIDER_ID,
    ...(child.itemId ? { activityId: child.itemId } : {}),
    parentThreadId: child.parentThreadId,
    threadId: child.threadId,
    roleHint: child.roleHint,
    status: child.status,
    initialInput: child.initialUserItem,
    model: child.model,
    reasoningEffort: child.reasoningEffort,
    displayName: child.displayName,
    finalText: child.finalText,
    changedFiles: child.changedFiles,
  };
}

function mapChildLifecycle(event: import("../codex/collaboration-normalizer.js").CodexChildLifecycleEvent): ProviderChildLifecycleEvent {
  return {
    providerId: CODEX_PROVIDER_ID,
    kind: event.kind,
    activityId: event.activityId,
    parentSession: { providerId: CODEX_PROVIDER_ID, sessionId: event.parentThreadId },
    childSession: { providerId: CODEX_PROVIDER_ID, sessionId: event.childThreadId },
    turnId: event.turnId,
    roleHint: event.roleHint,
  };
}

function mapUserInput(request: ProviderTurnRequest, input: import("../codex/app-server.js").CodexAppServerUserInputRequest): ProviderUserInputRequest {
  return {
    ...input,
    providerId: CODEX_PROVIDER_ID,
    attemptId: request.attemptId,
    sessionId: input.threadId,
    questions: input.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      inputMode: question.isSecret ? "secret" : question.options?.length ? "single" : "text",
      allowCustom: question.isOther !== false,
      options: question.options?.map((option) => ({ value: option.label, label: option.label, description: option.description })),
    })),
  };
}

function mapApproval(
  request: Pick<ProviderTurnRequest, "attemptId" | "runId" | "runtimeScopeId">,
  approval: import("../codex/app-server.js").CodexAppServerApprovalRequest,
): ProviderApprovalRequest {
  return {
    ...approval,
    providerId: CODEX_PROVIDER_ID,
    attemptId: request.attemptId,
    runId: request.runId,
    runtimeScopeId: request.runtimeScopeId ?? approval.runtimeScopeId,
    sessionId: approval.threadId,
  };
}

function mapObjective(goal: import("../codex/app-server.js").CodexAppServerThreadGoal): ProviderObjectiveState {
  return {
    providerId: CODEX_PROVIDER_ID,
    sessionId: goal.threadId,
    objective: goal.objective,
    status: objectiveStatus(goal.status),
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function objectiveStatus(status: CodexAppServerThreadGoalStatus): ProviderObjectiveState["status"] {
  if (status === "usageLimited") return "usage-limited";
  if (status === "budgetLimited") return "budget-limited";
  return status;
}
