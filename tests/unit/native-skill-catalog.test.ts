import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCodexNativeSkills, setCodexNativeSkillEnabled } from "../../src/codex/native-skills.js";
import type { ProviderSkillCatalogSnapshot } from "../../src/provider-runtime/contracts.js";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { initializeProjectRuntimeSidecar } from "../../src/project-runtime/lifecycle.js";
import {
  addSkillRoot,
  buildSkillResolutionCatalog,
  getEnabledSkillContext,
  listSkills,
  setSkillEnabled,
} from "../../src/skill/catalog.js";
import { hashNativeSkillPackageContent } from "../../src/skill/content-hash.js";
import { hashProjectHarnessProviderContent } from "../../src/project-harness/provider-content-hash.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-native-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Codex native Skill adapter", () => {
  it("serializes extra-root changes and reads across concurrent project scans", async () => {
    const a = await directory("a"); const b = await directory("b");
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: string[] = []; let roots: unknown;
    const requester = { async requestMetadata(method: string, params: Record<string, unknown>) {
      calls.push(method); if (method === "skills/extraRoots/set") { roots = params.extraRoots; return {}; }
      const cwd = (params.cwds as string[])[0]!;
      if (cwd === a) { entered(); await gate; expect(roots).toEqual([join(root, "roots-a")]); }
      else expect(roots).toEqual([join(root, "roots-b")]);
      return { data: [{ cwd, skills: [], errors: [] }] };
    } };
    const first = listCodexNativeSkills({ projectPath: a, extraRoots: [join(root, "roots-a")] }, { requester });
    await started;
    const second = listCodexNativeSkills({ projectPath: b, extraRoots: [join(root, "roots-b")] }, { requester });
    await Promise.resolve(); expect(calls).toEqual(["skills/extraRoots/set", "skills/list"]);
    release(); await Promise.all([first, second]);
    expect(calls).toEqual(["skills/extraRoots/set", "skills/list", "skills/extraRoots/set", "skills/list"]);
  });

  it("maps exact cwd scope, enablement, errors and package content identity", async () => {
    const projectPath = await directory("repo");
    const skillPath = await createSkill(join(root, "skills"), "portable-skill");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const requester = {
      async requestMetadata(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        calls.push({ method, params });
        if (method === "skills/extraRoots/set") return {};
        return {
          data: [{
            cwd: projectPath,
            skills: [{
              name: "portable-skill",
              description: "Portable Skill",
              path: skillPath,
              scope: "user",
              enabled: true,
              interface: { displayName: "Portable" },
              dependencies: { tools: [] },
            }],
            errors: [{ path: join(root, "broken", "SKILL.md"), message: "invalid frontmatter" }],
          }],
        };
      },
    };

    const snapshot = await listCodexNativeSkills({
      projectPath,
      extraRoots: [join(root, "skills"), join(root, "skills")],
      forceReload: true,
    }, { requester });

    expect(calls.map((call) => call.method)).toEqual(["skills/extraRoots/set", "skills/list"]);
    expect(calls[0].params).toEqual({ extraRoots: [resolve(join(root, "skills"))] });
    expect(calls[1].params).toEqual({ cwds: [resolve(projectPath)], forceReload: true });
    expect(snapshot.skills).toEqual([expect.objectContaining({
      name: "portable-skill",
      path: skillPath,
      scope: "user",
      enabled: true,
      contentHash: await hashNativeSkillPackageContent(dirname(skillPath)),
    })]);
    expect(snapshot.errors).toEqual([expect.objectContaining({ message: "invalid frontmatter" })]);
  });

  it("uses path-based Provider configuration and returns effective enablement", async () => {
    const projectPath = await directory("repo");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const result = await setCodexNativeSkillEnabled({
      projectPath,
      path: join(root, "skills", "portable-skill", "SKILL.md"),
      enabled: false,
    }, {
      requester: {
        async requestMetadata(method, params) {
          calls.push({ method, params });
          return { effectiveEnabled: false };
        },
      },
    });
    expect(result).toEqual({ effectiveEnabled: false });
    expect(calls).toEqual([{
      method: "skills/config/write",
      params: { path: join(root, "skills", "portable-skill", "SKILL.md"), enabled: false },
    }]);
  });

  it("fails closed when Codex does not return the requested cwd", async () => {
    const projectPath = await directory("repo");
    await expect(listCodexNativeSkills({ projectPath }, {
      requester: {
        async requestMetadata(method) {
          return method === "skills/list"
            ? { data: [{ cwd: join(root, "other"), skills: [], errors: [] }] }
            : {};
        },
      },
    })).rejects.toThrow("did not return the requested project cwd");
  });
});

describe("native Skill catalog and sidecar selections", () => {
  it("keeps Provider discovery authoritative and sidecar state selection-only", async () => {
    const projectPath = await directory("repo");
    const paths = resolveProjectRuntimePaths("demo-project", join(root, "aho-home"));
    await initializeProjectRuntimeSidecar(paths);
    const customRoot = await directory("custom-skills");
    const optionalPath = await createSkill(customRoot, "portable-skill");
    const harnessPath = await createSkill(join(projectPath, ".agents", "skills"), "demo-project-harness");
    await addSkillRoot(paths, customRoot);
    const snapshot = await snapshotFor(projectPath, [
      { name: "portable-skill", path: optionalPath, enabled: true, scope: "user" },
      { name: "demo-project-harness", path: harnessPath, enabled: true, scope: "repo" },
    ]);
    const harnessInput = {
      id: "demo-project-harness",
      path: harnessPath,
      contentHash: await hashProjectHarnessProviderContent(dirname(harnessPath)),
      source: "project-harness" as const,
      required: true,
    };

    const initial = await listSkills(paths, snapshot, [harnessInput]);
    expect(Object.keys(JSON.parse(JSON.stringify(initial.skills[0]))).sort()).toEqual([
      "compatibility",
      "contentHash",
      "description",
      "disabledTopics",
      "enabledProject",
      "enabledTopics",
      "name",
      "providerBindings",
      "providerEnabled",
      "required",
      "runtimeAssigned",
      "scope",
      "skillId",
      "sourceKind",
      "sourcePath",
    ].sort());
    expect(initial.skills.find((skill) => skill.skillId === "portable-skill")).toMatchObject({
      sourceKind: "custom",
      providerEnabled: true,
      required: false,
      runtimeAssigned: false,
    });
    expect(initial.skills.find((skill) => skill.skillId === "demo-project-harness")).toMatchObject({
      sourceKind: "project-harness",
      required: true,
    });
    await expect(setSkillEnabled(paths, snapshot, "demo-project-harness", { enabled: false }, [harnessInput]))
      .rejects.toThrow("assigned by the Runtime");

    await setSkillEnabled(paths, snapshot, "portable-skill", { enabled: true }, [harnessInput]);
    const context = await getEnabledSkillContext(paths, snapshot, undefined, [harnessInput]);
    expect(context.inputs).toEqual([
      expect.objectContaining({ id: "demo-project-harness", source: "project-harness", required: true }),
      expect.objectContaining({ id: "portable-skill", source: "provider-native", required: false }),
    ]);
    expect(context.promptSection).toContain("Native Skill Inputs");

    const disabled = await snapshotFor(projectPath, [
      { name: "portable-skill", path: optionalPath, enabled: false, scope: "user" },
      { name: "demo-project-harness", path: harnessPath, enabled: true, scope: "repo" },
    ]);
    const disabledContext = await getEnabledSkillContext(paths, disabled, undefined, [harnessInput]);
    expect(disabledContext.inputs).toEqual([expect.objectContaining({ id: "demo-project-harness" })]);
    expect(disabledContext.warnings).toContain("Selected Skill portable-skill is disabled in the Provider configuration.");
  });

  it("does not expose bundled runtime Skills as ordinary selections", async () => {
    const projectPath = await directory("repo");
    const paths = resolveProjectRuntimePaths("demo-project", join(root, "aho-home"));
    await initializeProjectRuntimeSidecar(paths);
    const systemPath = await createSkill(join(root, "system-skills"), "aho-harness-engineering");
    const snapshot = await snapshotFor(projectPath, [{
      name: "aho-harness-engineering",
      path: systemPath,
      enabled: true,
      scope: "system",
    }]);
    const catalog = await listSkills(paths, snapshot);
    expect(catalog.skills[0]).toMatchObject({ runtimeAssigned: true });
    await expect(setSkillEnabled(paths, snapshot, "aho-harness-engineering", { enabled: true }))
      .rejects.toThrow("assigned by the Runtime");
  });

  it("matches required Skill identity through a Junction or symlink alias", async () => {
    const projectPath = await directory("repo");
    const paths = resolveProjectRuntimePaths("demo-project", join(root, "aho-home"));
    await initializeProjectRuntimeSidecar(paths);
    const physicalPath = await createSkill(join(root, "physical-skills"), "demo-project-harness");
    const aliasRoot = join(root, "connector-harness");
    await symlink(dirname(physicalPath), aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = join(aliasRoot, "SKILL.md");
    const snapshot = await snapshotFor(projectPath, [{
      name: "demo-project-harness",
      path: aliasPath,
      enabled: true,
      scope: "repo",
    }]);
    const contentHash = await hashProjectHarnessProviderContent(dirname(physicalPath));

    const context = await getEnabledSkillContext(paths, snapshot, undefined, [{
      id: "demo-project-harness",
      path: aliasPath,
      contentHash,
      source: "project-harness",
      required: true,
    }]);

    expect(context.inputs).toEqual([expect.objectContaining({
      id: "demo-project-harness",
      path: await realpath(physicalPath),
      source: "project-harness",
      required: true,
    })]);
  });

  it("preserves same-name same-hash required Skills at distinct physical paths", async () => {
    const projectPath = await directory("repo");
    const paths = resolveProjectRuntimePaths("demo-project", join(root, "aho-home"));
    await initializeProjectRuntimeSidecar(paths);
    const firstPath = await createSkill(join(root, "required-one"), "shared-required-skill");
    const secondPath = await createSkill(join(root, "required-two"), "shared-required-skill");
    const firstHash = await hashNativeSkillPackageContent(dirname(firstPath));
    const secondHash = await hashNativeSkillPackageContent(dirname(secondPath));
    expect(firstHash).toBe(secondHash);
    const snapshot = await snapshotFor(projectPath, [
      { name: "shared-required-skill", path: firstPath, enabled: true, scope: "user" },
      { name: "shared-required-skill", path: secondPath, enabled: true, scope: "user" },
    ]);

    const context = await getEnabledSkillContext(paths, snapshot, undefined, [
      {
        id: "shared-required-skill",
        path: firstPath,
        contentHash: firstHash,
        source: "provider-native",
        required: true,
      },
      {
        id: "shared-required-skill",
        path: secondPath,
        contentHash: secondHash,
        source: "provider-native",
        required: true,
      },
    ]);

    expect(context.inputs).toHaveLength(2);
    expect(context.inputs.map((input) => input.path).sort()).toEqual([
      await realpath(firstPath),
      await realpath(secondPath),
    ].sort());
    for (const input of context.inputs) {
      expect(input).toMatchObject({
        id: "shared-required-skill",
        contentHash: firstHash,
        required: true,
      });
    }
  });

  it("reads legacy alias ids and converges subsequent writes to the canonical physical id", async () => {
    const projectPath = await directory("repo");
    const paths = resolveProjectRuntimePaths("demo-project", join(root, "aho-home"));
    await initializeProjectRuntimeSidecar(paths);
    const firstPath = await createSkill(join(root, "physical-skills"), "duplicate-skill");
    const secondPath = await createSkill(join(root, "other-skills"), "duplicate-skill");
    const aliasRoot = join(root, "legacy-alias");
    await symlink(dirname(firstPath), aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = join(aliasRoot, "SKILL.md");
    const snapshot = await snapshotFor(projectPath, [
      { name: "duplicate-skill", path: aliasPath, enabled: true, scope: "user" },
      { name: "duplicate-skill", path: firstPath, enabled: true, scope: "user" },
      { name: "duplicate-skill", path: secondPath, enabled: true, scope: "user" },
    ]);
    const legacyId = legacySkillId("duplicate-skill", aliasPath);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.skills.setSkillEnablement({
        projectId: paths.projectId,
        changeId: null,
        skillId: legacyId,
        scope: "project",
        enabled: true,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      database.close();
    }

    const listed = await listSkills(paths, snapshot);
    const selected = listed.skills.find((item) => item.enabledProject);
    expect(selected).toMatchObject({ enabledProject: true });
    await setSkillEnabled(paths, snapshot, legacyId, { enabled: false });
    const converged = await listSkills(paths, snapshot);
    expect(converged.skills.find((item) => item.skillId === selected!.skillId)).toMatchObject({
      enabledProject: false,
    });
    const reopened = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(reopened.skills.listSkillEnablement(paths.projectId)).toContainEqual(expect.objectContaining({
        skillId: selected!.skillId,
        enabled: false,
      }));
    } finally {
      reopened.close();
    }
  });

  it("deduplicates same-physical metadata conflicts independently of Provider order", async () => {
    const projectPath = await directory("repo");
    const physicalPath = await createSkill(join(root, "physical-conflict"), "conflict-skill");
    const aliasRoot = join(root, "conflict-alias");
    await symlink(dirname(physicalPath), aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const aliasPath = join(aliasRoot, "SKILL.md");
    const contentHash = await hashNativeSkillPackageContent(dirname(physicalPath));
    const left = {
      name: "conflict-skill",
      description: "A",
      path: physicalPath,
      enabled: true,
      scope: "user" as const,
      contentHash,
    };
    const right = { ...left, description: "B", path: aliasPath, enabled: false, scope: "repo" as const };
    const state = { roots: [], enablements: [] };
    const forward = buildSkillResolutionCatalog(
      { providerId: "codex", projectPath, skills: [left, right], errors: [] }, state);
    const reverse = buildSkillResolutionCatalog(
      { providerId: "codex", projectPath, skills: [right, left], errors: [] }, state);
    expect(forward.skills).toHaveLength(1);
    expect(forward.skills).toEqual(reverse.skills);
    expect(forward.skills[0]).toMatchObject({ catalogConflict: expect.any(String) });
  });

  it.each([
    {
      label: "missing",
      skills: [],
      inputHash: "expected-hash",
      expected: "was not discovered",
    },
    {
      label: "disabled",
      skills: [{ enabled: false }],
      inputHash: null,
      expected: "is disabled",
    },
    {
      label: "content drift",
      skills: [{ enabled: true }],
      inputHash: "stale-content-hash",
      expected: "content identity does not match",
    },
  ])("fails closed for a $label required project Harness", async ({ skills, inputHash, expected }) => {
    const projectPath = await directory("repo");
    const paths = resolveProjectRuntimePaths("demo-project", join(root, "aho-home"));
    await initializeProjectRuntimeSidecar(paths);
    const harnessPath = await createSkill(join(projectPath, ".agents", "skills"), "demo-project-harness");
    const discoveredHash = await hashProjectHarnessProviderContent(dirname(harnessPath));
    const snapshot = await snapshotFor(projectPath, skills.map(({ enabled }) => ({
      name: "demo-project-harness",
      path: harnessPath,
      enabled,
      scope: "repo" as const,
    })));
    await expect(getEnabledSkillContext(paths, snapshot, undefined, [{
      id: "demo-project-harness",
      path: harnessPath,
      contentHash: inputHash ?? discoveredHash,
      source: "project-harness",
      required: true,
    }])).rejects.toThrow(expected);
  });
});

async function directory(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  return path;
}

async function createSkill(parent: string, name: string): Promise<string> {
  const skillRoot = join(parent, name);
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: Test Skill.\n---\n`, "utf8");
  await writeFile(join(skillRoot, "references", "note.md"), "reference\n", "utf8");
  return join(skillRoot, "SKILL.md");
}

async function snapshotFor(
  projectPath: string,
  skills: Array<{ name: string; path: string; enabled: boolean; scope: "user" | "repo" | "system" | "admin" }>,
): Promise<ProviderSkillCatalogSnapshot> {
  return {
    providerId: "codex",
    projectPath,
    skills: await Promise.all(skills.map(async (skill) => ({
      ...skill,
      description: "Test Skill",
      contentHash: await hashNativeSkillPackageContent(dirname(skill.path)),
    }))),
    errors: [],
  };
}

function legacySkillId(name: string, path: string): string {
  const absolute = resolve(path);
  const normalized = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  return name + "-" + createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}
