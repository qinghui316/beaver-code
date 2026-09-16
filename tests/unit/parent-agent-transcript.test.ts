import { describe, expect, it } from "vitest";
import { canonicalTranscriptCellsFromThreadItem } from "../../src/workbench/parent-agent-transcript.js";

type ThreadItem = Parameters<typeof canonicalTranscriptCellsFromThreadItem>[0];

function renderThreadItems(threadItems: ThreadItem[]) {
  return threadItems.flatMap((item) => canonicalTranscriptCellsFromThreadItem(item));
}

function providerBlockIdentity(itemId: string, identity: { attemptId?: string; threadId?: string; turnId?: string } = {}) {
  return {
    providerId: "codex" as const,
    attemptId: identity.attemptId ?? "attempt-1",
    threadId: identity.threadId ?? "thread-main",
    turnId: identity.turnId ?? "turn-1",
    itemId,
  };
}

describe("canonical parent agent transcript cells", () => {
  it("projects one canonical Plan document reference into the timeline", () => {
    const cells = renderThreadItems([{
      id: "assistant-plan-ready",
      kind: "assistant-turn",
      label: "AI",
      blocks: [
        {
          id: "internal-status",
          sequence: 1,
          kind: "tool-result" as const,
          source: "aho" as const,
          title: "内部状态",
          text: "This must remain diagnostic-only.",
        },
        {
          id: "document-reference:plan-document-1",
          runId: "run-plan",
          sequence: 2,
          kind: "tool-result" as const,
          source: "aho" as const,
          title: "实现计划",
          text: "实现计划",
          documentRef: {
            documentId: "plan-document-1",
            documentKind: "plan",
            title: "实现计划",
            sourceMessageId: "assistant-plan-source",
            sourceCanonicalItemId: "prose:codex:attempt:thread:turn:item",
            proposalHash: "proposal-hash",
          },
        },
      ],
    }]);

    expect(cells).toEqual([
      expect.objectContaining({
        id: "cell:document:plan-document-1",
        kind: "document-preview",
        source: "aho-orchestration",
        title: "实现计划",
        documentRef: expect.objectContaining({ documentId: "plan-document-1" }),
      }),
    ]);
  });

  it("persists one completed turn boundary and a collapsed provider-visible reasoning summary", () => {
    const cells = renderThreadItems([{
      id: "assistant-1",
      kind: "assistant-turn",
      label: "AI",
      source: "chat",
      timestamp: "2026-07-14T00:00:24.000Z",
      providerId: "codex",
      attemptId: "attempt-turn-1",
      runId: "run-1",
      threadId: "thread-1",
      turnId: "turn-1",
      activity: [
        { kind: "status", label: "started", timestamp: "2026-07-14T00:00:00.000Z" },
        { kind: "status", label: "connecting", timestamp: "2026-07-14T00:00:01.000Z" },
        { kind: "status", label: "thinking", timestamp: "2026-07-14T00:00:03.000Z" },
        { kind: "status", label: "completed", timestamp: "2026-07-14T00:00:24.000Z" },
      ],
      blocks: [{
        id: "reasoning-1",
        ...providerBlockIdentity("reasoning-1", { attemptId: "attempt-turn-1", threadId: "thread-1" }),
        runId: "run-1",
        sequence: 1,
        kind: "reasoning-summary",
        timestamp: "2026-07-14T00:00:03.000Z",
        source: "provider",
        text: "Checked the implementation boundary.",
      }],
    }]);

    expect(cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cell:turn:codex:attempt-turn-1:thread-1:turn-1", kind: "process-row", title: "已完成 · 21 秒", status: "completed" }),
      expect.objectContaining({ kind: "process-row", title: "思考摘要", text: "", detailText: "Checked the implementation boundary." }),
    ]));
    expect(cells[0]?.id).toBe("cell:reasoning:codex:attempt-turn-1:thread-1:turn-1:reasoning-1");
    expect(cells.at(-1)?.id).toBe("cell:turn:codex:attempt-turn-1:thread-1:turn-1");
  });

  it("keeps one visible realtime Turn row while thinking and replying, then terminalizes the same identity", () => {
    const base = {
      id: "assistant-live",
      kind: "assistant-turn",
      label: "AI",
      source: "chat",
      providerId: "codex",
      attemptId: "attempt-live",
      threadId: "thread-live",
      turnId: "turn-live",
    } satisfies ThreadItem;
    const thinking = renderThreadItems([{
      ...base,
      activity: [
        { kind: "status", label: "thinking", timestamp: "2026-09-08T01:00:00.000Z" },
      ],
    }]);
    const replying = renderThreadItems([{
      ...base,
      activity: [
        { kind: "status", label: "thinking", timestamp: "2026-09-08T01:00:00.000Z" },
        { kind: "status", label: "replying", timestamp: "2026-09-08T01:00:03.000Z" },
      ],
    }]);
    const completed = renderThreadItems([{
      ...base,
      activity: [
        { kind: "status", label: "thinking", timestamp: "2026-09-08T01:00:00.000Z" },
        { kind: "status", label: "replying", timestamp: "2026-09-08T01:00:03.000Z" },
        { kind: "status", label: "completed", timestamp: "2026-09-08T01:00:08.000Z" },
      ],
    }]);

    expect(thinking).toEqual([expect.objectContaining({
      id: "cell:turn:codex:attempt-live:thread-live:turn-live",
      title: "正在思考",
      text: "",
      timestamp: "2026-09-08T01:00:00.000Z",
      realtime: true,
      activityKind: "turn",
    })]);
    expect(replying).toEqual([expect.objectContaining({
      id: thinking[0]?.id,
      title: "正在回复",
      text: "",
      realtime: true,
      activityKind: "turn",
    })]);
    expect(completed).toEqual([expect.objectContaining({
      id: thinking[0]?.id,
      title: "已完成 · 8 秒",
      activityKind: "turn",
    })]);
    expect(completed[0]).not.toHaveProperty("realtime");
  });

  it("marks public prose and reasoning summaries realtime only while their canonical Turn is active", () => {
    const item = {
      id: "assistant-streaming",
      kind: "assistant-turn",
      label: "AI",
      providerId: "codex",
      attemptId: "attempt-streaming",
      threadId: "thread-streaming",
      turnId: "turn-streaming",
      blocks: [
        { id: "summary", ...providerBlockIdentity("summary", { attemptId: "attempt-streaming", threadId: "thread-streaming", turnId: "turn-streaming" }), sequence: 1, kind: "reasoning-summary" as const, source: "provider" as const, text: "Public summary" },
        { id: "answer", ...providerBlockIdentity("answer", { attemptId: "attempt-streaming", threadId: "thread-streaming", turnId: "turn-streaming" }), sequence: 2, kind: "prose" as const, source: "provider" as const, text: "Visible answer" },
      ],
    } satisfies ThreadItem;
    const active = renderThreadItems([{ ...item, activity: [{ kind: "status", label: "thinking", timestamp: "2026-09-16T00:00:00.000Z" }, { kind: "status", label: "replying", timestamp: "2026-09-16T00:00:01.000Z" }] }]);
    const terminal = renderThreadItems([{ ...item, status: "completed", activity: [{ kind: "status", label: "thinking", timestamp: "2026-09-16T00:00:00.000Z" }, { kind: "status", label: "completed", timestamp: "2026-09-16T00:00:02.000Z" }] }]);

    expect(active.filter((cell) => ["reasoning", "status"].includes(cell.activityKind ?? ""))).toEqual(expect.arrayContaining([
      expect.objectContaining({ activityKind: "reasoning", realtime: true }),
      expect.objectContaining({ activityKind: "status", realtime: true }),
    ]));
    expect(terminal.filter((cell) => ["reasoning", "status"].includes(cell.activityKind ?? "")).every((cell) => cell.realtime === undefined)).toBe(true);
  });

  it("does not preserve unrelated empty process rows", () => {
    const cells = renderThreadItems([{
      id: "assistant-empty",
      kind: "assistant-turn",
      label: "AI",
      blocks: [{
        id: "empty-reasoning",
        ...providerBlockIdentity("empty-reasoning"),
        sequence: 1,
        kind: "reasoning-summary",
        source: "provider",
        text: "",
      }],
    }]);

    expect(cells).toEqual([]);
  });

  it("uses the canonical failed turn status when legacy activity ends with completed", () => {
    const cells = renderThreadItems([{
      id: "assistant-failed",
      kind: "assistant-turn",
      label: "AI",
      source: "chat",
      timestamp: "2026-07-14T00:00:24.000Z",
      providerId: "codex",
      attemptId: "attempt-failed",
      runId: "run-failed",
      threadId: "thread-failed",
      turnId: "turn-failed",
      status: "failed",
      activity: [
        { kind: "status", label: "thinking", timestamp: "2026-07-14T00:00:00.000Z" },
        { kind: "status", label: "failed", timestamp: "2026-07-14T00:00:20.000Z" },
        { kind: "status", label: "completed", timestamp: "2026-07-14T00:00:24.000Z" },
      ],
    }]);

    expect(cells).toEqual([expect.objectContaining({
      title: "本轮需要处理 · 24 秒",
      status: "failed",
      isError: true,
    })]);
  });

  it("projects an explicit stale-session recovery target on the failed Turn boundary", () => {
    const forkTarget = {
      sourceMessageId: "assistant-success-2",
      providerId: "codex",
      completedTurnSequence: 2,
      timelineRevision: 12,
      contextRevision: "",
      recovery: true as const,
    };
    const cells = renderThreadItems([{
      id: "assistant-stale",
      kind: "assistant-turn",
      label: "AI",
      source: "chat",
      providerId: "codex",
      attemptId: "attempt-stale",
      threadId: "thread-stale",
      turnId: "turn-stale",
      status: "failed",
      forkTarget,
      activity: [
        { kind: "status", label: "started", timestamp: "2026-08-27T00:00:00.000Z" },
        { kind: "status", label: "failed", timestamp: "2026-08-27T00:00:01.000Z" },
      ],
    }]);

    expect(cells).toEqual([expect.objectContaining({ status: "failed", forkTarget })]);
  });

  it("keeps Provider-private failure payloads out of the ordinary transcript", () => {
    const rawFailure = '{"threadId":"private-thread","turn":{"id":"private-turn","status":"failed","error":{"message":"429 Too Many Requests, request id: private-request"}}}';
    const cells = renderThreadItems([{
      id: "assistant-private-failure",
      kind: "assistant-turn",
      label: "AI",
      providerId: "codex",
      attemptId: "attempt-private",
      threadId: "thread-private",
      turnId: "turn-private",
      status: "failed",
      blocks: [{
        id: "private-error",
        ...providerBlockIdentity("private-error", { attemptId: "attempt-private", threadId: "thread-private", turnId: "turn-private" }),
        sequence: 1,
        kind: "error",
        source: "provider",
        title: "运行出错",
        text: rawFailure,
        isError: true,
      }],
    }]);

    expect(cells).toEqual([expect.objectContaining({
      title: "运行出错",
      text: "当前 Agent 未能完成本轮，请稍后重试。",
      isError: true,
    })]);
    expect(JSON.stringify(cells)).not.toContain("private-thread");
    expect(JSON.stringify(cells)).not.toContain("private-request");
  });

  it("projects a provider child lifecycle as one navigable canonical process row", () => {
    const cells = renderThreadItems([{
      id: "assistant-child-lifecycle",
      kind: "assistant-turn",
      label: "AI",
      providerId: "codex",
      attemptId: "attempt-1",
      runId: "run-1",
      threadId: "thread-main",
      turnId: "turn-main",
      blocks: [{
        id: "assistant:codex:run-1:thread-main:spawn-1:tool-result",
        providerId: "codex",
        attemptId: "attempt-1",
        runId: "run-1",
        threadId: "thread-main",
        turnId: "turn-main",
        itemId: "spawn-1",
        sequence: 1,
        kind: "tool-result",
        timestamp: "2026-07-16T00:00:00.000Z",
        source: "provider",
        status: "processing",
        title: "Plan Agent · Sagan",
        targetAgentSurfaceId: "agent:codex:thread:thread-child",
        targetAgentDisplayName: "Plan Agent · Sagan",
      }],
    }]);

    expect(cells).toEqual([expect.objectContaining({
      id: "cell:tool-result:codex:attempt-1:thread-main:turn-main:spawn-1",
      title: "Plan Agent · Sagan 正在规划",
      activityKind: "agent",
      status: "processing",
      targetAgentSurfaceId: "agent:codex:thread:thread-child",
    })]);
  });

  it("keeps identical visible content from distinct canonical message items", () => {
    const threadItems: ThreadItem[] = ["message-1", "message-2"].map((itemId) => ({
      id: `assistant-${itemId}`,
      kind: "assistant-turn",
      label: "AI",
      blocks: [{
        id: itemId,
        ...providerBlockIdentity(itemId),
        sequence: 1,
        kind: "prose" as const,
        source: "provider" as const,
        text: "Same visible reply",
      }],
    }));

    const cells = renderThreadItems(threadItems);
    expect(cells.map((cell) => cell.id)).toEqual([
      "cell:assistant:codex:attempt-1:thread-main:turn-1:message-1",
      "cell:assistant:codex:attempt-1:thread-main:turn-1:message-2",
    ]);
    expect(cells.map((cell) => cell.text)).toEqual(["Same visible reply", "Same visible reply"]);
  });

  it("preserves technical terms in canonical Agent messages", () => {
    const text = "planning_agent runs `npm test` in C:\\repo and reports ProviderAttempt unchanged.";
    const cells = renderThreadItems([{
      id: "assistant-technical-message",
      kind: "assistant-turn",
      label: "AI",
      blocks: [{
        id: "technical-message",
        ...providerBlockIdentity("technical-message"),
        sequence: 1,
        kind: "prose",
        source: "provider",
        text,
      }],
    }]);
    expect(cells[0]?.text).toBe(text);
  });

  it("preserves canonical user and Agent message whitespace without presentation rewriting", () => {
    const userText = "\n  用户保留的首行\n\n最后一行  \n";
    const agentText = "\n  ProviderAttempt 与 `npm test` 保持原样。\n\n结束  \n";
    const userCells = renderThreadItems([{
      id: "user-whitespace",
      kind: "user-message",
      label: "用户消息",
      body: userText,
    }]);
    const agentCells = renderThreadItems([{
      id: "assistant-whitespace",
      kind: "assistant-turn",
      label: "AI",
      blocks: [{
        id: "assistant-whitespace-block",
        ...providerBlockIdentity("assistant-whitespace-block"),
        sequence: 1,
        kind: "prose",
        source: "provider",
        text: agentText,
      }],
    }]);

    expect(userCells[0]?.text).toBe(userText);
    expect(agentCells[0]?.text).toBe(agentText);
  });

  it("keeps canonical cell identity stable across repeated rendering", () => {
    const threadItems: ThreadItem[] = [{
      id: "assistant-refresh",
      kind: "assistant-turn",
      label: "AI",
      blocks: [{
        id: "message-refresh",
        ...providerBlockIdentity("message-refresh", { attemptId: "attempt-refresh", turnId: "turn-refresh" }),
        sequence: 1,
        kind: "prose",
        source: "provider",
        text: "Stable reply",
      }],
    }];

    expect(renderThreadItems(threadItems).map((cell) => cell.id))
      .toEqual(renderThreadItems(threadItems).map((cell) => cell.id));
  });

  it("fails closed for provider-visible blocks without canonical identity", () => {
    const cells = renderThreadItems([{
      id: "assistant-missing-identity",
      kind: "assistant-turn",
      label: "AI",
      blocks: [{ id: "message", sequence: 1, kind: "prose", source: "provider", text: "Do not infer me" }],
    }]);

    expect(cells).toEqual([]);
  });

  it("preserves provider-visible planning sections in prose", () => {
    const cells = renderThreadItems([{
      id: "main-leak",
      kind: "assistant-turn",
      label: "AI",
      blocks: [{
        id: "main-leak-block",
        ...providerBlockIdentity("main-leak-block"),
        sequence: 1,
        kind: "prose",
        source: "provider",
        text: "我先确认需求，不会修改文件。\n\n## 目标\n做事\n\n## 验收标准\n- 通过",
      }],
    }]);

    expect(cells.map((cell) => cell.text)).toEqual(["我先确认需求，不会修改文件。\n\n## 目标\n做事\n\n## 验收标准\n- 通过"]);
  });

  it("preserves assistant delegation explanations in prose", () => {
    const cells = renderThreadItems([{
      id: "main-delegation-leak",
      kind: "assistant-turn",
      label: "AI",
      blocks: [{
        id: "main-delegation-leak-block",
        ...providerBlockIdentity("main-delegation-leak-block"),
        sequence: 1,
        kind: "prose",
        source: "provider",
        text: "我理解这次目标是完成验收，并保持当前回合只读。\n这条回复之后，我会把只读规划交给 planning-agent；当前不会修改文件。",
      }],
    }]);

    expect(cells.map((cell) => cell.text)).toEqual(["我理解这次目标是完成验收，并保持当前回合只读。\n这条回复之后，我会把只读规划交给 planning-agent；当前不会修改文件。"]);
  });

  it("keeps a native Agent question as one durable timeline item after submission", () => {
    const request = {
      providerId: "codex" as const,
      requestKey: "run-1:main:turn:item:request-1",
      requestId: "request-1",
      runId: "run-1",
      runtimeScopeId: "conv",
      attemptId: "run-1",
      conversationId: "conv",
      questions: [{
        id: "q1",
        question: "是否保留旧文件？",
        inputMode: "single" as const,
        allowCustom: false,
        options: [{ value: "discard", label: "不保留" }],
      }],
      status: "submitted" as const,
      publicAnswers: { q1: "不保留" },
      disposition: "answered" as const,
      submittedAt: "2026-07-15T00:00:05.000Z",
    };
    const cells = renderThreadItems([{
      id: "provider-user-input:run-1:main:turn:item:request-1",
      kind: "assistant-turn",
      label: "需要你回答",
      source: "chat",
      timestamp: "2026-07-15T00:00:00.000Z",
      providerUserInput: request,
    }]);

    expect(cells).toEqual([expect.objectContaining({
      id: "cell:provider-user-input:run-1:main:turn:item:request-1",
      kind: "user-input",
      status: "submitted",
      interactionHistory: {
        kind: "provider-input",
        status: "answered",
        questions: [{ questionId: "q1", title: "是否保留旧文件？" }],
        answers: { q1: "不保留" },
      },
    })]);
    expect(cells[0]).not.toHaveProperty("providerUserInput");
  });

  it("keeps repeated provider request ids distinct across durable turns", () => {
    const requests = ["turn-a", "turn-b"].map((turnId) => ({
      providerId: "codex" as const,
      requestKey: `run-${turnId}:main:${turnId}:item:1`,
      requestId: "1",
      runId: `run-${turnId}`,
      runtimeScopeId: "conv",
      attemptId: `run-${turnId}`,
      threadId: "main",
      turnId,
      conversationId: "conv",
      questions: [{
        id: "q1",
        question: `Question ${turnId}`,
        inputMode: "text" as const,
        allowCustom: true,
        options: [],
      }],
      status: "submitted" as const,
      disposition: "answered" as const,
      publicAnswers: { q1: `Answer ${turnId}` },
    }));
    const threadItems: ThreadItem[] = requests.map((request) => ({
      id: `provider-user-input:${request.requestKey}`,
      kind: "assistant-turn",
      label: "需要你回答",
      source: "chat",
      timestamp: "2026-07-15T00:00:00.000Z",
      providerUserInput: request,
    }));

    expect(renderThreadItems(threadItems).map((cell) => cell.id)).toEqual([
      `cell:provider-user-input:${requests[0].requestKey}`,
      `cell:provider-user-input:${requests[1].requestKey}`,
    ]);
  });

  it("keeps pending provider questions exclusively in the Interaction Dock projection", () => {
    const request = {
      providerId: "codex" as const,
      requestKey: "run-pending:main:turn:item:1",
      requestId: "1",
      runId: "run-pending",
      runtimeScopeId: "conv",
      attemptId: "run-pending",
      conversationId: "conv",
      questions: [{ id: "q1", question: "Pending question", inputMode: "text" as const, allowCustom: true, options: [] }],
      status: "pending" as const,
    };

    const cells = renderThreadItems([{
      id: `provider-user-input:${request.requestKey}`,
      kind: "assistant-turn",
      label: "需要你回答",
      source: "chat",
      timestamp: "2026-07-15T00:00:00.000Z",
      providerUserInput: request,
    }]);

    expect(cells).toEqual([]);
  });
});
