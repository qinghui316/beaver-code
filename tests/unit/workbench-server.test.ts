import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRegistryStore } from "../../src/registry/store.js";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { ProjectRuntimeCoordinator, ProjectRuntimeUnavailableError, type ProjectRuntimeCoordinatorPort } from "../../src/project-runtime/coordinator.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../../src/provider-runtime/project-harness-discovery.js";
import type { RunMetadata } from "../../src/types/index.js";
import { TerminalRuntime } from "../../src/server/terminal/terminal-runtime.js";
import { buildNativeFolderDialogCommand, executeWorkbenchAction, recoverWorkbenchProjects, startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/workbench-server.js";
import type { ManagedProject } from "../../src/types/index.js";
import { appendCanonicalTimelineEntry } from "../../src/workbench/canonical-timeline-command.js";
import { buildProjectScopedMainAgentPrompt } from "../../src/workbench/main-agent-turn-coordinator.js";
import { resolveTopicAttachments } from "../../src/workbench/attachments.js";
import type { ConversationTurnRoutingPort } from "../../src/workbench/conversation-turn-contract.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { materializeWorkbenchSchemaContract } from "../../src/workbench/persistence/schema-migrations.js";
import { applyCurrentWorkbenchSchema, WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";
import type { ConversationTurnControlOwner } from "../../src/workbench/conversation-turn-control.js";
import type { ConversationTurnRetryOwner } from "../../src/workbench/conversation-turn-retry.js";
import type { ConversationContextLifecycleOwner } from "../../src/workbench/conversation-context-lifecycle.js";
import type { ConversationForkLifecycleOwner } from "../../src/workbench/conversation-fork-lifecycle.js";
import type { ConversationTurnQueueOwner } from "../../src/workbench/conversation-turn-queue.js";
import type { ConversationLifecycleOwner } from "../../src/workbench/conversation-lifecycle.js";
import type { ConversationReviewLifecycleOwner } from "../../src/workbench/conversation-review-lifecycle.js";
import { createConversationChangeFixture } from "../helpers/conversation-change-fixture.js";
import { createFakeCodexRuntime } from "../helpers/fake-codex-runtime.js";
import { resetCodexRuntimeForTests } from "../../src/codex/executable.js";
import { sameTestPhysicalPath } from "../helpers/windows-short-path.js";
import { createReadyProjectHarnessFixture } from "../helpers/project-harness-fixture.js";
import { ProviderRegistry } from "../../src/provider-runtime/registry.js";
import { conversationAccessApi } from "../../src/web/src/controllers/conversation-access-http-adapter.js";
import type { ProviderDescriptor } from "../../src/provider-runtime/contracts.js";

let tempDir: string;
let staticRoot: string;
let registryRoot: string;
let handle: WorkbenchServerHandle | null = null;
let originalCodexHome: string | undefined;
let originalCodexBin: string | undefined;
let originalAhoHome: string | undefined;
let serverConversationId: string;
let serverRunId: string;
const execFileAsync = promisify(execFile);

interface SnapshotResponse {
  left: { topics: Array<{ id: string }> };
  center: { selectedTopic?: { id: string } | null; agentLoop: { runs: Array<{ id: string }> } };
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  return body.split(/\r?\n\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    return event && data ? [{ event, data: JSON.parse(data) as unknown }] : [];
  });
}

function project(): ManagedProject {
  return {
    id: "repo",
    name: "Repo",
    path: tempDir,
    addedAt: "2026-05-15T00:00:00.000Z",
    lastSeenAt: "2026-05-15T00:00:00.000Z",
  };
}

describe("workbench server", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "aho-server-"));
    staticRoot = await mkdtemp(join(tmpdir(), "aho-web-"));
    registryRoot = await mkdtemp(join(tmpdir(), "aho-registry-"));
    originalCodexHome = process.env.CODEX_HOME;
    originalCodexBin = process.env.AHO_CODEX_BIN;
    originalAhoHome = process.env.AHO_HOME;
    process.env.CODEX_HOME = join(tempDir, "codex-home");
    process.env.AHO_HOME = registryRoot;
    process.env.AHO_CODEX_BIN = await createFakeCodexRuntime(tempDir);
    resetCodexRuntimeForTests();
    await writeFile(join(staticRoot, "index.html"), "<div>AHO</div>", "utf8");
    await createReadyProjectHarnessFixture({
      projectRoot: tempDir,
      ahoHome: registryRoot,
      projectId: project().id,
      projectName: project().name,
    });
    const conversation = await createConversationChangeFixture(project(), { title: "Server Topic" });
    serverConversationId = conversation.conversationId;
    serverRunId = await writeRuntimeSidecarRun(conversation.changeId);
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
    });
  });

  afterEach(async () => {
    if (handle) await new Promise<void>((resolve) => handle?.server.close(() => resolve()));
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalCodexBin === undefined) delete process.env.AHO_CODEX_BIN;
    else process.env.AHO_CODEX_BIN = originalCodexBin;
    resetCodexRuntimeForTests();
    if (originalAhoHome === undefined) delete process.env.AHO_HOME;
    else process.env.AHO_HOME = originalAhoHome;
    const cleanupOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;
    await rm(tempDir, cleanupOptions);
    await rm(staticRoot, cleanupOptions);
    await rm(registryRoot, cleanupOptions);
  });

  it("serves workbench JSON routes and static index", async () => {
    const snapshot = await getJson<SnapshotResponse>(`${handle!.url}/api/workbench/snapshot?productMode=harness`);
    expect(snapshot.left.topics[0]).toMatchObject({ id: serverConversationId, boundChangeId: "server-topic" });

    const fullThread = await getJson<{ center: { thread: { items: unknown[] }; selectedTopic: { threadItems: unknown[] } } }>(
      `${handle!.url}/api/projects/repo/workbench/snapshot?productMode=harness&topic=${serverConversationId}`,
    );
    const compactThread = await getJson<{ center: { thread: { items: unknown[] }; selectedTopic: { threadItems: unknown[] } } }>(
      `${handle!.url}/api/projects/repo/workbench/snapshot?productMode=harness&topic=${serverConversationId}&compactThread=1`,
    );
    expect(fullThread.center.thread.items.length).toBeGreaterThan(0);
    expect(compactThread.center.thread.items).toEqual([]);
    expect(compactThread.center.selectedTopic.threadItems).toEqual([]);

    const topics = await getJson<unknown[]>(`${handle!.url}/api/projects/repo/workbench/topics?productMode=harness`);
    expect(topics).toHaveLength(1);

    const navigation = await getJson<{ conversations: Array<{ id: string; title: string; userStatusLabel: string; lifecycle: { lifecycleRevision: string } }> }>(
      `${handle!.url}/api/projects/repo/workbench/navigation?productMode=harness`,
    );
    expect(navigation.conversations).toHaveLength(1);
    expect(navigation.conversations[0]).toMatchObject({ id: serverConversationId, title: "Server Topic", userStatusLabel: "等你确认" });
    expect(navigation.conversations[0]?.lifecycle.lifecycleRevision).toMatch(/^conversation-lifecycle:/);
    expect(JSON.stringify(navigation)).not.toContain("threadItems");

    const activity = await getJson<Record<string, unknown>>(`${handle!.url}/api/projects/repo/workbench/mode-activity`);
    expect(Object.keys(activity).sort()).toEqual(["agent", "generatedAt", "harness", "projectId"]);
    expect(Object.keys(activity.agent as Record<string, unknown>).sort()).toEqual(["productMode", "state", "updatedAt"]);
    expect(Object.keys(activity.harness as Record<string, unknown>).sort()).toEqual(["productMode", "state", "updatedAt"]);
    expect(JSON.stringify(activity)).not.toMatch(/conversation|provider|title|message|path|count/i);

    const stream = await getJson<{ events: Array<{ type: string }> }>(`${handle!.url}/api/workbench/stream/${serverRunId}`);
    expect(stream.events.some((event: { type: string }) => event.type === "run.completed")).toBe(true);

    const page = await fetch(`${handle!.url}/`);
    expect(await page.text()).toContain("AHO");
  });

  it("serves Office assets with exact content types under nosniff", async () => {
    await mkdir(join(staticRoot, "agent-office"), { recursive: true });
    await writeFile(join(staticRoot, "agent-office", "atlas.json"), "{}", "utf8");
    await writeFile(join(staticRoot, "agent-office", "atlas.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    const documentResponse = await fetch(`${handle!.url}/agent-office/atlas.json`);
    const imageResponse = await fetch(`${handle!.url}/agent-office/atlas.webp`);

    expect(documentResponse.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(imageResponse.headers.get("content-type")).toBe("image/webp");
    expect(documentResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(imageResponse.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves Agent access GET and POST on the Workbench route with revision checks", async () => {
    const paths = resolveProjectRuntimePaths(project().id, registryRoot);
    const database = new Database(paths.workbenchDbPath);
    try { database.prepare(`INSERT INTO conversations(project_id,conversation_id,product_mode,agent_turn_mode,title,selected_provider_id,created_at,updated_at)
      VALUES ('repo','access-route-conversation','agent','default','Access route','codex','t0','t0')`).run(); }
    finally { database.close(); }
    const endpoint = `${handle!.url}/api/projects/repo/workbench/conversations/access-route-conversation/access`;
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => nativeFetch(
      typeof input === "string" && input.startsWith("/") ? `${handle!.url}${input}` : input, init,
    )) as typeof fetch);
    try {
      const identity = { projectId: "repo", conversationId: "access-route-conversation", providerId: "codex" };
      const selected = await conversationAccessApi.read(identity);
      expect(selected).toMatchObject({ accessMode: "default", revision: 0, providerId: "codex" });
      expect(await conversationAccessApi.save(identity, selected, "default", false)).toMatchObject({ accessMode: "default", revision: 1 });
    } finally { vi.unstubAllGlobals(); }
    const stale = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", providerId: "codex", accessMode: "default", expectedRevision: 0 }) });
    expect(stale.status).toBe(409);
  });

  it("protects every desktop API route with the ephemeral session cookie", async () => {
    const endOperation = vi.fn();
    const beginOperation = vi.fn(async () => endOperation);
    const desktopHandle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      desktopHost: { sessionToken: "desktop-secret", cookieName: "beaver_code_session", beginOperation },
    });
    try {
      const staticResponse = await fetch(desktopHandle.url);
      expect(staticResponse.status).toBe(200);
      expect(staticResponse.headers.get("content-security-policy")).toContain("default-src 'self'");

      const anonymous = await fetch(`${desktopHandle.url}/api/projects`);
      expect(anonymous.status).toBe(403);

      const authenticated = await fetch(`${desktopHandle.url}/api/projects`, {
        headers: { Cookie: "beaver_code_session=desktop-secret" },
      });
      expect(authenticated.status).toBe(200);
      expect(beginOperation).toHaveBeenCalledTimes(1);
      expect(endOperation).toHaveBeenCalledTimes(1);

      const wrong = await fetch(`${desktopHandle.url}/api/projects`, {
        headers: { Cookie: "beaver_code_session=wrong" },
      });
      expect(wrong.status).toBe(403);
      expect(beginOperation).toHaveBeenCalledTimes(1);
    } finally {
      await desktopHandle.close();
    }
  });

  it("advertises and opens only authenticated desktop menus", async () => {
    const openMenu = vi.fn(async () => ({ opened: true }));
    const desktopHandle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      desktopHost: { sessionToken: "desktop-menu-secret", cookieName: "beaver_code_session", openMenu },
    });
    const cookie = { Cookie: "beaver_code_session=desktop-menu-secret" };
    try {
      const status = await fetch(`${desktopHandle.url}/api/app/status`, { headers: cookie });
      expect(await status.json()).toMatchObject({
        desktopShell: { available: true, menus: ["file", "edit", "view", "help"] },
      });

      const opened = await fetch(`${desktopHandle.url}/api/desktop/menu/open`, {
        method: "POST",
        headers: { ...cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ menuId: "view", anchor: { x: 92, y: 48 } }),
      });
      expect(opened.status).toBe(200);
      expect(openMenu).toHaveBeenCalledWith({ menuId: "view", anchor: { x: 92, y: 48 } });

      const anonymous = await fetch(`${desktopHandle.url}/api/desktop/menu/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuId: "file", anchor: { x: 0, y: 48 } }),
      });
      expect(anonymous.status).toBe(403);

      const invalid = await fetch(`${desktopHandle.url}/api/desktop/menu/open`, {
        method: "POST",
        headers: { ...cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ menuId: "system", anchor: { x: 0, y: 48 } }),
      });
      expect(invalid.status).toBe(400);
      expect(openMenu).toHaveBeenCalledTimes(1);
    } finally {
      await desktopHandle.close();
    }
  });

  it("does not report idle after a model request starts a persistent Provider Host", async () => {
    const desktopHandle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      desktopHost: { sessionToken: "desktop-model-secret", cookieName: "beaver_code_session" },
    });
    try {
      const models = await fetch(`${desktopHandle.url}/api/projects/repo/providers/codex/models`, {
        headers: { Cookie: "beaver_code_session=desktop-model-secret" },
      });
      expect(models.status).toBe(200);
      expect(await desktopHandle.snapshot()).toMatchObject({
        state: "active",
        activeTurnCount: 0,
        activeTerminalCount: 0,
      });
    } finally {
      await desktopHandle.close();
    }
  });

  it("fails graceful close when a registered Turn explicitly rejects interruption", async () => {
    const interruptRejection = new Error("interrupt rejected");
    interruptRejection.name = "ProviderInterruptRejected";
    const interruptAll = vi.fn(async () => {
      throw new AggregateError([interruptRejection], "One or more Conversation Turns rejected interruption.");
    });
    const drain = vi.fn(async () => undefined);
    const turnControl = {
      interruptAll,
      drain,
      state: () => ({ state: "idle" as const, canInterrupt: false, canSteer: false, steerState: "idle" as const }),
      registerAttempt: () => undefined,
      release: () => undefined,
      onTurnStarted: () => undefined,
    } as unknown as ConversationTurnControlOwner;
    const providerShutdown = vi.fn(async () => undefined);
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register({
      id: "cleanup-provider",
      displayName: "Cleanup Provider",
      runtime: {
        liveness: () => ({ providerId: "cleanup-provider", liveHostCount: 0 }),
        shutdown: providerShutdown,
        shutdownProject: async () => undefined,
      },
      conversation: {
        getActiveTurn: () => null,
        listActiveTurns: () => [],
      },
    } as unknown as ProviderDescriptor);
    const terminalRuntime = new TerminalRuntime();
    const terminalCleanup = vi.spyOn(terminalRuntime, "cleanup");
    const closeHandle = await startWorkbenchServer(null, {
      port: 0,
      staticRoot,
      store: new ProjectRegistryStore(join(registryRoot, "interrupt-rejection")),
      turnControl,
      providerRegistry,
      terminalRuntime,
    });
    await expect(closeHandle.close()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [interruptRejection],
    });
    expect(interruptAll).toHaveBeenCalledTimes(1);
    expect(drain).not.toHaveBeenCalled();
    expect(providerShutdown).toHaveBeenCalledTimes(1);
    expect(terminalCleanup).toHaveBeenCalledTimes(1);
    expect(closeHandle.server.listening).toBe(false);
  });

  it("serves the exact Agent Turn interrupt JSON contract and rejects Harness mode before the Owner", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const interrupt = vi.fn(async () => ({ status: "interrupt-requested" as const, attemptId: "attempt-agent", runId: "run-agent" }));
    const turnControl = {
      interrupt,
      state: () => ({ state: "idle" as const, canInterrupt: false }),
      registerAttempt: () => undefined,
      release: () => undefined,
      onTurnStarted: () => undefined,
    } as unknown as ConversationTurnControlOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      turnControl,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/conversations/conversation-agent/turn/interrupt`;

    const wrongMode = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "harness", providerId: "codex", expectedAttemptId: "attempt-agent" }),
    });
    expect(wrongMode.status).toBe(409);
    expect(interrupt).not.toHaveBeenCalled();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", providerId: "codex", expectedAttemptId: "attempt-agent" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "interrupt-requested", attemptId: "attempt-agent", runId: "run-agent" });
    expect(interrupt).toHaveBeenCalledWith(project(), {
      projectId: "repo",
      productMode: "agent",
      conversationId: "conversation-agent",
      providerId: "codex",
      expectedAttemptId: "attempt-agent",
    });
  });

  it("serves the exact Agent Turn steer JSON contract and rejects invalid identity before the Owner", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const steer = vi.fn(async () => ({ status: "already-terminal" as const, attemptId: "attempt-agent", runId: "run-agent" }));
    const turnControl = {
      steer,
      state: () => ({ state: "idle" as const, canInterrupt: false, canSteer: false, steerState: "idle" as const }),
      registerAttempt: () => undefined,
      release: () => undefined,
      onTurnStarted: () => undefined,
    } as unknown as ConversationTurnControlOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      turnControl,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/conversations/conversation-agent/turn/steer`;

    const wrongMode = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "harness", providerId: "codex", expectedAttemptId: "attempt-agent", clientRequestId: "steer-1", text: "constraint" }),
    });
    expect(wrongMode.status).toBe(409);
    const incomplete = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", providerId: "codex", expectedAttemptId: "attempt-agent", text: "constraint" }),
    });
    expect(incomplete.status).toBe(400);
    expect(steer).not.toHaveBeenCalled();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", providerId: "codex", expectedAttemptId: "attempt-agent", clientRequestId: "steer-1", text: " constraint " }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "already-terminal", attemptId: "attempt-agent", runId: "run-agent" });
    expect(steer).toHaveBeenCalledWith(project(), {
      projectId: "repo",
      productMode: "agent",
      conversationId: "conversation-agent",
      providerId: "codex",
      expectedAttemptId: "attempt-agent",
      clientRequestId: "steer-1",
      text: "constraint",
    });
  });

  it("serves one shared Agent/AHO context compact JSON contract", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const compact = vi.fn(async () => ({ status: "accepted" as const }));
    const conversationContext = { compact, reconcileProject: async () => 0 } as unknown as ConversationContextLifecycleOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      conversationContext,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/conversations/conversation-context/context/compact`;

    const invalid = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", providerId: "codex", contextRevision: "revision-1" }),
    });
    expect(invalid.status).toBe(400);
    expect(compact).not.toHaveBeenCalled();

    for (const productMode of ["agent", "harness"] as const) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productMode,
          providerId: " codex ",
          contextRevision: " revision-1 ",
          clientRequestId: ` compact-${productMode} `,
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "accepted" });
      expect(compact).toHaveBeenLastCalledWith(project(), {
        projectId: "repo",
        productMode,
        conversationId: "conversation-context",
        providerId: "codex",
        contextRevision: "revision-1",
        clientRequestId: `compact-${productMode}`,
      });
    }
  });

  it("serves the exact Agent Conversation fork contract and rejects Harness before the Owner", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const fork = vi.fn(async () => ({
      status: "forked" as const,
      sourceConversationId: "conversation-agent",
      targetConversationId: "conversation-forked",
    }));
    const conversationFork = { fork, reconcileProject: async () => 0 } as unknown as ConversationForkLifecycleOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      conversationFork,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/conversations/conversation-agent/fork`;

    const wrongMode = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "harness", providerId: "codex", sourceMessageId: "assistant-anchor",
        expectedCompletedTurnSequence: 2, expectedTimelineRevision: 9,
        contextRevision: "context-1", clientRequestId: "fork-1",
      }),
    });
    expect(wrongMode.status).toBe(409);
    expect(fork).not.toHaveBeenCalled();

    const incomplete = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", providerId: "codex", sourceMessageId: "assistant-anchor" }),
    });
    expect(incomplete.status).toBe(400);
    expect(fork).not.toHaveBeenCalled();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "agent", providerId: " codex ", sourceMessageId: " assistant-anchor ",
        expectedCompletedTurnSequence: 2, expectedTimelineRevision: 9,
        contextRevision: " context-1 ", clientRequestId: " fork-1 ",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "forked",
      sourceConversationId: "conversation-agent",
      targetConversationId: "conversation-forked",
    });
    expect(fork).toHaveBeenCalledWith(project(), {
      projectId: "repo",
      productMode: "agent",
      conversationId: "conversation-agent",
      providerId: "codex",
      sourceMessageId: "assistant-anchor",
      expectedCompletedTurnSequence: 2,
      expectedTimelineRevision: 9,
      contextRevision: "context-1",
      clientRequestId: "fork-1",
    });
  });

  it("serves one strict shared Conversation Turn queue API for Agent and AHO", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const snapshot = {
      projectId: "repo",
      productMode: "agent" as const,
      conversationId: "conversation-agent",
      revision: "queue:1",
      executionRevision: "execution:1",
      items: [],
      canEnqueue: true,
      canDispatch: false,
    };
    const read = vi.fn(async () => snapshot);
    const enqueue = vi.fn(async () => snapshot);
    const remove = vi.fn(async () => snapshot);
    const reclaim = vi.fn(async () => snapshot);
    const retry = vi.fn(async () => snapshot);
    const confirmExecutionContract = vi.fn(async () => snapshot);
    const dispatchNext = vi.fn(async () => snapshot);
    const conversationTurnQueue = {
      read,
      enqueue,
      remove,
      reclaim,
      retry,
      confirmExecutionContract,
      dispatchNext,
      reconcileProject: async () => 0,
    } as unknown as ConversationTurnQueueOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      conversationTurnQueue,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/conversations/conversation-agent/turn-queue`;

    const getResponse = await fetch(`${endpoint}?productMode=agent`);
    expect(getResponse.status).toBe(200);
    expect(read).toHaveBeenCalledWith(project(), "agent", "conversation-agent");

    const invalid = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "harness",
        clientRequestId: "queue-1",
        expectedRevision: "queue:0",
        expectedExecutionRevision: "execution:0",
        expectedDraftUpdatedAt: null,
        text: "next",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: {},
        providerId: "codex",
        agentTurnMode: "plan",
        modelId: null,
        reasoningEffort: null,
      }),
    });
    expect(invalid.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();

    const enqueueResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "agent",
        clientRequestId: " queue-1 ",
        expectedRevision: " queue:0 ",
        expectedExecutionRevision: " execution:0 ",
        expectedDraftUpdatedAt: null,
        text: " next ",
        contextRefs: [{ relativePath: "src/app.ts", name: "app.ts", kind: "file" }],
        attachmentIds: [" attachment-1 "],
        skillOverrides: { reviewer: true },
        providerId: " codex ",
        agentTurnMode: "plan",
        modelId: " gpt-test ",
        reasoningEffort: " high ",
      }),
    });
    expect(enqueueResponse.status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(project(), expect.objectContaining({
      projectId: "repo",
      productMode: "agent",
      conversationId: "conversation-agent",
      clientRequestId: "queue-1",
      expectedRevision: "queue:0",
      expectedExecutionRevision: "execution:0",
      contextRefs: [{ relativePath: "src/app.ts", name: "app.ts", kind: "file", source: "composer" }],
      attachmentIds: ["attachment-1"],
      skillOverrides: { reviewer: true },
      providerId: "codex",
      agentTurnMode: "plan",
      modelId: "gpt-test",
      reasoningEffort: "high",
    }));

    expect((await fetch(`${endpoint}/item-1?productMode=agent&expectedRevision=queue%3A1`, { method: "DELETE" })).status).toBe(200);
    expect(remove).toHaveBeenCalledWith(project(), "agent", "conversation-agent", "item-1", "queue:1");
    expect((await fetch(`${endpoint}/item-1/reclaim`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", expectedRevision: "queue:1", expectedDraftUpdatedAt: null }),
    })).status).toBe(200);
    expect(reclaim).toHaveBeenCalledWith(project(), "agent", "conversation-agent", "item-1", "queue:1", null);
    expect((await fetch(`${endpoint}/item-1/retry`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", expectedRevision: "queue:1" }),
    })).status).toBe(200);
    expect(retry).toHaveBeenCalledWith(project(), "agent", "conversation-agent", "item-1", "queue:1");
    expect((await fetch(`${endpoint}/item-1/confirm-execution`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "agent",
        expectedRevision: " queue:1 ",
        clientRequestId: " confirm-1 ",
        expectedCreatedContract: { family: "agent.turn", epoch: 1 },
        expectedTargetContract: { family: "agent.turn", epoch: 2 },
      }),
    })).status).toBe(200);
    expect(confirmExecutionContract).toHaveBeenCalledWith(project(), {
      productMode: "agent",
      conversationId: "conversation-agent",
      queueItemId: "item-1",
      expectedRevision: "queue:1",
      clientRequestId: "confirm-1",
      expectedCreatedContract: { family: "agent.turn", epoch: 1 },
      expectedTargetContract: { family: "agent.turn", epoch: 2 },
    });
    expect((await fetch(`${endpoint}/dispatch-next`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", expectedRevision: "queue:1" }),
    })).status).toBe(200);
    expect(dispatchNext).toHaveBeenCalledWith(project(), "agent", "conversation-agent", "queue:1");
  });

  it("exposes native Review only to Agent requests and rejects Harness before Owner I/O", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const receipt = {
      projectId: "repo",
      conversationId: "conversation-agent",
      clientRequestId: "review-1",
      status: "submitting" as const,
      source: "direct" as const,
      target: { type: "uncommitted-changes" as const },
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const start = vi.fn(async () => receipt);
    const conversationReview = { start, reconcileProject: async () => 0 } as unknown as ConversationReviewLifecycleOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      conversationReview,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/reviews`;

    const harness = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "harness",
        conversationId: serverConversationId,
        providerId: "codex",
        target: { type: "uncommitted-changes" },
        expectedTimelineRevision: 0,
        expectedExecutionRevision: "execution:forged",
        clientRequestId: "review-harness-forged",
      }),
    });
    expect(harness.status).toBe(409);
    expect(start).not.toHaveBeenCalled();

    await expect(postJson(endpoint, {
      productMode: "agent",
      conversationId: "conversation-agent",
      providerId: "codex",
      target: { type: "commit", sha: "a".repeat(40) },
      expectedTimelineRevision: 3,
      expectedExecutionRevision: "execution:3",
      clientRequestId: "review-1",
    })).resolves.toEqual(receipt);
    expect(start).toHaveBeenCalledWith(project(), {
      productMode: "agent",
      conversationId: "conversation-agent",
      providerId: "codex",
      target: { type: "commit", sha: "a".repeat(40) },
      expectedTimelineRevision: 3,
      expectedExecutionRevision: "execution:3",
      clientRequestId: "review-1",
    });
  });

  it("serves the shared Conversation lifecycle and revision-bound delete confirmation contracts", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const snapshot = {
      projectId: "repo",
      productMode: "agent" as const,
      conversationId: "conversation-agent",
      state: "archived" as const,
      archiveOrigin: "agent-user" as const,
      lifecycleRevision: "conversation-lifecycle:2",
      updatedAt: "2026-08-31T00:00:00.000Z",
      canArchive: false,
      canRestore: true,
      canDelete: true,
    };
    const read = vi.fn(async () => snapshot);
    const prepareDelete = vi.fn(async () => ({
      token: "delete-token",
      expiresAt: "2026-08-31T00:05:00.000Z",
      conversationId: "conversation-agent",
      lifecycleRevision: "conversation-lifecycle:2",
      effect: "Delete local history.",
    }));
    const settle = vi.fn(async () => ({
      status: "completed" as const,
      action: "delete" as const,
      conversationId: "conversation-agent",
      snapshot: null,
      providerSyncStatus: "completed" as const,
    }));
    const conversationLifecycle = { read, prepareDelete, settle, reconcileProject: async () => 0 } as unknown as ConversationLifecycleOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      conversationLifecycle,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/conversations/conversation-agent/lifecycle`;

    expect(await getJson(`${endpoint}?productMode=agent`)).toEqual(snapshot);
    expect(read).toHaveBeenCalledWith(project(), "agent", "conversation-agent");

    const invalid = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productMode: "agent", action: "hide", expectedLifecycleRevision: "conversation-lifecycle:2", clientRequestId: "lifecycle-1" }),
    });
    expect(invalid.status).toBe(400);
    expect(settle).not.toHaveBeenCalled();

    const confirmation = await postJson(`${endpoint}/delete-confirmation`, {
      productMode: "agent",
      expectedLifecycleRevision: "conversation-lifecycle:2",
    });
    expect(confirmation).toMatchObject({ token: "delete-token" });
    expect(prepareDelete).toHaveBeenCalledWith(project(), "agent", "conversation-agent", "conversation-lifecycle:2");

    const result = await postJson(endpoint, {
      productMode: "agent",
      action: "delete",
      expectedLifecycleRevision: "conversation-lifecycle:2",
      clientRequestId: " lifecycle-1 ",
      confirmationToken: " delete-token ",
    });
    expect(result).toMatchObject({ status: "completed", action: "delete" });
    expect(settle).toHaveBeenCalledWith(project(), {
      projectId: "repo",
      productMode: "agent",
      conversationId: "conversation-agent",
      action: "delete",
      expectedLifecycleRevision: "conversation-lifecycle:2",
      clientRequestId: "lifecycle-1",
      confirmationToken: "delete-token",
    });
  });

  it("prepares Agent Retry before SSE and emits a completed replay stream", async () => {
    await new Promise<void>((resolve) => handle!.server.close(() => resolve()));
    const prepare = vi.fn(async (_project: ManagedProject, request: { productMode: string }) => {
      if (request.productMode !== "agent") {
        const error = new Error("Conversation Retry is available only in Agent mode.");
        error.name = "Conflict";
        throw error;
      }
      return { replayed: true, executionIdentity: { attemptId: "attempt-retry" } };
    });
    const execute = vi.fn(async () => ({ status: "replayed" as const, attemptId: "attempt-retry", result: null }));
    const turnRetry = { prepare, execute } as unknown as ConversationTurnRetryOwner;
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      turnRetry,
    });
    const endpoint = `${handle.url}/api/projects/repo/workbench/conversations/conversation-agent/turn/retry/live`;

    const wrongMode = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "harness", providerId: "codex", expectedAttemptId: "attempt-failed",
        sourceMessageId: "user-source", clientRequestId: "retry-1",
      }),
    });
    expect(wrongMode.status).toBe(409);
    expect(wrongMode.headers.get("content-type")).toContain("application/json");
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "agent", providerId: "codex", expectedAttemptId: "attempt-failed",
        sourceMessageId: "user-source", clientRequestId: "retry-1",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSseEvents(await response.text());
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(["snapshot", "done"]));
    expect(execute).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenLastCalledWith(project(), expect.objectContaining({
      conversationId: "conversation-agent",
      productMode: "agent",
      providerId: "codex",
      expectedAttemptId: "attempt-failed",
      sourceMessageId: "user-source",
      clientRequestId: "retry-1",
    }));
  });

  it("requires mode-aware reads and makes first-send creation idempotent", async () => {
    expect((await fetch(`${handle!.url}/api/projects/repo/workbench/topics`)).status).toBe(400);
    expect((await fetch(`${handle!.url}/api/projects/repo/workbench/snapshot?productMode=invalid`)).status).toBe(400);

    const request = {
      body: "Create an Agent-mode conversation once.",
      productMode: "agent",
      clientRequestId: "server-mode-idempotency",
      confirm: true,
    };
    const create = async (body: typeof request) => fetch(`${handle!.url}/api/projects/repo/workbench/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const firstResponse = await create(request);
    expect(firstResponse.ok).toBe(true);
    const first = await firstResponse.json() as {
      topic: { id: string; productMode: string; clientRequestId: string; replayed: boolean };
    };
    expect(first.topic).toMatchObject({
      productMode: "agent",
      clientRequestId: request.clientRequestId,
      replayed: false,
    });
    const replayResponse = await create(request);
    expect(replayResponse.ok).toBe(true);
    const replay = await replayResponse.json() as typeof first;
    expect(replay.topic).toMatchObject({ id: first.topic.id, productMode: "agent", replayed: true });
    expect((await create({ ...request, body: "Conflicting payload" })).status).toBe(409);

    const agentTopics = await getJson<Array<{ id: string; productMode: string }>>(
      `${handle!.url}/api/projects/repo/workbench/topics?productMode=agent`,
    );
    expect(agentTopics).toEqual([expect.objectContaining({ id: first.topic.id, productMode: "agent" })]);
    const harnessTopics = await getJson<Array<{ id: string; productMode: string }>>(
      `${handle!.url}/api/projects/repo/workbench/topics?productMode=harness`,
    );
    expect(harnessTopics).toEqual([expect.objectContaining({ id: serverConversationId, productMode: "harness" })]);

    expect((await fetch(
      `${handle!.url}/api/projects/repo/workbench/topics/${encodeURIComponent(serverConversationId)}?productMode=agent`,
    )).status).toBe(409);
    expect((await fetch(
      `${handle!.url}/api/projects/repo/workbench/snapshot?productMode=agent&topic=${encodeURIComponent(serverConversationId)}`,
    )).status).toBe(409);
    expect((await fetch(
      `${handle!.url}/api/projects/repo/workbench/conversations/${encodeURIComponent(serverConversationId)}/timeline?productMode=agent&agentSurfaceId=main-agent`,
    )).status).toBe(409);
  });

  it("persists Agent Composer mode through the HTTP draft contract and rejects Harness leakage", async () => {
    const endpoint = `${handle!.url}/api/projects/repo/workbench/composer-draft`;
    const saved = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "agent",
        agentTurnMode: "plan",
        text: "recover this draft",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: { reviewer: true },
        selectedProviderId: "codex",
        expectedUpdatedAt: null,
      }),
    });
    expect(saved.ok).toBe(true);
    const savedPayload = await saved.json() as { draft: { updatedAt: string } };
    expect(savedPayload).toMatchObject({
      draft: {
        productMode: "agent",
        agentTurnMode: "plan",
        text: "recover this draft",
        skillOverrides: { reviewer: true },
        selectedProviderId: "codex",
      },
    });

    expect(await getJson(`${endpoint}?productMode=agent`)).toMatchObject({
      draft: {
        productMode: "agent",
        agentTurnMode: "plan",
        text: "recover this draft",
        skillOverrides: { reviewer: true },
        selectedProviderId: "codex",
      },
    });
    const stale = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "agent",
        agentTurnMode: "default",
        text: "stale overwrite",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: {},
        selectedProviderId: "codex",
        expectedUpdatedAt: null,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      draft: { text: "recover this draft", updatedAt: savedPayload.draft.updatedAt },
    });
    const invalidHarness = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "harness",
        agentTurnMode: "plan",
        text: "",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: {},
        selectedProviderId: null,
        expectedUpdatedAt: null,
      }),
    });
    expect(invalidHarness.status).toBe(409);
    const deleted = await fetch(
      `${endpoint}?productMode=agent&expectedUpdatedAt=${encodeURIComponent(savedPayload.draft.updatedAt)}`,
      { method: "DELETE" },
    );
    expect(deleted.ok).toBe(true);
    expect(await getJson(`${endpoint}?productMode=agent`)).toEqual({ draft: null });
  });

  it("orders identity reconciliation before project recovery and listen", async () => {
    await handle!.close();
    handle = null;
    const order: string[] = [];
    let resolveCount = 0;
    const coordinator: ProjectRuntimeCoordinatorPort = {
      async reconcileStartup() {
        order.push("identity-recovery");
        return { states: [], migrations: [], recoveries: [], onboardingRecoveries: [] };
      },
      async resolve(inputProject) {
        resolveCount += 1;
        order.push("project-recovery");
        return {
          state: "onboarding",
          project: inputProject,
          projectRoot: inputProject.path,
          paths: resolveProjectRuntimePaths(inputProject.id, registryRoot),
          reservedProjectId: inputProject.id,
        };
      },
      async requireReady() {
        throw new Error("not used");
      },
      async startupState(inputProject) {
        return this.resolve(inputProject);
      },
      markUnavailable(inputProject, issue) {
        return { state: "unavailable", project: inputProject, issue };
      },
      runtimePaths(projectId) {
        return resolveProjectRuntimePaths(projectId, registryRoot);
      },
    };

    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      projectRuntimeCoordinator: coordinator,
    });
    order.push("listen");

    expect(order).toEqual([
      "identity-recovery",
      "project-recovery",
      "listen",
    ]);
    expect(resolveCount).toBe(1);
  });

  it("serves one canonical Timeline and retires flattened message reads", async () => {
    await appendCanonicalTimelineEntry(project(), "server-topic", { type: "user.message", text: "Conversation route message." });

    const payload = await getJson<{ conversationId: string; entries: Array<{ cells: Array<{ text?: string }> }> }>(
      `${handle!.url}/api/projects/repo/workbench/conversations/${serverConversationId}/timeline?productMode=harness&agentSurfaceId=main-agent&limit=100`,
    );
    expect(payload.conversationId).toBe(serverConversationId);
    expect(payload.entries.flatMap((entry) => entry.cells)).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Conversation route message." }),
    ]));

    const oldMessages = await fetch(`${handle!.url}/api/projects/repo/workbench/topics/${serverConversationId}/messages`);
    const replay = await fetch(`${handle!.url}/api/projects/repo/workbench/topics/${serverConversationId}/messages/stream`);
    expect(oldMessages.status).toBe(404);
    expect(replay.status).toBe(404);
  });

  it("serves the Provider-native Skill catalog without materializing packages", async () => {
    const skillRoot = join(tempDir, "custom-skills");
    const skillDir = join(skillRoot, "pricing-helper");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: pricing-helper\ndescription: Pricing helper.\n---\n\n# Pricing\n", "utf8");
    await writeFile(join(skillDir, "scripts", "run.ps1"), "Write-Host skill\n", "utf8");

    const addedRoot = await fetch(`${handle!.url}/api/projects/repo/skill-roots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: skillRoot, productMode: "harness", providerId: "codex" }),
    });
    expect(addedRoot.ok).toBe(true);
    const listed = await getJson<{ roots: Array<{ rootPath: string }>; skills: Array<{ skillId: string; sourceKind: string; contentHash: string; providerBindings: Array<{ providerId: string; status: string }> }> }>(`${handle!.url}/api/projects/repo/skills?productMode=harness&providerId=codex`);
    expect((await Promise.all(listed.roots.map((root) => sameTestPhysicalPath(root.rootPath, skillRoot))))
      .some(Boolean)).toBe(true);
    const pricing = listed.skills.find((skill) => skill.skillId === "pricing-helper");
    const system = listed.skills.find((skill) => skill.skillId === "aho-harness-engineering");
    expect(pricing).toMatchObject({ skillId: "pricing-helper", sourceKind: "custom" });
    expect(pricing).toMatchObject({ contentHash: expect.any(String) });
    expect(pricing?.providerBindings[0]).toMatchObject({ providerId: "codex", status: "ready" });
    expect(system).toMatchObject({ runtimeAssigned: true, sourceKind: "system-aho" });

    const enabled = await fetch(`${handle!.url}/api/projects/repo/skills/pricing-helper/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, productMode: "harness", providerId: "codex" }),
    });
    expect(enabled.ok).toBe(true);

    const disabled = await fetch(`${handle!.url}/api/projects/repo/skills/pricing-helper/provider-enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, productMode: "harness", providerId: "codex" }),
    });
    expect(disabled.ok).toBe(true);
    const refreshed = await getJson<{ skills: Array<{ skillId: string; providerEnabled: boolean }> }>(`${handle!.url}/api/projects/repo/skills?productMode=harness&providerId=codex`);
    expect(refreshed.skills.find((skill) => skill.skillId === "pricing-helper")?.providerEnabled).toBe(false);

    expect((await fetch(`${handle!.url}/api/projects/repo/skills`)).status).toBe(400);
    const createdResponse = await fetch(`${handle!.url}/api/projects/repo/workbench/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Create an Agent Skill selection scope.",
        productMode: "agent",
        clientRequestId: "agent-skill-catalog-scope",
        confirm: true,
      }),
    });
    expect(createdResponse.ok).toBe(true);
    const agentConversationId = (await createdResponse.json() as { topic: { conversationId: string } }).topic.conversationId;
    const agentTopics = await getJson<Array<{ id: string }>>(
      `${handle!.url}/api/projects/repo/workbench/topics?productMode=agent`,
    );
    expect(agentTopics).toContainEqual(expect.objectContaining({ id: agentConversationId }));
    const agentCatalog = await getJson<{ skills: Array<{ skillId: string; name: string; required: boolean; sourceKind: string }> }>(
      `${handle!.url}/api/projects/repo/skills?productMode=agent&providerId=codex&conversationId=${encodeURIComponent(agentConversationId)}`,
    );
    expect(agentCatalog.skills.map((skill) => skill.name)).not.toEqual(expect.arrayContaining([
      "aho-main-orchestration",
      "aho-harness-engineering",
      "aho-workflow-authoring",
    ]));
    expect(agentCatalog.skills).toContainEqual(expect.objectContaining({
      skillId: "repo-harness",
      sourceKind: "project-harness",
      required: false,
    }));

    const harnessCatalog = await getJson<{ skills: Array<{ skillId: string; required: boolean }> }>(
      `${handle!.url}/api/projects/repo/skills?productMode=harness&providerId=codex&conversationId=${encodeURIComponent(serverConversationId)}`,
    );
    expect(harnessCatalog.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: "repo-harness", required: true }),
      expect.objectContaining({ skillId: "aho-main-orchestration", required: true }),
    ]));

    const modeMismatch = await fetch(
      `${handle!.url}/api/projects/repo/skills?productMode=harness&providerId=codex&conversationId=${encodeURIComponent(agentConversationId)}`,
    );
    expect(modeMismatch.status).toBe(409);
    const providerMismatch = await fetch(
      `${handle!.url}/api/projects/repo/skills?productMode=agent&providerId=missing-provider&conversationId=${encodeURIComponent(agentConversationId)}`,
    );
    expect(providerMismatch.status).toBe(409);

    const selectedHarness = await fetch(`${handle!.url}/api/projects/repo/skills/repo-harness/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        productMode: "agent",
        providerId: "codex",
        conversationId: agentConversationId,
      }),
    });
    expect(selectedHarness.ok).toBe(true);
    const selectedHarnessCatalog = await selectedHarness.json() as { skills: Array<{ skillId: string; name: string }> };
    expect(selectedHarnessCatalog.skills.map((skill) => skill.name)).not.toContain("aho-main-orchestration");

    const providerGlobalHarnessDisable = await fetch(`${handle!.url}/api/projects/repo/skills/repo-harness/provider-enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, productMode: "agent", providerId: "codex" }),
    });
    expect(providerGlobalHarnessDisable.ok).toBe(false);
    expect(await providerGlobalHarnessDisable.text()).toContain("assigned by the Runtime");

    const database = await openProjectRuntimeWorkbenchDatabase(resolveProjectRuntimePaths(project().id));
    try {
      const conversation = database.conversations.readConversation(project().id, serverConversationId);
      if (!conversation?.boundChangeId || !conversation.currentGraphScopeId) {
        throw new Error("Expected a bound Harness Conversation fixture.");
      }
      database.conversations.archiveBoundConversation(
        project().id,
        serverConversationId,
        conversation.boundChangeId,
        conversation.currentGraphScopeId,
        "2026-08-14T00:00:00.000Z",
      );
    } finally {
      database.close();
    }
    const archivedCatalog = await fetch(
      `${handle!.url}/api/projects/repo/skills?productMode=harness&providerId=codex&conversationId=${encodeURIComponent(serverConversationId)}`,
    );
    expect(archivedCatalog.ok).toBe(true);
    const archivedRoots = await fetch(
      `${handle!.url}/api/projects/repo/skill-roots?productMode=harness&providerId=codex&conversationId=${encodeURIComponent(serverConversationId)}`,
    );
    expect(archivedRoots.ok).toBe(true);
    const archivedReload = await fetch(`${handle!.url}/api/projects/repo/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productMode: "harness",
        providerId: "codex",
        conversationId: serverConversationId,
      }),
    });
    expect(archivedReload.ok).toBe(true);
    const archivedMutation = await fetch(`${handle!.url}/api/projects/repo/skills/pricing-helper/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        productMode: "harness",
        providerId: "codex",
        conversationId: serverConversationId,
      }),
    });
    expect(archivedMutation.status).toBe(409);
    expect(await archivedMutation.text()).toContain("read-only");
    expect(existsSync(join(skillDir, "scripts", "run.ps1"))).toBe(true);
    expect(existsSync(join(process.env.CODEX_HOME ?? "", "plugins", "aho-managed"))).toBe(false);
  });

  it("serves safe project file search results for composer references", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "src", "pricing.ts"), "export const price = 1;\n", "utf8");
    await writeFile(join(tempDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
    await writeFile(join(tempDir, "dist", "bundle.js"), "console.log(1);\n", "utf8");

    const result = await getJson<{ files: Array<{ relativePath: string; kind: string; name: string }> }>(
      `${handle!.url}/api/projects/repo/files/search?q=src&limit=10`,
    );

    expect(result.files).toContainEqual(expect.objectContaining({ relativePath: "src", kind: "directory", name: "src" }));
    expect(result.files).toContainEqual(expect.objectContaining({ relativePath: "src/pricing.ts", kind: "file", name: "pricing.ts" }));
    expect(result.files.some((file) => file.relativePath.includes("node_modules"))).toBe(false);
    expect(result.files.some((file) => file.relativePath.startsWith("dist/"))).toBe(false);
  });

  it("stores composer attachments and binds them to the first topic message", async () => {
    const attachment = await fetch(`${handle!.url}/api/projects/repo/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "note.md",
        mediaType: "text/markdown",
        data: `data:text/markdown;base64,${Buffer.from("# Notes\nUse this context.\n", "utf8").toString("base64")}`,
      }),
    });
    expect(attachment.ok).toBe(true);
    const attachmentPayload = await attachment.json() as { attachment: { id: string; kind: string; fileName: string } };
    expect(attachmentPayload.attachment).toMatchObject({ kind: "text", fileName: "note.md" });

    const topicResponse = await fetch(`${handle!.url}/api/projects/repo/workbench/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachmentIds: [attachmentPayload.attachment.id],
        productMode: "harness",
        clientRequestId: "server-attachment-first-send",
        confirm: true,
      }),
    });
    expect(topicResponse.ok).toBe(true);
    const topicPayload = await topicResponse.json() as { topic: { id: string; conversationId: string; title: string } };
    expect(topicPayload.topic.title).toBe("附件需求");
    const timeline = await getJson<{ entries: Array<{ cells: Array<{ kind: string; attachments?: Array<{ id: string; fileName: string }> }> }> }>(
      `${handle!.url}/api/projects/repo/workbench/conversations/${encodeURIComponent(topicPayload.topic.conversationId ?? topicPayload.topic.id)}/timeline?productMode=harness&agentSurfaceId=main-agent&limit=100`,
    );
    const userMessage = timeline.entries.flatMap((entry) => entry.cells).find((cell) => cell.kind === "user-message");
    expect(userMessage?.attachments).toContainEqual(expect.objectContaining({
      id: attachmentPayload.attachment.id,
      fileName: "note.md",
    }));
    expect(JSON.stringify(timeline)).not.toContain("storagePath");
  });

  it("streams topic creation before the initial main-agent turn finishes", async () => {
    const live = await fetch(`${handle!.url}/api/projects/repo/workbench/topics/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "请先判断下一步",
        productMode: "harness",
        clientRequestId: "server-live-first-send",
        confirm: true,
      }),
    });

    expect(live.ok).toBe(true);
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    const body = await live.text();
    expect(body).toContain("event: topic.created");
    expect(body).toContain("event: timeline.patch");
    expect(body).toContain("event: snapshot");
    expect(body).toContain("event: done");
    const createdIndex = body.indexOf("event: topic.created");
    const userMessageIndex = body.indexOf("event: timeline.patch");
    expect(createdIndex).toBeGreaterThanOrEqual(0);
    expect(userMessageIndex).toBeGreaterThan(createdIndex);
  });

  it("runs a first Direct Agent Turn with the committed Conversation identity", async () => {
    const live = await fetch(`${handle!.url}/api/projects/repo/workbench/topics/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Create the durable Agent conversation and run it directly.",
        productMode: "agent",
        clientRequestId: "server-live-agent-failure",
        confirm: true,
      }),
    });

    expect(live.ok).toBe(true);
    const events = parseSseEvents(await live.text());
    const created = events.find((event) => event.event === "topic.created")?.data as { conversationId: string };
    const snapshot = events.find((event) => event.event === "snapshot")?.data as SnapshotResponse & { productMode: string };
    const done = events.find((event) => event.event === "done")?.data as { conversationId: string; productMode: string; status: string };

    expect(created.conversationId).toBeTruthy();
    expect(events.some((event) => event.event === "error")).toBe(false);
    expect(snapshot).toMatchObject({
      productMode: "agent",
      center: { selectedTopic: { id: created.conversationId } },
    });
    expect(done).toMatchObject({
      conversationId: created.conversationId,
      productMode: "agent",
      status: "completed",
    });
  });

  it("passes the Main Agent only the user's natural-language turn", () => {
    const prompt = buildProjectScopedMainAgentPrompt("请让计划子 Agent 生成计划");

    expect(prompt).toBe("请让计划子 Agent 生成计划");
    expect(prompt).not.toContain("$aho-main-orchestration");
    expect(prompt).not.toContain("$aho-workflow-authoring");
    expect(prompt).not.toContain("planner-proposal");
  });

  it("derives and updates Conversation titles through the server-owned path", async () => {
    const created = await fetch(`${handle!.url}/api/projects/repo/workbench/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "\n> ## -   Build   a reliable checkout\nMore detail",
        productMode: "harness",
        clientRequestId: "server-title-first-send",
        confirm: true,
      }),
    });
    expect(created.ok).toBe(true);
    const createdBody = await created.json() as { topic: { id: string; title: string } };
    expect(createdBody.topic.title).toBe("Build a reliable checkout");

    const renamed = await fetch(`${handle!.url}/api/projects/repo/workbench/topics/${encodeURIComponent(createdBody.topic.id)}/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  Checkout\n polish  " }),
    });
    expect(renamed.ok).toBe(true);
    const renamedBody = await renamed.json() as { conversation: { id: string; title: string } };
    expect(renamedBody.conversation).toMatchObject({ id: createdBody.topic.id, title: "Checkout polish" });

    const snapshot = await getJson<{ left: { topics: Array<{ id: string; title: string }> } }>(
      `${handle!.url}/api/projects/repo/workbench/snapshot?productMode=harness&topic=${encodeURIComponent(createdBody.topic.id)}`,
    );
    expect(snapshot.left.topics).toContainEqual(expect.objectContaining({ id: createdBody.topic.id, title: "Checkout polish" }));
  });

  it("stores composer attachments before Harness preparation for Direct Agent use", async () => {
    await rm(join(tempDir, ".claude", "skills", "repo-harness"), { recursive: true, force: true });
    await rm(join(tempDir, ".agents", "skills", "repo-harness"), { recursive: true, force: true });

    const attachment = await fetch(`${handle!.url}/api/projects/repo/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "note.md",
        mediaType: "text/markdown",
        data: `data:text/markdown;base64,${Buffer.from("# Notes\n", "utf8").toString("base64")}`,
      }),
    });

    expect(attachment.status).toBe(200);
    expect(await attachment.json()).toEqual({
      attachment: expect.objectContaining({ kind: "text", runtimeMode: "provider-file-reference" }),
    });
  });

  it("returns HTTP 409 before SSE and Conversation persistence when a managed attachment changed", async () => {
    const upload = await fetch(`${handle!.url}/api/projects/repo/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "marker.txt",
        mediaType: "text/plain",
        data: `data:text/plain;base64,${Buffer.from("before", "utf8").toString("base64")}`,
      }),
    });
    const uploaded = await upload.json() as { attachment: { id: string; storagePath?: string } };
    expect(uploaded.attachment.storagePath).toBeUndefined();
    const paths = resolveProjectRuntimePaths(project().id);
    const stored = (await resolveTopicAttachments(project(), [uploaded.attachment.id], { workbenchRoot: paths.workbenchRoot }))[0]!;
    await writeFile(join(paths.workbenchRoot, stored.storagePath), "after!", "utf8");

    const response = await fetch(`${handle!.url}/api/projects/repo/workbench/topics/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attachmentIds: [uploaded.attachment.id],
        productMode: "agent",
        clientRequestId: "tampered-attachment-create",
        confirm: true,
      }),
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toContain("Attachment content changed after upload");
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversations.readConversationByClientCreateRequestId(project().id, "tampered-attachment-create")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("replays a committed attachment Turn before reading deleted attachment content", async () => {
    const upload = await fetch(`${handle!.url}/api/projects/repo/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "replay-marker.txt",
        mediaType: "text/plain",
        data: `data:text/plain;base64,${Buffer.from("replay marker", "utf8").toString("base64")}`,
      }),
    });
    const uploaded = await upload.json() as { attachment: { id: string; storagePath?: string } };
    expect(uploaded.attachment.storagePath).toBeUndefined();
    const request = {
      attachmentIds: [uploaded.attachment.id],
      productMode: "agent",
      clientRequestId: "attachment-exact-replay",
      confirm: true,
    };
    const create = () => fetch(`${handle!.url}/api/projects/repo/workbench/topics/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    const firstResponse = await create();
    expect(firstResponse.status).toBe(200);
    const firstEvents = parseSseEvents(await firstResponse.text());
    const firstCreated = firstEvents.find((event) => event.event === "topic.created")?.data as {
      conversationId: string;
      replayed: boolean;
    };
    expect(firstCreated).toMatchObject({ replayed: false });

    const paths = resolveProjectRuntimePaths(project().id);
    const stored = (await resolveTopicAttachments(project(), [uploaded.attachment.id], { workbenchRoot: paths.workbenchRoot }))[0]!;
    await rm(join(paths.workbenchRoot, stored.storagePath), { force: true });

    const replayResponse = await create();
    expect(replayResponse.status).toBe(200);
    const replayEvents = parseSseEvents(await replayResponse.text());
    expect(replayEvents.find((event) => event.event === "topic.created")?.data).toMatchObject({
      conversationId: firstCreated.conversationId,
      replayed: true,
    });

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.providerAttempts.listProviderAttempts(project().id, firstCreated.conversationId)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("serves safe file tree children and read-only previews for the right rail files tab", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(tempDir, "src", "pricing.ts"), "export const price = 1;\n", "utf8");
    await writeFile(join(tempDir, "notes.md"), "# Notes\n\nResource workspace.\n", "utf8");
    await writeFile(join(tempDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

    const rootTree = await getJson<{ entries: Array<{ relativePath: string; kind: string; name: string }> }>(
      `${handle!.url}/api/projects/repo/files/children`,
    );
    expect(rootTree.entries).toContainEqual(expect.objectContaining({ relativePath: "src", kind: "directory", name: "src" }));
    expect(rootTree.entries.some((entry) => entry.relativePath.includes("node_modules"))).toBe(false);

    const srcTree = await getJson<{ path: string; parentPath: string | null; entries: Array<{ relativePath: string; kind: string; name: string }> }>(
      `${handle!.url}/api/projects/repo/files/children?path=src`,
    );
    expect(srcTree.path).toBe("src");
    expect(srcTree.parentPath).toBe("");
    expect(srcTree.entries).toContainEqual(expect.objectContaining({ relativePath: "src/pricing.ts", kind: "file", name: "pricing.ts" }));

    const preview = await getJson<{ path: string; status: string; content?: string }>(
      `${handle!.url}/api/projects/repo/files/preview?path=src%2Fpricing.ts`,
    );
    expect(preview).toMatchObject({ path: "src/pricing.ts", status: "text", content: "export const price = 1;\n" });

    const resourceResponse = await fetch(`${handle!.url}/api/projects/repo/workspace-resources/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: { kind: "project-file", relativePath: "notes.md" } }),
    });
    expect(resourceResponse.ok).toBe(true);
    expect(await resourceResponse.json()).toMatchObject({
      resourceId: "project-file:notes.md",
      kind: "markdown-file",
      language: "markdown",
      content: "# Notes\n\nResource workspace.\n",
      readOnly: true,
    });
  });

  it("serves read-only Git status and diff for the right rail Git tab", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "pricing.ts"), "export const price = 1;\n", "utf8");
    await runGit("init");
    await runGit("config", "user.email", "aho@example.test");
    await runGit("config", "user.name", "AHO Test");
    await runGit("add", "-A");
    await runGit("commit", "-m", "baseline");
    await writeFile(join(tempDir, "src", "pricing.ts"), "export const price = 2;\nexport const discount = true;\n", "utf8");
    await writeFile(join(tempDir, "src", "staged.ts"), "export const staged = true;\n", "utf8");
    await writeFile(join(tempDir, "src", "untracked.ts"), "export const untracked = true;\n", "utf8");
    await runGit("add", "src/staged.ts");

    const status = await getJson<{
      isGitRepository: boolean;
      branch: string | null;
      staged: Array<{ relativePath: string; statusLabel: string }>;
      unstaged: Array<{ relativePath: string; additions?: number }>;
      untracked: Array<{ relativePath: string }>;
    }>(`${handle!.url}/api/projects/repo/git/status`);
    expect(status.isGitRepository).toBe(true);
    expect(status.branch).toBeTruthy();
    expect(status.staged).toContainEqual(expect.objectContaining({ relativePath: "src/staged.ts", statusLabel: "新增" }));
    expect(status.unstaged).toContainEqual(expect.objectContaining({ relativePath: "src/pricing.ts" }));
    expect(status.untracked).toContainEqual(expect.objectContaining({ relativePath: "src/untracked.ts" }));

    const diff = await getJson<{ status: string; relativePath: string; sections: Array<{ patch: string }> }>(
      `${handle!.url}/api/projects/repo/git/diff?path=src%2Fpricing.ts`,
    );
    expect(diff).toMatchObject({ status: "text", relativePath: "src/pricing.ts" });
    expect(diff.sections[0]?.patch).toContain("export const price = 2;");

    const unsafe = await getJson<{ status: string; message: string }>(
      `${handle!.url}/api/projects/repo/git/diff?path=..%2Foutside.ts`,
    );
    expect(unsafe.status).toBe("not-found");
    expect(unsafe.message).toContain("安全范围");

    const history = await getJson<{
      status: string;
      commits: Array<{ sha: string; shortSha: string; summary: string; additions: number; deletions: number }>;
    }>(`${handle!.url}/api/projects/repo/git/history?limit=10&offset=0&query=baseline`);
    expect(history.status).toBe("ok");
    expect(history.commits[0]).toMatchObject({ summary: "baseline" });
    expect(history.commits[0]?.additions).toBeGreaterThan(0);

    const sha = history.commits[0]!.sha;
    const detail = await getJson<{
      status: string;
      sha: string;
      summary: string;
      files: Array<{ relativePath: string; status: string; additions: number; deletions: number }>;
    }>(`${handle!.url}/api/projects/repo/git/commit?sha=${encodeURIComponent(sha)}`);
    expect(detail).toMatchObject({ status: "ok", sha, summary: "baseline" });
    expect(detail.files).toContainEqual(expect.objectContaining({ relativePath: "src/pricing.ts", status: "A" }));

    const commitDiff = await getJson<{ status: string; relativePath: string; patch: string; additions: number }>(
      `${handle!.url}/api/projects/repo/git/commit-diff?sha=${encodeURIComponent(sha)}&path=src%2Fpricing.ts`,
    );
    expect(commitDiff).toMatchObject({ status: "text", relativePath: "src/pricing.ts" });
    expect(commitDiff.patch).toContain("+export const price = 1;");

    const badSha = await getJson<{ status: string; message: string }>(
      `${handle!.url}/api/projects/repo/git/commit?sha=not-a-sha`,
    );
    expect(badSha.status).toBe("not-found");
  });

  it("opens project-scoped terminal sessions through the TerminalRuntime owner", async () => {
    const fakePty = new FakePty();
    const terminalRuntime = new TerminalRuntime({
      loadPty: async () => ({
        spawn: (_shell: string, _args: string[], options: { cwd?: string; cols?: number; rows?: number }) => {
          fakePty.cwd = options.cwd ?? "";
          fakePty.cols = options.cols ?? 0;
          fakePty.rows = options.rows ?? 0;
          return fakePty;
        },
      }) as unknown as typeof import("node-pty"),
    });
    const appHandle = await startWorkbenchServer({ project: project(), path: tempDir }, { port: 0, staticRoot, terminalRuntime });
    try {
      const opened = await fetch(`${appHandle.url}/api/projects/repo/terminal/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalId: "term-1", cols: 90, rows: 30 }),
      });
      expect(opened.ok).toBe(true);
      expect(await sameTestPhysicalPath(fakePty.cwd, tempDir)).toBe(true);
      expect(fakePty.cols).toBe(90);
      expect(fakePty.rows).toBe(30);

      const received: string[] = [];
      const unsubscribe = terminalRuntime.subscribe("repo", "term-1", (event) => {
        if (event.type === "output") received.push(event.data);
      });
      fakePty.emitData("hello terminal");
      unsubscribe();
      expect(received).toEqual(["hello terminal"]);

      const write = await fetch(`${appHandle.url}/api/projects/repo/terminal/sessions/term-1/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "pwd\r" }),
      });
      expect(write.ok).toBe(true);
      expect(fakePty.writes).toContain("pwd\r");

      const resized = await fetch(`${appHandle.url}/api/projects/repo/terminal/sessions/term-1/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: 120, rows: 40 }),
      });
      expect(resized.ok).toBe(true);
      expect(fakePty.resizeCalls).toContainEqual({ cols: 120, rows: 40 });

      const closed = await fetch(`${appHandle.url}/api/projects/repo/terminal/sessions/term-1`, { method: "DELETE" });
      expect(closed.ok).toBe(true);
      expect(fakePty.killed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => appHandle.server.close(() => resolve()));
    }
  });

  it("returns a readable degraded response when PTY is unavailable", async () => {
    const terminalRuntime = new TerminalRuntime({
      loadPty: async () => {
        throw new Error("native module missing");
      },
    });
    const appHandle = await startWorkbenchServer({ project: project(), path: tempDir }, { port: 0, staticRoot, terminalRuntime });
    try {
      const opened = await fetch(`${appHandle.url}/api/projects/repo/terminal/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalId: "term-missing" }),
      });
      expect(opened.status).toBe(503);
      expect(await opened.text()).toContain("Terminal runtime is unavailable");
    } finally {
      await new Promise<void>((resolve) => appHandle.server.close(() => resolve()));
    }
  });

  it("returns HTTP diagnostics for unsupported API and action requests", async () => {
    const missing = await fetch(`${handle!.url}/api/not-found`);
    expect(missing.status).toBe(404);

    const unconfirmed = await fetch(`${handle!.url}/api/workbench/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: { actionId: "audit.accept", label: "Accept", command: "audit", args: ["accept", "repo", "audit-1"], mutates: true, requiresConfirmation: true },
      }),
    });
    expect(unconfirmed.status).toBe(409);

    const unknown = await fetch(`${handle!.url}/api/workbench/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: { actionId: "unknown", label: "Unknown", command: "bad", args: [], mutates: true, requiresConfirmation: true },
        confirm: true,
      }),
    });
    expect(unknown.status).toBe(400);

    const invalidJson = await fetch(`${handle!.url}/api/workbench/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
  });

  it("streams live endpoint errors as SSE without changing replay endpoints", async () => {
    const live = await fetch(`${handle!.url}/api/workbench/actions/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionType: "validate.run", changeId: "server-topic", confirm: true }),
    });
    expect(live.ok).toBe(true);
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    const body = await live.text();
    expect(body).toContain("event: error");
    expect(body).toContain("is not supported by the live endpoint");
    expect(body).toContain("event: done");
    const errorIndex = body.indexOf("event: error");
    const snapshotIndex = body.indexOf("event: snapshot");
    const doneIndex = body.indexOf("event: done");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThan(errorIndex);
    expect(doneIndex).toBeGreaterThan(snapshotIndex);

    const replay = await fetch(`${handle!.url}/api/workbench/stream/${serverRunId}`);
    const replayBody = await replay.json() as { live: boolean };
    expect(replayBody.live).toBe(false);
  });

  it("forwards scoped workflow targets through the live endpoint", async () => {
    const live = await fetch(`${handle!.url}/api/workbench/actions/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionType: "post-merge.prepare",
        changeId: "server-topic",
        landingPackageId: "landing-server",
        remoteLandingResultId: "remote-landing-server",
        confirm: true,
      }),
    });
    expect(live.ok).toBe(true);
    const body = await live.text();
    expect(body).toContain("event: error");
    expect(body).not.toContain("requires landingPackageId");
    expect(body).not.toContain("requires remoteLandingResultId");
  });

  it("rejects unknown and unconfirmed actions", async () => {
    await expect(executeWorkbenchAction({ project: project(), path: tempDir }, {
      action: { actionId: "unknown", label: "Unknown", command: "bad", args: [], mutates: true, requiresConfirmation: true },
      confirm: true,
    })).rejects.toThrow("Unknown");

    await expect(executeWorkbenchAction({ project: project(), path: tempDir }, {
      action: { actionId: "audit.accept", label: "Accept", command: "audit", args: ["accept", "repo", "audit-1"], mutates: true, requiresConfirmation: true },
    })).rejects.toThrow("confirm");

    await expect(executeWorkbenchAction({ project: project(), path: tempDir }, {
      actionType: "validate.run",
      changeId: "server-topic",
    })).rejects.toThrow("confirm");

    await expect(executeWorkbenchAction({ project: project(), path: tempDir }, {
      actionType: "harness-change.close",
      changeId: "server-topic",
      finalizationRequestId: "finalize-request",
    })).rejects.toThrow("confirm");
  });

  it("fails closed for missing demand scope and stale workflow targets", async () => {
    await expect(executeWorkbenchAction({ project: project(), path: tempDir }, {
      actionType: "validate.run",
      confirm: true,
    })).rejects.toThrow("requires changeId");

    const testRouter = workflowTestRouter();
    const missingTarget = await executeWorkbenchAction({ project: project(), path: tempDir }, {
      actionType: "validate.run",
      changeId: "server-topic",
      confirm: true,
    }, undefined, testRouter);
    expect(JSON.stringify(missingTarget.result)).toContain("requires worktreeId");

    await expect(executeWorkbenchAction({ project: project(), path: tempDir }, {
      actionType: "landing-queue.merge-next",
      changeId: "server-topic",
      landingPackageId: "forged-landing-package",
      confirm: true,
    }, undefined, testRouter)).rejects.toThrow("stale or no longer available");

  });

  it("serves one Main/child Timeline API and retires transcript projections", async () => {
    await appendCanonicalTimelineEntry(project(), "server-topic", { type: "assistant.message", text: "Main answer 1" });
    await appendCanonicalTimelineEntry(project(), "server-topic", { type: "assistant.message", text: "Main answer 2" });
    await appendCanonicalTimelineEntry(project(), "server-topic", {
      type: "assistant.message",
      text: "Child answer",
      providerId: "codex",
      agentSurfaceId: "agent:codex:thread:thread-child",
      threadId: "thread-child",
      parentThreadId: "thread-main",
      agentRoleId: "planning-agent",
    });
    const snapshot = await getJson<SnapshotResponse>(`${handle!.url}/api/workbench/snapshot?productMode=harness&topic=${serverConversationId}`);
    expect(snapshot.center).not.toHaveProperty("agentRelationGraph");
    expect(snapshot.center).not.toHaveProperty("parentAgentTranscript");
    expect(snapshot.right).not.toHaveProperty("agentWorkspace");

    const main = await getJson<{ watermark: number; pinned: Array<{ agentSurfaceId: string; orderClass: string; revision: number }>; entries: Array<{ agentSurfaceId: string; orderClass: string; position: number; revision: number }>; paging: { limit: number; totalCount: number; nextBeforeCursor?: string } }>(
      `${handle!.url}/api/projects/repo/workbench/conversations/${serverConversationId}/timeline?productMode=harness&agentSurfaceId=main-agent&limit=2`,
    );
    expect(main).toMatchObject({ pinned: [], paging: { limit: 2 } });
    expect(main.entries.every((envelope) => envelope.agentSurfaceId === "main-agent" && envelope.orderClass === "sequence" && envelope.revision <= main.watermark)).toBe(true);
    expect(main.paging.nextBeforeCursor).toEqual(expect.any(String));

    const childSurfaceId = "agent:codex:thread:thread-child";
    const child = await getJson<typeof main>(
      `${handle!.url}/api/projects/repo/workbench/conversations/${serverConversationId}/timeline?productMode=harness&agentSurfaceId=${encodeURIComponent(childSurfaceId)}`,
    );
    expect(child.entries).toHaveLength(1);
    expect(child.entries[0]).toMatchObject({ agentSurfaceId: childSurfaceId, orderClass: "sequence" });

    const crossScopeCursor = await fetch(
      `${handle!.url}/api/projects/repo/workbench/conversations/${serverConversationId}/timeline?productMode=harness&agentSurfaceId=${encodeURIComponent(childSurfaceId)}&beforeCursor=${encodeURIComponent(main.paging.nextBeforeCursor!)}`,
    );
    expect(crossScopeCursor.status).toBe(400);

    const retired = await fetch(`${handle!.url}/api/workbench/projections/transcript/${serverConversationId}`);
    expect(retired.status).toBe(400);

    const surfaces = await getJson<{ conversationId: string; projectionHash: string; surfaces: Array<{ agentSurfaceId: string }> }>(
      `${handle!.url}/api/projects/repo/workbench/projections/agent-surfaces/${serverConversationId}?productMode=harness`,
    );
    expect(surfaces).toMatchObject({ conversationId: serverConversationId, projectionHash: expect.any(String) });
    expect(surfaces.surfaces.some((surface) => surface.agentSurfaceId === "main-agent")).toBe(true);
    expect((await fetch(`${handle!.url}/api/projects/repo/workbench/projections/agent-surfaces/${serverConversationId}`)).status).toBe(400);
    expect((await fetch(`${handle!.url}/api/projects/repo/workbench/projections/agent-surfaces/${serverConversationId}?productMode=agent`)).status).toBe(400);
    expect((await fetch(`${handle!.url}/api/workbench/projections/agent-graph/${serverConversationId}`)).status).toBe(400);
  });

  it("serves app-level project onboarding routes", async () => {
    const store = new ProjectRegistryStore(registryRoot);
    const appHandle = await startWorkbenchServer(null, {
      port: 0,
      staticRoot,
      store,
    });
    try {
      const status = await getJson<{ mode: string }>(`${appHandle.url}/api/app/status`);
      expect(status.mode).toBe("app");

      const unconfirmed = await fetch(`${appHandle.url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tempDir }),
      });
      expect(unconfirmed.status).toBe(409);

      const added = await fetch(`${appHandle.url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tempDir, name: "Server Repo", confirm: true }),
      });
      expect(added.ok).toBe(true);
      const addedBody = await added.json() as { project: { id: string } };

      const projectTopic = await fetch(`${appHandle.url}/api/projects/${addedBody.project.id}/workbench/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "Keep route behavior",
          productMode: "harness",
          clientRequestId: "server-app-first-send",
          confirm: true,
        }),
      });
      expect(projectTopic.ok).toBe(true);
      const projectTopicBody = await projectTopic.json() as { topic: { id: string; conversationId: string } };
      const projectTopicId = projectTopicBody.topic.conversationId ?? projectTopicBody.topic.id;
      const projectTimeline = await getJson<{ pinned: unknown[]; entries: Array<{ cells: Array<{ kind: string; text?: string }> }> }>(
        `${appHandle.url}/api/projects/${addedBody.project.id}/workbench/conversations/${projectTopicId}/timeline?productMode=harness&agentSurfaceId=main-agent&limit=100`,
      );
      expect(Array.isArray(projectTimeline.entries)).toBe(true);
      expect(projectTimeline.entries.flatMap((entry) => entry.cells)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "user-message", text: "Keep route behavior" }),
      ]));
      const activityProject = { ...project(), id: addedBody.project.id, name: "Server Repo" };
      const activityScope = await createConversationChangeFixture(activityProject, { title: "Runtime activity fixture" });
      await appendCanonicalTimelineEntry(activityProject, activityScope.changeId, {
        type: "workflow.completed",
        actionRunId: "action-private-path",
        actionType: "code.run",
        status: "failed",
        error: `ENOENT: no such file or directory, open '${join(tempDir, ".agent-harness", "workbench", "private.json")}'`,
      });

      const directTopic = await fetch(`${handle!.url}/api/workbench/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Direct route remains unsupported", confirm: true }),
      });
      expect(directTopic.status).toBe(404);

      const projects = await getJson<{ projects: Array<{ project: { id: string }; path: string }> }>(`${appHandle.url}/api/projects`);
      expect(projects.projects).toHaveLength(1);
      expect(projects.projects[0].project.id).toBe(addedBody.project.id);
      expect(projects.projects[0].path).toContain("aho-server-");

      const diagnostics = await getJson<{ providerId: string; installation: { path?: string }; details: { configPath?: string; projectTrust?: { trusted: boolean } }; projectActions: Array<{ id: string; status: string }>; rawEvidenceRefs: string[] }>(`${appHandle.url}/api/projects/${addedBody.project.id}/providers/codex/diagnostics`);
      expect(diagnostics.providerId).toBe("codex");
      expect(diagnostics.installation.path).toContain("fake-codex-runtime");
      expect(diagnostics.details.configPath).toContain("codex-home");
      expect(diagnostics.details.projectTrust?.trusted).toBe(false);
      expect(Array.isArray(diagnostics.rawEvidenceRefs)).toBe(true);
      expect(diagnostics.projectActions).toContainEqual(expect.objectContaining({ id: "project.trust", status: "available" }));
      expect(existsSync(diagnostics.installation.path ?? "")).toBe(true);

      const trustResponse = await fetch(`${appHandle.url}/api/projects/${addedBody.project.id}/providers/codex/actions/project.trust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      expect(trustResponse.ok).toBe(true);
      const trusted = await trustResponse.json() as { details: { projectTrust?: { trusted: boolean } }; projectActions: Array<{ id: string; status: string }> };
      expect(trusted.details.projectTrust?.trusted).toBe(true);
      expect(trusted.projectActions).toContainEqual(expect.objectContaining({ id: "project.trust", status: "completed" }));

      const modelSettings = await getJson<{ providerId: string; effectiveModel: { modelId: string } | null; effectiveModelSource: string; candidates: unknown[]; available: boolean }>(`${appHandle.url}/api/projects/${addedBody.project.id}/providers/codex/models`);
      expect(modelSettings.providerId).toBe("codex");
      expect(modelSettings.effectiveModelSource).toBe("provider-default");
      expect(modelSettings.available).toBe(true);
      expect(Array.isArray(modelSettings.candidates)).toBe(true);

      const capabilities = await getJson<{
        providers: Array<{ providerId: string; productMode: string; runnable: boolean; snapshotHash: string; snapshotVersion: number; capabilities: Array<{ key: string; spec: string; runtime: string }> }>;
        runtimeSummaries: Array<{ providerId: string; productMode: string; harnessExecutionModes: string[]; snapshot: { providerId: string; productMode: string } }>;
      }>(
        `${appHandle.url}/api/projects/${addedBody.project.id}/providers/capabilities?productMode=harness`,
      );
      expect(capabilities.providers).toHaveLength(1);
      expect(capabilities.providers[0]).toMatchObject({ providerId: "codex", productMode: "harness" });
      expect(typeof capabilities.providers[0].runnable).toBe("boolean");
      expect(capabilities.providers[0].snapshotHash).toBeTruthy();
      expect(capabilities.providers[0].snapshotVersion).toBe(2);
      expect(capabilities.providers[0].capabilities).toContainEqual(expect.objectContaining({ key: "model.list", spec: "supported" }));
      expect(capabilities.providers[0].capabilities.some((item) => item.key === "skill.native-load")).toBe(true);
      expect(capabilities.runtimeSummaries).toHaveLength(1);
      expect(capabilities.runtimeSummaries[0]).toMatchObject({
        providerId: "codex",
        productMode: "harness",
        harnessExecutionModes: ["stepwise", "scoped-auto"],
        snapshot: { providerId: "codex", productMode: "harness" },
      });

      const runtimeActivity = await getJson<{
        projectId: string;
        limit: number;
        truncated: boolean;
        items: Array<{ type: string; title: string; summary: string; details?: string[]; refs: Array<{ label: string }> }>;
      }>(
        `${appHandle.url}/api/projects/${addedBody.project.id}/runtime/activity?limit=20`,
      );
      const defaultRuntimeActivityText = runtimeActivity.items.map((item) => [item.title, item.summary, ...(item.details ?? [])].join("\n")).join("\n");
      expect(runtimeActivity.projectId).toBe(addedBody.project.id);
      expect(runtimeActivity.limit).toBe(20);
      expect(typeof runtimeActivity.truncated).toBe("boolean");
      expect(runtimeActivity.items.length).toBeGreaterThan(0);
      expect(runtimeActivity.items.some((item) => item.type === "provider" && item.title.includes("Codex"))).toBe(true);
      const runActivity = runtimeActivity.items.find((item) => item.type === "run");
      expect(runActivity?.refs.map((ref) => ref.label)).not.toEqual(expect.arrayContaining(["owner", "directory"]));
      expect(JSON.stringify(runtimeActivity)).not.toContain("config.toml");
      expect(JSON.stringify(runtimeActivity)).not.toContain("stdout");
      expect(defaultRuntimeActivityText).not.toContain(tempDir);
      expect(defaultRuntimeActivityText).not.toContain(".agent-harness");
      expect(runtimeActivity.items.some((item) => item.type === "action-error" && item.summary.includes("路径已折叠"))).toBe(true);


      const init = await fetch(`${appHandle.url}/api/projects/${addedBody.project.id}/harness/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(init.status).toBe(404);

      const created = await fetch(`${appHandle.url}/api/projects/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: registryRoot, name: "created-repo", git: false, readme: true, initialCommit: false, confirm: true }),
      });
      expect(created.ok).toBe(true);
      const createdBody = await created.json() as { createdPath: string };
      expect(createdBody.createdPath).toContain("created-repo");

      const dialog = await fetch(`${appHandle.url}/api/dialog/open-folder`, {
        method: "POST",
        headers: { Origin: "https://example.com" },
      });
      expect(dialog.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => appHandle.server.close(() => resolve()));
    }
  });

  it("serves an unregistered direct Skill-native project from explicit input", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "aho-external-src-"));
    const ahoHome = await mkdtemp(join(tmpdir(), "aho-external-home-"));
    const store = new ProjectRegistryStore(join(registryRoot, "restore-home"));
    const directProject: ManagedProject = {
      id: "external-repo",
      name: "External Repo",
      path: sourceRoot,
      addedAt: "2026-06-25T00:00:00.000Z",
      lastSeenAt: "2026-06-25T00:00:00.000Z",
    };
    process.env.AHO_HOME = ahoHome;
    await createReadyProjectHarnessFixture({
      projectRoot: sourceRoot,
      ahoHome,
      projectId: directProject.id,
      projectName: directProject.name,
    });
    await createConversationChangeFixture(directProject, { title: "Restored Topic" });
    const projectRuntimeCoordinator = new ProjectRuntimeCoordinator({
      store,
      ahoHome,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });

    const directHandle = await startWorkbenchServer({ project: directProject, path: sourceRoot }, {
      port: 0,
      staticRoot,
      store,
      projectRuntimeCoordinator,
    });
    try {
      const status = await getJson<{ mode: string; directProjectId: string | null }>(`${directHandle.url}/api/app/status`);
      expect(status).toMatchObject({ mode: "project", directProjectId: "external-repo" });

      const projects = await getJson<{ projects: Array<{ project: { id: string; name: string } | null; harness: { managed: boolean; readiness: string } }> }>(`${directHandle.url}/api/projects`);
      expect(projects.projects).toHaveLength(1);
      expect(projects.projects[0]).toMatchObject({
        project: { id: "external-repo", name: "External Repo" },
        harness: { managed: true, readiness: "ready" },
      });
      expect(await store.listProjects()).toHaveLength(0);

      const saved = await fetch(`${directHandle.url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourceRoot, name: "External Repo", confirm: true }),
      });
      expect(saved.ok).toBe(true);
      expect(await store.listProjects()).toHaveLength(1);

      const snapshot = await getJson<SnapshotResponse>(`${directHandle.url}/api/projects/external-repo/workbench/snapshot?productMode=harness`);
      expect(snapshot.left.topics[0]).toMatchObject({ id: "conv-restored-topic", boundChangeId: "restored-topic" });
    } finally {
      await new Promise<void>((resolve) => directHandle.server.close(() => resolve()));
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(ahoHome, { recursive: true, force: true });
    }
  });

  it("uses the injected runtime coordinator owner for Skill API, Conversation, and Snapshot reads", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "aho-runtime-owner-src-"));
    const customAhoHome = await mkdtemp(join(tmpdir(), "aho-runtime-owner-home-"));
    const customStore = new ProjectRegistryStore(join(customAhoHome, "registry"));
    const customProject: ManagedProject = {
      id: "custom-runtime-owner",
      name: "Custom Runtime Owner",
      path: sourceRoot,
      addedAt: "2026-08-14T00:00:00.000Z",
      lastSeenAt: "2026-08-14T00:00:00.000Z",
      defaultProviderId: "codex",
    };
    await createReadyProjectHarnessFixture({
      projectRoot: sourceRoot,
      ahoHome: customAhoHome,
      projectId: customProject.id,
      projectName: customProject.name,
    });
    const projectRuntimeCoordinator = new ProjectRuntimeCoordinator({
      store: customStore,
      ahoHome: customAhoHome,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });
    const resolveRuntimeState = vi.spyOn(projectRuntimeCoordinator, "resolve");
    const customHandle = await startWorkbenchServer(
      { project: customProject, path: sourceRoot },
      {
        port: 0,
        staticRoot,
        store: customStore,
        projectRuntimeCoordinator,
      },
    );
    try {
      const skills = await getJson<{ skills: Array<{ skillId: string }> }>(
        `${customHandle.url}/api/projects/${customProject.id}/skills?productMode=agent&providerId=codex`,
      );
      expect(skills.skills).toEqual(expect.any(Array));

      const createResponse = await fetch(`${customHandle.url}/api/projects/${customProject.id}/workbench/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "Use the custom runtime owner.",
          productMode: "agent",
          clientRequestId: "custom-runtime-owner-create",
          confirm: true,
        }),
      });
      expect(createResponse.ok).toBe(true);
      const created = await createResponse.json() as { topic: { conversationId: string; productMode: string } };
      expect(created.topic.productMode).toBe("agent");

      const customPaths = resolveProjectRuntimePaths(customProject.id, customAhoHome);
      expect(existsSync(customPaths.workbenchDbPath)).toBe(true);
      expect(resolveRuntimeState).toHaveBeenCalled();
      expect(resolveRuntimeState.mock.calls.every(([selected]) => selected.id === customProject.id)).toBe(true);
      const customDatabase = await openProjectRuntimeWorkbenchDatabase(customPaths);
      try {
        expect(customDatabase.conversations.readConversation(customProject.id, created.topic.conversationId))
          .toMatchObject({ conversationId: created.topic.conversationId, productMode: "agent" });
      } finally {
        customDatabase.close();
      }

      const snapshot = await getJson<{ productMode: string; left: { topics: Array<{ id: string; productMode: string }> } }>(
        `${customHandle.url}/api/projects/${customProject.id}/workbench/snapshot?productMode=agent&topic=${encodeURIComponent(created.topic.conversationId)}`,
      );
      expect(snapshot).toMatchObject({
        productMode: "agent",
        left: { topics: [expect.objectContaining({ id: created.topic.conversationId, productMode: "agent" })] },
      });

      const conversationSkills = await getJson<{ skills: Array<{ skillId: string }> }>(
        `${customHandle.url}/api/projects/${customProject.id}/skills?productMode=agent&providerId=codex&conversationId=${encodeURIComponent(created.topic.conversationId)}`,
      );
      expect(conversationSkills.skills).toEqual(skills.skills);
    } finally {
      await new Promise<void>((resolve) => customHandle.server.close(() => resolve()));
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(customAhoHome, { recursive: true, force: true });
    }
  });

  it("reports incomplete Skill-native onboarding for a direct project without a physical Skill", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "aho-external-missing-src-"));
    const ahoHome = await mkdtemp(join(tmpdir(), "aho-external-missing-home-"));
    const store = new ProjectRegistryStore(join(registryRoot, "restore-missing-home"));
    const directProject: ManagedProject = {
      id: "missing-skill-repo",
      name: "Missing Skill Repo",
      path: sourceRoot,
      addedAt: "2026-06-25T00:00:00.000Z",
      lastSeenAt: "2026-06-25T00:00:00.000Z",
    };
    process.env.AHO_HOME = ahoHome;

    const directHandle = await startWorkbenchServer({ project: directProject, path: sourceRoot }, { port: 0, staticRoot, store });
    try {
      const snapshot = await getJson<SnapshotResponse & {
        harness: {
          kind: string;
          registered: boolean;
          managed: boolean;
          harnessReady: boolean;
          runtimeAvailable: boolean;
          projectId?: string;
          state: string;
          reason: string;
        };
      }>(`${directHandle.url}/api/projects/missing-skill-repo/workbench/snapshot?productMode=harness`);
      expect(snapshot.harness).toMatchObject({
        kind: "project-skill",
        registered: true,
        managed: true,
        harnessReady: false,
        runtimeAvailable: true,
        projectId: "missing-skill-repo",
        state: "onboarding",
      });
      expect(snapshot.left.topics).toHaveLength(0);
      expect(snapshot.warnings).toEqual([
        "Project Harness onboarding is incomplete; Workbench will not infer project history.",
      ]);

      const agentSkills = await fetch(
        `${directHandle.url}/api/projects/missing-skill-repo/skills?productMode=agent&providerId=codex`,
      );
      expect(agentSkills.ok).toBe(true);

      const createdResponse = await fetch(`${directHandle.url}/api/projects/missing-skill-repo/workbench/topics/live`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "Create an Agent conversation without a project Harness.",
          productMode: "agent",
          clientRequestId: "missing-harness-agent-conversation",
          confirm: true,
        }),
      });
      const createdEvents = parseSseEvents(await createdResponse.text());
      const created = createdEvents.find((event) => event.event === "topic.created")?.data as { conversationId: string };
      expect(created.conversationId).toBeTruthy();

      const laterResponse = await fetch(
        `${directHandle.url}/api/projects/missing-skill-repo/workbench/topics/${created.conversationId}/messages/live`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Run this later Agent message in the same Conversation.",
            productMode: "agent",
          }),
        },
      );
      const laterEvents = parseSseEvents(await laterResponse.text());
      expect(laterEvents.find((event) => event.event === "done")?.data).toMatchObject({
        conversationId: created.conversationId,
        productMode: "agent",
        status: "completed",
      });
      const timeline = await getJson<{ entries: Array<{ cells: Array<{ kind: string; text?: string }> }> }>(
        `${directHandle.url}/api/projects/missing-skill-repo/workbench/conversations/${created.conversationId}/timeline?productMode=agent&agentSurfaceId=main-agent&limit=100`,
      );
      expect(timeline.entries.flatMap((entry) => entry.cells)
        .filter((cell) => cell.kind === "user-message" || cell.kind === "assistant-message")
        .map((cell) => cell.text)).toEqual([
        "Create an Agent conversation without a project Harness.",
        "主 Agent 已读取需求。",
        "Run this later Agent message in the same Conversation.",
        "主 Agent 已读取需求。",
      ]);
    } finally {
      await new Promise<void>((resolve) => directHandle.server.close(() => resolve()));
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(ahoHome, { recursive: true, force: true });
    }
  });

  it("fails closed when a canonical Harness id is registered to another path", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "aho-external-src-"));
    const otherRoot = await mkdtemp(join(tmpdir(), "aho-external-other-"));
    const conflictHome = join(registryRoot, "restore-conflict-home");
    const store = new ProjectRegistryStore(conflictHome);
    process.env.AHO_HOME = conflictHome;
    await createReadyProjectHarnessFixture({
      projectRoot: sourceRoot,
      ahoHome: conflictHome,
      projectId: "external-repo",
      projectName: "External Repo",
    });
    await store.registerProject({ path: otherRoot, name: "Other Repo", projectId: "external-repo" });
    const appHandle = await startWorkbenchServer(null, { port: 0, staticRoot, store });
    try {
      const response = await fetch(`${appHandle.url}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sourceRoot, name: "External Repo", confirm: true }),
      });
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("Project id is already registered for a different path");
    } finally {
      await appHandle.close();
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects every project mutation through the startup coordinator when recovery marked the project unavailable", async () => {
    await handle!.close();
    handle = null;
    const store = new ProjectRegistryStore(registryRoot);
    await store.registerProject({ path: tempDir, name: project().name, projectId: project().id });
    const unavailable = {
      state: "unavailable" as const,
      project: project(),
      issue: {
        code: "project-recovery-failed" as const,
        summary: "这个项目的协作配置需要处理。",
        recovery: "请重新启动 Beaver Code。",
      },
    };
    const coordinator: ProjectRuntimeCoordinatorPort = {
      async reconcileStartup() {
        return { states: [unavailable], migrations: [], recoveries: [], onboardingRecoveries: [] };
      },
      async resolve() {
        throw new ProjectRuntimeUnavailableError(unavailable);
      },
      async startupState() {
        return unavailable;
      },
      async requireReady() {
        throw new ProjectRuntimeUnavailableError(unavailable);
      },
      markUnavailable() {
        return unavailable;
      },
      async register() {
        throw new Error("not used");
      },
      runtimePaths(projectId) {
        return resolveProjectRuntimePaths(projectId, registryRoot);
      },
    };
    handle = await startWorkbenchServer({ project: project(), path: tempDir }, {
      port: 0,
      staticRoot,
      store,
      projectRuntimeCoordinator: coordinator,
    });

    const providerAction = await fetch(`${handle.url}/api/projects/repo/providers/codex/actions/project.trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const abandon = await fetch(`${handle.url}/api/projects/repo/workbench/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ abandon: { changeId: "change-a", conversationId: "conv-a", graphScopeId: "graph-a" }, confirm: true }),
    });

    expect(providerAction.status).toBe(409);
    expect(abandon.status).toBe(409);
    await expect(providerAction.json()).resolves.toMatchObject({ error: "这个项目需要处理后才能继续使用。" });
    await expect(abandon.json()).resolves.toMatchObject({ error: "这个项目需要处理后才能继续使用。" });
  });

  it("starts with a ready project when another registered project is unavailable", async () => {
    await handle!.close();
    handle = null;
    const store = new ProjectRegistryStore(registryRoot);
    await store.registerProject({ path: tempDir, name: project().name, projectId: project().id });
    const missingPath = join(tempDir, "missing-project");
    const missing = (await store.registerProject({ path: missingPath, name: "Unavailable Project" })).project;

    handle = await startWorkbenchServer(null, { port: 0, staticRoot, store });

    const payload = await getJson<{ projects: Array<{
      project: ManagedProject;
      harness: { readiness: string };
      runtimeAvailability?: { state: string; summary: string | null };
    }> }>(`${handle.url}/api/projects`);
    expect(payload.projects.find((item) => item.project.id === project().id)).toMatchObject({
      harness: { readiness: "ready" },
      runtimeAvailability: { state: "ready" },
    });
    expect(payload.projects.find((item) => item.project.id === missing.id)).toMatchObject({
      harness: { readiness: "unavailable" },
      runtimeAvailability: {
        state: "unavailable",
        summary: "这个项目的协作配置无法读取。",
      },
    });
    expect((await fetch(`${handle.url}/api/projects/${missing.id}/workbench/snapshot?productMode=agent`)).status).toBe(409);
    expect((await fetch(`${handle.url}/api/projects/${project().id}/workbench/topics?productMode=harness`)).status).toBe(200);
  });

  it("isolates an unsupported Workbench database without changing its schema version", async () => {
    await handle!.close();
    handle = null;
    const isolatedHome = join(registryRoot, "database-compatibility");
    const healthyRoot = join(tempDir, "healthy-project");
    const legacyRoot = join(tempDir, "legacy-project");
    await mkdir(healthyRoot, { recursive: true });
    await mkdir(legacyRoot, { recursive: true });
    await createReadyProjectHarnessFixture({
      projectRoot: healthyRoot,
      ahoHome: isolatedHome,
      projectId: "healthy-project",
      projectName: "Healthy Project",
    });
    await createReadyProjectHarnessFixture({
      projectRoot: legacyRoot,
      ahoHome: isolatedHome,
      projectId: "legacy-project",
      projectName: "Legacy Project",
    });
    const store = new ProjectRegistryStore(isolatedHome);
    await store.registerProject({ path: healthyRoot, name: "Healthy Project", projectId: "healthy-project" });
    await store.registerProject({ path: legacyRoot, name: "Legacy Project", projectId: "legacy-project" });
    const legacyPaths = resolveProjectRuntimePaths("legacy-project", isolatedHome);
    const initialized = await openProjectRuntimeWorkbenchDatabase(legacyPaths);
    initialized.close();
    const legacy = new Database(legacyPaths.workbenchDbPath);
    legacy.pragma("user_version = 7");
    legacy.close();

    handle = await startWorkbenchServer(null, { port: 0, staticRoot, store });
    const payload = await getJson<{ projects: Array<{
      project: ManagedProject;
      runtimeAvailability?: { state: string; summary: string | null };
    }> }>(`${handle.url}/api/projects`);
    expect(payload.projects.find((item) => item.project.id === "legacy-project")).toMatchObject({
      runtimeAvailability: {
        state: "unavailable",
        summary: "这个项目的数据版本过旧，无法自动升级。",
      },
    });
    expect((await fetch(`${handle.url}/api/projects/healthy-project/workbench/topics?productMode=agent`)).status).toBe(200);
    const preserved = new Database(legacyPaths.workbenchDbPath, { readonly: true });
    expect(Number(preserved.pragma("user_version", { simple: true }))).toBe(7);
    preserved.close();
  });

  it("preflights Schema 16 and upgrades it only when the project is first opened", async () => {
    await handle!.close();
    handle = null;
    const isolatedHome = join(registryRoot, "lazy-database-upgrade");
    const projectRoot = join(tempDir, "lazy-project");
    await mkdir(projectRoot, { recursive: true });
    await createReadyProjectHarnessFixture({
      projectRoot,
      ahoHome: isolatedHome,
      projectId: "lazy-project",
      projectName: "Lazy Project",
    });
    const store = new ProjectRegistryStore(isolatedHome);
    await store.registerProject({ path: projectRoot, name: "Lazy Project", projectId: "lazy-project" });
    const paths = resolveProjectRuntimePaths("lazy-project", isolatedHome);
    const initialized = await openProjectRuntimeWorkbenchDatabase(paths);
    initialized.close();
    const legacy = new Database(paths.workbenchDbPath);
    materializeWorkbenchSchemaContract(legacy, 16);
    legacy.close();

    handle = await startWorkbenchServer(null, { port: 0, staticRoot, store });
    const before = await getJson<{ projects: Array<{
      project: ManagedProject;
      runtimeAvailability?: { state: string; summary: string | null };
    }> }>(`${handle.url}/api/projects`);
    expect(before.projects.find((item) => item.project.id === "lazy-project")).toMatchObject({
      runtimeAvailability: { state: "upgrade-required" },
    });
    const beforeOpen = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(beforeOpen.pragma("user_version", { simple: true }))).toBe(16);
    beforeOpen.close();

    expect((await fetch(`${handle.url}/api/projects/lazy-project/workbench/topics?productMode=agent`)).status).toBe(200);
    const afterOpen = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(afterOpen.pragma("user_version", { simple: true }))).toBe(WORKBENCH_SCHEMA_VERSION);
    afterOpen.close();
    const after = await getJson<{ projects: Array<{
      project: ManagedProject;
      runtimeAvailability?: { state: string };
    }> }>(`${handle.url}/api/projects`);
    expect(after.projects.find((item) => item.project.id === "lazy-project")).toMatchObject({
      runtimeAvailability: { state: "ready" },
    });
  });

  it("routes recoverable migration evidence through startup calibration instead of permanently isolating projects", async () => {
    await handle!.close();
    handle = null;
    const isolatedHome = join(registryRoot, "migration-retry-calibration");
    const store = new ProjectRegistryStore(isolatedHome);
    const projectIds = ["implementation-retry", "changed-source-retry", "stale-current"] as const;
    for (const projectId of projectIds) {
      const projectRoot = join(tempDir, projectId);
      await mkdir(projectRoot, { recursive: true });
      await createReadyProjectHarnessFixture({ projectRoot, ahoHome: isolatedHome, projectId, projectName: projectId });
      await store.registerProject({ path: projectRoot, name: projectId, projectId });
      const paths = resolveProjectRuntimePaths(projectId, isolatedHome);
      const initialized = await openProjectRuntimeWorkbenchDatabase(paths);
      initialized.close();
      const legacy = new Database(paths.workbenchDbPath);
      materializeWorkbenchSchemaContract(legacy, 16);
      legacy.close();
      await expect(openProjectRuntimeWorkbenchDatabase(paths, {
        upgradeOptions: {
          createTransactionId: () => `${projectId}-failed`,
          beforeMigration: () => { throw new Error("injected migration failure"); },
        },
      })).rejects.toMatchObject({ code: "recovery-required" });
    }

    const implementationPaths = resolveProjectRuntimePaths("implementation-retry", isolatedHome);
    const implementationUpgradeRoot = join(implementationPaths.workbenchRoot, "schema-upgrades");
    for (const evidencePath of [
      join(implementationUpgradeRoot, "recovery", "receipt.json"),
      join(implementationUpgradeRoot, "recovery-required.json"),
    ]) {
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { migrationImplementationVersion: number };
      evidence.migrationImplementationVersion += 1;
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }

    const changedPaths = resolveProjectRuntimePaths("changed-source-retry", isolatedHome);
    const changed = new Database(changedPaths.workbenchDbPath);
    changed.prepare(`
      INSERT INTO skill_roots(project_id, root_path, source_kind, updated_at)
      VALUES ('changed-source-retry', 'later-root', 'custom', '2026-09-11T00:00:00.000Z')
    `).run();
    changed.close();

    const stalePaths = resolveProjectRuntimePaths("stale-current", isolatedHome);
    await rm(stalePaths.workbenchDbPath, { force: true });
    await rm(`${stalePaths.workbenchDbPath}-wal`, { force: true });
    await rm(`${stalePaths.workbenchDbPath}-shm`, { force: true });
    const replacement = new Database(stalePaths.workbenchDbPath);
    applyCurrentWorkbenchSchema(replacement);
    replacement.pragma(`user_version = ${WORKBENCH_SCHEMA_VERSION}`);
    replacement.close();

    handle = await startWorkbenchServer(null, { port: 0, staticRoot, store });
    const before = await getJson<{ projects: Array<{
      project: ManagedProject;
      runtimeAvailability?: { state: string };
    }> }>(`${handle.url}/api/projects`);
    expect(before.projects.find((item) => item.project.id === "implementation-retry"))
      .toMatchObject({ runtimeAvailability: { state: "upgrade-required" } });
    expect(before.projects.find((item) => item.project.id === "changed-source-retry"))
      .toMatchObject({ runtimeAvailability: { state: "upgrade-required" } });
    expect(before.projects.find((item) => item.project.id === "stale-current"))
      .toMatchObject({ runtimeAvailability: { state: "ready" } });

    for (const projectId of ["implementation-retry", "changed-source-retry"] as const) {
      expect((await fetch(`${handle.url}/api/projects/${projectId}/workbench/topics?productMode=agent`)).status).toBe(200);
      const current = new Database(resolveProjectRuntimePaths(projectId, isolatedHome).workbenchDbPath, { readonly: true });
      expect(Number(current.pragma("user_version", { simple: true }))).toBe(WORKBENCH_SCHEMA_VERSION);
      current.close();
    }
    expect(existsSync(join(stalePaths.workbenchRoot, "schema-upgrades", "recovery-required.json"))).toBe(false);
    expect(existsSync(join(stalePaths.workbenchRoot, "schema-upgrades", "recovery"))).toBe(false);
  });

  it("starts when a previously registered project directory no longer exists", async () => {
    const removedRoot = await mkdtemp(join(tmpdir(), "aho-removed-project-"));
    const missingHome = join(registryRoot, "missing-project-home");
    const store = new ProjectRegistryStore(missingHome);
    process.env.AHO_HOME = missingHome;
    await store.registerProject({ path: removedRoot, name: "Removed Project", projectId: "removed-project" });
    await rm(removedRoot, { recursive: true, force: true });

    const appHandle = await startWorkbenchServer(null, { port: 0, staticRoot, store });
    try {
      const response = await fetch(`${appHandle.url}/api/projects`);
      expect(response.status).toBe(200);
      const body = await response.json() as { projects: Array<{ project: { id: string }; pathExists: boolean }> };
      expect(body.projects).toContainEqual(expect.objectContaining({
        project: expect.objectContaining({ id: "removed-project" }),
        pathExists: false,
      }));
    } finally {
      await appHandle.close();
    }
  });

  it("builds native folder dialog commands with fixed argv", () => {
    const windows = buildNativeFolderDialogCommand("win32");
    expect(windows?.command).toBe("powershell.exe");
    expect(windows?.args).toContain("-Sta");
    expect(windows?.args.join(" ")).toContain("FolderBrowserDialog");

    const mac = buildNativeFolderDialogCommand("darwin");
    expect(mac).toMatchObject({ command: "osascript" });

    const linux = buildNativeFolderDialogCommand("linux");
    expect(linux).toMatchObject({ command: "zenity" });

    expect(buildNativeFolderDialogCommand("freebsd")).toBeNull();
  });

  it("isolates a failed ready-project recovery and allows a later clean restart", async () => {
    const secondRoot = await mkdtemp(join(tmpdir(), "aho-server-recovery-"));
    const recoveryHome = join(registryRoot, "multi-project-recovery");
    const store = new ProjectRegistryStore(recoveryHome);
    process.env.AHO_HOME = recoveryHome;
    await createReadyProjectHarnessFixture({
      projectRoot: secondRoot,
      ahoHome: recoveryHome,
      projectId: "recovery-project",
      projectName: "Recovery Project",
    });
    await store.registerProject({ path: secondRoot, name: "Recovery Project", projectId: "recovery-project" });
    const runtime = resolveProjectRuntimePaths("recovery-project", recoveryHome);
    const malformed = join(runtime.workbenchRoot, "integration-checks", "malformed");
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, "apply-transaction.json"), "{}\n", "utf8");

    const coordinator = new ProjectRuntimeCoordinator({
      store,
      ahoHome: recoveryHome,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });
    await expect(recoverWorkbenchProjects(store, null, coordinator)).resolves.toBeUndefined();
    const registered = await store.resolveProject("recovery-project");
    expect(registered).not.toBeNull();
    await expect(coordinator.startupState(registered!)).resolves.toMatchObject({
      state: "unavailable",
      issue: { code: "project-recovery-failed" },
    });
    await rm(malformed, { recursive: true, force: true });
    const restarted = new ProjectRuntimeCoordinator({
      store,
      ahoHome: recoveryHome,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });
    await expect(recoverWorkbenchProjects(store, null, restarted)).resolves.toBeUndefined();
    await rm(secondRoot, { recursive: true, force: true });
  });
});

function workflowTestRouter(): ConversationTurnRoutingPort {
  return {
    assertRequestedMode: () => undefined,
    route: async () => {
      throw new Error("workflow test Router must not execute a Conversation Turn.");
    },
    resolveProviderId: (_project, requestedProviderId) => requestedProviderId ?? "codex",
    resolveRuntimeState: async (selectedProject) => ({
      state: "onboarding",
      project: selectedProject,
      projectRoot: selectedProject.path,
      paths: resolveProjectRuntimePaths(selectedProject.id, registryRoot),
      reservedProjectId: selectedProject.id,
    }),
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function postJson<T = Record<string, unknown>>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST ${url} failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function writeRuntimeSidecarRun(changeId: string): Promise<string> {
  const runtime = resolveProjectRuntimePaths(project().id, registryRoot);
  const runId = "run-server-stream";
  const directory = join(runtime.runsRoot, runId);
  const now = new Date().toISOString();
  const run: RunMetadata = {
    version: "1.0",
    id: runId,
    changeId,
    projectPath: tempDir,
    runtime: "local-command",
    executionMode: "direct",
    proposalOnly: false,
    command: [process.execPath, "-e", "console.log('server stream')"],
    status: "completed",
    exitCode: 0,
    signal: null,
    startedAt: now,
    finishedAt: now,
    artifacts: {
      owner: "runtime-sidecar",
      directory: `runs/${runId}`,
      context: `runs/${runId}/context.md`,
      events: `runs/${runId}/events.jsonl`,
      stdout: `runs/${runId}/stdout.log`,
      stderr: `runs/${runId}/stderr.log`,
    },
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  await writeFile(join(directory, "events.jsonl"), `${JSON.stringify({ timestamp: now, type: "run.completed", runId })}\n`, "utf8");
  return runId;
}

class FakePty {
  cwd = "";
  cols = 0;
  rows = 0;
  writes: string[] = [];
  resizeCalls: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.push(listener);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((item) => item !== listener); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitListeners.push(listener);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((item) => item !== listener); } };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

async function runGit(...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: tempDir });
}
