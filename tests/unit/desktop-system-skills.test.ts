import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDesktopSystemSkills } from "../../scripts/desktop-system-skills.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-system-skills-"));
  roots.push(root);
  const source = join(root, "source");
  const packaged = join(root, "resources", "system-skills");
  for (const target of [source, packaged]) {
    await mkdir(join(target, "aho-main-orchestration", "references"), { recursive: true });
    await writeFile(join(target, "aho-main-orchestration", "SKILL.md"), "# AHO\n完整技能包\n", "utf8");
    await writeFile(join(target, "aho-main-orchestration", "references", "guide.md"), "guide\n", "utf8");
  }
  return { root, source, packaged };
}

describe("physical desktop system Skill resources", () => {
  it("accepts a complete physical package, including nested references", async () => {
    const { source, packaged } = await fixture();
    await expect(verifyDesktopSystemSkills(packaged, source)).resolves.toEqual({ fileCount: 2 });
  });

  it("rejects an ASAR-only root even if a directory with that name exists", async () => {
    const { root, source } = await fixture();
    const archiveRoot = join(root, "app.asar", "dist", "templates", "system-skills");
    await mkdir(archiveRoot, { recursive: true });
    await expect(verifyDesktopSystemSkills(archiveRoot, source)).rejects.toThrow("outside ASAR");
  });

  it("rejects a missing physical directory", async () => {
    const { source, packaged } = await fixture();
    await rm(packaged, { recursive: true });
    await expect(verifyDesktopSystemSkills(packaged, source)).rejects.toThrow();
  });

  it("rejects missing mandatory orchestration entry", async () => {
    const { source, packaged } = await fixture();
    await rm(join(packaged, "aho-main-orchestration", "SKILL.md"));
    await expect(verifyDesktopSystemSkills(packaged, source)).rejects.toThrow("Mandatory");
  });

  it("rejects a missing nested file", async () => {
    const { source, packaged } = await fixture();
    await rm(join(packaged, "aho-main-orchestration", "references", "guide.md"));
    await expect(verifyDesktopSystemSkills(packaged, source)).rejects.toThrow("file set");
  });

  it("rejects stale extra files", async () => {
    const { source, packaged } = await fixture();
    await writeFile(join(packaged, "stale.md"), "old", "utf8");
    await expect(verifyDesktopSystemSkills(packaged, source)).rejects.toThrow("file set");
  });

  it("rejects altered bytes despite the same file set", async () => {
    const { source, packaged } = await fixture();
    await writeFile(join(packaged, "aho-main-orchestration", "references", "guide.md"), "modified", "utf8");
    await expect(verifyDesktopSystemSkills(packaged, source)).rejects.toThrow("content differs");
  });
});
