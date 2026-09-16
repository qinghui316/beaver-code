import { useRef, useState, type ReactElement } from "react";
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import {
  ProjectAddForm,
  ProjectCreateForm,
} from "../panels/ProjectPanels.js";
import { projectDisplayName } from "../formatters.js";
import {
  groupProjectNavigationConversations,
  projectNavigationConversations,
  type ProjectNavigationSurfaceProps,
  type ProjectNavigationFeatureSurface,
} from "../presentation/project-navigation.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type {
  ConversationDeleteConfirmation,
  ProjectStatus,
  Snapshot,
  TopicDetail,
  WorkpadSummary,
} from "../types.js";

export function ProjectConversationSidebarFeature({ surface }: { surface: ProjectNavigationFeatureSurface }): ReactElement {
  return <ProjectConversationSidebar {...surface.view} {...surface.actions} />;
}

export function ProjectConversationSidebar({
  projects,
  selectedProjectId,
  selectedTopicId,
  snapshots,
  snapshot,
  search,
  onSearch,
  expandedProjects,
  projectMenuMode,
  projectDetailsId,
  onProjectMenuMode,
  onProjectDetails,
  onNewConversation,
  onOpenProject,
  onToggleProject,
  onChooseConversation,
  onArchiveConversation,
  onRestoreConversation,
  onPrepareConversationDelete,
  onDeleteConversation,
  onRenameConversation,
  onRemoveProject,
  onRefresh,
  onOpenSettings,
  onOpenProjectSettings,
}: ProjectNavigationSurfaceProps): ReactElement {
  const [conversationMenuId, setConversationMenuId] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [archivedProjects, setArchivedProjects] = useState<Set<string>>(new Set());
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    projectId: string;
    conversationId: string;
    title: string;
    lifecycleRevision: string;
    confirmation: ConversationDeleteConfirmation;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const renameInFlightRef = useRef(false);
  const cancelRenameRef = useRef(false);
  const [editingConversation, setEditingConversation] = useState<{
    menuId: string;
    projectId: string;
    conversationId: string;
    originalTitle: string;
    value: string;
    saving: boolean;
    error: string | null;
  } | null>(null);
  const visibleProjects = projects;
  const normalizedSearch = search.trim().toLowerCase();
  const projectNameCounts = new Map<string, number>();
  for (const item of visibleProjects) {
    const name = projectDisplayName(item.project ?? { path: item.path });
    projectNameCounts.set(name, (projectNameCounts.get(name) ?? 0) + 1);
  }
  async function afterProjectAdded(projectId?: string): Promise<void> {
    await onRefresh();
    if (projectId) await onOpenProject(projectId);
    onProjectMenuMode("closed");
  }
  async function commitConversationRename(): Promise<void> {
    const editing = editingConversation;
    if (!editing || editing.saving || renameInFlightRef.current) return;
    const title = editing.value.replace(/\s+/g, " ").trim();
    if (title === editing.originalTitle) {
      setEditingConversation(null);
      return;
    }
    renameInFlightRef.current = true;
    setEditingConversation({ ...editing, saving: true, error: null });
    try {
      await onRenameConversation(editing.projectId, editing.conversationId, title);
      setEditingConversation(null);
    } catch (cause) {
      setEditingConversation({
        ...editing,
        value: editing.originalTitle,
        saving: false,
        error: userFacingErrorMessage(cause, "conversation"),
      });
    } finally {
      renameInFlightRef.current = false;
    }
  }
  async function runLifecycleAction(action: Promise<void>): Promise<void> {
    setLifecycleError(null);
    try {
      await action;
    } catch (cause) {
      setLifecycleError(userFacingErrorMessage(cause, "conversation"));
    }
  }
  return (
    <div className="project-conversation-sidebar">
      <nav className="global-nav" aria-label="全局入口">
        <label className="sidebar-search">
          <Search size={15} />
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索项目和对话" aria-label="搜索项目和对话" />
        </label>
      </nav>

      <section className="project-tree" aria-label="项目">
        <div className="project-tree-header">
          <span className="section-label">项目</span>
          <button className="icon-button compact-icon" aria-label="项目菜单" onClick={() => onProjectMenuMode(projectMenuMode === "closed" ? "add" : "closed")}><FolderPlus size={15} /></button>
        </div>
        {projectMenuMode !== "closed" ? (
          <div className="project-menu-popover">
            <button className={`project-menu-item ${projectMenuMode === "add" ? "selected" : ""}`} onClick={() => onProjectMenuMode("add")}><Folder size={15} />打开文件夹</button>
            <button className={`project-menu-item ${projectMenuMode === "new" ? "selected" : ""}`} onClick={() => onProjectMenuMode("new")}><FolderPlus size={15} />新建项目</button>
            {projectMenuMode === "add" ? <ProjectAddForm onDone={afterProjectAdded} /> : null}
            {projectMenuMode === "new" ? <ProjectCreateForm onDone={afterProjectAdded} /> : null}
          </div>
        ) : null}

        <div className="project-folder-list">
          {visibleProjects.length === 0 ? <div className="empty-state sidebar-empty">还没有项目。</div> : null}
          {visibleProjects.map((item) => {
            const projectId = item.project?.id ?? item.path;
            const concreteProjectId = item.project?.id ?? null;
            const projectName = projectDisplayName(item.project ?? { path: item.path });
            const duplicateName = (projectNameCounts.get(projectName) ?? 0) > 1;
            const selected = item.project?.id === selectedProjectId;
            const expanded = selected || expandedProjects.has(projectId);
            const projectSnapshot = item.project?.id === selectedProjectId ? snapshot : item.project?.id ? snapshots[item.project.id] : undefined;
            const hasConversationSnapshot = Boolean(projectSnapshot?.left.workpads?.length || projectSnapshot?.left.topics?.length);
            const harnessReady = projectSnapshot?.harness.harnessReady ?? item.harness.readiness === "ready";
            const harnessIssue = harnessStatusIssue(item, projectSnapshot);
            const duplicateContext = duplicateName ? projectParentContext(item.path) : null;
            const projectUnavailable = item.runtimeAvailability?.state === "unavailable";
            const canStartConversation = Boolean(
              item.project
              && item.pathExists
              && !projectUnavailable,
            );
            const conversations = projectNavigationConversations(projectSnapshot, selectedTopicId);
            const groupedConversations = groupProjectNavigationConversations(conversations, search);
            const activeConversations = groupedConversations.active;
            const archivedConversations = groupedConversations.archived;
            const archivedOpen = normalizedSearch.length > 0 || archivedProjects.has(projectId);
            const showProject = !normalizedSearch || projectName.toLowerCase().includes(normalizedSearch) || groupedConversations.hasSearchMatch;
            if (!showProject) return null;
            return (
              <div className="project-folder" key={projectId}>
                <div className={`project-folder-row ${selected ? "selected" : ""}`}>
                  <button className="project-folder-toggle" aria-label={expanded ? "收起项目" : "展开项目"} onClick={() => item.project ? void onToggleProject(item.project.id) : undefined}>
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button className="project-folder-main" aria-label={projectName} title={projectName} onClick={() => item.project ? void onOpenProject(item.project.id) : undefined}>
                    <Folder size={16} />
                    <span className="project-folder-text">
                      <strong>{projectName}</strong>
                      {duplicateContext ? <small aria-hidden="true">· {duplicateContext}</small> : null}
                    </span>
                  </button>
                  {harnessIssue ? <span className="project-folder-status" role="img" aria-label={harnessIssue.detail} title={harnessIssue.detail}><CircleAlert size={14} /></span> : null}
                  <span className="project-folder-actions">
                    {canStartConversation ? (
                      <button
                        className="project-folder-new"
                        aria-label={`在 ${projectName} 中开始新对话`}
                        title={`在 ${projectName} 中开始新对话`}
                        onClick={() => void onNewConversation(item.project?.id)}
                      >
                        <FileText size={15} />
                      </button>
                    ) : null}
                    <button className="project-folder-more" aria-label="更多项目操作" onClick={() => onProjectDetails(projectDetailsId === projectId ? null : projectId)}>
                      <MoreHorizontal size={15} />
                    </button>
                  </span>
                </div>
                {projectDetailsId === projectId ? (
                  <div className="project-row-menu-popover" role="menu" aria-label={`${projectName} 项目菜单`}>
                    <button className="project-menu-item" role="menuitem" onClick={() => {
                      onProjectDetails(null);
                      if (item.project) void onOpenProject(item.project.id);
                    }}><Folder size={15} />打开项目首页</button>
                    {concreteProjectId ? (
                      <button className="project-menu-item" role="menuitem" onClick={() => {
                        onProjectDetails(null);
                        onOpenProjectSettings(concreteProjectId);
                      }}><Settings size={15} />项目设置</button>
                    ) : null}
                    {concreteProjectId ? (
                      <button className="project-menu-item danger" role="menuitem" onClick={() => {
                        onProjectDetails(null);
                        void onRemoveProject(concreteProjectId);
                      }}><Trash2 size={15} />移出项目</button>
                    ) : null}
                  </div>
                ) : null}
                {expanded ? (
                  <div className="conversation-list">
                    {lifecycleError && selected ? <div className="conversation-lifecycle-error" role="alert">{lifecycleError}</div> : null}
                    {harnessReady && !projectSnapshot ? <div className="conversation-placeholder">正在加载对话。</div> : null}
                    {!projectUnavailable && !harnessReady && !hasConversationSnapshot ? <div className="conversation-placeholder">创建第一条会话即可开始使用。</div> : null}
                    {activeConversations.map((conversation) => {
                      const menuId = `${projectId}:${conversation.id}`;
                      const editing = editingConversation?.menuId === menuId ? editingConversation : null;
                      return (
                        <div className={`conversation-row-wrap ${conversation.selected ? "selected" : ""}`} key={conversation.id}>
                          {editing ? (
                            <div className="conversation-row conversation-row-editing">
                              <input
                                aria-label={`重命名 ${conversation.title}`}
                                autoFocus
                                disabled={editing.saving}
                                value={editing.value}
                                onChange={(event) => setEditingConversation({ ...editing, value: event.target.value, error: null })}
                                onBlur={() => {
                                  if (cancelRenameRef.current) {
                                    cancelRenameRef.current = false;
                                    return;
                                  }
                                  void commitConversationRename();
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void commitConversationRename();
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    cancelRenameRef.current = true;
                                    setEditingConversation(null);
                                  }
                                }}
                              />
                              {editing.error ? <small role="alert">{editing.error}</small> : null}
                            </div>
                          ) : <button
                            className={`conversation-row ${conversation.selected ? "selected" : ""}`}
                            onClick={() => item.project ? void onChooseConversation(item.project.id, conversation.id) : undefined}
                          >
                            <span>{conversation.title}</span>
                            <small>{conversation.status}</small>
                            {conversation.waitingDecisionCount > 0 ? <b aria-label={`${conversation.waitingDecisionCount} 个待确认`}>{conversation.waitingDecisionCount}</b> : null}
                          </button>}
                          <button
                            className="conversation-more"
                            aria-label={`${conversation.title} 会话菜单`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setConversationMenuId(conversationMenuId === menuId ? null : menuId);
                            }}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                          {conversationMenuId === menuId ? (
                            <div className="conversation-row-menu" role="menu">
                              <button className="project-menu-item" role="menuitem" onClick={() => {
                                setConversationMenuId(null);
                                if (!item.project) return;
                                cancelRenameRef.current = false;
                                setEditingConversation({
                                  menuId,
                                  projectId: item.project.id,
                                  conversationId: conversation.id,
                                  originalTitle: conversation.title,
                                  value: conversation.title,
                                  saving: false,
                                  error: null,
                                });
                              }}><Pencil size={14} />重命名</button>
                              <button
                                className="project-menu-item"
                                role="menuitem"
                                disabled={!conversation.lifecycle?.canArchive}
                                title={conversation.lifecycle?.disabledReason}
                                onClick={() => {
                                setConversationMenuId(null);
                                if (item.project && conversation.lifecycle) void runLifecycleAction(onArchiveConversation(
                                  item.project.id,
                                  conversation.id,
                                  conversation.lifecycle.lifecycleRevision,
                                ));
                              }}><Archive size={14} />归档</button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                    {archivedConversations.length > 0 ? (
                      <button
                        className="conversation-archive-toggle"
                        aria-expanded={archivedOpen}
                        onClick={() => setArchivedProjects((current) => {
                          const next = new Set(current);
                          if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
                          return next;
                        })}
                      >{archivedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}已归档</button>
                    ) : null}
                    {archivedOpen ? archivedConversations.map((conversation) => {
                      const menuId = `${projectId}:${conversation.id}`;
                      return (
                        <div className="conversation-row-wrap archived" key={conversation.id}>
                          <button className="conversation-row" onClick={() => item.project ? void onChooseConversation(item.project.id, conversation.id) : undefined}>
                            <span>{conversation.title}</span>
                            <small>已归档</small>
                          </button>
                          <button className="conversation-more" aria-label={`${conversation.title} 会话菜单`} onClick={(event) => {
                            event.stopPropagation();
                            setConversationMenuId(conversationMenuId === menuId ? null : menuId);
                          }}><MoreHorizontal size={14} /></button>
                          {conversationMenuId === menuId ? (
                            <div className="conversation-row-menu" role="menu">
                              {conversation.lifecycle?.canRestore ? (
                                <button className="project-menu-item" role="menuitem" onClick={() => {
                                  setConversationMenuId(null);
                                  if (item.project && conversation.lifecycle) void runLifecycleAction(onRestoreConversation(
                                    item.project.id,
                                    conversation.id,
                                    conversation.lifecycle.lifecycleRevision,
                                  ));
                                }}><ArchiveRestore size={14} />恢复</button>
                              ) : null}
                              <button className="project-menu-item danger" role="menuitem" disabled={!conversation.lifecycle?.canDelete} title={conversation.lifecycle?.disabledReason} onClick={() => {
                                setConversationMenuId(null);
                                if (!item.project || !conversation.lifecycle) return;
                                void onPrepareConversationDelete(item.project.id, conversation.id, conversation.lifecycle.lifecycleRevision)
                                  .then((confirmation) => setDeleteConfirmation({
                                    projectId: item.project!.id,
                                    conversationId: conversation.id,
                                    title: conversation.title,
                                    lifecycleRevision: conversation.lifecycle!.lifecycleRevision,
                                    confirmation,
                                    busy: false,
                                    error: null,
                                  }))
                                  .catch((cause) => setLifecycleError(userFacingErrorMessage(cause, "conversation")));
                              }}><Trash2 size={14} />{conversation.lifecycle?.archiveOrigin === "harness-workflow" ? "永久删除本地会话记录" : "永久删除"}</button>
                            </div>
                          ) : null}
                        </div>
                      );
                    }) : null}
                    {harnessReady && projectSnapshot && activeConversations.length === 0 && archivedConversations.length === 0 ? <div className="conversation-placeholder">暂无对话。</div> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <div className="sidebar-settings">
        <button className="global-nav-item settings-entry" onClick={onOpenSettings}><Settings size={16} />设置</button>
      </div>
      {deleteConfirmation ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !deleteConfirmation.busy) setDeleteConfirmation(null);
        }}>
          <section className="conversation-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-delete-title">
            <h2 id="conversation-delete-title">永久删除“{deleteConfirmation.title}”？</h2>
            <p>{deleteConfirmation.confirmation.effect}</p>
            <p>此操作不会修改项目文件，且无法从 Workbench 恢复。</p>
            {deleteConfirmation.error ? <p className="form-error" role="alert">{deleteConfirmation.error}</p> : null}
            <div className="dialog-actions">
              <button disabled={deleteConfirmation.busy} onClick={() => setDeleteConfirmation(null)}>取消</button>
              <button className="danger-button" disabled={deleteConfirmation.busy} onClick={() => {
                const current = deleteConfirmation;
                setDeleteConfirmation({ ...current, busy: true, error: null });
                void onDeleteConversation(current.projectId, current.conversationId, current.lifecycleRevision, current.confirmation.token)
                  .then(() => setDeleteConfirmation(null))
                  .catch((cause) => setDeleteConfirmation({ ...current, busy: false, error: userFacingErrorMessage(cause, "conversation") }));
              }}>{deleteConfirmation.busy ? "正在删除" : "永久删除"}</button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function currentWorkpadSummary(snapshot: Snapshot, topic: TopicDetail | null): WorkpadSummary | undefined {
  if (!topic) return undefined;
  return snapshot.left.workpads?.find((item) => item.id === topic.id);
}

export function UnmanagedProjectView({ project, onRetry, onOpenDiagnostics }: {
  project: ProjectStatus | null;
  onRetry: () => void | Promise<void>;
  onOpenDiagnostics: () => void;
}): ReactElement {
  const retryIdentityKey = project?.project?.id ?? project?.path ?? "";
  const retryIdentityRef = useRef(retryIdentityKey);
  retryIdentityRef.current = retryIdentityKey;
  const retryGenerationRef = useRef(0);
  const [retryState, setRetryState] = useState<{ identityKey: string; retrying: boolean; failure: string | null }>({
    identityKey: retryIdentityKey,
    retrying: false,
    failure: null,
  });
  const currentRetryState = retryState.identityKey === retryIdentityKey
    ? retryState
    : { identityKey: retryIdentityKey, retrying: false, failure: null };
  if (!project?.project) return <EmptyWorkbench title="项目不可用" description="请选择左侧项目或重新刷新项目列表。" />;
  const issue = harnessStatusIssue(project);
  return (
    <section className="empty-workbench">
      <p className="eyebrow">项目已添加</p>
      <h1>{projectDisplayName(project.project)}</h1>
      <p>{issue?.detail ?? "项目协作配置尚未完成准备。"}</p>
      {project.runtimeAvailability?.state === "unavailable" ? (
        <>
          <p>{project.runtimeAvailability.recovery ?? "修复后请退出并重新打开 Beaver Code。"}</p>
          {currentRetryState.failure ? <p className="form-error" role="alert">{currentRetryState.failure}</p> : null}
          <div className="empty-workbench-actions">
            <button type="button" className="primary-button" disabled={currentRetryState.retrying} onClick={() => {
              const generation = ++retryGenerationRef.current;
              const identityKey = retryIdentityKey;
              setRetryState({ identityKey, retrying: true, failure: null });
              void Promise.resolve()
                .then(onRetry)
                .catch((cause: unknown) => {
                  if (generation === retryGenerationRef.current && identityKey === retryIdentityRef.current) {
                    setRetryState({ identityKey, retrying: true, failure: userFacingErrorMessage(cause, "load") });
                  }
                })
                .finally(() => {
                  if (generation === retryGenerationRef.current && identityKey === retryIdentityRef.current) {
                    setRetryState((current) => current.identityKey === identityKey ? { ...current, retrying: false } : current);
                  }
                });
            }}>{currentRetryState.retrying ? "正在检测…" : "重新检测"}</button>
            <button type="button" className="outline-button" onClick={onOpenDiagnostics}>查看诊断</button>
            <button type="button" className="outline-button" onClick={() => { window.location.href = "/"; }}>打开其他项目</button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function TopicEmptyView({
  snapshot,
  composerText,
  setComposerText,
  onCreate,
  busy,
}: {
  snapshot: Snapshot;
  composerText: string;
  setComposerText: (value: string) => void;
  onCreate: () => Promise<void>;
  busy: boolean;
}): ReactElement {
  return (
    <section className="topic-empty-view">
      <div className="breadcrumb">{projectDisplayName(snapshot.project, "project")} / 需求对话</div>
      <div className="topic-empty-content">
        <p className="eyebrow">本地工作台</p>
        <h1>暂无需求对话</h1>
        <p>输入一个需求或问题来创建第一个需求对话。AHO 会先规划并确认，再进入实现。</p>
        <div className="empty-composer">
          <textarea value={composerText} onChange={(event) => setComposerText(event.target.value)} placeholder="例如：帮我新增会员满 100 元 9 折，并补测试。" />
          <button className="primary-button" disabled={busy || !composerText.trim()} onClick={() => void onCreate()}>创建需求对话</button>
        </div>
      </div>
    </section>
  );
}

export function EmptyWorkbench({ title, description }: { title: string; description: string }): ReactElement {
  return (
    <section className="empty-workbench">
      <p className="eyebrow">本地工作台</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}

function harnessStatusIssue(project: ProjectStatus, snapshot?: Snapshot): { kind: "uninitialized"; short: string; detail: string } | null {
  const harnessReady = snapshot?.harness.harnessReady ?? project.harness.readiness === "ready";
  if (harnessReady) return null;
  if (project.runtimeAvailability?.state === "unavailable" || project.harness.readiness === "unavailable") {
    return {
      kind: "uninitialized",
      short: "项目需要处理",
      detail: project.runtimeAvailability?.summary ?? "这个项目的协作配置无法读取。你仍然可以打开其他项目。",
    };
  }
  if (project.harness.readiness === "partial") return {
    kind: "uninitialized",
    short: "项目需要处理",
    detail: "这个项目需要处理后才能继续使用。",
  };
  return null;
}

function projectParentContext(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts.at(-2) ?? path : path;
}
