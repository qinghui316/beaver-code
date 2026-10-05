import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintPublicRepository } from "../../scripts/lint-public-repository.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public repository boundary", () => {
  it("rejects force-staged local state, evidence, credentials and generated files", async () => {
    const forbidden = [
      ".agents/skills/private/SKILL.md", ".agent-harness/conversation.json", ".claude/session.json",
      ".codex/session.json", "reference-projects/source/readme.md", ".gitmodules", "result.json",
      "acceptance-evidence/report.json", "playwright-report/index.html", "test-results/results.json",
      "dist/index.js", "build/BeaverCode.ico", ".env", ".env.production", "logs/runtime.log", "signer.pfx",
    ];
    const root = await fixture(forbidden);
    expect(lintPublicRepository(root).violations.map((line: string) => line.split(": ")[0])).toEqual([...forbidden].sort());
  });

  it("allows reproducible source inputs and only checks the index, leaving local data intact", async () => {
    const allowed = [
      "build/installer.nsh", "tests/fixtures/result.json", "tests/fixtures/diagnostic.log",
      "tests/fixtures/诊断样本.json", "templates/system-skills/skill/SKILL.md", ".env.example",
      "docs/MEMORY.md", "design-assets/agent-office/approved/frame.png", "src/web/public/agent-office/atlas.json",
    ];
    const root = await fixture(allowed);
    await writeFile(join(root, "result.json"), "private local result", "utf8");
    expect(lintPublicRepository(root)).toEqual({ checked: allowed.length, violations: [] });
    git(root, "add", "--force", "--", "result.json");
    expect(lintPublicRepository(root).violations).toHaveLength(1);
    git(root, "rm", "--cached", "--", "result.json");
    expect(lintPublicRepository(root).violations).toEqual([]);
    expect(await readFile(join(root, "result.json"), "utf8")).toBe("private local result");
  });

  it("shares ignore rules for local data while permitting the installer source hook", async () => {
    const root = await fixture(["build/installer.nsh"]);
    await writeFile(join(root, ".gitignore"), await readFile(new URL("../../.gitignore", import.meta.url)), "utf8");
    for (const path of ["result.json", ".agents/state.json", "build/BeaverCode.ico", "test-results/report.json", "acceptance-evidence/report.json", "signer.pfx"]) {
      expect(git(root, "check-ignore", "--no-index", "--", path).trim()).toBe(path);
    }
    expect(git(root, "check-ignore", "--no-index", "--non-matching", "--verbose", "--", "build/installer.nsh")).toContain("!/build/installer.nsh");
    expect(lintPublicRepository(root).violations).toEqual([]);
  });
});

async function fixture(paths: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "beaver-public-repository-"));
  roots.push(root);
  git(root, "init", "--quiet");
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture", "utf8");
  }
  git(root, "add", "--force", "--", ...paths);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
}
