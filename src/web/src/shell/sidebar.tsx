import { useEffect, useRef, useState, type ReactElement } from "react";
import { Archive, ArchiveRestore, CircleAlert, ChevronDown, ChevronRight, FileText, Folder, FolderPlus, MoreHorizontal, Pencil, Settings, Trash2, X } from "lucide-react";
import { ProjectAddForm, ProjectCreateForm } from "../panels/ProjectPanels.js";
import { projectDisplayName } from "../formatters.js";
import { DialogSurface } from "../presentation/DialogSurface.js";
import { groupProjectNavigationConversations, projectNavigationConversations, type ProjectNavigationFeatureSurface, type ProjectNavigationSurfaceProps } from "../presentation/project-navigation.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import { ResponsiveActionMenu, type ResponsiveActionMenuItem } from "./ResponsiveActionMenu.js";
import { DesktopUpdateDock } from "./DesktopUpdateDock.js";
import type { ConversationDeleteConfirmation, ProjectStatus, Snapshot, TopicDetail, WorkpadSummary } from "../types.js";

export function ProjectConversationSidebarFeature({ surface, onLocalDialogOpenChange }: { surface: ProjectNavigationFeatureSurface; onLocalDialogOpenChange?: (open: boolean) => void }): ReactElement {
  return <ProjectConversationSidebar {...surface.view} {...surface.actions} onLocalDialogOpenChange={onLocalDialogOpenChange} />;
}

export function ProjectConversationSidebar(props: ProjectNavigationSurfaceProps & { onLocalDialogOpenChange?: (open: boolean) => void }): ReactElement {
  const { projects, selectedProjectId, selectedTopicId, snapshots, snapshot, expandedProjects, overlay } = props;
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [archivedProjects, setArchivedProjects] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteState | null>(null);
  useEffect(() => {
    props.onLocalDialogOpenChange?.(Boolean(deleteConfirmation));
    return () => props.onLocalDialogOpenChange?.(false);
  }, [deleteConfirmation, props.onLocalDialogOpenChange]);
  const projectNameCounts = new Map<string, number>();
  for (const item of projects) {
    const name = projectDisplayName(item.project ?? { path: item.path });
    projectNameCounts.set(name, (projectNameCounts.get(name) ?? 0) + 1);
  }
  async function afterProjectAdded(projectId?: string): Promise<void> {
    await props.onRefresh();
    if (projectId) await props.onOpenProject(projectId);
    props.onCloseOverlay();
  }
  async function runLifecycleAction(action: Promise<void>): Promise<void> {
    setLifecycleError(null);
    try { await action; } catch (cause) { setLifecycleError(userFacingErrorMessage(cause, "conversation")); }
  }
  return <div className="project-conversation-sidebar">
    <section className="project-tree" aria-label="项目">
      <div className="project-tree-header"><span className="section-label">项目</span><ResponsiveActionMenu
        open={overlay.kind === "project-create-actions"}
        onOpenChange={(open) => open ? props.onOpenProjectCreateActions() : props.onCloseOverlay()}
        trigger={<FolderPlus size={15} />}
        triggerLabel="添加项目"
        menuLabel="添加项目"
        items={[
          { id: "open", label: "打开文件夹", icon: <Folder size={15} />, onSelect: () => props.onOpenProjectForm("open") },
          { id: "create", label: "新建项目", icon: <FolderPlus size={15} />, onSelect: () => props.onOpenProjectForm("create") },
        ]}
      /></div>
      <div className="project-folder-list">
        {projects.length === 0 ? <div className="empty-state sidebar-empty">还没有项目。</div> : null}
        {projects.map((item) => {
          const projectId = item.project?.id ?? item.path;
          const concreteProjectId = item.project?.id ?? null;
          const projectName = projectDisplayName(item.project ?? { path: item.path });
          const selected = concreteProjectId === selectedProjectId;
          const expanded = selected || expandedProjects.has(projectId);
          const projectSnapshot = selected ? snapshot : concreteProjectId ? snapshots[concreteProjectId] : undefined;
          const harnessReady = projectSnapshot?.harness.harnessReady ?? item.harness.readiness === "ready";
          const projectUnavailable = item.runtimeAvailability?.state === "unavailable";
          const issue = harnessStatusIssue(item, projectSnapshot);
          const conversations = projectNavigationConversations(projectSnapshot, selectedTopicId);
          const grouped = groupProjectNavigationConversations(conversations, "");
          const archivedOpen = archivedProjects.has(projectId);
          const projectItems: ResponsiveActionMenuItem[] = [
            { id: "home", label: "打开项目首页", icon: <Folder size={15} />, disabled: !concreteProjectId, onSelect: () => concreteProjectId && void props.onOpenProject(concreteProjectId) },
            { id: "settings", label: "项目设置", icon: <Settings size={15} />, disabled: !concreteProjectId, onSelect: () => concreteProjectId && props.onOpenProjectSettings(concreteProjectId) },
            { id: "remove", label: "移出项目", icon: <Trash2 size={15} />, danger: true, disabled: !concreteProjectId, onSelect: () => concreteProjectId && void props.onRemoveProject(concreteProjectId) },
          ];
          return <div className="project-folder" key={projectId}>
            <div className={`project-folder-row ${selected ? "selected" : ""}`}>
              <button className="project-folder-toggle" aria-label={expanded ? "收起项目" : "展开项目"} onClick={() => concreteProjectId && void props.onToggleProject(concreteProjectId)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
              <button className="project-folder-main" aria-label={projectName} title={projectName} onClick={() => concreteProjectId && void props.onOpenProject(concreteProjectId)}><Folder size={16} /><span className="project-folder-text"><strong>{projectName}</strong>{(projectNameCounts.get(projectName) ?? 0) > 1 ? <small>· {projectParentContext(item.path)}</small> : null}</span></button>
              {issue ? <span className="project-folder-status" role="img" aria-label={issue.detail} title={issue.detail}><CircleAlert size={14} /></span> : null}
              <span className="project-folder-actions">
                {concreteProjectId && item.pathExists && !projectUnavailable ? <button className="project-folder-new" aria-label={`在 ${projectName} 中开始新对话`} onClick={() => void props.onNewConversation(concreteProjectId)}><FileText size={15} /></button> : null}
                <ResponsiveActionMenu open={overlay.kind === "project-actions" && overlay.projectId === projectId} onOpenChange={(open) => open ? props.onOpenProjectActions(projectId) : props.onCloseOverlay()} trigger={<MoreHorizontal size={15} />} triggerLabel={`${projectName} 项目菜单`} menuLabel={`${projectName} 项目菜单`} items={projectItems} />
              </span>
            </div>
            {expanded ? <div className="conversation-list">
              {lifecycleError && selected ? <div className="conversation-lifecycle-error" role="alert">{lifecycleError}</div> : null}
              {harnessReady && !projectSnapshot ? <div className="conversation-placeholder">正在加载对话。</div> : null}
              {!projectUnavailable && !harnessReady && !projectSnapshot ? <div className="conversation-placeholder">创建第一条会话即可开始使用。</div> : null}
              {grouped.active.map((conversation) => <ConversationRow key={conversation.id} projectId={concreteProjectId} conversation={conversation} archived={false} props={props} runLifecycleAction={runLifecycleAction} onDelete={setDeleteConfirmation} onLifecycleError={setLifecycleError} />)}
              {grouped.archived.length ? <button className="conversation-archive-toggle" aria-expanded={archivedOpen} onClick={() => setArchivedProjects((current) => {
                const next = new Set(current);
                if (next.has(projectId)) next.delete(projectId);
                else next.add(projectId);
                return next;
              })}>{archivedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}已归档</button> : null}
              {archivedOpen ? grouped.archived.map((conversation) => <ConversationRow key={conversation.id} projectId={concreteProjectId} conversation={conversation} archived props={props} runLifecycleAction={runLifecycleAction} onDelete={setDeleteConfirmation} onLifecycleError={setLifecycleError} />) : null}
              {harnessReady && projectSnapshot && conversations.length === 0 ? <div className="conversation-placeholder">暂无对话。</div> : null}
            </div> : null}
          </div>;
        })}
      </div>
    </section>
    <div className="sidebar-settings"><button className="global-nav-item settings-entry" onClick={props.onOpenSettings}><Settings size={16} />设置</button><DesktopUpdateDock displayWhen="desktop" /></div>
    <ProjectFormDialog overlay={overlay} onClose={props.onCloseOverlay} onDone={afterProjectAdded} />
    <RenameConversationDialog overlay={overlay} onClose={props.onCloseOverlay} onRename={props.onRenameConversation} />
    <DialogSurface open={Boolean(deleteConfirmation)} onClose={() => setDeleteConfirmation(null)} dismissible={!deleteConfirmation?.busy} ariaLabelledBy="conversation-delete-title" panelClassName="conversation-delete-dialog" portal>
      {deleteConfirmation ? <><h2 id="conversation-delete-title">永久删除“{deleteConfirmation.title}”？</h2><p>{deleteConfirmation.confirmation.effect}</p><p>此操作不会修改项目文件，且无法从 Workbench 恢复。</p>{deleteConfirmation.failureMessage ? <p className="form-error" role="alert">{deleteConfirmation.failureMessage}</p> : null}<div className="dialog-actions"><button disabled={deleteConfirmation.busy} onClick={() => setDeleteConfirmation(null)}>取消</button><button className="danger-button" disabled={deleteConfirmation.busy} onClick={() => { const current = deleteConfirmation; setDeleteConfirmation({ ...current, busy: true, failureMessage: null }); void props.onDeleteConversation(current.projectId, current.conversationId, current.lifecycleRevision, current.confirmation.token).then(() => setDeleteConfirmation(null)).catch((cause) => setDeleteConfirmation({ ...current, busy: false, failureMessage: userFacingErrorMessage(cause, "conversation") })); }}>{deleteConfirmation.busy ? "正在删除" : "永久删除"}</button></div></> : null}
    </DialogSurface>
  </div>;
}

type Conversation = ReturnType<typeof projectNavigationConversations>[number];
type DeleteState = { projectId: string; conversationId: string; title: string; lifecycleRevision: string; confirmation: ConversationDeleteConfirmation; busy: boolean; failureMessage: string | null };

function ConversationRow({ projectId, conversation, archived, props, runLifecycleAction, onDelete, onLifecycleError }: { projectId: string | null; conversation: Conversation; archived: boolean; props: ProjectNavigationSurfaceProps; runLifecycleAction: (action: Promise<void>) => Promise<void>; onDelete: (state: DeleteState) => void; onLifecycleError: (message: string | null) => void }): ReactElement {
  const { overlay } = props;
  const open = Boolean(projectId && overlay.kind === "conversation-actions" && overlay.projectId === projectId && overlay.conversationId === conversation.id);
  const items: ResponsiveActionMenuItem[] = archived ? [
    ...(conversation.lifecycle?.canRestore ? [{ id: "restore", label: "恢复", icon: <ArchiveRestore size={14} />, onSelect: () => projectId && conversation.lifecycle && void runLifecycleAction(props.onRestoreConversation(projectId, conversation.id, conversation.lifecycle.lifecycleRevision)) }] : []),
    { id: "delete", label: conversation.lifecycle?.archiveOrigin === "harness-workflow" ? "永久删除本地会话记录" : "永久删除", icon: <Trash2 size={14} />, danger: true, disabled: !conversation.lifecycle?.canDelete, disabledReason: conversation.lifecycle?.disabledReason, onSelect: () => { if (!projectId || !conversation.lifecycle) return; onLifecycleError(null); void props.onPrepareConversationDelete(projectId, conversation.id, conversation.lifecycle.lifecycleRevision).then((confirmation) => onDelete({ projectId, conversationId: conversation.id, title: conversation.title, lifecycleRevision: conversation.lifecycle!.lifecycleRevision, confirmation, busy: false, failureMessage: null })).catch((cause) => onLifecycleError(userFacingErrorMessage(cause, "conversation"))); } },
  ] : [
    { id: "rename", label: "重命名", icon: <Pencil size={14} />, onSelect: () => projectId && props.onOpenRenameConversation(projectId, conversation.id, conversation.title) },
    { id: "archive", label: "归档", icon: <Archive size={14} />, disabled: !conversation.lifecycle?.canArchive, disabledReason: conversation.lifecycle?.disabledReason, onSelect: () => projectId && conversation.lifecycle && void runLifecycleAction(props.onArchiveConversation(projectId, conversation.id, conversation.lifecycle.lifecycleRevision)) },
  ];
  return <div className={`conversation-row-wrap${archived ? " archived" : ""}${conversation.selected ? " selected" : ""}`}><button className={`conversation-row${conversation.selected ? " selected" : ""}`} onClick={() => projectId && void props.onChooseConversation(projectId, conversation.id)}><span>{conversation.title}</span><small>{archived ? "已归档" : conversation.userStatusLabel}</small>{conversation.waitingDecisionCount > 0 ? <b aria-label={`${conversation.waitingDecisionCount} 个待确认`}>{conversation.waitingDecisionCount}</b> : null}</button><ResponsiveActionMenu open={open} onOpenChange={(next) => next && projectId ? props.onOpenConversationActions(projectId, conversation.id) : props.onCloseOverlay()} trigger={<MoreHorizontal size={14} />} triggerLabel={`${conversation.title} 会话菜单`} triggerClassName="conversation-more" menuLabel={`${conversation.title} 会话菜单`} items={items} /></div>;
}

function ProjectFormDialog({ overlay, onClose, onDone }: { overlay: ProjectNavigationSurfaceProps["overlay"]; onClose: () => void; onDone: (projectId?: string) => Promise<void> }): ReactElement {
  const [busy, setBusy] = useState(false);
  const open = overlay.kind === "project-form";
  return <DialogSurface open={open} onClose={onClose} dismissible={!busy} ariaLabel={overlay.kind === "project-form" && overlay.flow === "create" ? "新建项目" : "打开文件夹"} overlayClassName="task-dialog-overlay" panelClassName="project-form-dialog" portal>{overlay.kind === "project-form" ? <><header className="task-dialog-header"><h2>{overlay.flow === "create" ? "新建项目" : "打开文件夹"}</h2><button type="button" className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={17} /></button></header>{overlay.flow === "create" ? <ProjectCreateForm onDone={onDone} onBusyChange={setBusy} /> : <ProjectAddForm onDone={onDone} onBusyChange={setBusy} />}<div className="project-form-dialog-actions"><button type="button" className="text-button" disabled={busy} onClick={onClose}>取消</button></div></> : null}</DialogSurface>;
}

function RenameConversationDialog({ overlay, onClose, onRename }: { overlay: ProjectNavigationSurfaceProps["overlay"]; onClose: () => void; onRename: (projectId: string, conversationId: string, title: string) => Promise<void> }): ReactElement {
  if (overlay.kind !== "rename-conversation") return <></>;
  return <RenameConversationDialogBody key={`${overlay.projectId}:${overlay.conversationId}`} overlay={overlay} onClose={onClose} onRename={onRename} />;
}

function RenameConversationDialogBody({ overlay, onClose, onRename }: { overlay: Extract<ProjectNavigationSurfaceProps["overlay"], { kind: "rename-conversation" }>; onClose: () => void; onRename: (projectId: string, conversationId: string, title: string) => Promise<void> }): ReactElement {
  const [value, setValue] = useState(overlay.title);
  const [busy, setBusy] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const save = async () => { const title = value.replace(/\s+/g, " ").trim(); if (!title || title === overlay.title) { onClose(); return; } setBusy(true); setFailureMessage(null); try { await onRename(overlay.projectId, overlay.conversationId, title); onClose(); } catch (cause) { setBusy(false); setFailureMessage(userFacingErrorMessage(cause, "conversation")); } };
  return <DialogSurface open onClose={onClose} dismissible={!busy} ariaLabelledBy="rename-conversation-title" panelClassName="rename-conversation-dialog" portal><form onSubmit={(event) => { event.preventDefault(); void save(); }}><h2 id="rename-conversation-title">重命名会话</h2><label><span>会话名称</span><input autoFocus disabled={busy} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.key !== "Enter") return; event.preventDefault(); void save(); }} /></label>{failureMessage ? <p className="form-error" role="alert">{failureMessage}</p> : null}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !value.trim()}>{busy ? "正在保存" : "保存"}</button></div></form></DialogSurface>;
}

export function currentWorkpadSummary(snapshot: Snapshot, topic: TopicDetail | null): WorkpadSummary | undefined { return topic ? snapshot.left.workpads?.find((item) => item.id === topic.id) : undefined; }

export function UnmanagedProjectView({ project, onRetry, onOpenDiagnostics }: { project: ProjectStatus | null; onRetry: () => void | Promise<void>; onOpenDiagnostics: () => void }): ReactElement {
  const identity = project?.project?.id ?? project?.path ?? "";
  const identityRef = useRef(identity); identityRef.current = identity;
  const generationRef = useRef(0);
  const [retry, setRetry] = useState({ identity, busy: false, failure: null as string | null });
  const state = retry.identity === identity ? retry : { identity, busy: false, failure: null };
  if (!project?.project) return <EmptyWorkbench title="项目不可用" description="请选择左侧项目或重新刷新项目列表。" />;
  const issue = harnessStatusIssue(project);
  return <section className="empty-workbench"><p className="eyebrow">项目已添加</p><h1>{projectDisplayName(project.project)}</h1><p>{issue?.detail ?? "项目协作配置尚未完成准备。"}</p>{project.runtimeAvailability?.state === "unavailable" ? <><p>{project.runtimeAvailability.recovery ?? "修复后请退出并重新打开 Beaver Code。"}</p>{state.failure ? <p className="form-error" role="alert">{state.failure}</p> : null}<div className="empty-workbench-actions"><button className="primary-button" disabled={state.busy} onClick={() => { const generation = ++generationRef.current; const key = identity; setRetry({ identity: key, busy: true, failure: null }); void Promise.resolve().then(onRetry).catch((cause) => { if (generation === generationRef.current && key === identityRef.current) setRetry({ identity: key, busy: false, failure: userFacingErrorMessage(cause, "load") }); }).finally(() => { if (generation === generationRef.current && key === identityRef.current) setRetry((current) => current.identity === key ? { ...current, busy: false } : current); }); }}>{state.busy ? "正在检测…" : "重新检测"}</button><button className="outline-button" onClick={onOpenDiagnostics}>查看诊断</button><button className="outline-button" onClick={() => { window.location.href = "/"; }}>打开其他项目</button></div></> : null}</section>;
}

export function TopicEmptyView({ snapshot, composerText, setComposerText, onCreate, busy }: { snapshot: Snapshot; composerText: string; setComposerText: (value: string) => void; onCreate: () => Promise<void>; busy: boolean }): ReactElement { return <section className="topic-empty-view"><div className="breadcrumb">{projectDisplayName(snapshot.project, "project")} / 需求对话</div><div className="topic-empty-content"><p className="eyebrow">本地工作台</p><h1>暂无需求对话</h1><p>输入一个需求或问题来创建第一个需求对话。AHO 会先规划并确认，再进入实现。</p><div className="empty-composer"><textarea value={composerText} onChange={(event) => setComposerText(event.target.value)} placeholder="例如：帮我新增会员满 100 元 9 折，并补测试。" /><button className="primary-button" disabled={busy || !composerText.trim()} onClick={() => void onCreate()}>创建需求对话</button></div></div></section>; }
export function EmptyWorkbench({ title, description }: { title: string; description: string }): ReactElement { return <section className="empty-workbench"><p className="eyebrow">本地工作台</p><h1>{title}</h1><p>{description}</p></section>; }
function harnessStatusIssue(project: ProjectStatus, snapshot?: Snapshot): { detail: string } | null { const ready = snapshot?.harness.harnessReady ?? project.harness.readiness === "ready"; if (ready) return null; if (project.runtimeAvailability?.state === "unavailable" || project.harness.readiness === "unavailable") return { detail: project.runtimeAvailability?.summary ?? "这个项目的协作配置无法读取。你仍然可以打开其他项目。" }; if (project.harness.readiness === "partial") return { detail: "这个项目需要处理后才能继续使用。" }; return null; }
function projectParentContext(path: string): string { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length >= 2 ? parts.at(-2) ?? path : path; }
