// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationContextController } from "../../src/web/src/controllers/useConversationContextController.js";
import { ConversationContextIndicator } from "../../src/web/src/shell/composer.js";
import type { ConversationContextSnapshot } from "../../src/web/src/types.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared conversation context UI", () => {
  it("renders compact usage details and lifecycle-specific icons from one shared component", () => {
    const onCompact = vi.fn();
    const { rerender } = render(<ConversationContextIndicator snapshot={snapshot()} submitting={false} onCompact={onCompact} />);
    expect(screen.getByRole("button", { name: "上下文已使用 10%" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "上下文已使用 10%" }));
    expect(screen.getByRole("dialog", { name: "会话上下文" })).toBeTruthy();
    expect(screen.getByText("20,000")).toBeTruthy();
    expect(screen.getByText("200,000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "压缩上下文" }));
    expect(onCompact).toHaveBeenCalledOnce();

    rerender(<ConversationContextIndicator snapshot={snapshot({ lifecycle: "interrupted", canCompact: true })} submitting={false} onCompact={onCompact} />);
    expect(screen.getByRole("button", { name: "上下文压缩已中断" })).toBeTruthy();
  });

  it("shows exact disabled reason without creating a mode-specific control", () => {
    render(<ConversationContextIndicator
      snapshot={snapshot({ canCompact: false, disabledReason: "当前回合运行中，结束后才能压缩上下文。" })}
      submitting={false}
      onCompact={() => undefined}
    />);
    fireEvent.click(screen.getByRole("button", { name: "上下文已使用 10%" }));
    expect(screen.getByText("当前回合运行中，结束后才能压缩上下文。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "压缩上下文" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("dismisses on outside pointer, focus and Escape while internal actions remain usable", () => {
    const outside = vi.fn(); const compact = vi.fn();
    render(<><ConversationContextIndicator snapshot={snapshot()} submitting={false} onCompact={compact} scopeKey="a" /><button onClick={outside}>outside</button></>);
    const trigger = screen.getByRole("button", { name: "上下文已使用 10%" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: "压缩上下文" }));
    expect(compact).toHaveBeenCalledOnce(); expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }), { pointerType: "touch" });
    fireEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(outside).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger); fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger); fireEvent.focusIn(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on scope and floating-panel changes, and refresh cannot reopen it", () => {
    const view = render(<ConversationContextIndicator snapshot={snapshot()} submitting={false} scopeKey="a" />);
    fireEvent.click(screen.getByRole("button", { name: "上下文已使用 10%" }));
    view.rerender(<ConversationContextIndicator snapshot={snapshot()} submitting={false} scopeKey="b" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "上下文已使用 10%" }));
    view.rerender(<ConversationContextIndicator snapshot={snapshot()} submitting={false} scopeKey="b" dismiss />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<ConversationContextIndicator snapshot={snapshot({ lifecycle: "completed" })} submitting={false} scopeKey="b" dismiss />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fences stale settlement after project and conversation selection changes", async () => {
    let resolveRequest!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const refreshConversation = vi.fn(async () => undefined);
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ projectId, conversationId, value }) => useConversationContextController({
        projectId,
        productMode: "agent",
        conversationId,
        snapshot: value,
        refreshConversation,
        onError,
      }),
      { initialProps: { projectId: "project-a", conversationId: "conversation-a", value: snapshot() } },
    );

    let compact!: Promise<void>;
    act(() => { compact = result.current.compact(); });
    expect(result.current.submitting).toBe(true);
    rerender({ projectId: "project-b", conversationId: "conversation-b", value: snapshot({ contextRevision: "revision-b" }) });
    expect(result.current.submitting).toBe(false);
    await act(async () => {
      resolveRequest(new Response(JSON.stringify({ status: "accepted" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await compact;
    });

    expect(refreshConversation).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/projects/project-a/workbench/conversations/conversation-a/context/compact",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("preserves the current selection and reports a current-scope rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("stale revision", { status: 409 })));
    const onError = vi.fn();
    const { result } = renderHook(() => useConversationContextController({
      projectId: "project-a",
      productMode: "harness",
      conversationId: "conversation-a",
      snapshot: snapshot(),
      refreshConversation: async () => undefined,
      onError,
    }));

    await act(async () => result.current.compact());
    expect(onError).toHaveBeenCalledWith("当前状态已经变化。刷新后再试一次。");
    expect(result.current.snapshot?.contextRevision).toBe("revision-a");
    expect(result.current.submitting).toBe(false);
  });
});

function snapshot(overrides: Partial<ConversationContextSnapshot> = {}): ConversationContextSnapshot {
  return {
    providerId: "codex",
    contextRevision: "revision-a",
    usage: {
      total: breakdown(190_000, 170_000, 10_000),
      last: breakdown(20_000, 15_000, 5_000),
      contextUsedTokens: 20_000,
      modelContextWindow: 200_000,
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
    usedPercent: 10,
    remainingPercent: 90,
    lifecycle: "idle",
    source: null,
    lastCompactedAt: null,
    canCompact: true,
    ...overrides,
  };
}

function breakdown(totalTokens: number, inputTokens: number, cachedInputTokens: number) {
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens: 3, reasoningOutputTokens: 1 };
}
