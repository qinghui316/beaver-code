import crossSpawn from "cross-spawn";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, normalize, resolve } from "node:path";

const CODEX_BIN_ENV = "AHO_CODEX_BIN";

export type CodexRuntimeSource = "explicit-override" | "codex-desktop" | "path";

export interface CodexRuntimeDescriptor {
  command: string;
  version: string;
  source: CodexRuntimeSource;
}

type RuntimeCandidate = {
  command: string;
  source: Exclude<CodexRuntimeSource, "explicit-override">;
};

let cachedRuntime: CodexRuntimeDescriptor | null = null;

export function resolveCodexRuntime(env: NodeJS.ProcessEnv = process.env): CodexRuntimeDescriptor {
  if (env === process.env && cachedRuntime) return cachedRuntime;
  const configured = env[CODEX_BIN_ENV]?.trim();
  if (configured) {
    const selected = probeRequiredRuntime({ command: configured, source: "explicit-override" });
    if (env === process.env) cachedRuntime = selected;
    return selected;
  }

  const compatible = discoverRuntimeCandidates(env)
    .map((candidate) => probeRuntime(candidate))
    .filter((candidate): candidate is CodexRuntimeDescriptor => candidate !== null)
    .sort(compareRuntimeDescriptors);
  const selected = compatible.at(-1);
  if (!selected) throw new Error("No compatible Codex runtime was found on PATH or in the Codex Desktop installation.");
  if (env === process.env) cachedRuntime = selected;
  return selected;
}

export function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return resolveCodexRuntime(env).command;
}

export function codexExecutableEnvironmentKey(): string {
  return CODEX_BIN_ENV;
}

export function resetCodexRuntimeForTests(): void {
  cachedRuntime = null;
}

export function discoverRuntimeCandidates(env: NodeJS.ProcessEnv = process.env): RuntimeCandidate[] {
  const candidates: RuntimeCandidate[] = [];
  const desktopRoot = windowsDesktopRuntimeRoot(env);
  if (desktopRoot) {
    for (const entry of safeDirectoryEntries(desktopRoot)) {
      const command = join(desktopRoot, entry, "codex.exe");
      if (isRegularFile(command)) candidates.push({ command, source: "codex-desktop" });
    }
  }

  for (const directory of splitPath(env.PATH ?? env.Path ?? "")) {
    for (const filename of executableNames(env)) {
      const command = join(directory, filename);
      if (isRegularFile(command)) candidates.push({
        command,
        source: desktopRoot && isWithin(command, desktopRoot) ? "codex-desktop" : "path",
      });
    }
  }
  return deduplicateCandidates(candidates);
}

function probeRequiredRuntime(candidate: RuntimeCandidate | { command: string; source: "explicit-override" }): CodexRuntimeDescriptor {
  const descriptor = probeRuntime(candidate);
  if (descriptor) return descriptor;
  throw new Error(`Configured Codex runtime is unavailable or incompatible: ${candidate.command}`);
}

function probeRuntime(candidate: RuntimeCandidate | { command: string; source: "explicit-override" }): CodexRuntimeDescriptor | null {
  const versionResult = crossSpawn.sync(candidate.command, ["--version"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (versionResult.error || versionResult.status !== 0) return null;
  const version = `${versionResult.stdout ?? ""}${versionResult.stderr ?? ""}`.trim();
  if (!version) return null;

  const appServerResult = crossSpawn.sync(candidate.command, ["app-server", "--help"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 5_000,
  });
  const help = `${appServerResult.stdout ?? ""}${appServerResult.stderr ?? ""}`;
  if (appServerResult.error || appServerResult.status !== 0 || !help.includes("--listen") || !help.includes("stdio://")) return null;
  return { command: candidate.command, version, source: candidate.source };
}

function compareRuntimeDescriptors(left: CodexRuntimeDescriptor, right: CodexRuntimeDescriptor): number {
  const leftVersion = parsedVersion(left.version);
  const rightVersion = parsedVersion(right.version);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftVersion.core[index] - rightVersion.core[index];
    if (difference !== 0) return difference;
  }
  const prereleaseDifference = comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
  if (prereleaseDifference !== 0) return prereleaseDifference;
  if (left.source !== right.source) return left.source === "codex-desktop" ? 1 : -1;
  return normalizeForComparison(left.command).localeCompare(normalizeForComparison(right.command));
}

function parsedVersion(version: string): { core: [number, number, number]; prerelease: string[] | null } {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)(?:-([^\s+]+))?/);
  if (!match) return { core: [0, 0, 0], prerelease: null };
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? null,
  };
}

function comparePrerelease(left: string[] | null, right: string[] | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function windowsDesktopRuntimeRoot(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "win32") return null;
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData ? join(localAppData, "OpenAI", "Codex", "bin") : null;
}

function executableNames(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return ["codex"];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return ["codex", ...extensions.map((extension) => `codex${extension}`)];
}

function splitPath(value: string): string[] {
  return value.split(delimiter).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function safeDirectoryEntries(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function deduplicateCandidates(candidates: RuntimeCandidate[]): RuntimeCandidate[] {
  const unique = new Map<string, RuntimeCandidate>();
  for (const candidate of candidates) {
    const key = canonicalPath(candidate.command);
    const existing = unique.get(key);
    if (!existing || candidate.source === "codex-desktop") unique.set(key, candidate);
  }
  return [...unique.values()];
}

function canonicalPath(path: string): string {
  try {
    return normalizeForComparison(realpathSync.native(path));
  } catch {
    return normalizeForComparison(resolve(path));
  }
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = normalizeForComparison(resolve(path));
  const normalizedRoot = `${normalizeForComparison(resolve(root))}\\`;
  return normalizedPath.startsWith(normalizedRoot);
}

function normalizeForComparison(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}
