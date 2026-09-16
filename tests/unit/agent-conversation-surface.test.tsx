// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalTranscriptCellsFromThreadItem } from "../../src/workbench/parent-agent-transcript.js";
import { ResourceWorkspacePanel } from "../../src/web/src/panels/workbench/ResourceWorkspacePanel.js";
import { AgentTranscriptPane, ParentAgentTranscriptCellView } from "../../src/web/src/panels/workbench/TranscriptReadingSurface.js";
import type { AgentSurfaceProjectionItem, AssistantTurnBlock, ParentAgentTranscript } from "../../src/web/src/types.js";

afterEach(cleanup);

describe("Agent conversation surfaces", () => {
  it("keeps long child transcripts DOM-bounded through the shared virtual list", () => {
    render(<div style={{ height: 500, overflow: "auto" }}>
      <AgentTranscriptPane cells={Array.from({ length: 120 }, (_, index) => ({
        id: `child-cell:${index}`,
        kind: "assistant-message" as const,
        source: "provider-runtime" as const,
        text: `Child output ${index}`,
      }))} />
    </div>);
    const pane = screen.getByTestId("agent-transcript-pane");
    expect(pane.querySelectorAll("[data-transcript-cell-id]").length).toBeLessThan(120);
    expect(pane.querySelectorAll(".transcript-virtual-spacer").length).toBeGreaterThan(0);
  });

  it("keeps same-role provider threads in separate closeable tabs", () => {
    const first = agent("agent:codex:thread:coder-1", "thread-coder-1", "Coder Agent 1", "Coder one result");
    const second = agent("agent:codex:thread:coder-2", "thread-coder-2", "Coder Agent 2", "Coder two result");
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onBack = vi.fn();
    render(<ResourceWorkspacePanel
      agents={[first, second]}
      agentTranscripts={{
        [first.agentSurfaceId]: first.transcript,
        [second.agentSurfaceId]: second.transcript,
      }}
      conversationId="conversation-1"
      tabs={[
        { resourceId: `agent:${first.agentSurfaceId}`, target: { kind: "agent", conversationId: "conversation-1", agentSurfaceId: first.agentSurfaceId } },
        { resourceId: `agent:${second.agentSurfaceId}`, target: { kind: "agent", conversationId: "conversation-1", agentSurfaceId: second.agentSurfaceId } },
      ]}
      selectedResourceId={`agent:${first.agentSurfaceId}`}
      documents={{}}
      loadingResourceIds={[]}
      resourceErrors={{}}
      onSelectResource={onSelect}
      onCloseResource={onClose}
      onBack={onBack}
      agentDrafts={{}}
      pendingAgentMessages={{}}
      onAgentDraftChange={vi.fn()}
      onSubmitAgentMessage={async () => undefined}
      onLoadEarlierAgentTranscript={async () => undefined}
      providerDisplayName="Claude Code"
      modelLabel="default"
    />);
    const tabs = screen.getByRole("tablist", { name: "已打开的资源" });
    expect(within(tabs).getByRole("tab", { name: /Coder Agent 1/ })).toBeTruthy();
    expect(within(tabs).getByRole("tab", { name: /Coder Agent 2/ })).toBeTruthy();
    expect(screen.getByText("Coder one result")).toBeTruthy();
    fireEvent.click(within(tabs).getByRole("tab", { name: /Coder Agent 2/ }));
    expect(onSelect).toHaveBeenCalledWith(`agent:${second.agentSurfaceId}`);
    fireEvent.click(screen.getByRole("button", { name: "关闭 Coder Agent 1" }));
    expect(onClose).toHaveBeenCalledWith(`agent:${first.agentSurfaceId}`);
    fireEvent.click(screen.getByRole("button", { name: "返回工具列表" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("groups only adjacent command items and keeps canonical result copy", () => {
    const command = (id: string, sequence: number, status: "completed" | "failed", text: string): AssistantTurnBlock => ({
      id,
      itemId: id,
      providerId: "codex",
      attemptId: "attempt-command",
      runId: "run-command",
      threadId: "thread-command",
      turnId: "turn-command",
      sequence,
      kind: "command",
      timestamp: `2026-07-14T00:00:0${sequence}.000Z`,
      source: "provider",
      status,
      command: text,
      exitCode: status === "failed" ? 1 : 0,
      isError: status === "failed",
    });
    const cells = canonicalTranscriptCellsFromThreadItem({
      id: "assistant-command-run",
      kind: "assistant-turn",
      label: "AI",
      timestamp: "2026-07-14T00:00:01.000Z",
      providerId: "codex",
      attemptId: "attempt-command",
      runId: "run-command",
      threadId: "thread-command",
      turnId: "turn-command",
      blocks: [
        command("cmd-1", 1, "completed", "npm test"),
        command("cmd-2", 2, "failed", "npm run lint"),
        { id: "prose-break", sequence: 3, kind: "prose", timestamp: "2026-07-14T00:00:03.000Z", source: "provider", text: "继续检查。" },
        command("cmd-3", 4, "completed", "npm run build"),
      ],
    });
    expect(cells.filter((cell) => cell.activityKind === "command")).toEqual([
      expect.objectContaining({ title: "运行了 2 条命令 · 1 条失败", status: "failed", isError: true }),
      expect.objectContaining({ title: "命令已完成 · npm run build", status: "completed" }),
    ]);
  });

  it("keeps tool detail collapsed and follows output only while pinned", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1_000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
    const cell = {
      id: "command-live",
      kind: "process-row" as const,
      source: "provider-runtime" as const,
      title: "正在运行命令",
      text: "输出持续更新",
      detailText: "line 1\nline 2",
      status: "running",
      realtime: true,
    };
    const view = render(<AgentTranscriptPane cells={[cell]} />);
    expect(screen.queryByText(/line 2/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /正在运行命令/ }));
    const details = document.querySelector(".tool-result-details") as HTMLDivElement;
    expect(details.scrollTop).toBe(1_000);
    details.scrollTop = 100;
    fireEvent.scroll(details);
    view.rerender(<AgentTranscriptPane cells={[{ ...cell, detailText: `${cell.detailText}\nline 3` }]} />);
    expect(details.scrollTop).toBe(100);
    expect(details.textContent).toContain("line 3");
    vi.restoreAllMocks();
  });

  it("keeps fenced code with internal blank lines as one canonical code block", () => {
    const code = "const first = 1;\n\nconst second = 2;";
    render(<ParentAgentTranscriptCellView
      cell={{
        id: "assistant-fenced-code",
        kind: "assistant-message",
        source: "provider-runtime",
        text: `前文\n\n\`\`\`ts\n${code}\n\`\`\`\n\n后文`,
      }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);

    const codeBlock = document.querySelector("pre.markdown-lite-code");
    expect(codeBlock?.textContent).toBe(code);
    expect(screen.getByText("前文")).toBeTruthy();
    expect(screen.getByText("后文")).toBeTruthy();
  });

  it("renders realtime reasoning, streaming caret, code copy, and deterministic tables from canonical cells", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { rerender } = render(<ParentAgentTranscriptCellView
      cell={{ id: "reasoning-live", kind: "process-row", source: "provider-runtime", text: "", detailText: "公开摘要", activityKind: "reasoning", realtime: true }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);
    expect(screen.getByText("公开摘要")).toBeTruthy();
    expect(screen.getByRole("button", { name: /思考摘要/ }).getAttribute("aria-expanded")).toBe("true");

    rerender(<ParentAgentTranscriptCellView
      cell={{ id: "reasoning-done", kind: "process-row", source: "provider-runtime", text: "", detailText: "公开摘要", activityKind: "reasoning" }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);
    expect(screen.queryByText("公开摘要")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /思考摘要/ }));

    rerender(<ParentAgentTranscriptCellView
      cell={{ id: "answer-live", kind: "assistant-message", source: "provider-runtime", realtime: true, text: "结果\n\n```ts\nconst value = 1;\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| 构建 | 通过 |" }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);
    expect(document.querySelector(".transcript-streaming-caret")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await screen.findByText("已复制");
    expect(writeText).toHaveBeenCalledWith("const value = 1;");

    rerender(<ParentAgentTranscriptCellView
      cell={{ id: "answer-complete", kind: "assistant-message", source: "provider-runtime", text: "完成" }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);
    expect(document.querySelector(".transcript-streaming-caret")).toBeNull();
  });

  it("falls back to literal text for an unclosed fence after streaming completes", () => {
    render(<ParentAgentTranscriptCellView
      cell={{ id: "answer-unclosed", kind: "assistant-message", source: "provider-runtime", text: "```ts\nconst value = 1;" }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);
    expect(document.querySelector("pre.markdown-lite-code")).toBeNull();
    expect(document.body.textContent).toContain("```ts");
  });

  it("announces clipboard failure without changing the source code", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    render(<ParentAgentTranscriptCellView
      cell={{ id: "answer-copy-failure", kind: "assistant-message", source: "provider-runtime", text: "```\nraw code\n```" }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(await screen.findByText("复制失败，请手动选择代码。")).toBeTruthy();
    expect(document.querySelector("pre.markdown-lite-code")?.textContent).toBe("raw code");
  });

  it("keeps failed command emphasis deterministic and opens child lifecycle rows by canonical target", () => {
    const onOpenAgent = vi.fn();
    const { rerender } = render(<ParentAgentTranscriptCellView
      cell={{
        id: "failed-command",
        kind: "process-row",
        source: "provider-runtime",
        title: "命令执行失败 · npm test",
        text: "命令执行失败 · npm test",
        status: "failed",
        isError: true,
        activityKind: "command",
      }}
      expanded={false}
      onToggleExpanded={vi.fn()}
    />);
    const failed = document.querySelector(".transcript-activity-row") as HTMLElement;
    expect(failed.classList.contains("activity-command")).toBe(true);
    expect(failed.classList.contains("tone-danger")).toBe(true);
    expect(failed.querySelector("span.transcript-activity-title")?.textContent).toContain("命令执行失败");
    expect(failed.querySelector("strong")).toBeNull();

    rerender(<ParentAgentTranscriptCellView
      cell={{
        id: "child-lifecycle",
        kind: "process-row",
        source: "provider-runtime",
        title: "Plan Agent · Sagan 正在规划",
        text: "Plan Agent · Sagan 正在规划",
        status: "processing",
        activityKind: "agent",
        targetAgentSurfaceId: "agent:codex:thread:thread-plan",
      }}
      expanded={false}
      onToggleExpanded={vi.fn()}
      onOpenAgent={onOpenAgent}
      canOpenAgent={() => true}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Plan Agent · Sagan 正在规划" }));
    expect(onOpenAgent).toHaveBeenCalledWith("agent:codex:thread:thread-plan");

    const onToggleExpanded = vi.fn();
    rerender(<ParentAgentTranscriptCellView
      cell={{
        id: "unknown-child",
        kind: "process-row",
        source: "provider-runtime",
        title: "Provider child activity",
        text: "Unknown child",
        detailText: "Diagnostic evidence",
        activityKind: "agent",
        targetAgentSurfaceId: "agent:codex:thread:unknown",
      }}
      expanded={false}
      onToggleExpanded={onToggleExpanded}
      onOpenAgent={onOpenAgent}
      canOpenAgent={() => false}
    />);
    expect(screen.queryByText("打开")).toBeNull();
    expect(screen.getByText("详情")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Provider child activity/ }));
    expect(onToggleExpanded).toHaveBeenCalledOnce();
    expect(onOpenAgent).toHaveBeenCalledTimes(1);
  });
});

type TestAgent = AgentSurfaceProjectionItem & { transcript: ParentAgentTranscript };

function agent(id: string, _providerThreadId: string, label: string, text: string): TestAgent {
  return {
    agentSurfaceId: id,
    kind: "agent",
    roleId: "coder-agent",
    parentAgentSurfaceId: "main-agent",
    label,
    status: "completed",
    createdAt: "2026-07-18T00:00:00Z",
    transcript: {
      title: label,
      items: [],
      cells: [{ id: `${id}:message`, kind: "assistant-message", source: "provider-runtime", text }],
    },
  };
}
