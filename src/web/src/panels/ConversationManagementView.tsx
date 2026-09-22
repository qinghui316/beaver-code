import type { ReactElement } from "react";
import { AgentTranscriptPane } from "./workbench/TranscriptReadingSurface.js";
import { DialogSurface } from "../presentation/DialogSurface.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import { useConversationManagement, type ManagementConversation } from "../controllers/useConversationManagement.js";
import type { ProductMode, ProjectStatus } from "../types.js";

export function ConversationManagementView(input: {
  active: boolean;
  currentProjectId: string | null;
  projects: ProjectStatus[];
  refreshVersions: Record<string, number>;
  onChanged: (item: ManagementConversation, action: "archive" | "restore" | "delete") => void;
  onBack: () => void;
}): ReactElement {
  const management = useConversationManagement(input);
  const { filters, page, loading, error, preview, previewLoading, busyKey } = management;
  return <section className="conversation-management" aria-label="会话管理">
    <header className="settings-surface-header"><div><h1>会话管理</h1><p>查看和管理项目会话。归档历史在这里只读预览。</p></div>
      <button type="button" className="outline-button settings-back-button" onClick={input.onBack}>返回工作区</button></header>
    <div className="conversation-management-filters">
      <label>范围<select aria-label="会话范围" value={filters.scope} onChange={(event) => management.changeFilters({ scope: event.target.value as "project" | "all" })}>
        <option value="project">项目</option><option value="all">全部项目</option></select></label>
      {filters.scope === "project" ? <label>项目<select aria-label="选择项目" value={filters.projectId} onChange={(event) => management.changeFilters({ projectId: event.target.value })}>
        {!filters.projectId ? <option value="">请选择项目</option> : null}
        {input.projects.filter((item) => item.project).map((item) => <option key={item.project!.id} value={item.project!.id}>{item.project!.name}</option>)}</select></label> : null}
      <label>模式<select aria-label="会话模式" value={filters.productMode} onChange={(event) => management.changeFilters({ productMode: event.target.value as ProductMode | "all" })}>
        <option value="all">全部</option><option value="agent">Agent</option><option value="harness">工作流</option></select></label>
      <label>状态<select aria-label="会话状态" value={filters.state} onChange={(event) => management.changeFilters({ state: event.target.value as "active" | "archive" | "all" })}>
        <option value="archive">已归档</option><option value="active">活跃</option><option value="all">全部</option></select></label>
      <label>标题<input aria-label="搜索会话标题" value={filters.search} onChange={(event) => management.changeFilters({ search: event.target.value })} placeholder="搜索标题" /></label>
    </div>
    {error ? <p role="alert" className="form-error">{userFacingErrorMessage(error, "conversation")}</p> : null}
    {page?.partial ? <p role="status" className="conversation-management-warning">部分项目无法读取：{page.unreadableProjects.map((item) => item.projectName).join("、")}。</p> : null}
    {loading && !page ? <p role="status">正在读取会话。</p> : null}
    {page && page.conversations.length === 0 ? <p className="muted-copy">没有符合条件的会话。</p> : null}
    <div className="conversation-management-list">{page?.conversations.map((item) => {
      const key = `${item.projectId}:${item.productMode}:${item.conversationId}`;
      const busy = busyKey === key;
      return <article className="conversation-management-row" key={key}>
        <div><strong>{item.title}</strong><small>{item.projectName} · {item.productMode === "agent" ? "Agent" : "工作流"} · {item.state === "archive" ? "已归档" : "活跃"} · {new Date(item.updatedAt).toLocaleString()}</small>
          {item.providerSyncStatus === "submitting" ? <small>正在同步外部会话归档</small> : null}
          {item.providerSyncStatus === "failed" || item.providerSyncStatus === "uncertain" || item.providerSyncStatus === "unsupported"
            ? <small>外部会话同步{item.providerSyncStatus === "uncertain" ? "结果未确认；恢复需重新校验" : item.providerSyncStatus === "unsupported" ? "不受支持" : "失败"}，本地归档已保留。</small> : null}</div>
        <div className="conversation-management-actions">
          {item.state === "archive" ? <button type="button" className="outline-button" disabled={busy} onClick={() => void management.openPreview(item)}>预览</button> : null}
          {item.canArchive ? <button type="button" className="outline-button" disabled={busy} onClick={() => void management.settle(item, "archive")}>归档</button> : null}
          {item.canRestore ? <button type="button" className="outline-button" disabled={busy} onClick={() => void management.settle(item, "restore")}>恢复</button> : null}
          {item.canDelete ? <button type="button" className="outline-button" disabled={busy} onClick={() => void management.prepareDelete(item)}>永久删除</button> : null}
        </div>
      </article>;
    })}</div>
    {page?.nextCursor ? <button type="button" className="outline-button" disabled={loading} onClick={() => void management.loadMore()}>加载更多</button> : null}
    {previewLoading && !preview ? <p role="status">正在读取归档历史。</p> : null}
    {preview ? <section className="conversation-management-preview" aria-label="归档会话预览">
      <header><div><h2>{preview.item.title}</h2><p>只读预览 · {preview.item.projectName}</p></div><button type="button" className="outline-button" onClick={() => management.openPreview(preview.item)}>刷新状态</button></header>
      {preview.pages[0]?.paging.hasMoreBefore ? <button type="button" className="outline-button" disabled={previewLoading} onClick={() => void management.loadEarlier()}>加载更早记录</button> : null}
      <AgentTranscriptPane testId="conversation-management-preview" cells={preview.pages.flatMap((item) => item.entries.flatMap((entry) => entry.cells))} emptyMessage="暂无历史记录。" />
    </section> : null}
    <DialogSurface open={Boolean(management.deleteConfirmation)} onClose={() => management.setDeleteConfirmation(null)} ariaLabel="确认删除归档会话" panelClassName="conversation-delete-dialog" portal>
      {management.deleteConfirmation ? <><h2>永久删除“{management.deleteConfirmation.item.title}”？</h2>
        <p>{management.deleteConfirmation.token.effect}</p>
        <div className="dialog-actions"><button type="button" onClick={() => management.setDeleteConfirmation(null)}>取消</button>
          <button type="button" className="danger-button" disabled={Boolean(busyKey)} onClick={() => void management.settle(management.deleteConfirmation!.item, "delete", management.deleteConfirmation!.token.token)}>永久删除</button></div></> : null}
    </DialogSurface>
  </section>;
}
