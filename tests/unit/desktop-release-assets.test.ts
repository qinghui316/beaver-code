import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("desktop release asset cleanup", () => {
  it("removes only prior generated assets for the selected channel", async () => {
    const output = await mkdtemp(join(tmpdir(), "beaver-release-assets-"));
    cleanup.push(output);
    const removable = [
      "Beaver-Code-Setup-0.1.3-win-x64.exe",
      "Beaver-Code-Setup-0.1.3-win-x64.exe.blockmap",
      "latest.yml",
      "beaver-update-win-x64.json",
      "beaver-update-win-x64.json.sig",
      "beaver-release-notes.json",
      "beaver-release-notes.json.sig",
      "release-receipt.json",
      "SHA256SUMS.txt",
    ];
    const retained = ["keep.txt", "Other-Setup-0.1.3-win-x64.exe"];
    await Promise.all([...removable, ...retained].map((name) => writeFile(join(output, name), name, "utf8")));

    const moduleUrl = pathToFileURL(join(process.cwd(), "scripts", "desktop-release-assets.mjs")).href;
    const source = `import { removePriorChannelReleaseAssets } from ${JSON.stringify(moduleUrl)}; await removePriorChannelReleaseAssets(process.env.BEAVER_TEST_OUTPUT, "Beaver-Code-Setup");`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: process.cwd(),
      env: { ...process.env, BEAVER_TEST_OUTPUT: output },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect((await readdir(output)).sort()).toEqual(retained.sort());
  });
});
