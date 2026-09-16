import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashProjectHarnessProviderContent,
  PROJECT_HARNESS_PROVIDER_CONTENT_PATHS,
} from "../../src/project-harness/provider-content-hash.js";
import { hashNativeSkillPackageContent } from "../../src/skill/content-hash.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Project Harness Provider content hash", () => {
  it("uses the ECL stable Skill content roots", () => {
    expect(PROJECT_HARNESS_PROVIDER_CONTENT_PATHS).toEqual([
      "SKILL.md",
      "references",
      "scripts",
      "assets",
      "agents",
    ]);
  });

  it("ignores dynamic state even when it contains more than 500 files", async () => {
    const root = await fixture();
    const before = await hashProjectHarnessProviderContent(root);
    await mkdir(join(root, "state", "changes"), { recursive: true });
    await Promise.all(Array.from({ length: 520 }, (_, index) =>
      writeFile(join(root, "state", "changes", `change-${String(index).padStart(3, "0")}.json`), "{}", "utf8")));
    await writeFile(join(root, "state", "registry.json"), "{\"changed\":true}", "utf8");
    await expect(hashProjectHarnessProviderContent(root)).resolves.toBe(before);
  });

  it("does not impose the ordinary Skill file limit on stable Harness content", async () => {
    const root = await fixture();
    await mkdir(join(root, "references", "generated"), { recursive: true });
    await Promise.all(Array.from({ length: 520 }, (_, index) =>
      writeFile(join(root, "references", "generated", `reference-${String(index).padStart(3, "0")}.md`), `${index}\n`, "utf8")));

    await expect(hashProjectHarnessProviderContent(root)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the ordinary Skill package resource limit", async () => {
    const root = await fixture();
    await mkdir(join(root, "ordinary"), { recursive: true });
    await Promise.all(Array.from({ length: 501 }, (_, index) =>
      writeFile(join(root, "ordinary", `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`, "utf8")));

    await expect(hashNativeSkillPackageContent(root)).rejects.toThrow(/too many files/i);
  });

  it("ignores runtime state when Codex fingerprints a discovered project Harness", async () => {
    const root = await fixture();
    await mkdir(join(root, "state", "changes"), { recursive: true });
    await Promise.all(Array.from({ length: 520 }, (_, index) =>
      writeFile(join(root, "state", "changes", `change-${String(index).padStart(3, "0")}.json`), "{}", "utf8")));

    await expect(hashNativeSkillPackageContent(root)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["SKILL.md", "updated entry"],
    ["references/guide.md", "updated reference"],
    ["scripts/check.mjs", "updated script"],
    ["assets/prompt.txt", "updated asset"],
    ["agents/auditor.md", "updated agent"],
  ])("changes when stable content %s changes", async (relativePath, content) => {
    const root = await fixture();
    const before = await hashProjectHarnessProviderContent(root);
    await writeFile(join(root, ...relativePath.split("/")), content, "utf8");
    await expect(hashProjectHarnessProviderContent(root)).resolves.not.toBe(before);
  });

  it("is deterministic across creation order", async () => {
    const first = await fixture("first");
    const second = await fixture("second", true);
    await expect(hashProjectHarnessProviderContent(first)).resolves.toBe(await hashProjectHarnessProviderContent(second));
  });

  it("rejects links in stable content", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "aho-provider-hash-outside-"));
    cleanup.push(outside);
    await writeFile(join(outside, "outside.md"), "outside", "utf8");
    await symlink(outside, join(root, "references", "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(hashProjectHarnessProviderContent(root)).rejects.toThrow(/link or Junction/);
  });
});

async function fixture(label = "default", reverse = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `aho-provider-hash-${label}-`));
  cleanup.push(root);
  const files: Array<[string, string]> = [
    ["SKILL.md", "---\nname: sample-harness\n---\n"],
    ["references/guide.md", "reference\n"],
    ["scripts/check.mjs", "export {};\n"],
    ["assets/prompt.txt", "asset\n"],
    ["agents/auditor.md", "auditor\n"],
    ["state/manifest.json", "{\"project_id\":\"sample\"}\n"],
  ];
  for (const [relativePath, content] of reverse ? files.reverse() : files) {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}
