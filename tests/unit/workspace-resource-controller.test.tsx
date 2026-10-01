// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentDraftKey,
  useWorkspaceResourceController,
  workspaceResourceId,
} from "../../src/web/src/controllers/useWorkspaceResourceController.js";
import type { AgentSurfaceProjectionItem, TextDocumentResource, WorkspaceResourceTarget } from "../../src/web/src/types.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Workspace resource controller", () => {
  it("returns the adjacent target when closing the selected tab so navigation can replace its identity", () => {
    const { result } = renderHook(() => useWorkspaceResourceController({
      projectId: "repo-1", conversationId: "conversation-1",
      resolveResource: vi.fn(async () => document("plan-1", "content")),
    }));
    const first = planTarget("conversation-1", "plan-1");
    const second = planTarget("conversation-1", "plan-2");
    act(() => { result.current.openResource(first); result.current.openResource(second); });
    let adjacent: WorkspaceResourceTarget | null = null;
    act(() => { adjacent = result.current.closeResource("plan-2"); });
    expect(adjacent).toEqual(first);
    expect(result.current.selectedResourceId).toBe("plan-1");
    act(() => { adjacent = result.current.closeResource("plan-1"); });
    expect(adjacent).toBeNull();
  });

  it("restores child drafts per project, mode and conversation after navigation", () => {
    const initial = { projectId: "repo-1", conversationId: "conversation-1", productMode: "agent" as const };
    const { result, rerender } = renderHook(useWorkspaceResourceController, { initialProps: initial as { projectId: string; conversationId: string; productMode: "agent" | "harness" } });
    act(() => result.current.setAgentDraft("child", "original"));
    rerender({ ...initial, projectId: "repo-2" }); expect(result.current.agentDrafts).toEqual({});
    act(() => result.current.setAgentDraft("child", "other-project"));
    rerender({ ...initial, productMode: "harness" }); expect(result.current.agentDrafts).toEqual({});
    rerender(initial); expect(Object.values(result.current.agentDrafts)).toEqual(["original"]);
  });

  it("includes the exact selected Agent surface in the fallback live request", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        mode: "chat",
        message: "feedback",
        agentSurfaceId: "agent:codex:thread:a",
        productMode: "harness",
      });
      return new Response("event: done\ndata: {\"status\":\"completed\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const { result } = renderHook(() => useWorkspaceResourceController({
        projectId: "repo-1",
        conversationId: "conversation-1",
      }));
      const agent = planningAgent("agent:codex:thread:a");
      act(() => result.current.setAgentDraft(agent.agentSurfaceId, "feedback"));
      await act(async () => result.current.submitAgentMessage(agent));
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/repo-1/workbench/topics/conversation-1/messages/live",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it.each(["agent", "harness"] as const)("sends caller-captured %s product mode without role inference", async (productMode) => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ productMode, agentSurfaceId: "agent:codex:thread:a" });
      return new Response("event: done\ndata: {\"status\":\"completed\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const { result } = renderHook(() => useWorkspaceResourceController({
        projectId: "repo-1",
        conversationId: "conversation-1",
        productMode,
      }));
      const roleMustNotDecideMode = { ...planningAgent("agent:codex:thread:a"), roleId: "native-child-agent" };
      act(() => result.current.setAgentDraft(roleMustNotDecideMode.agentSurfaceId, "feedback"));
      await act(async () => result.current.submitAgentMessage(roleMustNotDecideMode));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("owns stable tabs, selection, document loading, errors, and request generations", async () => {
    let resolveFirst!: (resource: TextDocumentResource) => void;
    const firstRequest = new Promise<TextDocumentResource>((resolve) => { resolveFirst = resolve; });
    const resolveResource = vi.fn()
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValueOnce(document("plan-1", "updated"));
    const options = {
      projectId: "repo-1",
      conversationId: "conversation-1",
      resolveResource,
      sendAgentMessage: vi.fn(async () => undefined),
    };
    const { result } = renderHook((props) => useWorkspaceResourceController(props), { initialProps: options });
    const target = planTarget("conversation-1", "plan-1");

    act(() => {
      result.current.openResource(target);
      result.current.openResource(target);
    });
    expect(result.current.tabs).toEqual([{ resourceId: "plan-1", target }]);
    expect(result.current.selectedResourceId).toBe("plan-1");
    expect(result.current.loadingResourceIds).toEqual(["plan-1"]);
    expect(resolveResource).toHaveBeenCalledTimes(1);

    act(() => result.current.closeResource("plan-1"));
    await act(async () => { resolveFirst(document("plan-1", "stale")); await firstRequest; });
    expect(result.current.documents).toEqual({});
    expect(result.current.loadingResourceIds).toEqual([]);

    act(() => { result.current.openResource(target); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.documents["plan-1"]?.content).toBe("updated");
    act(() => result.current.selectResource("plan-1"));
    await act(async () => { await Promise.resolve(); });
    expect(resolveResource).toHaveBeenCalledTimes(2);
  });

  it("applies explicit cleanup transitions without mixing project and conversation resources", async () => {
    const resolveResource = vi.fn(async (_projectId: string, target: Exclude<WorkspaceResourceTarget, { kind: "agent" }>) => (
      target.kind === "document" ? document(target.documentId, "plan") : projectFile(target.relativePath)
    ));
    const { result } = renderHook(() => useWorkspaceResourceController({
      projectId: "repo-1",
      conversationId: "conversation-1",
      resolveResource,
      sendAgentMessage: vi.fn(async () => undefined),
    }));
    const agent = planningAgent("agent:codex:thread:a");

    act(() => {
      result.current.openResource({ kind: "agent", conversationId: "conversation-1", agentSurfaceId: agent.agentSurfaceId });
      result.current.openResource(planTarget("conversation-1", "plan-1"));
      result.current.openResource({ kind: "project-file", relativePath: "notes.md" });
      result.current.setAgentDraft(agent.agentSurfaceId, "draft");
    });
    await act(async () => { await Promise.resolve(); });

    act(() => result.current.cleanupTransition("graph-scope-changed"));
    expect(result.current.tabs.map((tab) => tab.target.kind)).toEqual(["agent", "document", "project-file"]);
    expect(Object.values(result.current.agentDrafts)).toEqual(["draft"]);
    expect(result.current.documents["plan-1"]).toBeTruthy();

    act(() => result.current.cleanupTransition("conversation-changed"));
    expect(result.current.tabs.map((tab) => tab.target.kind)).toEqual(["project-file"]);
    expect(result.current.selectedResourceId).toBe("project-file:notes.md");

    act(() => result.current.cleanupTransition("project-changed"));
    expect(result.current.tabs).toEqual([]);
    expect(result.current.documents).toEqual({});
    expect(result.current.selectedResourceId).toBeNull();
  });

  it("owns resource errors and retries the same stable resource identity", async () => {
    const resolveResource = vi.fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(projectFile("notes.md"));
    const { result } = renderHook(() => useWorkspaceResourceController({
      projectId: "repo-1",
      conversationId: "conversation-1",
      resolveResource,
      sendAgentMessage: vi.fn(async () => undefined),
    }));
    const target = { kind: "project-file", relativePath: "notes.md" } as const;
    const resourceId = workspaceResourceId(target);

    await act(async () => { await result.current.ensureLoaded(target); });
    expect(result.current.resourceErrors[resourceId]).toBe("暂时无法加载内容。请重试。");
    expect(result.current.loadingResourceIds).toEqual([]);

    await act(async () => { await result.current.ensureLoaded(target); });
    expect(result.current.resourceErrors[resourceId]).toBeUndefined();
    expect(result.current.documents[resourceId]?.content).toBe("# Notes");
    expect(resolveResource).toHaveBeenCalledTimes(2);
  });

  it("isolates Agent drafts and releases each pending submit after 1.2 seconds", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<void>(() => undefined);
    const sendAgentMessage = vi.fn(() => neverSettles);
    const { result } = renderHook(() => useWorkspaceResourceController({
      projectId: "repo-1",
      conversationId: "conversation-1",
      sendAgentMessage,
    }));
    const first = planningAgent("agent:codex:thread:a");
    const second = planningAgent("agent:codex:thread:b");
    const firstKey = agentDraftKey("conversation-1", first.agentSurfaceId);
    const secondKey = agentDraftKey("conversation-1", second.agentSurfaceId);

    act(() => {
      result.current.openResource({ kind: "agent", conversationId: "conversation-1", agentSurfaceId: first.agentSurfaceId });
      result.current.openResource({ kind: "agent", conversationId: "conversation-1", agentSurfaceId: second.agentSurfaceId });
      result.current.setAgentDraft(first.agentSurfaceId, "first draft");
      result.current.setAgentDraft(second.agentSurfaceId, "second draft");
    });
    expect(result.current.agentDrafts[firstKey]).toBe("first draft");
    expect(result.current.agentDrafts[secondKey]).toBe("second draft");

    act(() => { void result.current.submitAgentMessage(first); });
    expect(sendAgentMessage).toHaveBeenCalledWith(first, "first draft");
    expect(result.current.pendingAgentMessages[firstKey]).toBeTruthy();
    expect(result.current.pendingAgentMessages[secondKey]).toBeUndefined();
    expect(result.current.agentDrafts[firstKey]).toBeUndefined();
    expect(result.current.agentDrafts[secondKey]).toBe("second draft");

    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(result.current.pendingAgentMessages[firstKey]).toBeUndefined();
  });

  it("never submits feedback for a historical or terminated Agent", async () => {
    const sendAgentMessage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorkspaceResourceController({
      projectId: "repo-1",
      conversationId: "conversation-1",
      sendAgentMessage,
    }));
    const historical = { ...planningAgent("agent:codex:thread:old"), scopeRange: "historical" as const, readOnly: true };
    act(() => result.current.setAgentDraft(historical.agentSurfaceId, "must not send"));
    await act(async () => result.current.submitAgentMessage(historical));
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("does not let an older submission settle or restore state owned by a newer submission", async () => {
    vi.useFakeTimers();
    let rejectFirst!: (reason: Error) => void;
    let resolveSecond!: () => void;
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
    const sendAgentMessage = vi.fn().mockImplementationOnce(() => first).mockImplementationOnce(() => second);
    const { result } = renderHook(() => useWorkspaceResourceController({
      projectId: "repo-1",
      conversationId: "conversation-1",
      sendAgentMessage,
    }));
    const agent = planningAgent("agent:codex:thread:a");
    const key = agentDraftKey("conversation-1", agent.agentSurfaceId);

    act(() => result.current.setAgentDraft(agent.agentSurfaceId, "first"));
    let firstSubmit!: Promise<void>;
    act(() => { firstSubmit = result.current.submitAgentMessage(agent); });
    await act(async () => { vi.advanceTimersByTime(1200); });
    act(() => result.current.setAgentDraft(agent.agentSurfaceId, "second"));
    let secondSubmit!: Promise<void>;
    act(() => { secondSubmit = result.current.submitAgentMessage(agent); });
    expect(result.current.pendingAgentMessages[key]).toBeTruthy();

    await act(async () => { rejectFirst(new Error("old failure")); await firstSubmit.catch(() => undefined); });
    expect(result.current.agentDrafts[key]).toBeUndefined();
    expect(result.current.pendingAgentMessages[key]).toBeTruthy();

    await act(async () => { resolveSecond(); await secondSubmit; });
    expect(result.current.pendingAgentMessages[key]).toBeUndefined();
  });

  it("retains the closed Agent draft and restores its failed in-flight send", async () => {
    let rejectSend!: (reason: Error) => void;
    const inFlight = new Promise<void>((_resolve, reject) => { rejectSend = reject; });
    const sendAgentMessage = vi.fn(() => inFlight);
    const { result } = renderHook(() => useWorkspaceResourceController({
      projectId: "repo-1",
      conversationId: "conversation-1",
      sendAgentMessage,
    }));
    const agent = planningAgent("agent:codex:thread:a");
    const target = { kind: "agent", conversationId: "conversation-1", agentSurfaceId: agent.agentSurfaceId } as const;
    const resourceId = workspaceResourceId(target);

    act(() => {
      result.current.openResource(target);
      result.current.setAgentDraft(agent.agentSurfaceId, "feedback");
    });
    let submit!: Promise<void>;
    act(() => { submit = result.current.submitAgentMessage(agent); });
    act(() => result.current.closeResource(resourceId));
    await act(async () => { rejectSend(new Error("closed request failed")); await submit.catch(() => undefined); });

    expect(result.current.tabs).toEqual([]);
    expect(Object.values(result.current.agentDrafts)).toEqual(["feedback"]);
    expect(result.current.pendingAgentMessages).toEqual({});
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
  });
});

function planningAgent(id: string): AgentSurfaceProjectionItem {
  return {
    agentSurfaceId: id,
    kind: "agent",
    roleId: "planning-agent",
    roleDisplayName: "Planning Agent",
    parentAgentSurfaceId: "main-agent",
    label: id,
    description: "Plans work",
    skills: ["planning"],
    graphScopeId: "scope-1",
    scopeRange: "current",
    status: "running",
    readOnly: false,
    createdAt: "2026-07-18T00:00:00Z",
  };
}

function planTarget(conversationId: string, documentId: string) {
  return { kind: "document", conversationId, documentId } as const;
}

function document(resourceId: string, content: string): TextDocumentResource {
  return {
    resourceId,
    kind: "plan",
    title: "Plan",
    language: "markdown",
    content,
    revision: `revision:${content}`,
    readOnly: true,
    target: planTarget("conversation-1", resourceId),
  };
}

function projectFile(relativePath: string): TextDocumentResource {
  return {
    resourceId: `project-file:${relativePath}`,
    kind: "markdown-file",
    title: relativePath,
    language: "markdown",
    content: "# Notes",
    revision: "revision:file",
    readOnly: true,
    target: { kind: "project-file", relativePath },
  };
}
