import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedProject } from "../types/index.js";
import type { ProviderRegistry } from "../provider-runtime/registry.js";
import type { ProjectRuntimeState } from "../project-runtime/coordinator.js";
import type { ManagedSkillCatalog, ManagedSkillCatalogItem, SkillCatalogScope, SkillConfigurationChange } from "../types/skill-catalog.js";
import { buildSkillCatalog, isRuntimeAssignedSkill, listSkillRoots, listSkills } from "./catalog.js";
import { resolveSkillPathIdentity } from "./path-identity.js";

export interface SkillManagementPorts {
  providers: ProviderRegistry;
  listProjects(): Promise<ManagedProject[]>;
  resolveProject(project: ManagedProject): Promise<ProjectRuntimeState>;
  systemRoot: string;
}

const configurationWrites = new Map<string, Promise<unknown>>();
const configurationListeners = new Set<(providerId: string) => void>();

export function subscribeSkillConfiguration(listener: (providerId: string) => void): () => void {
  configurationListeners.add(listener);
  return () => { configurationListeners.delete(listener); };
}

/** Discovery and global config mutations share this owner; execution selection is separate. */
export class SkillManagementCatalog {
  constructor(private readonly ports: SkillManagementPorts) {}

  async read(scope: SkillCatalogScope, forceReload = false): Promise<ManagedSkillCatalog> {
    const provider = this.ports.providers.get(scope.providerId);
    let catalog;
    if (scope.kind === "global") {
      if (!provider.skills.listGlobal) throw new Error("此 AI 服务暂不支持通用技能目录。");
      const snapshot = await provider.skills.listGlobal({ forceReload });
      catalog = buildSkillCatalog(snapshot, { roots: [], enablements: [] });
    } else {
      const project = await this.project(scope.projectId);
      const state = await this.ports.resolveProject(project);
      const paths = state.state === "onboarding" ? state.paths : state.resolution.paths;
      const roots = state.state === "onboarding" ? [] : await listSkillRoots(paths);
      const snapshot = await provider.skills.list({ projectPath: project.path,
        extraRoots: [this.ports.systemRoot, ...roots.map((root) => root.rootPath)], forceReload });
      const identityInputs = state.state === "onboarding" ? [] : [state.resolution.providerInput];
      // Management must still show a disabled required source so it can be diagnosed.
      catalog = state.state === "onboarding"
        ? buildSkillCatalog(snapshot, { roots: [], enablements: [] })
        : await listSkills(paths, snapshot, [], identityInputs);
    }
    const protection = await this.protection();
    return { scope, roots: catalog.roots, errors: [...catalog.errors, ...protection.errors],
      skills: catalog.skills.map((skill) => {
        const path = resolveSkillPathIdentity(skill.sourcePath);
        const identity = path.ok ? path.value.identity : skill.sourcePath;
        const sourceIdentity = digest(`${scope.providerId}\0${identity}`);
        const required = path.ok && protection.paths.has(path.value.identity);
        const lockReason = scope.kind === "global" && !provider.skills.setGlobalEnabled ? "此 AI 服务暂不支持修改通用技能配置。"
          : !path.ok ? "技能来源暂时无法验证。"
          : skill.runtimeAssigned || skill.required || required ? "此技能由项目或运行时使用，不能在这里关闭。"
          : protection.errors.length > 0 ? "项目必需来源尚未完成校验。" : null;
        return { ...skill, required: skill.required || required, sourceIdentity,
          catalogId: digest(`${scope.kind}\0${scope.kind === "project" ? scope.projectId : ""}\0${sourceIdentity}`),
          catalogScope: scope, canChangeProviderEnabled: !lockReason, lockReason };
      }) };
  }

  async setEnabled(scope: SkillCatalogScope, skillId: string, change: SkillConfigurationChange): Promise<{ saved: true }> {
    const provider = this.ports.providers.get(scope.providerId);
    const key = provider.skills.configurationKey?.() ?? provider.id;
    const previous = configurationWrites.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const before = await this.read(scope, true);
      const item = before.skills.find((skill) => change.sourceIdentity
        ? skill.sourceIdentity === change.sourceIdentity && skill.skillId === skillId
        : skill.skillId === skillId);
      if (!item) throw conflict("技能目录已变化，请重新检测后重试。");
      if (!item.canChangeProviderEnabled) throw conflict(item.lockReason ?? "此技能不能修改。");
      if ((change.expectedEnabled !== undefined && item.providerEnabled !== change.expectedEnabled)
        || (change.expectedContentHash !== undefined && item.contentHash !== change.expectedContentHash)) {
        throw conflict("技能配置已变化，请重新读取后重试。");
      }
      const path = resolveSkillPathIdentity(item.sourcePath);
      if (!path.ok || digest(`${scope.providerId}\0${path.value.identity}`) !== item.sourceIdentity) {
        throw conflict("技能来源已变化，请重新检测后重试。");
      }
      const result = scope.kind === "global"
        ? await provider.skills.setGlobalEnabled!({ path: path.value.canonicalPath, enabled: change.enabled })
        : await provider.skills.setEnabled({ projectPath: (await this.project(scope.projectId)).path,
          path: path.value.canonicalPath, enabled: change.enabled });
      if (result.effectiveEnabled !== change.enabled) throw conflict("AI 服务未确认技能配置，请重新读取。");
      for (const listener of configurationListeners) {
        try { listener(scope.providerId); } catch { /* Saved config must not depend on subscribers. */ }
      }
      return { saved: true as const };
    });
    configurationWrites.set(key, next);
    void next.finally(() => { if (configurationWrites.get(key) === next) configurationWrites.delete(key); }).catch(() => undefined);
    return next;
  }

  private async project(projectId: string): Promise<ManagedProject> {
    const project = (await this.ports.listProjects()).find((item) => item.id === projectId);
    if (!project) throw conflict("项目已移除，请刷新目录。");
    return project;
  }

  private async protection(): Promise<{ paths: Set<string>; errors: Array<{ path: string; message: string }> }> {
    const paths = new Set<string>();
    const errors: Array<{ path: string; message: string }> = [];
    try {
      for (const name of await readdir(this.ports.systemRoot)) {
        if (!isRuntimeAssignedSkill(name)) continue;
        const path = resolveSkillPathIdentity(join(this.ports.systemRoot, name, "SKILL.md"));
        if (!path.ok) throw new Error(path.message);
        paths.add(path.value.identity);
      }
    } catch { errors.push({ path: this.ports.systemRoot, message: "运行时必需技能来源暂时无法验证。" }); }
    for (const project of await this.ports.listProjects()) {
      try {
        const state = await this.ports.resolveProject(project);
        if (state.state === "onboarding") continue;
        const path = resolveSkillPathIdentity(state.resolution.providerInput.path);
        if (!path.ok) throw new Error(path.message);
        paths.add(path.value.identity);
      } catch {
        errors.push({ path: project.path, message: "项目必需技能来源暂时无法验证。" });
      }
    }
    return { paths, errors };
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function conflict(message: string): Error { const error = new Error(message); error.name = "Conflict"; return error; }

export function projectCatalogEntries(items: readonly ManagedSkillCatalogItem[]): ManagedSkillCatalogItem[] {
  return items.filter((item) => item.scope === "repo" || item.sourceKind !== "provider-native");
}
