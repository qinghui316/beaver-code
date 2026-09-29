import { randomUUID } from "node:crypto";
import type { DesktopUpdateActivity, WorkbenchUpdateIdentity, WorkbenchUpdateReceipt } from "../types/workbench-update.js";
import { sameWorkbenchUpdate } from "../types/workbench-update.js";
import { isNewerStableVersion } from "./update-policy.js";
import type { BeaverReleaseNoteContent } from "./update-manifest.js";

export interface DesktopUpdateArtifact {
  readonly version: string;
  readonly sha512: string;
  readonly releaseUrl?: string;
  readonly manifestSha256?: string;
}

export interface DesktopUpdateDownloadPort {
  check(signal: AbortSignal): Promise<DesktopUpdateArtifact | null>;
  download(artifact: DesktopUpdateArtifact, signal: AbortSignal, onProgress: (progress: DesktopDownloadProgress) => void): Promise<void>;
  revalidate(artifact: DesktopUpdateArtifact, signal: AbortSignal): Promise<void>;
  install(): Promise<void>;
  notes?(artifact: DesktopUpdateArtifact, signal: AbortSignal): Promise<BeaverReleaseNoteContent>;
}

export interface DesktopDownloadProgress {
  readonly transferred: number;
  readonly total: number;
}

export interface DesktopUpdateHostPort {
  generation(): string | null;
  prepare(identity: WorkbenchUpdateIdentity): Promise<WorkbenchUpdateReceipt>;
  stop(identity: WorkbenchUpdateIdentity): Promise<WorkbenchUpdateReceipt>;
  cancel(identity: WorkbenchUpdateIdentity): Promise<void>;
  /** Must not terminate a possibly active Utility. Only detach a proven stopped runtime. */
  authorizeInstallerExit(identity: WorkbenchUpdateIdentity): void;
}

export type DesktopUpdateState = "idle" | "checking" | "downloading" | "verifying" | "ready-to-install" | "preparing" | "stopping" | "installing" | "failed";

/** One transaction owns the entire update; library download events never authorize installation. */
export class DesktopUpdateCoordinator {
  private state: DesktopUpdateState = "idle";
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private ending = false;
  private failedVersion: string | null = null;
  private failureStage: DesktopUpdateState | null = null;
  private recoveryRequired = false;
  private readyArtifact: DesktopUpdateArtifact | null = null;
  private attempt: { id: string; artifact: DesktopUpdateArtifact; percent: number | null; lastPercent: number } | null = null;

  constructor(
    private readonly installedVersion: string,
    private readonly downloads: DesktopUpdateDownloadPort,
    private readonly host: DesktopUpdateHostPort,
    private readonly onState: (state: DesktopUpdateState) => void | Promise<void>,
    private readonly onProgress: (activity: DesktopUpdateActivity) => void = () => {},
  ) {}

  read(): DesktopUpdateState { return this.state; }
  diagnostic(): { stage: DesktopUpdateState | null; recoveryRequired: boolean } {
    return { stage: this.failureStage, recoveryRequired: this.recoveryRequired };
  }
  offer(): DesktopUpdateArtifact | null { return this.readyArtifact ? Object.freeze({ ...this.readyArtifact }) : null; }

  activity(): DesktopUpdateActivity | null {
    const attempt = this.attempt;
    if (!attempt) return null;
    const phase = this.state === "ready-to-install" ? "ready" : this.state;
    if (phase === "idle" || phase === "checking") return null;
    return phase === "downloading"
      ? { attemptId: attempt.id, version: attempt.artifact.version, phase, percent: attempt.percent }
      : { attemptId: attempt.id, version: attempt.artifact.version, phase };
  }

  async readyNotes(artifact: DesktopUpdateArtifact, signal: AbortSignal): Promise<BeaverReleaseNoteContent> {
    if (this.state !== "ready-to-install" || !this.readyArtifact || !sameReadyArtifact(artifact, this.readyArtifact)
      || !this.downloads.notes) throw new Error("Release notes are unavailable.");
    const notes = await this.downloads.notes(artifact, signal);
    if (this.state !== "ready-to-install" || !this.readyArtifact || !sameReadyArtifact(artifact, this.readyArtifact)) {
      throw new Error("Release notes are stale.");
    }
    return notes;
  }

  check(manual = false): Promise<void> {
    if (this.pending) return this.pending;
    if (this.ending || this.state === "installing") return Promise.resolve();
    if (this.state === "ready-to-install") return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.runCheck(manual, controller).finally(() => {
      this.pending = null;
      if (this.controller === controller) this.controller = null;
    });
    return this.pending;
  }

  installReady(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.ending || this.state !== "ready-to-install" || !this.readyArtifact) return Promise.resolve();
    const controller = new AbortController();
    const artifact = this.readyArtifact;
    this.controller = controller;
    this.pending = this.runInstall(artifact, controller).finally(() => {
      this.pending = null;
      if (this.controller === controller) this.controller = null;
    });
    return this.pending;
  }

  async dismissReady(): Promise<void> {
    if (this.pending || this.state !== "ready-to-install") return;
    this.readyArtifact = null;
    this.attempt = null;
    await this.setState("idle");
  }

  endSession(): void {
    this.ending = true;
    this.controller?.abort();
  }

  private async runCheck(manual: boolean, controller: AbortController): Promise<void> {
    this.failureStage = null;
    this.recoveryRequired = false;
    this.readyArtifact = null;
    this.attempt = null;
    try {
      await this.setState("checking");
      const offered = await this.downloads.check(controller.signal);
      this.assertSession(controller);
      if (!offered || !isNewerStableVersion(offered.version, this.installedVersion)
        || (!manual && offered.version === this.failedVersion)) {
        await this.setState("idle");
        return;
      }
      const artifact = Object.freeze({ ...offered });
      if (!/^[A-Za-z0-9+/]{86}==$/.test(artifact.sha512)) throw new Error("Invalid update artifact.");
      const attempt = { id: randomUUID(), artifact, percent: null as number | null, lastPercent: -1 };
      this.attempt = attempt;
      await this.setState("downloading");
      await this.downloads.download(artifact, controller.signal, (progress) => {
        if (this.attempt !== attempt || this.state !== "downloading" || controller.signal.aborted || this.ending) return;
        const transferred = progress.transferred;
        const total = progress.total;
        const valid = Number.isFinite(transferred) && Number.isFinite(total)
          && transferred >= 0 && total > 0 && transferred <= total;
        const next = valid ? Math.floor(transferred / total * 100) : null;
        attempt.percent = next !== null && next >= attempt.lastPercent ? next : null;
        if (attempt.percent !== null) attempt.lastPercent = attempt.percent;
        try { this.onProgress(this.activity()!); } catch { /* Presentation cannot fail the download. */ }
      });
      this.assertSession(controller);
      await this.setState("verifying");
      await this.downloads.revalidate(artifact, controller.signal);
      this.assertSession(controller);
      this.readyArtifact = artifact;
      await this.setState("ready-to-install");
    } catch {
      this.failureStage = this.state;
      try { await this.setState("failed"); } catch { /* state remains failed if its observer is unavailable */ }
    }
  }

  private async runInstall(artifact: DesktopUpdateArtifact, controller: AbortController): Promise<void> {
    let identity: WorkbenchUpdateIdentity | null = null;
    let teardownStarted = false;
    this.failureStage = null;
    this.recoveryRequired = false;
    try {
      await this.downloads.revalidate(artifact, controller.signal);
      this.assertSession(controller);
      const generation = this.host.generation();
      if (!generation) throw new Error("Workbench is unavailable for updating.");
      identity = Object.freeze({ updateId: randomUUID(), generation, targetVersion: artifact.version, artifactSha512: artifact.sha512 });
      await this.setState("preparing");
      const prepared = await this.host.prepare(identity);
      this.assertCurrent(identity, prepared, "prepared", controller);
      await this.setState("stopping");
      teardownStarted = true;
      const stopped = await this.host.stop(identity);
      this.assertCurrent(identity, stopped, "stopped", controller);
      // Check the cached installer again after the potentially long preparation.
      await this.downloads.revalidate(artifact, controller.signal);
      this.assertCurrent(identity, stopped, "stopped", controller);
      await this.setState("installing");
      await this.downloads.install();
      this.readyArtifact = null;
      this.host.authorizeInstallerExit(identity);
    } catch {
      this.failureStage = this.state;
      this.recoveryRequired = teardownStarted;
      if (identity) {
        this.failedVersion = identity.targetVersion;
        if (!teardownStarted) {
          try { await this.host.cancel(identity); } catch { this.recoveryRequired = true; }
        }
      }
      if (!teardownStarted) this.readyArtifact = null;
      try { await this.setState("failed"); } catch { /* state remains failed if its observer is unavailable */ }
    }
  }

  private assertSession(controller: AbortController): void {
    if (this.ending || controller.signal.aborted) throw new Error("Update session ended.");
  }

  private assertCurrent(identity: WorkbenchUpdateIdentity, receipt: WorkbenchUpdateReceipt,
    status: WorkbenchUpdateReceipt["status"], controller: AbortController): void {
    this.assertSession(controller);
    if (receipt.status !== status || !sameWorkbenchUpdate(identity, receipt.identity)
      || this.host.generation() !== identity.generation) throw new Error("Update receipt is stale.");
  }

  private async setState(state: DesktopUpdateState): Promise<void> {
    this.state = state;
    await this.onState(state);
  }
}

function sameReadyArtifact(left: DesktopUpdateArtifact, right: DesktopUpdateArtifact): boolean {
  return left.version === right.version && left.sha512 === right.sha512
    && left.manifestSha256 === right.manifestSha256;
}
