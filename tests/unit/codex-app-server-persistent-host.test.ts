import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => Object.assign(vi.fn(), {
  sync: vi.fn((_: string, args: string[]) => args[0] === "--version"
    ? { status: 0, stdout: "codex-cli 0.154.0\n", stderr: "", error: undefined }
    : { status: 0, stdout: "--listen stdio://\n", stderr: "", error: undefined }),
}));
vi.mock("cross-spawn", () => ({ default: spawnMock }));

import { getActiveCodexAppServerTurn, runCodexAppServerChildClose, runCodexAppServerChildTurn, runCodexAppServerTurn, type CodexAppServerRealtimeEvent } from "../../src/codex/app-server.js";
import { CodexAppServerHost, CodexAppServerHostRegistry, defaultCodexAppServerHostRegistry } from "../../src/codex/app-server-host.js";
import { resetCodexRuntimeForTests } from "../../src/codex/executable.js";
import { listCodexRuntimeModels } from "../../src/codex/model-settings.js";
import { defaultProjectRemovalFence } from "../../src/project-runtime/removal.js";
import { compactCodexContext, forkCodexSession, runCodexReview, runCodexTurn, setCodexSessionArchived } from "../../src/provider-runtime/codex-adapter.js";

const tempDirs: string[] = [];
const previousCodexBin = process.env.AHO_CODEX_BIN;

beforeEach(() => {
  process.env.AHO_CODEX_BIN = process.execPath;
  resetCodexRuntimeForTests();
  spawnMock.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await defaultCodexAppServerHostRegistry.disposeAll("persistent Host test cleanup");
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (previousCodexBin === undefined) delete process.env.AHO_CODEX_BIN;
  else process.env.AHO_CODEX_BIN = previousCodexBin;
  resetCodexRuntimeForTests();
});

describe("Codex persistent app-server Host", () => {
  it("routes a command approval through the exact active Turn and waits for Provider resolution", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4041, true);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    let started!: () => void;
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    const approvals: import("../../src/codex/app-server.js").CodexAppServerApprovalRequest[] = [];
    const resolutions: string[] = [];
    const options = await turnOptions(cwd, "approval-run", null);
    const run = runCodexAppServerTurn({
      ...options,
      approvalMode: "on-request",
      onTurnStarted: () => started(),
      onApprovalRequest: (request) => approvals.push(request),
      onApprovalResolved: (resolution) => resolutions.push(resolution.requestId),
    });
    await turnStarted;
    expect(server.threadParams[0]).toMatchObject({
      approvalPolicy: "on-request",
      config: { "features.request_permissions_tool": true },
    });
    server.sendApproval(901, "item/commandExecution/requestApproval", {
      threadId: "thread-main",
      turnId: "turn-main-1",
      itemId: "command-1",
      command: "TOKEN=private npm test",
      cwd,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]?.summary.command).toBe("TOKEN=[REDACTED] npm test");

    const active = getActiveCodexAppServerTurn(options.runtimeScopeId);
    await active?.respondToApproval("901", "approve-once", {
      runId: options.runId,
      threadId: "thread-main",
      turnId: "turn-main-1",
    });
    expect(server.serverResponses).toContainEqual({ id: 901, result: { decision: "accept" } });
    expect(resolutions).toEqual([]);
    server.resolveApproval("901", "thread-main");
    await vi.waitFor(() => expect(resolutions).toEqual(["901"]));
    server.completeParent();
    await run;

    const events = await readFile(options.paths.events, "utf8");
    expect(events).not.toContain("private");
    expect(events).not.toContain("availableDecisions\":[\"accept\"");
  });

  it("fails closed when a recognized approval request has malformed Turn lineage", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4042, true);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const errors: string[] = [];
    const options = await turnOptions(cwd, "malformed-approval-run", null);
    const run = runCodexAppServerTurn({
      ...options,
      approvalMode: "on-request",
      onApprovalRequest: () => {
        throw new Error("A malformed approval must not be presented.");
      },
      onError: (error) => errors.push(error.message),
    });
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());

    server.sendApproval(902, "item/fileChange/requestApproval", {
      threadId: "thread-main",
      turnId: "turn-main-1",
      reason: "missing item identity",
    });

    await expect(run).resolves.toMatchObject({ status: "interrupted" });
    expect(errors).toContain("Malformed Codex approval request: item/fileChange/requestApproval.");
    expect(server.interruptParams).toEqual([{ threadId: "thread-main", turnId: "turn-main-1" }]);
    expect(server.serverResponses).not.toContainEqual(expect.objectContaining({ id: 902 }));
  });

  it("maps managed images and files to private LocalImage and Mention inputs", async () => {
    const cwd = await tempDir();
    const managedFile = join(cwd, "managed", "marker.txt");
    const server = new PersistentCollaborationServer(4051, false, managedFile);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "attachment-run", null);
    const realtimeEvents: string[] = [];
    const alternateManagedPath = managedFile.replace(/\\/g, "/").toUpperCase();

    await runCodexAppServerTurn({
      ...options,
      imageInputs: [{ path: join(cwd, "managed", "pixel.png"), fileName: "pixel.png" }],
      fileInputs: [{ name: "marker.txt", path: managedFile }],
      onRealtimeEvent: (event) => realtimeEvents.push(JSON.stringify(event)),
    });

    expect(server.turnInputs[0]).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "mention", name: "marker.txt", path: join(cwd, "managed", "marker.txt") },
      { type: "localImage", path: join(cwd, "managed", "pixel.png") },
    ]);
    const events = await readFile(options.paths.events, "utf8");
    expect(events).not.toContain(join(cwd, "managed"));
    expect(events).not.toContain(alternateManagedPath);
    expect(events).not.toContain("AHO_ATTACHMENT_PRIVATE_TEXT");
    expect(events).not.toContain("storagePath");
    expect(realtimeEvents.join("\n")).not.toContain(join(cwd, "managed"));
    expect(realtimeEvents.join("\n")).not.toContain(alternateManagedPath);
    expect(realtimeEvents.join("\n")).not.toContain("AHO_ATTACHMENT_PRIVATE_TEXT");
    expect(realtimeEvents.join("\n")).not.toContain("storagePath");
    expect(realtimeEvents.join("\n")).toContain("[managed-attachment]");
  });

  it("maps the admitted Default model and reasoning effort to turn/start", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4052, false);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    await runCodexAppServerTurn({
      ...await turnOptions(cwd, "model-effort-run", null),
      model: "gpt-test",
      reasoningEffort: "high",
    });

    expect(server.turnParams[0]).toMatchObject({ model: "gpt-test", effort: "high" });
    expect(server.turnParams[0]).not.toHaveProperty("collaborationMode");
  });

  it("maps every native Review target to inline delivery on an existing read-only Session", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4054, false);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const lifecycle: string[] = [];
    const targets = [
      { type: "uncommitted-changes" as const },
      { type: "base-branch" as const, branch: "origin/main" },
      { type: "commit" as const, sha: "a".repeat(40), title: "Review target" },
      { type: "custom" as const, instructions: "Focus on correctness." },
    ];

    for (const [index, target] of targets.entries()) {
      const runId = `review-existing-${index}`;
      const options = await turnOptions(cwd, runId, "thread-main");
      await expect(runCodexReview({
        providerId: "codex",
        projectId: options.projectId,
        conversationId: options.conversationId,
        graphScopeId: "review-graph",
        runtimeScopeId: options.runtimeScopeId,
        runId,
        attemptId: `review-attempt-${index}`,
        cwd,
        target,
        existingSession: { providerId: "codex", sessionId: "thread-main" },
        bootstrapModel: { providerId: "codex", modelId: "must-not-override" },
        bootstrapReasoningEffort: "xhigh",
        sandboxPolicy: "read-only",
        paths: options.paths,
        timeoutMs: options.timeoutMs,
        onReviewEvent: (event) => lifecycle.push(event.phase),
      })).resolves.toMatchObject({ status: "completed", reviewText: "Review result." });
    }

    expect(server.reviewParams).toEqual([
      { threadId: "thread-main", target: { type: "uncommittedChanges" }, delivery: "inline" },
      { threadId: "thread-main", target: { type: "baseBranch", branch: "origin/main" }, delivery: "inline" },
      { threadId: "thread-main", target: { type: "commit", sha: "a".repeat(40), title: "Review target" }, delivery: "inline" },
      { threadId: "thread-main", target: { type: "custom", instructions: "Focus on correctness." }, delivery: "inline" },
    ]);
    expect(server.threadParams).toHaveLength(4);
    for (const params of server.threadParams) {
      expect(params).toMatchObject({ threadId: "thread-main", sandbox: "read-only", approvalPolicy: "on-request" });
      expect(params).not.toHaveProperty("model");
      expect(params.config).not.toHaveProperty("model_reasoning_effort");
    }
    expect(lifecycle).toEqual(["started", "completed", "started", "completed", "started", "completed", "started", "completed"]);
  });

  it("bootstraps a new Review Session with admitted model and reasoning effort", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4055, false);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "review-bootstrap", null);

    await expect(runCodexReview({
      providerId: "codex",
      projectId: options.projectId,
      conversationId: options.conversationId,
      graphScopeId: "review-graph",
      runtimeScopeId: options.runtimeScopeId,
      runId: options.runId,
      attemptId: "review-bootstrap-attempt",
      cwd,
      target: { type: "uncommitted-changes" },
      existingSession: null,
      bootstrapModel: { providerId: "codex", modelId: "gpt-review" },
      bootstrapReasoningEffort: "high",
      sandboxPolicy: "read-only",
      paths: options.paths,
      timeoutMs: options.timeoutMs,
    })).resolves.toMatchObject({ status: "completed" });

    expect(server.threadParams).toEqual([expect.objectContaining({
      model: "gpt-review",
      cwd,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      config: {
        "features.request_permissions_tool": true,
        model_reasoning_effort: "high",
      },
    })]);
    expect(server.reviewParams).toEqual([
      { threadId: "thread-main", target: { type: "uncommittedChanges" }, delivery: "inline" },
    ]);
  });

  it("registers Review as stoppable but never steerable", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4056, false);
    server.holdNextReview();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "review-control", "thread-main");
    const review = runCodexReview({
      providerId: "codex",
      projectId: options.projectId,
      conversationId: options.conversationId,
      graphScopeId: "review-graph",
      runtimeScopeId: options.runtimeScopeId,
      runId: options.runId,
      attemptId: "review-control-attempt",
      cwd,
      target: { type: "uncommitted-changes" },
      existingSession: { providerId: "codex", sessionId: "thread-main" },
      bootstrapModel: null,
      bootstrapReasoningEffort: null,
      sandboxPolicy: "read-only",
      paths: options.paths,
      timeoutMs: options.timeoutMs,
    });
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());
    const active = getActiveCodexAppServerTurn(options.runtimeScopeId)!;
    expect(active.turnKind).toBe("review");
    await expect(active.steer("change scope")).rejects.toMatchObject({ name: "ProviderSteerRejected" });
    await expect(active.interrupt("user stop")).resolves.toEqual({ status: "interrupt-requested" });
    await expect(review).resolves.toMatchObject({ status: "interrupted" });
    expect(server.interruptParams).toEqual([{ threadId: "thread-main", turnId: "turn-main-1" }]);
  });

  it("classifies an unproven Review timeout as transport-uncertain", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4057, false);
    server.holdNextReview();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "review-uncertain", "thread-main");

    await expect(runCodexReview({
      providerId: "codex",
      projectId: options.projectId,
      conversationId: options.conversationId,
      graphScopeId: "review-graph",
      runtimeScopeId: options.runtimeScopeId,
      runId: options.runId,
      attemptId: "review-uncertain-attempt",
      cwd,
      target: { type: "uncommitted-changes" },
      existingSession: { providerId: "codex", sessionId: "thread-main" },
      bootstrapModel: null,
      bootstrapReasoningEffort: null,
      sandboxPolicy: "read-only",
      paths: options.paths,
      timeoutMs: 20,
    })).rejects.toMatchObject({ name: "ProviderReviewTransportUncertain" });
  });

  it("maps turn/completed with a failed nested Turn status to a failed result", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4053, false);
    server.failNextTurn("controlled upstream failure");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const realtimeEvents: CodexAppServerRealtimeEvent[] = [];

    const result = await runCodexAppServerTurn({
      ...await turnOptions(cwd, "failed-turn-run", null),
      onRealtimeEvent: (event) => realtimeEvents.push(event),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("controlled upstream failure");
    expect(realtimeEvents.at(-1)?.streamEvent).toMatchObject({
      type: "error",
      message: "controlled upstream failure",
    });
  });

  it("initializes one process and continues the exact native Child on the same generation", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4101, true);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    let resolveInitialChild!: () => void;
    const initialChild = new Promise<void>((resolve) => { resolveInitialChild = resolve; });
    const mainEvents: string[] = [];
    let mainText = "";
    const firstPromise = runCodexAppServerTurn({
      ...await turnOptions(cwd, "main-run", null),
      onRealtimeEvent: (event) => mainEvents.push(`${event.threadId}:${event.turnId}`),
      onTextDelta: (text) => { mainText += text; },
      onChildThreadResult: (child) => { if (child.threadId === "thread-hume" && child.finalText) resolveInitialChild(); },
    });
    await initialChild;
    const mainEventCountBeforeFollowup = mainEvents.length;
    const mainTextBeforeFollowup = mainText;
    expect(defaultCodexAppServerHostRegistry.snapshots()).toEqual([
      expect.objectContaining({ state: "busy", generation: 1, pid: 4101 }),
    ]);

    const childEvents: string[] = [];
    const second = await runCodexAppServerChildTurn({
      ...await turnOptions(cwd, "feedback-run", "thread-main"),
      parentThreadId: "thread-main",
      targetThreadId: "thread-hume",
      targetDisplayName: "Hume",
      prompt: "Read line three.",
      onRealtimeEvent: (event) => childEvents.push(event.threadId),
    });

    expect(second.status).toBe("completed");
    expect(second.host).toEqual(expect.objectContaining({ generation: 1, pid: 4101 }));
    expect(second.childThreads).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "thread-hume", finalText: "Follow-up complete." }),
    ]));
    expect(new Set(childEvents)).toContain("thread-hume");
    expect(mainEvents).toHaveLength(mainEventCountBeforeFollowup + 1);
    expect(mainText).toBe(mainTextBeforeFollowup);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(server.methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(server.followupPrompts).toEqual([expect.stringContaining("Read line three.")]);
    const first = await firstPromise;
    expect(first.status).toBe("completed");
    expect(first.host).toEqual(second.host);
    const activeClose = await runCodexAppServerChildClose({
      ...await turnOptions(cwd, "active-close-run", "thread-main"),
      parentThreadId: "thread-main",
      targetThreadId: "thread-hume",
      targetDisplayName: "Hume",
    });
    expect(activeClose.status).toBe("completed");
    expect(activeClose.host).toEqual(second.host);
  });

  it("continues the exact native Child after the parent Turn is already idle", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4151);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const first = await runCodexAppServerTurn(await turnOptions(cwd, "idle-main-run", null));
    expect(first.status).toBe("completed");

    const followup = await runCodexAppServerChildTurn({
      ...await turnOptions(cwd, "idle-feedback-run", "thread-main"),
      parentThreadId: "thread-main",
      targetThreadId: "thread-hume",
      targetDisplayName: "Hume",
      prompt: "Continue after Main is idle.",
      model: "gpt-test",
      reasoningEffort: "high",
    });

    expect(followup.error).toBeUndefined();
    expect(followup.status).toBe("completed");
    expect(followup.host).toEqual(first.host);
    expect(followup.childThreads).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "thread-hume", finalText: "Follow-up complete." }),
    ]));
    expect(JSON.parse(await readFile(join(cwd, "idle-feedback-run", "session.json"), "utf8"))).toEqual(
      expect.objectContaining({ host: expect.objectContaining({ generation: 1, pid: 4151 }) }),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(server.methods.filter((method) => method === "initialize")).toHaveLength(1);
    expect(server.turnParams[1]).toMatchObject({ model: "gpt-test", effort: "high" });
  });

  it("rejects concurrent leases and invalidates Child bindings after a crashed generation", async () => {
    const cwd = await tempDir();
    const firstServer = new PersistentCollaborationServer(4201);
    const secondServer = new PersistentCollaborationServer(4202);
    spawnMock.mockReturnValueOnce(firstServer as unknown as ChildProcess).mockReturnValueOnce(secondServer as unknown as ChildProcess);
    const host = new CodexAppServerHost(cwd);
    const exits: string[] = [];
    const auxiliaryExits: string[] = [];
    const lease = await host.acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: (error) => exits.push(error.message) });
    lease.bindChild("thread-main", "thread-hume");
    lease.bindChild("thread-main", "thread-darwin");
    lease.setActiveTurn("thread-main", "turn-main-active");
    host.acquireActiveChildControl("thread-main", "thread-hume", { onLine: () => undefined, onStderr: () => undefined, onExit: (error) => auxiliaryExits.push(error.message) });
    expect(() => host.acquireActiveChildControl("thread-main", "thread-darwin", { onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined }))
      .toThrow("already controlling a Child Agent");
    await expect(host.acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined }))
      .rejects.toThrow("already executing a Turn");
    firstServer.crash();
    await vi.waitFor(() => expect(exits).toEqual([expect.stringContaining("exited with 17")]));
    expect(auxiliaryExits).toEqual([expect.stringContaining("exited with 17")]);

    const restarted = await host.acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined });
    expect(restarted.generation).toBe(2);
    expect(restarted.pid).toBe(4202);
    expect(() => restarted.assertChild("thread-main", "thread-hume")).toThrow("not available");
    restarted.release();
    await host.dispose("test cleanup");
  });

  it("closes the exact native Child and rejects later continuation without another process", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4301);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    expect((await runCodexAppServerTurn(await turnOptions(cwd, "main-run", null))).status).toBe("completed");

    const closed = await runCodexAppServerChildClose({
      ...await turnOptions(cwd, "close-run", "thread-main"),
      parentThreadId: "thread-main",
      targetThreadId: "thread-hume",
      targetDisplayName: "Hume",
    });
    expect(closed.status).toBe("completed");
    expect(closed.host).toEqual(expect.objectContaining({ generation: 1, pid: 4301 }));
    expect(defaultCodexAppServerHostRegistry.snapshots()[0]).toMatchObject({ childBindingCount: 0 });

    const lifecycleKinds: string[] = [];
    const repeated = await runCodexAppServerChildClose({
      ...await turnOptions(cwd, "close-repeat-run", "thread-main"),
      parentThreadId: "thread-main",
      targetThreadId: "thread-hume",
      targetDisplayName: "Hume",
      onChildLifecycleEvent: (event) => lifecycleKinds.push(event.kind),
    });
    expect(repeated.status).toBe("completed");
    expect(repeated.host).toEqual(closed.host);
    expect(lifecycleKinds).toEqual(["closed"]);

    const conflictingParent = await runCodexAppServerChildClose({
      ...await turnOptions(cwd, "close-conflict-run", "thread-other-parent"),
      parentThreadId: "thread-other-parent",
      targetThreadId: "thread-hume",
      targetDisplayName: "Hume",
    });
    expect(conflictingParent.status).toBe("failed");
    expect(conflictingParent.error).toContain("conflicting parent lineage");

    const rejected = await runCodexAppServerChildTurn({
      ...await turnOptions(cwd, "rejected-run", "thread-main"),
      parentThreadId: "thread-main",
      targetThreadId: "thread-hume",
      prompt: "This must not run.",
    });
    expect(rejected.status).toBe("failed");
    expect(rejected.error).toContain("not available");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(server.closePrompts).toHaveLength(1);
  });

  it("isolates different project directories in independent Host generations", async () => {
    const firstCwd = await tempDir();
    const secondCwd = await tempDir();
    const firstServer = new PersistentCollaborationServer(4401);
    const secondServer = new PersistentCollaborationServer(4402);
    spawnMock.mockReturnValueOnce(firstServer as unknown as ChildProcess).mockReturnValueOnce(secondServer as unknown as ChildProcess);
    const registry = new CodexAppServerHostRegistry();
    const [first, second] = await Promise.all([
      registry.hostFor(firstCwd).acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined }),
      registry.hostFor(secondCwd).acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined }),
    ]);
    expect(first).toMatchObject({ generation: 1, pid: 4401 });
    expect(second).toMatchObject({ generation: 1, pid: 4402 });
    expect(first.hostId).not.toBe(second.hostId);
    first.release();
    second.release();
    await registry.disposeAll("test cleanup");
  });

  it("retains Provider liveness until every terminated Host confirms OS process exit", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4421);
    server.holdProcessExitOnKill();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const registry = new CodexAppServerHostRegistry();
    await registry.hostFor(cwd)
      .acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined });

    let completed = false;
    const shutdown = registry.disposeAll("update shutdown", 2_000).then(() => { completed = true; });
    await vi.waitFor(() => expect(server.killCount).toBe(1));
    expect(completed).toBe(false);
    expect(registry.liveProcessCount()).toBe(1);

    server.confirmProcessExit();
    await shutdown;
    expect(completed).toBe(true);
    expect(registry.liveProcessCount()).toBe(0);
  });

  it("fails shutdown when a terminated Host does not confirm OS process exit by the deadline", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4422);
    server.holdProcessExitOnKill();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const registry = new CodexAppServerHostRegistry();
    const lease = await registry.hostFor(cwd)
      .acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined });
    lease.release();

    await expect(registry.disposeAll("update shutdown", 10)).rejects.toThrow("did not confirm process exit");
    expect(registry.liveProcessCount()).toBe(1);
    await expect(registry.disposeAll("update shutdown retry", 10)).rejects.toThrow("did not confirm process exit");
    expect(registry.liveProcessCount()).toBe(1);
    server.confirmProcessExit();
    await vi.waitFor(() => expect(registry.liveProcessCount()).toBe(0));
  });

  it("stops and drains every canonical and worktree Host owned by one project", async () => {
    const canonicalCwd = await tempDir();
    const firstWorktree = await tempDir();
    const otherProjectCwd = await tempDir();
    const canonicalServer = new PersistentCollaborationServer(4451);
    const worktreeServer = new PersistentCollaborationServer(4452);
    const otherServer = new PersistentCollaborationServer(4453);
    spawnMock
      .mockReturnValueOnce(canonicalServer as unknown as ChildProcess)
      .mockReturnValueOnce(worktreeServer as unknown as ChildProcess)
      .mockReturnValueOnce(otherServer as unknown as ChildProcess);
    const registry = new CodexAppServerHostRegistry();
    const canonicalLease = await registry.hostForProject("project-one", canonicalCwd)
      .acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined });
    const worktreeLease = await registry.hostForProject("project-one", firstWorktree)
      .acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined });
    const otherLease = await registry.hostForProject("project-two", otherProjectCwd)
      .acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined });

    let drained = false;
    const shutdown = registry.disposeProject("project-one", "project removed").then(() => { drained = true; });
    await Promise.resolve();
    expect(canonicalServer.killCount).toBe(1);
    expect(worktreeServer.killCount).toBe(1);
    expect(otherServer.killCount).toBe(0);
    expect(drained).toBe(false);

    canonicalLease.release();
    expect(drained).toBe(false);
    worktreeLease.release();
    await shutdown;
    expect(drained).toBe(true);
    expect(registry.snapshots()).toEqual([expect.objectContaining({ cwd: otherProjectCwd })]);

    otherLease.release();
    await registry.disposeAll("test cleanup");
  });

  it("runs model discovery without taking or disposing the active Turn lease", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4501);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const host = defaultCodexAppServerHostRegistry.hostFor(cwd);
    const lease = await host.acquire({ onLine: () => undefined, onStderr: () => undefined, onExit: () => undefined });

    await expect(listCodexRuntimeModels(cwd)).resolves.toMatchObject({ available: true, degraded: false });
    expect(host.snapshot()).toMatchObject({ state: "busy", generation: 1, pid: 4501 });
    expect(server.killCount).toBe(0);
    lease.release();
  });

  it("sends exact context compact wire input and releases lifecycle metadata after completion", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4521);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const events: string[] = [];

    await expect(compactCodexContext({
      providerId: "codex",
      projectId: "project-host",
      cwd,
      session: { providerId: "codex", sessionId: "thread-main" },
      onContextEvent: (event) => {
        if (event.type === "compaction") events.push(`${event.itemId}:${event.phase}`);
      },
    })).resolves.toEqual({ status: "accepted" });
    await vi.waitFor(() => expect(events).toEqual(["compact-item-1:started", "compact-item-1:completed"]));
    expect(server.compactParams).toEqual([{ threadId: "thread-main" }]);
    expect(server.threadParams).toContainEqual({ threadId: "thread-main" });
    expect(server.methods.indexOf("thread/resume")).toBeLessThan(server.methods.indexOf("thread/compact/start"));

    server.sendCompaction("compact-after-release");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["compact-item-1:started", "compact-item-1:completed"]);
  });

  it("maps provider-neutral session archive and restore to exact Codex thread methods", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4522);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const base = {
      providerId: "codex" as const,
      projectId: "project-host",
      cwd,
      session: { providerId: "codex" as const, sessionId: "thread-main" },
    };

    await expect(setCodexSessionArchived({ ...base, archived: true })).resolves.toEqual({ status: "completed" });
    await expect(setCodexSessionArchived({ ...base, archived: false })).resolves.toEqual({ status: "completed" });
    expect(server.archiveParams).toEqual([{ threadId: "thread-main" }]);
    expect(server.unarchiveParams).toEqual([{ threadId: "thread-main" }]);
    expect(server.methods.filter((method) => method === "thread/archive" || method === "thread/unarchive"))
      .toEqual(["thread/archive", "thread/unarchive"]);
  });

  it("does not settle session archive from a notification for another Codex thread", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4523);
    server.misdirectNextArchiveNotification();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const outcome = setCodexSessionArchived({
      providerId: "codex",
      projectId: "project-host",
      cwd,
      session: { providerId: "codex", sessionId: "thread-main" },
      archived: true,
    });
    await expect(outcome).rejects.toThrow("exited");
  });

  it("classifies an explicit pre-Turn thread resume rejection as a stale Provider session", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4054, false);
    server.rejectNextResume("thread is no longer available");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const base = await turnOptions(cwd, "stale-session-run", "thread-main");

    const result = await runCodexTurn({
      ...base,
      providerId: "codex",
      operationProfile: "agent",
      attemptId: "attempt-stale-session",
      existingSession: { providerId: "codex", sessionId: "thread-main" },
    });

    expect(result).toMatchObject({ status: "failed", failureKind: "stale-session" });
    expect(server.methods).toContain("thread/resume");
    expect(server.methods).not.toContain("turn/start");
  });

  it("forks, rolls back, and verifies one exact anchor without exposing Codex identity in the public request", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4520);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    await expect(forkCodexSession({
      providerId: "codex",
      projectId: "project-host",
      cwd,
      sourceSession: { providerId: "codex", sessionId: "thread-main" },
      anchorTurn: { providerId: "codex", sessionId: "thread-main", turnId: "turn-history-2" },
    })).resolves.toEqual({
      session: { providerId: "codex", sessionId: "thread-fork" },
      inheritedThroughTurn: { providerId: "codex", sessionId: "thread-fork", turnId: "turn-history-2" },
    });
    expect(server.methods.filter((method) => ["thread/resume", "thread/read", "thread/fork", "thread/rollback"].includes(method)))
      .toEqual(["thread/resume", "thread/read", "thread/fork", "thread/rollback", "thread/read"]);
    expect(server.forkParams).toEqual([{ threadId: "thread-main", cwd, threadSource: "user" }]);
    expect(server.rollbackParams).toEqual([{ threadId: "thread-fork", numTurns: 1 }]);
    expect(server.archiveParams).toEqual([]);
  });

  it("reports the provider-neutral stage when child creation times out", async () => {
    vi.useFakeTimers();
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4521);
    server.holdNextForkResponse();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const outcome = forkCodexSession({
      providerId: "codex",
      projectId: "project-host",
      cwd,
      sourceSession: { providerId: "codex", sessionId: "thread-main" },
      anchorTurn: { providerId: "codex", sessionId: "thread-main", turnId: "turn-history-2" },
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(server.methods).toContain("thread/fork");
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(outcome).resolves.toMatchObject({
      name: "ProviderSessionForkTransportUncertain",
      stage: "child-create",
      timeoutMs: 30_000,
    });
    expect(server.archiveParams).toEqual([]);
  });

  it("holds the Host lease until compaction completes and blocks a concurrent Turn", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4522);
    server.holdNextCompaction();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    await expect(compactCodexContext({
      providerId: "codex",
      projectId: "project-host",
      cwd,
      session: { providerId: "codex", sessionId: "thread-main" },
    })).resolves.toEqual({ status: "accepted" });
    expect(defaultCodexAppServerHostRegistry.hostFor(cwd).snapshot().state).toBe("busy");

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(defaultCodexAppServerHostRegistry.hostFor(cwd).snapshot().state).toBe("busy");

    await expect(runCodexAppServerTurn(await turnOptions(cwd, "concurrent-turn", "thread-main")))
      .resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining("already executing a Turn"),
      });
    expect(server.methods.filter((method) => method === "turn/start")).toHaveLength(0);

    server.completeHeldCompaction();
    await vi.advanceTimersByTimeAsync(0);
    expect(defaultCodexAppServerHostRegistry.hostFor(cwd).snapshot().state).toBe("healthy");
  });

  it("redacts Provider-private JSON-RPC rejection details", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4523);
    server.rejectNextCompact("thread-main private-provider-secret");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    await expect(compactCodexContext({
      providerId: "codex",
      projectId: "project-host",
      cwd,
      session: { providerId: "codex", sessionId: "thread-main" },
    })).rejects.toMatchObject({
      name: "ProviderContextCompactRejected",
      message: "Provider rejected context compaction.",
    });
  });

  it("drops provider callbacks from a generation invalidated by project removal", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4551, true);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const realtimeEvents: string[] = [];
    const base = await turnOptions(cwd, "generation-guard-run", null);
    const turn = runCodexTurn({
      ...base,
      providerId: "codex",
      operationProfile: "main",
      attemptId: "attempt-generation-guard",
      onRealtimeEvent: (event) => realtimeEvents.push(`${event.threadId}:${event.turnId}`),
    });
    await vi.waitFor(() => expect(realtimeEvents.length).toBeGreaterThan(0));
    const eventCountBeforeRemoval = realtimeEvents.length;

    const removalGeneration = defaultProjectRemovalFence.beginRemoval(base.projectId);
    try {
      server.completeParent();
      await expect(turn).resolves.toMatchObject({ status: "completed" });
      expect(realtimeEvents).toHaveLength(eventCountBeforeRemoval);
    } finally {
      defaultProjectRemovalFence.completeRemoval(base.projectId, removalGeneration);
      defaultProjectRemovalFence.activateAfterRegistration(base.projectId);
    }
  });

  it("publishes one started identity and sends an exact turn interrupt wire request", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4561, true);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "interrupt-wire-run", null);
    const started: Array<{ threadId: string; turnId: string }> = [];
    const turn = runCodexAppServerTurn({
      ...options,
      onTurnStarted: (identity) => started.push(identity),
    });
    await vi.waitFor(() => expect(started).toEqual([{ threadId: "thread-main", turnId: "turn-main-1" }]));
    const active = getActiveCodexAppServerTurn(options.runtimeScopeId);
    expect(active).not.toBeNull();

    await expect(active!.interrupt("user stop")).resolves.toEqual({ status: "interrupt-requested" });
    await expect(turn).resolves.toMatchObject({ status: "interrupted", threadId: "thread-main", turnId: "turn-main-1" });
    expect(server.interruptParams).toEqual([{ threadId: "thread-main", turnId: "turn-main-1" }]);
    expect(started).toHaveLength(1);
  });

  it("sends exact turn steer input and classifies an explicit rejection as retryable", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4567, true);
    server.rejectNextSteer("turn cannot accept steering");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "steer-wire-run", null);
    const turn = runCodexAppServerTurn(options);
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());

    const active = getActiveCodexAppServerTurn(options.runtimeScopeId)!;
    await expect(active.steer("first steer")).rejects.toMatchObject({
      name: "ProviderSteerRejected",
      message: "turn cannot accept steering",
    });
    await expect(active.steer("retry steer")).resolves.toBeUndefined();
    await expect(turn).resolves.toMatchObject({ status: "completed" });
    expect(server.steerParams).toEqual([
      {
        threadId: "thread-main",
        expectedTurnId: "turn-main-1",
        input: [{ type: "text", text: "first steer", text_elements: [] }],
      },
      {
        threadId: "thread-main",
        expectedTurnId: "turn-main-1",
        input: [{ type: "text", text: "retry steer", text_elements: [] }],
      },
    ]);
  });

  it("classifies an explicit interrupt error response as a retryable Provider rejection", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4562, true);
    server.rejectNextInterrupt("turn is not interruptible");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "interrupt-rejection-run", null);
    const turn = runCodexAppServerTurn(options);
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());

    const active = getActiveCodexAppServerTurn(options.runtimeScopeId)!;
    await expect(active.interrupt("user stop")).rejects.toMatchObject({
      name: "ProviderInterruptRejected",
      message: "turn is not interruptible",
    });
    expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull();

    await expect(active.interrupt("retry user stop")).resolves.toEqual({ status: "interrupt-requested" });
    await expect(turn).resolves.toMatchObject({ status: "interrupted" });
    expect(server.interruptParams).toEqual([
      { threadId: "thread-main", turnId: "turn-main-1" },
      { threadId: "thread-main", turnId: "turn-main-1" },
    ]);
  });

  it("bounds an explicit interrupt rejection message", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4564, true);
    server.rejectNextInterrupt(`rejected\n${"x".repeat(800)}`);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "interrupt-bounded-rejection-run", null);
    const turn = runCodexAppServerTurn(options);
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());

    const active = getActiveCodexAppServerTurn(options.runtimeScopeId)!;
    let failure: Error | null = null;
    try {
      await active.interrupt("user stop");
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toMatchObject({ name: "ProviderInterruptRejected" });
    expect(failure?.message).toHaveLength(500);
    expect(failure?.message).not.toContain("\n");

    await active.interrupt("retry user stop");
    await expect(turn).resolves.toMatchObject({ status: "interrupted" });
  });

  it("keeps an interrupt connection loss classified as an uncertain transport failure", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4563, true);
    server.crashOnNextInterrupt();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "interrupt-uncertain-run", null);
    const turn = runCodexAppServerTurn(options);
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());

    const active = getActiveCodexAppServerTurn(options.runtimeScopeId)!;
    const interruption = active.interrupt("user stop");
    await expect(interruption).rejects.not.toMatchObject({ name: "ProviderInterruptRejected" });
    await expect(turn).resolves.toMatchObject({
      status: "failed",
      error: "Codex app-server Host exited with 17.",
    });
  });

  it("bounds an interrupt whose JSON-RPC response never arrives and ignores a late response", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4565, true);
    server.holdNextInterruptResponse();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "interrupt-timeout-run", null);
    const turn = runCodexAppServerTurn(options);
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());

    vi.useFakeTimers();
    const interruption = getActiveCodexAppServerTurn(options.runtimeScopeId)!.interrupt("user stop");
    const timeoutAssertion = expect(interruption).rejects.toMatchObject({
      name: "CodexAppServerRequestTimeout",
      method: "turn/interrupt",
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await timeoutAssertion;

    server.respondToHeldInterrupt();
    server.completeParent();
    await vi.advanceTimersByTimeAsync(100);
    await expect(turn).resolves.toMatchObject({ status: "completed" });
    expect(server.interruptParams).toEqual([{ threadId: "thread-main", turnId: "turn-main-1" }]);
  });

  it("settles an interrupt when the exact Turn becomes terminal before its JSON-RPC response", async () => {
    const cwd = await tempDir();
    const server = new PersistentCollaborationServer(4566, true);
    server.holdNextInterruptResponse();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const options = await turnOptions(cwd, "interrupt-terminal-race-run", null);
    const turn = runCodexAppServerTurn(options);
    await vi.waitFor(() => expect(getActiveCodexAppServerTurn(options.runtimeScopeId)).not.toBeNull());

    const interruption = getActiveCodexAppServerTurn(options.runtimeScopeId)!.interrupt("user stop");
    server.completeParent();

    await expect(interruption).resolves.toEqual({ status: "already-terminal" });
    await expect(turn).resolves.toMatchObject({ status: "completed" });
    server.respondToHeldInterrupt();
    expect(server.interruptParams).toEqual([{ threadId: "thread-main", turnId: "turn-main-1" }]);
  });
});

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "aho-codex-host-"));
  tempDirs.push(path);
  return path;
}

async function turnOptions(cwd: string, runId: string, existingThreadId: string | null) {
  const runDir = join(cwd, runId);
  return {
    projectId: "project-host",
    conversationId: "conversation-host",
    runtimeScopeId: `${runId}:scope`,
    roleId: "main-agent",
    runId,
    cwd,
    prompt: "Create Hume once.",
    sandboxPolicy: "read-only" as const,
    paths: {
      events: join(runDir, "events.jsonl"),
      stderr: join(runDir, "stderr.log"),
      lastMessage: join(runDir, "last-message.md"),
      session: join(runDir, "session.json"),
    },
    existingThreadId,
    timeoutMs: 10_000,
  };
}

class PersistentCollaborationServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly methods: string[] = [];
  readonly followupPrompts: string[] = [];
  readonly closePrompts: string[] = [];
  readonly turnInputs: unknown[][] = [];
  readonly turnParams: Array<Record<string, unknown>> = [];
  readonly reviewParams: Array<Record<string, unknown>> = [];
  readonly threadParams: Array<Record<string, unknown>> = [];
  readonly steerParams: Array<Record<string, unknown>> = [];
  readonly compactParams: Array<Record<string, unknown>> = [];
  readonly archiveParams: Array<Record<string, unknown>> = [];
  readonly unarchiveParams: Array<Record<string, unknown>> = [];
  readonly forkParams: Array<Record<string, unknown>> = [];
  readonly rollbackParams: Array<Record<string, unknown>> = [];
  readonly interruptParams: Array<{ threadId: string; turnId: string }> = [];
  readonly serverResponses: Array<{ id: number; result: Record<string, unknown> }> = [];
  readonly pid: number;
  killCount = 0;
  private input = "";
  private turnCount = 0;
  private nextInterruptError: string | null = null;
  private nextSteerError: string | null = null;
  private crashInterrupt = false;
  private holdInterruptResponse = false;
  private heldInterruptId: number | null = null;
  private nextTurnFailure: string | null = null;
  private holdCompaction = false;
  private heldCompactionItemId: string | null = null;
  private nextCompactError: string | null = null;
  private nextResumeError: string | null = null;
  private holdFork = false;
  private holdReview = false;
  private holdProcessExit = false;
  private processExitConfirmed = false;
  private misdirectArchiveNotification = false;
  private forkTurns = ["turn-history-1", "turn-history-2", "turn-history-3"];

  constructor(
    pid: number,
    private readonly holdFirstParent = false,
    private readonly managedPathLeak?: string,
  ) {
    super();
    this.pid = pid;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += chunk.toString();
        this.drain();
        callback();
      },
    });
  }

  kill(): boolean {
    this.killCount += 1;
    this.stdout.end();
    this.stderr.end();
    if (!this.holdProcessExit) queueMicrotask(() => this.confirmProcessExit());
    return true;
  }

  holdProcessExitOnKill(): void {
    this.holdProcessExit = true;
  }

  confirmProcessExit(): void {
    if (this.processExitConfirmed) return;
    this.processExitConfirmed = true;
    this.emit("close", 0);
  }

  crash(): void {
    this.emit("close", 17);
  }

  completeParent(): void {
    this.notify("turn/completed", { threadId: "thread-main", turn: { id: "turn-main-1", status: "completed" } });
  }

  failNextTurn(message: string): void {
    this.nextTurnFailure = message;
  }

  sendApproval(id: number, method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  resolveApproval(requestId: string, threadId: string): void {
    this.notify("serverRequest/resolved", { requestId, threadId });
  }

  sendCompaction(itemId: string): void {
    this.notify("item/started", { threadId: "thread-main", item: { id: itemId, type: "contextCompaction" } });
    this.notify("item/completed", { threadId: "thread-main", item: { id: itemId, type: "contextCompaction", status: "completed" } });
  }

  holdNextCompaction(): void {
    this.holdCompaction = true;
  }

  completeHeldCompaction(): void {
    if (!this.heldCompactionItemId) throw new Error("No held context compaction is available.");
    const itemId = this.heldCompactionItemId;
    this.heldCompactionItemId = null;
    this.notify("item/completed", { threadId: "thread-main", item: { id: itemId, type: "contextCompaction", status: "completed" } });
  }

  rejectNextCompact(message: string): void {
    this.nextCompactError = message;
  }

  rejectNextResume(message: string): void {
    this.nextResumeError = message;
  }

  misdirectNextArchiveNotification(): void {
    this.misdirectArchiveNotification = true;
  }

  holdNextForkResponse(): void {
    this.holdFork = true;
  }

  holdNextReview(): void {
    this.holdReview = true;
  }

  rejectNextInterrupt(message: string): void {
    this.nextInterruptError = message;
  }

  rejectNextSteer(message: string): void {
    this.nextSteerError = message;
  }

  crashOnNextInterrupt(): void {
    this.crashInterrupt = true;
  }

  holdNextInterruptResponse(): void {
    this.holdInterruptResponse = true;
  }

  respondToHeldInterrupt(): void {
    if (this.heldInterruptId === null) throw new Error("No held interrupt response is available.");
    const id = this.heldInterruptId;
    this.heldInterruptId = null;
    this.respond(id, {});
  }

  private drain(): void {
    for (;;) {
      const newline = this.input.indexOf("\n");
      if (newline < 0) return;
      const line = this.input.slice(0, newline).trim();
      this.input = this.input.slice(newline + 1);
      if (line) this.handle(JSON.parse(line) as Record<string, unknown>);
    }
  }

  private handle(message: Record<string, unknown>): void {
    if (typeof message.method !== "string" || typeof message.id !== "number") {
      if (typeof message.id === "number" && isTestRecord(message.result)) {
        this.serverResponses.push({ id: message.id, result: message.result });
      }
      return;
    }
    const id = message.id;
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.methods.push(message.method);
    switch (message.method) {
      case "initialize":
        this.respond(id, {});
        return;
      case "model/list":
        this.respond(id, { data: [{ id: "gpt-test", displayName: "GPT Test" }] });
        return;
      case "thread/start":
      case "thread/resume":
        this.threadParams.push({ ...params });
        if (message.method === "thread/resume" && this.nextResumeError) {
          const resumeError = this.nextResumeError;
          this.nextResumeError = null;
          this.reject(id, { code: -32000, message: resumeError });
          return;
        }
        this.respond(id, { thread: { id: "thread-main", status: { type: "idle" }, turns: this.forkTurns.map((turnId) => ({ id: turnId })) } });
        return;
      case "thread/fork":
        this.forkParams.push({ ...params });
        if (this.holdFork) {
          this.holdFork = false;
          return;
        }
        this.respond(id, { thread: { id: "thread-fork", status: { type: "idle" }, turns: this.forkTurns.map((turnId) => ({ id: turnId })) } });
        return;
      case "thread/rollback":
        this.rollbackParams.push({ ...params });
        this.forkTurns = this.forkTurns.slice(0, -Number(params.numTurns ?? 0));
        this.respond(id, { thread: { id: String(params.threadId), status: { type: "idle" }, turns: this.forkTurns.map((turnId) => ({ id: turnId })) } });
        return;
      case "turn/start": {
        this.turnCount += 1;
        const turnId = `turn-main-${this.turnCount}`;
        const turnInput = Array.isArray(params.input) ? params.input : [];
        this.turnParams.push({ ...params });
        this.turnInputs.push(turnInput);
        const prompt = JSON.stringify(turnInput);
        this.respond(id, { turn: { id: turnId } });
        this.notify("turn/started", { threadId: "thread-main", turn: { id: turnId } });
        if (this.nextTurnFailure) {
          const message = this.nextTurnFailure;
          this.nextTurnFailure = null;
          this.notify("turn/completed", {
            threadId: "thread-main",
            turn: { id: turnId, status: "failed", error: { message } },
          });
          return;
        }
        if (this.managedPathLeak) {
          const alternateManagedPath = this.managedPathLeak.replace(/\\/g, "/").toUpperCase();
          this.notify("item/completed", {
            threadId: "thread-main",
            turnId,
            item: {
              id: "managed-path-command",
              type: "commandExecution",
              command: `Get-Content ${alternateManagedPath}`,
              cwd: dirname(this.managedPathLeak).replace(/\\/g, "/").toUpperCase(),
              aggregatedOutput: `storagePath=${alternateManagedPath}\nAHO_ATTACHMENT_PRIVATE_TEXT`,
              raw: { error: `failed to read ${alternateManagedPath}` },
              exitCode: 0,
            },
          });
        }
        if (this.turnCount === 1) {
          this.notify("item/completed", {
            threadId: "thread-main",
            turnId,
            item: { id: "spawn-hume", type: "subAgentActivity", kind: "started", agentThreadId: "thread-hume", agentPath: "/root/hume" },
          });
        } else {
          this.followupPrompts.push(prompt);
          this.notify("item/completed", {
            threadId: "thread-main",
            turnId,
            item: { id: `interacted-${this.turnCount}`, type: "subAgentActivity", kind: "interacted", agentThreadId: "thread-hume", agentPath: "/root/hume" },
          });
        }
        this.notify("turn/completed", { threadId: "thread-hume", turn: { id: `turn-hume-${this.turnCount}`, status: "completed" } });
        if (!this.holdFirstParent || this.turnCount > 1) {
          this.notify("turn/completed", { threadId: "thread-main", turn: { id: turnId, status: "completed" } });
        }
        return;
      }
      case "review/start": {
        this.turnCount += 1;
        const turnId = `turn-main-${this.turnCount}`;
        this.reviewParams.push({ ...params });
        this.respond(id, { turn: { id: turnId } });
        this.notify("turn/started", { threadId: "thread-main", turn: { id: turnId } });
        this.notify("item/started", {
          threadId: "thread-main",
          turnId,
          item: { id: `review-entered-${this.turnCount}`, type: "enteredReviewMode" },
        });
        if (this.holdReview) {
          this.holdReview = false;
          return;
        }
        this.notify("item/completed", {
          threadId: "thread-main",
          turnId,
          item: { id: `review-exited-${this.turnCount}`, type: "exitedReviewMode", text: "Review result." },
        });
        this.notify("turn/completed", { threadId: "thread-main", turn: { id: turnId, status: "completed" } });
        return;
      }
      case "thread/compact/start":
        this.compactParams.push({ ...params });
        if (this.nextCompactError) {
          const message = this.nextCompactError;
          this.nextCompactError = null;
          this.reject(id, { code: -32000, message });
          return;
        }
        this.respond(id, {});
        if (this.holdCompaction) {
          this.holdCompaction = false;
          this.heldCompactionItemId = "compact-item-1";
          this.notify("item/started", { threadId: "thread-main", item: { id: "compact-item-1", type: "contextCompaction" } });
        } else {
          this.sendCompaction("compact-item-1");
        }
        return;
      case "thread/unarchive":
        this.unarchiveParams.push({ ...params });
        this.respond(id, { thread: { id: String(params.threadId), status: { type: "idle" }, turns: [] } });
        this.notify("thread/unarchived", { threadId: String(params.threadId) });
        return;
      case "turn/steer": {
        this.steerParams.push({ ...params });
        if (this.nextSteerError) {
          const message = this.nextSteerError;
          this.nextSteerError = null;
          this.reject(id, { code: -32000, message });
          return;
        }
        const prompt = JSON.stringify(params.input ?? []);
        this.respond(id, {});
        this.followupPrompts.push(prompt);
        this.notify("item/completed", {
          threadId: "thread-main",
          turnId: "turn-main-1",
          item: { id: "interacted-other", type: "subAgentActivity", kind: "interacted", agentThreadId: "thread-other", agentPath: "/root/other" },
        });
        this.notify("item/completed", {
          threadId: "thread-main",
          turnId: "turn-main-1",
          item: { id: "interacted-hume", type: "subAgentActivity", kind: "interacted", agentThreadId: "thread-hume", agentPath: "/root/hume" },
        });
        this.notify("turn/completed", { threadId: "thread-hume", turn: { id: "turn-hume-followup", status: "completed" } });
        this.notify("item/completed", {
          threadId: "thread-main",
          turnId: "turn-main-1",
          item: { id: "parent-marker", type: "agentMessage", text: "AHO_CHILD_FOLLOWUP_COMPLETE", phase: "final_answer" },
        });
        this.notify("turn/completed", { threadId: "thread-main", turn: { id: "turn-main-1", status: "completed" } });
        return;
      }
      case "turn/interrupt":
        this.interruptParams.push({ threadId: String(params.threadId), turnId: String(params.turnId) });
        if (this.holdInterruptResponse) {
          this.holdInterruptResponse = false;
          this.heldInterruptId = id;
          return;
        }
        if (this.crashInterrupt) {
          this.crashInterrupt = false;
          queueMicrotask(() => this.crash());
          return;
        }
        if (this.nextInterruptError) {
          const message = this.nextInterruptError;
          this.nextInterruptError = null;
          this.reject(id, { code: -32000, message });
          return;
        }
        this.respond(id, {});
        this.notify("turn/completed", { threadId: String(params.threadId), turn: { id: String(params.turnId), status: "interrupted" } });
        return;
      case "thread/archive":
        this.archiveParams.push({ ...params });
        this.closePrompts.push(JSON.stringify(params));
        if (this.misdirectArchiveNotification) {
          this.misdirectArchiveNotification = false;
          this.respond(id, {});
          this.notify("thread/archived", { threadId: "thread-other" });
          queueMicrotask(() => this.crash());
          return;
        }
        this.notify("thread/archived", { threadId: String(params.threadId) });
        this.respond(id, {});
        return;
      case "thread/read":
        if (params.threadId === "thread-main" || params.threadId === "thread-fork") {
          this.respond(id, { thread: { id: String(params.threadId), status: { type: "idle" }, turns: this.forkTurns.map((turnId) => ({ id: turnId })) } });
          return;
        }
        this.respond(id, { thread: {
          id: "thread-hume",
          agentNickname: "Hume",
          turns: [
            { id: "turn-delegation", items: [{ id: "input-hume", type: "userMessage", content: [{ type: "input_text", text: "Initial task." }] }] },
            { id: this.followupPrompts.length ? "turn-hume-followup" : `turn-hume-${this.turnCount}`, items: [{ id: `output-hume-${this.turnCount}`, type: "agentMessage", content: [{ type: "output_text", text: this.followupPrompts.length ? "Follow-up complete." : "Initial Hume response." }] }] },
          ],
        } });
        return;
      default:
        throw new Error(`Unexpected Host test method: ${message.method}`);
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  private reject(id: number, error: Record<string, unknown>): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, error })}\n`));
  }

  private notify(method: string, params: Record<string, unknown>): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ method, params })}\n`));
  }
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
