import { isDesktopUpdateOffer, isWorkbenchUpdateIdentity, type DesktopUpdateChoice, type DesktopUpdateOffer, type WorkbenchUpdateIdentity } from "../types/workbench-update.js";
import { isDesktopMenuId, isDesktopMenuOpenRequest, type DesktopMenuId, type DesktopMenuOpenRequest } from "../types/desktop-shell.js";

export const DESKTOP_PROTOCOL_VERSION = 4 as const;
export const DESKTOP_SESSION_COOKIE = "beaver_code_session";

export interface DesktopSafeDiagnostic {
  stage: "bootstrap" | "startup" | "runtime" | "shutdown" | "dialog";
  summary: string;
  recovery?: string;
}

export interface DesktopRuntimeSnapshot {
  state: "idle" | "active" | "attention" | "unknown";
  activeTurnCount: number;
  activeTerminalCount: number;
  pendingInteractionCount: number;
}

export type DesktopHostMessage =
  | { type: "bootstrap"; protocolVersion: 4; sessionToken: string; generation: string }
  | { type: "ready"; protocolVersion: 4; origin: string; generation: string }
  | { type: "startup-failed"; generation: string; diagnostic: DesktopSafeDiagnostic }
  | { type: "read-quit-snapshot"; requestId: string; generation: string }
  | ({ type: "quit-snapshot"; requestId: string; generation: string } & DesktopRuntimeSnapshot)
  | { type: "open-folder-request"; requestId: string; generation: string; title: string }
  | { type: "open-folder-result"; requestId: string; generation: string; path: string | null; canceled: boolean; error?: string }
  | ({ type: "open-menu-request"; requestId: string; generation: string } & DesktopMenuOpenRequest)
  | { type: "open-menu-result"; requestId: string; generation: string; menuId: DesktopMenuId; opened: boolean; error?: string }
  | { type: "idle-lease-granted"; generation: string; leaseId: string }
  | { type: "idle-lease-revoked"; generation: string; leaseId: string; requestId: string }
  | { type: "idle-lease-revoke-ack"; generation: string; leaseId: string; requestId: string }
  | { type: "shutdown"; requestId: string; generation: string; reason: "app-quit" | "window-close" | "restart" | "host-failure"; deadlineMs: number }
  | { type: "shutdown-complete"; requestId: string; generation: string; diagnostic?: DesktopSafeDiagnostic }
  | { type: "update-request"; requestId: string; generation: string; identity: WorkbenchUpdateIdentity; action: "prepare" | "stop" | "cancel" }
  | { type: "update-result"; requestId: string; generation: string; identity: WorkbenchUpdateIdentity; result: "prepared" | "stopped" | "canceled" | "failed"; diagnostic?: DesktopSafeDiagnostic }
  | { type: "update-offer"; generation: string; offer: DesktopUpdateOffer | null }
  | { type: "update-choice"; generation: string; offerId: string; action: DesktopUpdateChoice };

export function isDesktopHostMessage(value: unknown): value is DesktopHostMessage {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.generation !== "string") return false;
  switch (value.type) {
    case "update-request":
    case "update-result": {
      if (!isBoundedId(value.requestId) || !isWorkbenchUpdateIdentity(value.identity)
        || value.generation !== value.identity.generation) return false;
      return value.type === "update-request"
        ? ["prepare", "stop", "cancel"].includes(String(value.action))
        : ["prepared", "stopped", "canceled", "failed"].includes(String(value.result))
          && (value.diagnostic === undefined || isDiagnostic(value.diagnostic));
    }
    case "update-offer": return value.offer === null || isDesktopUpdateOffer(value.offer);
    case "update-choice": return isBoundedId(value.offerId) && ["install", "later"].includes(String(value.action));
    case "bootstrap": return value.protocolVersion === DESKTOP_PROTOCOL_VERSION && isNonEmpty(value.sessionToken);
    case "ready": return value.protocolVersion === DESKTOP_PROTOCOL_VERSION && isLoopbackOrigin(value.origin);
    case "startup-failed": return isDiagnostic(value.diagnostic);
    case "read-quit-snapshot": return isNonEmpty(value.requestId);
    case "quit-snapshot": return isNonEmpty(value.requestId) && isSnapshot(value);
    case "open-folder-request": return isNonEmpty(value.requestId) && typeof value.title === "string";
    case "open-folder-result": return isNonEmpty(value.requestId) && (value.path === null || typeof value.path === "string") && typeof value.canceled === "boolean" && (value.error === undefined || typeof value.error === "string");
    case "open-menu-request": return isNonEmpty(value.requestId) && isDesktopMenuOpenRequest(value);
    case "open-menu-result": return isNonEmpty(value.requestId) && isDesktopMenuId(value.menuId) && typeof value.opened === "boolean" && (value.error === undefined || typeof value.error === "string");
    case "idle-lease-granted": return isNonEmpty(value.leaseId);
    case "idle-lease-revoked": return isNonEmpty(value.leaseId) && isNonEmpty(value.requestId);
    case "idle-lease-revoke-ack": return isNonEmpty(value.leaseId) && isNonEmpty(value.requestId);
    case "shutdown": return isNonEmpty(value.requestId) && Number.isInteger(value.deadlineMs) && Number(value.deadlineMs) > 0 && ["app-quit", "window-close", "restart", "host-failure"].includes(String(value.reason));
    case "shutdown-complete": return isNonEmpty(value.requestId) && (value.diagnostic === undefined || isDiagnostic(value.diagnostic));
    default: return false;
  }
}

export function safeDiagnostic(stage: DesktopSafeDiagnostic["stage"], cause: unknown, recovery?: string): DesktopSafeDiagnostic {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const summary = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^'"<>|\r\n)\]}]+/g, "[本地路径]")
    .replace(/\/(?:Users|home|var|tmp)\/[^'"<>|\r\n)\]}]+/g, "[本地路径]")
    .slice(0, 400);
  return { stage, summary, ...(recovery ? { recovery } : {}) };
}

function isSnapshot(value: Record<string, unknown>): boolean {
  return ["idle", "active", "attention", "unknown"].includes(String(value.state))
    && isCount(value.activeTurnCount) && isCount(value.activeTerminalCount) && isCount(value.pendingInteractionCount);
}

function isDiagnostic(value: unknown): value is DesktopSafeDiagnostic {
  return isRecord(value) && ["bootstrap", "startup", "runtime", "shutdown", "dialog"].includes(String(value.stage)) && typeof value.summary === "string" && value.summary.length <= 400 && (value.recovery === undefined || typeof value.recovery === "string");
}

function isLoopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port) && url.pathname === "/";
  } catch { return false; }
}

function isCount(value: unknown): boolean { return Number.isInteger(value) && Number(value) >= 0; }
function isNonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isBoundedId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
