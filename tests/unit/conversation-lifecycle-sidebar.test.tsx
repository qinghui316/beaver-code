// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectConversationSidebar } from "../../src/web/src/shell/sidebar.js";
import type { ProductMode, Snapshot, Topic } from "../../src/web/src/types.js";
import type { ProjectNavigationOverlayState } from "../../src/web/src/presentation/project-navigation.js";

afterEach(cleanup);

describe("shared Conversation lifecycle sidebar", () => {
  it("groups Agent archives and completes revision-bound permanent deletion", async () => {
    const onArchiveConversation = vi.fn(async () => undefined);
    const onRestoreConversation = vi.fn(async () => undefined);
    const onPrepareConversationDelete = vi.fn(async () => ({
      token: "delete-token",
      expiresAt: "2026-08-31T00:05:00.000Z",
      conversationId: "archived-agent",
      lifecycleRevision: "conversation-lifecycle:2",
      effect: "删除本地会话历史，项目文件保持不变。",
    }));
    const onDeleteConversation = vi.fn(async () => undefined);
    renderSidebar("agent", [
      topic("active-agent", "Active Agent", "active", "agent", {
        state: "active", archiveOrigin: null, lifecycleRevision: "conversation-lifecycle:0",
        canArchive: true, canRestore: false, canDelete: false,
      }),
      topic("archived-agent", "Archived Agent", "archive", "agent", {
        state: "archived", archiveOrigin: "agent-user", lifecycleRevision: "conversation-lifecycle:2",
        canArchive: false, canRestore: true, canDelete: true,
      }),
    ], { onArchiveConversation, onRestoreConversation, onPrepareConversationDelete, onDeleteConversation });

    fireEvent.click(screen.getByLabelText("Active Agent 会话菜单"));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    await waitFor(() => expect(onArchiveConversation).toHaveBeenCalledWith("repo", "active-agent", "conversation-lifecycle:0"));

    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    fireEvent.click(screen.getByLabelText("Archived Agent 会话菜单"));
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复" }));
    await waitFor(() => expect(onRestoreConversation).toHaveBeenCalledWith("repo", "archived-agent", "conversation-lifecycle:2"));

    fireEvent.click(screen.getByLabelText("Archived Agent 会话菜单"));
    fireEvent.click(screen.getByRole("menuitem", { name: "永久删除" }));
    expect(await screen.findByRole("dialog", { name: "永久删除“Archived Agent”？" })).toBeTruthy();
    expect(screen.getByText("删除本地会话历史，项目文件保持不变。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(onDeleteConversation).toHaveBeenCalledWith(
      "repo", "archived-agent", "conversation-lifecycle:2", "delete-token",
    ));
  });

  it("never exposes restore for a Harness workflow archive", () => {
    renderSidebar("harness", [
      topic("archived-harness", "Archived Harness", "archive", "harness", {
        state: "archived", archiveOrigin: "harness-workflow", lifecycleRevision: "conversation-lifecycle:4",
        canArchive: false, canRestore: false, canDelete: true,
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "已归档" }));
    fireEvent.click(screen.getByLabelText("Archived Harness 会话菜单"));
    expect(screen.queryByRole("menuitem", { name: "恢复" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "永久删除本地会话记录" })).toBeTruthy();
  });
});

function renderSidebar(productMode: ProductMode, topics: Topic[], overrides: Record<string, unknown> = {}) {
  const snapshot = {
    productMode,
    project: { id: "repo", name: "Repo", path: "C:/repo" },
    harness: { harnessReady: true },
    left: { topics, workpads: [], repo: {} },
    center: { selectedTopic: null, workpad: {}, agentLoop: { runs: [] }, thread: { items: [] }, conversationInteractions: { pending: [], history: [] } },
    right: { approvals: [], decisions: [], decisionInspector: {}, confirmationQueue: {} },
    roles: [], harnessGaps: [], warnings: [],
  } as unknown as Snapshot;
  const defaults = {
    projects: [{
      project: { id: "repo", name: "Repo", path: "C:/repo" },
      path: "C:/repo", pathExists: true, isGitRepo: true, managed: true,
      harness: { readiness: "ready", activeChanges: [], pendingEvolution: false, components: [] },
    }],
    selectedProjectId: "repo",
    selectedTopicId: null,
    snapshots: { repo: snapshot },
    snapshot,
    expandedProjects: new Set(["repo"]),
    onNewConversation: vi.fn(), onOpenProject: vi.fn(),
    onToggleProject: vi.fn(), onChooseConversation: vi.fn(), onArchiveConversation: vi.fn(),
    onRestoreConversation: vi.fn(),
    onPrepareConversationDelete: vi.fn(async () => ({ token: "token", expiresAt: "2026-08-31", conversationId: "", lifecycleRevision: "", effect: "" })),
    onDeleteConversation: vi.fn(), onRenameConversation: vi.fn(), onRemoveProject: vi.fn(), onRefresh: vi.fn(),
    onOpenSettings: vi.fn(), onOpenProjectSettings: vi.fn(),
    ...overrides,
  };
  function TestSidebar() {
    const [overlay, setOverlay] = useState<ProjectNavigationOverlayState>({ kind: "closed" });
    return <ProjectConversationSidebar {...defaults as never} overlay={overlay}
      onCloseOverlay={() => setOverlay({ kind: "closed" })}
      onOpenSearch={() => setOverlay({ kind: "search", query: "", activeIndex: 0 })}
      onSetSearchQuery={vi.fn()} onSetSearchActiveIndex={vi.fn()} onPrepareSearch={vi.fn()}
      onOpenProjectCreateActions={() => setOverlay({ kind: "project-create-actions" })}
      onOpenProjectActions={(projectId) => setOverlay({ kind: "project-actions", projectId })}
      onOpenConversationActions={(projectId, conversationId) => setOverlay({ kind: "conversation-actions", projectId, conversationId })}
      onOpenProjectForm={(flow) => setOverlay({ kind: "project-form", flow })}
      onOpenRenameConversation={(projectId, conversationId, title) => setOverlay({ kind: "rename-conversation", projectId, conversationId, title })}
    />;
  }
  return render(<TestSidebar />);
}

function topic(
  id: string,
  title: string,
  state: "active" | "archive",
  productMode: ProductMode,
  lifecycle: Partial<NonNullable<Topic["lifecycle"]>>,
): Topic {
  return {
    id, title, state, productMode, kind: "conversation",
    lifecycle: {
      projectId: "repo", productMode, conversationId: id, updatedAt: "2026-08-31T00:00:00.000Z",
      disabledReason: undefined,
      ...lifecycle,
    } as NonNullable<Topic["lifecycle"]>,
  };
}
