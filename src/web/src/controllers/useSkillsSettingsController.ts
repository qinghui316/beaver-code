import { useCallback, useEffect, useRef, useState } from "react";
import { toUserFacingFailure, type UserFacingFailure } from "../presentation/user-facing-language.js";
import type { ProductMode, ProjectStatus, SkillListItem } from "../types.js";
import type { ManagedSkillCatalogItem } from "../../../types/skill-catalog.js";
import { projectSkillsCatalog } from "./skills-catalog-projection.js";
import type { SkillCatalogFilter, SkillsSettingsSurface } from "./skills-settings-contract.js";
import { skillsSettingsHttpPort, subscribeSkillCatalogChanges, type SkillsCatalogPayload, type SkillsSettingsIdentity, type SkillsSettingsPort } from "./skills-settings-http-adapter.js";

interface CatalogGroup {
  id: string; label: string; identity: SkillsSettingsIdentity;
  state: "loading" | "ready" | "error"; payload: SkillsCatalogPayload; failure?: string;
}

export function useSkillsSettingsController({ active, projectId, productMode, providerId, projects = [], providers = [],
  onRefresh, port = skillsSettingsHttpPort }: {
  active: boolean; projectId: string | null; productMode: ProductMode; conversationId: string | null;
  providerId: string | null; projects?: ProjectStatus[]; providers?: readonly { id: string; label: string }[];
  onRefresh: () => Promise<void>; port?: SkillsSettingsPort;
}): SkillsSettingsSurface {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(providerId ?? (providers.length === 1 ? providers[0]!.id : null));
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillCatalogFilter>("all");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(projectId);
  const [pages, setPages] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<UserFacingFailure | null>(null);
  const generation = useRef(0);
  const actionInFlight = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const registered = projects.flatMap((status) => status.project ? [{ id: status.project.id, label: status.project.name }] : []);
  if (projectId && !registered.some((project) => project.id === projectId)) registered.push({ id: projectId, label: projectId });
  const projectKey = JSON.stringify(registered);
  const scopeKey = `${selectedProvider ?? ""}\0${productMode}\0${projectKey}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  useEffect(() => { setSelectedProvider(providerId ?? (providers.length === 1 ? providers[0]!.id : null)); }, [providerId, providers.length === 1 ? providers[0]?.id : null]);

  const reload = useCallback(async (force = false): Promise<boolean> => {
    const token = ++generation.current;
    const key = scopeRef.current;
    const list = [{ id: "global", label: "通用技能", projectId: null as string | null },
      ...(JSON.parse(projectKey) as Array<{ id: string; label: string }>).map((project) => ({ ...project, projectId: project.id }))];
    const initial: CatalogGroup[] = list.map((item) => ({ id: item.id, label: item.label,
      identity: { projectId: item.projectId, productMode, conversationId: null, providerId: selectedProvider },
      state: "loading", payload: {} }));
    setGroups((previous) => initial.map((group) => {
      const saved = previous.find((item) => item.id === group.id && item.identity.providerId === selectedProvider && item.identity.productMode === productMode);
      return saved ? { ...group, payload: saved.payload } : group;
    }));
    const current = (): boolean => token === generation.current && key === scopeRef.current;
    let failed = false;
    const read = async (index: number): Promise<void> => {
      if (!current()) return;
      const group = initial[index]!;
      try {
        if (force) await port.refresh(group.identity);
        if (!current()) return;
        const payload = await port.load(group.identity);
        if (!payload || typeof payload !== "object") throw new Error("技能目录暂时无法读取。");
        const unreadable = (payload.errors?.length ?? 0) > 0 && (payload.skills?.length ?? 0) === 0;
        if (current()) setGroups((items) => items.map((item) => item.id === group.id ? { ...item,
          state: unreadable ? "error" : "ready", failure: unreadable ? "技能目录暂时无法读取。" : undefined, payload } : item));
      } catch (cause) {
        failed = true;
        if (current()) setGroups((items) => items.map((item) => item.id === group.id
          ? { ...item, state: "error", failure: toUserFacingFailure(cause, "load").summary } : item));
      }
    };
    await read(0);
    let cursor = 1;
    await Promise.all(Array.from({ length: Math.min(3, initial.length - 1) }, async () => {
      while (current() && cursor < initial.length) await read(cursor++);
    }));
    return current() && !failed;
  }, [port, productMode, projectKey, selectedProvider]);

  useEffect(() => {
    generation.current += 1;
    setGroups([]); setBusy(false); setSelectedSkillId(null); setSourcesOpen(false); setDiagnosticsOpen(false); setActionFailure(null); setPages({}); setSourcePath("");
    if (active) void reload(); else setGroups([]);
    return () => { generation.current += 1; };
  }, [active, scopeKey, reload]);

  useEffect(() => {
    if (!active) return;
    return subscribeSkillCatalogChanges((providerId) => {
      if ((!providerId || !selectedProvider || providerId === selectedProvider) && !actionInFlight.current) void reload();
    });
  }, [active, reload, selectedProvider]);

  const entries = new Map<string, { group: CatalogGroup; item: SkillListItem }>();
  const projected = groups.map((group) => {
    const skills = (group.payload.skills ?? []).filter((item) => group.id === "global"
      || item.scope === "repo" || item.sourceKind !== "provider-native");
    const projection = projectSkillsCatalog({ hasProject: Boolean(group.identity.projectId), resolved: true,
      loading: false, skills, roots: group.payload.roots ?? [], catalogErrors: group.payload.errors ?? [],
      failure: null, actionFailure: null, query: query && group.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? "" : query,
      filter: filter === "project" || filter === "provider" ? "all" : filter, conversationId: null, selectedSkillId: null, sourcePath: "", sourcesOpen: false, diagnosticsOpen: false, busy });
    const excluded = filter === "project" && group.id === "global" || filter === "provider" && group.id !== "global";
    const cards = !excluded && projection.state.status === "ready" ? projection.state.data.map((card) => {
      const item = skills.find((skill) => skill.skillId === card.skillId)!;
      const id = (item as Partial<ManagedSkillCatalogItem>).catalogId ?? `${group.id}:${card.skillId}`;
      entries.set(id, { group, item });
      return { ...card, skillId: id, scopeLabel: group.label };
    }) : [];
    return { group, projection, cards };
  });
  const cards = projected.flatMap((item) => item.cards);
  const sourceGroup = groups.find((group) => group.identity.projectId === sourceProjectId);
  const diagnostics = projected.flatMap(({ group, projection }) => [
    ...projection.diagnostics,
    ...(group.failure ? [{ label: group.label, detail: group.failure }] : []),
  ]);
  const total = projected.reduce((count, item) => count + item.projection.totalCount, 0);
  const filters = (["all", "enabled", "project", "provider", "custom"] as const).map((id) => ({ id,
    label: ({ all: "全部", enabled: "已启用", project: "项目技能", provider: "通用技能", custom: "自定义" })[id],
    count: projected.reduce((count, item) => count + (id === "project" || id === "provider"
      ? (item.group.id === "global") === (id === "provider") ? item.projection.totalCount : 0
      : item.projection.filters.find((value) => value.id === id)?.count ?? 0), 0) }));

  async function run(operation: () => Promise<void>, savedNotice: boolean, refreshOnly = false): Promise<void> {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const key = scopeRef.current;
    setBusy(true); setActionFailure(null);
    let saved = false;
    try {
      await operation(); saved = true;
      if (scopeRef.current !== key) return;
      const refreshed = await reload(refreshOnly);
      if (!refreshed && savedNotice && scopeRef.current === key) setActionFailure({ summary: "配置已保存，目录刷新失败。", recoveryAction: "可以重新检测目录。" });
      if (!refreshOnly && scopeRef.current === key) await onRefreshRef.current();
    } catch (cause) {
      if (scopeRef.current === key) setActionFailure(saved
        ? { summary: "配置已保存，目录刷新失败。", recoveryAction: "可以重新检测目录。" } : toUserFacingFailure(cause, "settings"));
    } finally { actionInFlight.current = false; setBusy(false); }
  }

  return { view: {
    hasProject: registered.length > 0, query, filter, filters, totalCount: total,
    state: cards.length ? { status: "ready", data: cards }
      : groups.some((group) => group.state === "loading") ? { status: "loading" }
      : { status: "empty", title: query ? "没有匹配的技能" : "还没有发现技能", actions: [{ id: "retry", label: "重新检测", emphasis: "primary" }] },
    groups: projected.map(({ group, cards: items }) => { const page = Math.max(0, Math.min(pages[group.id] ?? 0, Math.ceil(items.length / 50) - 1));
      return { id: group.id, label: group.label, state: group.state, failure: group.failure, total: items.length,
        page, cards: items.slice(page * 50, page * 50 + 50) }; }),
    providers, providerId: selectedProvider, sourceProjects: registered, sourceProjectId,
    selectedSkill: cards.find((card) => card.skillId === selectedSkillId) ?? null,
    roots: sourceGroup?.payload.roots ?? [], sourcePath, sourcesOpen, diagnosticsOpen, diagnostics, busy, actionFailure,
  }, actions: {
    refresh: async () => { await run(async () => undefined, false, true); },
    selectProvider: setSelectedProvider, selectSourceProject: setSourceProjectId,
    setGroupPage: (id, page) => setPages((current) => ({ ...current, [id]: page })),
    setQuery: (value) => { setQuery(value); setPages({}); }, setFilter: (value) => { setFilter(value); setPages({}); },
    openSkill: setSelectedSkillId, closeSkill: () => { if (!actionInFlight.current) setSelectedSkillId(null); },
    setProviderEnabled: async (id, enabled) => {
      const entry = entries.get(id);
      if (!entry) return;
      await run(() => port.setProviderEnabled({ ...entry.group.identity,
        providerId: entry.group.payload.scope?.providerId ?? selectedProvider }, entry.item.skillId, enabled,
      "sourceIdentity" in entry.item ? entry.item as ManagedSkillCatalogItem : undefined), true);
    },
    openSources: () => setSourcesOpen(true), closeSources: () => { if (!actionInFlight.current) setSourcesOpen(false); },
    setSourcePath,
    addSource: async (rootPath) => {
      if (!sourceGroup) { setActionFailure({ summary: "请选择来源所属的项目。" }); return; }
      await run(() => port.addSource(sourceGroup.identity, rootPath.trim()), true);
    },
    openDiagnostics: () => setDiagnosticsOpen(true), closeDiagnostics: () => setDiagnosticsOpen(false),
  } };
}
