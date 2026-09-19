// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationTurnQueue, TopicComposer } from "../../src/web/src/shell/composer.js";
import type { ConversationTurnQueueSnapshot, SkillListItem } from "../../src/web/src/types.js";

afterEach(cleanup);

describe("Topic Composer height", () => {
  it("routes an explicit Review command with its captured Composer text", () => {
    const onStartReviewCommand = vi.fn();
    const onSend = vi.fn();
    render(<TopicComposer
      value="/review base origin/main"
      onChange={vi.fn()}
      modelLabel="gpt"
      projectId="project"
      productMode="agent"
      onSend={onSend}
      onStartReviewCommand={onStartReviewCommand}
    />);

    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onStartReviewCommand).toHaveBeenCalledWith(
      { type: "base-branch", branch: "origin/main" },
      "/review base origin/main",
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the turn-mode control only for Agent and keeps unsupported Plan selected", () => {
    const onSelect = vi.fn();
    const view = render(<TopicComposer
      value="draft"
      onChange={vi.fn()}
      modelLabel="gpt"
      projectId="project"
      productMode="agent"
      agentTurnMode="plan"
      onSelectAgentTurnMode={onSelect}
      agentTurnModeDisabledReason="当前 Agent 不支持计划模式。"
      onSend={async () => undefined}
      actionRunning={null}
    />);
    fireEvent.click(screen.getByRole("button", { name: "添加上下文" }));
    const planButton = screen.getByRole("menuitemcheckbox", { name: "计划模式" });
    expect(planButton.getAttribute("aria-checked")).toBe("true");
    expect(planButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "退出计划模式" }));
    expect(onSelect).toHaveBeenCalledWith("default");

    view.rerender(composer("draft"));
    expect(screen.queryByRole("button", { name: "退出计划模式" })).toBeNull();
  });

  it("keeps a compact input and caps content growth at 160px", () => {
    let measuredHeight = 44;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => measuredHeight });
    const view = renderComposer("");
    const textarea = screen.getByRole("textbox");
    expect(textarea.style.height).toBe("44px");
    expect(textarea.style.overflowY).toBe("hidden");

    measuredHeight = 240;
    view.rerender(composer("line\n".repeat(30)));
    expect(textarea.style.height).toBe("160px");
    expect(textarea.style.overflowY).toBe("auto");
    if (descriptor) Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", descriptor);
    else delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  it("shows per-Turn model and effort menus only for Agent mode", () => {
    const onSelectModel = vi.fn();
    const onSelectEffort = vi.fn();
    const view = render(<TopicComposer
      value="draft"
      onChange={vi.fn()}
      modelLabel="gpt-test"
      projectId="project"
      productMode="agent"
      agentTurnMode="default"
      agentModelId="gpt-test"
      agentReasoningEffort="high"
      selectedProviderId="codex"
      providerModelCatalogs={[{ providerId: "codex", displayName: "Codex", status: "ready", snapshot: {
        providerId: "codex", selectedModel: null, effectiveModel: { providerId: "codex", modelId: "gpt-test" },
        effectiveModelSource: "provider-default", candidates: [{ providerId: "codex", modelId: "gpt-test",
          label: "GPT Test", source: "runtime", supportedReasoningEfforts: [{ value: "high", label: "高" }],
          defaultReasoningEffort: "high" }], available: true,
      } }]}
      onSelectAgentTurnMode={vi.fn()}
      onSelectAgentProviderModel={onSelectModel}
      onSelectAgentReasoningEffort={onSelectEffort}
      onSend={async () => undefined}
      actionRunning={null}
    />);

    expect(screen.getByTestId("agent-model-selectors")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "模型：GPT Test" }), { key: "Enter" });
    fireEvent.click(screen.getByText("使用该服务默认模型"));
    expect(onSelectModel).toHaveBeenCalledWith("codex", null);
    fireEvent.keyDown(screen.getByRole("button", { name: "思考强度：高" }), { key: "Enter" });
    fireEvent.click(screen.getByText("模型默认值"));
    expect(onSelectEffort).toHaveBeenCalledWith(null);

    view.rerender(composer("draft"));
    expect(screen.queryByTestId("agent-model-selectors")).toBeNull();
  });

  it("remeasures unchanged text when the composer width changes", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    const resizeObserver = class {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    vi.stubGlobal("ResizeObserver", resizeObserver);
    let measuredHeight = 44;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => measuredHeight });
    renderComposer("unchanged text that wraps when the rail opens");
    const textarea = screen.getByRole("textbox");

    measuredHeight = 112;
    resizeCallback?.([{ contentRect: { width: 360 } } as ResizeObserverEntry], {} as ResizeObserver);
    expect(textarea.style.height).toBe("112px");
    expect(textarea.style.overflowY).toBe("hidden");
    if (descriptor) Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", descriptor);
    else delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  it("keeps Agent steer and Stop available with a conversation Skill enabled", () => {
    const onSend = vi.fn(async () => undefined);
    const onStop = vi.fn(async () => undefined);
    render(<TopicComposer
      value="keep this for the next turn"
      onChange={vi.fn()}
      modelLabel="gpt"
      projectId="project"
      productMode="agent"
      skills={[composerSkill("reviewer")]}
      activeSkillIds={["reviewer"]}
      onSend={onSend}
      onStopAndContinue={onStop}
      actionRunning={null}
      currentWorkpadStatus="running"
      runControlState={{
        state: "running",
        canStop: true,
        canSteer: true,
        steerState: "idle",
        providerId: "codex",
        attemptId: "attempt-agent",
        runId: "run-agent",
      }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "发送给当前执行" }));
    expect(onSend).toHaveBeenCalledOnce();
    expect(onStop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "停止当前执行" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this for the next turn");
  });

  it("disables Agent steer while submitting without disabling Stop", () => {
    const onSend = vi.fn(async () => undefined);
    const onStop = vi.fn(async () => undefined);
    render(<TopicComposer
      value="keep this text"
      onChange={vi.fn()}
      modelLabel="gpt"
      projectId="project"
      productMode="agent"
      onSend={onSend}
      onStopAndContinue={onStop}
      actionRunning={null}
      currentWorkpadStatus="running"
      runControlState={{ state: "running", canStop: true, canSteer: false, steerState: "submitting" }}
    />);

    expect(screen.getByRole("button", { name: "正在发送给当前执行" }).hasAttribute("disabled")).toBe(true);
    const stop = screen.getByRole("button", { name: "停止当前执行" });
    expect(stop.hasAttribute("disabled")).toBe(false);
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("routes Enter through the projected Queue action when an item is already ahead", () => {
    const onSend = vi.fn(async () => undefined);
    const onEnqueue = vi.fn(async () => undefined);
    render(<TopicComposer
      value="next turn"
      onChange={vi.fn()}
      modelLabel="gpt"
      projectId="project"
      productMode="agent"
      skills={[composerSkill("reviewer")]}
      activeSkillIds={["reviewer"]}
      onSend={onSend}
      onEnqueue={onEnqueue}
      turnQueue={{
        projectId: "project",
        productMode: "agent",
        conversationId: "conversation",
        revision: "queue:1",
        executionRevision: null,
        canEnqueue: true,
        canDispatch: false,
        items: [queuedItem("dispatching", "dispatching-item", "ahead", 1)],
      }}
    />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: false });
    expect(onEnqueue).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not submit with Enter while a queue mutation is in flight", () => {
    const onSend = vi.fn(async () => undefined);
    render(<TopicComposer
      value="do not send yet"
      onChange={vi.fn()}
      modelLabel="gpt"
      projectId="project"
      productMode="agent"
      onSend={onSend}
      queueBusy
      turnQueue={{
        projectId: "project",
        productMode: "agent",
        conversationId: "conversation",
        revision: "queue:1",
        executionRevision: null,
        canEnqueue: true,
        canDispatch: true,
        items: [],
      }}
    />);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "正在更新会话队列" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("Conversation Turn queue surface", () => {
  it("renders stable FIFO actions and exposes blocked retry without allowing dispatching removal", () => {
    const onReclaim = vi.fn();
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const snapshot: ConversationTurnQueueSnapshot = {
      projectId: "project",
      productMode: "agent",
      conversationId: "conversation",
      revision: "queue:2",
      executionRevision: "execution:1",
      canEnqueue: true,
      canDispatch: false,
      items: [
        queuedItem("blocked", "blocked-item", "Fix the failing admission", 1),
        queuedItem("dispatching", "dispatching-item", "Already accepted for dispatch", 2),
      ],
    };
    render(<ConversationTurnQueue snapshot={snapshot} busy={false} onReclaim={onReclaim} onRemove={onRemove} onRetry={onRetry} />);

    expect(screen.getByLabelText("待发送内容")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新尝试发送" }));
    fireEvent.click(screen.getAllByRole("button", { name: "移回输入框" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "删除待发送内容" })[0]!);
    expect(onRetry).toHaveBeenCalledWith("blocked-item");
    expect(onReclaim).toHaveBeenCalledWith("blocked-item");
    expect(onRemove).toHaveBeenCalledWith("blocked-item");
    expect(screen.getAllByRole("button", { name: "移回输入框" })[1]!.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("button", { name: "删除待发送内容" })[1]!.hasAttribute("disabled")).toBe(true);
  });

  it("requires explicit execution confirmation without exposing the generic retry action", () => {
    const onConfirmExecution = vi.fn();
    const onRetry = vi.fn();
    const snapshot: ConversationTurnQueueSnapshot = {
      projectId: "project",
      productMode: "agent",
      conversationId: "conversation",
      revision: "queue:3",
      executionRevision: "execution:1",
      canEnqueue: true,
      canDispatch: false,
      items: [{
        ...queuedItem("blocked", "changed-execution", "Run this after the update", 1),
        executionCompatibility: {
          state: "confirmation-required",
          created: { family: "agent.turn", epoch: 1 },
          target: { family: "agent.turn", epoch: 2 },
          summary: "执行方式已更新，需要确认后发送。",
        },
      }],
    };

    render(<ConversationTurnQueue
      snapshot={snapshot}
      busy={false}
      onRetry={onRetry}
      onConfirmExecution={onConfirmExecution}
    />);

    expect(screen.getByText("执行方式已更新，需要确认后发送。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重新尝试发送" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "按当前方式发送" }));
    expect(onConfirmExecution).toHaveBeenCalledWith("changed-execution");
    expect(onRetry).not.toHaveBeenCalled();
  });
});

function queuedItem(status: "blocked" | "dispatching", queueItemId: string, text: string, position: number) {
  return {
    queueItemId,
    clientRequestId: `${queueItemId}-request`,
    position,
    status,
    retryCount: status === "blocked" ? 1 : 0,
    text,
    contextRefs: [],
    attachmentIds: status === "blocked" ? ["attachment-1"] : [],
    skillOverrides: {},
    providerId: "codex",
    agentTurnMode: "default" as const,
    modelId: null,
    reasoningEffort: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    executionCompatibility: { state: "compatible" as const },
  };
}

function composerSkill(skillId: string): SkillListItem {
  return {
    skillId,
    name: skillId,
    description: `${skillId} description`,
    sourcePath: `C:/skills/${skillId}/SKILL.md`,
    sourceKind: "custom",
    scope: "repo",
    contentHash: `hash-${skillId}`,
    compatibility: { requiredCapabilities: [] },
    providerBindings: [],
    providerEnabled: true,
    required: false,
    runtimeAssigned: false,
    enabledProject: true,
    enabledTopics: [],
    disabledTopics: [],
  };
}

function renderComposer(value: string) { return render(composer(value)); }

function composer(value: string) {
  return <TopicComposer
    value={value}
    onChange={vi.fn()}
    providerDisplayName="Codex"
    modelLabel="gpt"
    projectId="project"
    onSend={async () => undefined}
    actionRunning={null}
  />;
}
