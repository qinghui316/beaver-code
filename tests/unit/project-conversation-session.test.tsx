// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkbenchSnapshot,
  removalConfirmationMessage,
  snapshotMatchesSelection,
  useProjectConversationSession,
  type ProjectConversationSessionPorts,
  type WorkbenchRestoreParams,
} from "../../src/web/src/controllers/useProjectConversationSession.js";
import type { ProductMode, ProjectStatus, Snapshot, StreamPacket, WorkbenchLiveEvent } from "../../src/web/src/types.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Project conversation session owner", () => {
  it("initializes an Agent empty Snapshot before auto-load runs", () => {
    const fixture = ownerFixture();
    const { result } = renderHook(() => useProjectConversationSession({
      ...fixture.ports,
      productMode: "agent",
      autoLoad: false,
    }));

    expect(result.current.productMode).toBe("agent");
    expect(result.current.snapshot.productMode).toBe("agent");
    expect(result.current.snapshot.center.conversationInteractions.productMode).toBe("agent");
  });

  it("keeps the default initial empty Snapshot in Harness mode", () => {
    const fixture = ownerFixture();
    const { result } = renderHook(() => useProjectConversationSession({
      ...fixture.ports,
      autoLoad: false,
    }));

    expect(result.current.productMode).toBe("harness");
    expect(result.current.snapshot.productMode).toBe("harness");
    expect(result.current.snapshot.center.conversationInteractions.productMode).toBe("harness");
  });

  it("keeps an Agent empty Snapshot when app restore finds no project", async () => {
    const fixture = ownerFixture();
    fixture.api.loadProjects.mockResolvedValue([]);
    fixture.api.loadAppStatus.mockResolvedValue({ mode: "app", directProjectId: null });
    const { result } = renderHook(() => useProjectConversationSession({
      ...fixture.ports,
      productMode: "agent",
      autoLoad: false,
    }));

    await act(async () => { await result.current.loadApp(); });

    expect(result.current.selectedProjectId).toBeNull();
    expect(result.current.selectedTopic).toBeNull();
    expect(result.current.snapshot.productMode).toBe("agent");
    expect(result.current.snapshot.center.conversationInteractions.productMode).toBe("agent");
  });

  it("restores the selected managed project, conversation, snapshot, run, and stream", async () => {
    const fixture = ownerFixture({ restore: { projectId: "repo-1", topicId: "conv-1", orchestrationOpen: true, settingsOpen: false } });
    fixture.api.loadSnapshot.mockResolvedValue(snapshot("repo-1", "conv-1", "run-1"));
    fixture.api.loadStream.mockResolvedValue(stream("run-1"));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));

    await act(async () => { await result.current.loadApp(); });

    expect(result.current.selectedProjectId).toBe("repo-1");
    expect(result.current.selectedTopic).toBe("conv-1");
    expect(result.current.snapshot.center.selectedTopic?.id).toBe("conv-1");
    expect(result.current.selectedRun).toBe("run-1");
    expect(result.current.stream?.run.id).toBe("run-1");
    expect(result.current.expandedProjects).toEqual(new Set(["repo-1"]));
    expect(fixture.navigation.persistProjectId).toHaveBeenCalledWith("repo-1");
    expect(fixture.ui.restoreView).toHaveBeenCalledWith({ orchestrationOpen: true, settingsOpen: false });
    expect(fixture.api.loadProjects).toHaveBeenCalledTimes(1);
  });

  it("fences old project and conversation snapshots before rendering", () => {
    const old = snapshot("repo-1", "old", undefined, "agent");
    expect(snapshotMatchesSelection(old, "repo-1", "agent", "old")).toBe(true);
    expect(snapshotMatchesSelection(old, "repo-1", "agent", "new")).toBe(false);
    expect(snapshotMatchesSelection(old, "repo-2", "agent", "old")).toBe(false);
    expect(snapshotMatchesSelection(old, "repo-1", "harness", "old")).toBe(false);
  });

  it("keeps a slow sidebar navigation response across a conversation switch", async () => {
    let resolveNavigation!: (value: { productMode: ProductMode; conversations: Array<{ id: string; title: string; state: string; userStatusLabel: string; waitingDecisionCount: number }> }) => void;
    const pendingNavigation = new Promise<Parameters<typeof resolveNavigation>[0]>((resolve) => { resolveNavigation = resolve; });
    const fixture = ownerFixture();
    fixture.api.loadNavigation.mockImplementation((projectId: string, mode: ProductMode) => projectId === "repo-2"
      ? pendingNavigation : Promise.resolve({ productMode: mode, conversations: [] }));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    let folder!: Promise<void>;
    act(() => { folder = result.current.toggleProjectFolder("repo-2"); });
    await act(async () => { await result.current.chooseConversation("repo-1", "new"); });
    await act(async () => { resolveNavigation({ productMode: "harness", conversations: [
      { id: "repo-2-conversation", title: "Repo 2", state: "active", userStatusLabel: "处理中", waitingDecisionCount: 0 },
    ] }); await folder; });
    expect(result.current.projectNavigation["repo-2"]?.[0]?.title).toBe("Repo 2");
    expect(result.current.selectedTopic).toBe("new");
    expect(fixture.api.loadSnapshot).not.toHaveBeenCalledWith("repo-2", "harness", null);
  });

  it("surfaces a navigation failure and clears it after a retry", async () => {
    const fixture = ownerFixture();
    fixture.api.loadNavigation.mockImplementation(async (projectId: string, mode: ProductMode) => {
      if (projectId === "repo-2" && fixture.api.loadNavigation.mock.calls.filter(([id]) => id === "repo-2").length === 1) {
        throw new Error("navigation unavailable");
      }
      return { productMode: mode, conversations: [] };
    });
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    await act(async () => { await result.current.toggleProjectFolder("repo-2"); });
    expect(result.current.projectNavigationErrors["repo-2"]).toBeTruthy();
    await act(async () => { await result.current.retryNavigation("repo-2"); });
    expect(result.current.projectNavigationErrors["repo-2"]).toBeUndefined();
    expect(result.current.projectNavigation["repo-2"]).toEqual([]);
  });

  it("coalesces repeated invalidations and ignores an older navigation failure", async () => {
    let rejectOld!: (reason: Error) => void;
    let resolveLatest!: (value: { productMode: ProductMode; conversations: Array<{ id: string; title: string; state: string; userStatusLabel: string; waitingDecisionCount: number }> }) => void;
    const old = new Promise<Parameters<typeof resolveLatest>[0]>((_resolve, reject) => { rejectOld = reject; });
    const latest = new Promise<Parameters<typeof resolveLatest>[0]>((resolve) => { resolveLatest = resolve; });
    const fixture = ownerFixture();
    let targetReads = 0;
    fixture.api.loadNavigation.mockImplementation(async (projectId: string, mode: ProductMode) => {
      if (projectId !== "repo-2") return { productMode: mode, conversations: [] };
      targetReads += 1;
      return targetReads === 1 ? old : latest;
    });
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    let folder!: Promise<void>;
    act(() => {
      folder = result.current.toggleProjectFolder("repo-2");
      result.current.invalidateNavigation("repo-2", "harness");
      result.current.invalidateNavigation("repo-2", "harness");
      result.current.invalidateNavigation("repo-2", "harness");
    });
    expect(targetReads).toBe(1);
    await act(async () => { rejectOld(new Error("old navigation failed")); await folder; });
    await waitFor(() => expect(targetReads).toBe(2));
    await act(async () => { resolveLatest({ productMode: "harness", conversations: [
      { id: "fresh", title: "Fresh", state: "active", userStatusLabel: "处理中", waitingDecisionCount: 0 },
    ] }); });
    expect(result.current.projectNavigation["repo-2"]?.[0]?.title).toBe("Fresh");
    expect(result.current.projectNavigationErrors["repo-2"]).toBeUndefined();
    expect(fixture.ports.onError).not.toHaveBeenCalled();
  });

  it("preserves the project while switching modes and keeps mode caches isolated", async () => {
    const fixture = ownerFixture();
    fixture.api.loadSnapshot.mockImplementation(async (projectId: string, productMode: ProductMode) => (
      snapshot(projectId, productMode === "agent" ? "agent-conversation" : "harness-conversation", undefined, productMode)
    ));
    const { result, rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProjectConversationSession({
        ...fixture.ports,
        productMode,
        autoLoad: false,
      }),
      { initialProps: { productMode: "harness" as ProductMode } },
    );
    await act(async () => { await result.current.loadApp(); });
    expect(result.current.selectedTopic).toBe("harness-conversation");

    rerender({ productMode: "agent" });
    await waitFor(() => expect(result.current.productMode).toBe("agent"));
    await waitFor(() => expect(result.current.selectedTopic).toBe("agent-conversation"));

    expect(result.current.selectedProjectId).toBe("repo-1");
    expect(result.current.snapshot.productMode).toBe("agent");
    expect(result.current.projectSnapshots["repo-1"]?.productMode).toBe("agent");
    expect(fixture.api.loadSnapshot).toHaveBeenCalledWith("repo-1", "agent", null);
    expect(fixture.resources.cleanupTransition).toHaveBeenCalledWith("conversation-changed");
    expect(fixture.ui.transition).toHaveBeenCalledWith(expect.objectContaining({
      fromProductMode: "harness",
      toProductMode: "agent",
      toProjectId: "repo-1",
      toConversationId: null,
    }));

    rerender({ productMode: "harness" });
    await waitFor(() => expect(result.current.productMode).toBe("harness"));
    await waitFor(() => expect(result.current.projectSnapshots["repo-1"]?.productMode).toBe("harness"));
  });

  it("loads target-mode navigation for an expanded project without waiting for its response", async () => {
    let resolveAgentNavigation!: (value: { productMode: ProductMode; conversations: Array<{ id: string; title: string; state: "active"; userStatusLabel: string; waitingDecisionCount: number }> }) => void;
    const agentNavigation = new Promise<Parameters<typeof resolveAgentNavigation>[0]>((resolve) => { resolveAgentNavigation = resolve; });
    const fixture = ownerFixture();
    fixture.api.loadNavigation.mockImplementation((projectId: string, mode: ProductMode) => (
      projectId === "repo-2" && mode === "agent"
        ? agentNavigation
        : Promise.resolve({ productMode: mode, conversations: projectId === "repo-2" ? [
          { id: "harness-conversation", title: "Harness conversation", state: "active" as const, userStatusLabel: "处理中", waitingDecisionCount: 0 },
        ] : [] })
    ));
    const { result, rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProjectConversationSession({
        ...fixture.ports,
        productMode,
        autoLoad: false,
      }),
      { initialProps: { productMode: "harness" as ProductMode } },
    );
    await act(async () => { await result.current.loadApp(); });
    await act(async () => { await result.current.toggleProjectFolder("repo-2"); });
    expect(result.current.projectNavigation["repo-2"]?.[0]?.title).toBe("Harness conversation");

    rerender({ productMode: "agent" });
    await waitFor(() => expect(fixture.api.loadNavigation).toHaveBeenCalledWith("repo-2", "agent"));
    await waitFor(() => expect(result.current.productMode).toBe("agent"));
    expect(result.current.expandedProjects.has("repo-2")).toBe(true);
    expect(result.current.projectNavigation["repo-2"]).toBeUndefined();

    await act(async () => { resolveAgentNavigation({ productMode: "agent", conversations: [
      { id: "agent-conversation", title: "Agent conversation", state: "active", userStatusLabel: "稍后处理", waitingDecisionCount: 0 },
    ] }); await agentNavigation; });
    expect(result.current.projectNavigation["repo-2"]?.[0]?.title).toBe("Agent conversation");
  });

  it("drops an old-mode Snapshot after a newer mode selection wins", async () => {
    let resolveHarness!: (value: Snapshot) => void;
    const harnessResponse = new Promise<Snapshot>((resolve) => { resolveHarness = resolve; });
    const fixture = ownerFixture();
    fixture.api.loadSnapshot.mockImplementation((_projectId: string, productMode: ProductMode) => (
      productMode === "harness" ? harnessResponse : Promise.resolve(snapshot("repo-1", "agent-conversation", undefined, "agent"))
    ));
    const { result, rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProjectConversationSession({
        ...fixture.ports,
        productMode,
        autoLoad: false,
      }),
      { initialProps: { productMode: "harness" as ProductMode } },
    );

    let harnessLoad!: Promise<void>;
    act(() => { harnessLoad = result.current.loadApp(); });
    await waitFor(() => expect(fixture.api.loadSnapshot).toHaveBeenCalledWith("repo-1", "harness", null));
    rerender({ productMode: "agent" });
    await waitFor(() => expect(result.current.snapshot.productMode).toBe("agent"));
    await act(async () => { resolveHarness(snapshot("repo-1", "stale-harness", undefined, "harness")); await harnessLoad; });

    expect(result.current.productMode).toBe("agent");
    expect(result.current.selectedTopic).toBe("agent-conversation");
    expect(result.current.snapshot.productMode).toBe("agent");
  });

  it("keeps the selected mode when a deep link belongs to the other mode", async () => {
    const fixture = ownerFixture({ restore: { projectId: "repo-1", topicId: "harness-link", orchestrationOpen: false, settingsOpen: false } });
    fixture.api.loadSnapshot.mockImplementation(async (projectId: string, productMode: ProductMode, conversationId: string | null) => {
      if (conversationId === "harness-link") {
        const error = new Error("Conversation belongs to harness mode.");
        error.name = "Conflict";
        throw error;
      }
      return snapshot(projectId, "agent-latest", undefined, productMode);
    });
    const { result } = renderHook(() => useProjectConversationSession({
      ...fixture.ports,
      productMode: "agent",
      autoLoad: false,
    }));

    await act(async () => { await result.current.loadApp(); });

    expect(result.current.productMode).toBe("agent");
    expect(result.current.selectedTopic).toBe("agent-latest");
    expect(fixture.api.loadSnapshot).toHaveBeenNthCalledWith(1, "repo-1", "agent", "harness-link");
    expect(fixture.api.loadSnapshot).toHaveBeenNthCalledWith(2, "repo-1", "agent", null);
    expect(fixture.navigation.syncLocation).toHaveBeenLastCalledWith("repo-1", "agent-latest");
  });

  it("opens an exact same-mode deep link even when it is absent from the mode summary", async () => {
    const fixture = ownerFixture({ restore: { projectId: "repo-1", topicId: "agent-link", orchestrationOpen: false, settingsOpen: false } });
    fixture.api.loadSnapshot.mockImplementation(async (projectId: string, productMode: ProductMode, conversationId: string | null) => (
      snapshot(projectId, conversationId ?? "agent-latest", undefined, productMode)
    ));
    const { result } = renderHook(() => useProjectConversationSession({
      ...fixture.ports,
      productMode: "agent",
      autoLoad: false,
    }));

    await act(async () => { await result.current.loadApp(); });

    expect(result.current.selectedTopic).toBe("agent-link");
    expect(fixture.api.loadSnapshot).toHaveBeenCalledOnce();
    expect(fixture.api.loadSnapshot).toHaveBeenCalledWith("repo-1", "agent", "agent-link");
  });

  it("rejects a stale conversation response after a newer selection wins", async () => {
    let resolveOld!: (value: Snapshot) => void;
    const oldSnapshot = new Promise<Snapshot>((resolve) => { resolveOld = resolve; });
    const fixture = ownerFixture();
    fixture.api.loadSnapshot.mockImplementation((_projectId: string, _productMode: ProductMode, conversationId: string | null) => (
      conversationId === "conv-old" ? oldSnapshot : Promise.resolve(snapshot("repo-1", "conv-new"))
    ));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    let oldRequest!: Promise<void>;
    act(() => { oldRequest = result.current.chooseConversation("repo-1", "conv-old"); });
    await act(async () => { await result.current.chooseConversation("repo-1", "conv-new"); });
    await act(async () => { resolveOld(snapshot("repo-1", "conv-old")); await oldRequest; });

    expect(result.current.selectedTopic).toBe("conv-new");
    expect(result.current.snapshot.center.selectedTopic?.id).toBe("conv-new");
  });

  it("keeps the target selected and reports an incorrect response instead of showing another conversation", async () => {
    const fixture = ownerFixture();
    fixture.api.loadSnapshot.mockImplementation(async (projectId: string, mode: ProductMode, conversationId: string | null) => (
      snapshot(projectId, conversationId === "target" ? "other" : conversationId, undefined, mode)
    ));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    await act(async () => { await result.current.chooseConversation("repo-1", "target"); });
    expect(result.current.selectedTopic).toBe("target");
    expect(result.current.snapshotError).toBeTruthy();
    expect(snapshotMatchesSelection(result.current.snapshot, "repo-1", "harness", "target")).toBe(false);
    expect(fixture.api.loadSnapshot).toHaveBeenLastCalledWith("repo-1", "harness", "target");
  });

  it("notifies explicit cleanup owners while preserving Composer text on project and conversation switches", async () => {
    const fixture = ownerFixture();
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => { await result.current.chooseConversation("repo-1", "conv-2"); });
    await act(async () => { await result.current.openProject("repo-2"); });

    expect(fixture.resources.cleanupTransition).toHaveBeenNthCalledWith(1, "conversation-changed");
    expect(fixture.resources.cleanupTransition).toHaveBeenNthCalledWith(2, "project-changed");
    expect(fixture.operations.invalidate).toHaveBeenCalledTimes(2);
    expect(fixture.timeline.invalidateProjection).toHaveBeenCalledTimes(3);
    expect(fixture.ui.transition.mock.calls.map(([event]) => ({ kind: event.kind, reset: event.resetComposerText }))).toEqual([
      { kind: "conversation-changed", reset: false },
      { kind: "project-changed", reset: false },
    ]);
  });

  it("makes new Conversation the only transition that requests Composer text reset", async () => {
    const fixture = ownerFixture();
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => { await result.current.beginNewConversation("repo-1"); });

    expect(fixture.resources.cleanupTransition).toHaveBeenCalledWith("new-conversation");
    expect(fixture.ui.transition).toHaveBeenCalledWith(expect.objectContaining({
      kind: "new-conversation",
      resetComposerText: true,
      toProjectId: "repo-1",
      toConversationId: null,
    }));
    expect(result.current.selectedTopic).toBeNull();
    expect(result.current.snapshot.center.selectedTopic).toBeNull();
    expect(result.current.snapshot.center.agentLoop.runs).toEqual([]);
  });

  it("loads cold project navigation without loading full snapshots for search", async () => {
    const fixture = ownerFixture();
    fixture.api.loadSnapshot.mockImplementation(async (projectId: string, productMode: ProductMode) => (
      snapshot(projectId, `${projectId}-conversation`, undefined, productMode)
    ));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    expect(result.current.projectSnapshots["repo-2"]).toBeUndefined();
    await act(async () => { await result.current.prepareProjectNavigationSearch(); });

    expect(fixture.api.loadNavigation).toHaveBeenCalledWith("repo-2", "harness");
    expect(fixture.api.loadSnapshot).not.toHaveBeenCalledWith("repo-2", "harness", null);
    expect(result.current.projectNavigation["repo-2"]?.[0]?.title).toBe("repo-2-conversation");
  });

  it("rekeys provisional demand metadata without creating or merging canonical transcript", async () => {
    const fixture = ownerFixture();
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    let pendingId = "";
    act(() => {
      pendingId = result.current.beginPendingDemand({
        projectId: "repo-1",
        clientRequestId: "pending-request",
        title: "需求",
        body: "实现功能",
        selectedProviderId: "codex",
        id: "pending:test",
        startedAt: "2026-07-17T00:00:00.000Z",
      }).id;
    });
    expect(pendingId).toBe("pending:test");
    expect(result.current.selectedTopic).toBe("pending:test");
    expect(fixture.navigation.syncLocation).toHaveBeenLastCalledWith("repo-1", "pending:test");

    act(() => result.current.acceptCanonicalConversation({
      projectId: "repo-1",
      productMode: "harness",
      clientRequestId: "foreign-request",
      conversationId: "conv-foreign",
      title: "错误需求",
    }));
    act(() => result.current.acceptCanonicalConversation({
      projectId: "repo-1",
      conversationId: "conv-missing-identity",
      title: "缺少身份",
    }));

    expect(result.current.selectedTopic).toBe("pending:test");

    act(() => result.current.acceptCanonicalConversation({
      projectId: "repo-1",
      productMode: "harness",
      clientRequestId: "pending-request",
      conversationId: "conv-canonical",
      title: "正式需求",
      selectedProviderId: "codex",
    }));

    expect(result.current.selectedTopic).toBe("conv-canonical");
    expect(result.current.pendingDemandConversation).toMatchObject({
      id: "conv-canonical",
      canonical: true,
      body: "实现功能",
    });
    expect(fixture.timeline.clearConversation).not.toHaveBeenCalled();
    expect(fixture.timeline.clearProject).not.toHaveBeenCalled();
  });

  it("owns pending-to-canonical creation and routes provider events without a second transcript", async () => {
    const fixture = ownerFixture();
    const routed: WorkbenchLiveEvent[] = [];
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => {
      await result.current.createDemandConversation({
        projectId: "repo-1",
        productMode: "harness",
        clientRequestId: "create-request-1",
        body: "Implement it",
        contextRefs: [],
        attachmentIds: [],
        providerId: "codex",
        skillOverrides: [],
        showPendingBeforeCreate: true,
      }, (_projectId, event) => routed.push(event));
    });

    expect(fixture.api.createDemandConversation).toHaveBeenCalledTimes(1);
    expect(fixture.ui.restoreView).toHaveBeenLastCalledWith({ orchestrationOpen: false, settingsOpen: false });
    expect(result.current.selectedTopic).toBe("conv-created");
    expect(result.current.pendingDemandConversation).toBeNull();
    expect(routed.map((event) => event.event)).toEqual(["topic.created"]);
  });

  it("binds topic.created only to the exact create request identity", async () => {
    const fixture = ownerFixture();
    const routed: WorkbenchLiveEvent[] = [];
    fixture.api.loadSnapshot.mockImplementation(async (projectId: string, productMode: ProductMode, conversationId: string | null) => {
      const next = snapshot(projectId, conversationId, undefined, productMode);
      if (!conversationId) {
        next.left.topics = [{
          id: "conv-correct",
          productMode,
          title: "Correct",
          state: "active",
          selectedProviderId: "codex",
          demandId: "conv-correct",
          graphScopeId: "scope-1",
        }];
      }
      return next;
    });
    let finishStream!: () => void;
    const streamPending = new Promise<void>((resolve) => { finishStream = resolve; });
    fixture.api.createDemandConversation.mockImplementation(async (_input, onEvent) => {
      const emitCreated = (data: Record<string, unknown>) => onEvent({
        event: "topic.created",
        data: {
          projectId: "repo-1",
          productMode: "agent",
          conversationId: "conv-correct",
          clientRequestId: "request-correct",
          replayed: false,
          topic: { id: "conv-correct", conversationId: "conv-correct", title: "Correct", state: "active", productMode: "agent" },
          ...data,
        },
      } as WorkbenchLiveEvent);
      emitCreated({ clientRequestId: "foreign-request", conversationId: "conv-foreign", topic: { id: "conv-foreign", title: "Foreign", productMode: "agent" } });
      onEvent({
        event: "snapshot",
        data: snapshot("repo-1", "conv-foreign", undefined, "agent"),
      });
      emitCreated({ clientRequestId: undefined, conversationId: "conv-missing", topic: { id: "conv-missing", title: "Missing", productMode: "agent" } });
      onEvent({
        event: "run.status",
        data: { projectId: "repo-1", productMode: "agent", conversationId: "conv-missing", status: "running" },
      });
      emitCreated({ productMode: "harness", conversationId: "conv-wrong-mode", topic: { id: "conv-wrong-mode", title: "Wrong mode", productMode: "harness" } });
      emitCreated({});
      emitCreated({
        conversationId: "conv-conflict",
        topic: { id: "conv-conflict", conversationId: "conv-conflict", title: "Conflict", state: "active", productMode: "agent" },
      });
      onEvent({
        event: "run.status",
        data: { projectId: "repo-1", productMode: "agent", conversationId: "conv-conflict", status: "running" },
      });
      onEvent({
        event: "run.status",
        data: { projectId: "repo-1", productMode: "agent", conversationId: "conv-correct", status: "running" },
      });
      onEvent({
        event: "conversation.turn-control.invalidated",
        data: { conversationId: "conv-correct", attemptId: "attempt-correct" },
      });
      await streamPending;
    });
    const { result } = renderHook(() => useProjectConversationSession({
      ...fixture.ports,
      productMode: "agent",
      autoLoad: false,
    }));
    await act(async () => { await result.current.loadApp(); });

    let creation!: Promise<{ projectId: string; conversationId: string }>;
    act(() => {
      creation = result.current.createDemandConversation({
        projectId: "repo-1",
        productMode: "agent",
        clientRequestId: "request-correct",
        body: "Exact request",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: [],
        showPendingBeforeCreate: true,
      }, (_projectId, event) => {
        routed.push(event);
        if (event.event === "topic.created") {
          result.current.acceptCanonicalConversation({
            projectId: event.data.projectId,
            productMode: event.data.productMode,
            clientRequestId: event.data.clientRequestId,
            conversationId: event.data.conversationId,
            title: event.data.topic.title,
            selectedProviderId: event.data.topic.selectedProviderId,
          });
        }
      });
    });

    await waitFor(() => expect(result.current.selectedTopic).toBe("conv-correct"));
    expect(routed.map((event) => event.event)).toEqual(["topic.created", "run.status", "conversation.turn-control.invalidated"]);
    expect(routed[0]?.data.clientRequestId).toBe("request-correct");
    expect(routed.every((event) => event.data.conversationId === "conv-correct")).toBe(true);
    await waitFor(() => expect(fixture.api.loadSnapshot).toHaveBeenCalledWith("repo-1", "agent", "conv-correct"));
    await waitFor(() => expect(result.current.pendingDemandConversation).toBeNull());
    expect(fixture.navigation.syncLocation.mock.calls.filter(([, conversationId]) => conversationId === "conv-correct")).toHaveLength(1);

    act(() => result.current.acceptCanonicalConversation({
      projectId: "repo-1",
      productMode: "agent",
      clientRequestId: "request-correct",
      conversationId: "conv-same-request-wrong-conversation",
      title: "Wrong Conversation",
    }));
    expect(result.current.selectedTopic).toBe("conv-correct");
    expect(result.current.pendingDemandConversation).toBeNull();
    expect(fixture.navigation.syncLocation.mock.calls.some(([, conversationId]) => (
      conversationId === "conv-conflict" || conversationId === "conv-same-request-wrong-conversation"
    ))).toBe(false);

    await act(async () => {
      finishStream();
      await expect(creation).resolves.toEqual({
        projectId: "repo-1",
        conversationId: "conv-correct",
      });
    });

    expect(result.current.selectedTopic).toBe("conv-correct");
    expect(result.current.pendingDemandConversation).toBeNull();
  });

  it("binds the first valid created identity without a provisional pending Conversation", async () => {
    const fixture = ownerFixture();
    const routed: WorkbenchLiveEvent[] = [];
    const { result } = renderHook(() => useProjectConversationSession({
      ...fixture.ports,
      productMode: "harness",
      autoLoad: false,
    }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => {
      await expect(result.current.createDemandConversation({
        projectId: "repo-1",
        productMode: "harness",
        clientRequestId: "without-pending",
        body: "Create without provisional UI",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: [],
        showPendingBeforeCreate: false,
      }, (_projectId, event) => routed.push(event))).resolves.toEqual({
        projectId: "repo-1",
        conversationId: "conv-created",
      });
    });

    expect(routed.map((event) => event.event)).toEqual(["topic.created"]);
    expect(result.current.selectedTopic).toBe("conv-created");
    expect(result.current.pendingDemandConversation).toBeNull();
  });

  it("reconciles title updates across the selected snapshot and project cache", async () => {
    const fixture = ownerFixture();
    const initial = snapshot("repo-1", "conv-1");
    initial.left.topics = [{ id: "conv-1", title: "Old title", state: "active" }];
    initial.left.workpads = [{
      id: "conv-1",
      title: "Old title",
      state: "active",
      runtimeStatus: "active",
      selected: true,
      waitingDecisionCount: 0,
    }];
    fixture.api.loadSnapshot.mockResolvedValue(initial);
    fixture.api.updateConversationTitle.mockResolvedValue({
      conversation: {
        id: "conv-1",
        productMode: "harness",
        title: "New title",
        state: "active",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    });
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => { await result.current.updateConversationTitle("repo-1", "conv-1", " New title "); });

    expect(fixture.api.updateConversationTitle).toHaveBeenCalledWith("repo-1", "conv-1", " New title ");
    expect(result.current.snapshot.left.topics[0]?.title).toBe("New title");
    expect(result.current.snapshot.left.workpads?.[0]?.title).toBe("New title");
    expect(result.current.snapshot.center.selectedTopic?.title).toBe("New title");
    expect(result.current.projectSnapshots["repo-1"]?.left.topics[0]?.title).toBe("New title");

    act(() => result.current.reconcileConversationTitle("repo-1", {
      id: "conv-1",
      productMode: "harness",
      title: "Newest title",
      state: "active",
      updatedAt: "2026-07-28T00:00:02.000Z",
    }));
    act(() => result.current.reconcileConversationTitle("repo-1", {
      id: "conv-1",
      productMode: "harness",
      title: "Stale title",
      state: "active",
      updatedAt: "2026-07-28T00:00:01.000Z",
    }));
    act(() => result.current.reconcileConversationTitle("repo-1", {
      id: "conv-1",
      productMode: "harness",
      title: "Same-version rollback",
      state: "active",
      updatedAt: "2026-07-28T00:00:02.000Z",
    }));

    expect(result.current.snapshot.left.topics[0]?.title).toBe("Newest title");
    expect(result.current.snapshot.left.workpads?.[0]?.title).toBe("Newest title");
    expect(result.current.snapshot.center.selectedTopic?.title).toBe("Newest title");
    expect(result.current.projectSnapshots["repo-1"]?.left.topics[0]?.title).toBe("Newest title");

    act(() => result.current.reconcileConversationTitle("repo-1", {
      id: "conv-1",
      productMode: "agent",
      title: "Wrong mode title",
      state: "active",
      updatedAt: "2026-07-28T00:00:03.000Z",
    }));

    expect(result.current.snapshot.left.topics[0]?.title).toBe("Newest title");
    expect(result.current.projectSnapshots["repo-1"]?.left.topics[0]?.title).toBe("Newest title");
  });

  it("lets a captured creation finish without pulling the user back after a project switch", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const fixture = ownerFixture();
    fixture.api.createDemandConversation.mockImplementation(async (_input, onEvent) => {
      await pending;
      onEvent({
        event: "topic.created",
        data: {
          projectId: "repo-1",
          productMode: "harness",
          conversationId: "conv-stale",
          clientRequestId: "stale-create-request",
          replayed: false,
          topic: { id: "conv-stale", conversationId: "conv-stale", title: "Stale", state: "active", productMode: "harness" },
        },
      } as WorkbenchLiveEvent);
    });
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    let creation!: Promise<{ projectId: string; conversationId: string }>;
    act(() => {
      creation = result.current.createDemandConversation({
        projectId: "repo-1",
        productMode: "harness",
        clientRequestId: "stale-create-request",
        body: "Old request",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: [],
        showPendingBeforeCreate: true,
      }, vi.fn());
    });
    await act(async () => { await result.current.openProject("repo-2"); });
    finish();
    await expect(creation).resolves.toEqual({ projectId: "repo-1", conversationId: "conv-stale" });

    expect(result.current.selectedProjectId).toBe("repo-2");
    expect(result.current.selectedTopic).not.toBe("conv-stale");
    expect(result.current.selectedTopic).toBeNull();
  });

  it("owns temporary project registration before first demand", async () => {
    const fixture = ownerFixture({ restore: {
      projectId: "temporary",
      topicId: null,
      orchestrationOpen: false,
      settingsOpen: false,
    } });
    fixture.api.loadProjects.mockResolvedValue([{
      project: { id: "temporary", name: "Temporary", path: "C:/temporary" },
      path: "C:/temporary",
      pathExists: true,
      isGitRepo: true,
      managed: false,
      harness: {
        projectPath: "C:/temporary",
        managed: false,
        readiness: "missing",
        activeChanges: [],
        pendingEvolution: false,
        components: [],
      },
    }]);
    fixture.api.registerProject.mockResolvedValue({
      project: { id: "registered" },
      status: managedProject("registered"),
    });
    fixture.api.createDemandConversation.mockImplementation(async (_input, onEvent) => {
      onEvent({
        event: "topic.created",
        data: {
          projectId: "registered",
          productMode: "harness",
          conversationId: "registered-conversation",
          clientRequestId: "registered-request",
          replayed: false,
          topic: {
            id: "registered-conversation",
            conversationId: "registered-conversation",
            title: "Registered demand",
            state: "active",
            productMode: "harness",
          },
        },
      } as WorkbenchLiveEvent);
    });
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => {
      await expect(result.current.ensureProjectRegistered("temporary")).resolves.toBe("registered");
    });
    expect(fixture.api.registerProject).toHaveBeenCalledWith("C:/temporary");
    expect(result.current.selectedProjectId).toBe("registered");
    expect(fixture.navigation.persistProjectId).toHaveBeenLastCalledWith("registered");

    await act(async () => {
      await expect(result.current.createDemandConversation({
        projectId: "registered",
        productMode: "harness",
        clientRequestId: "registered-request",
        body: "Create after registration",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: [],
        showPendingBeforeCreate: true,
      }, vi.fn())).resolves.toEqual({
        projectId: "registered",
        conversationId: "registered-conversation",
      });
    });
    expect(result.current.selectedProjectId).toBe("registered");
    expect(result.current.selectedTopic).toBe("registered-conversation");
  });

  it("loads Agent snapshots without Harness readiness while keeping Harness diagnostic-only", async () => {
    const status: ProjectStatus = {
      project: { id: "agent-only", name: "Agent only", path: "C:/agent-only" },
      path: "C:/agent-only",
      pathExists: true,
      isGitRepo: true,
      managed: false,
      harness: {
        projectPath: "C:/agent-only",
        managed: false,
        readiness: "missing",
        activeChanges: [],
        pendingEvolution: false,
        components: [],
      },
    };
    const agentFixture = ownerFixture({ restore: { projectId: "agent-only", topicId: null, orchestrationOpen: false, settingsOpen: false } });
    agentFixture.api.loadProjects.mockResolvedValue([status]);
    const agent = renderHook(() => useProjectConversationSession({ ...agentFixture.ports, productMode: "agent", autoLoad: false }));
    await act(async () => { await agent.result.current.loadApp(); });
    expect(agentFixture.api.loadSnapshot).toHaveBeenCalledWith("agent-only", "agent", null);

    const harnessFixture = ownerFixture({ restore: { projectId: "agent-only", topicId: null, orchestrationOpen: false, settingsOpen: false } });
    harnessFixture.api.loadProjects.mockResolvedValue([status]);
    const harness = renderHook(() => useProjectConversationSession({ ...harnessFixture.ports, productMode: "harness", autoLoad: false }));
    await act(async () => { await harness.result.current.loadApp(); });
    expect(harnessFixture.api.loadSnapshot).not.toHaveBeenCalled();
    expect(harness.result.current.snapshot.warnings).toContain("创建第一条会话即可开始使用。");
  });

  it("keeps committed identity when the live stream fails after topic.created", async () => {
    const fixture = ownerFixture();
    fixture.api.createDemandConversation.mockImplementation(async (_input, onEvent) => {
      onEvent({
        event: "topic.created",
        data: {
          projectId: "repo-1",
          productMode: "harness",
          conversationId: "conv-committed",
          clientRequestId: "committed-request",
          replayed: false,
          topic: {
            id: "conv-committed",
            conversationId: "conv-committed",
            title: "Committed",
            state: "active",
            productMode: "harness",
          },
        },
      } as WorkbenchLiveEvent);
      throw new Error("stream disconnected");
    });
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => {
      await expect(result.current.createDemandConversation({
        projectId: "repo-1",
        productMode: "harness",
        clientRequestId: "committed-request",
        body: "Committed request",
        contextRefs: [],
        attachmentIds: ["attachment-1"],
        skillOverrides: [],
        showPendingBeforeCreate: true,
      }, vi.fn())).resolves.toEqual({ projectId: "repo-1", conversationId: "conv-committed" });
    });

    expect(result.current.selectedTopic).toBe("conv-committed");
    expect(fixture.ports.onError).toHaveBeenCalledWith("暂时无法加载内容。请重试。");
  });

  it("keeps the selected run and stream scoped to the latest request", async () => {
    let resolveOld!: (value: StreamPacket) => void;
    const oldStream = new Promise<StreamPacket>((resolve) => { resolveOld = resolve; });
    const fixture = ownerFixture();
    fixture.api.loadStream.mockImplementation((_projectId: string, runId: string) => (
      runId === "run-old" ? oldStream : Promise.resolve(stream(runId))
    ));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    let oldRequest!: Promise<void>;
    act(() => { oldRequest = result.current.chooseRun("run-old"); });
    await act(async () => { await result.current.chooseRun("run-new"); });
    await act(async () => { resolveOld(stream("run-old")); await oldRequest; });

    expect(result.current.selectedRun).toBe("run-new");
    expect(result.current.stream?.run.id).toBe("run-new");
  });

  it("does not load an old project's run during a conversation switch", async () => {
    let resolveTarget!: (value: Snapshot) => void;
    const targetSnapshot = new Promise<Snapshot>((resolve) => { resolveTarget = resolve; });
    const fixture = ownerFixture();
    fixture.api.loadSnapshot.mockImplementation((projectId: string) => projectId === "repo-2"
      ? targetSnapshot : Promise.resolve(snapshot("repo-1", "conv-1", "run-old")));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    fixture.api.loadStream.mockClear();
    let selection!: Promise<void>;
    act(() => { selection = result.current.chooseConversation("repo-2", "conv-2"); });
    expect(result.current.selectedProjectId).toBe("repo-2");
    expect(result.current.selectedTopic).toBe("conv-2");
    expect(fixture.api.loadStream).not.toHaveBeenCalledWith("repo-2", "run-old");
    await act(async () => { resolveTarget(snapshot("repo-2", "conv-2", "run-new")); await selection; });
    expect(fixture.api.loadStream).not.toHaveBeenCalledWith("repo-2", "run-old");
    expect(result.current.selectedRun).toBe("run-new");
    expect(result.current.stream?.run.id).toBe("run-new");
  });

  it("clears Timeline only for permanent Conversation deletion and preserves project removal behavior", async () => {
    const fixture = ownerFixture();
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    await act(async () => { await result.current.chooseConversation("repo-1", "conv-1"); });

    await act(async () => { await result.current.settleConversationLifecycle({
      projectId: "repo-1",
      conversationId: "conv-1",
      action: "delete",
      expectedLifecycleRevision: "conversation-lifecycle:1",
      confirmationToken: "delete-token",
    }); });
    expect(fixture.api.settleConversationLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo-1",
      conversationId: "conv-1",
      productMode: "harness",
      action: "delete",
      expectedLifecycleRevision: "conversation-lifecycle:1",
      confirmationToken: "delete-token",
    }));
    expect(fixture.timeline.clearConversation).toHaveBeenCalledWith("repo-1", "conv-1");
    expect(result.current.selectedTopic).toBeNull();

    await act(async () => { await result.current.removeProject("repo-1"); });
    expect(fixture.api.prepareProjectRemoval).toHaveBeenCalledWith("repo-1");
    expect(fixture.api.removeProject).toHaveBeenCalledWith("repo-1", "remove-token-repo-1");
    expect(fixture.timeline.clearProject).toHaveBeenCalledWith("repo-1");
    expect(result.current.selectedProjectId).toBeNull();
    expect(result.current.snapshot).toEqual(emptyWorkbenchSnapshot);
  });

  it("settles a selected lifecycle action after its SSE invalidation refresh wins the request generation", async () => {
    let resolveSettlement!: (value: {
      status: "completed";
      action: "archive";
      conversationId: string;
      snapshot: null;
      providerSyncStatus: "not-required";
    }) => void;
    const fixture = ownerFixture();
    fixture.api.settleConversationLifecycle.mockImplementation(() => new Promise((resolve) => {
      resolveSettlement = resolve;
    }));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    await act(async () => { await result.current.chooseConversation("repo-1", "conv-1"); });

    let settlement!: Promise<void>;
    act(() => {
      settlement = result.current.settleConversationLifecycle({
        projectId: "repo-1",
        conversationId: "conv-1",
        action: "archive",
        expectedLifecycleRevision: "conversation-lifecycle:0",
      });
    });
    await waitFor(() => expect(fixture.api.settleConversationLifecycle).toHaveBeenCalledOnce());
    await act(async () => { await result.current.refresh("repo-1", null); });
    await act(async () => {
      resolveSettlement({
        status: "completed",
        action: "archive",
        conversationId: "conv-1",
        snapshot: null,
        providerSyncStatus: "not-required",
      });
      await settlement;
    });

    expect(result.current.selectedTopic).toBeNull();
    expect(fixture.navigation.syncLocation).toHaveBeenLastCalledWith("repo-1", null);
  });

  it("hides an archive target immediately and leaves the selected draft identity untouched on failure", async () => {
    let rejectArchive!: (reason: Error) => void;
    const fixture = ownerFixture();
    fixture.api.loadNavigation.mockImplementation(async (_projectId: string, productMode: ProductMode) => ({
      productMode,
      conversations: [{ id: "conv-1", title: "Selected", state: "active", userStatusLabel: "处理中", waitingDecisionCount: 0 }],
    }));
    fixture.api.settleConversationLifecycle.mockImplementation(() => new Promise((_resolve, reject) => { rejectArchive = reject; }));
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });
    await act(async () => { await result.current.chooseConversation("repo-1", "conv-1"); });
    await waitFor(() => expect(result.current.projectNavigation["repo-1"]?.some((item) => item.id === "conv-1")).toBe(true));
    let settlement!: Promise<void>;
    act(() => { settlement = result.current.settleConversationLifecycle({
      projectId: "repo-1", conversationId: "conv-1", action: "archive", expectedLifecycleRevision: "conversation-lifecycle:0",
    }); });
    expect(result.current.archivingKeys.has("repo-1\0harness\0conv-1")).toBe(true);
    expect(result.current.projectNavigation["repo-1"]?.some((item) => item.id === "conv-1")).toBe(false);
    expect(result.current.selectedTopic).toBe("conv-1");
    await act(async () => { rejectArchive(new Error("Local commit failed")); await expect(settlement).rejects.toThrow("Local commit failed"); });
    expect(result.current.archivingKeys.size).toBe(0);
    expect(result.current.projectNavigation["repo-1"]?.some((item) => item.id === "conv-1")).toBe(true);
    expect(result.current.selectedTopic).toBe("conv-1");
  });

  it("does not consume a prepared removal when the user declines the destructive warning", async () => {
    const fixture = ownerFixture();
    fixture.ui.confirmRemoveProject.mockReturnValue(false);
    const { result } = renderHook(() => useProjectConversationSession({ ...fixture.ports, autoLoad: false }));
    await act(async () => { await result.current.loadApp(); });

    await act(async () => { await result.current.removeProject("repo-1"); });

    expect(fixture.api.prepareProjectRemoval).toHaveBeenCalledWith("repo-1");
    expect(fixture.api.removeProject).not.toHaveBeenCalled();
    expect(result.current.projects).toHaveLength(2);
  });
});

function ownerFixture(options: { restore?: WorkbenchRestoreParams } = {}) {
  const projects = [managedProject("repo-1"), managedProject("repo-2")];
  const api = {
    loadAppStatus: vi.fn(async () => ({ mode: "app" as const, directProjectId: "repo-1" })),
    loadProjects: vi.fn(async () => projects),
    loadSnapshot: vi.fn(async (projectId: string, productMode: ProductMode, conversationId: string | null) => (
      snapshot(projectId, conversationId, undefined, productMode)
    )),
    loadNavigation: vi.fn(async (projectId: string, productMode: ProductMode) => ({
      productMode,
      conversations: [{ id: `${projectId}-conversation`, title: `${projectId}-conversation`, state: "active", userStatusLabel: "处理中", waitingDecisionCount: 0 }],
    })),
    loadStream: vi.fn(async (_projectId: string, runId: string) => stream(runId)),
    prepareProjectRemoval: vi.fn(async (projectId: string) => ({
      token: `remove-token-${projectId}`,
      projectId,
      projectName: projectId,
      expiresAt: "2026-08-03T12:00:00.000Z",
    })),
    removeProject: vi.fn(async () => undefined),
    prepareConversationDelete: vi.fn(async (_projectId: string, conversationId: string, _productMode: ProductMode, expectedLifecycleRevision: string) => ({
      token: "delete-token",
      expiresAt: "2026-08-31T12:00:00.000Z",
      conversationId,
      lifecycleRevision: expectedLifecycleRevision,
      effect: "Deletes local presentation data.",
    })),
    settleConversationLifecycle: vi.fn(async (input) => ({
      status: "completed" as const,
      action: input.action,
      conversationId: input.conversationId,
      snapshot: null,
      providerSyncStatus: "not-required" as const,
    })),
    updateConversationTitle: vi.fn(async (_projectId: string, conversationId: string, title: string) => ({
      conversation: { id: conversationId, productMode: "harness" as const, title, state: "active" },
    })),
    registerProject: vi.fn(async () => ({ project: { id: "repo-1" }, status: managedProject("repo-1") })),
    createDemandConversation: vi.fn(async (input, onEvent: (event: WorkbenchLiveEvent) => void) => {
      onEvent({
        event: "topic.created",
        data: {
          projectId: "repo-1",
          productMode: "harness",
          conversationId: "conv-created",
          clientRequestId: input.clientRequestId,
          replayed: false,
          topic: { id: "conv-created", conversationId: "conv-created", title: "New demand", state: "active", productMode: "harness" },
        },
      } as WorkbenchLiveEvent);
    }),
  };
  const navigation = {
    readRestoreParams: vi.fn(() => options.restore ?? { projectId: null, topicId: null, orchestrationOpen: false, settingsOpen: false }),
    readPersistedProjectId: vi.fn(() => null),
    persistProjectId: vi.fn(),
    clearPersistedProjectId: vi.fn(),
    syncLocation: vi.fn(),
  };
  const timeline = { invalidateProjection: vi.fn(), clearProject: vi.fn(), clearConversation: vi.fn() };
  const resources = { cleanupTransition: vi.fn() };
  const operations = { invalidate: vi.fn() };
  const ui = { transition: vi.fn(), restoreView: vi.fn(), confirmRemoveProject: vi.fn(() => true) };
  const ports: ProjectConversationSessionPorts = { api, navigation, timeline, resources, operations, ui, onError: vi.fn() };
  return { api, navigation, timeline, resources, operations, ui, ports };
}

describe("Project removal confirmation", () => {
  it("states the destructive runtime boundary and preserved source owners", () => {
    const message = removalConfirmationMessage("Example");
    expect(message).toContain("永久删除 AHO 中的会话、执行记录和日志");
    expect(message).toContain("项目源码、项目协作配置、Git 独立工作区和 Git 历史会保留");
    expect(message).not.toContain("只会从 App 项目列表移出");
  });
});

function managedProject(id: string): ProjectStatus {
  return {
    project: { id, name: id, path: `C:/${id}` },
    path: `C:/${id}`,
    pathExists: true,
    isGitRepo: true,
    managed: true,
    harness: { readiness: "ready" },
  };
}

function snapshot(
  projectId: string,
  conversationId: string | null,
  runId?: string,
  productMode: ProductMode = "harness",
): Snapshot {
  return {
    ...emptyWorkbenchSnapshot,
    productMode,
    project: { id: projectId, name: projectId, path: `C:/${projectId}` },
    center: {
      ...emptyWorkbenchSnapshot.center,
      selectedTopic: conversationId ? { id: conversationId, productMode, title: conversationId, state: "active", selectedProviderId: "codex", demandId: conversationId, graphScopeId: "scope-1" } : null,
      conversationInteractions: { productMode, conversationId: conversationId ?? undefined, items: [] },
      agentLoop: { runs: runId ? [{ id: runId, status: "running", startedAt: "2026-07-17T00:00:00.000Z", stages: [], targets: [], evidenceRefs: [], actionRefs: [] }] : [] },
    },
  };
}

function stream(runId: string): StreamPacket {
  return {
    run: { id: runId, status: "running", startedAt: "2026-07-17T00:00:00.000Z", stages: [], targets: [], evidenceRefs: [], actionRefs: [] },
    live: true,
    events: [],
    artifacts: [],
    diagnostics: [],
  };
}
