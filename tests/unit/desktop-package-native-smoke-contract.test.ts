import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

const packaging = await read("scripts/package-desktop-win.mjs");
const smoke = await read("scripts/desktop-native-smoke.cjs");
const main = await read("src/desktop/main.ts");
const builder = load(await read("electron-builder.yml")) as { files: string[]; extraResources: { from: string; to: string }[] };
const verifier = await read("scripts/verify-desktop-package.mjs");

describe("desktop packaged native smoke boundary", () => {
  it("includes the MIT project license in desktop build inputs", async () => {
    expect(builder.files).toContain("LICENSE");
    expect(JSON.parse(await read("package.json")).license).toBe("MIT");
    expect((await read("LICENSE")).split(/\r?\n/)[0]).toBe("MIT License");
  });

  it("ships physical system Skills and binds the packaged Utility root in Main", () => {
    expect(builder.extraResources).toContainEqual({ from: "dist/templates/system-skills", to: "system-skills" });
    expect(main).toContain('...(app.isPackaged ? { AHO_SYSTEM_SKILLS_DIR: join(process.resourcesPath, "system-skills") } : {})');
    expect(main).toContain("...process.env");
    expect(verifier).toContain('verifyDesktopSystemSkills(join(dirname(asar), "system-skills")');
    expect(smoke).toContain('join(resolve(packagedRoot), "resources", "system-skills")');
  });

  it("tests the packaged executable instead of a development Electron install", () => {
    expect(packaging).toContain('resolve(packagedRoot, variant.config.win.executableName + ".exe")');
    expect(packaging).toContain('ELECTRON_RUN_AS_NODE: "1"');
    expect(packaging).toContain("BEAVER_NATIVE_PACKAGE_ROOT: packagedRoot");
    expect(packaging).not.toContain('node_modules", "electron", "dist"');
  });

  it("loads packaged native modules without requiring a BrowserWindow lifecycle", () => {
    expect(smoke).toContain('load("better-sqlite3")');
    expect(smoke).toContain('load("node-pty")');
    expect(smoke).not.toContain('require("electron")');
    expect(smoke).not.toContain("app.whenReady");
    expect(smoke).toContain("process.exit(0)");
    expect(smoke).toContain("process.exit(1)");
  });
});

async function read(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}
