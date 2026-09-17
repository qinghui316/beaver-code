import { workpadStatusLabel } from "../formatters.js";
import type {
  ConversationDeleteConfirmation,
  ConversationLifecycleSnapshot,
  ProjectStatus,
  Snapshot,
  WorkpadSummary,
} from "../types.js";
import type { FeatureSurface } from "./feature-surface.js";
import { projectDisplayName } from "../formatters.js";

export type ProjectNavigationOverlayState =
  | { readonly kind: "closed" }
  | { readonly kind: "search"; readonly query: string; readonly activeIndex: number }
  | { readonly kind: "project-create-actions" }
  | { readonly kind: "project-actions"; readonly projectId: string }
  | { readonly kind: "conversation-actions"; readonly projectId: string; readonly conversationId: string }
  | { readonly kind: "project-form"; readonly flow: "open" | "create" }
  | { readonly kind: "rename-conversation"; readonly projectId: string; readonly conversationId: string; readonly title: string };

export interface ProjectNavigationViewModel {
  projects: ProjectStatus[];
  selectedProjectId: string | null;
  selectedTopicId: string | null;
  snapshots: Record<string, Snapshot>;
  snapshot: Snapshot;
  expandedProjects: Set<string>;
  overlay: ProjectNavigationOverlayState;
}

export interface ProjectNavigationActions {
  onCloseOverlay: () => void;
  onOpenSearch: () => void;
  onSetSearchQuery: (query: string) => void;
  onSetSearchActiveIndex: (activeIndex: number) => void;
  onPrepareSearch: () => Promise<void>;
  onOpenProjectCreateActions: () => void;
  onOpenProjectActions: (projectId: string) => void;
  onOpenConversationActions: (projectId: string, conversationId: string) => void;
  onOpenProjectForm: (flow: "open" | "create") => void;
  onOpenRenameConversation: (projectId: string, conversationId: string, title: string) => void;
  onNewConversation: (projectId?: string) => Promise<void>;
  onOpenProject: (projectId: string) => Promise<void>;
  onToggleProject: (projectId: string) => Promise<void>;
  onChooseConversation: (projectId: string, conversationId: string) => Promise<void>;
  onArchiveConversation: (projectId: string, conversationId: string, lifecycleRevision: string) => Promise<void>;
  onRestoreConversation: (projectId: string, conversationId: string, lifecycleRevision: string) => Promise<void>;
  onPrepareConversationDelete: (projectId: string, conversationId: string, lifecycleRevision: string) => Promise<ConversationDeleteConfirmation>;
  onDeleteConversation: (projectId: string, conversationId: string, lifecycleRevision: string, confirmationToken: string) => Promise<void>;
  onRenameConversation: (projectId: string, conversationId: string, title: string) => Promise<void>;
  onRemoveProject: (projectId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenProjectSettings: (projectId: string) => void;
}

export type ProjectNavigationSearchResult =
  | { readonly kind: "project"; readonly key: string; readonly projectId: string; readonly title: string; readonly context: string | null; readonly statusLabel: string }
  | { readonly kind: "conversation"; readonly key: string; readonly projectId: string; readonly conversationId: string; readonly title: string; readonly projectTitle: string; readonly statusLabel: string; readonly archived: boolean };

export function projectNavigationSearchResults(input: {
  readonly projects: readonly ProjectStatus[];
  readonly snapshots: Readonly<Record<string, Snapshot>>;
  readonly selectedProjectId: string | null;
  readonly selectedConversationId: string | null;
  readonly query: string;
}): readonly ProjectNavigationSearchResult[] {
  const query = input.query.trim().toLocaleLowerCase();
  const projects = [...input.projects]
    .filter((item): item is ProjectStatus & { project: NonNullable<ProjectStatus["project"]> } => Boolean(item.project))
    .sort((a, b) => Number(b.project.id === input.selectedProjectId) - Number(a.project.id === input.selectedProjectId));
  const nameCounts = new Map<string, number>();
  for (const item of projects) {
    const name = projectDisplayName(item.project);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const results: ProjectNavigationSearchResult[] = [];
  for (const item of projects) {
    const projectId = item.project.id;
    const title = projectDisplayName(item.project);
    const context = (nameCounts.get(title) ?? 0) > 1 ? projectParentContext(item.path) : null;
    const status = item.runtimeAvailability?.state === "unavailable" ? "需要处理" : "项目";
    if (!query || `${title} ${context ?? ""} ${status}`.toLocaleLowerCase().includes(query)) {
      results.push({ kind: "project", key: `project:${projectId}`, projectId, title, context, statusLabel: status });
    }
    const conversations = projectNavigationConversations(input.snapshots[projectId], input.selectedConversationId);
    for (const conversation of conversations) {
      const archived = conversation.state === "archive";
      const searchable = `${conversation.title} ${title} ${conversation.userStatusLabel} ${archived ? "已归档" : ""}`.toLocaleLowerCase();
      if (!query || searchable.includes(query)) {
        results.push({
          kind: "conversation",
          key: `conversation:${projectId}:${conversation.id}`,
          projectId,
          conversationId: conversation.id,
          title: conversation.title,
          projectTitle: title,
          statusLabel: conversation.userStatusLabel,
          archived,
        });
      }
    }
  }
  return results;
}

export type ProjectNavigationSurfaceProps = ProjectNavigationViewModel & ProjectNavigationActions;

export type ProjectNavigationFeatureSurface = FeatureSurface<ProjectNavigationViewModel, ProjectNavigationActions>;

export function projectNavigationSurface(
  view: ProjectNavigationViewModel,
  actions: ProjectNavigationActions,
): ProjectNavigationFeatureSurface {
  return { view, actions };
}

export interface ProjectNavigationConversationViewModel {
  readonly id: string;
  readonly title: string;
  readonly userStatusLabel: string;
  readonly selected: boolean;
  readonly waitingDecisionCount: number;
  readonly blocker?: string;
  readonly state: string;
  readonly lifecycle?: ConversationLifecycleSnapshot;
}

export interface ProjectNavigationConversationGroups {
  readonly active: readonly ProjectNavigationConversationViewModel[];
  readonly archived: readonly ProjectNavigationConversationViewModel[];
  readonly hasSearchMatch: boolean;
}

export function projectNavigationConversations(
  snapshot: Snapshot | undefined,
  selectedConversationId: string | null,
): readonly ProjectNavigationConversationViewModel[] {
  if (!snapshot) return [];
  const workpads = snapshot.left.workpads?.length
    ? snapshot.left.workpads
    : snapshot.left.topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      state: topic.state,
      runtimeStatus: topic.state === "archive" ? "archived" : "active",
      userStatus: topic.state === "archive" ? "completed" : "waiting-confirmation",
      userStatusLabel: topic.state === "archive" ? "已完成" : "等你确认",
      selected: selectedConversationId === topic.id,
      waitingDecisionCount: 0,
      blocker: undefined,
    } satisfies WorkpadSummary));
  return workpads.map((workpad) => ({
    id: workpad.id,
    title: workpad.title,
    userStatusLabel: workpad.userStatusLabel ?? workpadStatusLabel(workpad.runtimeStatus),
    selected: selectedConversationId === workpad.id || workpad.selected,
    waitingDecisionCount: workpad.waitingDecisionCount,
    blocker: workpad.blocker,
    state: workpad.state,
    lifecycle: snapshot.left.topics.find((topic) => topic.id === workpad.id)?.lifecycle,
  }));
}

export function groupProjectNavigationConversations(
  conversations: readonly ProjectNavigationConversationViewModel[],
  search: string,
): ProjectNavigationConversationGroups {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filtered = normalizedSearch
    ? conversations.filter((conversation) => (
      conversation.title.toLocaleLowerCase().includes(normalizedSearch)
      || conversation.userStatusLabel.toLocaleLowerCase().includes(normalizedSearch)
    ))
    : conversations;
  return {
    active: filtered.filter((conversation) => conversation.state !== "archive"),
    archived: filtered.filter((conversation) => conversation.state === "archive"),
    hasSearchMatch: filtered.length > 0,
  };
}

function projectParentContext(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts.at(-2) ?? path : path;
}
