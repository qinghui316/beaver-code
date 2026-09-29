import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DesktopUpdateCoordinator, type DesktopUpdateDownloadPort, type DesktopUpdateHostPort } from "../../src/desktop/update-coordinator.js";
import { isNewerStableVersion, parseDesktopUpdatePolicy } from "../../src/desktop/update-policy.js";
import { validateDesktopSignatureEvidence } from "../../src/desktop/update-signature.js";

const artifact = { version: "0.1.3", sha512: Buffer.alloc(64, 2).toString("base64"), releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3" };
function fixture() {
  const downloads: DesktopUpdateDownloadPort = {
    check: vi.fn(async () => artifact), download: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}), install: vi.fn(async () => {}),
  };
  const host: DesktopUpdateHostPort = {
    generation: vi.fn(() => "generation"),
    prepare: vi.fn(async (identity) => ({ identity, status: "prepared" })),
    stop: vi.fn(async (identity) => ({ identity, status: "stopped" })),
    cancel: vi.fn(async () => {}), authorizeInstallerExit: vi.fn(),
  };
  const onState = vi.fn();
  return { downloads, host, onState, owner: new DesktopUpdateCoordinator("0.1.2", downloads, host, onState) };
}

describe("desktop update policy", () => {
  it.each(["0.1.2", "0.1.1", "0.1.3-beta", "v0.1.3", "01.1.3", "0.1.3+test"])("rejects non-new-stable %s", (version) => {
    expect(isNewerStableVersion(version, "0.1.2")).toBe(false);
  });
  it.each(["0.1.3", "0.2.0", "1.0.0"])("accepts newer stable %s", (version) => {
    expect(isNewerStableVersion(version, "0.1.2")).toBe(true);
  });
  it("requires trusted Ed25519 keys and the fixed production repo", () => {
    expect(() => parseDesktopUpdatePolicy({ mode: "stable" })).toThrow();
    expect(() => parseDesktopUpdatePolicy({ mode: "stable", owner: "other", repo: "other", trustedKeys: [] })).toThrow();
    expect(parseDesktopUpdatePolicy({ mode: "disabled" })).toEqual({ mode: "disabled" });
  });
  it("does not allow HTTP, credentials or GitHub as a test feed", () => {
    for (const feedUrl of ["http://localhost/", "https://u:p@localhost/", "https://github.com/test", "file:///test", "https://localhost/?token=x"]) {
      expect(() => parseDesktopUpdatePolicy({ mode: "test", feedUrl, publisherSubject: "CN=Test" })).toThrow();
    }
  });
});

describe("signature evidence", () => {
  const evidence = { status: 0, path: "C:/cache/update.exe", subject: "CN=Test", timestamped: true };
  it("accepts only exact valid publisher, file and timestamp evidence", () => {
    expect(() => validateDesktopSignatureEvidence(evidence, evidence.path, evidence.subject)).not.toThrow();
    for (const patch of [{ status: 1 }, { path: "C:/different.exe" }, { subject: "CN=Other" }, { timestamped: false }]) {
      expect(() => validateDesktopSignatureEvidence({ ...evidence, ...patch }, evidence.path, evidence.subject)).toThrow();
    }
    expect(() => validateDesktopSignatureEvidence({ ...evidence, timestamped: false }, evidence.path, evidence.subject))
      .toThrow("Update signature timestamp validation failed.");
    expect(() => validateDesktopSignatureEvidence({ ...evidence, status: 4 }, evidence.path, evidence.subject))
      .toThrow("Update signature trust validation failed with status 4.");
    expect(() => validateDesktopSignatureEvidence({ ...evidence, status: 1, statusMessage: "  bounded   detail  " }, evidence.path, evidence.subject))
      .toThrow("Update signature trust validation failed with status 1. bounded detail");
  });
  it("rejects renamed older installers even if their publisher is valid", () => {
    expect(() => validateDesktopSignatureEvidence({ ...evidence, productVersion: "0.1.2", productName: "Beaver Code" },
      evidence.path, evidence.subject, { version: "0.1.3", productName: "Beaver Code" })).toThrow("product or version");
  });
});

describe("desktop update coordinator", () => {
  it("keeps one attempt through download and verification without treating progress as readiness", async () => {
    const { downloads, host, onState } = fixture();
    const progress = vi.fn();
    let releaseVerification!: () => void;
    const verification = new Promise<void>((resolve) => { releaseVerification = resolve; });
    vi.mocked(downloads.download).mockImplementation(async (_artifact, _signal, report) => {
      report({ transferred: 40, total: 100 });
      report({ transferred: 60, total: 200 });
      report({ transferred: 90, total: 200 });
      report({ transferred: Number.POSITIVE_INFINITY, total: 200 });
    });
    vi.mocked(downloads.revalidate).mockImplementationOnce(async () => verification);
    const owner = new DesktopUpdateCoordinator("0.1.2", downloads, host, onState, progress);
    const checking = owner.check();
    await vi.waitFor(() => expect(owner.read()).toBe("verifying"));
    const attemptId = progress.mock.calls[0][0].attemptId;
    expect(progress.mock.calls.map(([activity]) => activity.percent)).toEqual([40, null, 45, null]);
    expect(progress.mock.calls.every(([activity]) => activity.attemptId === attemptId)).toBe(true);
    expect(owner.activity()).toEqual({ attemptId, version: "0.1.3", phase: "verifying" });
    expect(owner.offer()).toBeNull();
    const installWhileChecking = owner.installReady();
    expect(downloads.install).not.toHaveBeenCalled();
    releaseVerification();
    await checking;
    await installWhileChecking;
    expect(owner.activity()).toEqual({ attemptId, version: "0.1.3", phase: "ready" });
  });

  it("ignores late progress and uses a new attempt ID after dismissal", async () => {
    const { downloads, host, onState } = fixture();
    const progress = vi.fn();
    let report!: (value: { transferred: number; total: number }) => void;
    vi.mocked(downloads.download).mockImplementation(async (_artifact, _signal, callback) => { report = callback; });
    const owner = new DesktopUpdateCoordinator("0.1.2", downloads, host, onState, progress);
    await owner.check();
    const first = owner.activity()!.attemptId;
    report({ transferred: 80, total: 100 });
    expect(progress).not.toHaveBeenCalled();
    await owner.dismissReady();
    await owner.check();
    expect(owner.activity()!.attemptId).not.toBe(first);
  });

  it("keeps a verified installer ready when optional notes fail", async () => {
    const { owner, downloads } = fixture();
    downloads.notes = vi.fn(async () => { throw new Error("notes unavailable"); });
    await owner.check();
    await expect(owner.readyNotes(owner.offer()!, new AbortController().signal)).rejects.toThrow("notes unavailable");
    expect(owner.read()).toBe("ready-to-install");
    expect(owner.offer()).toEqual(artifact);
  });
  it("loads the Windows signature module explicitly instead of relying on module autoload", () => {
    const source = readFileSync(new URL("../../src/desktop/update-signature.ts", import.meta.url), "utf8");
    expect(source).toContain("Microsoft.PowerShell.Security.psd1");
    expect(source).toContain("Import-Module -Name $env:BEAVER_UPDATE_VERIFY_MODULE -Force");
  });
  it("downloads first and installs once only after explicit intent and exact receipts", async () => {
    const { owner, host, downloads, onState } = fixture();
    const first = owner.check();
    expect(owner.check()).toBe(first);
    await first;
    expect(onState.mock.calls.flat()).toEqual(["checking", "downloading", "verifying", "ready-to-install"]);
    expect(downloads.revalidate).toHaveBeenCalledTimes(1);
    expect(downloads.install).not.toHaveBeenCalled();
    await owner.installReady();
    expect(downloads.revalidate).toHaveBeenCalledTimes(3);
    expect(host.authorizeInstallerExit).toHaveBeenCalledTimes(1);
    expect(downloads.install).toHaveBeenCalledTimes(1);
    await owner.check(true);
    expect(downloads.install).toHaveBeenCalledTimes(1);
  });
  it("persists the installing state before launching the installer", async () => {
    const { downloads, host } = fixture();
    let releaseInstalling!: () => void;
    const installingPersisted = new Promise<void>((resolve) => { releaseInstalling = resolve; });
    const onState = vi.fn((state: string) => state === "installing" ? installingPersisted : undefined);
    const owner = new DesktopUpdateCoordinator("0.1.2", downloads, host, onState);
    await owner.check();
    const check = owner.installReady();
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith("installing"));
    expect(downloads.install).not.toHaveBeenCalled();
    releaseInstalling();
    await check;
    expect(downloads.install).toHaveBeenCalledTimes(1);
  });
  it("does not launch the installer when the installing state cannot be persisted", async () => {
    const { downloads, host } = fixture();
    const owner = new DesktopUpdateCoordinator("0.1.2", downloads, host, async (state) => {
      if (state === "installing") throw new Error("log unavailable");
    });
    await owner.check();
    await owner.installReady();
    expect(owner.read()).toBe("failed");
    expect(owner.diagnostic()).toEqual({ stage: "installing", recoveryRequired: true });
    expect(downloads.install).not.toHaveBeenCalled();
    expect(host.authorizeInstallerExit).not.toHaveBeenCalled();
  });
  it("signature/checksum failure never stops the Workbench", async () => {
    const { owner, host, downloads } = fixture();
    vi.mocked(downloads.revalidate).mockRejectedValue(new Error("signature"));
    await owner.check();
    expect(owner.read()).toBe("failed");
    expect(host.prepare).not.toHaveBeenCalled();
    expect(downloads.install).not.toHaveBeenCalled();
  });
  it("failed save cancels preparation and suppresses repeated automatic interruption", async () => {
    const { owner, host, downloads } = fixture();
    vi.mocked(host.prepare).mockRejectedValue(new Error("save"));
    await owner.check();
    await owner.installReady();
    await owner.check();
    expect(host.prepare).toHaveBeenCalledTimes(1);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    expect(host.stop).not.toHaveBeenCalled();
    expect(downloads.install).not.toHaveBeenCalled();
    await owner.check(true);
    await owner.installReady();
    expect(host.prepare).toHaveBeenCalledTimes(2);
  });
  it("does not mistake a wrong shutdown receipt for success", async () => {
    const { owner, host, downloads } = fixture();
    vi.mocked(host.stop).mockImplementation(async (identity) => ({ identity: { ...identity, updateId: "stale" }, status: "stopped" }));
    await owner.check();
    await owner.installReady();
    expect(downloads.install).not.toHaveBeenCalled();
    expect(host.authorizeInstallerExit).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
  });
  it("rejects a generation switch after shutdown", async () => {
    const { owner, host, downloads } = fixture();
    vi.mocked(host.stop).mockImplementation(async (identity) => {
      vi.mocked(host.generation).mockReturnValue("replacement");
      return { identity, status: "stopped" };
    });
    await owner.check();
    await owner.installReady();
    expect(downloads.install).not.toHaveBeenCalled();
  });
  it("does not install when the session ends during preparation", async () => {
    const { owner, host, downloads } = fixture();
    vi.mocked(host.prepare).mockImplementation(async (identity) => {
      owner.endSession();
      return { identity, status: "prepared" };
    });
    await owner.check();
    await owner.installReady();
    expect(host.cancel).toHaveBeenCalled();
    expect(downloads.install).not.toHaveBeenCalled();
  });
  it("rechecks cached files after shutdown", async () => {
    const { owner, downloads } = fixture();
    vi.mocked(downloads.revalidate)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("timed out"));
    await owner.check();
    await owner.installReady();
    expect(owner.diagnostic()).toEqual({ stage: "stopping", recoveryRequired: true });
    expect(downloads.install).not.toHaveBeenCalled();
  });
  it("does not authorize app quit when installer launch fails asynchronously", async () => {
    const { owner, downloads, host } = fixture();
    vi.mocked(downloads.install).mockImplementation(async () => {
      await Promise.resolve();
      throw new Error("spawn failed");
    });
    await owner.check();
    await owner.installReady();
    expect(owner.read()).toBe("failed");
    expect(owner.diagnostic()).toEqual({ stage: "installing", recoveryRequired: true });
    expect(host.authorizeInstallerExit).not.toHaveBeenCalled();
  });
});
