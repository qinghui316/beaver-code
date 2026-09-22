import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach } from "vitest";
import { defaultProviderRegistry } from "../../src/provider-runtime/default-registry.js";
import { resetCodexRuntimeForTests, resolveCodexRuntime } from "../../src/codex/executable.js";
import type { ManagedProject } from "../../src/types/index.js";
import type { WorkbenchDecisionAction } from "../../src/workbench/read-model-types.js";

let tempDir: string;
export const execFileAsync = promisify(execFile);

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "aho-skill-native-workbench-"));
});

afterEach(async () => {
  await defaultProviderRegistry.shutdownAll("Skill-native Workbench fixture cleanup.");
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

export function getTempDir(): string {
  return tempDir;
}

export function project(path = tempDir): ManagedProject {
  return {
    id: "repo",
    name: "Repo",
    path,
    addedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    defaultProviderId: "codex",
  };
}

export function findSchedulerGateAction(
  actions: WorkbenchDecisionAction[],
  concreteActionType: WorkbenchDecisionAction["actionType"],
  predicate: (action: WorkbenchDecisionAction) => boolean,
): WorkbenchDecisionAction | undefined {
  return actions.find((action) => action.actionType === concreteActionType && predicate(action));
}

export function unwrapWorkflowActionResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  return typeof record.actionRunId === "string" && "result" in record ? record.result : result;
}

export async function initGitRepository(cwd: string): Promise<void> {
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test User"]);
}

export async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

export async function createFakeCodex(
  options: { mutateOnExec?: boolean; message?: string } = {},
): Promise<{ binDir: string; executable: string }> {
  const binDir = join(tempDir, "fake-codex-bin");
  await mkdir(binDir, { recursive: true });
  const script = join(binDir, "fake-codex.cjs");
  const mutateOnExec = options.mutateOnExec ?? true;
  const message = options.message ?? "fake scheduler coder done";
  await writeFile(script, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const appServerIndex = args.indexOf("app-server");
const mutateOnExec = ${JSON.stringify(mutateOnExec)};
const message = ${JSON.stringify(message)};
if (args[0] === "--version") {
  console.log("codex-cli fake");
  process.exit(0);
}
if (appServerIndex >= 0 && args.includes("--help")) {
  console.log("Codex app server\\n--listen <stdio://>");
  process.exit(0);
}
if (args[0] === "--help") {
  console.log("Usage: codex [OPTIONS]\\n--ask-for-approval <APPROVAL_POLICY>");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  console.log("Usage: codex exec [OPTIONS]\\n--json\\n--sandbox <SANDBOX_MODE>\\n--cd <DIR>\\n--output-last-message <FILE>\\n--ask-for-approval <APPROVAL_POLICY>");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "resume" && args[2] === "--help") {
  console.log("Usage: codex exec resume [OPTIONS]\\n--sandbox <SANDBOX_MODE>\\n--cd <DIR>");
  process.exit(0);
}
if (appServerIndex >= 0) {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin });
  let appCwd = process.cwd();
  let threadSequence = 0;
  let threadId = "thread-scheduler-fake-" + process.pid + "-0";
  let turnSequence = 0;
  const reply = (id, result) => console.log(JSON.stringify({ id, result }));
  const reject = (id, method) => console.log(JSON.stringify({
    id,
    error: { code: -32601, message: "Unsupported fake Codex RPC method: " + method },
  }));
  rl.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize" || request.method === "skills/extraRoots/set") {
      reply(request.id, {});
    } else if (request.method === "initialized") {
      // JSON-RPC notifications do not have an id and must not receive a response.
    } else if (request.method === "skills/list") {
      const requestedCwd = Array.isArray(request.params && request.params.cwds)
        ? request.params.cwds[0]
        : appCwd;
      reply(request.id, { data: [{ cwd: requestedCwd, skills: [], errors: [] }] });
    } else if (request.method === "model/list") {
      reply(request.id, { data: [{ id: "fake-model", model: "fake-model", displayName: "Fake Model" }] });
    } else if (request.method === "collaborationMode/list") {
      reply(request.id, { data: [{ name: "Plan", mode: "plan", model: "fake-model", reasoning_effort: null }] });
    } else if (request.method === "thread/start" || request.method === "thread/resume") {
      appCwd = request.params.cwd || appCwd;
      if (request.method === "thread/start") threadId = "thread-scheduler-fake-" + process.pid + "-" + (++threadSequence);
      else if (request.params.threadId) threadId = request.params.threadId;
      reply(request.id, { thread: { id: threadId } });
    } else if (request.method === "turn/start") {
      appCwd = request.params.cwd || appCwd;
      const turnId = "turn-scheduler-fake-" + process.pid + "-" + (++turnSequence);
      const requestText = JSON.stringify(request.params);
      const isAudit = requestText.includes("Auditor Agent Profile") || requestText.includes("Authoritative Audit Packet");
      const responseText = isAudit
        ? "Status: approved\\n\\nFinding: Scheduler worker audit passed."
        : message;
      if (mutateOnExec && !isAudit) fs.appendFileSync(path.join(appCwd, "README.md"), "\\nScheduler worker fake coder\\n", "utf8");
      reply(request.id, { turn: { id: turnId } });
      setImmediate(() => {
        console.log(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } }));
        console.log(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item: { id: "message-scheduler-fake-" + process.pid + "-" + turnSequence, type: "agentMessage", text: responseText } } }));
        console.log(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }));
      });
    } else if (request.id !== undefined && request.id !== null) {
      reject(request.id, request.method);
    } else {
      console.error("Unsupported fake Codex RPC notification: " + request.method);
      process.exitCode = 1;
      rl.close();
    }
  });
} else if (args[0] === "exec" || args.includes("exec")) {
  const prompt = fs.readFileSync(0, "utf8");
  const lastMessageIndex = args.indexOf("--output-last-message");
  const lastMessagePath = lastMessageIndex >= 0 ? args[lastMessageIndex + 1] : null;
  const cwdIndex = args.indexOf("--cd");
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
  if (prompt.includes("Auditor Agent Profile") || prompt.includes("Authoritative Audit Packet")) {
    const auditMessage = "Status: approved\\n\\nFinding: Scheduler worker audit passed.";
    if (lastMessagePath) fs.writeFileSync(lastMessagePath, auditMessage, "utf8");
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: auditMessage } }));
    process.exit(0);
  }
  if (mutateOnExec) fs.appendFileSync(path.join(cwd, "README.md"), "\\nScheduler worker fake coder\\n", "utf8");
  if (lastMessagePath) fs.writeFileSync(lastMessagePath, message, "utf8");
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: message } }));
  process.exit(0);
} else {
  console.error("Unsupported fake codex command: " + args.join(" "));
  process.exit(1);
}
`, "utf8");
  await chmod(script, 0o755).catch(() => undefined);
  const commandShim = process.platform === "win32" ? join(binDir, "codex.cmd") : join(binDir, "codex");
  const shim = process.platform === "win32"
    ? `@echo off\r\nnode "${script}" %*\r\n`
    : `#!/usr/bin/env sh\nnode "${script}" "$@"\n`;
  await writeFile(commandShim, shim, "utf8");
  await chmod(commandShim, 0o755).catch(() => undefined);
  return { binDir, executable: commandShim };
}

export function assertFakeCodexSelected(fakeCodex: { executable: string }): void {
  const selected = resolveCodexRuntime();
  if (selected.source !== "explicit-override" || selected.command !== fakeCodex.executable) {
    throw new Error(`Scheduler fixture selected ${JSON.stringify(selected)} instead of ${fakeCodex.executable}.`);
  }
}

export function enterFakeCodexScope(fakeCodex: { binDir: string; executable: string }): () => Promise<void> {
  const originalPath = process.env.PATH;
  const originalCodexBin = process.env.AHO_CODEX_BIN;
  process.env.PATH = `${fakeCodex.binDir}${delimiter}${originalPath ?? ""}`;
  process.env.AHO_CODEX_BIN = fakeCodex.executable;
  resetCodexRuntimeForTests();
  try {
    assertFakeCodexSelected(fakeCodex);
  } catch (error) {
    restoreEnvironment();
    throw error;
  }
  return async () => {
    try {
      await defaultProviderRegistry.shutdownAll("Scheduler fake Codex scope closed.");
    } finally {
      restoreEnvironment();
    }
  };

  function restoreEnvironment(): void {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCodexBin === undefined) delete process.env.AHO_CODEX_BIN;
    else process.env.AHO_CODEX_BIN = originalCodexBin;
    resetCodexRuntimeForTests();
  }
}
