// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionInspectorPane } from "../../src/web/src/panels/workbench/DecisionPanels.js";
import { useDecisionInspectorController } from "../../src/web/src/controllers/useDecisionInspectorController.js";
import type { ConfirmationQueue, ConfirmationQueueItem, DecisionActionResult, DecisionContext, DecisionInspector } from "../../src/web/src/types.js";
afterEach(cleanup);

const accepted = async (): Promise<DecisionActionResult> => ({ status: "accepted", refresh: "ready" });
function Harness({ queue = emptyQueue(), inspector = { primary: null, related: [], history: [] }, execute = vi.fn(accepted), feedback = vi.fn(accepted), open = vi.fn(async () => undefined), loadFailure = null }: {
  queue?: ConfirmationQueue; inspector?: DecisionInspector; execute?: ReturnType<typeof vi.fn>; feedback?: ReturnType<typeof vi.fn>; open?: ReturnType<typeof vi.fn>; loadFailure?: string | null;
}) {
  const controller = useDecisionInspectorController({ projectId: "repo-1", productMode: "harness", conversationId: "conv-1", queue, inspector, busy: false, loadFailure,
    actions: { executeDecisionAction: execute, requestDecisionFeedback: feedback, refresh: async () => undefined, openConversation: open } });
  return <DecisionInspectorPane controller={controller} />;
}
describe("Confirmation surface", () => {
  it("renders one quiet empty state with no zero counts or empty history", () => {
    render(<Harness />);
    expect(screen.getByText("当前没有待确认事项")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByTestId("decision-history")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("selects every current item by its own identity and keeps approval explicit", async () => {
    const first = item("one", "第一个事项"), second = item("two", "第二个事项");
    const execute = vi.fn(accepted);
    render(<Harness queue={{ ...emptyQueue(), primary: first, current: [first, second] }} execute={execute} />);
    fireEvent.click(screen.getByRole("button", { name: /第二个事项/ }));
    const detail = screen.getByTestId("decision-inspector-primary");
    expect(detail.getAttribute("data-decision-id")).toBe("two");
    fireEvent.click(within(detail).getByRole("button", { name: "应用到项目" }));
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole("button", { name: "确认应用到项目" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledWith(second.actions[0], expect.objectContaining({ id: "two" }));
  });
  it("shows history detail as readonly and retains its history row", () => {
    const context = { id: "history-1", kind: "history", title: "历史事项", summary: "已处理", severity: "info", actions: item("old", "old").actions } as DecisionContext;
    render(<Harness inspector={{ primary: null, related: [], history: [context] }} />);
    fireEvent.click(screen.getByText("历史记录"));
    fireEvent.click(screen.getByRole("button", { name: /历史事项/ }));
    const detail = screen.getByTestId("decision-inspector-primary");
    expect(within(detail).getByText("已处理")).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: /应用/ })).toBeNull();
    expect(screen.getByTestId("decision-history")).toBeTruthy();
  });
  it("does not show a false empty state when only another conversation has an item", () => {
    const other = { ...item("other", "其他会话事项"), conversationId: "conv-2" };
    const open = vi.fn(async () => undefined);
    render(<Harness queue={{ ...emptyQueue(), otherDemands: [other] }} open={open} />);
    expect(screen.queryByText("当前没有待确认事项")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开对应会话" }));
    expect(open).toHaveBeenCalledWith("repo-1", "conv-2");
    expect(screen.queryByRole("button", { name: "应用到项目" })).toBeNull();
  });
  it("keeps failed feedback and prevents repeated pending submission", async () => {
    let finish!: (value: DecisionActionResult) => void;
    const feedback = vi.fn(() => new Promise<DecisionActionResult>((resolve) => { finish = resolve; }));
    const primary = item("one", "需要修改");
    render(<Harness queue={{ ...emptyQueue(), primary, current: [primary] }} feedback={feedback} />);
    fireEvent.click(screen.getByRole("button", { name: "要求修改" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "保留接口" } });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
    fireEvent.click(screen.getByRole("button", { name: "正在提交…" }));
    expect(feedback).toHaveBeenCalledTimes(1);
    finish({ status: "failed", message: "提交失败" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("提交失败"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("保留接口");
  });
  it("shows read failure instead of claiming the list is empty", () => {
    render(<Harness loadFailure="读取失败" />);
    expect(screen.getByRole("alert").textContent).toContain("读取失败");
    expect(screen.queryByText("当前没有待确认事项")).toBeNull();
  });
});
function emptyQueue(): ConfirmationQueue { return { primary: null, current: [], otherDemands: [], maintenance: [], history: [] }; }
function item(id: string, title: string): ConfirmationQueueItem {
  return { id, kind: "single-result-apply", conversationId: "conv-1", changeId: "change-1", summary: "检查通过", whyNeedsConfirmation: title, confirmEffect: "应用检查通过的结果", riskSummary: "", evidenceRefs: ["checks.json"], primary: true, actions: [
    { id: `apply:${id}`, label: "应用到项目", kind: "approval", enabled: true, requiresConfirmation: true },
    { id: `feedback:${id}`, label: "要求修改", kind: "feedback", enabled: true, requiresConfirmation: false },
  ] };
}
