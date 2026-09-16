import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { GitBranch, MoreHorizontal, PanelRightOpen, SquareTerminal } from "lucide-react";
import type { ReactElement } from "react";
import { WORKSPACE_TOOLS } from "../../presentation/core-workbench-experience.js";
import { ToolbarIconButton } from "../../shell/ToolbarIconButton.js";

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
      <div className="workspace-dock-direct">
        <ToolbarIconButton
        active={orchestrationActive}
        className={`top-tool-button workspace-orchestration-toggle${orchestrationNeedsAttention ? " attention" : ""}`}
        data-testid="orchestration-overlay-toggle"
        disabled={orchestrationDisabled}
        aria-pressed={orchestrationActive}
        aria-label={orchestrationNeedsAttention ? "Agent Office，需要你处理" : orchestrationActive ? WORKSPACE_TOOLS.office.closeLabel : WORKSPACE_TOOLS.office.openLabel}
        title={orchestrationNeedsAttention ? "Agent Office 需要你处理" : orchestrationActive ? WORKSPACE_TOOLS.office.closeLabel : WORKSPACE_TOOLS.office.openLabel}
        onClick={onToggleOrchestration}
      >
        <GitBranch size={16} aria-hidden="true" />
        </ToolbarIconButton>
        <ToolbarIconButton
        active={terminalActive}
        className="top-tool-button workspace-dock-toggle"
        data-testid="terminal-dock-toggle"
        disabled={terminalDisabled}
        aria-pressed={terminalActive}
        aria-label={terminalActive ? WORKSPACE_TOOLS.terminal.closeLabel : WORKSPACE_TOOLS.terminal.openLabel}
        title={terminalActive ? WORKSPACE_TOOLS.terminal.closeLabel : WORKSPACE_TOOLS.terminal.openLabel}
        onClick={onToggleTerminal}
      >
        <SquareTerminal size={16} aria-hidden="true" />
        </ToolbarIconButton>
        <ToolbarIconButton
        active={rightRailOpen}
        className="top-tool-button workspace-right-rail-toggle"
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
        {rightRailPendingCount > 0 ? <span className="decision-pane-badge">{rightRailPendingCount}</span> : null}
        </ToolbarIconButton>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <ToolbarIconButton
            className="top-tool-button workspace-dock-overflow"
            aria-label="更多工作区工具"
            title="更多工作区工具"
          >
            <MoreHorizontal size={18} aria-hidden="true" />
            {orchestrationNeedsAttention || rightRailPendingCount > 0
              ? <span className="decision-pane-badge">{rightRailPendingCount > 0 ? rightRailPendingCount : ""}</span>
              : null}
          </ToolbarIconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="workspace-dock-overflow-menu" side="bottom" align="end" sideOffset={6} collisionPadding={8}>
            <WorkspaceToolMenuItem
              icon={<GitBranch size={16} aria-hidden="true" />}
              label={orchestrationNeedsAttention ? "Agent Office 需要你处理" : orchestrationActive ? WORKSPACE_TOOLS.office.closeLabel : WORKSPACE_TOOLS.office.openLabel}
              disabled={orchestrationDisabled}
              active={orchestrationActive}
              onSelect={onToggleOrchestration}
            />
            <WorkspaceToolMenuItem
              icon={<SquareTerminal size={16} aria-hidden="true" />}
              label={terminalActive ? WORKSPACE_TOOLS.terminal.closeLabel : WORKSPACE_TOOLS.terminal.openLabel}
              disabled={terminalDisabled}
              active={terminalActive}
              onSelect={onToggleTerminal}
            />
            <WorkspaceToolMenuItem
              icon={<PanelRightOpen size={16} aria-hidden="true" />}
              label={rightRailOpen
                ? WORKSPACE_TOOLS.tools.closeLabel
                : rightRailPendingCount > 0
                  ? `${WORKSPACE_TOOLS.tools.openLabel}，${rightRailPendingCount} 个待确认`
                  : WORKSPACE_TOOLS.tools.openLabel}
              active={rightRailOpen}
              onSelect={onToggleRightRail}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function WorkspaceToolMenuItem({
  icon,
  label,
  disabled = false,
  active = false,
  onSelect,
}: {
  icon: ReactElement;
  label: string;
  disabled?: boolean;
  active?: boolean;
  onSelect: () => void;
}): ReactElement {
  return <DropdownMenu.Item
    className="workspace-dock-overflow-item"
    disabled={disabled}
    data-active={active || undefined}
    onSelect={onSelect}
  >
    {icon}
    <span>{label}</span>
  </DropdownMenu.Item>;
}
