// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useConversationActionController,
  type ConversationActionPorts,
  type ConversationActionSession,
} from "../../src/web/src/controllers/useConversationActionController.js";
import type { ConversationInteractionDraft } from "../../src/web/src/types.js";
import type { DecisionAction, DecisionContext, Snapshot, WorkbenchLiveEvent } from "../../src/web/src/types.js";

afterEach(() => cleanup());

describe("Conversation action controller", () => {
  it("preserves Composer and unrelated errors for workflow decisions and feedback", async () => {
    const harness = controllerHarness({ composerText: "next draft" });
    harness.ports.consumeLiveStream = vi.fn(async (_url, _body, onEvent) => {
      // The workflow endpoint's request-bound terminal event carries only status.
      onEvent({ event: "done", data: { status: "completed" } });
    });
    const { result } = renderHook(() => useConversationActionController(harness.options));
    const action = { ...decisionAction("workflow", "workflow-action"), actionType: "workflow.execute" as const };
    await act(async () => { expect(await result.current.executeDecisionAction(action, decisionContext())).toEqual({ status: "accepted", refresh: "ready" }); });
    await act(async () => { await result.current.requestDecisionFeedback(decisionContext(), { ...action, kind: "feedback" }, "revise"); });
    for (const call of vi.mocked(harness.ports.consumeLiveStream!).mock.calls) expect(call[1]).not.toHaveProperty("prompt");
    expect(harness.ports.setComposerText).not.toHaveBeenCalled();
    expect(harness.ports.setError).not.toHaveBeenCalled();
  });

  it("rejects an explicitly mismatched workflow receipt", async () => {
    const harness = controllerHarness();
    harness.ports.consumeLiveStream = vi.fn(async (_url, _body, onEvent) => {
      onEvent({ event: "done", data: { projectId: "another-project", status: "completed" } });
    });
    const { result } = renderHook(() => useConversationActionController(harness.options));
    await act(async () => {
      expect(await result.current.executeDecisionAction({ ...decisionAction("workflow", "workflow-action"), actionType: "workflow.execute" }, decisionContext())).toMatchObject({ status: "uncertain" });
    });
  });

  it("distinguishes an accepted operation from its subsequent refresh failure", async () => {
    const harness = controllerHarness();
    harness.ports.refreshSession = vi.fn().mockRejectedValue(new Error("refresh offline"));
    const { result } = renderHook(() => useConversationActionController(harness.options));
    await act(async () => {
      expect(await result.current.executeDecisionAction({ ...decisionAction("approve", "approval"), action: approvalAction("apply") }, decisionContext())).toEqual({ status: "accepted", refresh: "failed" });
    });
    expect(harness.ports.postJson).toHaveBeenCalledTimes(1);
    expect(harness.ports.setError).not.toHaveBeenCalled();
  });

  it("does not claim workflow success when a stream ends with an error", async () => {
    const harness = controllerHarness();
    harness.ports.consumeLiveStream = vi.fn(async (_url, _body, onEvent) => onEvent({ event: "error", data: { message: "failed upstream" } } as WorkbenchLiveEvent));
    const { result } = renderHook(() => useConversationActionController(harness.options));
    await act(async () => { expect(await result.current.executeDecisionAction({ ...decisionAction("workflow", "workflow-action"), actionType: "workflow.execute" }, decisionContext())).toMatchObject({ status: "uncertain" }); });
    expect(harness.ports.setError).not.toHaveBeenCalled();
    expect(harness.ports.routeProjectionEvent).not.toHaveBeenCalled();
  });
  it("routes approvals, abandon, evidence, and feedback through their existing owners", async () => {
    const harness = controllerHarness();
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await act(async () => result.current.executeDecisionAction({
      ...decisionAction("approve", "approval"),
      action: approvalAction("apply"),
      options: { commit: true },
    }, decisionContext()));
    expect(harness.ports.postJson).toHaveBeenNthCalledWith(1, "/api/projects/repo-1/workbench/actions", {
      action: approvalAction("apply"),
      confirm: true,
      options: { commit: true },
    });

    await act(async () => result.current.executeDecisionAction(
      decisionAction("abandon", "abandon"),
      decisionContext(),
    ));
    expect(harness.ports.postJson).toHaveBeenNthCalledWith(2, "/api/projects/repo-1/workbench/actions", {
      abandon: {
        changeId: "change-1",
        conversationId: "conversation-1",
        graphScopeId: "graph:conversation-1",
        reason: "用户选择放弃这个需求。",
      },
      confirm: true,
      feedbackContext: {
        contextId: "decision-1",
        changeId: "change-1",
        targetId: "worktree-1",
        runId: "run-1",
      },
    });

    await act(async () => result.current.executeDecisionAction(
      decisionAction("evidence", "evidence"),
      decisionContext(),
    ));
    expect(harness.ports.chooseRun).toHaveBeenCalledWith("run-1");
    expect(harness.ports.openOrchestration).toHaveBeenCalledTimes(1);

    await act(async () => result.current.requestDecisionFeedback(
      decisionContext(),
      { ...decisionAction("feedback", "feedback"), approvalId: "approval-1", artifact: "action.md" },
      "  revise this  ",
    ));
    expect(harness.ports.postJson).toHaveBeenNthCalledWith(3, "/api/projects/repo-1/workbench/actions", expect.objectContaining({
      feedback: "revise this",
      feedbackContext: expect.objectContaining({
        contextId: "decision-1",
        actionId: "feedback",
        approvalId: "approval-1",
        artifact: "action.md",
        worktreeId: "worktree-1",
      }),
    }));
    expect(harness.gateBegins).toEqual([
      "decision.approve",
      "decision.abandon",
      "decision.feedback.feedback",
    ]);
    expect(harness.gateReleases).toHaveLength(3);
  });

  it("owns workflow live routing, intake actions, preserveSelectedTopic, and calibration", async () => {
    const selectedBefore = snapshot("conversation-1");
    const refreshed = snapshot(null);
    const harness = controllerHarness({ snapshot: selectedBefore, composerText: "  proceed  " });
    harness.ports.refreshSession = vi.fn(async () => refreshed);
    const timelinePatch = { event: "timeline.patch", data: { conversationId: "conversation-1" } } as WorkbenchLiveEvent;
    harness.ports.consumeLiveStream = vi.fn(async (_url, _body, onEvent) => onEvent(timelinePatch));
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await act(async () => result.current.runWorkflowAction("workflow.execute", {
      preserveSelectedTopic: true,
      workflowRunId: "workflow-1",
    }));
    expect(harness.ports.consumeLiveStream).toHaveBeenCalledWith(
      "/api/projects/repo-1/workbench/actions/live",
      {
        actionType: "workflow.execute",
        changeId: "conversation-1",
        confirm: true,
        prompt: "proceed",
        workflowRunId: "workflow-1",
      },
      expect.any(Function),
    );
    expect(harness.ports.routeProjectionEvent).toHaveBeenCalledWith("repo-1", timelinePatch);
    expect(harness.ports.applySnapshot).toHaveBeenCalledWith(expect.objectContaining({
      center: expect.objectContaining({ selectedTopic: selectedBefore.center.selectedTopic }),
    }));
    expect(harness.ports.cacheProjectSnapshot).toHaveBeenCalledWith("repo-1", expect.any(Object));
    expect(harness.ports.calibrateTimeline).toHaveBeenCalledWith({
      projectId: "repo-1",
      conversationId: "conversation-1",
      agentSurfaceId: "main-agent",
    });

    harness.options.session.composerText = "scan details";
    harness.ports.postJson = vi.fn(async () => ({ snapshot: selectedBefore }));
    await act(async () => result.current.runWorkflowAction("intake.scan"));
    expect(harness.ports.postJson).toHaveBeenCalledWith(
      "/api/projects/repo-1/workbench/intake/scan",
      { changeId: "conversation-1", prompt: "scan details" },
    );

    harness.options.session.composerText = "";
    harness.ports.requestReanalysisMessage = vi.fn(() => "clarification");
    await act(async () => result.current.runWorkflowAction("intake.reanalyze"));
    expect(harness.ports.postJson).toHaveBeenLastCalledWith(
      "/api/projects/repo-1/workbench/intake/reanalyze",
      { changeId: "conversation-1", message: "clarification" },
    );
  });

  it("owns the exact Agent Turn interrupt JSON request outside the App shell", async () => {
    const harness = controllerHarness();
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await act(async () => result.current.interruptTurn({
      projectId: "repo-1",
      conversationId: "conversation-1",
      providerId: "codex",
      expectedAttemptId: "attempt-1",
    }));

    expect(harness.ports.postJson).toHaveBeenCalledWith(
      "/api/projects/repo-1/workbench/conversations/conversation-1/turn/interrupt",
      {
        productMode: "agent",
        providerId: "codex",
        expectedAttemptId: "attempt-1",
      },
    );
    expect(harness.ports.consumeLiveStream).not.toHaveBeenCalled();
  });

  it("owns the exact Agent Turn steer JSON request without opening an action stream", async () => {
    const harness = controllerHarness();
    harness.ports.postJson = vi.fn(async () => ({ status: "steer-accepted" }));
    const { result } = renderHook(() => useConversationActionController(harness.options));

    let outcome;
    await act(async () => { outcome = await result.current.steerAgentTurn({
      projectId: "repo-1",
      conversationId: "conversation-1",
      providerId: "codex",
      expectedAttemptId: "attempt-1",
      clientRequestId: "steer-1",
      text: "add one constraint",
    }); });

    expect(harness.ports.postJson).toHaveBeenCalledWith(
      "/api/projects/repo-1/workbench/conversations/conversation-1/turn/steer",
      {
        productMode: "agent",
        providerId: "codex",
        expectedAttemptId: "attempt-1",
        clientRequestId: "steer-1",
        text: "add one constraint",
      },
    );
    expect(outcome).toEqual({ status: "accepted" });
    expect(harness.ports.consumeLiveStream).not.toHaveBeenCalled();
  });

  it("forks with exact Snapshot generations, preserves Composer state, and navigates only from the owning scope", async () => {
    const current = snapshot("conversation-1");
    current.productMode = "agent";
    current.center.selectedTopic = {
      ...current.center.selectedTopic!,
      selectedProviderId: "codex",
      timelineRevision: 12,
    };
    current.center.conversationContext = { contextRevision: "context-12" } as never;
    const harness = controllerHarness({ snapshot: current, composerText: "unsent draft" });
    harness.ports.postJson = vi.fn(async () => ({
      status: "forked",
      sourceConversationId: "conversation-1",
      targetConversationId: "conversation-child",
    }));
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await act(async () => result.current.forkAgentConversation({
      projectId: "repo-1",
      conversationId: "conversation-1",
      providerId: "codex",
      sourceMessageId: "assistant-1",
      expectedCompletedTurnSequence: 1,
      expectedTimelineRevision: 12,
      contextRevision: "context-12",
      clientRequestId: "fork-1",
    }));

    expect(harness.ports.postJson).toHaveBeenCalledWith(
      "/api/projects/repo-1/workbench/conversations/conversation-1/fork",
      {
        productMode: "agent",
        providerId: "codex",
        sourceMessageId: "assistant-1",
        expectedCompletedTurnSequence: 1,
        expectedTimelineRevision: 12,
        contextRevision: "context-12",
        clientRequestId: "fork-1",
      },
    );
    expect(harness.ports.navigateConversation).toHaveBeenCalledWith("conversation-child");
    expect(harness.ports.setComposerText).not.toHaveBeenCalled();
  });

  it("owns Agent Retry SSE identity, reports failure, and preserves stale Conversation isolation", async () => {
    const current = snapshot("conversation-1");
    current.productMode = "agent";
    current.center.selectedTopic = {
      ...current.center.selectedTopic!,
      selectedProviderId: "codex",
    };
    const harness = controllerHarness({ snapshot: current });
    harness.ports.consumeLiveStream = vi.fn(async () => { throw new Error("Retry admission failed."); });
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await expect(result.current.retryAgentTurn({
      projectId: "repo-1",
      conversationId: "conversation-1",
      providerId: "codex",
      expectedAttemptId: "attempt-failed",
      sourceMessageId: "user-original",
      clientRequestId: "retry-1",
    })).rejects.toThrow("Retry admission failed.");

    expect(harness.ports.consumeLiveStream).toHaveBeenCalledWith(
      "/api/projects/repo-1/workbench/conversations/conversation-1/turn/retry/live",
      {
        productMode: "agent",
        providerId: "codex",
        expectedAttemptId: "attempt-failed",
        sourceMessageId: "user-original",
        clientRequestId: "retry-1",
      },
      expect.any(Function),
    );
    expect(harness.ports.setError).toHaveBeenLastCalledWith("会话操作暂时无法完成。请重试。");
    expect(harness.ports.calibrateTimeline).toHaveBeenCalledWith({
      projectId: "repo-1",
      productMode: "agent",
      conversationId: "conversation-1",
      agentSurfaceId: "main-agent",
    });
    expect(harness.gateReleases).toEqual([{ id: 1, key: "conversation.retry.attempt-failed" }]);
  });

  it("reuses the Retry client request after transport or SSE failure and rotates it after success", async () => {
    const current = snapshot("conversation-1");
    current.productMode = "agent";
    current.center.selectedTopic = { ...current.center.selectedTopic!, selectedProviderId: "codex" };
    const harness = controllerHarness({ snapshot: current });
    let call = 0;
    harness.ports.consumeLiveStream = vi.fn(async (_url, _body, onEvent) => {
      call += 1;
      if (call === 1) throw new Error("connection lost");
      if (call === 2) {
        onEvent({ event: "error", data: { projectId: "repo-1", productMode: "agent", conversationId: "conversation-1", message: "retry failed" } });
        onEvent({ event: "done", data: { projectId: "repo-1", productMode: "agent", conversationId: "conversation-1", status: "failed" } });
        return;
      }
      onEvent({ event: "done", data: { projectId: "repo-1", productMode: "agent", conversationId: "conversation-1", status: "completed" } });
    });
    const { result } = renderHook(() => useConversationActionController(harness.options));
    const request = {
      projectId: "repo-1",
      conversationId: "conversation-1",
      providerId: "codex",
      expectedAttemptId: "attempt-failed",
      sourceMessageId: "user-original",
      clientRequestId: "retry-first",
    };

    await expect(result.current.retryAgentTurn(request)).rejects.toThrow("connection lost");
    await expect(result.current.retryAgentTurn({ ...request, clientRequestId: "retry-second" })).rejects.toThrow("retry failed");
    await expect(result.current.retryAgentTurn({ ...request, clientRequestId: "retry-third" })).resolves.toBeUndefined();
    await expect(result.current.retryAgentTurn({ ...request, clientRequestId: "retry-fourth" })).resolves.toBeUndefined();

    const bodies = vi.mocked(harness.ports.consumeLiveStream!).mock.calls.map((entry) => entry[1] as { clientRequestId: string });
    expect(bodies.map((body) => body.clientRequestId)).toEqual([
      "retry-first",
      "retry-first",
      "retry-first",
      "retry-fourth",
    ]);
  });

  it("returns terminal Agent and Harness steering settlements without hiding them behind transport success", async () => {
    const harness = controllerHarness();
    harness.ports.postJson = vi.fn(async (url: string) => url.endsWith("/turn/steer")
      ? { status: "already-terminal", attemptId: "attempt-1" }
      : {
          result: {
            actionRunId: "action-1",
            actionType: "conversation.steer",
            status: "completed",
            result: { status: "already-terminal", attemptId: "attempt-1" },
          },
          snapshot: snapshot("conversation-1"),
        });
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await expect(result.current.steerAgentTurn({
      projectId: "repo-1",
      conversationId: "conversation-1",
      providerId: "codex",
      expectedAttemptId: "attempt-1",
      clientRequestId: "steer-agent",
      text: "agent text",
    })).resolves.toEqual({ status: "already-terminal" });
    await expect(result.current.steerHarnessTurn({
      projectId: "repo-1",
      conversationId: "conversation-1",
      clientRequestId: "steer-harness",
      text: "harness text",
    })).resolves.toEqual({ status: "already-terminal" });

    expect(harness.ports.applySnapshot).toHaveBeenCalledOnce();
    expect(harness.ports.consumeLiveStream).not.toHaveBeenCalled();
  });

  it("unwraps the Harness steering workflow settlement", async () => {
    const harness = controllerHarness();
    harness.ports.postJson = vi.fn(async () => ({
      result: {
        actionRunId: "action-1",
        actionType: "conversation.steer",
        status: "completed",
        result: { status: "steered" },
      },
      snapshot: snapshot("conversation-1"),
    }));
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await expect(result.current.steerHarnessTurn({
      projectId: "repo-1",
      conversationId: "conversation-1",
      clientRequestId: "steer-accepted",
      text: "harness text",
    })).resolves.toEqual({ status: "accepted" });
  });

  it("surfaces a failed Harness workflow settlement without treating it as accepted", async () => {
    const harness = controllerHarness();
    harness.ports.postJson = vi.fn(async () => ({
      result: {
        actionRunId: "action-1",
        actionType: "conversation.steer",
        status: "failed",
        error: "Harness steering failed upstream.",
      },
      snapshot: snapshot("conversation-1"),
    }));
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await expect(result.current.steerHarnessTurn({
      projectId: "repo-1",
      conversationId: "conversation-1",
      clientRequestId: "steer-failed",
      text: "harness text",
    })).rejects.toThrow("Harness steering failed upstream.");
  });

  it("keeps interaction drafts scope-isolated and settles through projection plus calibration", async () => {
    const harness = controllerHarness();
    const events: WorkbenchLiveEvent[] = [
      { event: "conversation.interactions.updated", data: { conversationId: "conversation-1", items: [] } },
    ];
    harness.ports.consumeLiveStream = vi.fn(async (_url, _body, onEvent) => {
      for (const event of events) onEvent(event);
    });
    const { result, rerender } = renderHook(
      ({ options }) => useConversationActionController(options),
      { initialProps: { options: harness.options } },
    );
    const draft = interactionDraft("answer one");

    act(() => result.current.setInteractionDraft("interaction-1", draft));
    expect(result.current.getInteractionDraft("interaction-1")).toEqual(draft);

    await act(async () => result.current.settleInteraction("interaction-1", {
      action: "answer",
      answers: { question: "answer one" },
    }));
    expect(harness.ports.consumeLiveStream).toHaveBeenCalledWith(
      "/api/projects/repo-1/workbench/conversations/conversation-1/interactions/interaction-1/settle",
      { action: "answer", answers: { question: "answer one" } },
      expect.any(Function),
    );
    expect(harness.ports.routeProjectionEvent).toHaveBeenCalledWith("repo-1", events[0]);
    expect(result.current.getInteractionDraft("interaction-1")).toBeUndefined();

    act(() => result.current.setInteractionDraft("interaction-1", draft));
    const conversationTwoOptions = {
      ...harness.options,
      session: { ...harness.options.session, conversationId: "conversation-2", selectedTopicId: "conversation-2" },
    };
    rerender({ options: conversationTwoOptions });
    expect(result.current.getInteractionDraft("interaction-1")).toBeUndefined();
    act(() => result.current.setInteractionDraft("interaction-1", interactionDraft("answer two")));
    rerender({ options: harness.options });
    expect(result.current.getInteractionDraft("interaction-1")).toEqual(draft);
  });

  it("retains a draft after an error event and releases only its injected operation token", async () => {
    const harness = controllerHarness();
    harness.ports.consumeLiveStream = vi.fn(async (_url, _body, onEvent) => {
      onEvent({ event: "error", data: { message: "stale interaction" } } as WorkbenchLiveEvent);
    });
    const { result } = renderHook(() => useConversationActionController(harness.options));
    const draft = interactionDraft("retry me");
    act(() => result.current.setInteractionDraft("interaction-1", draft));

    await act(async () => result.current.settleInteraction("interaction-1", { action: "skip" }));

    expect(result.current.getInteractionDraft("interaction-1")).toEqual(draft);
    expect(harness.gateBegins).toEqual(["interaction.skip"]);
    expect(harness.gateReleases).toEqual([{ id: 1, key: "interaction.skip" }]);
    expect(harness.ports.calibrateTimeline).toHaveBeenCalledTimes(1);
  });

  it("passes execute, revise, and skip settlements through unchanged", async () => {
    const harness = controllerHarness();
    const settlements = [
      { action: "execute-plan" as const },
      { action: "revise-plan" as const, feedback: "keep the public API" },
      { action: "skip" as const, skippedQuestionIds: ["question-1"] },
    ];
    const { result } = renderHook(() => useConversationActionController(harness.options));

    for (const settlement of settlements) {
      await act(async () => result.current.settleInteraction("plan-interaction", settlement));
    }

    expect(harness.ports.consumeLiveStream).toHaveBeenCalledTimes(3);
    for (const [index, settlement] of settlements.entries()) {
      expect(harness.ports.consumeLiveStream).toHaveBeenNthCalledWith(
        index + 1,
        "/api/projects/repo-1/workbench/conversations/conversation-1/interactions/plan-interaction/settle",
        settlement,
        expect.any(Function),
      );
    }
  });

  it("releases the global operation token when Timeline calibration fails", async () => {
    const harness = controllerHarness();
    harness.ports.calibrateTimeline = vi.fn(async () => { throw new Error("calibration failed"); });
    const { result } = renderHook(() => useConversationActionController(harness.options));

    await expect(result.current.runWorkflowAction("workflow.execute")).rejects.toThrow("calibration failed");

    expect(harness.gateReleases).toEqual([{ id: 1, key: "workflow.execute" }]);
  });

  it("does not refresh or calibrate a stale Conversation after the scope changes", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const harness = controllerHarness({ composerText: "old request" });
    harness.ports.consumeLiveStream = vi.fn(async () => pending);
    const { result, rerender } = renderHook(
      ({ options }) => useConversationActionController(options),
      { initialProps: { options: harness.options } },
    );

    let request!: Promise<void>;
    act(() => { request = result.current.runWorkflowAction("workflow.execute", { preserveSelectedTopic: true }); });
    rerender({
      options: {
        ...harness.options,
        session: { ...harness.options.session, conversationId: "conversation-2", selectedTopicId: "conversation-2" },
      },
    });
    await act(async () => { finish(); await request; });

    expect(harness.ports.refreshSession).not.toHaveBeenCalled();
    expect(harness.ports.calibrateTimeline).not.toHaveBeenCalled();
    expect(harness.ports.setComposerText).not.toHaveBeenCalled();
    expect(harness.gateReleases).toEqual([{ id: 1, key: "workflow.execute" }]);
  });
});

function controllerHarness(overrides: Partial<ConversationActionSession> = {}) {
  const gateBegins: string[] = [];
  const gateReleases: Array<{ id: number; key: string }> = [];
  const session: ConversationActionSession = {
    projectId: "repo-1",
    conversationId: "conversation-1",
    selectedTopicId: "conversation-1",
    snapshot: snapshot("conversation-1"),
    composerText: "",
    ...overrides,
  };
  const ports: ConversationActionPorts = {
    operationGate: {
      begin: (key) => {
        gateBegins.push(key);
        return { id: gateBegins.length, key };
      },
      release: (token) => { gateReleases.push(token); },
    },
    routeProjectionEvent: vi.fn(),
    refreshSession: vi.fn(async () => snapshot("conversation-1")),
    calibrateTimeline: vi.fn(async () => undefined),
    postJson: vi.fn(async () => ({})),
    consumeLiveStream: vi.fn(async () => undefined),
    applySnapshot: vi.fn(),
    cacheProjectSnapshot: vi.fn(),
    setComposerText: vi.fn(),
    setError: vi.fn(),
    chooseRun: vi.fn(async () => undefined),
    openOrchestration: vi.fn(),
    navigateConversation: vi.fn(async () => undefined),
    requestReanalysisMessage: vi.fn(() => null),
  };
  return { options: { session, ports }, ports, gateBegins, gateReleases };
}

function decisionAction(id: string, kind: DecisionAction["kind"]): DecisionAction {
  return {
    id,
    kind,
    label: id,
    enabled: true,
    requiresConfirmation: false,
  };
}

function approvalAction(id: string) {
  return {
    actionId: id,
    label: id,
    command: id,
    args: [],
    mutates: true,
    requiresConfirmation: true,
  };
}

function decisionContext(): DecisionContext {
  return {
    id: "decision-1",
    kind: "workflow",
    title: "Decision",
    summary: "Choose",
    severity: "warning",
    changeId: "change-1",
    targetId: "worktree-1",
    runId: "run-1",
    artifact: "context.md",
    actions: [],
  };
}

function interactionDraft(feedback: string): ConversationInteractionDraft {
  return {
    questionIndex: 0,
    answers: { question: feedback },
    skippedQuestionIds: [],
    feedbackExpanded: false,
    feedback,
  };
}

function snapshot(selectedTopicId: string | null): Snapshot {
  const selectedTopic = selectedTopicId
    ? { id: selectedTopicId, title: "Current topic", state: "active", graphScopeId: `graph:${selectedTopicId}` }
    : null;
  return {
    project: { id: "repo-1", name: "Repo", path: "E:/repo" },
    memory: {},
    left: { topics: [] },
    center: {
      selectedTopic,
      workpad: { id: "workpad-1" },
      agentLoop: { runs: [] },
      thread: { items: [] },
      conversationInteractions: { items: [] },
    },
    right: {
      approvals: [],
      decisions: [],
      decisionInspector: { primary: null, related: [], history: [] },
      confirmationQueue: { primary: null, current: [], otherDemands: [], maintenance: [], history: [] },
    },
    harnessGaps: [],
    warnings: [],
  } as Snapshot;
}
