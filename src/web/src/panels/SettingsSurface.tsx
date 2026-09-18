import { useState, type ReactElement } from "react";
import { ArrowLeft, Bot, CircleAlert, RefreshCw, Sparkles, X } from "lucide-react";
import { SkillsSettingsView } from "./SkillsSettingsView.js";
import { DialogSurface } from "../presentation/DialogSurface.js";
import { providerHealthViewModel } from "../presentation/provider-health.js";
import { sanitizeTechnicalDetail, userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type { ProductMode, ProviderDiagnostics, ProviderModelSettingsSnapshot, ProjectStatus, ProviderCapabilityItem, ProviderCapabilitySnapshot } from "../types.js";
import { DesktopUpdateDock } from "../shell/DesktopUpdateDock.js";

export type SettingsSection = "basic" | "project" | "provider" | "skills";
type VisibleSettingsSection = "provider" | "skills";

const sections: Array<{ id: VisibleSettingsSection; label: string; icon: typeof Bot }> = [
  { id: "provider", label: "AI 服务", icon: Bot },
  { id: "skills", label: "技能", icon: Sparkles },
];

export function SettingsSurface({ section, onSectionChange, project, productMode, conversationId, selectedProviderId, diagnostics, modelSettings, providerCapabilities, modelSettingsBusy, onClose, onRefresh }: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  project: ProjectStatus | null;
  productMode: ProductMode;
  conversationId: string | null;
  selectedProviderId: string | null;
  diagnostics: ProviderDiagnostics | null;
  modelSettings: ProviderModelSettingsSnapshot | null;
  providerCapabilities?: ProviderCapabilitySnapshot[];
  modelSettingsBusy?: boolean;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const visibleSection: VisibleSettingsSection = section === "skills" ? "skills" : "provider";
  const selectedProjectId = project?.project?.id ?? null;
  const providerLabel = diagnostics?.displayName ?? "当前 AI 服务";
  const capabilitySnapshot = providerCapabilities?.find((item) => item.providerId === (diagnostics?.providerId ?? selectedProviderId)) ?? null;

  async function refresh(): Promise<void> {
    setMessage(null);
    try { await onRefresh(); }
    catch (cause) { setMessage(userFacingErrorMessage(cause, "settings")); }
  }

  const health = providerHealthViewModel({ snapshot: capabilitySnapshot, diagnostics, hasSelectedProject: Boolean(selectedProjectId), productMode });
  const status = health.serviceState === "connected" ? "ready" : health.serviceState === "attention" ? "degraded" : "unavailable";
  const diagnosticsAvailable = status !== "ready" || Boolean(health.projectIssue) || health.featureIssues.length > 0 || Boolean(diagnostics?.lastError);
  return (
    <section className="settings-surface" aria-label="设置">
      <aside className="settings-surface-sidebar" aria-label="设置分类">
        <header><h2>设置</h2></header>
        <nav aria-label="设置页面">{sections.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={visibleSection === item.id ? "selected" : ""} aria-current={visibleSection === item.id ? "page" : undefined} onClick={() => onSectionChange(item.id)}><Icon size={16} aria-hidden="true" />{item.label}</button>; })}</nav>
        <div className="settings-update-footer"><DesktopUpdateDock /></div>
      </aside>

      <div className="settings-surface-content">
        <header className="settings-surface-header">
          <div><h1>{visibleSection === "provider" ? "AI 服务" : "技能"}</h1><p>{settingsDescription(visibleSection)}</p></div>
          <button className="outline-button settings-back-button" aria-label="返回工作区" onClick={onClose}><ArrowLeft size={16} />返回工作区</button>
        </header>

        {visibleSection === "provider" ? (
          <section className="provider-settings-section" aria-label="AI 服务">
            <div className="provider-settings-summary">
              <span className={`provider-connection-mark ${status}`}><Bot size={19} aria-hidden="true" /></span>
              <div><h3>{providerLabel}</h3><p>{health.serviceSummary}</p></div>
              <span className={`provider-status-pill ${status}`}>{providerStatusLabel(status)}</span>
            </div>
            {health.projectIssue ? <div className="provider-project-issue" role="status"><div><strong>{health.projectIssue.summary}</strong><p>{health.projectIssue.recoveryAction}</p></div><div className="settings-inline-actions"><button className="outline-button" onClick={() => void refresh()} disabled={modelSettingsBusy}>重新检测</button><button className="outline-button" onClick={() => onSectionChange("skills")}>打开技能</button></div></div> : null}
            {health.featureIssues.length > 0 ? <div className="provider-feature-issues" role="status" aria-label="功能可用性">{health.featureIssues.map((issue) => <div className="provider-feature-issue" key={issue.summary}><strong>{issue.summary}</strong>{issue.recoveryAction ? <p>{issue.recoveryAction}</p> : null}</div>)}</div> : null}
            <dl className="settings-definition-list">
              <div><dt>默认模型</dt><dd className="settings-identity" tabIndex={0} title={modelSettings?.effectiveModel?.modelId ?? diagnostics?.models.effectiveModel?.modelId ?? `${providerLabel} 默认模型`}>{modelSettings?.effectiveModel?.modelId ?? diagnostics?.models.effectiveModel?.modelId ?? `${providerLabel} 默认模型`}</dd></div>
              <div><dt>模型来源</dt><dd>{modelSourceLabel(modelSettings?.effectiveModelSource ?? diagnostics?.models.effectiveModelSource)}</dd></div>
            </dl>
            <div className="settings-inline-actions">
              <button className="outline-button" onClick={() => void refresh()} disabled={modelSettingsBusy}><RefreshCw size={14} className={modelSettingsBusy ? "spin" : undefined} />重新检测</button>
              {diagnosticsAvailable ? <button className="outline-button" onClick={() => setDiagnosticsOpen(true)}><CircleAlert size={14} />查看诊断</button> : null}
            </div>
          </section>
        ) : <SkillsSettingsView projectId={selectedProjectId} productMode={productMode} conversationId={conversationId} providerId={selectedProviderId} onRefresh={onRefresh} />}
        {message ? <p className="diagnostic-errors" role="alert">{message}</p> : null}
      </div>

      {diagnosticsOpen ? <ProviderDiagnosticsDrawer snapshot={capabilitySnapshot} diagnostics={diagnostics} onClose={() => setDiagnosticsOpen(false)} /> : null}
    </section>
  );
}

function ProviderDiagnosticsDrawer({ snapshot, diagnostics, onClose }: { snapshot: ProviderCapabilitySnapshot | null; diagnostics: ProviderDiagnostics | null; onClose: () => void }): ReactElement {
  const capabilities = snapshot?.capabilities ?? [];
  const reasons = [diagnostics?.lastError, ...(snapshot?.degradedReasons ?? [])].filter((value): value is string => Boolean(value));
  return <DialogSurface open onClose={onClose} ariaLabel="服务诊断" overlayClassName="settings-drawer-overlay" panelClassName="settings-panel provider-diagnostics-drawer">
    <div data-diagnostic-raw-evidence>
      <header className="settings-panel-header"><div><h2>服务诊断</h2><p>{snapshot?.displayName ?? diagnostics?.displayName ?? "AI 服务"}</p></div><button className="icon-button" aria-label="关闭服务诊断" onClick={onClose}><X size={16} /></button></header>
      <p className="muted-copy">查看检测结果和建议操作。</p>
      {reasons.length > 0 ? <div className="diagnostic-errors"><strong>检测到的问题</strong>{reasons.map((reason) => <p key={reason}>{sanitizeTechnicalDetail(reason)}</p>)}</div> : <p className="provider-healthy-note">当前未检测到服务问题。</p>}
      <details className="diagnostic-technical-details">
        <summary>查看技术信息</summary>
        <div className="provider-capability-list" aria-label="能力诊断">{capabilities.map((item) => <ProviderCapabilityRow item={item} key={item.key} />)}</div>
        <dl className="settings-definition-list compact"><div><dt>Adapter</dt><dd>{diagnostics ? `${diagnostics.adapter.id} ${diagnostics.adapter.version}` : "未读取"}</dd></div><div><dt>Snapshot</dt><dd>{snapshot ? `v${snapshot.snapshotVersion}` : "未读取"}</dd></div></dl>
      </details>
    </div>
  </DialogSurface>;
}

function ProviderCapabilityRow({ item }: { item: ProviderCapabilityItem }): ReactElement {
  return <div className="provider-capability-row"><div><strong>{item.label}</strong><small>{item.summary}</small>{item.reason ? <small className="provider-capability-reason">{item.reason}</small> : null}<code>{item.key}</code></div><div className="provider-capability-states"><span className={`provider-state-pill spec ${item.spec}`}>{specStateLabel(item.spec)}</span><span className={`provider-state-pill runtime ${item.runtime}`}>{runtimeStateLabel(item.runtime)}</span></div></div>;
}

function settingsDescription(section: VisibleSettingsSection): string { return section === "provider" ? "查看当前 Agent 的连接、模型检测和诊断。" : "查找、了解并管理当前项目可用的技能。"; }
function providerStatusLabel(status: ProviderCapabilitySnapshot["status"]): string { return status === "ready" ? "已连接" : status === "degraded" ? "需注意" : "不可用"; }
function modelSourceLabel(source: ProviderModelSettingsSnapshot["effectiveModelSource"] | undefined): string { return source === "selected" ? "用户选择" : source === "config" ? "服务配置" : source === "provider-default" ? "服务默认" : "自动检测"; }
function specStateLabel(state: ProviderCapabilityItem["spec"]): string { return state === "supported" ? "支持" : state === "compat-input" ? "兼容" : state === "unsupported" ? "不支持" : "未知"; }
function runtimeStateLabel(state: ProviderCapabilityItem["runtime"]): string { return state === "ready" ? "可用" : state === "degraded" ? "降级" : "不可用"; }
