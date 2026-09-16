// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightToolRailShell, type RightToolRailState } from "../../src/web/src/panels/workbench/DecisionPaneShell.js";
import { WorkspaceDockToggleBar } from "../../src/web/src/panels/workbench/WorkspaceDockToggleBar.js";

afterEach(cleanup);

describe("Right tool rail shell", () => {
  it("opens the launcher from the shared workspace tool group", () => {
    const onToggleRightRail = vi.fn();
    render(<WorkspaceDockToggleBar
      orchestrationActive={false}
      orchestrationDisabled={false}
      onToggleOrchestration={vi.fn()}
      terminalActive={false}
      terminalDisabled={false}
      onToggleTerminal={vi.fn()}
      rightRailOpen={false}
      rightRailPendingCount={2}
      onToggleRightRail={onToggleRightRail}
    />);
    expect(screen.getByRole("button", { name: "打开 Agent Office" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 Terminal" })).toBeTruthy();
    expect(screen.queryByText("Agent Office")).toBeNull();
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByRole("button", { name: "更多工作区工具" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("打开工具，2 个待确认"));
    expect(onToggleRightRail).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("decision-pane-shell")).toBeNull();
  });

  it("routes launcher tools without mounting their panels twice", () => {
    const onToolOpen = vi.fn();
    const onCollapse = vi.fn();
    renderShell({ state: { mode: "launcher" }, onToolOpen, onCollapse });
    expect(screen.getByText("工作")).toBeTruthy();
    expect(screen.getByText("支持")).toBeTruthy();
    expect(screen.getByRole("group", { name: "工作" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "支持" })).toBeTruthy();
    expect(screen.getByText("帮助与诊断")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-agent")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-confirm")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-files")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-git")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-diagnostics")).toBeTruthy();
    fireEvent.click(screen.getByTestId("right-tool-launcher-agent"));
    fireEvent.click(screen.getByTestId("decision-pane-collapse"));
    expect(onToolOpen).toHaveBeenCalledWith("agent");
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("keeps shared tools and omits the governance entry when policy hides it", () => {
    renderShell({ showGovernance: false });
    expect(screen.getByTestId("right-tool-launcher-agent")).toBeTruthy();
    expect(screen.queryByTestId("right-tool-launcher-confirm")).toBeNull();
    expect(screen.getByTestId("right-tool-launcher-files")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-git")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-diagnostics")).toBeTruthy();
  });

  it("renders a tool panel and returns to the launcher", () => {
    const onBackToLauncher = vi.fn();
    renderShell({ state: { mode: "tool", tool: "diagnostics" }, onBackToLauncher });
    expect(screen.getByTestId("diagnostics-owner-panel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("right-tool-back"));
    expect(onBackToLauncher).toHaveBeenCalledTimes(1);
  });

  it("renders the Agent resource panel as the sole agent view", () => {
    renderShell({ state: { mode: "tool", tool: "agent" } });
    expect(screen.getByTestId("agent-owner-panel")).toBeTruthy();
    expect(screen.queryByTestId("right-tool-launcher")).toBeNull();
    expect(screen.queryByTestId("decision-pane-collapse")).toBeNull();
    expect(screen.getByTestId("decision-pane-shell").className).toContain("agent-view");
  });
});

function renderShell(overrides: Partial<{
  state: Exclude<RightToolRailState, { mode: "closed" }>;
  pendingCount: number;
  hasPrimary: boolean;
  onCollapse: () => void;
  onToolOpen: (tool: "agent" | "confirm" | "files" | "git" | "diagnostics") => void;
  onBackToLauncher: () => void;
  showGovernance: boolean;
}> = {}) {
  return render(<RightToolRailShell
    state={overrides.state ?? { mode: "launcher" }}
    pendingCount={overrides.pendingCount ?? 1}
    hasPrimary={overrides.hasPrimary ?? false}
    showGovernance={overrides.showGovernance ?? true}
    onCollapse={overrides.onCollapse ?? vi.fn()}
    onToolOpen={overrides.onToolOpen ?? vi.fn()}
    onBackToLauncher={overrides.onBackToLauncher ?? vi.fn()}
    agentPanel={<div data-testid="agent-owner-panel" />}
    confirmPanel={<div data-testid="confirm-owner-panel" />}
    filesPanel={<div data-testid="files-owner-panel" />}
    gitPanel={<div data-testid="git-owner-panel" />}
    diagnosticsPanel={<div data-testid="diagnostics-owner-panel" />}
    resizeMin={280}
    resizeMax={560}
    resizeValue={320}
    onResizeKeyDown={vi.fn()}
  />);
}
