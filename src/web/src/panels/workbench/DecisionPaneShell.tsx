import { Activity, Bot, ChevronLeft, FileText, GitBranch, ListChecks, PanelRightClose } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, PointerEvent as ReactPointerEvent } from "react";

export type RightToolRailTab = "agent" | "confirm" | "files" | "git" | "diagnostics";
export type RightToolRailState =
  | { mode: "closed" }
  | { mode: "launcher" }
  | { mode: "tool"; tool: RightToolRailTab };

const toolLabels: Record<RightToolRailTab, string> = {
  agent: "Agent",
  confirm: "确认事项",
  files: "文件",
  git: "Git",
  diagnostics: "帮助与诊断",
};

export function RightToolRailShell({
  state,
  pendingCount,
  hasPrimary,
  showGovernance = true,
  onCollapse,
  onToolOpen,
  onBackToLauncher,
  agentPanel,
  confirmPanel,
  filesPanel,
  gitPanel,
  diagnosticsPanel,
  resizeMin,
  resizeMax,
  resizeValue,
  onResizeStart,
  onResizeKeyDown,
}: {
  state: Exclude<RightToolRailState, { mode: "closed" }>;
  pendingCount: number;
  hasPrimary: boolean;
  showGovernance?: boolean;
  onCollapse: () => void;
  onToolOpen: (tab: RightToolRailTab) => void;
  onBackToLauncher: () => void;
  agentPanel: ReactNode;
  confirmPanel: ReactNode;
  filesPanel: ReactNode;
  gitPanel: ReactNode;
  diagnosticsPanel: ReactNode;
  resizeMin: number;
  resizeMax: number;
  resizeValue: number;
  onResizeStart?: (event: ReactPointerEvent) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent) => void;
}): ReactElement {
  const activeView = state.mode === "launcher" ? "launcher" : state.tool;
  const panelTitle = activeView === "launcher" ? "工具" : toolLabels[activeView];
  const panelContent =
    activeView === "launcher" ? (
      <RightToolLauncher pendingCount={pendingCount} hasPrimary={hasPrimary} showGovernance={showGovernance} onToolOpen={onToolOpen} />
    ) : activeView === "agent" ? (
      agentPanel
    ) : activeView === "confirm" ? (
      confirmPanel
    ) : activeView === "files" ? (
      filesPanel
    ) : activeView === "git" ? (
      gitPanel
    ) : (
      diagnosticsPanel
    );

  return (
    <aside className={`approval-pane approval-pane-expanded${activeView === "agent" ? " agent-view" : ""}`} data-testid="decision-pane-shell" aria-label="右侧工具面板">
      <div
        className="shell-resize-grip right-rail-resizer"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="调整右侧工具栏宽度"
        aria-valuemin={resizeMin}
        aria-valuemax={resizeMax}
        aria-valuenow={resizeValue}
        aria-valuetext={`${resizeValue} 像素`}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKeyDown}
      />
      {activeView !== "agent" ? <div className="decision-pane-toolbar">
        <div className="decision-pane-toolbar-left">
          {activeView !== "launcher" ? (
            <button
              type="button"
              className="top-tool-button decision-pane-back"
              data-testid="right-tool-back"
              aria-label="返回工具列表"
              onClick={onBackToLauncher}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
          ) : null}
          <span className="decision-pane-title">{panelTitle}</span>
        </div>
        <button
          type="button"
          className="top-tool-button decision-pane-collapse"
          data-testid="decision-pane-collapse"
          aria-label="折叠右侧面板"
          aria-expanded="true"
          onClick={onCollapse}
        >
          <PanelRightClose size={18} aria-hidden="true" />
        </button>
      </div> : null}
      <div className={`decision-pane-content${activeView === "agent" ? " agent-content" : ""}`}>{panelContent}</div>
    </aside>
  );
}

function RightToolLauncher({
  pendingCount,
  hasPrimary,
  showGovernance,
  onToolOpen,
}: {
  pendingCount: number;
  hasPrimary: boolean;
  showGovernance: boolean;
  onToolOpen: (tab: RightToolRailTab) => void;
}): ReactElement {
  return (
    <div className="right-tool-launcher" data-testid="right-tool-launcher" aria-label="右侧工具入口">
      <div className="right-tool-launcher-list">
        <span className="right-tool-launcher-group-label">工作</span>
        <button
          type="button"
          className="right-tool-launcher-item"
          data-testid="right-tool-launcher-agent"
          onClick={() => onToolOpen("agent")}
        >
          <Bot size={17} aria-hidden="true" />
          <span>Agent</span>
        </button>
        {showGovernance ? <button
          type="button"
          className={`right-tool-launcher-item${hasPrimary ? " has-primary" : ""}`}
          data-testid="right-tool-launcher-confirm"
          onClick={() => onToolOpen("confirm")}
        >
          <ListChecks size={17} aria-hidden="true" />
          <span>确认事项</span>
          {pendingCount > 0 ? <span className="right-tool-launcher-badge">{pendingCount}</span> : null}
        </button> : null}
        <button
          type="button"
          className="right-tool-launcher-item"
          data-testid="right-tool-launcher-files"
          onClick={() => onToolOpen("files")}
        >
          <FileText size={17} aria-hidden="true" />
          <span>文件</span>
        </button>
        <button
          type="button"
          className="right-tool-launcher-item"
          data-testid="right-tool-launcher-git"
          onClick={() => onToolOpen("git")}
        >
          <GitBranch size={17} aria-hidden="true" />
          <span>Git</span>
        </button>
        <span className="right-tool-launcher-group-label support">支持</span>
        <button
          type="button"
          className="right-tool-launcher-item"
          data-testid="right-tool-launcher-diagnostics"
          onClick={() => onToolOpen("diagnostics")}
        >
          <Activity size={17} aria-hidden="true" />
          <span>帮助与诊断</span>
        </button>
      </div>
    </div>
  );
}
