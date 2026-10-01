import type { ReactElement } from "react";
import { FileText } from "lucide-react";
import { confirmationKindLabel, decisionKindLabel, formatTime } from "../../formatters.js";
import type { DecisionAction, DecisionInspectorControls, DecisionInspectorEntry } from "../../types.js";
import { artifactName } from "./RunReplayPanel.js";

export function DecisionInspectorPane({ controller }: { controller: DecisionInspectorControls }): ReactElement {
  const { view } = controller;
  const remaining = view.entries.filter((entry) => entry !== view.selected);
  return <div className="decision-inspector">
    {view.loading ? <p className="approval-empty" role="status">正在读取确认事项…</p> : null}
    {view.loadFailure ? <div className="decision-notice failed" role="alert"><p>{view.loadFailure}</p><button className="outline-button" disabled={view.loading} onClick={() => void controller.refresh()}>重新读取</button></div> : null}
    {!view.loading && !view.loadFailure && view.entries.length === 0 ? <p className="approval-empty">当前没有待确认事项</p> : null}
    {view.selected?.target.source === "history" ? <div className="approval-header"><h2>历史详情</h2></div>
      : view.entries.length > 0 ? <div className="approval-header"><h2>待确认</h2>{view.entries.length > 1 ? <span>{view.entries.length}</span> : null}</div> : null}
    {view.selected ? <DecisionDetail controller={controller} entry={view.selected} /> : null}
    {remaining.length > 0 ? <section className="decision-related" aria-label="其他待确认事项">
      {view.selected?.target.source === "history" ? <div className="approval-header compact"><h2>待确认事项</h2>{remaining.length > 1 ? <span>{remaining.length}</span> : null}</div> : null}
      {remaining.map((entry) => <DecisionRow key={`${entry.target.source}:${entry.target.id}`} entry={entry} onSelect={() => controller.select(entry.target)} />)}
    </section> : null}
    {view.history.length > 0 ? <details className="decision-history" data-testid="decision-history">
      <summary>历史记录 <span>{view.history.length}</span></summary>
      <div className="decision-history-details">{view.history.map((entry) => <DecisionRow key={entry.target.id} entry={entry} onSelect={() => controller.select(entry.target)} />)}</div>
    </details> : null}
  </div>;
}

function DecisionRow({ entry, onSelect }: { entry: DecisionInspectorEntry; onSelect: () => void }): ReactElement {
  return <button className="decision-row" onClick={onSelect}>
    <strong>{entry.context.title}</strong>
    <span>{entry.target.source === "history" ? decisionKindLabel(entry.context.kind) : confirmationKindLabel(entry.context.kind)}{entry.context.timestamp ? ` · ${formatTime(entry.context.timestamp)}` : ""}</span>
  </button>;
}

function DecisionDetail({ controller, entry }: { controller: DecisionInspectorControls; entry: DecisionInspectorEntry }): ReactElement {
  const { view } = controller;
  const context = entry.context;
  const historical = entry.target.source === "history";
  const canMutate = !entry.readOnly && !view.busy && !view.locked;
  const feedbackAction = context.actions.find((action) => action.kind === "feedback" && action.id === view.feedbackActionId);
  const summary = context.resultSummary || context.summary;
  const explanation = context.explanation?.trim();
  return <article className={`approval-card decision-primary ${context.severity}`} data-testid="decision-inspector-primary" data-decision-id={entry.target.id}>
    <div className="approval-meta"><span>{historical ? "历史记录" : entry.target.source === "maintenance" ? "维护事项" : "需要你决定"}</span></div>
    <h3>{context.title}</h3>
    {summary ? <p>{summary}</p> : null}
    {context.recommendation?.trim() && !historical ? <div className="decision-explainer"><strong>确认后的影响</strong><p>{context.recommendation}</p></div> : null}
    {explanation && context.severity !== "info" ? <p className="decision-risk">{explanation}</p> : null}
    {explanation || context.evidenceRefs?.length ? <details className="decision-details"><summary>详情与证据</summary>
      {explanation && context.severity === "info" ? <p>{explanation}</p> : null}
      {context.evidenceRefs?.length ? <ul className="decision-evidence">{context.evidenceRefs.map((artifact) => <li key={artifact}>{artifactName(artifact)}</li>)}</ul> : null}
    </details> : null}
    {view.issue ? <div className={`decision-notice ${view.issue.kind}`} role={view.issue.kind === "failed" ? "alert" : "status"}>
      <p>{view.issue.message}</p>
      {view.issue.kind !== "failed" ? <button className="outline-button" disabled={view.loading || view.busy} onClick={() => void controller.refresh()}>重新读取</button> : null}
    </div> : null}
    {entry.readOnly && !historical && entry.projectId && entry.conversationId ? <div className="approval-actions"><button className="outline-button" disabled={view.busy} onClick={() => void controller.openConversation()}>打开对应会话</button></div> : null}
    {!entry.readOnly ? <div className="approval-actions">
      {context.actions.map((action) => {
        if (action.kind === "none" || (action.kind === "evidence" && !context.runId)) return null;
        const disabled = !canMutate || !action.enabled;
        const title = !action.enabled ? action.disabledReason : view.locked ? "请先读取正式操作结果。" : undefined;
        if (action.kind === "feedback") return <button className="outline-button" key={action.id} disabled={disabled} title={title} onClick={() => controller.beginFeedback(action.id)}>{action.label}</button>;
        if (view.confirming === action.id) return <span className="confirm-inline" key={action.id}>
          <button className={actionClass(action)} disabled={disabled} onClick={() => void controller.execute(action)}>确认{action.label}</button>
          <button className="outline-button" disabled={view.busy} onClick={() => controller.confirm(null)}>取消</button>
        </span>;
        return <button className={actionClass(action)} key={action.id} disabled={disabled} title={title}
          onClick={() => action.requiresConfirmation ? controller.confirm(action.id) : void controller.execute(action)}>
          {action.kind === "evidence" ? <FileText size={15} aria-hidden="true" /> : null}{action.label}
        </button>;
      })}
    </div> : null}
    {feedbackAction && !entry.readOnly ? <div className="decision-feedback" data-testid="decision-feedback-editor">
      <label><span>{context.rework?.label ?? feedbackAction.label}</span><textarea rows={4} value={view.feedback} onChange={(event) => controller.setFeedback(event.target.value)} placeholder={context.rework?.placeholder ?? "写下需要修改的地方"} /></label>
      <div className="approval-actions"><button className="primary-button" disabled={!canMutate || !view.feedback.trim()} onClick={() => void controller.submitFeedback()}>{view.busy ? "正在提交…" : "提交反馈"}</button><button className="outline-button" disabled={view.busy} onClick={controller.cancelFeedback}>取消</button></div>
    </div> : null}
  </article>;
}

function actionClass(action: DecisionAction): string {
  if (action.kind === "abandon" || action.action?.actionId.includes("discard")) return "danger-button";
  return action.kind === "evidence" ? "outline-button" : "primary-button";
}
