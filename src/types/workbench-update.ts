/** Host lifecycle facts only. This contract cannot authorize Provider or database operations. */
export interface WorkbenchUpdateIdentity {
  readonly updateId: string;
  readonly generation: string;
  readonly targetVersion: string;
  readonly artifactSha512: string;
}

export type WorkbenchUpdatePhase = "idle" | "preparing" | "prepared" | "shutting-down" | "stopped" | "canceled" | "recovery-required";

export interface WorkbenchUpdateSnapshot {
  readonly identity: WorkbenchUpdateIdentity | null;
  readonly phase: WorkbenchUpdatePhase;
}

export interface WorkbenchUpdateReceipt {
  readonly identity: WorkbenchUpdateIdentity;
  readonly status: "prepared" | "stopped";
}

export interface DesktopUpdateOffer {
  readonly offerId: string;
  readonly version: string;
  readonly releaseUrl: string;
  /** Undefined while loading, null when unavailable. */
  readonly notes?: DesktopReleaseNotes | null;
}

export type DesktopUpdateActivityPhase = "downloading" | "verifying" | "ready" | "preparing" | "stopping" | "installing" | "failed";

export interface DesktopUpdateActivity {
  readonly attemptId: string;
  readonly version: string;
  readonly phase: DesktopUpdateActivityPhase;
  /** Null means that the download has no trustworthy total. */
  readonly percent?: number | null;
}

export function isDesktopUpdateActivity(value: unknown): value is DesktopUpdateActivity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!boundedId(item.attemptId) || typeof item.version !== "string"
    || !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(item.version)) return false;
  if (item.phase === "downloading") {
    return item.percent === null || (Number.isInteger(item.percent) && Number(item.percent) >= 0 && Number(item.percent) <= 100);
  }
  return ["verifying", "ready", "preparing", "stopping", "installing", "failed"].includes(String(item.phase))
    && item.percent === undefined;
}

export interface DesktopReleaseNotes {
  readonly version: string;
  readonly zhCN: { readonly summary: string; readonly changes: readonly string[] };
  readonly enUS: { readonly summary: string; readonly changes: readonly string[] };
}

export function isDesktopReleaseNotes(value: unknown): value is DesktopReleaseNotes {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const validText = (text: unknown): text is string => typeof text === "string" && text.length > 0
    && text.length <= 500 && text.trim() === text && !Array.from(text).some((character) =>
      character.charCodeAt(0) < 32 || character === "<" || character === ">");
  const validLanguage = (language: unknown): boolean => {
    if (!language || typeof language !== "object") return false;
    const note = language as Record<string, unknown>;
    return validText(note.summary) && Array.isArray(note.changes) && note.changes.length > 0
      && note.changes.length <= 20 && note.changes.every(validText);
  };
  return typeof item.version === "string" && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(item.version)
    && validLanguage(item.zhCN) && validLanguage(item.enUS);
}

export type DesktopUpdateChoice = "install" | "later";

export function isDesktopUpdateOffer(value: unknown): value is DesktopUpdateOffer {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!boundedId(item.offerId) || typeof item.version !== "string"
    || !/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(item.version) || typeof item.releaseUrl !== "string") return false;
  if (item.notes !== undefined && item.notes !== null
    && (!isDesktopReleaseNotes(item.notes) || item.notes.version !== item.version)) return false;
  try {
    const url = new URL(item.releaseUrl);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password
      && !url.port && !url.search && !url.hash
      && url.pathname === `/qinghui316/beaver-code/releases/tag/v${item.version}`;
  } catch { return false; }
}

export function sameWorkbenchUpdate(left: WorkbenchUpdateIdentity, right: WorkbenchUpdateIdentity): boolean {
  return left.updateId === right.updateId && left.generation === right.generation
    && left.targetVersion === right.targetVersion && left.artifactSha512 === right.artifactSha512;
}

export function isWorkbenchUpdateIdentity(value: unknown): value is WorkbenchUpdateIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return boundedId(item.updateId) && boundedId(item.generation)
    && typeof item.targetVersion === "string" && /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(item.targetVersion)
    && typeof item.artifactSha512 === "string" && /^[A-Za-z0-9+/]{86}==$/.test(item.artifactSha512);
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value);
}
