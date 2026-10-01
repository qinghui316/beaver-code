// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDecisionInspectorController } from "../../src/web/src/controllers/useDecisionInspectorController.js";
import type { ConfirmationQueue, ConfirmationQueueItem, Decision, DecisionActionResult } from "../../src/web/src/types.js";
afterEach(cleanup);

function options(conversationId = "conv-1") {
  const item: ConfirmationQueueItem = { id: "item-1", kind: "planning-confirm", conversationId, summary: "摘要", whyNeedsConfirmation: "确认计划", confirmEffect: "推进计划", riskSummary: "", evidenceRefs: [], primary: true,
    actions: [{ id: "feedback", label: "要求修改", kind: "feedback", enabled: true, requiresConfirmation: false }] };
  const queue: ConfirmationQueue = { primary: item, current: [item], otherDemands: [], maintenance: [], history: [] };
  return { projectId: "repo", productMode: "harness" as const, conversationId, queue, inspector: { primary: null, related: [], history: [] }, busy: false,
    actions: { executeDecisionAction: vi.fn(async (): Promise<DecisionActionResult> => ({ status: "accepted", refresh: "ready" })),
      requestDecisionFeedback: vi.fn(async (): Promise<DecisionActionResult> => ({ status: "accepted", refresh: "ready" })), refresh: vi.fn(async () => undefined), openConversation: vi.fn(async () => undefined) } };
}

describe("Scoped decision owner", () => {
  it("restores per-item feedback after scope changes", () => {
    const first = options(), second = options("conv-2");
    const hook = renderHook((input) => useDecisionInspectorController(input), { initialProps: first });
    act(() => { hook.result.current.beginFeedback("feedback"); hook.result.current.setFeedback("原会话草稿"); });
    hook.rerender(second);
    expect(hook.result.current.view.feedback).toBe("");
    act(() => { hook.result.current.beginFeedback("feedback"); hook.result.current.setFeedback("另一个草稿"); });
    hook.rerender(first);
    expect(hook.result.current.view.feedback).toBe("原会话草稿");
    expect(hook.result.current.view.feedbackActionId).toBe("feedback");
  });
  it("preserves a newer feedback draft while the captured feedback completes", async () => {
    const input = options();
    let finish!: (result: DecisionActionResult) => void;
    input.actions.requestDecisionFeedback = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const hook = renderHook(() => useDecisionInspectorController(input));
    act(() => { hook.result.current.beginFeedback("feedback"); hook.result.current.setFeedback("旧意见"); });
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.submitFeedback(); });
    act(() => hook.result.current.setFeedback("新意见"));
    await act(async () => { finish({ status: "accepted", refresh: "ready" }); await pending; });
    expect(hook.result.current.view.feedback).toBe("新意见");
    expect(hook.result.current.view.feedbackActionId).toBe("feedback");
  });
  it("keeps uncertain requests locked after rereading without acceptance evidence", async () => {
    const input = options();
    input.actions.requestDecisionFeedback = vi.fn(async () => ({ status: "uncertain", message: "待确认" }));
    const hook = renderHook(() => useDecisionInspectorController(input));
    act(() => { hook.result.current.beginFeedback("feedback"); hook.result.current.setFeedback("意见"); });
    await act(async () => { await hook.result.current.submitFeedback(); });
    await act(async () => { await hook.result.current.refresh(); await hook.result.current.submitFeedback(); });
    expect(hook.result.current.view.locked).toBe(true);
    expect(input.actions.requestDecisionFeedback).toHaveBeenCalledTimes(1);
    expect(hook.result.current.view.feedback).toBe("意见");
  });
  it("does not contaminate a new scope with a late rejection", async () => {
    const first = options(), second = options("conv-2");
    let finish!: (result: DecisionActionResult) => void;
    first.actions.requestDecisionFeedback = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const hook = renderHook((input) => useDecisionInspectorController(input), { initialProps: first });
    act(() => { hook.result.current.beginFeedback("feedback"); hook.result.current.setFeedback("旧草稿"); });
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.submitFeedback(); });
    hook.rerender(second);
    act(() => { hook.result.current.beginFeedback("feedback"); hook.result.current.setFeedback("新草稿"); });
    await act(async () => { finish({ status: "failed", message: "旧错误" }); await pending; });
    expect(hook.result.current.view.issue).toBeNull();
    expect(hook.result.current.view.feedback).toBe("新草稿");
    expect(hook.result.current.view.busy).toBe(false);
  });
  it("settles uncertainty only with a changed exact formal receipt", async () => {
    const input = { ...options(), decisions: [] as Decision[] };
    input.queue.current[0].actions = [{ id: "approve", label: "接受", kind: "approval", enabled: true, requiresConfirmation: false, action: { actionId: "change.approve", args: ["change-1"] } }];
    input.queue.current[0].changeId = "change-1";
    input.actions.executeDecisionAction = vi.fn(async () => ({ status: "uncertain", message: "待确认" }));
    const hook = renderHook((value) => useDecisionInspectorController(value), { initialProps: input });
    await act(async () => { await hook.result.current.execute(input.queue.current[0].actions[0]); });
    const receipt = { id: "approval:change.approve:change-1", changeId: "change-1", status: "accepted", updatedAt: "2026-10-02T00:00:00Z" } as Decision;
    hook.rerender({ ...input, decisions: [{ ...receipt, changeId: "another-change" }] });
    expect(hook.result.current.view.issue?.kind).toBe("uncertain");
    hook.rerender({ ...input, decisions: [receipt] });
    expect(hook.result.current.view.issue?.kind).toBe("accepted");
    expect(input.actions.executeDecisionAction).toHaveBeenCalledTimes(1);
  });
});
