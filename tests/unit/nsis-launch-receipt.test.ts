import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNsisInstallArguments,
  createNsisUpdateAdapter,
} from "../../src/desktop/nsis-update-adapter.js";

const state = vi.hoisted(() => ({
  instance: null as unknown,
  spawn: () => Promise.resolve(true),
  spawnCount: 0,
  spawnCommand: null as string | null,
  spawnArgs: null as string[] | null,
  prematureQuit: 0,
}));
vi.mock("electron-updater", () => ({
  default: {
    NsisUpdater: class {
      installerPath: string | null = "C:/verified/installer.exe";
      installDirectory: string | undefined;
      downloadedUpdateHelper: { packageFile: string | null } | null = null;
      elevated = false;
      constructor() { state.instance = this; }
      on() { return this; }
      install(isSilent: boolean, isForceRunAfter: boolean) {
        return this.doInstall({ isSilent, isForceRunAfter, isAdminRightsRequired: this.elevated });
      }
      doInstall(_options: unknown): boolean { return false; }
      spawnLog(command: string, args: string[]): Promise<boolean> {
        state.spawnCount += 1;
        state.spawnCommand = command;
        state.spawnArgs = [...args];
        return state.spawn();
      }
      quitAndInstall() { state.prematureQuit += 1; }
    },
  },
}));

interface FixtureNsis {
  installerPath: string | null;
  installDirectory: string | undefined;
  downloadedUpdateHelper: { packageFile: string | null } | null;
  elevated: boolean;
  launchVerifiedUpdate(): Promise<void>;
}
beforeEach(() => {
  state.instance = null;
  state.spawn = () => Promise.resolve(true);
  state.spawnCount = 0;
  state.spawnCommand = null;
  state.spawnArgs = null;
  state.prematureQuit = 0;
});
async function fixture(installDirectory = "E:\\beaver code\\BeaverCode"): Promise<FixtureNsis> {
  await createNsisUpdateAdapter({
    mode: "test", feedUrl: "https://beaver-update.test/", publisherSubject: "CN=Fixture",
  }, installDirectory);
  return state.instance as FixtureNsis;
}

describe("actual NSIS launch-boundary adapter", () => {
  it("builds the pinned upstream argument order without shell quoting", () => {
    expect(buildNsisInstallArguments(
      { isSilent: true, isForceRunAfter: true },
      "E:\\Beaver Code\\应用",
      "C:\\更新缓存\\package.7z",
    )).toEqual([
      "--updated",
      "/S",
      "--force-run",
      "/D=E:\\Beaver Code\\应用",
      "--package-file=C:\\更新缓存\\package.7z",
    ]);
  });
  it("forwards the exact custom directory and package file to the verified installer", async () => {
    const nsis = await fixture("E:\\beaver code\\BeaverCode");
    expect(nsis.installDirectory).toBe("E:\\beaver code\\BeaverCode");
    nsis.downloadedUpdateHelper = { packageFile: "C:\\更新缓存\\payload.7z" };
    await nsis.launchVerifiedUpdate();
    expect(state.spawnCommand).toBe("C:/verified/installer.exe");
    expect(state.spawnArgs).toEqual([
      "--updated",
      "/S",
      "--force-run",
      "/D=E:\\beaver code\\BeaverCode",
      "--package-file=C:\\更新缓存\\payload.7z",
    ]);
  });
  it("waits for asynchronous launch failure without invoking the library quit path", async () => {
    const nsis = await fixture();
    state.spawn = async () => { await Promise.resolve(); throw new Error("CreateProcess failed"); };
    await expect(nsis.launchVerifiedUpdate()).rejects.toThrow("CreateProcess failed");
    expect(state.prematureQuit).toBe(0);
  });
  it("rejects elevation and missing installer paths before spawning", async () => {
    const nsis = await fixture();
    nsis.elevated = true;
    await expect(nsis.launchVerifiedUpdate()).rejects.toThrow("did not start");
    nsis.elevated = false;
    nsis.installerPath = null;
    await expect(nsis.launchVerifiedUpdate()).rejects.toThrow("did not start");
    expect(state.spawnCount).toBe(0);
  });
  it("requires affirmative launch evidence, not just a settled Promise", async () => {
    const nsis = await fixture();
    state.spawn = () => Promise.resolve(false);
    await expect(nsis.launchVerifiedUpdate()).rejects.toThrow("not confirmed");
    expect(state.prematureQuit).toBe(0);
  });
});
