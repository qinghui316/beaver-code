import { Bot, ChevronLeft, FileText, Send, X } from "lucide-react";
import { useRef, type ReactElement } from "react";
import { AgentTranscriptPane, TranscriptMarkdownLite } from "./TranscriptReadingSurface.js";
import type { AgentSurfaceProjectionItem, ParentAgentTranscript, TextDocumentResource, WorkspaceResourceTab } from "../../types.js";
import { agentDraftKey } from "../../controllers/useWorkspaceResourceController.js";
import { ComposerControls } from "../../shell/ComposerControls.js";
import { ComposerFrame } from "../../shell/ComposerFrame.js";

export function ResourceWorkspacePanel({
  agents,
  agentTranscripts,
  conversationId,
  tabs,
  selectedResourceId,
  documents,
  loadingResourceIds,
  resourceErrors,
  onSelectResource,
  onCloseResource,
  onBack,
  agentDrafts,
  pendingAgentMessages,
  onAgentDraftChange,
  onSubmitAgentMessage,
  onLoadEarlierAgentTranscript,
  providerDisplayName,
  modelLabel,
}: {
  agents: AgentSurfaceProjectionItem[];
  agentTranscripts: Record<string, ParentAgentTranscript>;
  conversationId: string;
  tabs: WorkspaceResourceTab[];
  selectedResourceId: string | null;
  documents: Record<string, TextDocumentResource>;
  loadingResourceIds: string[];
  resourceErrors: Record<string, string>;
  onSelectResource: (resourceId: string) => void;
  onCloseResource: (resourceId: string) => void;
  onBack: () => void;
  agentDrafts: Record<string, string>;
  pendingAgentMessages: Record<string, string>;
  onAgentDraftChange: (agentSurfaceId: string, value: string) => void;
  onSubmitAgentMessage: (agent: AgentSurfaceProjectionItem) => Promise<void>;
  onLoadEarlierAgentTranscript: (agentSurfaceId: string, cursor: string) => Promise<void>;
  providerDisplayName?: string;
  modelLabel: string;
}): ReactElement {
  const availableTabs = tabs;
  const selectedTab = availableTabs.find((tab) => tab.resourceId === selectedResourceId) ?? availableTabs[0] ?? null;
  const selectedTarget = selectedTab?.target;
  const selectedAgent = selectedTarget?.kind === "agent"
    ? agents.find((agent) => agent.agentSurfaceId === selectedTarget.agentSurfaceId) ?? null
    : null;
  const lastAgentIdRef = useRef<string | null>(null);
  if (selectedAgent) lastAgentIdRef.current = selectedAgent.agentSurfaceId;
  const mountedAgent = selectedAgent ?? agents.find((agent) => agent.agentSurfaceId === lastAgentIdRef.current) ?? null;
  const selectedDocument = selectedTab && selectedTab.target.kind !== "agent" ? documents[selectedTab.resourceId] ?? null : null;
  const mountedAgentTranscript = mountedAgent ? agentTranscripts[mountedAgent.agentSurfaceId] : undefined;
  const cells = (mountedAgentTranscript?.cells ?? []).filter((cell) => cell.kind !== "detail-only");
  const mountedAgentKey = mountedAgent ? agentDraftKey(conversationId, mountedAgent.agentSurfaceId) : null;
  return (
    <div className="agent-workspace-panel resource-workspace-panel" data-testid="agent-workspace-panel" data-resource-workspace="true">
      <div className="agent-workspace-tabbar">
        <button type="button" className="agent-workspace-back" data-testid="right-tool-back" aria-label="返回工具列表" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <div className="agent-workspace-tabs" role="tablist" aria-label="已打开的资源">
          {availableTabs.map((tab) => {
            const target = tab.target;
            const agent = target.kind === "agent" ? agents.find((candidate) => candidate.agentSurfaceId === target.agentSurfaceId) : null;
            const document = target.kind === "agent" ? null : documents[tab.resourceId];
            const label = agent?.label ?? document?.title ?? (target.kind === "agent" ? "Agent 正在同步" : target.kind === "document" ? "实现计划" : target.kind === "project-file" ? fileName(target.relativePath) : "资源");
            return (
              <div key={tab.resourceId} className={`agent-workspace-tab${tab.resourceId === selectedTab?.resourceId ? " selected" : ""}`} role="presentation">
                <button type="button" role="tab" aria-label={`打开 ${label}`} aria-selected={tab.resourceId === selectedTab?.resourceId} onClick={() => onSelectResource(tab.resourceId)}>
                  {target.kind === "agent" ? <span className={`agent-tab-status ${agent?.status ?? "syncing"}`} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
                  <span>{label}</span>
                </button>
                <button type="button" className="agent-workspace-tab-close" title={`关闭 ${label}`} aria-label={`关闭 ${label}`} onClick={() => onCloseResource(tab.resourceId)}>
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {mountedAgent ? <section className="agent-workspace-surface" hidden={!selectedAgent}>
        <div className="agent-workspace-transcript-region">
          <AgentTranscriptPane key={`${conversationId}:${mountedAgent.agentSurfaceId}`} cells={cells} emptyMessage={mountedAgentTranscript?.emptyMessage} testId="agent-workspace-transcript" />
          {mountedAgentTranscript?.paging?.hasMoreBefore && mountedAgentTranscript.paging.nextBeforeCursor ? (
            <button
              type="button"
              className="transcript-load-earlier"
              onClick={() => void onLoadEarlierAgentTranscript(mountedAgent.agentSurfaceId, mountedAgentTranscript.paging!.nextBeforeCursor!)}
            >加载更早消息</button>
          ) : null}
        </div>
        {mountedAgent.readOnly ? (
          <div className="agent-workspace-readonly" role="status" data-testid="agent-workspace-readonly">
            <strong>{mountedAgent.status === "terminated" ? "已关闭" : "历史 Agent"}</strong>
            <span>只读历史</span>
          </div>
        ) : <AgentWorkspaceComposer
          agent={mountedAgent}
          value={mountedAgentKey ? agentDrafts[mountedAgentKey] ?? "" : ""}
          pending={mountedAgentKey ? pendingAgentMessages[mountedAgentKey] ?? null : null}
          onValueChange={(value) => onAgentDraftChange(mountedAgent.agentSurfaceId, value)}
          onSubmit={() => onSubmitAgentMessage(mountedAgent)}
          providerDisplayName={providerDisplayName}
          modelLabel={modelLabel}
        />}
      </section> : null}
      {selectedTab?.target.kind === "agent" && !selectedAgent ? (
        <div className="agent-workspace-empty agent-workspace-unavailable" role="status">
          <Bot size={20} />
          <strong>Agent 工作区尚未同步</strong>
          <span>当前 Agent 已不在最新投影中，或数据仍在加载。你可以关闭此标签后重试。</span>
          <button type="button" className="outline-button" onClick={() => onCloseResource(selectedTab.resourceId)}>关闭标签</button>
        </div>
      ) : selectedTab && selectedTab.target.kind !== "agent" ? (
        <DocumentReadingSurface
          resource={selectedDocument}
          loading={loadingResourceIds.includes(selectedTab.resourceId)}
          failureMessage={resourceErrors[selectedTab.resourceId]}
        />
      ) : !mountedAgent ? <div className="agent-workspace-empty"><Bot size={20} /><span>从对话或 Agent 办公室中打开一个 Agent。</span></div> : null}
    </div>
  );
}

function DocumentReadingSurface({ resource, loading, failureMessage }: { resource: TextDocumentResource | null; loading: boolean; failureMessage?: string }): ReactElement {
  if (loading && !resource) return <div className="resource-document-state" role="status">正在打开...</div>;
  if (failureMessage && !resource) return <div className="resource-document-state error" role="alert">{failureMessage}</div>;
  if (!resource) return <div className="resource-document-state">文档不可用。</div>;
  return (
    <section className="resource-document-surface" data-testid="resource-document-surface" aria-label={resource.title}>
      <header className="resource-document-header">
        <FileText size={16} aria-hidden="true" />
        <span>{resource.title}</span>
        <small>只读</small>
      </header>
      <div className={`resource-document-content ${resource.language}`}>
        {resource.language === "markdown"
          ? <TranscriptMarkdownLite text={resource.content} idPrefix={`resource:${resource.resourceId}`} />
          : <pre>{resource.content}</pre>}
      </div>
    </section>
  );
}

function AgentWorkspaceComposer({ agent, value, pending, onValueChange, onSubmit, providerDisplayName, modelLabel }: {
  agent: AgentSurfaceProjectionItem;
  value: string;
  pending: string | null;
  onValueChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  providerDisplayName?: string;
  modelLabel: string;
}): ReactElement {
  const text = value.trim();
  const canInteract = agent.status !== "queued" && agent.status !== "running" && agent.status !== "terminated";
  const submitDisabled = pending !== null || !canInteract || !text;
  async function submit(): Promise<void> {
    if (submitDisabled) return;
    await onSubmit();
  }
  return (
    <ComposerFrame
      className="agent-workspace-composer"
      data-testid="agent-workspace-composer"
      aria-label={`${agent.label} 输入框`}
      controls={<ComposerControls providerDisplayName={providerDisplayName} modelLabel={modelLabel} />}
      toolbar={<>
        <span className="composer-spacer" />
        <button type="button" className={`composer-send ${pending ? "running" : ""}`} disabled={submitDisabled} title="发送给当前 Agent" onClick={() => void submit()}><Send size={16} /></button>
      </>}
    >
      <textarea value={value} onChange={(event) => onValueChange(event.target.value)} placeholder="给当前 Agent 发送反馈" disabled={pending !== null || !canInteract} />
    </ComposerFrame>
  );
}

function fileName(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}
