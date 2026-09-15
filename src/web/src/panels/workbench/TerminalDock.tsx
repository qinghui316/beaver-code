import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { postJson } from "../../api.js";
import { userFacingErrorMessage } from "../../presentation/user-facing-language.js";

export interface TerminalTab {
  id: string;
  title: string;
}

interface TerminalSession {
  projectId: string;
  terminalId: string;
  cwd: string;
  shell: string;
}

type TerminalEventFrame =
  | { event: "output"; data: { type: "output"; data: string } }
  | { event: "exit"; data: { type: "exit"; exitCode: number; signal?: number } }
  | { event: "terminal-error"; data: { type: "error"; message: string } };

const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

export function TerminalDock({
  projectId,
  open,
  height,
  tabs,
  activeTabId,
  onOpen,
  onCollapse,
  onHeightChange,
  onNewTab,
  onSelectTab,
  onCloseTab,
}: {
  projectId: string | null;
  open: boolean;
  height: number;
  tabs: TerminalTab[];
  activeTabId: string | null;
  onOpen: () => void;
  onCollapse: () => void;
  onHeightChange: (height: number) => void;
  onNewTab: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}): ReactElement | null {
  const [resizing, setResizing] = useState(false);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  useEffect(() => {
    if (!resizing) return;
    const handleMove = (event: MouseEvent): void => {
      onHeightChange(Math.max(180, Math.min(520, window.innerHeight - event.clientY)));
    };
    const handleUp = (): void => setResizing(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp, { once: true });
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [onHeightChange, resizing]);

  if (!open) return null;

  return (
    <section className="terminal-dock" style={{ height }} data-testid="terminal-dock" aria-label="项目终端">
      <div
        className="terminal-dock-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整终端高度"
        onMouseDown={(event: ReactMouseEvent) => {
          event.preventDefault();
          setResizing(true);
        }}
      />
      <div className="terminal-dock-header">
        <button type="button" className="icon-button terminal-dock-collapse" onClick={onCollapse} aria-label="收起终端">
          <SquareTerminal size={15} aria-hidden="true" />
        </button>
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {tabs.map((tab) => (
            <span className={`terminal-tab-item${tab.id === activeTabId ? " active" : ""}`} key={tab.id}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                className="terminal-tab"
                title={tab.title}
                onClick={() => onSelectTab(tab.id)}
              >
                <span>{tab.title}</span>
              </button>
              <button type="button" className="terminal-tab-close" aria-label={`关闭 ${tab.title}`} onClick={() => onCloseTab(tab.id)}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <button type="button" className="terminal-tab-add" onClick={onNewTab} aria-label="新建终端">
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="terminal-dock-body">
        {projectId && activeTab ? (
          <TerminalPane key={`${projectId}:${activeTab.id}`} projectId={projectId} terminalId={activeTab.id} onOpen={onOpen} />
        ) : (
          <div className="terminal-empty">选择项目后可打开终端。</div>
        )}
      </div>
    </section>
  );
}

function TerminalPane({ projectId, terminalId, onOpen }: { projectId: string; terminalId: string; onOpen: () => void }): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<"connecting" | "ready" | "closed" | "error">("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const openPayload = useMemo(() => ({ terminalId, cols: 80, rows: 24 }), [terminalId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      convertEol: true,
      theme: {
        background: "#fbfbfa",
        foreground: "#202124",
        cursor: "#111827",
        selectionBackground: "#dbeafe",
        black: "#202124",
        brightBlack: "#6b7280",
        blue: "#2563eb",
        brightBlue: "#1d4ed8",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const fitTerminal = (): void => {
      try {
        fit.fit();
        void postJson(`/api/projects/${encodeURIComponent(projectId)}/terminal/sessions/${encodeURIComponent(terminalId)}/resize`, {
          cols: terminal.cols,
          rows: terminal.rows,
        }).catch(() => undefined);
      } catch {
        // xterm can throw while hidden; the next resize/open will fit again.
      }
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(fitTerminal) : null;
    resizeObserver?.observe(host);
    window.setTimeout(fitTerminal, 0);

    const dataDisposable = terminal.onData((data) => {
      void postJson(`/api/projects/${encodeURIComponent(projectId)}/terminal/sessions/${encodeURIComponent(terminalId)}/write`, { data })
        .catch((cause: unknown) => setMessage(userFacingErrorMessage(cause, "terminal")));
    });

    let disposed = false;
    let openTimedOut = false;
    const openTimeout = window.setTimeout(() => {
      if (disposed) return;
      openTimedOut = true;
      setStatus("error");
      setMessage("终端连接超时。请确认 Workbench 服务仍在运行，或重新打开终端。");
    }, TERMINAL_OPEN_TIMEOUT_MS);
    void postJson<{ session: TerminalSession }>(`/api/projects/${encodeURIComponent(projectId)}/terminal/sessions`, openPayload)
      .then(() => {
        if (disposed) return;
        window.clearTimeout(openTimeout);
        if (openTimedOut) {
          void fetch(`/api/projects/${encodeURIComponent(projectId)}/terminal/sessions/${encodeURIComponent(terminalId)}`, { method: "DELETE" });
          return;
        }
        setStatus("ready");
        setMessage(null);
        onOpen();
        fitTerminal();
        const events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/terminal/sessions/${encodeURIComponent(terminalId)}/events`);
        eventSourceRef.current = events;
        events.addEventListener("output", (event) => {
          const frame = parseTerminalEvent(event);
          if (frame?.event === "output") terminal.write(frame.data.data);
        });
        events.addEventListener("exit", (event) => {
          const frame = parseTerminalEvent(event);
          if (frame?.event === "exit") {
            setStatus("closed");
            setMessage(`终端已退出（${frame.data.exitCode}）。`);
          }
        });
        events.addEventListener("terminal-error", (event) => {
          const frame = parseTerminalEvent(event);
          if (frame?.event === "terminal-error") {
            setStatus("error");
            setMessage(userFacingErrorMessage(new Error(frame.data.message), "terminal"));
          }
        });
        events.onerror = () => {
          setStatus((current) => (current === "closed" ? current : "error"));
          setMessage("终端输出连接已断开。");
        };
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        window.clearTimeout(openTimeout);
        setStatus("error");
        setMessage(userFacingErrorMessage(cause, "terminal"));
      });

    return () => {
      disposed = true;
      window.clearTimeout(openTimeout);
      dataDisposable.dispose();
      resizeObserver?.disconnect();
      eventSourceRef.current?.close();
      terminal.dispose();
      eventSourceRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [onOpen, openPayload, projectId, retryGeneration, terminalId]);

  return (
    <div className="terminal-pane">
      <div ref={hostRef} className="terminal-xterm" data-testid="terminal-xterm" />
      {status !== "ready" || message ? (
        <div className={`terminal-overlay ${status}`} role={status === "error" ? "alert" : "status"}>
          <strong>{status === "connecting" ? "正在连接终端" : status === "closed" ? "终端已关闭" : "终端不可用"}</strong>
          {message ? <span>{message}</span> : null}
          {status === "error" ? <button type="button" className="outline-button" onClick={() => { setStatus("connecting"); setMessage(null); setRetryGeneration((current) => current + 1); }}>重新连接</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function parseTerminalEvent(event: Event): TerminalEventFrame | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    const payload = JSON.parse(event.data) as TerminalEventFrame["data"];
    if (payload.type === "output") return { event: "output", data: payload };
    if (payload.type === "exit") return { event: "exit", data: payload };
    if (payload.type === "error") return { event: "terminal-error", data: payload };
  } catch {
    return null;
  }
  return null;
}
