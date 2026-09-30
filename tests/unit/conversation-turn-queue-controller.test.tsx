// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationTurnQueueController } from "../../src/web/src/controllers/useConversationTurnQueueController.js";
import type { ConversationTurnQueueSnapshot } from "../../src/web/src/types.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Conversation Turn queue controller", () => {
  it.each(["enqueue", "guide"] as const)("recalibrates %s only after an exact unaccepted receipt", async (action) => {
    const bodies: Record<string, unknown>[] = [];
    let revision = "queue:1";
    const initial = { ...queuedSnapshot(false), guideTarget: { providerId: "codex", attemptId: "attempt-1" } };
    initial.items[0] = { ...initial.items[0]!, guideMode: "steer" } as typeof initial.items[0];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (bodies.length === 1) {
          revision = "queue:2";
          return new Response(JSON.stringify({ error: "changed before acceptance", queueAdmission: {
            status: "not-accepted", action, projectId: "project-1", productMode: "agent",
            conversationId: "conversation-a", clientRequestId: body.clientRequestId,
            ...(action === "guide" ? { queueItemId: "item-1" } : {}),
          } }), { status: 409 });
        }
      }
      return jsonResponse({ ...initial, revision, executionRevision: `execution:${revision}` });
    }));
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1", productMode: "agent", conversationId: "conversation-a", onError: vi.fn(),
    }));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe("queue:1"));
    const captured = { text: "same demand", contextRefs: [], attachmentIds: [], skillOverrides: {}, providerId: "codex",
      agentTurnMode: "default" as const, modelId: null, reasoningEffort: null, expectedDraftUpdatedAt: "draft-1" };
    await act(async () => { await expect(action === "guide" ? result.current.guide("item-1") : result.current.enqueue(captured)).rejects.toThrow(); });
    expect(result.current.snapshot?.revision).toBe("queue:2");
    await act(async () => { await (action === "guide" ? result.current.guide("item-1")
      : result.current.enqueue({ ...captured, expectedDraftUpdatedAt: "draft-2" })); });
    expect(bodies[1]).toMatchObject({ expectedRevision: "queue:2", expectedExecutionRevision: "execution:queue:2" });
    expect(bodies[1]!.clientRequestId).not.toBe(bodies[0]!.clientRequestId);
    if (action === "enqueue") expect(bodies[1]!.expectedDraftUpdatedAt).toBe("draft-2");
  });

  it.each(["absent", "foreign"] as const)("retains identity when conflict acceptance evidence is %s", async (evidence) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (bodies.length === 1) return new Response(JSON.stringify({ error: "uncertain conflict",
          ...(evidence === "foreign" ? { queueAdmission: { status: "not-accepted", action: "enqueue",
            projectId: "other-project", productMode: "agent", conversationId: "conversation-a", clientRequestId: body.clientRequestId } } : {}),
        }), { status: 409 });
      }
      return jsonResponse(snapshot("conversation-a", bodies.length ? "queue:2" : "queue:1"));
    }));
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1", productMode: "agent", conversationId: "conversation-a", onError: vi.fn(),
    }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const captured = { text: "same demand", contextRefs: [], attachmentIds: [], skillOverrides: {}, providerId: "codex",
      agentTurnMode: "default" as const, modelId: null, reasoningEffort: null, expectedDraftUpdatedAt: "draft-1" };
    await act(async () => { await expect(result.current.enqueue(captured)).rejects.toThrow(); });
    await act(async () => { await result.current.enqueue({ ...captured, expectedDraftUpdatedAt: "draft-2" }); });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("retains uncertain enqueue identity across scope changes and newer draft revisions", async () => {
    const bodies: Record<string, unknown>[] = [];
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        if (fail) { fail = false; throw new Error("lost confirmation"); }
      }
      return jsonResponse(snapshot(url.includes("conversation-b") ? "conversation-b" : "conversation-a", "queue:2"));
    }));
    const { result, rerender } = renderHook(({ conversationId }) => useConversationTurnQueueController({
      projectId: "project-1", productMode: "agent", conversationId, onError: vi.fn(),
    }), { initialProps: { conversationId: "conversation-a" } });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const captured = { text: "same request", contextRefs: [], attachmentIds: [], skillOverrides: {}, providerId: "codex",
      agentTurnMode: "default" as const, modelId: null, reasoningEffort: null, expectedDraftUpdatedAt: "draft-1" };
    await act(async () => { await expect(result.current.enqueue(captured)).rejects.toThrow(); });
    rerender({ conversationId: "conversation-b" });
    await waitFor(() => expect(result.current.snapshot?.conversationId).toBe("conversation-b"));
    rerender({ conversationId: "conversation-a" });
    await waitFor(() => expect(result.current.snapshot?.conversationId).toBe("conversation-a"));
    await act(async () => { await result.current.enqueue({ ...captured, expectedDraftUpdatedAt: "draft-2" }); });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("guides persisted content with exact target identity and keeps background calibration usable", async () => {
    const held = deferred<Response>();
    let reads = 0;
    const initial = { ...queuedSnapshot(false), guideTarget: { providerId: "codex", attemptId: "attempt-1" } };
    initial.items[0] = { ...initial.items[0]!, guideMode: "steer" } as typeof initial.items[0];
    const fetchMock = vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ ...initial, items: [] });
      if (++reads === 2) return held.promise;
      return jsonResponse(initial);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConversationTurnQueueController({ projectId: "project-1", productMode: "agent", conversationId: "conversation-a", onError: vi.fn() }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    let refresh!: Promise<unknown>;
    act(() => { refresh = result.current.load(); });
    expect(result.current.loading).toBe(false);
    await act(async () => { await result.current.guide("item-1"); });
    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(mutation[0])).toContain("/item-1/guide");
    expect(JSON.parse(String(mutation[1]?.body))).toEqual({ productMode: "agent", expectedRevision: initial.revision,
      expectedExecutionRevision: initial.executionRevision, providerId: "codex", expectedAttemptId: "attempt-1", clientRequestId: expect.any(String) });
    held.resolve(jsonResponse(initial));
    await act(async () => { await refresh; });
    expect(result.current.snapshot?.items).toEqual([]);
  });
  it("does not request queue state for a Renderer-only pending Conversation scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1",
      productMode: "agent",
      conversationId: "pending:request-1",
      onError: vi.fn(),
    }));

    await act(async () => { await Promise.resolve(); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("fences stale Conversation loads and sends exact queue CAS identity", async () => {
    const first = deferred<Response>();
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (!init && value.includes("conversation-a")) return first.promise;
      if (!init && value.includes("conversation-b")) return Promise.resolve(jsonResponse(snapshot("conversation-b", "queue:3")));
      if (init?.method === "POST" && value.includes("conversation-b")) return Promise.resolve(jsonResponse(snapshot("conversation-b", "queue:4")));
      throw new Error(`Unexpected request: ${value}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ conversationId }) => useConversationTurnQueueController({
        projectId: "project-1",
        productMode: "agent",
        conversationId,
        onError,
      }),
      { initialProps: { conversationId: "conversation-a" } },
    );
    rerender({ conversationId: "conversation-b" });
    await waitFor(() => expect(result.current.snapshot?.conversationId).toBe("conversation-b"));
    first.resolve(jsonResponse(snapshot("conversation-a", "queue:9")));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.snapshot?.conversationId).toBe("conversation-b");

    await act(async () => {
      await result.current.enqueue({
        text: "next",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: {},
        providerId: "codex",
        agentTurnMode: "default",
        modelId: null,
        reasoningEffort: null,
        expectedDraftUpdatedAt: "2026-08-28T00:00:00.000Z",
      });
    });
    const enqueueCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(enqueueCall[1]?.body))).toMatchObject({
      productMode: "agent",
      expectedRevision: "queue:3",
      expectedExecutionRevision: "execution:conversation-b",
      expectedDraftUpdatedAt: "2026-08-28T00:00:00.000Z",
      text: "next",
      providerId: "codex",
    });
    expect(result.current.snapshot?.revision).toBe("queue:4");
    expect(onError).not.toHaveBeenCalled();
  });

  it("automatically dispatches only the selected queue revision", async () => {
    const initial = {
      ...snapshot("conversation-a", "queue:1"),
      canDispatch: true,
      items: [{
        queueItemId: "item-1", clientRequestId: "request-1", position: 1, status: "queued" as const,
        retryCount: 0, text: "queued", contextRefs: [], attachmentIds: [], skillOverrides: {},
        providerId: "codex", agentTurnMode: "default" as const, modelId: null, reasoningEffort: null,
        createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
        executionCompatibility: { state: "compatible" as const },
      }],
    };
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => Promise.resolve(jsonResponse(
      init?.method === "POST"
        ? { ...initial, revision: "queue:2", canDispatch: false, items: [{ ...initial.items[0]!, status: "dispatching" as const }] }
        : initial,
    )));
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useConversationTurnQueueController({
      projectId: "project-1",
      productMode: "agent",
      conversationId: "conversation-a",
      onError: vi.fn(),
    }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    const dispatchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(dispatchCall[0])).toContain("/turn-queue/dispatch-next");
    expect(JSON.parse(String(dispatchCall[1]?.body))).toEqual({ productMode: "agent", expectedRevision: "queue:1" });
  });

  it("reloads canonical queue state after the selected Turn terminates and then continues FIFO", async () => {
    const waiting = queuedSnapshot(false);
    const ready = queuedSnapshot(true);
    let reads = 0;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse({
          ...ready,
          revision: "queue:2",
          canDispatch: false,
          items: [{ ...ready.items[0]!, status: "dispatching" as const }],
        }));
      }
      reads += 1;
      return Promise.resolve(jsonResponse(reads === 1 ? waiting : ready));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1",
      productMode: "agent",
      conversationId: "conversation-a",
      onError: vi.fn(),
    }));
    await waitFor(() => expect(result.current.snapshot?.canDispatch).toBe(false));

    act(() => result.current.handleEvent("project-1", {
      event: "done",
      data: { projectId: "project-1", productMode: "agent", conversationId: "conversation-a", status: "failed" },
    }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("reloads the exact execution revision when the selected Turn identity changes", async () => {
    let reads = 0;
    const runningLoad = deferred<Response>();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(jsonResponse(snapshot("conversation-a", "queue:2")));
      }
      reads += 1;
      if (reads === 2) return runningLoad.promise;
      return Promise.resolve(jsonResponse({
        ...snapshot("conversation-a", "queue:1"),
        executionRevision: "execution:idle",
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ executionKey }) => useConversationTurnQueueController({
        projectId: "project-1",
        productMode: "agent",
        conversationId: "conversation-a",
        executionKey,
        onError: vi.fn(),
      }),
      { initialProps: { executionKey: "idle" } },
    );
    await waitFor(() => expect(result.current.snapshot?.executionRevision).toBe("execution:idle"));

    rerender({ executionKey: "running\0codex\0attempt-1" });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      expect(await result.current.enqueue({
        text: "must wait for calibration",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: {},
        providerId: "codex",
        agentTurnMode: "default",
        modelId: null,
        reasoningEffort: null,
        expectedDraftUpdatedAt: null,
      })).toBeNull();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    runningLoad.resolve(jsonResponse({
      ...snapshot("conversation-a", "queue:1"),
      executionRevision: "execution:running-attempt",
    }));
    await waitFor(() => expect(result.current.snapshot?.executionRevision).toBe("execution:running-attempt"));
    expect(reads).toBe(2);
  });

  it("retries the same queue revision after a busy response becomes dispatchable", async () => {
    const ready = queuedSnapshot(true);
    const waiting = queuedSnapshot(false);
    let posts = 0;
    let reads = 0;
    let dispatchable = true;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        if (posts === 1) dispatchable = false;
        return Promise.resolve(jsonResponse(posts === 1
          ? waiting
          : { ...ready, revision: "queue:2", canDispatch: false, items: [{ ...ready.items[0]!, status: "dispatching" as const }] }));
      }
      reads += 1;
      return Promise.resolve(jsonResponse(dispatchable ? ready : waiting));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1",
      productMode: "agent",
      conversationId: "conversation-a",
      onError: vi.fn(),
    }));
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => expect(result.current.snapshot?.canDispatch).toBe(false));

    dispatchable = true;
    act(() => result.current.handleEvent("project-1", {
      event: "done",
      data: { projectId: "project-1", productMode: "agent", conversationId: "conversation-a", status: "completed" },
    }));

    await waitFor(() => expect(posts).toBe(2));
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("keeps enqueue available during a long background dispatch and ignores its stale receipt", async () => {
    const ready = queuedSnapshot(true);
    const dispatch = deferred<Response>();
    const afterEnqueue = {
      ...ready,
      revision: "queue:2",
      canDispatch: false,
      items: [
        { ...ready.items[0]!, status: "dispatching" as const },
        { ...ready.items[0]!, queueItemId: "item-2", clientRequestId: "request-2", position: 2, text: "second" },
      ],
    };
    let latest = ready;
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (init?.method === "POST" && value.endsWith("/dispatch-next")) return dispatch.promise;
      if (init?.method === "POST") {
        latest = afterEnqueue;
        return Promise.resolve(jsonResponse(afterEnqueue));
      }
      return Promise.resolve(jsonResponse(latest));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1",
      productMode: "agent",
      conversationId: "conversation-a",
      onError: vi.fn(),
    }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/dispatch-next"))).toBe(true));
    expect(result.current.mutating).toBe(false);

    await act(async () => {
      await result.current.enqueue({
        text: "second",
        contextRefs: [],
        attachmentIds: [],
        skillOverrides: {},
        providerId: "codex",
        agentTurnMode: "default",
        modelId: null,
        reasoningEffort: null,
        expectedDraftUpdatedAt: null,
      });
    });
    expect(result.current.snapshot?.revision).toBe("queue:2");

    dispatch.resolve(jsonResponse({ ...ready, revision: "queue:99", items: [] }));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe("queue:2"));
  });

  it("does not let an older load overwrite a newer queue mutation", async () => {
    const staleLoad = deferred<Response>();
    let reads = 0;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return Promise.resolve(jsonResponse(snapshot("conversation-a", "queue:2")));
      reads += 1;
      return reads === 1
        ? Promise.resolve(jsonResponse({ ...snapshot("conversation-a", "queue:1"), items: queuedSnapshot(false).items }))
        : staleLoad.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1",
      productMode: "agent",
      conversationId: "conversation-a",
      onError: vi.fn(),
    }));
    await waitFor(() => expect(result.current.snapshot?.revision).toBe("queue:1"));

    let pendingLoad!: Promise<ConversationTurnQueueSnapshot | null>;
    act(() => { pendingLoad = result.current.load(); });
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => { await result.current.remove("item-1"); });
    staleLoad.resolve(jsonResponse(snapshot("conversation-a", "queue:1")));
    await act(async () => { await pendingLoad; });

    expect(result.current.snapshot?.revision).toBe("queue:2");
  });

  it("confirms the exact queued execution contract before dispatch becomes available", async () => {
    const confirmationRequired: ConversationTurnQueueSnapshot = {
      ...queuedSnapshot(false),
      items: [{
        ...queuedSnapshot(false).items[0]!,
        executionCompatibility: {
          state: "confirmation-required",
          created: { family: "agent.turn", epoch: 1 },
          target: { family: "agent.turn", epoch: 2 },
          summary: "执行方式已更新，需要确认后发送",
        },
      }],
    };
    const confirmed = {
      ...confirmationRequired,
      revision: "queue:2",
      canDispatch: false,
      items: [{ ...confirmationRequired.items[0]!, executionCompatibility: { state: "compatible" as const } }],
    };
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => Promise.resolve(jsonResponse(
      init?.method === "POST" ? confirmed : confirmationRequired,
    )));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useConversationTurnQueueController({
      projectId: "project-1",
      productMode: "agent",
      conversationId: "conversation-a",
      onError: vi.fn(),
    }));
    await waitFor(() => expect(result.current.snapshot?.items[0]?.executionCompatibility.state).toBe("confirmation-required"));

    await act(async () => { await result.current.confirmExecutionContract("item-1"); });
    const call = fetchMock.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/item-1/confirm-execution"))!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      productMode: "agent",
      expectedRevision: "queue:1",
      expectedCreatedContract: { family: "agent.turn", epoch: 1 },
      expectedTargetContract: { family: "agent.turn", epoch: 2 },
    });
    expect(result.current.snapshot?.items[0]?.executionCompatibility).toEqual({ state: "compatible" });
  });
});

function queuedSnapshot(canDispatch: boolean): ConversationTurnQueueSnapshot {
  return {
    ...snapshot("conversation-a", "queue:1"),
    canDispatch,
    items: [{
      queueItemId: "item-1", clientRequestId: "request-1", position: 1, status: "queued",
      retryCount: 0, text: "queued", contextRefs: [], attachmentIds: [], skillOverrides: {},
      providerId: "codex", agentTurnMode: "default", modelId: null, reasoningEffort: null,
      createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
      executionCompatibility: { state: "compatible" },
    }],
  };
}

function snapshot(conversationId: string, revision: string): ConversationTurnQueueSnapshot {
  return {
    projectId: "project-1",
    productMode: "agent",
    conversationId,
    revision,
    executionRevision: `execution:${conversationId}`,
    items: [],
    canEnqueue: true,
    canDispatch: false,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
