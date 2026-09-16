import { executeProcessStreaming } from "../run/process.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolveCodexExecutable, resolveCodexRuntime, type CodexRuntimeSource } from "./executable.js";

export type ApprovalFlagPlacement = "root" | "exec" | "unsupported";

export interface CodexCapabilities {
  available: boolean;
  version: string | null;
  executablePath?: string;
  runtimeSource?: CodexRuntimeSource;
  approvalFlagPlacement: ApprovalFlagPlacement;
  supportsJson: boolean;
  supportsSandbox: boolean;
  supportsCd: boolean;
  supportsAddDir: boolean;
  supportsColor: boolean;
  supportsOutputLastMessage: boolean;
  supportsSafeResume: boolean;
  supportsResumeAddDir: boolean;
  errors: string[];
}

export interface CodexArgv {
  command: string;
  args: string[];
}

export interface CodexArgvOptions {
  projectPath: string;
  lastMessagePath: string;
  model?: string;
  profile?: string;
  additionalReadDirs?: string[];
}

export function codexRuntimeConfigArgs(): string[] {
  return ["-c", 'service_tier="fast"'];
}

export function evaluateCodexCapabilities(versionOutput: string | null, rootHelp: string | null, execHelp: string | null, spawnError?: string, resumeHelp: string | null = null): CodexCapabilities {
  const errors: string[] = [];
  if (spawnError) errors.push(spawnError);

  const available = !spawnError && rootHelp !== null && execHelp !== null;
  const approvalFlagPlacement: ApprovalFlagPlacement =
    includesFlag(execHelp, "--ask-for-approval") ? "exec" :
      includesFlag(rootHelp, "--ask-for-approval") ? "root" :
        "unsupported";

  const supportsJson = includesFlag(execHelp, "--json");
  const supportsSandbox = includesFlag(execHelp, "--sandbox");
  const supportsCd = includesFlag(execHelp, "--cd") || includesFlag(execHelp, "-C, --cd");
  const supportsAddDir = includesFlag(execHelp, "--add-dir");
  const supportsColor = includesFlag(execHelp, "--color");
  const supportsOutputLastMessage = includesFlag(execHelp, "--output-last-message");
  const supportsResumeAddDir = includesFlag(resumeHelp, "--add-dir");
  const supportsSafeResume = includesFlag(resumeHelp, "--sandbox") && (includesFlag(resumeHelp, "--cd") || includesFlag(resumeHelp, "-C, --cd"));

  if (!available) errors.push(`Codex CLI is unavailable at ${resolveCodexExecutable()}.`);
  if (!supportsJson) errors.push("Codex exec does not support --json.");
  if (!supportsSandbox) errors.push("Codex exec does not support --sandbox.");
  if (!supportsCd) errors.push("Codex exec does not support --cd.");

  return {
    available,
    version: versionOutput?.trim() || null,
    approvalFlagPlacement,
    supportsJson,
    supportsSandbox,
    supportsCd,
    supportsAddDir,
    supportsColor,
    supportsOutputLastMessage,
    supportsSafeResume,
    supportsResumeAddDir,
    errors,
  };
}

export async function detectCodexCapabilities(): Promise<CodexCapabilities> {
  let version: string | null = null;
  let rootHelp: string | null = null;
  let execHelp: string | null = null;
  let resumeHelp: string | null = null;
  let spawnError: string | undefined;
  let executablePath: string | undefined;
  let runtimeSource: CodexRuntimeSource | undefined;

  try {
    const runtime = resolveCodexRuntime();
    executablePath = runtime.command;
    runtimeSource = runtime.source;
    version = await captureCodexHelp(["--version"]);
    rootHelp = await captureCodexHelp(["--help"]);
    execHelp = await captureCodexHelp(["exec", "--help"]);
    try {
      resumeHelp = await captureCodexHelp(["exec", "resume", "--help"]);
    } catch {
      resumeHelp = null;
    }
  } catch (error) {
    spawnError = `Failed to inspect Codex CLI: ${(error as Error).message}`;
  }

  return {
    ...evaluateCodexCapabilities(version, rootHelp, execHelp, spawnError, resumeHelp),
    ...(executablePath ? { executablePath } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
  };
}

export function assertCodexSafeToRun(capabilities: CodexCapabilities): void {
  const blocking = capabilities.errors.filter((error) =>
    error.includes("not available") ||
    error.includes("--json") ||
    error.includes("--sandbox") ||
    error.includes("--cd"),
  );
  if (blocking.length > 0) {
    throw new Error(`Codex CLI does not support safe read-only non-interactive execution:\n${blocking.map((item) => `- ${item}`).join("\n")}`);
  }
}

export function buildCodexReadonlyArgv(capabilities: CodexCapabilities, options: CodexArgvOptions): CodexArgv {
  assertCodexSafeToRun(capabilities);

  const args: string[] = [...codexRuntimeConfigArgs()];
  if (capabilities.approvalFlagPlacement === "root") {
    args.push("--ask-for-approval", "never");
  }

  args.push("exec");

  if (capabilities.approvalFlagPlacement === "exec") {
    args.push("--ask-for-approval", "never");
  }

  args.push("--json");
  if (capabilities.supportsColor) args.push("--color", "never");
  args.push("--sandbox", "read-only");
  args.push("--cd", options.projectPath);
  if (capabilities.supportsAddDir) {
    for (const dir of options.additionalReadDirs ?? []) {
      args.push("--add-dir", dir);
    }
  }
  if (capabilities.supportsOutputLastMessage) args.push("--output-last-message", options.lastMessagePath);
  if (options.model) args.push("--model", options.model);
  if (options.profile) args.push("--profile", options.profile);
  args.push("-");

  return { command: resolveCodexExecutable(), args };
}

export function buildCodexReadonlyResumeArgv(capabilities: CodexCapabilities, options: CodexArgvOptions & { sessionId: string }): CodexArgv {
  assertCodexSafeToRun(capabilities);
  if (!capabilities.supportsSafeResume) {
    throw new Error("Codex resume does not expose equivalent read-only sandbox and cwd constraints; use a fresh read-only exec.");
  }
  if ((options.additionalReadDirs?.length ?? 0) > 0 && !capabilities.supportsResumeAddDir) {
    throw new Error("Codex resume does not expose --add-dir for external read-only memory; use a fresh read-only exec.");
  }

  const args: string[] = [...codexRuntimeConfigArgs(), "exec", "resume", "--json", "--sandbox", "read-only", "--cd", options.projectPath];
  if (capabilities.supportsResumeAddDir) {
    for (const dir of options.additionalReadDirs ?? []) {
      args.push("--add-dir", dir);
    }
  }
  if (capabilities.supportsOutputLastMessage) args.push("--output-last-message", options.lastMessagePath);
  if (options.model) args.push("--model", options.model);
  if (options.profile) args.push("--profile", options.profile);
  args.push(options.sessionId, "-");

  return { command: resolveCodexExecutable(), args };
}

export function buildCodexWorkspaceWriteArgv(capabilities: CodexCapabilities, options: CodexArgvOptions): CodexArgv {
  assertCodexSafeToRun(capabilities);

  const args: string[] = [...codexRuntimeConfigArgs()];
  if (capabilities.approvalFlagPlacement === "root") {
    args.push("--ask-for-approval", "never");
  }

  args.push("exec");

  if (capabilities.approvalFlagPlacement === "exec") {
    args.push("--ask-for-approval", "never");
  }

  args.push("--json");
  if (capabilities.supportsColor) args.push("--color", "never");
  args.push("--sandbox", "workspace-write");
  args.push("--cd", options.projectPath);
  if (capabilities.supportsAddDir) {
    for (const dir of options.additionalReadDirs ?? []) {
      args.push("--add-dir", dir);
    }
  }
  if (capabilities.supportsOutputLastMessage) args.push("--output-last-message", options.lastMessagePath);
  if (options.model) args.push("--model", options.model);
  if (options.profile) args.push("--profile", options.profile);
  args.push("-");

  return { command: resolveCodexExecutable(), args };
}

async function captureCodexHelp(args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aho-codex-help-"));
  const stdoutPath = join(dir, "stdout.log");
  const stderrPath = join(dir, "stderr.log");
  try {
    const result = await executeProcessStreaming({
      cwd: process.cwd(),
      command: resolveCodexExecutable(),
      args,
      stdoutPath,
      stderrPath,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderrSample || `codex ${args.join(" ")} exited with ${result.exitCode}`);
    }
    return result.stdoutSample;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function includesFlag(help: string | null, flag: string): boolean {
  return help?.includes(flag) ?? false;
}
