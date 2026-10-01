import { useRef, type ReactElement, type RefObject } from "react";
import {
  Check,
  CircleAlert,
  Folder,
  FolderPlus,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import type { SkillsSettingsSurface } from "../controllers/skills-settings-contract.js";
import { DialogSurface } from "../presentation/DialogSurface.js";

export function SkillsSettingsView({ surface }: { surface: SkillsSettingsSurface }): ReactElement {
  const { view, actions } = surface;
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const diagnosticsTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section className="skills-settings-view" aria-label="技能设置">
      <header className="skills-catalog-page-header">
        <div><h1>技能</h1><p>浏览通用技能与各项目的本机技能。</p></div>
        <div className="skills-catalog-actions">
          <button type="button" className="outline-button" disabled={view.busy} onClick={() => void actions.refresh()}>
            <RefreshCw size={15} className={view.busy ? "spin" : undefined} aria-hidden="true" />
            重新检测
          </button>
          <button ref={sourceTriggerRef} type="button" className="outline-button" onClick={actions.openSources}>
            <Settings2 size={15} aria-hidden="true" />
            管理来源
          </button>
        </div>
      </header>

      {(view.providers?.length ?? 0) > 1 ? <label className="skills-provider-field">AI 服务
        <select value={view.providerId ?? ""} onChange={(event) => actions.selectProvider?.(event.target.value)}>
          <option value="" disabled>选择 AI 服务</option>
          {view.providers?.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
        </select>
      </label> : null}

      <label className="skills-catalog-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">搜索技能</span>
        <input
          value={view.query}
          onChange={(event) => actions.setQuery(event.target.value)}
          placeholder="搜索技能名称、说明或来源"
          aria-label="搜索技能"
        />
        {view.query ? <button type="button" aria-label="清除搜索" onClick={() => actions.setQuery("")}><X size={15} /></button> : null}
      </label>

      <div className="skills-catalog-filters" role="group" aria-label="筛选技能">
        {view.filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={view.filter === filter.id ? "selected" : ""}
            aria-pressed={view.filter === filter.id}
            onClick={() => actions.setFilter(filter.id)}
          >
            <span>{filter.label}</span>
            <small>{filter.count}</small>
          </button>
        ))}
      </div>

      {view.diagnostics.length > 0 && view.state.status !== "loading" && view.state.status !== "error" ? (
        <div className="skills-catalog-warning" role="status">
          <CircleAlert size={16} aria-hidden="true" />
          <span>部分技能暂时无法读取，其余技能仍可使用。</span>
          <button ref={diagnosticsTriggerRef} type="button" onClick={actions.openDiagnostics}>查看诊断</button>
        </div>
      ) : null}

      {view.actionFailure && view.state.status !== "loading" && view.state.status !== "error" && !view.selectedSkill && !view.sourcesOpen ? (
        <div className="skills-state-notice" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <div><strong>{view.actionFailure.summary}</strong>{view.actionFailure.recoveryAction ? <span>{view.actionFailure.recoveryAction}</span> : null}</div>
        </div>
      ) : null}

      <div className="skills-catalog-heading">
        <h2>技能目录</h2>
        <span>{view.totalCount}</span>
      </div>

      <div className="skills-catalog-content" aria-live="polite">
        {view.groups ? view.groups.map((group) => <section className="skills-catalog-group" key={group.id} aria-label={group.label}>
          <header><h3>{group.label}</h3><span>{group.total}</span></header>
          {group.state === "loading" ? <p role="status">正在加载技能…</p> : null}
          {group.state === "error" ? <div className="skills-state-notice" role="alert"><span>{group.failure}</span><button className="outline-button" onClick={() => void actions.refresh()}>重新检测</button></div> : null}
          {group.state === "loading" && group.cards.length === 0 || group.state === "error" && group.cards.length === 0 ? null
            : group.cards.length === 0 ? <p className="skills-group-empty">{view.query ? "没有匹配的技能" : "还没有发现技能"}</p>
            : <div className="skills-catalog-grid" role="list" aria-label={`${group.label}列表`}>
              {group.cards.map((skill) => <div key={skill.skillId} role="listitem"><button type="button" className="skills-catalog-card"
                aria-label={`${skill.name}，${skill.sourceLabel}，${skill.statusLabel}`} onClick={(event) => { detailTriggerRef.current = event.currentTarget; actions.openSkill(skill.skillId); }}>
                <span className="skill-catalog-icon"><Puzzle size={18} aria-hidden="true" /></span>
                <span className="skill-catalog-copy"><strong>{skill.name}</strong><span className="skill-catalog-description">{skill.description}</span></span>
                <span className="skill-catalog-meta"><span>{skill.sourceLabel}</span><span className={`skill-catalog-status ${skill.statusTone}`}>{skill.statusLabel}</span></span>
              </button></div>)}
            </div>}
          {group.total > 50 ? <nav className="skills-group-pagination" aria-label={`${group.label}分页`}>
            <button className="outline-button" disabled={group.page === 0} onClick={() => actions.setGroupPage?.(group.id, group.page - 1)}>上一页</button>
            <span>{group.page + 1} / {Math.ceil(group.total / 50)}</span>
            <button className="outline-button" disabled={(group.page + 1) * 50 >= group.total} onClick={() => actions.setGroupPage?.(group.id, group.page + 1)}>下一页</button>
          </nav> : null}
        </section>) : view.state.status === "loading" ? (
          <div className="skills-empty-results" role="status"><RefreshCw size={22} className="spin" /><strong>正在加载技能…</strong></div>
        ) : view.state.status === "error" ? (
          <div className="skills-empty-results" role="alert">
            <CircleAlert size={22} />
            <strong>{view.state.failure.summary}</strong>
            {view.state.failure.recoveryAction ? <span>{view.state.failure.recoveryAction}</span> : null}
            <div className="skills-empty-actions">
              {view.state.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={action.emphasis === "primary" ? "primary-button" : "outline-button"}
                  onClick={() => action.id === "diagnostics" ? actions.openDiagnostics() : void actions.refresh()}
                >{action.label}</button>
              ))}
            </div>
          </div>
        ) : view.state.status === "empty" ? (
          <div className="skills-empty-results">
            <Puzzle size={22} />
            <strong>{view.state.title}</strong>
            {view.state.description ? <span>{view.state.description}</span> : null}
            <button
              type="button"
              className={view.state.actions[0]?.emphasis === "primary" ? "primary-button" : "outline-button"}
              onClick={() => {
                if (view.state.status !== "empty") return;
                if (view.state.actions[0]?.id === "clear-filter") {
                  actions.setQuery("");
                  actions.setFilter("all");
                } else {
                  void actions.refresh();
                }
              }}
            >{view.state.actions[0]?.label}</button>
          </div>
        ) : (
          <div className="skills-catalog-grid" role="list" aria-label="技能列表">
            {view.state.data.map((skill) => (
              <div key={skill.skillId} role="listitem">
                <button
                  type="button"
                  className="skills-catalog-card"
                  aria-label={`${skill.name}，${skill.sourceLabel}，${skill.statusLabel}`}
                  onClick={(event) => {
                    detailTriggerRef.current = event.currentTarget;
                    actions.openSkill(skill.skillId);
                  }}
                >
                <span className="skill-catalog-icon"><Puzzle size={18} aria-hidden="true" /></span>
                <span className="skill-catalog-copy">
                  <strong>{skill.name}</strong>
                  <span className="skill-catalog-description">{skill.description}</span>
                </span>
                <span className="skill-catalog-meta">
                  <span>{skill.sourceLabel}</span>
                  <span className={`skill-catalog-status ${skill.statusTone}`}>
                    {skill.statusTone !== "inactive" ? <Check size={13} aria-hidden="true" /> : null}
                    {skill.statusLabel}
                  </span>
                </span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <SkillDetailDialog surface={surface} returnFocusRef={detailTriggerRef} />
      <SkillSourcesDialog surface={surface} returnFocusRef={sourceTriggerRef} />
      <SkillDiagnosticsDialog surface={surface} returnFocusRef={diagnosticsTriggerRef} />
    </section>
  );
}

function SkillDetailDialog({
  surface,
  returnFocusRef,
}: {
  surface: SkillsSettingsSurface;
  returnFocusRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const { view, actions } = surface;
  const skill = view.selectedSkill;
  return (
    <DialogSurface
      open={Boolean(skill)}
      onClose={actions.closeSkill}
      dismissible={!view.busy}
      ariaLabel={skill ? `${skill.name} 详情` : "技能详情"}
      overlayClassName="task-dialog-overlay"
      panelClassName="skill-task-dialog skill-detail-dialog"
      returnFocusRef={returnFocusRef}
      portal
    >
      {skill ? <>
        <header className="skill-dialog-header">
          <div className="skill-detail-title">
            <span className="skill-catalog-icon"><Puzzle size={20} aria-hidden="true" /></span>
            <div><h2>{skill.name}</h2><p>{skill.sourceLabel}</p></div>
          </div>
          <button type="button" className="icon-button" aria-label="关闭技能详情" disabled={view.busy} onClick={actions.closeSkill}><X size={17} /></button>
        </header>
        <p className="skill-detail-description">{skill.description}</p>
        <dl className="skill-detail-facts">
          <div><dt>状态</dt><dd>{skill.runtimeStatusLabel}</dd></div>
          <div><dt>作用范围</dt><dd>{skill.scopeLabel}</dd></div>
          <div><dt>使用状态</dt><dd>{skill.statusLabel}</dd></div>
        </dl>
        {view.actionFailure ? <div className="skill-dialog-error" role="alert"><CircleAlert size={16} /><div><strong>{view.actionFailure.summary}</strong>{view.actionFailure.recoveryAction ? <span>{view.actionFailure.recoveryAction}</span> : null}</div></div> : null}
        {skill.lockReason ? (
          <div className="skill-required-note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>{skill.statusLabel}</strong><p>{skill.lockReason}</p></div></div>
        ) : (
          <label className="skill-enable-row">
            <span><strong>为此 AI 服务启用</strong><small>修改此 AI 服务的全局配置，可能影响多个项目。</small></span>
            <input
              type="checkbox"
              checked={skill.providerEnabled}
              disabled={view.busy || !skill.canChangeProviderEnabled}
              onChange={(event) => void actions.setProviderEnabled(skill.skillId, event.target.checked)}
            />
          </label>
        )}
      </> : null}
    </DialogSurface>
  );
}

function SkillSourcesDialog({
  surface,
  returnFocusRef,
}: {
  surface: SkillsSettingsSurface;
  returnFocusRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const { view, actions } = surface;
  return (
    <DialogSurface
      open={view.sourcesOpen}
      onClose={actions.closeSources}
      dismissible={!view.busy}
      ariaLabel="管理技能来源"
      overlayClassName="task-dialog-overlay"
      panelClassName="skill-task-dialog skill-sources-dialog"
      returnFocusRef={returnFocusRef}
      portal
    >
      <header className="skill-dialog-header">
        <div><h2>管理技能来源</h2><p>添加受信任的本机目录。</p></div>
        <button type="button" className="icon-button" aria-label="关闭技能来源设置" disabled={view.busy} onClick={actions.closeSources}><X size={17} /></button>
      </header>
      {view.sourceProjects ? <label className="skill-root-field"><span>来源所属项目</span>
        <select disabled={view.busy} value={view.sourceProjectId ?? ""} onChange={(event) => actions.selectSourceProject?.(event.target.value)}>
          <option value="" disabled>选择项目</option>
          {view.sourceProjects.map((project) => <option key={project.id} value={project.id}>{project.label}</option>)}
        </select>
      </label> : null}
      <label className="skill-root-field">
        <span>技能目录</span>
        <input
          data-dialog-initial-focus
          value={view.sourcePath}
          onChange={(event) => actions.setSourcePath(event.target.value)}
          placeholder="输入受信任的本机目录"
          disabled={view.busy}
        />
      </label>
      <button
        type="button"
        className="primary-button skill-source-add"
        disabled={view.busy || !view.sourcePath.trim() || Boolean(view.sourceProjects && !view.sourceProjectId)}
        onClick={() => void actions.addSource(view.sourcePath)}
      ><FolderPlus size={16} />添加来源</button>
      {view.actionFailure ? <div className="skill-dialog-error" role="alert"><CircleAlert size={16} /><div><strong>{view.actionFailure.summary}</strong>{view.actionFailure.recoveryAction ? <span>{view.actionFailure.recoveryAction}</span> : null}</div></div> : null}
      <section className="skill-source-list" aria-labelledby="skill-source-list-title">
        <header><h3 id="skill-source-list-title">已添加的目录</h3><span>{view.roots.length}</span></header>
        {view.roots.length === 0 ? <p>尚未添加自定义来源。</p> : <div>{view.roots.map((root) => <div className="skill-source-row" key={root.rootPath}><Folder size={15} /><span title={root.rootPath}>{root.rootPath}</span></div>)}</div>}
      </section>
    </DialogSurface>
  );
}

function SkillDiagnosticsDialog({
  surface,
  returnFocusRef,
}: {
  surface: SkillsSettingsSurface;
  returnFocusRef: RefObject<HTMLElement | null>;
}): ReactElement {
  const { view, actions } = surface;
  return (
    <DialogSurface
      open={view.diagnosticsOpen}
      onClose={actions.closeDiagnostics}
      ariaLabel="技能扫描诊断"
      overlayClassName="task-dialog-overlay"
      panelClassName="skill-task-dialog skill-diagnostics-dialog"
      returnFocusRef={returnFocusRef}
      portal
    >
      <div data-diagnostic-raw-evidence>
        <header className="skill-dialog-header"><div><h2>技能扫描诊断</h2><p>查看无法读取的本机来源。</p></div><button type="button" className="icon-button" aria-label="关闭技能扫描诊断" onClick={actions.closeDiagnostics}><X size={17} /></button></header>
        <div className="skill-diagnostic-list">{view.diagnostics.map((diagnostic, index) => <div className="skill-diagnostic-item" key={`${diagnostic.label}:${index}`}><strong>{diagnostic.label}</strong><p>{diagnostic.detail}</p></div>)}</div>
      </div>
    </DialogSurface>
  );
}
