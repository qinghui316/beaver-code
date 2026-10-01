// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMainConversationViewport,
  type MainConversationViewportInput,
} from "../../src/web/src/controllers/useMainConversationViewport.js";
import type { CanonicalTimelineMutation, CanonicalTimelineMutationKind } from "../../src/web/src/canonicalTimelineStore.js";

type Frame = { id: number; callback: FrameRequestCallback };

let frames: Frame[];
let nextFrameId: number;

beforeEach(() => {
  frames = [];
  nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.push({ id, callback });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Main Conversation viewport owner", () => {
  it("restores reading position after settings hide and show the same conversation", () => {
    const initial = input({ visible: true });
    const { result, rerender } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 200 });
    result.current.scrollContainerRef.current = node;
    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    rerender({ ...initial, visible: false }); node.scrollTop = 0;
    rerender(initial); flushFrames(); expect(node.scrollTop).toBe(200); expect(result.current.showLatest).toBe(true);
  });

  it("derives pinned intent only from user scroll and lets Latest restore it", () => {
    const { result } = renderViewport();
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 200 });
    result.current.scrollContainerRef.current = node;

    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    expect(result.current.showLatest).toBe(true);

    act(() => result.current.scrollToLatest());
    expect(node.scrollTop).toBe(1_000);
    expect(result.current.showLatest).toBe(false);
  });

  it.each(["append-tail", "replace-tail-growth"] as const)("follows %s only while pinned", (kind) => {
    const initial = input();
    const { result, rerender } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 });
    result.current.scrollContainerRef.current = node;

    rerender({ ...initial, mutation: mutation(kind, 1) });
    node.setScrollHeight(1_300);
    flushFrames();
    expect(node.scrollTop).toBe(1_300);

    node.scrollTop = 300;
    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    rerender({ ...initial, mutation: mutation(kind, 2) });
    node.setScrollHeight(1_600);
    flushFrames();

    expect(node.scrollTop).toBe(300);
    expect(result.current.showLatest).toBe(true);
  });

  it("does not move an unpinned viewport for prepend or repeated calibration", () => {
    const initial = input();
    const { result, rerender } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 250 });
    result.current.scrollContainerRef.current = node;
    act(() => result.current.onUserScroll({ currentTarget: node } as never));

    rerender({ ...initial, mutation: mutation("prepend", 1) });
    for (let revision = 2; revision <= 101; revision += 1) {
      rerender({ ...initial, mutation: mutation("calibrate", revision) });
    }
    flushFrames();

    expect(node.scrollTop).toBe(250);
    expect(result.current.showLatest).toBe(true);
  });

  it("loads earlier once and preserves the viewport anchor after prepend layout", async () => {
    let resolveLoad!: () => void;
    const loadEarlier = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    const initial = input({ hasMoreBefore: true, loadEarlier });
    const { result } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 120 });
    result.current.scrollContainerRef.current = node;

    act(() => {
      result.current.onUserScroll({ currentTarget: node } as never);
      result.current.onUserScroll({ currentTarget: node } as never);
    });
    await act(async () => Promise.resolve());
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    node.setScrollHeight(1_450);
    await act(async () => resolveLoad());
    flushFrames();

    expect(node.scrollTop).toBe(570);
  });

  it("invalidates a pending prepend anchor when the scope resets", async () => {
    let resolveLoad!: () => void;
    const loadEarlier = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve; }));
    const initial = input({ hasMoreBefore: true, loadEarlier });
    const { result, rerender } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 100 });
    result.current.scrollContainerRef.current = node;

    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    await act(async () => Promise.resolve());
    rerender({ ...initial, scopeKey: "project:conversation-b:main" });
    node.setScrollHeight(1_500);
    await act(async () => resolveLoad());
    flushFrames();

    expect(node.scrollTop).toBe(100);
    expect(result.current.showLatest).toBe(false);
  });

  it("does not let an old scope request unlock the new scope request", async () => {
    const resolvers: Array<() => void> = [];
    const loadEarlier = vi.fn(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    const initial = input({ hasMoreBefore: true, loadEarlier });
    const { result, rerender } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 100 });
    result.current.scrollContainerRef.current = node;

    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    await act(async () => Promise.resolve());
    rerender({ ...initial, scopeKey: "project:conversation-b:main" });
    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    await act(async () => Promise.resolve());
    expect(loadEarlier).toHaveBeenCalledTimes(2);

    await act(async () => resolvers[0]!());
    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    expect(loadEarlier).toHaveBeenCalledTimes(2);

    await act(async () => resolvers[1]!());
    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    await act(async () => Promise.resolve());
    expect(loadEarlier).toHaveBeenCalledTimes(3);
    await act(async () => resolvers[2]!());
  });

  it("releases the pagination lock after a failed request", async () => {
    const loadEarlier = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const initial = input({ hasMoreBefore: true, loadEarlier });
    const { result } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 100 });
    result.current.scrollContainerRef.current = node;

    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());
    act(() => result.current.onUserScroll({ currentTarget: node } as never));
    await act(async () => Promise.resolve());

    expect(loadEarlier).toHaveBeenCalledTimes(2);
  });

  it("preserves the saved reading intent across a same-scope reset", () => {
    const initial = input();
    const { result, rerender } = renderHook(useMainConversationViewport, { initialProps: initial });
    const node = viewportNode({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 200 });
    result.current.scrollContainerRef.current = node;
    act(() => result.current.onUserScroll({ currentTarget: node } as never));

    rerender({ ...initial, mutation: mutation("reset", 1) });
    flushFrames();

    expect(node.scrollTop).toBe(200);
    expect(result.current.showLatest).toBe(true);
  });
});

function renderViewport(overrides: Partial<MainConversationViewportInput> = {}) {
  return renderHook(useMainConversationViewport, { initialProps: input(overrides) });
}

function input(overrides: Partial<MainConversationViewportInput> = {}): MainConversationViewportInput {
  return {
    scopeKey: "project:conversation-a:main",
    mutation: null,
    hasMoreBefore: false,
    loadingEarlier: false,
    loadEarlier: async () => {},
    ...overrides,
  };
}

function mutation(kind: CanonicalTimelineMutationKind, revision: number): CanonicalTimelineMutation {
  return {
    kind,
    scopeKey: "project:conversation-a:main",
    revision,
    addedMessageIds: kind === "append-tail" || kind === "prepend" ? [`added-${revision}`] : [],
    updatedMessageIds: kind === "replace-tail-growth" || kind === "calibrate" ? [`updated-${revision}`] : [],
    removedMessageIds: [],
  };
}

function viewportNode(initial: { scrollHeight: number; clientHeight: number; scrollTop: number }): HTMLDivElement & { setScrollHeight(value: number): void } {
  const node = document.createElement("div") as HTMLDivElement & { setScrollHeight(value: number): void };
  let scrollHeight = initial.scrollHeight;
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(node, "clientHeight", { configurable: true, value: initial.clientHeight });
  node.scrollTop = initial.scrollTop;
  node.setScrollHeight = (value) => { scrollHeight = value; };
  return node;
}

function flushFrames(): void {
  act(() => {
    while (frames.length) {
      const pending = frames;
      frames = [];
      for (const frame of pending) frame.callback(0);
    }
  });
}
