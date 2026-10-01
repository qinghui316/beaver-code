import type { AsyncSurfaceState } from "../presentation/surface-state.js";
import type { UserFacingFailure } from "../presentation/user-facing-language.js";
import type { SkillRootListItem } from "../types.js";

export type SkillCatalogFilter = "all" | "enabled" | "project" | "provider" | "custom";

export interface SkillCatalogFilterViewModel {
  readonly id: SkillCatalogFilter;
  readonly label: string;
  readonly count: number;
}

export interface SkillCatalogCardViewModel {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly sourceLabel: string;
  readonly scopeLabel: string;
  readonly statusLabel: "已启用" | "未启用" | "项目必需" | "不可修改";
  readonly statusTone: "active" | "inactive" | "locked";
  readonly providerEnabled: boolean;
  readonly canChangeProviderEnabled: boolean;
  readonly lockReason: string | null;
  readonly runtimeStatusLabel: "可用" | "已关闭" | "不可用";
}

export interface SkillCatalogDiagnosticViewModel {
  readonly label: string;
  readonly detail: string;
}

export interface SkillsCatalogViewModel {
  readonly groups?: readonly SkillCatalogGroupViewModel[];
  readonly providers?: readonly { id: string; label: string }[];
  readonly providerId?: string | null;
  readonly sourceProjects?: readonly { id: string; label: string }[];
  readonly sourceProjectId?: string | null;
  readonly hasProject: boolean;
  readonly query: string;
  readonly filter: SkillCatalogFilter;
  readonly filters: readonly SkillCatalogFilterViewModel[];
  readonly totalCount: number;
  readonly state: AsyncSurfaceState<readonly SkillCatalogCardViewModel[]>;
  readonly selectedSkill: SkillCatalogCardViewModel | null;
  readonly roots: readonly SkillRootListItem[];
  readonly sourcePath: string;
  readonly sourcesOpen: boolean;
  readonly diagnosticsOpen: boolean;
  readonly diagnostics: readonly SkillCatalogDiagnosticViewModel[];
  readonly busy: boolean;
  readonly actionFailure: UserFacingFailure | null;
}

export interface SkillCatalogGroupViewModel {
  readonly id: string;
  readonly label: string;
  readonly state: "loading" | "ready" | "error";
  readonly failure?: string;
  readonly cards: readonly SkillCatalogCardViewModel[];
  readonly total: number;
  readonly page: number;
}

export interface SkillsSettingsSurface {
  readonly view: SkillsCatalogViewModel;
  readonly actions: {
    selectProvider?(providerId: string): void;
    selectSourceProject?(projectId: string): void;
    setGroupPage?(groupId: string, page: number): void;
    refresh(): Promise<void>;
    setQuery(query: string): void;
    setFilter(filter: SkillCatalogFilter): void;
    openSkill(skillId: string): void;
    closeSkill(): void;
    setProviderEnabled(skillId: string, enabled: boolean): Promise<void>;
    openSources(): void;
    closeSources(): void;
    setSourcePath(rootPath: string): void;
    addSource(rootPath: string): Promise<void>;
    openDiagnostics(): void;
    closeDiagnostics(): void;
  };
}
