import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { CheckCircle2, CircleAlert, Folder, RefreshCw, Search, Settings2, Sparkles, X } from "lucide-react";
import { fetchJson, postJson } from "../api.js";
import { DialogSurface } from "../presentation/DialogSurface.js";
import type { AsyncSurfaceState } from "../presentation/surface-state.js";
import { sanitizeTechnicalDetail, toUserFacingFailure, type UserFacingFailure } from "../presentation/user-facing-language.js";
import type { ProductMode, SkillListItem, SkillRootListItem } from "../types.js";

type SkillGroupId = "enabled" | "project" | "provider" | "custom";
const groupOrder: SkillGroupId[] = ["enabled", "project", "provider", "custom"];

export function SkillsSettingsView({ projectId, productMode, conversationId, providerId, onRefresh }: {
  projectId: string | null;
  productMode: ProductMode;
  conversationId: string | null;
  providerId: string | null;
  onRefresh: () => Promise<void>;
}): ReactElement {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [roots, setRoots] = useState<SkillRootListItem[]>([]);
  const [rootPath, setRootPath] = useState("");
  const [query, setQuery] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [sourceManagerOpen, setSourceManagerOpen] = useState(false);
  const [catalogDiagnosticsOpen, setCatalogDiagnosticsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [resolvedIdentityKey, setResolvedIdentityKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<UserFacingFailure | null>(null);
  const [catalogErrors, setCatalogErrors] = useState<Array<{ path: string; message: string }>>([]);
  const requestGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const diagnosticsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const identityKey = skillSettingsIdentityKey(projectId, productMode, conversationId, providerId);
  const identityKeyRef = useRef(identityKey);
  identityKeyRef.current = identityKey;
  const identityResolved = resolvedIdentityKey === identityKey;
  const visibleSkills = identityResolved ? skills : [];
  const visibleRoots = identityResolved ? roots : [];
  const visibleFailure = identityResolved ? failure : null;
  const visibleCatalogErrors = identityResolved ? catalogErrors : [];

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return visibleSkills;
    return visibleSkills.filter((skill) => [skill.name, skill.skillId, skill.description, sourceKindLabel(skill.sourceKind), scopeLabel(skill.scope)].some((value) => value.toLowerCase().includes(normalized)));
  }, [query, visibleSkills]);
  const groupedSkills = useMemo(() => groupOrder.map((id) => ({ id, items: filteredSkills.filter((skill) => skillGroup(skill, conversationId) === id) })).filter((group) => group.items.length > 0), [filteredSkills, conversationId]);
  const selectedSkill = filteredSkills.find((skill) => skill.skillId === selectedSkillId) ?? null;
  const selectedTarget = selectedSkill?.providerBindings[0];

  useEffect(() => {
    if (selectedSkillId && !filteredSkills.some((skill) => skill.skillId === selectedSkillId)) setSelectedSkillId(null);
  }, [filteredSkills, selectedSkillId]);

  async function load(): Promise<void> {
    const generation = ++requestGenerationRef.current;
    const requestIdentityKey = identityKey;
    if (!projectId) {
      if (generation === requestGenerationRef.current && requestIdentityKey === identityKeyRef.current) {
        setSkills([]); setRoots([]); setSelectedSkillId(null); setCatalogErrors([]);
        setResolvedIdentityKey(requestIdentityKey);
      }
      return;
    }
    const params = skillSearchParams(productMode, conversationId, providerId);
    const payload = await fetchJson<{ roots?: SkillRootListItem[]; skills?: SkillListItem[]; errors?: Array<{ path: string; message: string }> }>(`/api/projects/${encodeURIComponent(projectId)}/skills?${params.toString()}`);
    if (generation !== requestGenerationRef.current || requestIdentityKey !== identityKeyRef.current) return;
    const nextSkills = Array.isArray(payload.skills) ? payload.skills : [];
    setRoots(Array.isArray(payload.roots) ? payload.roots : []);
    setSkills(nextSkills);
    setCatalogErrors(Array.isArray(payload.errors) ? payload.errors : []);
    setSelectedSkillId((current) => current && nextSkills.some((skill) => skill.skillId === current) ? current : null);
    setResolvedIdentityKey(requestIdentityKey);
  }

  useEffect(() => {
    actionGenerationRef.current += 1;
    setBusy(false); setLoading(true); setFailure(null); setQuery(""); setRootPath(""); setSkills([]); setRoots([]); setCatalogErrors([]); setSelectedSkillId(null); setSourceManagerOpen(false); setCatalogDiagnosticsOpen(false);
    const requestIdentityKey = identityKey;
    const requestGeneration = requestGenerationRef.current + 1;
    load().then(() => {
      if (requestGeneration === requestGenerationRef.current && requestIdentityKey === identityKeyRef.current) setLoading(false);
    }).catch((cause: unknown) => {
      if (requestGeneration === requestGenerationRef.current && requestIdentityKey === identityKeyRef.current) {
        setLoading(false);
        setFailure(toUserFacingFailure(cause, "load"));
        setResolvedIdentityKey(requestIdentityKey);
      }
    });
    return () => { requestGenerationRef.current += 1; actionGenerationRef.current += 1; };
  }, [projectId, productMode, conversationId, providerId]);

  async function run(action: () => Promise<void>): Promise<boolean> {
    if (!projectId) return false;
    const generation = ++actionGenerationRef.current;
    const actionIdentityKey = identityKey;
    setBusy(true); setFailure(null);
    try {
      await action();
      if (generation !== actionGenerationRef.current || actionIdentityKey !== identityKeyRef.current) return false;
      await load();
      if (generation !== actionGenerationRef.current || actionIdentityKey !== identityKeyRef.current) return false;
      await onRefresh();
      return generation === actionGenerationRef.current && actionIdentityKey === identityKeyRef.current;
    } catch (cause) {
      if (generation === actionGenerationRef.current && actionIdentityKey === identityKeyRef.current) setFailure(toUserFacingFailure(cause, "settings"));
      return false;
    } finally {
      if (generation === actionGenerationRef.current && actionIdentityKey === identityKeyRef.current) setBusy(false);
    }
  }

  function retryLoad(): void {
    const requestIdentityKey = identityKey;
    const requestGeneration = requestGenerationRef.current + 1;
    setLoading(true);
    setFailure(null);
    void load().then(() => {
      if (requestGeneration === requestGenerationRef.current && requestIdentityKey === identityKeyRef.current) setLoading(false);
    }).catch((cause: unknown) => {
      if (requestGeneration === requestGenerationRef.current && requestIdentityKey === identityKeyRef.current) {
        setLoading(false);
        setFailure(toUserFacingFailure(cause, "load"));
        setResolvedIdentityKey(requestIdentityKey);
      }
    });
  }

  const listState: AsyncSurfaceState<typeof groupedSkills> = !identityResolved || loading
    ? { status: "loading" }
    : visibleFailure && groupedSkills.length === 0
      ? { status: "error", failure: visibleFailure, actions: [{ id: "retry", label: "重新加载", emphasis: "primary" }] }
      : groupedSkills.length === 0
        ? {
            status: "empty",
            title: query ? "没有匹配的技能" : "还没有发现技能",
            description: query ? "可以换一个关键词，或清除搜索后查看全部技能。" : "重新检测后会显示当前项目可用的技能。",
            actions: query ? [{ id: "clear-search", label: "清除搜索", emphasis: "secondary" }] : [{ id: "retry", label: "重新检测", emphasis: "primary" }],
          }
        : { status: "ready", data: groupedSkills };

  if (!projectId) return <section className="settings-empty-state"><Sparkles size={24} /><h3>选择项目后管理技能</h3><p>在这里查看和启用当前项目可用的技能。</p></section>;

  return (
    <section className="skills-settings-view" aria-label="技能设置">
      <header className="skills-page-toolbar">
        <label className="skills-search"><Search size={16} aria-hidden="true" /><span className="sr-only">搜索技能</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、说明或来源" aria-label="搜索技能" />{query ? <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button> : null}</label>
        <button className="outline-button" disabled={busy} onClick={() => run(async () => { await postJson(`/api/projects/${encodeURIComponent(projectId)}/skills`, skillRequestBody(productMode, conversationId, providerId)); })}><RefreshCw size={14} className={busy ? "spin" : undefined} />刷新</button>
        <button ref={sourceTriggerRef} className="icon-button" aria-label="技能来源设置" title="技能来源设置" onClick={() => setSourceManagerOpen(true)}><Settings2 size={16} /></button>
      </header>

      {visibleCatalogErrors.length > 0 && listState.status !== "loading" && listState.status !== "error" ? <div className="skills-catalog-warning" role="status"><CircleAlert size={16} /><span>有 {visibleCatalogErrors.length} 个技能无法读取。</span><button ref={diagnosticsTriggerRef} type="button" onClick={() => setCatalogDiagnosticsOpen(true)}>查看诊断</button></div> : null}
      {visibleFailure && groupedSkills.length > 0 ? <div className="skills-state-notice" role="alert"><CircleAlert size={16} /><div><strong>{visibleFailure.summary}</strong>{visibleFailure.recoveryAction ? <span>{visibleFailure.recoveryAction}</span> : null}</div></div> : null}

      <div className="skills-settings-list" role="list" aria-label="技能列表">
        {listState.status === "loading" ? <div className="skills-empty-results" role="status"><RefreshCw size={22} className="spin" /><strong>正在加载技能…</strong></div> : listState.status === "error" ? <div className="skills-empty-results" role="alert"><CircleAlert size={22} /><strong>{listState.failure.summary}</strong>{listState.failure.recoveryAction ? <span>{listState.failure.recoveryAction}</span> : null}<button className="primary-button" onClick={retryLoad}>重新加载</button></div> : listState.status === "empty" ? <div className="skills-empty-results"><Sparkles size={22} /><strong>{listState.title}</strong>{listState.description ? <span>{listState.description}</span> : null}<button className={listState.actions[0]?.emphasis === "primary" ? "primary-button" : "outline-button"} onClick={() => listState.actions[0]?.id === "clear-search" ? setQuery("") : retryLoad()}>{listState.actions[0]?.label}</button></div> : listState.data.map((group) => <section className="skills-group" key={group.id} aria-labelledby={`skill-group-${group.id}`}><header><h3 id={`skill-group-${group.id}`}>{skillGroupLabel(group.id)}</h3><span>{group.items.length}</span></header><div className="skills-group-grid">{group.items.map((skill) => {
          const active = skill.providerEnabled || skill.required || skill.runtimeAssigned || skill.enabledProject || (conversationId ? skill.enabledTopics.includes(conversationId) : false);
          return <button key={skill.skillId} type="button" className="skills-settings-list-item" onClick={(event) => { detailTriggerRef.current = event.currentTarget; setSelectedSkillId(skill.skillId); }}>
            <span className="skill-list-icon"><Sparkles size={16} /></span><span className="skill-list-main"><strong>{skill.name}</strong><small>{skill.description || "暂无说明"}</small><span className="skill-list-source">{sourceKindLabel(skill.sourceKind)}</span></span><span className={`skill-enabled-indicator ${active ? "active" : ""}`} aria-label={active ? "已启用" : "未启用"}>{active ? <CheckCircle2 size={16} /> : <span />}</span>
          </button>;
        })}</div></section>)}
      </div>

      <DialogSurface open={identityResolved && Boolean(selectedSkill)} onClose={() => setSelectedSkillId(null)} ariaLabel={selectedSkill ? `${selectedSkill.name} 详情` : "技能详情"} panelClassName="settings-panel skill-detail-drawer" returnFocusRef={detailTriggerRef}>
        {selectedSkill ? <>
        <header className="settings-panel-header"><div className="skill-detail-title"><span className="skill-list-icon"><Sparkles size={18} /></span><div><p className="eyebrow">{sourceKindLabel(selectedSkill.sourceKind)}</p><h2>{selectedSkill.name}</h2></div></div><button className="icon-button" aria-label="关闭技能详情" onClick={() => setSelectedSkillId(null)}><X size={16} /></button></header>
        <p className="skill-detail-description">{selectedSkill.description || "当前技能没有提供说明。"}</p>
        <dl className="settings-definition-list compact"><div><dt>来源</dt><dd>{sourceKindLabel(selectedSkill.sourceKind)}</dd></div><div><dt>作用域</dt><dd>{scopeLabel(selectedSkill.scope)}</dd></div><div><dt>状态</dt><dd>{runtimeStatusLabel(selectedTarget?.status)}</dd></div></dl>
        {selectedSkill.required || selectedSkill.runtimeAssigned ? <div className="skill-required-note"><CheckCircle2 size={16} /><div><strong>项目必需</strong><p>由当前项目或 AHO 流程管理，不能在这里关闭。</p></div></div> : <label className="settings-toggle-row prominent"><span><strong>为当前 Agent 启用</strong><small>后续会话可以选择使用此技能。</small></span><input type="checkbox" checked={selectedSkill.providerEnabled} disabled={busy || selectedSkill.sourceKind === "project-harness"} onChange={(event) => run(async () => { await postJson(`/api/projects/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(selectedSkill.skillId)}/provider-enable`, { enabled: event.target.checked, ...skillRequestBody(productMode, conversationId, providerId) }); })} /></label>}
        </> : null}
      </DialogSurface>

      <DialogSurface open={identityResolved && sourceManagerOpen} onClose={() => setSourceManagerOpen(false)} ariaLabel="技能来源设置" panelClassName="settings-panel skill-source-drawer" returnFocusRef={sourceTriggerRef}>
        <header className="settings-panel-header"><div><p className="eyebrow">高级</p><h2>技能来源</h2></div><button className="icon-button" aria-label="关闭技能来源设置" onClick={() => setSourceManagerOpen(false)}><X size={16} /></button></header>
        <p className="muted-copy">添加受信任的本机目录，让当前项目发现其中的技能。</p>
        <div className="skill-root-form compact"><label className="skill-root-field"><span>技能目录</span><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="输入受信任的本机目录" /></label><button className="primary-button" disabled={busy || !rootPath.trim()} onClick={async () => { const added = await run(async () => { await postJson(`/api/projects/${encodeURIComponent(projectId)}/skill-roots`, { rootPath: rootPath.trim(), sourceKind: "custom", ...skillRequestBody(productMode, conversationId, providerId) }); }); if (added) setRootPath(""); }}>添加</button></div>
        <div className="skill-root-list" aria-label="已添加技能目录">{visibleRoots.length === 0 ? <span>尚未添加自定义来源。</span> : visibleRoots.map((root) => <div key={root.rootPath}><Folder size={14} /><span title={root.rootPath}>{root.rootPath}</span></div>)}</div>
      </DialogSurface>

      <DialogSurface open={identityResolved && catalogDiagnosticsOpen} onClose={() => setCatalogDiagnosticsOpen(false)} ariaLabel="技能扫描诊断" panelClassName="settings-panel skill-diagnostics-drawer" returnFocusRef={diagnosticsTriggerRef}><div data-diagnostic-raw-evidence><header className="settings-panel-header"><div><p className="eyebrow">诊断</p><h2>无法读取的技能</h2></div><button className="icon-button" aria-label="关闭技能扫描诊断" onClick={() => setCatalogDiagnosticsOpen(false)}><X size={16} /></button></header>{visibleCatalogErrors.map((error) => <div className="skill-diagnostic-item" key={`${error.path}:${error.message}`}><strong>{safePathLabel(error.path)}</strong><p>{sanitizeTechnicalDetail(error.message)}</p></div>)}</div></DialogSurface>
    </section>
  );
}

function skillRequestBody(productMode: ProductMode, conversationId: string | null, providerId: string | null) { return { productMode, conversationId: conversationId ?? undefined, providerId: providerId ?? undefined }; }
export function skillSettingsIdentityKey(projectId: string | null, productMode: ProductMode, conversationId: string | null, providerId: string | null): string { return [projectId ?? "", productMode, conversationId ?? "", providerId ?? ""].join("\0"); }
function skillSearchParams(productMode: ProductMode, conversationId: string | null, providerId: string | null): URLSearchParams { const params = new URLSearchParams({ productMode }); if (conversationId) params.set("conversationId", conversationId); if (providerId) params.set("providerId", providerId); return params; }
function skillGroup(skill: SkillListItem, conversationId: string | null): SkillGroupId {
  if (skill.providerEnabled || skill.required || skill.runtimeAssigned || skill.enabledProject || (conversationId ? skill.enabledTopics.includes(conversationId) : false)) return "enabled";
  if (skill.sourceKind === "project-harness" || skill.scope === "repo") return "project";
  if (skill.sourceKind === "custom") return "custom";
  return "provider";
}
function skillGroupLabel(group: SkillGroupId): string { return group === "enabled" ? "已启用" : group === "project" ? "项目" : group === "provider" ? "当前 Agent" : "自定义来源"; }
function runtimeStatusLabel(status: SkillListItem["providerBindings"][number]["status"] | undefined): string { return status === "ready" ? "可用" : status === "disabled" ? "已关闭" : "不可用"; }
function sourceKindLabel(kind: string): string { return kind === "system-aho" ? "AHO 内置技能" : kind === "provider-native" ? "当前 Agent 的本地技能" : kind === "project-harness" ? "项目技能" : kind === "custom" ? "自定义来源" : "其他来源"; }
function scopeLabel(scope: SkillListItem["scope"]): string { return scope === "repo" ? "当前项目" : scope === "user" ? "当前用户" : scope === "system" ? "系统" : "管理员"; }
function safePathLabel(path: string): string { const parts = path.split(/[\\/]+/).filter(Boolean); return parts.length > 1 ? `…/${parts.slice(-2).join("/")}` : parts[0] ?? "未知来源"; }
