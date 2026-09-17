import { useCallback, useState } from "react";
import type { ProjectNavigationOverlayState } from "../presentation/project-navigation.js";

export interface ProjectNavigationOverlayController {
  readonly state: ProjectNavigationOverlayState;
  readonly close: () => void;
  readonly openSearch: () => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setSearchActiveIndex: (activeIndex: number) => void;
  readonly openProjectCreateActions: () => void;
  readonly openProjectActions: (projectId: string) => void;
  readonly openConversationActions: (projectId: string, conversationId: string) => void;
  readonly openProjectForm: (flow: "open" | "create") => void;
  readonly openRenameConversation: (projectId: string, conversationId: string, title: string) => void;
}

const CLOSED: ProjectNavigationOverlayState = { kind: "closed" };

export function useProjectNavigationOverlayController(): ProjectNavigationOverlayController {
  const [state, setState] = useState<ProjectNavigationOverlayState>(CLOSED);
  const close = useCallback(() => setState(CLOSED), []);
  const openSearch = useCallback(() => setState((current) => current.kind === "search" ? CLOSED : { kind: "search", query: "", activeIndex: 0 }), []);
  const setSearchQuery = useCallback((query: string) => setState((current) => current.kind === "search" ? { ...current, query, activeIndex: 0 } : current), []);
  const setSearchActiveIndex = useCallback((activeIndex: number) => setState((current) => current.kind === "search" ? { ...current, activeIndex } : current), []);
  return {
    state,
    close,
    openSearch,
    setSearchQuery,
    setSearchActiveIndex,
    openProjectCreateActions: useCallback(() => setState({ kind: "project-create-actions" }), []),
    openProjectActions: useCallback((projectId) => setState({ kind: "project-actions", projectId }), []),
    openConversationActions: useCallback((projectId, conversationId) => setState({ kind: "conversation-actions", projectId, conversationId }), []),
    openProjectForm: useCallback((flow) => setState({ kind: "project-form", flow }), []),
    openRenameConversation: useCallback((projectId, conversationId, title) => setState({ kind: "rename-conversation", projectId, conversationId, title }), []),
  };
}
