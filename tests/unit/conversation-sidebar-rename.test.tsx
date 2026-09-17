// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyWorkbenchSnapshot } from "../../src/web/src/controllers/useProjectConversationSession.js";
import { ProjectConversationSidebar } from "../../src/web/src/shell/sidebar.js";
import type { ProjectStatus, Snapshot } from "../../src/web/src/types.js";
import type { ProjectNavigationOverlayState } from "../../src/web/src/presentation/project-navigation.js";

afterEach(cleanup);

describe("Conversation sidebar rename", () => {
  it("keeps the local project path out of the ordinary sidebar surface", () => {
    renderSidebar(vi.fn(async () => undefined));

    const projectButton = screen.getByRole("button", { name: "Repo" });
    expect(projectButton.getAttribute("title")).toBe("Repo");
    expect(document.body.innerHTML).not.toContain("C:/repo");
    expect(screen.queryByRole("img", { name: /可以开始使用/ })).toBeNull();
  });

  it("falls back to topics when an Agent snapshot has no Harness workpads", () => {
    const snapshot = sidebarSnapshot();
    snapshot.left.workpads = [];
    renderSidebar(vi.fn(async () => undefined), snapshot);

    expect(screen.getByText("Old title")).toBeTruthy();
    expect(screen.queryByText("暂无对话。")).toBeNull();
  });

  it("does not offer a new Conversation for a project locked during startup", () => {
    const unavailable: ProjectStatus = {
      ...managedProject(),
      runtimeAvailability: {
        state: "unavailable",
        summary: "这个项目的协作配置需要处理。",
        recovery: "请重新启动 Beaver Code。",
      },
    };
    renderSidebar(vi.fn(async () => undefined), sidebarSnapshot(), unavailable);

    expect(screen.queryByLabelText("在 Repo 中开始新对话")).toBeNull();
    expect(screen.queryByText("首次需求时会根据项目情况建立必要工作说明。")).toBeNull();
    fireEvent.click(screen.getByLabelText("Repo 项目菜单"));
    expect(screen.queryByRole("menuitem", { name: "新建对话" })).toBeNull();
  });

  it("saves once on Enter even when blur follows", async () => {
    const rename = vi.fn(async () => undefined);
    renderSidebar(rename);
    fireEvent.click(screen.getByLabelText("Old title 会话菜单"));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByLabelText("会话名称");
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    expect(rename).toHaveBeenCalledWith("repo-1", "conv-1", "New title");
  });

  it("keeps the draft and shows an inline error after failure", async () => {
    const rename = vi.fn(async () => { throw new Error("rename failed"); });
    renderSidebar(rename);
    fireEvent.click(screen.getByLabelText("Old title 会话菜单"));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByLabelText("会话名称");
    fireEvent.change(input, { target: { value: "Broken title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("会话操作暂时无法完成。请重试。"));
    expect((screen.getByLabelText("会话名称") as HTMLInputElement).value).toBe("Broken title");
  });

  it("does not save on blur and cancels on Escape", async () => {
    const rename = vi.fn(async () => undefined);
    renderSidebar(rename);
    fireEvent.click(screen.getByLabelText("Old title 会话菜单"));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    let input = screen.getByLabelText("会话名称");
    fireEvent.change(input, { target: { value: "Blur title" } });
    fireEvent.blur(input);
    expect(rename).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });

    fireEvent.click(screen.getByLabelText("Old title 会话菜单"));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    input = screen.getByLabelText("会话名称");
    fireEvent.change(input, { target: { value: "Cancelled title" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("会话名称")).toBeNull();
    expect(rename).not.toHaveBeenCalled();
  });
});

function renderSidebar(
  onRenameConversation: (projectId: string, conversationId: string, title: string) => Promise<void>,
  snapshot = sidebarSnapshot(),
  project = managedProject(),
): void {
  function TestSidebar() {
    const [overlay, setOverlay] = useState<ProjectNavigationOverlayState>({ kind: "closed" });
    const defaults = {
      projects: [project], selectedProjectId: "repo-1", selectedTopicId: "conv-1",
      snapshots: { "repo-1": snapshot }, snapshot, expandedProjects: new Set(["repo-1"]), overlay,
      onCloseOverlay: () => setOverlay({ kind: "closed" }),
      onOpenSearch: vi.fn(), onSetSearchQuery: vi.fn(), onSetSearchActiveIndex: vi.fn(), onPrepareSearch: vi.fn(),
      onOpenProjectCreateActions: () => setOverlay({ kind: "project-create-actions" }),
      onOpenProjectActions: (projectId: string) => setOverlay({ kind: "project-actions", projectId }),
      onOpenConversationActions: (projectId: string, conversationId: string) => setOverlay({ kind: "conversation-actions", projectId, conversationId }),
      onOpenProjectForm: (flow: "open" | "create") => setOverlay({ kind: "project-form", flow }),
      onOpenRenameConversation: (projectId: string, conversationId: string, title: string) => setOverlay({ kind: "rename-conversation", projectId, conversationId, title }),
      onNewConversation: vi.fn(), onOpenProject: vi.fn(), onToggleProject: vi.fn(), onChooseConversation: vi.fn(),
      onArchiveConversation: vi.fn(), onRestoreConversation: vi.fn(), onPrepareConversationDelete: vi.fn(), onDeleteConversation: vi.fn(),
      onRenameConversation, onRemoveProject: vi.fn(), onRefresh: vi.fn(), onOpenSettings: vi.fn(), onOpenProjectSettings: vi.fn(),
    };
    return <ProjectConversationSidebar {...defaults as never} />;
  }
  render(<TestSidebar />);
}

function sidebarSnapshot(): Snapshot {
  const project = managedProject();
  const snapshot: Snapshot = {
    ...emptyWorkbenchSnapshot,
    project: project.project!,
    memory: { harnessReady: true },
    left: {
      ...emptyWorkbenchSnapshot.left,
      topics: [{ id: "conv-1", title: "Old title", state: "active" }],
      workpads: [{
        id: "conv-1",
        title: "Old title",
        state: "active",
        runtimeStatus: "active",
        userStatusLabel: "进行中",
        selected: true,
        waitingDecisionCount: 0,
      }],
    },
  };
  return snapshot;
}

function managedProject(): ProjectStatus {
  return {
    project: { id: "repo-1", name: "Repo", path: "C:/repo" },
    path: "C:/repo",
    pathExists: true,
    isGitRepo: true,
    managed: true,
    harness: { readiness: "ready" },
  };
}
