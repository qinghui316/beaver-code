import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ProjectRegistryStore } from "../registry/store.js";
import { recoverApplyApprovalReceipts, recoverDiscardApprovalReceipts } from "../apply/manager.js";
import { recoverIntegrationCheckApprovalReceipts } from "../integration-check/manager.js";
import { recoverSpecTestApprovalReceipts } from "../spec-test/proposal.js";
import type { WorkbenchProjectInput } from "../workbench/read-model-types.js";
import type { ManagedProject } from "../types/index.js";
import { TerminalRuntime } from "./terminal/terminal-runtime.js";
import { handleApi } from "./workbench/api-router.js";
import { restoreDirectProjectInput } from "./workbench/direct-project.js";
import { assertDesktopSession, sendJson, statusForError } from "./workbench/http.js";
import { defaultStaticRoot, serveStatic } from "./workbench/static.js";
import { defaultProviderRegistry } from "../provider-runtime/index.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../provider-runtime/project-harness-discovery.js";
import type { WorkbenchServeOptions, WorkbenchServerContext, WorkbenchServerHandle } from "./workbench/types.js";
import {
  ProjectRuntimeCoordinator,
  ProjectRuntimeUnavailableError,
  type ProjectRuntimeCoordinatorPort,
  type ProjectRuntimeStartupResult,
  type ProjectRuntimeStartupState,
} from "../project-runtime/coordinator.js";
import { WorkbenchProjectRemovalService } from "./workbench/project-removal.js";
import { reconcileRecoveredApprovalDecisions } from "../workbench/actions/approval-decision-reconciliation.js";
import { reconcileStaleAgentNativeChildren } from "../workbench/agent-native-child-lifecycle-service.js";
import { ProjectSkillRuntimeContextResolver } from "../skill/project-skill-runtime-context-resolver.js";
import { createConversationTurnRouter } from "../workbench/conversation-turn-router.js";
import { reconcileStaleProviderInputRequests } from "../workbench/provider-input-lifecycle.js";
import { ConversationTurnControlOwner } from "../workbench/conversation-turn-control.js";
import { reconcileStaleAgentMainAttempts } from "../workbench/agent-main-attempt-recovery.js";
import { ConversationTurnRetryOwner } from "../workbench/conversation-turn-retry.js";
import { TurnAttachmentResolver } from "../workbench/turn-attachment-resolver.js";
import { ComposerDraftRecoveryService } from "../workbench/composer-draft-recovery.js";
import { ProductModeActivityProjectionOwner } from "../workbench/product-mode-activity.js";
import { ConversationContextLifecycleOwner } from "../workbench/conversation-context-lifecycle.js";
import { ConversationForkLifecycleOwner } from "../workbench/conversation-fork-lifecycle.js";
import { ConversationTurnQueueOwner } from "../workbench/conversation-turn-queue.js";
import { ConversationLifecycleOwner } from "../workbench/conversation-lifecycle.js";
import { ConversationReviewLifecycleOwner } from "../workbench/conversation-review-lifecycle.js";
import { defaultProjectRuntimeActivityRegistry } from "../project-runtime/activity.js";
import { WorkbenchDatabaseCompatibilityError } from "../workbench/persistence/schema-migrations.js";
import { inspectWorkbenchDatabaseUpgradeState } from "../workbench/persistence/database-upgrade.js";
import { WORKBENCH_SCHEMA_VERSION } from "../workbench/persistence/schema.js";
import { WorkbenchMigrationBusyError } from "../workbench/persistence/migration-errors.js";
import { WorkbenchUpdateLifecycle } from "../workbench/update-lifecycle.js";
import { WorkbenchUpdateRequestGate } from "./workbench/update-request-gate.js";
import { WorkbenchUpdateRendererChannel } from "./workbench/update-renderer-channel.js";

export type { WorkbenchServeOptions, WorkbenchServerHandle } from "./workbench/types.js";
export { executeWorkbenchAction } from "./workbench/actions.js";
export { buildNativeFolderDialogCommand, openNativeFolderDialog } from "./workbench/native-dialog.js";

export async function startWorkbenchServer(input: WorkbenchProjectInput | null = null, options: WorkbenchServeOptions = {}): Promise<WorkbenchServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const staticRoot = options.staticRoot ?? defaultStaticRoot();
  const store = options.store ?? new ProjectRegistryStore();
  const projectRuntimeCoordinator = options.projectRuntimeCoordinator ?? new ProjectRuntimeCoordinator({
    store,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    inspectWorkbenchData: inspectWorkbenchDatabaseUpgradeState,
  });
  const providerRegistry = options.providerRegistry ?? defaultProviderRegistry;
  const projectRemoval = options.projectRemoval ?? new WorkbenchProjectRemovalService({ store, providerRegistry });
  for (const project of await store.listProjects()) projectRemoval.activateAfterRegistration(project.id);
  const terminalRuntime = options.terminalRuntime ?? new TerminalRuntime();
  const skillContext = new ProjectSkillRuntimeContextResolver({
    providerRegistry,
    projectRuntimeCoordinator,
  });
  const turnControl = options.turnControl ?? new ConversationTurnControlOwner({
    providerRegistry,
    projectRuntimeCoordinator,
  });
  const conversationContext = options.conversationContext ?? new ConversationContextLifecycleOwner({
    providerRegistry,
    projectRuntimeCoordinator,
  });
  const conversationFork = options.conversationFork ?? new ConversationForkLifecycleOwner({
    providerRegistry,
    projectRuntimeCoordinator,
    turnControl,
    conversationContext,
  });
  const attachmentResolver = new TurnAttachmentResolver({
    resolveRuntimePaths: (projectId) => projectRuntimeCoordinator.runtimePaths(projectId),
  });
  const turnRouter = createConversationTurnRouter({
    skillContext,
    providerRegistry,
    projectRuntimeCoordinator,
    turnControl,
    contextLifecycle: conversationContext,
    attachmentResolver,
  });
  const turnRetry = options.turnRetry ?? new ConversationTurnRetryOwner(turnRouter);
  const conversationReview = options.conversationReview ?? new ConversationReviewLifecycleOwner({
    providerRegistry,
    projectRuntimeCoordinator,
    turnControl,
    contextLifecycle: conversationContext,
  });
  const conversationTurnQueue = options.conversationTurnQueue ?? new ConversationTurnQueueOwner({
    projectRuntimeCoordinator,
    turnRouter,
    reviewDispatch: conversationReview,
    providerRegistry,
  });
  const conversationLifecycle = options.conversationLifecycle ?? new ConversationLifecycleOwner({
    providerRegistry,
    projectRuntimeCoordinator,
    turnControl,
  });
  const composerDraftRecovery = options.composerDraftRecovery ?? new ComposerDraftRecoveryService({
    attachmentResolver,
    providerRegistry,
  });
  const productModeActivity = options.productModeActivity ?? new ProductModeActivityProjectionOwner();
  const updateGate = options.desktopHost?.updateGeneration ? new WorkbenchUpdateRequestGate() : undefined;
  const updateChannel = updateGate ? new WorkbenchUpdateRendererChannel(
    options.desktopHost?.chooseUpdate, options.desktopHost?.acknowledgeInstalledNotes) : undefined;
  const releaseAdmissionObserver = updateGate
    ? turnControl.subscribeAdmission(() => updateGate.managedExecutionRegistered())
    : () => {};
  const startup = await projectRuntimeCoordinator.reconcileStartup();
  const restoredInput = await restoreDirectProjectInput(input, store);
  const composedInput = restoredInput
    ? {
      ...restoredInput,
      runtimeStateResolver: (project: ManagedProject) => projectRuntimeCoordinator.resolve(project),
      turnControlStateResolver: (projectId: string, conversationId: string, attemptId?: string) => turnControl.state(projectId, conversationId, attemptId),
      conversationContextSnapshotResolver: (project: ManagedProject, productMode: import("../provider-runtime/index.js").ProductMode, conversationId: string) => conversationContext.read(project, productMode, conversationId),
      conversationLifecycleSnapshotResolver: (project: ManagedProject, productMode: import("../provider-runtime/index.js").ProductMode, conversationId: string) => conversationLifecycle.read(project, productMode, conversationId),
    }
    : restoredInput;
  const recoveredProjectIds = new Set<string>();
  await recoverWorkbenchProjects(
    store,
    composedInput,
    projectRuntimeCoordinator,
    providerRegistry,
    conversationContext,
    conversationFork,
    conversationTurnQueue,
    conversationLifecycle,
    conversationReview,
    startup,
    {
      recoveredProjectIds,
      shouldRecover: (project, runtime) => runtime.state !== "ready"
        || runtime.workbenchData?.state !== "upgrade-required"
        || composedInput?.project?.id === project.id,
    },
  );
  const recoveryInFlight = new Map<string, Promise<void>>();
  const ensureProjectRecovered = async (projectId: string): Promise<void> => {
    if (recoveredProjectIds.has(projectId)) return;
    const existing = recoveryInFlight.get(projectId);
    if (existing) return existing;
    const recovery = (async () => {
      const project = await store.resolveProject(projectId);
      if (!project) return;
      const runtime = await projectRuntimeCoordinator.startupState(project);
      if (runtime.state === "unavailable") throw new ProjectRuntimeUnavailableError(runtime);
      if (runtime.state === "ready" && runtime.workbenchData?.state === "upgrade-required") {
        projectRuntimeCoordinator.markWorkbenchDataState?.(project, {
          state: "upgrading",
          schemaVersion: runtime.workbenchData.schemaVersion,
        });
      }
      const recovered = await recoverWorkbenchProject({
        project,
        runtime,
        projectRuntimeCoordinator,
        providerRegistry,
        conversationContext,
        conversationFork,
        conversationTurnQueue,
        conversationLifecycle,
        conversationReview,
      });
      const current = await projectRuntimeCoordinator.startupState(project);
      if (!recovered || current.state === "unavailable") {
        throw new ProjectRuntimeUnavailableError(current as import("../project-runtime/coordinator.js").ProjectRuntimeUnavailable);
      }
      projectRuntimeCoordinator.markWorkbenchDataState?.(project, {
        state: "ready",
        schemaVersion: WORKBENCH_SCHEMA_VERSION,
      });
      recoveredProjectIds.add(projectId);
    })().finally(() => recoveryInFlight.delete(projectId));
    recoveryInFlight.set(projectId, recovery);
    return recovery;
  };
  const context: WorkbenchServerContext = {
    input: composedInput,
    staticRoot,
    store,
    projectRuntimeCoordinator,
    providerRegistry,
    projectRemoval,
    terminalRuntime,
    turnRouter,
    turnControl,
    turnRetry,
    composerDraftRecovery,
    productModeActivity,
    conversationContext,
    conversationFork,
    conversationTurnQueue,
    conversationLifecycle,
    conversationReview,
    ensureProjectRecovered,
    desktopHost: options.desktopHost,
    updateGate,
    updateChannel,
  };
  const sockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  const inFlightRequests = new Set<Promise<void>>();
  let acceptingRequests = true;
  const server = createServer((request, response) => {
    responses.add(response);
    response.once("close", () => responses.delete(response));
    if (!acceptingRequests) {
      sendJson(response, 503, { error: "Beaver Code is closing." });
      return;
    }
    const operation = handleRequest(context, request, response)
      .catch((error: unknown) => {
        sendJson(response, statusForError(error), { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => inFlightRequests.delete(operation));
    inFlightRequests.add(operation);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let runtimeCleanup: Promise<void> | null = null;
  let strictUpdateShutdown = false;
  const cleanupRuntime = (): Promise<void> => runtimeCleanup ??= (async () => {
    releaseAdmissionObserver();
    const failures: unknown[] = [];
    try {
      await providerRegistry.shutdownAll("Workbench server stopped.");
      if (strictUpdateShutdown && providerRegistry.runtimeLiveness().liveHostCount !== 0) {
        throw new Error("Provider processes have not confirmed exit.");
      }
    } catch (cause) {
      appendShutdownFailure(failures, cause);
    }
    try {
      if (strictUpdateShutdown) await terminalRuntime.shutdown();
      else terminalRuntime.cleanup();
    } catch (cause) {
      appendShutdownFailure(failures, cause);
    }
    if (failures.length > 0) throw new AggregateError(failures, "Workbench runtime cleanup failed.");
  })();
  server.on("close", () => {
    void cleanupRuntime().catch(() => undefined);
  });
  await new Promise<void>((resolvePromise) => server.listen(port, host, resolvePromise));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const handle: WorkbenchServerHandle = {
    server,
    url: `http://${host}:${actualPort}`,
    snapshot: () => readRuntimeSnapshot({
      store,
      directInput: composedInput,
      projectRuntimeCoordinator,
      providerRegistry,
      terminalRuntime,
      productModeActivity,
      turnControl,
      conversationContext,
      conversationLifecycle,
    }),
    async close(deadlineMs = 8_000) {
      acceptingRequests = false;
      let shutdownStage = "reading registered projects";
      const registered = await store.listProjects();
      const directProject = composedInput?.project;
      const projectIds = new Set(registered.map((project) => project.id));
      if (directProject) projectIds.add(directProject.id);
      for (const projectId of projectIds) defaultProjectRuntimeActivityRegistry.blockProject(projectId);
      const closing = (async () => {
        const failures: unknown[] = [];
        shutdownStage = "interrupting active work";
        const interruptionResults = await Promise.allSettled([
          turnControl.interruptAll("Beaver Code is closing."),
          ...providerRegistry.listActiveTurns()
            .filter((turn) => turn.roleId !== "main-agent")
            .map((turn) => turn.interrupt("Beaver Code is closing.")),
        ]);
        for (const result of interruptionResults) {
          if (result.status === "rejected") appendShutdownFailure(failures, result.reason);
        }
        for (const response of responses) {
          const contentType = String(response.getHeader("content-type") ?? "");
          if (contentType.startsWith("text/event-stream") && !response.writableEnded) response.end();
        }
        if (failures.length === 0) {
          shutdownStage = "draining active work";
          const drainResults = await Promise.allSettled([
            turnControl.drain(),
            ...[...projectIds].map((projectId) => defaultProjectRuntimeActivityRegistry.drainProject(projectId)),
            ...inFlightRequests,
          ]);
          for (const result of drainResults) {
            if (result.status === "rejected") appendShutdownFailure(failures, result.reason);
          }
        }
        try {
          shutdownStage = "stopping runtime processes";
          await cleanupRuntime();
        } catch (cause) {
          appendShutdownFailure(failures, cause);
        }
        try {
          shutdownStage = "closing local connections";
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            // Every handler has drained and SSE has ended. The renderer remains
            // alive until the Utility receipt reaches Electron Main, so a
            // Chromium keep-alive peer must not be allowed to delay that receipt.
            server.closeIdleConnections();
            server.closeAllConnections();
            for (const socket of sockets) socket.destroy();
          });
        } catch (cause) {
          appendShutdownFailure(failures, cause);
        }
        if (failures.length > 0) throw new AggregateError(failures, "Workbench shutdown failed.");
      })();
      let timeout: NodeJS.Timeout | undefined;
      let completed = false;
      try {
        await Promise.race([
          closing,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(
              `Workbench shutdown deadline exceeded while ${shutdownStage}.`,
            )), Math.max(1, deadlineMs));
          }),
        ]);
        completed = true;
      } catch (cause) {
        for (const socket of sockets) socket.destroy();
        throw cause;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (completed) {
          for (const projectId of projectIds) defaultProjectRuntimeActivityRegistry.activateProject(projectId);
        }
      }
    },
  };
  if (updateGate && updateChannel && options.desktopHost?.updateGeneration) {
    const lifecycle = new WorkbenchUpdateLifecycle({
      pauseNewWork: (identity) => {
        const releaseRequests = updateGate.pause(identity.updateId);
        const releaseQueue = conversationTurnQueue.pauseDispatch();
        const releaseRuntime = defaultProjectRuntimeActivityRegistry.pauseAll();
        return () => { releaseRuntime(); releaseQueue(); releaseRequests(); };
      },
      prepareRenderer: (identity, signal) => updateChannel.request("prepare", identity, signal),
      drainMutations: (signal) => updateGate.drain(signal),
      cancelRenderer: (identity) => updateChannel.request("cancel", identity),
      shutdown: async (deadlineMs, signal) => {
        const identity = handle.updates?.snapshot().identity;
        if (!identity) throw new Error("Update preparation is missing.");
        await updateChannel.request("confirm", identity, signal);
        if (signal.aborted) throw new Error("Update shutdown was canceled.");
        strictUpdateShutdown = true;
        await handle.close(deadlineMs);
      },
    }, options.desktopHost.updateGeneration);
    handle.updates = {
      prepare: (identity) => lifecycle.prepare(identity),
      stop: (identity) => lifecycle.stop(identity),
      cancel: (identity) => lifecycle.cancel(identity),
      snapshot: () => lifecycle.snapshot(),
      publishOffer: (offer) => updateChannel.publishOffer(offer),
      publishActivity: (activity) => updateChannel.publishActivity(activity),
      publishInstalledNotes: (notes) => updateChannel.publishInstalledNotes(notes),
    };
  }
  return handle;
}

function appendShutdownFailure(failures: unknown[], cause: unknown): void {
  if (cause instanceof AggregateError) {
    for (const nested of cause.errors) appendShutdownFailure(failures, nested);
    return;
  }
  failures.push(cause);
}

async function readRuntimeSnapshot(input: {
  store: ProjectRegistryStore;
  directInput: WorkbenchProjectInput | null;
  projectRuntimeCoordinator: ProjectRuntimeCoordinatorPort;
  providerRegistry: typeof defaultProviderRegistry;
  terminalRuntime: TerminalRuntime;
  productModeActivity: ProductModeActivityProjectionOwner;
  turnControl: ConversationTurnControlOwner;
  conversationContext: ConversationContextLifecycleOwner;
  conversationLifecycle: ConversationLifecycleOwner;
}): Promise<import("./workbench/types.js").WorkbenchRuntimeSnapshot> {
  const activeTurnCount = input.providerRegistry.listActiveTurns().length;
  const activeTerminalCount = input.terminalRuntime.activeSessionCount();
  const liveProviderHostCount = input.providerRegistry.runtimeLiveness().liveHostCount;
  if (activeTurnCount + activeTerminalCount + liveProviderHostCount > 0) {
    return { state: "active", activeTurnCount, activeTerminalCount, pendingInteractionCount: 0 };
  }
  try {
    const registered = await input.store.listProjects();
    const directProject = input.directInput?.project;
    const projects = directProject && !registered.some((project) => project.id === directProject.id)
      ? [...registered, directProject]
      : registered;
    let pendingInteractionCount = 0;
    let hasBackgroundActivity = false;
    for (const project of projects) {
      const runtime = await input.projectRuntimeCoordinator.startupState(project);
      if (runtime.state === "unavailable"
        || (runtime.state === "ready" && runtime.workbenchData && runtime.workbenchData.state !== "ready")) continue;
      const projectInput: WorkbenchProjectInput = {
        project,
        path: project.path,
        runtimeStateResolver: (selected) => input.projectRuntimeCoordinator.resolve(selected),
        turnControlStateResolver: (projectId, conversationId, attemptId) => input.turnControl.state(projectId, conversationId, attemptId),
        conversationContextSnapshotResolver: (selected, productMode, conversationId) => input.conversationContext.read(selected, productMode, conversationId),
        conversationLifecycleSnapshotResolver: (selected, productMode, conversationId) => input.conversationLifecycle.read(selected, productMode, conversationId),
      };
      const activity = await input.productModeActivity.read(projectInput);
      for (const mode of [activity.agent, activity.harness]) {
        if (mode.state === "attention" || mode.state === "failed") pendingInteractionCount += 1;
        if (mode.state === "running") hasBackgroundActivity = true;
      }
    }
    return {
      state: pendingInteractionCount > 0 ? "attention" : hasBackgroundActivity ? "active" : "idle",
      activeTurnCount,
      activeTerminalCount,
      pendingInteractionCount,
    };
  } catch {
    return { state: "unknown", activeTurnCount, activeTerminalCount, pendingInteractionCount: 0 };
  }
}

export async function recoverWorkbenchProjects(
  store: ProjectRegistryStore,
  directInput: WorkbenchProjectInput | null,
  projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve"> & Partial<Pick<ProjectRuntimeCoordinatorPort, "markUnavailable" | "markWorkbenchDataState" | "startupState">> = new ProjectRuntimeCoordinator({
    store,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  }),
  providerRegistry = defaultProviderRegistry,
  conversationContext?: ConversationContextLifecycleOwner,
  conversationFork?: ConversationForkLifecycleOwner,
  conversationTurnQueue?: ConversationTurnQueueOwner,
  conversationLifecycle?: ConversationLifecycleOwner,
  conversationReview?: ConversationReviewLifecycleOwner,
  startup?: Pick<ProjectRuntimeStartupResult, "states">,
  options: {
    shouldRecover?: (project: ManagedProject, runtime: ProjectRuntimeStartupState) => boolean;
    recoveredProjectIds?: Set<string>;
  } = {},
): Promise<void> {
  const projects = await store.listProjects();
  if (directInput?.project && !projects.some((project) => project.id === directInput.project?.id || project.path === directInput.project?.path)) {
    projects.push(directInput.project);
  }
  if (directInput?.project) {
    projects.sort((left, right) => Number(right.id === directInput.project?.id) - Number(left.id === directInput.project?.id));
  }
  const startupByProjectId = new Map(startup?.states.map((state) => [state.project.id, state] as const) ?? []);
  for (const project of projects) {
    if (!existsSync(project.path)) continue;
    let runtime: ProjectRuntimeStartupState | undefined = startupByProjectId.get(project.id);
    if (!runtime) runtime = projectRuntimeCoordinator.startupState
      ? await projectRuntimeCoordinator.startupState(project)
      : await projectRuntimeCoordinator.resolve(project);
    if (options.shouldRecover && !options.shouldRecover(project, runtime)) continue;
    let recovered = false;
    try {
      recovered = await recoverWorkbenchProject({
        project,
        runtime,
        projectRuntimeCoordinator,
        providerRegistry,
        conversationContext,
        conversationFork,
        conversationTurnQueue,
        conversationLifecycle,
        conversationReview,
      });
    } catch (cause) {
      if (!(cause instanceof WorkbenchMigrationBusyError)) throw cause;
      continue;
    }
    if (recovered) options.recoveredProjectIds?.add(project.id);
  }
}

async function recoverWorkbenchProject(input: {
  project: ManagedProject;
  runtime: ProjectRuntimeStartupState;
  projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve"> & Partial<Pick<ProjectRuntimeCoordinatorPort, "markUnavailable" | "markWorkbenchDataState">>;
  providerRegistry: typeof defaultProviderRegistry;
  conversationContext?: ConversationContextLifecycleOwner;
  conversationFork?: ConversationForkLifecycleOwner;
  conversationTurnQueue?: ConversationTurnQueueOwner;
  conversationLifecycle?: ConversationLifecycleOwner;
  conversationReview?: ConversationReviewLifecycleOwner;
}): Promise<boolean> {
  const { project, projectRuntimeCoordinator, providerRegistry, conversationContext, conversationFork, conversationTurnQueue, conversationLifecycle, conversationReview } = input;
  const runtime = input.runtime;
  try {
    if (runtime.state !== "ready") return true;
    await reconcileStaleAgentMainAttempts({ project, providerRegistry, runtimeState: runtime });
    await reconcileStaleAgentNativeChildren({ project, providerRegistry });
    const runtimePaths = runtime.resolution.paths;
    await reconcileStaleProviderInputRequests({ runtime: runtimePaths, providerRegistry });
    await conversationContext?.reconcileProject(runtimePaths);
    await conversationFork?.reconcileProject(runtimePaths);
    await conversationTurnQueue?.reconcileProject(runtimePaths);
    await conversationLifecycle?.reconcileProject(runtimePaths);
    await conversationReview?.reconcileProject(runtimePaths);
    const reconcileReceipt = (receipt: Parameters<typeof reconcileRecoveredApprovalDecisions>[1][number]) => (
      reconcileRecoveredApprovalDecisions(project, [receipt])
    );
    await recoverApplyApprovalReceipts(project, true, reconcileReceipt);
    await recoverIntegrationCheckApprovalReceipts(project, true, reconcileReceipt);
    await recoverDiscardApprovalReceipts(project, true, reconcileReceipt);
    await recoverSpecTestApprovalReceipts(project, reconcileReceipt);
    return true;
  } catch (cause) {
    if (cause instanceof WorkbenchMigrationBusyError) {
      if (runtime.state === "ready" && runtime.workbenchData?.state === "upgrade-required") {
        projectRuntimeCoordinator.markWorkbenchDataState?.(project, runtime.workbenchData);
      }
      throw cause;
    }
    projectRuntimeCoordinator.markUnavailable?.(project, workbenchRecoveryIssue(cause));
    return false;
  }
}

function workbenchRecoveryIssue(cause: unknown): import("../project-runtime/coordinator.js").ProjectRuntimeStartupIssue {
  if (!(cause instanceof WorkbenchDatabaseCompatibilityError)) {
    return {
      code: "project-recovery-failed",
      summary: "这个项目的协作配置需要处理。",
      recovery: "请检查项目协作配置，然后重新启动 Beaver Code。",
    };
  }
  if (cause.code === "newer-version") {
    return {
      code: "workbench-data-newer",
      summary: "这个项目的数据由更新版本的 Beaver Code 创建。",
      recovery: "请使用创建这些数据的版本打开项目。",
    };
  }
  if (cause.code === "unsupported-legacy") {
    return {
      code: "workbench-data-unsupported",
      summary: "这个项目的数据版本过旧，无法自动升级。",
      recovery: "原有数据保持不变，请使用兼容版本进行恢复。",
    };
  }
  if (cause.code === "corrupt") {
    return {
      code: "workbench-data-corrupt",
      summary: "这个项目的数据无法读取。",
      recovery: "原有数据保持不变，请查看诊断信息后恢复。",
    };
  }
  return {
    code: "workbench-data-recovery-required",
    summary: "这个项目的数据需要恢复。",
    recovery: "原有数据已保留，请查看诊断信息后重试。",
  };
}

async function handleRequest(
  context: WorkbenchServerContext, request: IncomingMessage, response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const desktopHost = context.desktopHost;
    let endOperation: (() => void) | undefined;
    if (desktopHost) {
      assertDesktopSession(request, desktopHost.sessionToken, desktopHost.cookieName);
    }
    if (context.updateChannel && await context.updateChannel.handle(request, response, url)) return;
    if (context.updateGate?.paused && request.method === "GET" && url.pathname !== "/api/app/status") {
      sendJson(response, 409, { error: "正在保存并更新，请稍候。" });
      return;
    }
    const isDraftSave = request.method === "PUT" && /^\/api\/projects\/[^/]+\/workbench\/composer-draft$/.test(url.pathname);
    const header = request.headers["x-beaver-update-id"];
    const lease = context.updateGate?.begin(
      request.method === "GET" ? "read" : isDraftSave ? "draft-save" : "mutation",
      typeof header === "string" ? header : undefined,
    );
    let outcome: "settled" | "uncertain" = "uncertain";
    try {
      endOperation = await desktopHost?.beginOperation?.();
      if (lease && context.updateGate) await context.updateGate.runTracked(lease, () => handleApi(context, request, response, url));
      else await handleApi(context, request, response, url);
      outcome = response.statusCode < 500 ? "settled" : "uncertain";
    } catch (cause) {
      // Admission/validation rejections have a definite HTTP outcome. Only
      // genuinely unknown server/transport failures poison the update drain.
      if (statusForError(cause) < 500) outcome = "settled";
      throw cause;
    } finally {
      lease?.complete(outcome);
      endOperation?.();
    }
    return;
  }
  await serveStatic(context.staticRoot, url.pathname, response);
}
