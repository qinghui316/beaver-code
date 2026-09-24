// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainConversationView } from "../../src/web/src/panels/workbench/ConversationPanel.js";
import { TranscriptActivityRow } from "../../src/web/src/panels/workbench/TranscriptReadingSurface.js";
import type { ParentAgentTranscript, ParentAgentTranscriptCell } from "../../src/web/src/types.js";

type ResizeCallback = ResizeObserverCallback;

class ControlledResizeObserver implements ResizeObserver {
  static callbacks: ResizeCallback[] = [];

  constructor(callback: ResizeCallback) {
    ControlledResizeObserver.callbacks.push(callback);
  }

  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

beforeEach(() => {
  ControlledResizeObserver.callbacks = [];
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("main conversation virtualization", () => {
  it("announces a realtime Turn phase once without announcing the changing timer", () => {
    const { container } = render(
      <TranscriptActivityRow
        cell={{
          id: "turn-live",
          kind: "process-row",
          source: "provider-runtime",
          activityKind: "turn",
          title: "正在思考",
          text: "",
          realtime: true,
          timestamp: new Date().toISOString(),
          status: "thinking",
        }}
        expanded={false}
        onToggleExpanded={() => {}}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("正在思考");
    const visualTitle = container.querySelector(".transcript-activity-title");
    expect(visualTitle?.getAttribute("aria-hidden")).toBe("true");
    expect(visualTitle?.textContent).toMatch(/^正在思考 · \d+ 秒$/);
    expect(visualTitle?.classList.contains("is-thinking")).toBe(true);
    expect(container.querySelector(".transcript-activity-spinner")).toBeNull();
  });

  it("offers Retry only on the latest failed Turn boundary and submits its exact target once", async () => {
    const onRetry = vi.fn(async () => undefined);
    const retryTarget = {
      failedAttemptId: "attempt-latest",
      sourceMessageId: "user-original",
      rootSourceMessageId: "user-original",
      providerId: "codex",
      agentTurnMode: "plan" as const,
    };
    renderTranscript([
      failedTurnCell("failed-old", { ...retryTarget, failedAttemptId: "attempt-old" }),
      { id: "user-next", kind: "user-message", source: "user", text: "next", timestamp: "2026-08-20T00:00:01.000Z" },
      failedTurnCell("failed-latest", retryTarget),
    ], onRetry);

    const button = screen.getByRole("button", { name: "重试上一条消息" });
    expect(screen.getAllByText("执行失败")).toHaveLength(2);
    fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
    expect(onRetry).toHaveBeenCalledWith(retryTarget);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it("suppresses historical Retry after a later user message or successful Turn", () => {
    const retryTarget = {
      failedAttemptId: "attempt-failed",
      sourceMessageId: "user-original",
      rootSourceMessageId: "user-original",
      providerId: "codex",
      agentTurnMode: "default" as const,
    };
    renderTranscript([
      failedTurnCell("failed", retryTarget),
      { id: "user-later", kind: "user-message", source: "user", text: "later" },
      { id: "success", kind: "process-row", source: "provider-runtime", activityKind: "turn", title: "执行完成", text: "", status: "completed" },
    ], vi.fn(async () => undefined));

    expect(screen.queryByRole("button", { name: "重试上一条消息" })).toBeNull();
  });

  it("confirms normal Fork and stale-session recovery without exposing an action when the port is absent", async () => {
    const normalTarget = {
      sourceMessageId: "assistant-1",
      providerId: "codex",
      completedTurnSequence: 1,
      timelineRevision: 4,
      contextRevision: "",
    };
    const recoveryTarget = { ...normalTarget, sourceMessageId: "assistant-2", recovery: true as const };
    const onFork = vi.fn(async () => undefined);
    const cells: ParentAgentTranscriptCell[] = [
      { id: "fork-normal", kind: "process-row", source: "provider-runtime", activityKind: "turn", title: "已完成", text: "", status: "completed", forkTarget: normalTarget },
      { id: "fork-recovery", kind: "process-row", source: "provider-runtime", activityKind: "turn", title: "本轮需要处理", text: "", status: "failed", isError: true, forkTarget: recoveryTarget },
    ];
    renderForkTranscript(cells, onFork);

    expect(screen.getByRole("button", { name: "从这里创建新会话" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "创建恢复会话" }));
    const dialog = screen.getByRole("dialog", { name: "创建恢复会话" });
    expect(screen.getByText(/失败输入不会自动发送/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "创建恢复会话" }));
    await waitFor(() => expect(onFork).toHaveBeenCalledWith(recoveryTarget));

    cleanup();
    renderForkTranscript(cells);
    expect(screen.queryByRole("button", { name: "从这里创建新会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "创建恢复会话" })).toBeNull();
  });

  it("keeps message timestamps beside their own bubble and reveals them without changing the row contract", () => {
    renderTranscript([
      { id: "user-timestamp", kind: "user-message", source: "user", text: "你好", timestamp: "2026-08-20T06:30:00.000Z" },
      { id: "assistant-timestamp", kind: "assistant-message", source: "provider-runtime", text: "你好！", timestamp: "2026-08-20T06:31:00.000Z" },
    ], vi.fn(async () => undefined));

    const userRow = screen.getByTestId("parent-message-user");
    const assistantRow = screen.getByTestId("parent-message-parent-agent");
    expect(userRow.querySelector(".parent-agent-message-stack.user > .parent-agent-bubble.user")).toBeTruthy();
    expect(userRow.querySelector(".parent-agent-message-stack.user > .parent-agent-message-timestamp")).toBeTruthy();
    expect(assistantRow.querySelector(".parent-agent-message-stack.parent > .parent-agent-bubble.parent")).toBeTruthy();
    expect(assistantRow.querySelector(".parent-agent-message-stack.parent > .parent-agent-message-timestamp")).toBeTruthy();
    expect(userRow.getAttribute("data-timestamp-available")).toBe("true");
    expect(userRow.getAttribute("tabindex")).toBe("0");

    fireEvent.touchStart(userRow);
    expect(document.activeElement).toBe(userRow);
    expect(userRow.matches(":focus-within")).toBe(true);
    fireEvent.blur(userRow);
  });

  it("keeps a sub-threshold transcript at natural grid height after repeated measurements", async () => {
    renderConversation(35);

    const list = screen.getByTestId("transcript-virtual-list");
    const rows = () => list.querySelectorAll("[data-transcript-cell-id]");
    expect(rows()).toHaveLength(35);
    expect(list.style.minHeight).toBe("");

    await publishMeasurements(rows(), 100, 72);

    expect(rows()).toHaveLength(35);
    expect(list.style.minHeight).toBe("");
  });

  it("uses bounded spacer virtualization without stretching measured rows", async () => {
    renderConversation(120);

    const list = screen.getByTestId("transcript-virtual-list");
    const rows = () => list.querySelectorAll("[data-transcript-cell-id]");
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(120);
    expect(list.querySelectorAll(".transcript-virtual-spacer").length).toBeGreaterThan(0);
    expect(list.style.minHeight).toBe("");

    await publishMeasurements(rows(), 1, 72);
    const settledRowCount = rows().length;
    await publishMeasurements(rows(), 100, 72);

    expect(rows()).toHaveLength(settledRowCount);
    expect(list.style.minHeight).toBe("");
  });

  it("keeps the scroll position anchored when measured rows change", async () => {
    const scrollNode = renderConversation(120);
    Object.defineProperties(scrollNode, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, writable: true, value: 10_000 },
      scrollTop: { configurable: true, writable: true, value: 1_000 },
    });
    fireEvent.scroll(scrollNode);
    await waitFor(() => expect(screen.getByTestId("transcript-virtual-list").querySelectorAll("[data-transcript-cell-id]").length).toBeGreaterThan(0));
    const rows = screen.getByTestId("transcript-virtual-list").querySelectorAll("[data-transcript-cell-id]");
    await publishMeasurements(rows, 1, 144);
    expect(scrollNode.scrollTop).toBeGreaterThan(1_000);
  });

  it("keeps a pinned viewport at the bottom after measured rows change", async () => {
    const scrollNode = renderConversation(120);
    Object.defineProperties(scrollNode, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, writable: true, value: 10_000 },
      scrollTop: { configurable: true, writable: true, value: 9_600 },
    });
    fireEvent.scroll(scrollNode);
    const rows = screen.getByTestId("transcript-virtual-list").querySelectorAll("[data-transcript-cell-id]");
    await publishMeasurements(rows, 1, 144);
    expect(scrollNode.scrollTop).toBe(10_000);
  });
});

function renderConversation(cellCount: number): HTMLDivElement {
  const scrollRef = createRef<HTMLDivElement>();
  const transcript: ParentAgentTranscript = {
    title: "Virtual transcript",
    items: [],
    cells: Array.from({ length: cellCount }, (_, index): ParentAgentTranscriptCell => ({
      id: `cell:${index}`,
      kind: "assistant-message",
      source: "provider-runtime",
      text: `message ${index}`,
      threadId: "thread-main",
      turnId: `turn-${index}`,
    })),
  };
  render(
    <div ref={scrollRef}>
      <MainConversationView
        transcript={transcript}
        scrollContainerRef={scrollRef}
        loadingEarlierTranscript={false}
        onOpenAgent={() => {}}
        canOpenAgent={() => true}
      />
    </div>,
  );
  return scrollRef.current!;
}

function renderTranscript(cells: ParentAgentTranscriptCell[], onRetry: NonNullable<Parameters<typeof MainConversationView>[0]["onRetry"]>): void {
  const scrollRef = createRef<HTMLDivElement>();
  render(
    <div ref={scrollRef}>
      <MainConversationView
        transcript={{ title: "Retry transcript", items: [], cells }}
        scrollContainerRef={scrollRef}
        loadingEarlierTranscript={false}
        onOpenAgent={() => {}}
        canOpenAgent={() => true}
        onRetry={onRetry}
      />
    </div>,
  );
}

function renderForkTranscript(cells: ParentAgentTranscriptCell[], onFork?: NonNullable<Parameters<typeof MainConversationView>[0]["onFork"]>): void {
  const scrollRef = createRef<HTMLDivElement>();
  render(
    <div ref={scrollRef}>
      <MainConversationView
        transcript={{ title: "Fork transcript", items: [], cells }}
        scrollContainerRef={scrollRef}
        loadingEarlierTranscript={false}
        onOpenAgent={() => {}}
        canOpenAgent={() => true}
        onFork={onFork}
      />
    </div>,
  );
}

function failedTurnCell(
  id: string,
  retryTarget: NonNullable<ParentAgentTranscriptCell["retryTarget"]>,
): ParentAgentTranscriptCell {
  return {
    id,
    kind: "process-row",
    source: "provider-runtime",
    activityKind: "turn",
    title: "执行失败",
    text: "Provider failed",
    status: "failed",
    isError: true,
    retryTarget,
  };
}

async function publishMeasurements(rows: NodeListOf<Element>, repetitions: number, height: number): Promise<void> {
  expect(ControlledResizeObserver.callbacks.length).toBeGreaterThan(0);
  const callback = ControlledResizeObserver.callbacks.at(-1)!;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    await act(async () => {
      callback(Array.from(rows, (target) => ({
        target,
        contentRect: { height } as DOMRectReadOnly,
      } as ResizeObserverEntry)), {} as ResizeObserver);
    });
  }
}
