import { describe, expect, it } from "vitest";
import { canonicalTimelineReconnectScopes } from "../../src/web/src/canonicalTimelineController.js";
import {
  beginCanonicalTimelineRequest,
  canonicalTimelineReducer,
  canonicalTimelineScopeKey,
  createCanonicalTimelineState,
  selectCanonicalTimelineEnvelopes,
  selectCanonicalTimelineSurface,
  selectCanonicalTimelineTranscript,
  type CanonicalTimelineEnvelope,
  type CanonicalTimelinePage,
  type CanonicalTimelineRequestKind,
  type CanonicalTimelineScope,
  type CanonicalTimelineState,
} from "../../src/web/src/canonicalTimelineStore.js";

const mainScope: CanonicalTimelineScope = {
  projectId: "project-a",
  productMode: "harness",
  conversationId: "conversation-a",
  agentSurfaceId: "main-agent",
};

describe("canonical Timeline Store", () => {
  it("calibrates Main and every open child surface after project SSE reconnect", () => {
    expect(canonicalTimelineReconnectScopes("project-a", "harness", "conversation-a", [
      { resourceId: "agent:a", target: { kind: "agent", conversationId: "conversation-a", agentSurfaceId: "agent:a" } },
      { resourceId: "agent:b", target: { kind: "agent", conversationId: "conversation-b", agentSurfaceId: "agent:b" } },
      { resourceId: "document:a", target: { kind: "document", conversationId: "conversation-a", documentId: "document:a" } },
      { resourceId: "agent:a-duplicate", target: { kind: "agent", conversationId: "conversation-a", agentSurfaceId: "agent:a" } },
    ])).toEqual([
      { projectId: "project-a", productMode: "harness", conversationId: "conversation-a", agentSurfaceId: "main-agent" },
      { projectId: "project-a", productMode: "harness", conversationId: "conversation-a", agentSurfaceId: "agent:a" },
    ]);
  });

  it("keeps optimistic steering ephemeral until canonical calibration or explicit discard", () => {
    const optimistic = {
      ...envelope("optimistic-steer:request-1", Number.MAX_SAFE_INTEGER, 1),
      cells: [{
        ...envelope("optimistic-steer:request-1", Number.MAX_SAFE_INTEGER, 1).cells[0],
        kind: "user-message" as const,
        source: "user" as const,
        text: "temporary steer",
        status: "submitting",
        realtime: true,
      }],
    };
    let state = canonicalTimelineReducer(createCanonicalTimelineState(), {
      type: "optimistic.received",
      scope: mainScope,
      envelope: optimistic,
    });
    expect(texts(state)).toEqual(["temporary steer"]);
    expect(selectCanonicalTimelineSurface(state, mainScope)?.watermark).toBe(0);

    state = loadPage(state, "latest", page(1, [envelope("steer:request-1:user", 10, 1)]));
    expect(texts(state)).toEqual(["steer:request-1:user@1"]);

    state = canonicalTimelineReducer(state, {
      type: "optimistic.received",
      scope: mainScope,
      envelope: { ...optimistic, messageId: "optimistic-steer:request-2" },
    });
    state = canonicalTimelineReducer(state, {
      type: "optimistic.discarded",
      scope: mainScope,
      messageId: "optimistic-steer:request-2",
    });
    expect(selectCanonicalTimelineEnvelopes(state, mainScope).map((item) => item.messageId)).toEqual(["steer:request-1:user"]);
  });

  it("keeps a scoped optimistic user intent visible and updates its transport state", () => {
    let state = canonicalTimelineReducer(createCanonicalTimelineState(), {
      type: "optimistic.received",
      scope: mainScope,
      envelope: optimisticUserEnvelope("request-1", "validate the import"),
    });

    expect(texts(state)).toEqual(["validate the import"]);
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)[0]?.cells[0]).toMatchObject({
      id: "pending-user:request-1",
      text: "validate the import",
    });
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)[0]?.cells[0]?.title).toBeUndefined();
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)[0]?.cells[0]?.status).toBeUndefined();
    expect(selectCanonicalTimelineSurface(state, mainScope)?.watermark).toBe(0);

    state = canonicalTimelineReducer(state, {
      type: "optimistic.state-changed",
      scope: mainScope,
      clientRequestId: "request-1",
      state: "uncertain",
      failure: "暂时无法确认是否已经发送。",
    });
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)[0]?.cells[0]).toMatchObject({
      id: "pending-user:request-1",
      title: "发送状态待确认",
      status: "uncertain",
      detailText: "暂时无法确认是否已经发送。",
      isError: false,
    });

    state = canonicalTimelineReducer(state, {
      type: "optimistic.state-changed",
      scope: mainScope,
      clientRequestId: "request-1",
      state: "failed",
      failure: "消息未发送。",
    });
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)[0]?.cells[0]).toMatchObject({
      id: "pending-user:request-1",
      title: "发送失败",
      status: "failed",
      detailText: "消息未发送。",
      isError: true,
      pendingIntent: { clientRequestId: "request-1", canRetry: true, canRestore: true },
    });

    state = canonicalTimelineReducer(state, {
      type: "optimistic.actions-consumed",
      scope: mainScope,
      clientRequestId: "request-1",
    });
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)[0]?.cells[0]?.pendingIntent).toEqual({
      clientRequestId: "request-1",
      canRetry: false,
      canRestore: false,
    });
  });

  it("reconciles a canonical user envelope by request id while preserving the visible cell identity", () => {
    let state = canonicalTimelineReducer(createCanonicalTimelineState(), {
      type: "optimistic.received",
      scope: mainScope,
      envelope: optimisticUserEnvelope("request-1", "same visible message"),
    });
    state = receive(state, {
      ...envelope("canonical-user", 10, 4),
      clientRequestId: "request-1",
      cells: [{
        id: "canonical-cell",
        kind: "user-message",
        source: "user",
        text: "same visible message",
      }],
    });

    const envelopes = selectCanonicalTimelineEnvelopes(state, mainScope);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ messageId: "canonical-user", clientRequestId: "request-1", revision: 4 });
    expect(envelopes[0]?.cells[0]).toMatchObject({ id: "pending-user:request-1", text: "same visible message" });
    expect(state.lastMutation).toMatchObject({
      kind: "append-tail",
      addedMessageIds: [],
      updatedMessageIds: ["canonical-user"],
      removedMessageIds: ["optimistic:request-1"],
    });
  });

  it("keeps unrelated optimistic intents during latest-page calibration and removes the correlated one", () => {
    let state = canonicalTimelineReducer(createCanonicalTimelineState(), {
      type: "optimistic.received",
      scope: mainScope,
      envelope: optimisticUserEnvelope("request-1", "accepted"),
    });
    state = canonicalTimelineReducer(state, {
      type: "optimistic.received",
      scope: mainScope,
      envelope: optimisticUserEnvelope("request-2", "still pending"),
    });
    const canonical = {
      ...envelope("canonical-user", 10, 3),
      clientRequestId: "request-1",
      cells: [{ id: "canonical-cell", kind: "user-message" as const, source: "user" as const, text: "accepted" }],
    };
    state = loadPage(state, "latest", page(3, [canonical]));

    const envelopes = selectCanonicalTimelineEnvelopes(state, mainScope);
    expect(envelopes.map((item) => item.messageId)).toEqual(["canonical-user", "optimistic:request-2"]);
    expect(envelopes[0]?.cells[0]?.id).toBe("pending-user:request-1");
    expect(envelopes[1]?.cells[0]).toMatchObject({ text: "still pending" });
    expect(envelopes[1]?.cells[0]?.status).toBeUndefined();
  });

  it("rekeys only the exact pending Conversation scope and preserves mode isolation", () => {
    const pendingScope = { ...mainScope, conversationId: "pending:request-1" };
    const targetScope = { ...mainScope, conversationId: "conversation-created" };
    const otherModeScope = { ...pendingScope, productMode: "agent" as const };
    let state = canonicalTimelineReducer(createCanonicalTimelineState(), {
      type: "optimistic.received",
      scope: pendingScope,
      envelope: optimisticUserEnvelope("request-1", "harness pending", pendingScope),
    });
    state = canonicalTimelineReducer(state, {
      type: "optimistic.received",
      scope: otherModeScope,
      envelope: optimisticUserEnvelope("request-1", "agent pending", otherModeScope),
    });
    state = canonicalTimelineReducer(state, {
      type: "optimistic.rekeyed",
      from: pendingScope,
      to: targetScope,
      clientRequestId: "request-1",
    });

    expect(selectCanonicalTimelineEnvelopes(state, pendingScope)).toEqual([]);
    expect(texts(state, targetScope)).toEqual(["harness pending"]);
    expect(texts(state, otherModeScope)).toEqual(["agent pending"]);
    expect(selectCanonicalTimelineEnvelopes(state, targetScope)[0]).toMatchObject({
      conversationId: "conversation-created",
      clientRequestId: "request-1",
    });
  });

  it("rekeys across a registered project identity without moving a different request or surface", () => {
    const pendingScope = { ...mainScope, conversationId: "pending:request-1" };
    const targetScope = { ...pendingScope, projectId: "project-registered", conversationId: "conversation-created" };
    const childScope = { ...pendingScope, agentSurfaceId: "agent:child" };
    let state = canonicalTimelineReducer(createCanonicalTimelineState(), {
      type: "optimistic.received",
      scope: pendingScope,
      envelope: optimisticUserEnvelope("request-1", "move exactly this", pendingScope),
    });
    state = canonicalTimelineReducer(state, {
      type: "optimistic.received",
      scope: pendingScope,
      envelope: optimisticUserEnvelope("request-2", "stay pending", pendingScope),
    });
    state = canonicalTimelineReducer(state, {
      type: "optimistic.received",
      scope: childScope,
      envelope: optimisticUserEnvelope("request-1", "stay on child", childScope),
    });
    state = canonicalTimelineReducer(state, {
      type: "optimistic.rekeyed",
      from: pendingScope,
      to: targetScope,
      clientRequestId: "unknown-request",
    });
    expect(texts(state, targetScope)).toEqual([]);

    state = canonicalTimelineReducer(state, {
      type: "optimistic.rekeyed",
      from: pendingScope,
      to: targetScope,
      clientRequestId: "request-1",
    });
    expect(texts(state, targetScope)).toEqual(["move exactly this"]);
    expect(texts(state, pendingScope)).toEqual(["stay pending"]);
    expect(texts(state, childScope)).toEqual(["stay on child"]);
  });

  it("orders out-of-order delivery by canonical order and rejects stale revisions", () => {
    let state = createCanonicalTimelineState();
    state = receive(state, envelope("third", 30, 3));
    state = receive(state, envelope("first", 10, 1));
    state = receive(state, envelope("second", 20, 2));
    state = receive(state, envelope("second", 20, 5));
    state = receive(state, envelope("second", 20, 4));

    expect(texts(state)).toEqual(["first@1", "second@5", "third@3"]);
    expect(state.lastMutation).toMatchObject({ kind: "none", ignored: "stale" });
  });

  it("is idempotent for duplicate delivery and rejects changed order identity", () => {
    let state = receive(createCanonicalTimelineState(), envelope("message", 10, 1));
    state = receive(state, envelope("message", 10, 1));
    expect(texts(state)).toEqual(["message@1"]);
    expect(state.lastMutation).toMatchObject({ ignored: "duplicate" });

    state = receive(state, envelope("message", 99, 2));
    expect(texts(state)).toEqual(["message@1"]);
    expect(state.lastMutation).toMatchObject({ ignored: "identity-conflict" });
  });

  it("is idempotent when the same latest page is requested again", () => {
    const latest = page(2, [envelope("message", 10, 2)]);
    let state = loadPage(createCanonicalTimelineState(), "latest", latest);
    state = loadPage(state, "latest", latest);

    expect(texts(state)).toEqual(["message@2"]);
    expect(state.lastMutation).toMatchObject({ kind: "none", ignored: "duplicate" });
  });

  it("classifies an initial latest window as a tail append for pinned viewport placement", () => {
    const state = loadPage(createCanonicalTimelineState(), "latest", page(2, [envelope("message", 10, 2)]));
    expect(selectCanonicalTimelineSurface(state, mainScope)?.lastMutation.kind).toBe("append-tail");
  });

  it("keeps one message through 100 updates", () => {
    let state = createCanonicalTimelineState();
    for (let revision = 1; revision <= 100; revision += 1) {
      state = receive(state, envelope("stable", 10, revision));
    }

    expect(texts(state)).toEqual(["stable@100"]);
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)).toHaveLength(1);
    expect(selectCanonicalTimelineSurface(state, mainScope)?.watermark).toBe(100);
    expect(state.lastMutation).toMatchObject({ kind: "replace-tail-growth", updatedMessageIds: ["stable"] });
  });

  it("rejects stale latest calibration while preserving history and realtime state", () => {
    let state = loadPage(createCanonicalTimelineState(), "latest", page(10, [
      envelope("latest-1", 30, 8),
      envelope("latest-2", 40, 10),
    ], { hasMoreBefore: true, nextBeforeCursor: "before-30" }));
    state = loadPage(state, "before", page(10, [
      envelope("history-1", 10, 2),
      envelope("history-2", 20, 4),
    ], { hasMoreBefore: false }));
    state = receive(state, envelope("live", 50, 12));
    state = loadPage(state, "latest", page(11, [envelope("latest-2", 40, 10)], {
      hasMoreBefore: true,
      nextBeforeCursor: "stale-cursor",
    }));

    expect(texts(state)).toEqual(["history-1@2", "history-2@4", "latest-1@8", "latest-2@10", "live@12"]);
    expect(selectCanonicalTimelineTranscript(state, mainScope).paging).toMatchObject({ hasMoreBefore: false });
    expect(state.lastMutation).toMatchObject({ kind: "none", ignored: "stale" });
  });

  it("uses a stale latest response to fill missing history without overwriting newer realtime state", () => {
    let state = receive(createCanonicalTimelineState(), envelope("live", 30, 5));
    state = loadPage(state, "latest", page(4, [
      envelope("history", 10, 1),
      envelope("live", 30, 4),
    ], { hasMoreBefore: true, nextBeforeCursor: "before-10" }));

    expect(texts(state)).toEqual(["history@1", "live@5"]);
    expect(selectCanonicalTimelineSurface(state, mainScope)?.watermark).toBe(5);
    expect(state.lastMutation).toMatchObject({
      kind: "calibrate",
      ignored: "stale",
      addedMessageIds: ["history"],
    });
  });

  it("uses a stale latest response to reconcile a correlated optimistic user row", () => {
    let state = canonicalTimelineReducer(createCanonicalTimelineState(), {
      type: "optimistic.received",
      scope: mainScope,
      envelope: optimisticUserEnvelope("request-stale", "accepted after realtime"),
    });
    state = receive(state, envelope("live", 30, 5));
    const canonical = {
      ...envelope("canonical-user", 10, 4),
      clientRequestId: "request-stale",
      cells: [{ id: "canonical-cell", kind: "user-message" as const, source: "user" as const, text: "accepted after realtime" }],
    };
    state = loadPage(state, "latest", page(4, [canonical]));

    const envelopes = selectCanonicalTimelineEnvelopes(state, mainScope);
    expect(envelopes.map((item) => item.messageId)).toEqual(["canonical-user", "live"]);
    expect(envelopes[0]?.cells[0]?.id).toBe("pending-user:request-stale");
    expect(state.lastMutation).toMatchObject({
      kind: "calibrate",
      ignored: "stale",
      updatedMessageIds: ["canonical-user"],
      removedMessageIds: ["optimistic:request-stale"],
    });
  });

  it("calibrates a fresh latest page without discarding loaded earlier pages", () => {
    let state = loadPage(createCanonicalTimelineState(), "latest", page(10, [
      envelope("old-latest", 30, 8),
      envelope("latest", 40, 10),
    ], { hasMoreBefore: true }));
    state = loadPage(state, "before", page(10, [envelope("history", 20, 4)], { hasMoreBefore: false }));
    state = loadPage(state, "latest", page(15, [
      envelope("latest", 40, 14),
      envelope("new-latest", 50, 15),
    ]));

    expect(texts(state)).toEqual(["history@4", "latest@14", "new-latest@15"]);
    expect(state.lastMutation).toMatchObject({
      kind: "calibrate",
      addedMessageIds: ["new-latest"],
      updatedMessageIds: ["latest"],
      removedMessageIds: ["old-latest"],
    });
  });

  it("prepends history then appends realtime with deterministic paging metadata", () => {
    let state = loadPage(createCanonicalTimelineState(), "latest", page(5, [
      envelope("m3", 30, 3),
      envelope("m4", 40, 5),
    ], { hasMoreBefore: true, nextBeforeCursor: "before-30", totalCount: 4 }));
    state = loadPage(state, "before", page(5, [
      envelope("m1", 10, 1),
      envelope("m2", 20, 2),
    ], { hasMoreBefore: false, totalCount: 4 }));
    state = receive(state, envelope("m5", 50, 6));

    const transcript = selectCanonicalTimelineTranscript(state, mainScope);
    expect(transcript.cells?.map((cell) => cell.text)).toEqual(["m1@1", "m2@2", "m3@3", "m4@5", "m5@6"]);
    expect(transcript.items).toHaveLength(5);
    expect(transcript.paging).toMatchObject({ hasMoreBefore: false, totalCount: 5 });
    expect(state.lastMutation).toMatchObject({ kind: "append-tail", addedMessageIds: ["m5"] });
  });

  it("isolates project, conversation, and exact surface scopes without aliases", () => {
    const childScope = { ...mainScope, agentSurfaceId: "agent:codex:thread-child" };
    const otherConversation = { ...mainScope, conversationId: "conversation-b" };
    const otherProject = { ...mainScope, projectId: "project-b" };
    const otherMode = { ...mainScope, productMode: "agent" as const };
    let state = receive(createCanonicalTimelineState(), envelope("main", 10, 1));
    state = receive(state, envelope("child", 10, 2, childScope), childScope.projectId);
    state = receive(state, envelope("conversation", 10, 3, otherConversation), otherConversation.projectId);
    state = receive(state, envelope("project", 10, 4, otherProject), otherProject.projectId);
    state = receive(state, envelope("mode", 10, 5, otherMode), otherMode.projectId);

    expect(texts(state, mainScope)).toEqual(["main@1"]);
    expect(texts(state, childScope)).toEqual(["child@2"]);
    expect(texts(state, otherConversation)).toEqual(["conversation@3"]);
    expect(texts(state, otherProject)).toEqual(["project@4"]);
    expect(texts(state, otherMode)).toEqual(["mode@5"]);
    expect(Object.keys(state.surfaces)).toHaveLength(5);
    expect(canonicalTimelineScopeKey(mainScope)).toBe(JSON.stringify(["project-a", "harness", "conversation-a", "main-agent"]));
  });

  it("places an explicit thread-start envelope before ordinary child entries", () => {
    const childScope = { ...mainScope, agentSurfaceId: "agent:codex:thread-child" };
    let state = receive(createCanonicalTimelineState(), envelope("assistant", 100, 12, childScope), childScope.projectId);
    state = receive(state, {
      ...envelope("thread-start", 200, 13, childScope),
      orderClass: "thread-start",
      cells: [{
        id: "cell:thread-start",
        kind: "user-message",
        source: "provider-runtime",
        initialThreadInput: true,
        text: "delegated input",
      }],
    }, childScope.projectId);

    expect(texts(state, childScope)).toEqual(["delegated input", "assistant@12"]);
    expect(state.lastMutation?.kind).toBe("prepend");
  });

  it("treats empty cells as a canonical replacement", () => {
    let state = receive(createCanonicalTimelineState(), envelope("message", 10, 1));
    state = receive(state, { ...envelope("message", 10, 2), cells: [] });

    expect(texts(state)).toEqual([]);
    expect(selectCanonicalTimelineEnvelopes(state, mainScope)[0]?.cells).toEqual([]);
    expect(state.lastMutation).toMatchObject({ kind: "calibrate", updatedMessageIds: ["message"] });
  });

  it("replaces pinned entries only during a fresh latest calibration", () => {
    let state = loadPage(createCanonicalTimelineState(), "latest", page(3, [envelope("body", 20, 3)], {}, [
      envelope("start", 100, 1, mainScope, "thread-start"),
    ]));
    expect(texts(state)).toEqual(["start@1", "body@3"]);

    state = loadPage(state, "latest", page(4, [envelope("body", 20, 3)], {}, []));
    expect(texts(state)).toEqual(["body@3"]);
    expect(state.lastMutation).toMatchObject({ kind: "calibrate", removedMessageIds: ["start"] });
  });

  it("fences request generations independently", () => {
    const first = beginCanonicalTimelineRequest(createCanonicalTimelineState(), mainScope, "latest");
    const second = beginCanonicalTimelineRequest(first.state, mainScope, "latest");
    let state = canonicalTimelineReducer(second.state, {
      type: "page.received",
      scope: mainScope,
      requestKind: "latest",
      generation: first.generation,
      page: page(1, [envelope("stale", 10, 1)]),
    });
    expect(texts(state)).toEqual([]);
    expect(state.lastMutation).toMatchObject({ ignored: "request-generation" });

    state = canonicalTimelineReducer(state, {
      type: "page.received",
      scope: mainScope,
      requestKind: "latest",
      generation: second.generation,
      page: page(2, [envelope("fresh", 20, 2)]),
    });
    const before = beginCanonicalTimelineRequest(state, mainScope, "before");
    expect(texts(before.state)).toEqual(["fresh@2"]);
    expect(before.generation).toBe(1);
    expect(selectCanonicalTimelineSurface(before.state, mainScope)?.requests.latest.generation).toBe(2);
  });

  it("cleans exact scopes, conversations, projects, and the Store", () => {
    const childScope = { ...mainScope, agentSurfaceId: "child" };
    const otherProject = { ...mainScope, projectId: "project-b" };
    let state = receive(createCanonicalTimelineState(), envelope("main", 10, 1));
    state = receive(state, envelope("child", 20, 2, childScope), childScope.projectId);
    state = receive(state, envelope("other", 30, 3, otherProject), otherProject.projectId);

    state = canonicalTimelineReducer(state, { type: "scope.cleaned", scope: childScope });
    expect(Object.keys(state.surfaces)).toHaveLength(2);
    state = canonicalTimelineReducer(state, {
      type: "conversation.cleaned",
      projectId: mainScope.projectId,
      conversationId: mainScope.conversationId,
    });
    expect(Object.keys(state.surfaces)).toHaveLength(1);
    state = canonicalTimelineReducer(state, { type: "project.cleaned", projectId: otherProject.projectId });
    expect(Object.keys(state.surfaces)).toHaveLength(0);
    expect(state.lastMutation?.kind).toBe("reset");
    expect(canonicalTimelineReducer(state, { type: "store.cleaned" })).toBe(state);
  });
});

function envelope(
  messageId: string,
  position: number,
  revision: number,
  scope: CanonicalTimelineScope = mainScope,
  orderClass: CanonicalTimelineEnvelope["orderClass"] = "sequence",
): CanonicalTimelineEnvelope {
  return {
    projectId: scope.projectId,
    productMode: scope.productMode,
    conversationId: scope.conversationId,
    agentSurfaceId: scope.agentSurfaceId,
    messageId,
    position,
    revision,
    orderClass,
    cells: [{
      id: `cell:${messageId}:${revision}`,
      kind: "assistant-message",
      source: "provider-runtime",
      text: `${messageId}@${revision}`,
    }],
  };
}

function optimisticUserEnvelope(
  clientRequestId: string,
  text: string,
  scope: CanonicalTimelineScope = mainScope,
): CanonicalTimelineEnvelope {
  return {
    ...scope,
    messageId: `optimistic:${clientRequestId}`,
    clientRequestId,
    position: Number.MAX_SAFE_INTEGER,
    revision: 1,
    orderClass: "sequence",
    cells: [{
      id: `pending-user:${clientRequestId}`,
      kind: "user-message",
      source: "user",
      text,
      realtime: true,
    }],
  };
}

function page(
  watermark: number,
  entries: CanonicalTimelineEnvelope[],
  paging: Partial<CanonicalTimelinePage["paging"]> = {},
  pinned: CanonicalTimelineEnvelope[] = [],
): CanonicalTimelinePage {
  return {
    projectId: mainScope.projectId,
    productMode: mainScope.productMode,
    conversationId: mainScope.conversationId,
    agentSurfaceId: mainScope.agentSurfaceId,
    watermark,
    pinned,
    entries,
    paging: {
      limit: paging.limit ?? 100,
      totalCount: paging.totalCount ?? entries.length + pinned.length,
      hasMoreBefore: paging.hasMoreBefore ?? false,
      nextBeforeCursor: paging.nextBeforeCursor,
    },
  };
}

function receive(
  state: CanonicalTimelineState,
  value: CanonicalTimelineEnvelope,
  projectId = mainScope.projectId,
): CanonicalTimelineState {
  return canonicalTimelineReducer(state, { type: "envelope.received", projectId, envelope: value });
}

function loadPage(
  state: CanonicalTimelineState,
  requestKind: CanonicalTimelineRequestKind,
  value: CanonicalTimelinePage,
  scope: CanonicalTimelineScope = mainScope,
): CanonicalTimelineState {
  const request = beginCanonicalTimelineRequest(state, scope, requestKind);
  return canonicalTimelineReducer(request.state, {
    type: "page.received",
    scope,
    requestKind,
    generation: request.generation,
    page: value,
  });
}

function texts(state: CanonicalTimelineState, scope: CanonicalTimelineScope = mainScope): string[] {
  return selectCanonicalTimelineTranscript(state, scope).cells?.map((cell) => cell.text) ?? [];
}
