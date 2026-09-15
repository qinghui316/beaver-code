import { GitBranch, PanelRightOpen, SquareTerminal } from "lucide-react";
import type { ReactElement } from "react";
import { WORKSPACE_TOOLS } from "../../presentation/core-workbench-experience.js";

export function WorkspaceDockToggleBar({
  orchestrationActive,
  orchestrationNeedsAttention,
  orchestrationDisabled,
  onToggleOrchestration,
  terminalActive,
  terminalDisabled,
  onToggleTerminal,
  rightRailOpen,
  rightRailPendingCount,
  onToggleRightRail,
}: {
  orchestrationActive: boolean;
  orchestrationNeedsAttention?: boolean;
  orchestrationDisabled: boolean;
  onToggleOrchestration: () => void;
  terminalActive: boolean;
  terminalDisabled: boolean;
  onToggleTerminal: () => void;
  rightRailOpen: boolean;
  rightRailPendingCount: number;
  onToggleRightRail: () => void;
}): ReactElement {
  return (
    <div className="workspace-dock-toggle-bar" aria-label="工作区工具">
      <button
        type="button"
        className={`top-tool-button workspace-orchestration-toggle${orchestrationActive ? " active" : ""}${orchestrationNeedsAttention ? " attention" : ""}`}
        data-testid="orchestration-overlay-toggle"
        disabled={orchestrationDisabled}
        aria-pressed={orchestrationActive}
        aria-label={orchestrationNeedsAttention ? "Agent Office，需要你处理" : orchestrationActive ? WORKSPACE_TOOLS.office.closeLabel : WORKSPACE_TOOLS.office.openLabel}
        title={orchestrationNeedsAttention ? "Agent Office 需要你处理" : orchestrationActive ? WORKSPACE_TOOLS.office.closeLabel : WORKSPACE_TOOLS.office.openLabel}
        onClick={onToggleOrchestration}
      >
        <GitBranch size={16} aria-hidden="true" />
        <span className="workspace-tool-label">{WORKSPACE_TOOLS.office.label}</span>
      </button>
      <button
        type="button"
        className={`top-tool-button workspace-dock-toggle${terminalActive ? " active" : ""}`}
        data-testid="terminal-dock-toggle"
        disabled={terminalDisabled}
        aria-pressed={terminalActive}
        aria-label={terminalActive ? WORKSPACE_TOOLS.terminal.closeLabel : WORKSPACE_TOOLS.terminal.openLabel}
        title={terminalActive ? WORKSPACE_TOOLS.terminal.closeLabel : WORKSPACE_TOOLS.terminal.openLabel}
        onClick={onToggleTerminal}
      >
        <SquareTerminal size={16} aria-hidden="true" />
        <span className="workspace-tool-label">{WORKSPACE_TOOLS.terminal.label}</span>
      </button>
      <button
        type="button"
        className={`top-tool-button workspace-right-rail-toggle${rightRailOpen ? " active" : ""}`}
        data-testid="right-tool-rail-toggle"
        aria-expanded={rightRailOpen}
        aria-label={rightRailOpen
          ? WORKSPACE_TOOLS.tools.closeLabel
          : rightRailPendingCount > 0
            ? `${WORKSPACE_TOOLS.tools.openLabel}，${rightRailPendingCount} 个待确认`
            : WORKSPACE_TOOLS.tools.openLabel}
        title={rightRailOpen ? WORKSPACE_TOOLS.tools.closeLabel : WORKSPACE_TOOLS.tools.openLabel}
        onClick={onToggleRightRail}
      >
        <PanelRightOpen size={16} aria-hidden="true" />
        <span className="workspace-tool-label">{WORKSPACE_TOOLS.tools.label}</span>
        {rightRailPendingCount > 0 ? <span className="decision-pane-badge">{rightRailPendingCount}</span> : null}
      </button>
    </div>
  );
}
