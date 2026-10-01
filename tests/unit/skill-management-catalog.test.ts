import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillManagementCatalog } from "../../src/skill/management-catalog.js";
import { ProviderRegistry } from "../../src/provider-runtime/registry.js";
import type { ProviderDescriptor, ProviderNativeSkill } from "../../src/provider-runtime/contracts.js";
import type { SkillManagementPorts } from "../../src/skill/management-catalog.js";
import type { ManagedProject } from "../../src/types/index.js";
import type { ProjectRuntimeState } from "../../src/project-runtime/coordinator.js";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "aho-managed-skills-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const systemRoot = join(root, "system"); await mkdir(systemRoot);
  const skills: ProviderNativeSkill[] = [];
  const projects: ManagedProject[] = [];
  const listGlobal = vi.fn(async () => ({ providerId: "test", projectPath: root, skills: skills.map((item) => ({ ...item })), errors: [] }));
  const write = vi.fn(async ({ path, enabled }: { path: string; enabled: boolean }) => {
    for (const skill of skills) if (skill.path === path) skill.enabled = enabled;
    return { effectiveEnabled: enabled };
  });
  const list = vi.fn(async () => ({ providerId: "test", projectPath: root, skills, errors: [] }));
  const providers = new ProviderRegistry(); providers.register({ id: "test", skills: { listGlobal, list,
    configurationKey: () => root, setGlobalEnabled: write, setEnabled: write } } as unknown as ProviderDescriptor);
  const ports: SkillManagementPorts = { providers, systemRoot, listProjects: async () => projects,
    resolveProject: async (project) => ({ state: "onboarding", project, projectRoot: project.path,
      reservedProjectId: project.id, paths: resolveProjectRuntimePaths(project.id, { ahoHome: root }) }) };
  const service = new SkillManagementCatalog(ports);
  async function add(name: string, directory = name) {
    const path = join(root, directory, "SKILL.md"); await mkdir(join(root, directory), { recursive: true }); await writeFile(path, `---\nname: ${name}\ndescription: Test\n---\n`, "utf8");
    skills.push({ name, path, description: name, scope: "user", enabled: true, contentHash: "content" }); return path;
  }
  return { service, ports, skills, projects, write, list, listGlobal, add };
}
const scope = { kind: "global", providerId: "test" } as const;

describe("Skill management protection and configuration owner", () => {
  it("reads global Skills without resolving or initializing any project", async () => {
    const f = await fixture(); await f.add("portable"); const resolve = vi.spyOn(f.ports, "resolveProject");
    const catalog = await f.service.read(scope);
    expect(catalog.skills[0]?.canChangeProviderEnabled).toBe(true);
    expect(resolve).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
  });

  it("keeps same-name distinct sources and merges physical aliases", async () => {
    const f = await fixture(); const path = await f.add("same", "a"); await f.add("same", "b");
    await symlink(join(root, "a"), join(root, "alias"), "junction");
    f.skills.push({ ...f.skills[0]!, path: join(root, "alias", "SKILL.md") });
    const result = await f.service.read(scope);
    expect(result.skills).toHaveLength(2); expect(new Set(result.skills.map((item) => item.catalogId)).size).toBe(2);
    expect(result.skills.map((item) => item.sourcePath)).toContain(path);
  });

  it("protects another project's required physical source through an alias and renamed Skill", async () => {
    const f = await fixture(); const required = await f.add("renamed", "physical");
    await symlink(join(root, "physical"), join(root, "alias"), "junction");
    f.skills[0]!.path = join(root, "alias", "SKILL.md");
    f.projects.push({ id: "other", name: "Other", path: root } as ManagedProject);
    f.ports.resolveProject = async (project) => ({ state: "ready", project, resolution: { providerInput: { path: required } } } as ProjectRuntimeState);
    const item = (await f.service.read(scope)).skills[0]!;
    expect(item.required).toBe(true); expect(item.canChangeProviderEnabled).toBe(false);
    await expect(f.service.setEnabled(scope, item.skillId, { enabled: false })).rejects.toMatchObject({ name: "Conflict" });
    expect(f.write).not.toHaveBeenCalled();
  });

  it("protects runtime-required physical paths regardless of the discovered name", async () => {
    const f = await fixture(); await f.add("alias", "system/aho-main-orchestration");
    const item = (await f.service.read(scope)).skills[0]!;
    expect(item.required).toBe(true); expect(item.canChangeProviderEnabled).toBe(false);
  });

  it("keeps the catalog readable but fails closed when protection cannot be verified", async () => {
    const f = await fixture(); await f.add("portable"); f.projects.push({ id: "missing", name: "Missing", path: root } as ManagedProject);
    f.ports.resolveProject = async () => { throw new Error("unavailable"); };
    const result = await f.service.read(scope); expect(result.skills).toHaveLength(1);
    expect(result.errors).toHaveLength(1); expect(result.skills[0]!.canChangeProviderEnabled).toBe(false);
  });

  it("serializes competing expected-state writes and rejects the second stale window", async () => {
    const f = await fixture(); await f.add("portable"); const item = (await f.service.read(scope)).skills[0]!;
    const change = { enabled: false, expectedEnabled: true, sourceIdentity: item.sourceIdentity, expectedContentHash: item.contentHash };
    const results = await Promise.allSettled([f.service.setEnabled(scope, item.skillId, change), f.service.setEnabled(scope, item.skillId, change)]);
    expect(results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]); expect(f.write).toHaveBeenCalledTimes(1);
    await expect(f.service.setEnabled(scope, item.skillId, { ...change, expectedContentHash: "changed" })).rejects.toMatchObject({ name: "Conflict" });
  });
});
