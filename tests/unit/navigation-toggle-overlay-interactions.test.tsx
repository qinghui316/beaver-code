// @vitest-environment jsdom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productModeToggleViewModel } from "../../src/web/src/presentation/core-workbench-experience.js";
import { projectNavigationSearchResults, type ProjectNavigationActions, type ProjectNavigationFeatureSurface, type ProjectNavigationOverlayState, type ProjectNavigationViewModel } from "../../src/web/src/presentation/project-navigation.js";
import { ProductModeToggle } from "../../src/web/src/shell/ProductModeToggle.js";
import { WorkspaceNavigationHeader } from "../../src/web/src/shell/WorkspaceNavigationHeader.js";
import type { ProjectStatus, Snapshot } from "../../src/web/src/types.js";

afterEach(cleanup);

describe("navigation toggle and overlay interactions", () => {
  it("projects one direct mode toggle whose label describes the next action", () => {
    const onToggle = vi.fn();
    const view = productModeToggleViewModel("agent", { harness: "attention" });
    const rendered = render(<ProductModeToggle view={view} onToggle={onToggle} />);

    const toggle = screen.getByRole("switch", { name: "切换到 AHO，需要你处理" });
    expect(toggle.getAttribute("data-mode")).toBe("agent");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.querySelector(".product-mode-toggle-label.agent")?.textContent).toBe("Agent 模式");
    expect(toggle.querySelector(".product-mode-toggle-label.harness")?.textContent).toBe("AHO 模式");
    expect(toggle.querySelector(".product-mode-toggle-thumb")).toBeTruthy();
    expect(toggle.querySelector(".product-mode-toggle-activity.attention")).toBeTruthy();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rendered.rerender(<ProductModeToggle view={productModeToggleViewModel("harness", { agent: "running" })} onToggle={onToggle} />);
    const harnessToggle = screen.getByRole("switch", { name: "切换到 Agent，正在执行" });
    expect(harnessToggle.getAttribute("data-mode")).toBe("harness");
    expect(harnessToggle.getAttribute("aria-checked")).toBe("true");
    expect(harnessToggle.querySelector(".product-mode-toggle-activity.running")).toBeTruthy();
  });

  it("keeps the selected project first and searches active and archived conversations", () => {
    const first = project("first", "相同项目", "C:/work/first");
    const selected = project("selected", "相同项目", "D:/work/selected");
    const results = projectNavigationSearchResults({
      projects: [first, selected],
      snapshots: {
        selected: snapshot("selected", [
          { id: "active", title: "当前会话", state: "active" },
          { id: "archive", title: "历史会话", state: "archive" },
        ]),
      },
      selectedProjectId: "selected",
      selectedConversationId: "active",
      query: "",
    });

    expect(results[0]).toMatchObject({ kind: "project", projectId: "selected", context: "work" });
    expect(results.filter((item) => item.kind === "conversation")).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: "active", archived: false }),
      expect.objectContaining({ conversationId: "archive", archived: true }),
    ]));
    expect(projectNavigationSearchResults({
      projects: [selected], snapshots: { selected: snapshot("selected", [{ id: "archive", title: "历史会话", state: "archive" }]) },
      selectedProjectId: "selected", selectedConversationId: null, query: "已归档",
    })).toEqual([expect.objectContaining({ kind: "conversation", conversationId: "archive" })]);
  });

  it("opens with Ctrl+K, supports keyboard selection, and restores focus after Escape", async () => {
    const onChooseConversation = vi.fn(async () => undefined);
    const onPrepareSearch = vi.fn(async () => undefined);
    render(<NavigationHarness onChooseConversation={onChooseConversation} onPrepareSearch={onPrepareSearch} />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "搜索项目和会话" });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("button", { name: /关闭/ })).toBeNull();
    expect(onPrepareSearch).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("navigation-search-result-1");
    expect(document.getElementById("navigation-search-result-1")?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onChooseConversation).toHaveBeenCalledWith("repo", "conversation"));

    const trigger = screen.getByRole("button", { name: "搜索项目和会话" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("combobox", { name: "搜索项目和会话" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "搜索项目和会话" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

function NavigationHarness({ onChooseConversation, onPrepareSearch }: { onChooseConversation: (projectId: string, conversationId: string) => Promise<void>; onPrepareSearch: () => Promise<void> }) {
  const [overlay, setOverlay] = useState<ProjectNavigationOverlayState>({ kind: "closed" });
  const sidebarRef = useRef<HTMLButtonElement | null>(null);
  const view: ProjectNavigationViewModel = {
    projects: [project("repo", "Repo", "C:/work/repo")],
    selectedProjectId: "repo",
    selectedTopicId: "conversation",
    snapshots: { repo: snapshot("repo", [{ id: "conversation", title: "当前会话", state: "active" }]) },
    snapshot: snapshot("repo", [{ id: "conversation", title: "当前会话", state: "active" }]),
    expandedProjects: new Set(["repo"]),
    overlay,
  };
  const actions = {
    onCloseOverlay: () => setOverlay({ kind: "closed" }),
    onOpenSearch: () => setOverlay((current) => current.kind === "search" ? { kind: "closed" } : { kind: "search", query: "", activeIndex: 0 }),
    onSetSearchQuery: (query: string) => setOverlay((current) => current.kind === "search" ? { ...current, query, activeIndex: 0 } : current),
    onSetSearchActiveIndex: (activeIndex: number) => setOverlay((current) => current.kind === "search" ? { ...current, activeIndex } : current),
    onPrepareSearch,
    onChooseConversation,
    onOpenProject: vi.fn(async () => undefined),
  } as unknown as ProjectNavigationActions;
  const surface: ProjectNavigationFeatureSurface = { view, actions };
  return <WorkspaceNavigationHeader
    mode={productModeToggleViewModel("agent", {})}
    onToggleMode={() => undefined}
    navigation={surface}
    mobileSidebarOpen={false}
    onToggleMobileSidebar={() => undefined}
    mobileSidebarToggleRef={sidebarRef}
  />;
}

function project(id: string, name: string, path: string): ProjectStatus {
  return {
    project: { id, name, path }, path, pathExists: true, isGitRepo: true, managed: true,
    harness: { readiness: "ready" }, runtimeAvailability: { state: "ready", summary: null, recovery: null },
  } as unknown as ProjectStatus;
}

function snapshot(projectId: string, topics: Array<{ id: string; title: string; state: "active" | "archive" }>): Snapshot {
  return {
    project: { id: projectId, name: projectId, path: `C:/work/${projectId}` },
    harness: { harnessReady: true },
    left: { topics, workpads: [], repo: {} },
    center: { selectedTopic: null, workpad: {}, agentLoop: { runs: [] }, thread: { items: [] }, conversationInteractions: { pending: [], history: [] } },
    right: { approvals: [], decisions: [], decisionInspector: {}, confirmationQueue: {} },
    roles: [], harnessGaps: [], warnings: [],
  } as unknown as Snapshot;
}
