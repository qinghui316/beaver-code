import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => Object.assign(vi.fn(), {
  sync: vi.fn((_: string, args: string[]) => args[0] === "--version"
    ? { status: 0, stdout: "codex-cli 0.154.0\n", stderr: "", error: undefined }
    : { status: 0, stdout: "--listen stdio://\n", stderr: "", error: undefined }),
}));
vi.mock("cross-spawn", () => ({ default: spawnMock }));

import { getActiveCodexAppServerTurn, runCodexAppServerTurn, type CodexAppServerThreadGoal } from "../../src/codex/app-server.js";

const tempDirs: string[] = [];

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.sync.mockClear();
});
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex native Goal lifecycle", () => {
  it("reads a real spawned planner child result before completing the parent turn", async () => {
    const server = new FakePlannerChildAppServer();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const observed: string[] = [];
    const initialInputs: string[] = [];
    const parentLifecycle: string[] = [];
    const resolvedRequests: string[] = [];
    const realtimeEvents: Array<{ threadId: string; roleId: string; displayName?: string }> = [];

    const result = await runCodexAppServerTurn(await options({
      existingThreadId: null,
      goalSession: false,
      enableDefaultModeUserInput: true,
      dynamicTools: [
        { name: "aho_goal_yield", description: "Yield", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        { name: "aho_accept_current_plan", description: "Accept", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      ],
      onChildThreadResult: (child) => {
        if (child.finalText) observed.push(child.finalText);
        if (child.initialUserItem) initialInputs.push(child.initialUserItem.text);
      },
      onUserInputResolved: (resolution) => resolvedRequests.push(resolution.requestId),
      onRealtimeEvent: (event) => realtimeEvents.push(event),
      onNotification: (notification) => {
        if (notification.method === "turn/completed") parentLifecycle.push(String(notification.params.threadId));
      },
    }));

    expect(result.status).toBe("completed");
    expect(result.childThreads).toEqual([expect.objectContaining({
      parentThreadId: "thread-parent",
      threadId: "thread-planner",
      roleHint: "planning-agent",
      displayName: "Feynman",
      finalText: '{"specMd":"# Spec","planMd":"# Plan","tasksMd":"# Tasks"}',
    })]);
    expect(observed).toEqual(['{"specMd":"# Spec","planMd":"# Plan","tasksMd":"# Tasks"}']);
    expect(new Set(initialInputs)).toEqual(new Set(["Draft the project plan."]));
    expect(parentLifecycle).toEqual(["thread-parent"]);
    expect(resolvedRequests).toEqual(["77"]);
    expect(server.methods).toContain("thread/read");
    expect(realtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "thread-planner", roleId: "planning-agent" }),
    ]));
    expect(server.threadStartParams.dynamicTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "aho_goal_yield" }),
      expect.objectContaining({ name: "aho_accept_current_plan" }),
    ]));
    expect(server.threadStartParams.config).toEqual({ "features.default_mode_request_user_input": true });
    expect(server.methods.filter((method) => method === "thread/goal/set")).toHaveLength(0);
  });

  it("retries child thread/read until the provider-native initial input is visible", async () => {
    const server = new FakePlannerChildAppServer(["aho-main-orchestration", "aho-workflow-authoring"], 1, 250);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const observed: Array<{ status?: string; input?: string }> = [];

    await runCodexAppServerTurn(await options({
      existingThreadId: null,
      goalSession: false,
      onChildThreadResult: (child) => observed.push({ status: child.status, input: child.initialUserItem?.text }),
    }));

    expect(observed).toEqual(expect.arrayContaining([
      { status: "running", input: "Draft the project plan." },
    ]));
    expect(server.methods.filter((method) => method === "thread/read").length).toBeGreaterThanOrEqual(2);
  });

  it("does not emit running child input after a terminal read claims the same item", async () => {
    const server = new FakePlannerChildAppServer(["aho-main-orchestration", "aho-workflow-authoring"], 0, 0, 200);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const observed: Array<{ status?: string; input?: string }> = [];

    await runCodexAppServerTurn(await options({
      existingThreadId: null,
      goalSession: false,
      onChildThreadResult: (child) => {
        if (child.initialUserItem) observed.push({ status: child.status, input: child.initialUserItem.text });
      },
    }));

    expect(observed).toEqual([{ status: "completed", input: "Draft the project plan." }]);
  });

  it("registers native Skills before starting a turn and carries workspace facts as protocol input", async () => {
    const server = new FakePlannerChildAppServer();
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({
      existingThreadId: null,
      goalSession: false,
      prompt: "请根据项目现状判断下一步。",
      nativeSkillRoots: ["C:/aho/templates/system-skills"],
      requiredNativeSkills: ["aho-main-orchestration"],
      skillInputs: [{
        name: "aho-main-orchestration",
        path: "C:/aho/templates/system-skills/aho-main-orchestration/SKILL.md",
      }],
      runtimeWorkspaceRoots: ["C:/project", "C:/memory", "C:/proposal"],
      additionalContext: {
        "aho.project": { kind: "application", value: JSON.stringify({ projectRoot: "C:/project", memoryRoot: "C:/memory" }) },
      },
    }));

    expect(result.status).toBe("completed");
    expect(server.methods.slice(0, 3)).toEqual(["initialize", "skills/extraRoots/set", "skills/list"]);
    expect(server.extraRoots).toEqual(["C:/aho/templates/system-skills"]);
    expect(server.skillsListParams).toMatchObject({ cwds: [expect.any(String)], forceReload: true });
    expect(server.threadStartParams.runtimeWorkspaceRoots).toEqual(["C:/project", "C:/memory", "C:/proposal"]);
    expect(server.turnStartParams.additionalContext).toMatchObject({
      "aho.project": { kind: "application" },
    });
    expect(server.turnStartParams.input).toEqual(expect.arrayContaining([
      { type: "text", text: "请根据项目现状判断下一步。", text_elements: [] },
      { type: "skill", name: "aho-main-orchestration", path: "C:/aho/templates/system-skills/aho-main-orchestration/SKILL.md" },
    ]));
    expect(JSON.stringify(server.turnStartParams.input)).not.toContain("请加载 Skill");
  });

  it("fails in Chinese when the provider cannot discover a required native Skill", async () => {
    const server = new FakePlannerChildAppServer(["unrelated-skill"]);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({
      existingThreadId: null,
      goalSession: false,
      nativeSkillRoots: ["C:/aho/templates/system-skills"],
      requiredNativeSkills: ["aho-main-orchestration"],
    }));

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Codex 原生 Skill 不可用：未发现需要的 Skill：aho-main-orchestration");
    expect(server.methods).toEqual(["initialize", "skills/extraRoots/set", "skills/list"]);
  });

  it("injects evidence once, resumes without turn/start, and pauses only after the yield turn is terminal", async () => {
    const server = new FakeGoalAppServer("paused");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({
      goalResume: { deliveryKey: "action-1:evidence-1", contextText: "canonical evidence" },
      onDynamicToolCall: async () => ({
        contentItems: [{ type: "inputText", text: "current gate" }],
        success: true,
        yieldAfterResponse: true,
      }),
    }));

    expect(result).toMatchObject({ status: "interrupted", goal: { status: "paused" } });
    expect(server.methods).toEqual([
      "initialize",
      "thread/goal/get",
      "thread/resume",
      "thread/read",
      "thread/inject_items",
      "thread/goal/set",
      "thread/goal/get",
      "turn/interrupt",
      "thread/goal/get",
      "thread/goal/set",
    ]);
    expect(server.methods).not.toContain("turn/start");
    expect(server.injectedItems).toHaveLength(1);
    expect(JSON.stringify(server.injectedItems[0])).toContain("canonical evidence");
    expect(server.events).toEqual(expect.arrayContaining([
      "dynamic-tool-response",
      "turn-interrupted",
      "goal-paused",
    ]));
    expect(server.events.indexOf("dynamic-tool-response")).toBeLessThan(server.events.indexOf("turn-interrupted"));
    expect(server.events.indexOf("turn-interrupted")).toBeLessThan(server.events.indexOf("goal-paused"));
  });

  it("resumes a blocked Goal through the same idempotent evidence path", async () => {
    const server = new FakeGoalAppServer("blocked");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({
      goalResume: { deliveryKey: "action-blocked:evidence-blocked", contextText: "blocked canonical evidence" },
      onDynamicToolCall: yieldToolResult,
    }));

    expect(result).toMatchObject({ status: "interrupted", goal: { status: "paused" } });
    expect(server.methods).toEqual(expect.arrayContaining(["thread/read", "thread/inject_items", "thread/goal/set"]));
    expect(server.methods).not.toContain("turn/start");
    expect(server.injectedItems).toHaveLength(1);
  });

  it("returns without competing injection when action evidence observes an already active Goal", async () => {
    const server = new FakeGoalAppServer("active");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({
      goalResume: { deliveryKey: "duplicate-active", contextText: "late duplicate evidence" },
    }));

    expect(result).toMatchObject({ status: "completed", goal: { status: "active" } });
    expect(server.methods).toContain("thread/resume");
    expect(server.methods).not.toEqual(expect.arrayContaining(["thread/inject_items", "thread/goal/set", "turn/start"]));
  });

  it("waits for the parent turn terminal before returning a blocked Goal and final message", async () => {
    const server = new FakeGoalAppServer("active", [], "blocked");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    let settled = false;
    const resultPromise = runCodexAppServerTurn(await options({})).finally(() => {
      settled = true;
    });
    await waitForServerEvent(server, "goal-blocked");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    server.completeBlockedTurn();
    const result = await resultPromise;

    expect(result).toMatchObject({ status: "completed", goal: { status: "blocked" } });
    expect(result.lastMessage).toContain("Waiting for external confirmation.");
    expect(server.events.indexOf("goal-blocked")).toBeLessThan(server.events.indexOf("turn-completed"));
  });

  it("fails immediately when an active session receives an unknown Goal status notification", async () => {
    const server = new FakeGoalAppServer("active", [], "unknown");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({ timeoutMs: 60_000 }));

    expect(result).toMatchObject({
      status: "failed",
      error: "Unsupported Codex native Goal status: providerFutureStatus.",
    });
  });

  it.each(["usageLimited", "budgetLimited", "complete"] as const)("does not resume a %s Goal", async (status) => {
    const server = new FakeGoalAppServer(status);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({
      goalResume: { deliveryKey: "action-2:evidence-2", contextText: "late evidence" },
    }));

    expect(result).toMatchObject({ status: "completed", goal: { status } });
    expect(server.methods).toEqual(["initialize", "thread/goal/get"]);
    expect(server.injectedItems).toHaveLength(0);
  });

  it("fails immediately when the provider reports an unknown Goal status", async () => {
    const server = new FakeGoalAppServer("providerFutureStatus");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({ timeoutMs: 60_000 }));

    expect(result).toMatchObject({
      status: "failed",
      error: "Unsupported Codex native Goal status: providerFutureStatus.",
    });
    expect(server.methods).toEqual(["initialize", "thread/goal/get"]);
  });

  it("does not inject duplicate action evidence already present in thread history", async () => {
    const first = new FakeGoalAppServer("paused");
    spawnMock.mockReturnValue(first as unknown as ChildProcess);
    const resume = { deliveryKey: "action-3:evidence-3", contextText: "same canonical evidence" };
    await runCodexAppServerTurn(await options({
      goalResume: resume,
      onDynamicToolCall: yieldToolResult,
    }));

    const retry = new FakeGoalAppServer("paused", first.injectedItems);
    spawnMock.mockReturnValue(retry as unknown as ChildProcess);
    await runCodexAppServerTurn(await options({
      goalResume: resume,
      onDynamicToolCall: yieldToolResult,
    }));

    expect(first.injectedItems).toHaveLength(1);
    expect(retry.injectedItems).toHaveLength(0);
    expect(retry.methods).not.toContain("thread/inject_items");
  });

  it("delivers an ordinary user message without activating the paused Goal", async () => {
    const server = new FakeGoalAppServer("paused");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({
      prompt: "Revise the accepted plan before continuing.",
    }));

    expect(result).toMatchObject({ status: "completed", goal: { status: "paused" } });
    expect(server.methods).toContain("thread/goal/get");
    expect(server.methods).toContain("turn/start");
    expect(server.methods).not.toContain("thread/goal/set");
    expect(server.methods).not.toContain("thread/inject_items");
  });

  it("keeps resumed-session history out of the new canonical realtime turn", async () => {
    const server = new FakeGoalAppServer("paused", [], "tool", true);
    spawnMock.mockReturnValue(server as unknown as ChildProcess);
    const realtime: Array<{ turnId?: string; streamEvent: { type: string; [key: string]: unknown } }> = [];
    const deltas: string[] = [];

    const result = await runCodexAppServerTurn(await options({
      prompt: "Inspect the current page.",
      onRealtimeEvent: (event) => realtime.push(event),
      onTextDelta: (delta) => deltas.push(delta),
    }));

    expect(result).toMatchObject({ status: "completed", turnId: "turn-user" });
    expect(deltas.join("")).toBe("");
    expect(realtime.some((event) => event.turnId === "turn-old")).toBe(false);
    expect(realtime).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "turn-user", streamEvent: expect.objectContaining({ type: "status", label: "thinking" }) }),
    ]));
  });

  it("delivers an ordinary user message without activating the blocked Goal", async () => {
    const server = new FakeGoalAppServer("blocked");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const result = await runCodexAppServerTurn(await options({ prompt: "Review the blocker without continuing the Goal." }));

    expect(result).toMatchObject({ status: "completed", goal: { status: "blocked" } });
    expect(server.methods).toContain("turn/start");
    expect(server.methods).not.toContain("thread/goal/set");
    expect(server.methods).not.toContain("thread/inject_items");
  });

  it("confirms the native Goal paused when the user interrupts the active turn", async () => {
    const server = new FakeGoalAppServer("active");
    spawnMock.mockReturnValue(server as unknown as ChildProcess);

    const resultPromise = runCodexAppServerTurn(await options({}));
    const activeTurn = await waitForActiveTurn("change-1");
    await activeTurn.interrupt("User cancelled the current Goal.");
    const result = await resultPromise;

    expect(result).toMatchObject({ status: "interrupted", goal: { status: "paused" } });
    expect(server.events).toEqual(expect.arrayContaining(["turn-interrupted", "goal-paused"]));
    expect(server.events.indexOf("turn-interrupted")).toBeLessThan(server.events.indexOf("goal-paused"));
  });
});

async function waitForActiveTurn(changeId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const activeTurn = getActiveCodexAppServerTurn(changeId);
    if (activeTurn) return activeTurn;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Codex app-server test turn did not become active.");
}

async function waitForServerEvent(server: FakeGoalAppServer, event: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (server.events.includes(event)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Fake app-server event did not occur: ${event}.`);
}

async function yieldToolResult() {
  return {
    contentItems: [{ type: "inputText" as const, text: "current gate" }],
    success: true,
    yieldAfterResponse: true,
  };
}

async function options(overrides: Partial<Parameters<typeof runCodexAppServerTurn>[0]>) {
  const root = await mkdtemp(join(tmpdir(), "aho-native-goal-test-"));
  tempDirs.push(root);
  return {
    projectId: "project-1",
    changeId: "change-1",
    roleId: "main-agent",
    runId: "run-1",
    cwd: root,
    prompt: "continue",
    sandboxPolicy: "read-only" as const,
    existingThreadId: "thread-1",
    timeoutMs: 5_000,
    goalSession: true,
    paths: {
      events: join(root, "events.jsonl"),
      stderr: join(root, "stderr.log"),
      lastMessage: join(root, "last-message.txt"),
      session: join(root, "session.json"),
    },
    ...overrides,
  };
}

class FakeGoalAppServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly methods: string[] = [];
  readonly events: string[] = [];
  readonly injectedItems: unknown[] = [];
  readonly stdin: Writable;
  private input = "";
  private goal: CodexAppServerThreadGoal;
  private readonly history: unknown[];

  constructor(
    status: CodexAppServerThreadGoal["status"] | string,
    history: unknown[] = [],
    private readonly activeOutcome: "tool" | "blocked" | "unknown" = "tool",
    private readonly replayCompletedTurn = false,
  ) {
    super();
    this.goal = {
      threadId: "thread-1",
      objective: "Finish the accepted Change",
      status: status as CodexAppServerThreadGoal["status"],
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 1,
      createdAt: 100,
      updatedAt: 100,
    };
    this.history = history;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += chunk.toString();
        this.drain();
        callback();
      },
    });
  }

  kill(): boolean {
    this.stdout.end();
    this.stderr.end();
    return true;
  }

  completeBlockedTurn(): void {
    this.events.push("turn-completed");
    this.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
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
    if (typeof message.method !== "string") {
      if (message.id === 900) {
        this.events.push("dynamic-tool-response");
        this.notify("item/completed", { item: { type: "dynamicToolCall", callId: "call-1" } });
      }
      return;
    }
    const id = message.id as number | undefined;
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (id === undefined) return;
    this.methods.push(message.method);
    switch (message.method) {
      case "initialize":
        this.respond(id, {});
        return;
      case "thread/goal/get":
        this.respond(id, { goal: this.goal });
        return;
      case "thread/resume":
        if (this.replayCompletedTurn) {
          this.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-old", status: "inProgress" } });
          this.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-old", delta: "stale history" });
          this.notify("item/completed", {
            threadId: "thread-1",
            turnId: "turn-old",
            item: { id: "old-command", type: "commandExecution", command: "old command", exitCode: 0 },
          });
          this.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-old", status: "completed" } });
        }
        this.respond(id, { thread: { id: "thread-1" } });
        if (this.goal.status === "active") {
          this.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } });
          if (this.activeOutcome === "blocked") {
            this.goal = { ...this.goal, status: "blocked", updatedAt: this.goal.updatedAt + 1 };
            this.events.push("goal-blocked");
            this.notify("thread/goal/updated", { threadId: "thread-1", goal: this.goal });
            this.notify("item/completed", { item: { type: "agentMessage", text: "Waiting for external confirmation." } });
          } else if (this.activeOutcome === "unknown") {
            const unknownGoal = { ...this.goal, status: "providerFutureStatus", updatedAt: this.goal.updatedAt + 1 };
            this.notify("thread/goal/updated", { threadId: "thread-1", goal: unknownGoal });
          } else {
            this.requestTool();
          }
        } else {
          this.notify("thread/goal/updated", { threadId: "thread-1", goal: this.goal });
        }
        return;
      case "thread/read":
        this.respond(id, { thread: { id: "thread-1", turns: this.history } });
        return;
      case "thread/inject_items":
        this.injectedItems.push(...((params.items as unknown[]) ?? []));
        this.respond(id, {});
        return;
      case "thread/goal/set": {
        const status = params.status as CodexAppServerThreadGoal["status"];
        this.goal = { ...this.goal, status, updatedAt: this.goal.updatedAt + 1 };
        this.respond(id, { goal: this.goal });
        this.notify("thread/goal/updated", { threadId: "thread-1", goal: this.goal });
        if (status === "active") {
          this.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } });
          this.requestTool();
        }
        if (status === "paused") {
          this.events.push("goal-paused");
        }
        return;
      }
      case "turn/start":
        this.respond(id, { turn: { id: "turn-user" } });
        this.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-user", status: "inProgress" } });
        this.notify("item/completed", { item: { type: "agentMessage", text: "I will revise the plan first." } });
        this.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-user", status: "completed" } });
        return;
      case "turn/interrupt":
        this.respond(id, {});
        this.events.push("turn-interrupted");
        this.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } });
        return;
      default:
        throw new Error(`Unexpected app-server method ${message.method}`);
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  private notify(method: string, params: Record<string, unknown>): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ method, params })}\n`));
  }

  private requestTool(): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({
      id: 900,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "aho_goal_yield",
        arguments: {},
      },
    })}\n`));
  }
}

class FakePlannerChildAppServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly methods: string[] = [];
  readonly stdin: Writable;
  readonly extraRoots: unknown[] = [];
  readonly skillsListParams: Record<string, unknown> = {};
  readonly threadStartParams: Record<string, unknown> = {};
  readonly turnStartParams: Record<string, unknown> = {};
  private input = "";
  private childReadCount = 0;

  constructor(
    private readonly discoveredSkills = ["aho-main-orchestration", "aho-workflow-authoring"],
    private readonly delayedInitialInputReads = 0,
    private readonly childTerminalDelayMs = 0,
    private readonly firstChildReadResponseDelayMs = 0,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += chunk.toString();
        this.drain();
        callback();
      },
    });
  }

  kill(): boolean {
    this.stdout.end();
    this.stderr.end();
    return true;
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
    if (typeof message.method !== "string" || typeof message.id !== "number") return;
    const id = message.id;
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.methods.push(message.method);
    switch (message.method) {
      case "initialize":
        this.respond(id, {});
        return;
      case "skills/extraRoots/set":
        this.extraRoots.push(...((params.extraRoots as unknown[]) ?? []));
        this.respond(id, {});
        return;
      case "skills/list":
        Object.assign(this.skillsListParams, params);
        this.respond(id, {
          data: [{
            cwd: params.cwds,
            skills: this.discoveredSkills.map((name) => ({ name })),
          }],
        });
        return;
      case "thread/start":
        Object.assign(this.threadStartParams, params);
        this.respond(id, { thread: { id: "thread-parent" } });
        return;
      case "turn/start":
        Object.assign(this.turnStartParams, params);
        this.respond(id, { turn: { id: "turn-parent" } });
        this.notify("turn/started", { threadId: "thread-parent", turn: { id: "turn-parent" } });
        this.notify("serverRequest/resolved", { threadId: "thread-parent", requestId: 77 });
        this.notify("item/completed", {
          item: {
            type: "subAgentActivity",
            id: "collab-plan",
            kind: "started",
            agentThreadId: "thread-planner",
            agentPath: "/root/planning_agent",
          },
          threadId: "thread-parent",
        });
        this.notify("item/agentMessage/delta", { threadId: "thread-planner", delta: "child output must not leak" });
        if (this.childTerminalDelayMs > 0) {
          setTimeout(() => {
            this.notify("turn/completed", { threadId: "thread-planner", turn: { id: "turn-planner", status: "completed" } });
            this.notify("turn/completed", { threadId: "thread-parent", turn: { id: "turn-parent", status: "completed" } });
          }, this.childTerminalDelayMs);
        } else {
          this.notify("turn/completed", { threadId: "thread-planner", turn: { id: "turn-planner", status: "completed" } });
          this.notify("turn/completed", { threadId: "thread-parent", turn: { id: "turn-parent", status: "completed" } });
        }
        return;
      case "thread/read": {
        this.childReadCount += 1;
        const childSnapshot = {
          thread: {
            id: "thread-planner",
            agentNickname: "Feynman",
            turns: [
              ...(this.childReadCount > this.delayedInitialInputReads ? [{ id: "turn-delegation", items: [{
                id: "item-child-input",
                type: "userMessage",
                role: "user",
                content: [{ type: "input_text", text: "Draft the project plan." }],
              }] }] : []),
              { id: "turn-planner", items: [{
                id: "item-child-output",
                type: "agentMessage",
                role: "assistant",
                content: [{ type: "output_text", text: '{"specMd":"# Spec","planMd":"# Plan","tasksMd":"# Tasks"}' }],
              }] },
            ],
          },
        };
        if (this.childReadCount === 1 && this.firstChildReadResponseDelayMs > 0) {
          setTimeout(() => this.respond(id, childSnapshot), this.firstChildReadResponseDelayMs);
        } else {
          this.respond(id, childSnapshot);
        }
        return;
      }
      default:
        throw new Error(`Unexpected app-server method ${message.method}`);
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id, result })}\n`));
  }

  private notify(method: string, params: Record<string, unknown>): void {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ method, params })}\n`));
  }
}
