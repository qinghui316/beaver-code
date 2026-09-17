import { Folder, MessageSquare, Search } from "lucide-react";
import { useMemo, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { DialogSurface } from "../presentation/DialogSurface.js";
import { projectNavigationSearchResults, type ProjectNavigationFeatureSurface } from "../presentation/project-navigation.js";

export function ProjectConversationSearchPalette({ surface, triggerRef }: {
  surface: ProjectNavigationFeatureSurface;
  triggerRef: RefObject<HTMLButtonElement | null>;
}): ReactElement | null {
  const { view, actions } = surface;
  const search = view.overlay.kind === "search" ? view.overlay : null;
  const results = useMemo(() => search ? projectNavigationSearchResults({
    projects: view.projects,
    snapshots: view.snapshots,
    selectedProjectId: view.selectedProjectId,
    selectedConversationId: view.selectedTopicId,
    query: search.query,
  }) : [], [search, view.projects, view.selectedProjectId, view.selectedTopicId, view.snapshots]);
  if (!search) return null;
  const activeIndex = results.length ? Math.min(search.activeIndex, results.length - 1) : 0;
  const activeResultId = results.length ? `navigation-search-result-${activeIndex}` : undefined;
  const openResult = (index: number) => {
    const result = results[index];
    if (!result) return;
    actions.onCloseOverlay();
    if (result.kind === "project") void actions.onOpenProject(result.projectId);
    else void actions.onChooseConversation(result.projectId, result.conversationId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      actions.onSetSearchActiveIndex(results.length ? (activeIndex + 1) % results.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      actions.onSetSearchActiveIndex(results.length ? (activeIndex - 1 + results.length) % results.length : 0);
    } else if (event.key === "Home") {
      event.preventDefault(); actions.onSetSearchActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault(); actions.onSetSearchActiveIndex(Math.max(0, results.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault(); openResult(activeIndex);
    }
  };
  return (
    <DialogSurface open onClose={actions.onCloseOverlay} ariaLabel="搜索项目和会话" overlayClassName="navigation-search-overlay" panelClassName="navigation-search-palette" returnFocusRef={triggerRef} portal>
      <label className="navigation-search-field">
        <Search size={19} aria-hidden="true" />
        <input autoFocus role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="navigation-search-results" aria-activedescendant={activeResultId} value={search.query} onChange={(event) => actions.onSetSearchQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="搜索项目和会话" aria-label="搜索项目和会话" />
      </label>
      <div id="navigation-search-results" className="navigation-search-results" role="listbox" aria-label="搜索结果">
        {results.map((result, index) => <button
          key={result.key}
          id={`navigation-search-result-${index}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`navigation-search-result${index === activeIndex ? " active" : ""}`}
          onMouseMove={() => actions.onSetSearchActiveIndex(index)}
          onClick={() => openResult(index)}
        >
          {result.kind === "project" ? <Folder size={17} /> : <MessageSquare size={17} />}
          <span><strong>{result.title}</strong><small>{result.kind === "project" ? [result.context, result.statusLabel].filter(Boolean).join(" · ") : `${result.projectTitle} · ${result.archived ? "已归档" : result.statusLabel}`}</small></span>
        </button>)}
        {results.length === 0 ? <div className="navigation-search-empty"><p>没有匹配的项目或会话。</p><button type="button" onClick={() => actions.onSetSearchQuery("")}>清除搜索</button></div> : null}
      </div>
    </DialogSurface>
  );
}
