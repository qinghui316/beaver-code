import type { AsyncSurfaceState } from "../presentation/surface-state.js";
import { sanitizeTechnicalDetail, type UserFacingFailure } from "../presentation/user-facing-language.js";
import type { SkillListItem, SkillRootListItem, SkillSourceKind } from "../types.js";
import type {
  SkillCatalogCardViewModel,
  SkillCatalogDiagnosticViewModel,
  SkillCatalogFilter,
  SkillCatalogFilterViewModel,
  SkillsCatalogViewModel,
} from "./skills-settings-contract.js";

const filters: readonly { id: SkillCatalogFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "enabled", label: "已启用" },
  { id: "project", label: "项目技能" },
  { id: "provider", label: "Agent 技能" },
  { id: "custom", label: "自定义" },
];

export interface SkillsCatalogProjectionInput {
  readonly hasProject: boolean;
  readonly resolved: boolean;
  readonly loading: boolean;
  readonly skills: readonly SkillListItem[];
  readonly roots: readonly SkillRootListItem[];
  readonly catalogErrors: readonly { path: string; message: string }[];
  readonly failure: UserFacingFailure | null;
  readonly actionFailure: UserFacingFailure | null;
  readonly query: string;
  readonly filter: SkillCatalogFilter;
  readonly conversationId: string | null;
  readonly selectedSkillId: string | null;
  readonly sourcePath: string;
  readonly sourcesOpen: boolean;
  readonly diagnosticsOpen: boolean;
  readonly busy: boolean;
}

export function projectSkillsCatalog(input: SkillsCatalogProjectionInput): SkillsCatalogViewModel {
  const uniqueSkills = deduplicateSkills(input.skills);
  const cards = uniqueSkills.map((skill) => projectSkillCard(skill, input.conversationId));
  const normalizedQuery = input.query.trim().toLocaleLowerCase();
  const filteredCards = cards.filter((card) => matchesFilter(card, uniqueSkills, input.filter)
    && (!normalizedQuery || [card.name, card.description, card.sourceLabel].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))));
  const filterViewModels: SkillCatalogFilterViewModel[] = filters.map((filter) => ({
    ...filter,
    count: cards.filter((card) => matchesFilter(card, uniqueSkills, filter.id)).length,
  }));
  const state = projectState(input, filteredCards);

  return {
    hasProject: input.hasProject,
    query: input.query,
    filter: input.filter,
    filters: filterViewModels,
    totalCount: cards.length,
    state,
    selectedSkill: filteredCards.find((card) => card.skillId === input.selectedSkillId) ?? null,
    roots: input.roots,
    sourcePath: input.sourcePath,
    sourcesOpen: input.sourcesOpen,
    diagnosticsOpen: input.diagnosticsOpen,
    diagnostics: input.catalogErrors.map(projectDiagnostic),
    busy: input.busy,
    actionFailure: input.actionFailure,
  };
}

function projectState(
  input: SkillsCatalogProjectionInput,
  cards: readonly SkillCatalogCardViewModel[],
): AsyncSurfaceState<readonly SkillCatalogCardViewModel[]> {
  if (!input.resolved || input.loading) return { status: "loading" };
  if (input.failure && input.skills.length === 0) {
    return { status: "error", failure: input.failure, actions: [{ id: "retry", label: "重新加载", emphasis: "primary" }] };
  }
  if (cards.length === 0) {
    const narrowed = Boolean(input.query.trim()) || input.filter !== "all";
    return {
      status: "empty",
      title: narrowed ? "没有匹配的技能" : "还没有发现技能",
      description: narrowed ? "可以更换关键词或筛选条件。" : "重新检测后会显示当前项目可用的技能。",
      actions: narrowed
        ? [{ id: "clear-filter", label: "查看全部技能", emphasis: "secondary" }]
        : [{ id: "retry", label: "重新检测", emphasis: "primary" }],
    };
  }
  return { status: "ready", data: cards };
}

function deduplicateSkills(skills: readonly SkillListItem[]): readonly SkillListItem[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.skillId)) return false;
    seen.add(skill.skillId);
    return true;
  });
}

function projectSkillCard(skill: SkillListItem, conversationId: string | null): SkillCatalogCardViewModel {
  const enabled = skill.providerEnabled
    || skill.required
    || skill.runtimeAssigned
    || skill.enabledProject
    || Boolean(conversationId && skill.enabledTopics.includes(conversationId));
  const lockReason = skill.required
    ? "这是当前项目需要的技能，不能在这里关闭。"
    : skill.runtimeAssigned
      ? "当前运行流程正在使用此技能，不能在这里关闭。"
      : skill.sourceKind === "project-harness"
        ? "此技能由项目协作配置管理，不能在这里关闭。"
        : null;
  const bindingStatus = skill.providerBindings[0]?.status;
  return {
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description.trim() || "暂无说明",
    sourceLabel: sourceKindLabel(skill.sourceKind),
    scopeLabel: scopeLabel(skill.scope),
    statusLabel: lockReason ? "项目必需" : enabled ? "已启用" : "未启用",
    statusTone: lockReason ? "locked" : enabled ? "active" : "inactive",
    providerEnabled: skill.providerEnabled,
    canChangeProviderEnabled: lockReason === null,
    lockReason,
    runtimeStatusLabel: bindingStatus === "ready" ? "可用" : bindingStatus === "disabled" ? "已关闭" : "不可用",
  };
}

function matchesFilter(
  card: SkillCatalogCardViewModel,
  skills: readonly SkillListItem[],
  filter: SkillCatalogFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "enabled") return card.statusTone !== "inactive";
  const skill = skills.find((item) => item.skillId === card.skillId);
  if (!skill) return false;
  if (filter === "project") return skill.sourceKind === "project-harness" || skill.scope === "repo";
  if (filter === "provider") return skill.sourceKind === "provider-native";
  return skill.sourceKind === "custom";
}

function sourceKindLabel(kind: SkillSourceKind): string {
  if (kind === "system-aho") return "AHO 内置技能";
  if (kind === "provider-native") return "当前 Agent 的本机技能";
  if (kind === "project-harness") return "项目技能";
  return "自定义来源";
}

function scopeLabel(scope: SkillListItem["scope"]): string {
  if (scope === "repo") return "当前项目";
  if (scope === "user") return "当前用户";
  if (scope === "system") return "系统";
  return "管理员";
}

function projectDiagnostic(error: { path: string; message: string }): SkillCatalogDiagnosticViewModel {
  return { label: safePathLabel(error.path), detail: sanitizeTechnicalDetail(error.message) };
}

function safePathLabel(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return "技能目录";
  return parts.length === 1 ? parts[0]! : `…/${parts.slice(-2).join("/")}`;
}
