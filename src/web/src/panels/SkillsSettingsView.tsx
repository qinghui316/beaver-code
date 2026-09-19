import { useRef, type ReactElement, type RefObject } from "react";
import {
  ArrowLeft,
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

export function SkillsSettingsView({ surface, onBack }: { surface: SkillsSettingsSurface; onBack: () => void }): ReactElement {
  const { view, actions } = surface;
  const detailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const diagnosticsTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section className="skills-settings-view" aria-label="技能设置">
      <header className="skills-catalog-page-header">
        <div><h1>技能</h1><p>查看当前项目与 AI 服务可用的本机技能。</p></div>
        <div className="skills-catalog-actions">
          <button type="button" className="outline-button" disabled={view.busy || !view.hasProject} onClick={() => void actions.refresh()}>
            <RefreshCw size={15} className={view.busy ? "spin" : undefined} aria-hidden="true" />
            重新检测
          </button>
          <button ref={sourceTriggerRef} type="button" className="outline-button" disabled={!view.hasProject} onClick={actions.openSources}>
            <Settings2 size={15} aria-hidden="true" />
            管理来源
          </button>
          <button type="button" className="outline-button settings-back-button" aria-label="返回工作区" onClick={onBack}><ArrowLeft size={16} />返回工作区</button>
        </div>
      </header>

      {!view.hasProject ? <section className="settings-empty-state"><Puzzle size={24} /><h3>选择项目后管理技能</h3><p>选择项目后，可以查看当前 Agent 与项目可用的本机技能。</p></section> : <>

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

      {view.actionFailure && view.state.status === "ready" && !view.selectedSkill && !view.sourcesOpen ? (
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
        {view.state.status === "loading" ? (
          <div className="skills-empty-results" role="status"><RefreshCw size={22} className="spin" /><strong>正在加载技能…</strong></div>
        ) : view.state.status === "error" ? (
          <div className="skills-empty-results" role="alert">
            <CircleAlert size={22} />
            <strong>{view.state.failure.summary}</strong>
            {view.state.failure.recoveryAction ? <span>{view.state.failure.recoveryAction}</span> : null}
            <button type="button" className="primary-button" onClick={() => void actions.refresh()}>重新加载</button>
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
      </>}
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
            <span><strong>为当前 Agent 启用</strong><small>启用后，可在后续会话中选择使用此技能。</small></span>
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
        disabled={view.busy || !view.sourcePath.trim()}
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
