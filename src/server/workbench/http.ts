import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { relative, resolve } from "node:path";
import type { ManagedProject } from "../../types/index.js";
import type { WorkbenchProjectInput } from "../../workbench/read-model-types.js";
import { parseProductMode, type ProductMode } from "../../provider-runtime/index.js";

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch (cause) {
    const error = new Error(`Invalid JSON request body: ${cause instanceof Error ? cause.message : String(cause)}`);
    error.name = "BadRequest";
    throw error;
  }
}

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload, null, 2));
}

export function statusForError(error: unknown): number {
  if (error instanceof Error && error.name === "BadRequest") return 400;
  if (error instanceof Error && error.name === "Conflict") return 409;
  if (error instanceof Error && error.name === "Forbidden") return 403;
  if (error instanceof Error && error.name === "NotFound") return 404;
  return 500;
}

export function assertLocalWorkbenchRequest(request: IncomingMessage): void {
  const host = request.headers.host;
  if (!isLocalHostHeader(host)) {
    const error = new Error("Workbench API requests must target a local host.");
    error.name = "Forbidden";
    throw error;
  }

  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0 && !isAllowedOrigin(origin, host)) {
    const error = new Error("Cross-origin Workbench API request rejected.");
    error.name = "Forbidden";
    throw error;
  }
}

export function assertDesktopSession(request: IncomingMessage, token: string, cookieName = "beaver_code_session"): void {
  const candidate = readCookie(request.headers.cookie, cookieName);
  if (!candidate || !safeTokenEqual(candidate, token)) {
    const error = new Error("Beaver Code session is not authorized.");
    error.name = "Forbidden";
    throw error;
  }
}

export function assertConfirmed(value: unknown): void {
  if (value !== true) {
    const error = new Error("Mutating Workbench project actions require confirm: true.");
    error.name = "Conflict";
    throw error;
  }
}

export function assertDirectProjectInput(input: WorkbenchProjectInput | null): asserts input is WorkbenchProjectInput {
  if (!input) {
    const error = new Error("No project is selected. Use /api/projects/:id/workbench/* or start with `aho workbench serve <project>`.");
    error.name = "BadRequest";
    throw error;
  }
}

export function assertRegisteredProject(input: WorkbenchProjectInput): asserts input is WorkbenchProjectInput & { project: ManagedProject } {
  if (!input.project) throw new Error("This Workbench API requires a registered project.");
}

export function requireChangeId(changeId: string | undefined): string {
  if (typeof changeId === "string" && changeId.trim()) return changeId.trim();
  const error = new Error("changeId is required.");
  error.name = "BadRequest";
  throw error;
}

export function requireProductMode(value: unknown): ProductMode {
  const productMode = parseProductMode(value);
  if (productMode) return productMode;
  const error = new Error("productMode must be agent or harness.");
  error.name = "BadRequest";
  throw error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isWithinDirectory(path: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), path);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(":"));
}

function isAllowedOrigin(origin: string, hostHeader: string | undefined): boolean {
  try {
    const parsed = new URL(origin);
    return isLocalHostname(parsed.hostname) && normalizeHostHeader(parsed.host) === normalizeHostHeader(hostHeader);
  } catch {
    return false;
  }
}

function isLocalHostHeader(hostHeader: string | undefined): boolean {
  const normalized = normalizeHostHeader(hostHeader);
  if (!normalized) return false;
  const hostname = normalized.startsWith("[") ? normalized.slice(1, normalized.indexOf("]")) : normalized.split(":")[0] ?? "";
  return isLocalHostname(hostname);
}

function normalizeHostHeader(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isLocalHostname(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function requireAccessRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    const error = new Error("Access revision is invalid.");
    error.name = "BadRequest";
    throw error;
  }
  return value;
}

export function requireExpectedUpdatedAt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))) return value;
  const error = new Error("Composer draft expectedUpdatedAt must be null or a valid timestamp.");
  error.name = "BadRequest";
  throw error;
}
