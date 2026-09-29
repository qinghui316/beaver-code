import { describe, expect, it, vi } from "vitest";
import { NsisUpdateAdapter } from "../../src/desktop/nsis-update-adapter.js";

const sha512 = Buffer.alloc(64, 5).toString("base64");
const signed = {
  manifest: {
    schemaVersion: 1 as const, channel: "stable" as const, version: "0.1.3", tag: "v0.1.3", commit: "a".repeat(40),
    platform: "win32" as const, arch: "x64" as const, publishedAt: "2026-09-13T00:00:00.000Z",
    installer: { name: "Beaver-Code-Setup-0.1.3-win-x64.exe", size: 123, sha512 },
    blockmap: { name: "Beaver-Code-Setup-0.1.3-win-x64.exe.blockmap", size: 10, sha512: Buffer.alloc(64, 6).toString("base64") },
  },
  manifestSha256: "a".repeat(64),
  releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
};
function fixture() {
  const cancellation = { cancel: vi.fn() };
  const listeners = new Map<string, Set<(value?: unknown) => void>>();
  const emit = (event: string, value?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const nsis = {
    autoDownload: true, autoInstallOnAppQuit: true, autoRunAppAfterInstall: false,
    allowPrerelease: true, allowDowngrade: true, disableWebInstaller: false, logger: null,
    verifyUpdateCodeSignature: vi.fn(async () => null),
    on: vi.fn((event: string, listener: (value?: unknown) => void) => {
      const current = listeners.get(event) ?? new Set();
      current.add(listener);
      listeners.set(event, current);
    }),
    removeListener: vi.fn((event: string, listener: (value?: unknown) => void) => { listeners.get(event)?.delete(listener); }),
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: true, updateInfo: { version: "0.1.3", files: [{ url: "Beaver-Code-Setup-0.1.3-win-x64.exe", sha512 }] },
      cancellationToken: cancellation,
    })),
    downloadUpdate: vi.fn(async () => ["C:/cache/update.exe"]),
    launchVerifiedUpdate: vi.fn(async () => {}),
  };
  const verifier = { signature: vi.fn(async () => {}), hash: vi.fn(async () => {}), size: vi.fn(async () => 123) };
  const manifests = { latest: vi.fn(async () => signed), exact: vi.fn(async () => {}) };
  const adapter = new NsisUpdateAdapter(nsis as unknown as ConstructorParameters<typeof NsisUpdateAdapter>[0],
    { mode: "stable", owner: "qinghui316", repo: "beaver-code", trustedKeys: [{ keyId: "test", publicKey: "unused-by-mock" }] }, verifier, manifests);
  return { nsis, verifier, manifests, adapter, cancellation, emitError: () => emit("error"),
    emitProgress: (transferred: unknown, total: unknown) => emit("download-progress", { transferred, total }),
    progressListeners: () => listeners.get("download-progress")?.size ?? 0 };
}
describe("NSIS adapter security defaults", () => {
  it("reports current download bytes and removes its listener after completion", async () => {
    const { adapter, nsis, emitProgress, progressListeners } = fixture();
    const artifact = (await adapter.check())!;
    const observed = vi.fn();
    nsis.downloadUpdate.mockImplementationOnce(async () => {
      expect(progressListeners()).toBe(1);
      emitProgress(50, 100);
      emitProgress("invalid", 100);
      return ["C:/cache/update.exe"];
    });
    await adapter.download(artifact, new AbortController().signal, observed);
    expect(observed.mock.calls[0][0]).toEqual({ transferred: 50, total: 100 });
    expect(Number.isNaN(observed.mock.calls[1][0].transferred)).toBe(true);
    expect(progressListeners()).toBe(0);
    emitProgress(100, 100);
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it("disables implicit download/install, downgrade, prerelease and web installers", () => {
    const { nsis } = fixture();
    expect(nsis).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false,
      allowDowngrade: false, disableWebInstaller: true, logger: null,
    });
  });
  it("requires independent manifest and artifact verification even when the library skips its callback", async () => {
    const { adapter, verifier, manifests, nsis } = fixture();
    const artifact = (await adapter.check())!;
    await adapter.download(artifact, new AbortController().signal);
    expect(verifier.signature).not.toHaveBeenCalled();
    expect(verifier.hash).not.toHaveBeenCalled();
    await adapter.revalidate(artifact);
    expect(verifier.hash).toHaveBeenCalledWith("C:/cache/update.exe", sha512);
    expect(manifests.exact).toHaveBeenCalled();
    await adapter.install();
    expect(nsis.launchVerifiedUpdate).toHaveBeenCalledTimes(1);
    await expect(adapter.install()).rejects.toThrow();
  });
  it("cannot install after verifier failure", async () => {
    const { adapter, verifier, nsis } = fixture();
    const artifact = (await adapter.check())!;
    verifier.hash.mockRejectedValue(new Error("untrusted"));
    await adapter.download(artifact, new AbortController().signal);
    await expect(adapter.revalidate(artifact)).rejects.toThrow();
    await expect(adapter.install()).rejects.toThrow();
    expect(nsis.launchVerifiedUpdate).not.toHaveBeenCalled();
  });
  it("rejects remote metadata file URLs and wrong architecture before download", async () => {
    const { adapter, nsis } = fixture();
    for (const url of ["https://other/installer.exe", "Beaver-Code-Setup-0.1.3-win-arm64.exe", "../installer.exe"]) {
      nsis.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true, updateInfo: { version: "0.1.3", files: [{ url, sha512 }] },
        cancellationToken: { cancel: vi.fn() },
      });
      await expect(adapter.check()).rejects.toThrow();
    }
    expect(nsis.downloadUpdate).not.toHaveBeenCalled();
  });
  it("does not install after an asynchronous library error", async () => {
    const { adapter, emitError } = fixture();
    const artifact = (await adapter.check())!;
    await adapter.download(artifact, new AbortController().signal);
    await adapter.revalidate(artifact);
    emitError();
    await expect(adapter.install()).rejects.toThrow();
  });

  it("passes the check's cancellation token into the actual download", async () => {
    const { adapter, nsis, cancellation, emitProgress, progressListeners } = fixture();
    const artifact = (await adapter.check())!;
    const abort = new AbortController();
    const observed = vi.fn();
    nsis.downloadUpdate.mockImplementationOnce(async () => {
      expect(progressListeners()).toBe(1);
      abort.abort();
      emitProgress(50, 100);
      return ["C:/cache/update.exe"];
    });
    await expect(adapter.download(artifact, abort.signal, observed)).rejects.toThrow();
    expect(observed).not.toHaveBeenCalled();
    expect(progressListeners()).toBe(0);
    expect(nsis.downloadUpdate).toHaveBeenCalledWith(cancellation);
    expect(cancellation.cancel).toHaveBeenCalledTimes(1);
    await expect(adapter.install()).rejects.toThrow();
  });

  it("rejects a changed offered hash without touching the cached installer", async () => {
    const { adapter, nsis } = fixture();
    const artifact = (await adapter.check())!;
    await expect(adapter.download({ ...artifact, sha512: Buffer.alloc(64, 6).toString("base64") },
      new AbortController().signal)).rejects.toThrow();
    expect(nsis.downloadUpdate).not.toHaveBeenCalled();
  });
});
