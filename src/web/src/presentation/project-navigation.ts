import { workpadStatusLabel } from "../formatters.js";
import type { ConversationLifecycleSnapshot, Snapshot, WorkpadSummary } from "../types.js";

export interface ProjectNavigationConversationViewModel {
  readonly id: string;
  readonly title: string;
  readonly status: string;
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
    status: workpad.userStatusLabel ?? workpadStatusLabel(workpad.runtimeStatus),
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
      || conversation.status.toLocaleLowerCase().includes(normalizedSearch)
    ))
    : conversations;
  return {
    active: filtered.filter((conversation) => conversation.state !== "archive"),
    archived: filtered.filter((conversation) => conversation.state === "archive"),
    hasSearchMatch: filtered.length > 0,
  };
}
