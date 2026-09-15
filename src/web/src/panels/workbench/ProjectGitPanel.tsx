import { ArrowLeft, ChevronDown, ChevronRight, FileText, GitCommit, Link2, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type PointerEvent, type ReactElement } from "react";
import { fetchJson } from "../../api.js";
import { userFacingErrorMessage } from "../../presentation/user-facing-language.js";
import type { ProjectGitCommitDetailResult, ProjectGitCommitDiffResult, ProjectGitCommitFileChange, ProjectGitFileStatus, ProjectGitHistoryCommit, ProjectGitHistoryResult, ProjectGitStatusResult, TopicFileReference } from "../../types.js";
import { GitDiffViewer } from "./GitDiffViewer.js";

export function ProjectGitPanel({
  projectId,
  selectedPath,
  selectedRefs,
  onSelectedPathChange,
  onSelectedRefsChange,
}: {
  projectId: string | null;
  selectedPath: string | null;
  selectedRefs: TopicFileReference[];
  onSelectedPathChange: (relativePath: string) => void;
  onSelectedRefsChange: (refs: TopicFileReference[]) => void;
}): ReactElement {
  const [status, setStatus] = useState<ProjectGitStatusResult | null>(null);
  const [railView, setRailView] = useState<"changes" | "history">("changes");
  const [history, setHistory] = useState<ProjectGitHistoryResult | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<ProjectGitCommitDetailResult | null>(null);
  const [commitDetailLoading, setCommitDetailLoading] = useState(false);
  const [commitDetailError, setCommitDetailError] = useState<string | null>(null);
  const [selectedCommitFile, setSelectedCommitFile] = useState<ProjectGitCommitFileChange | null>(null);
  const [commitDiff, setCommitDiff] = useState<ProjectGitCommitDiffResult | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<ProjectGitFileStatus["group"]>>(new Set());

  async function loadStatus(): Promise<void> {
    if (!projectId) return;
    setLoading(true);
    setFailureMessage(null);
    try {
      setStatus(await fetchJson<ProjectGitStatusResult>(`/api/projects/${encodeURIComponent(projectId)}/git/status`));
    } catch (err) {
      setFailureMessage(userFacingErrorMessage(err, "git"));
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory(offset = 0): Promise<void> {
    if (!projectId) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const url = `/api/projects/${encodeURIComponent(projectId)}/git/history?limit=30&offset=${offset}&query=${encodeURIComponent(historyQuery.trim())}`;
      const next = await fetchJson<ProjectGitHistoryResult>(url);
      setHistory((current) => offset > 0 && current
        ? { ...next, commits: [...current.commits, ...next.commits] }
        : next);
    } catch (err) {
      setHistoryError(userFacingErrorMessage(err, "git"));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadCommitDetail(sha: string): Promise<void> {
    if (!projectId) return;
    setCommitDetailLoading(true);
    setCommitDetailError(null);
    setCommitDetail(null);
    try {
      setCommitDetail(await fetchJson<ProjectGitCommitDetailResult>(`/api/projects/${encodeURIComponent(projectId)}/git/commit?sha=${encodeURIComponent(sha)}`));
    } catch (err) {
      setCommitDetailError(userFacingErrorMessage(err, "git"));
    } finally {
      setCommitDetailLoading(false);
    }
  }

  async function loadCommitDiff(sha: string, path: string): Promise<void> {
    if (!projectId) return;
    setCommitDiffLoading(true);
    setCommitDiffError(null);
    setCommitDiff(null);
    try {
      setCommitDiff(await fetchJson<ProjectGitCommitDiffResult>(
        `/api/projects/${encodeURIComponent(projectId)}/git/commit-diff?sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(path)}`,
      ));
    } catch (err) {
      setCommitDiffError(userFacingErrorMessage(err, "git"));
    } finally {
      setCommitDiffLoading(false);
    }
  }

  function insertReference(file: ProjectGitFileStatus): void {
    if (selectedRefs.some((item) => item.relativePath === file.relativePath)) return;
    onSelectedRefsChange([...selectedRefs, {
      relativePath: file.relativePath,
      name: file.name,
      kind: "file",
      source: "composer",
    }]);
  }

  function openGitRowFromEvent(target: EventTarget | null): void {
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-git-ref-button]")) return;
    const row = target.closest<HTMLElement>("[data-git-file-path]");
    const relativePath = row?.dataset.gitFilePath;
    if (!relativePath) return;
    onSelectedPathChange(relativePath);
  }

  function handleGitRowPointerDown(event: PointerEvent<HTMLElement>): void {
    openGitRowFromEvent(event.target);
  }

  function handleGitRowMouseDown(event: MouseEvent<HTMLElement>): void {
    if ((event.target as HTMLElement | null)?.closest("[data-git-ref-button]")) return;
    openGitRowFromEvent(event.target);
  }

  useEffect(() => {
    void loadStatus();
    setSelectedCommitSha(null);
    setSelectedCommitFile(null);
  }, [projectId]);

  useEffect(() => {
    if (railView === "history") void loadHistory(0);
  }, [railView, projectId]);

  useEffect(() => {
    if (selectedCommitSha) void loadCommitDetail(selectedCommitSha);
  }, [selectedCommitSha]);

  useEffect(() => {
    if (selectedCommitSha && selectedCommitFile) void loadCommitDiff(selectedCommitSha, selectedCommitFile.relativePath);
  }, [selectedCommitSha, selectedCommitFile?.relativePath]);

  const dirtyCount = useMemo(() => (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0), [status]);
  const hasChanges = Boolean(status && dirtyCount > 0);

  function toggleGroup(group: ProjectGitFileStatus["group"]): void {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  if (!projectId) {
    return <div className="project-git-panel empty-state" data-testid="project-git-panel">选择项目后可查看 Git 状态。</div>;
  }

  return (
    <section
      className="project-git-panel"
      data-testid="project-git-panel"
      aria-label="Git 状态"
      onPointerDownCapture={handleGitRowPointerDown}
      onMouseDownCapture={handleGitRowMouseDown}
    >
      <div className="project-git-subnav" aria-label="Git 子视图">
        <button type="button" className={railView === "changes" ? "active" : ""} onClick={() => setRailView("changes")}>变更</button>
        <button type="button" className={railView === "history" ? "active" : ""} onClick={() => setRailView("history")}>历史</button>
      </div>
      {railView === "history" ? (
        <GitHistoryRail
          history={history}
          query={historyQuery}
          loading={historyLoading}
          failureMessage={historyError}
          selectedCommitSha={selectedCommitSha}
          detail={commitDetail}
          detailLoading={commitDetailLoading}
          detailError={commitDetailError}
          selectedFile={selectedCommitFile}
          diff={commitDiff}
          diffLoading={commitDiffLoading}
          diffError={commitDiffError}
          onQueryChange={setHistoryQuery}
          onSearch={() => {
            setSelectedCommitSha(null);
            setSelectedCommitFile(null);
            void loadHistory(0);
          }}
          onRefresh={() => {
            if (selectedCommitFile && selectedCommitSha) {
              void loadCommitDiff(selectedCommitSha, selectedCommitFile.relativePath);
            } else if (selectedCommitSha) {
              void loadCommitDetail(selectedCommitSha);
            } else {
              void loadHistory(0);
            }
          }}
          onLoadMore={() => void loadHistory(history?.commits.length ?? 0)}
          onSelectCommit={(sha) => {
            setSelectedCommitSha(sha);
            setSelectedCommitFile(null);
          }}
          onBackToList={() => {
            setSelectedCommitSha(null);
            setSelectedCommitFile(null);
          }}
          onSelectFile={(file) => setSelectedCommitFile(file)}
          onBackToDetail={() => setSelectedCommitFile(null)}
        />
      ) : (
        <>
      <header className="project-git-header" data-testid="project-git-compact-header">
        <div className="project-git-header-copy">
          <div className="project-git-header-main">
            <strong>{status?.isGitRepository ? status.branch ?? "未命名分支" : "Git"}</strong>
            {status?.isGitRepository ? (
              <span className={status.dirty ? "dirty" : "clean"}>{status.dirty ? "有变更" : "干净"}</span>
            ) : null}
          </div>
          <div className="project-git-header-meta">
            <span>{status?.isGitRepository ? `${dirtyCount} 个变更` : "只读状态"}</span>
            {status?.isGitRepository ? <span className="diff-stats">+{status.totalAdditions} -{status.totalDeletions}</span> : null}
          </div>
        </div>
        <button type="button" className="icon-button" aria-label="刷新 Git 状态" data-testid="project-git-refresh" onClick={() => void loadStatus()}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </header>

      {failureMessage ? <div className="project-files-error">{failureMessage}</div> : null}
      {loading ? <div className="project-files-empty">正在读取 Git 状态...</div> : null}
      {!loading && status && !status.isGitRepository ? (
        <div className="project-git-empty">{status.message ?? "当前项目不是 Git 仓库。"}</div>
      ) : null}
      {!loading && status?.isGitRepository ? (
        <>
          {!hasChanges ? <div className="project-git-empty compact">当前工作区没有 Git 变更。</div> : null}
          <GitFileGroup
            title="已暂存"
            group="staged"
            files={status.staged}
            collapsed={collapsedGroups.has("staged")}
            onToggle={() => toggleGroup("staged")}
            selectedPath={selectedPath}
            onSelectedPathChange={onSelectedPathChange}
            onInsertReference={insertReference}
          />
          <GitFileGroup
            title="未暂存"
            group="unstaged"
            files={status.unstaged}
            collapsed={collapsedGroups.has("unstaged")}
            onToggle={() => toggleGroup("unstaged")}
            selectedPath={selectedPath}
            onSelectedPathChange={onSelectedPathChange}
            onInsertReference={insertReference}
          />
          <GitFileGroup
            title="未跟踪"
            group="untracked"
            files={status.untracked}
            collapsed={collapsedGroups.has("untracked")}
            onToggle={() => toggleGroup("untracked")}
            selectedPath={selectedPath}
            onSelectedPathChange={onSelectedPathChange}
            onInsertReference={insertReference}
          />
          <GitDiffViewer projectId={projectId} selectedPath={selectedPath} variant="rail" />
        </>
      ) : null}
        </>
      )}
    </section>
  );
}

function GitHistoryRail({
  history,
  query,
  loading,
  failureMessage,
  selectedCommitSha,
  detail,
  detailLoading,
  detailError,
  selectedFile,
  diff,
  diffLoading,
  diffError,
  onQueryChange,
  onSearch,
  onRefresh,
  onLoadMore,
  onSelectCommit,
  onBackToList,
  onSelectFile,
  onBackToDetail,
}: {
  history: ProjectGitHistoryResult | null;
  query: string;
  loading: boolean;
  failureMessage: string | null;
  selectedCommitSha: string | null;
  detail: ProjectGitCommitDetailResult | null;
  detailLoading: boolean;
  detailError: string | null;
  selectedFile: ProjectGitCommitFileChange | null;
  diff: ProjectGitCommitDiffResult | null;
  diffLoading: boolean;
  diffError: string | null;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onSelectCommit: (sha: string) => void;
  onBackToList: () => void;
  onSelectFile: (file: ProjectGitCommitFileChange) => void;
  onBackToDetail: () => void;
}): ReactElement {
  if (selectedCommitSha && selectedFile) {
    return (
      <section className="project-git-history-detail" data-testid="project-git-history-diff">
        <RailBackHeader title={selectedFile.name} subtitle={selectedFile.relativePath} onBack={onBackToDetail} onRefresh={onRefresh} />
        {diffError ? <div className="project-files-error">{diffError}</div> : null}
        {diffLoading ? <div className="project-files-empty">正在读取历史 diff...</div> : null}
        {!diffLoading && diff ? <CommitDiffPreview diff={diff} /> : null}
      </section>
    );
  }
  if (selectedCommitSha) {
    return (
      <section className="project-git-history-detail" data-testid="project-git-history-detail">
        <RailBackHeader title={detail?.shortSha ?? selectedCommitSha.slice(0, 12)} subtitle={detail?.summary ?? "提交详情"} onBack={onBackToList} onRefresh={onRefresh} />
        {detailError ? <div className="project-files-error">{detailError}</div> : null}
        {detailLoading ? <div className="project-files-empty">正在读取提交详情...</div> : null}
        {!detailLoading && detail?.status !== "ok" ? (
          <div className="project-git-empty">{detail?.message ?? "无法读取提交详情。"}</div>
        ) : null}
        {!detailLoading && detail?.status === "ok" ? (
          <>
            <div className="project-git-commit-card">
              <strong>{detail.summary || "(no message)"}</strong>
              <div className="project-git-commit-meta">
                <code>{detail.shortSha}</code>
                <span>{detail.author || "unknown"}</span>
                <time>{formatDate(detail.timestamp)}</time>
                <span>+{detail.totalAdditions ?? 0} -{detail.totalDeletions ?? 0}</span>
              </div>
              {commitBody(detail.summary, detail.message) ? <pre>{commitBody(detail.summary, detail.message)}</pre> : null}
            </div>
            <div className="project-git-history-section-title">文件 {detail.files.length}</div>
            <div className="project-git-history-file-list">
              {detail.files.map((file) => (
                <HistoryFileRow key={`${detail.sha}:${file.relativePath}`} file={file} onSelect={() => onSelectFile(file)} />
              ))}
            </div>
          </>
        ) : null}
      </section>
    );
  }
  return (
    <section className="project-git-history" data-testid="project-git-history">
      <header className="project-git-history-header">
        <div className="project-git-header-copy">
          <div className="project-git-header-main">
            <strong>{history?.branch ?? "Git 历史"}</strong>
            {history?.head ? <code>{history.head}</code> : null}
          </div>
          <div className="project-git-header-meta">
            <span>{history?.status === "ok" ? `${history.total} 个 Git 提交` : "只读历史"}</span>
          </div>
        </div>
        <button type="button" className="icon-button" aria-label="刷新历史" onClick={onRefresh}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </header>
      <form className="project-git-history-search" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <Search size={13} aria-hidden="true" />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索历史" />
      </form>
      {failureMessage ? <div className="project-files-error">{failureMessage}</div> : null}
      {loading ? <div className="project-files-empty">正在读取 Git 历史...</div> : null}
      {!loading && history?.status !== "ok" ? (
        <div className="project-git-empty">{history?.message ?? "无法读取 Git 历史。"}</div>
      ) : null}
      {!loading && history?.status === "ok" && history.commits.length === 0 ? (
        <div className="project-git-empty compact">没有匹配的历史。</div>
      ) : null}
      <div className="project-git-commit-list">
        {history?.commits.map((commit) => (
          <HistoryCommitRow key={commit.sha} commit={commit} selected={selectedCommitSha === commit.sha} onSelect={() => onSelectCommit(commit.sha)} />
        ))}
      </div>
      {history?.hasMore ? (
        <button type="button" className="project-git-history-more" disabled={loading} onClick={onLoadMore}>
          加载更多
        </button>
      ) : null}
    </section>
  );
}

function RailBackHeader({ title, subtitle, onBack, onRefresh }: { title: string; subtitle: string; onBack: () => void; onRefresh: () => void }): ReactElement {
  return (
    <header className="project-git-history-header">
      <button type="button" className="icon-button" aria-label="返回 Git 历史" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
      </button>
      <div className="project-git-header-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <button type="button" className="icon-button" aria-label="刷新历史详情" onClick={onRefresh}>
        <RefreshCw size={15} aria-hidden="true" />
      </button>
    </header>
  );
}

function HistoryCommitRow({ commit, selected, onSelect }: { commit: ProjectGitHistoryCommit; selected: boolean; onSelect: () => void }): ReactElement {
  return (
    <button type="button" className={`project-git-commit-row ${selected ? "selected" : ""}`} data-testid="project-git-history-row" aria-label={`打开提交 ${commit.shortSha}`} onClick={onSelect}>
      <span className="project-git-commit-graph" aria-hidden="true"><GitCommit size={13} /></span>
      <span className="project-git-commit-text">
        <span className="project-git-commit-summary">{commit.summary}</span>
        <span className="project-git-commit-meta">
          <code>{commit.shortSha}</code>
          <span>{commit.author || "unknown"}</span>
          <time>{formatDate(commit.timestamp)}</time>
        </span>
      </span>
      <span className="project-git-counts">+{commit.additions} -{commit.deletions}</span>
    </button>
  );
}

function HistoryFileRow({ file, onSelect }: { file: ProjectGitCommitFileChange; onSelect: () => void }): ReactElement {
  const pathParts = splitPath(file.relativePath);
  return (
    <button type="button" className="project-git-history-file-row" aria-label={`查看 ${file.relativePath} 的历史 diff`} onClick={onSelect}>
      <span className={`project-git-status ${statusClassFromSymbol(file.status)}`}>({file.status})</span>
      <span className="project-git-file-icon" aria-hidden="true"><FileText size={14} /></span>
      <span className="project-git-file-text">
        <span className="project-git-file-name">{pathParts.name}</span>
        {pathParts.dir ? <span className="project-git-file-dir">{pathParts.dir}</span> : null}
      </span>
      <span className="project-git-counts">+{file.additions} -{file.deletions}</span>
    </button>
  );
}

function CommitDiffPreview({ diff }: { diff: ProjectGitCommitDiffResult }): ReactElement {
  if (diff.status !== "text" && diff.status !== "too-large") {
    return (
      <div className="git-diff-empty">
        <strong>{diff.name}</strong>
        <span>{diff.message ?? "此文件没有可显示的文本 diff。"}</span>
      </div>
    );
  }
  return (
    <div className="git-diff-content project-git-history-diff-content">
      {diff.message ? <div className="project-files-note">{diff.message}</div> : null}
      <div className="git-diff-stats">+{diff.additions ?? 0} -{diff.deletions ?? 0}</div>
      <section className="git-diff-section">
        <h3>历史 diff{diff.truncated ? " · 已截断" : ""}</h3>
        <pre>
          {diff.patch.split(/\n/).map((line, index) => (
            <span key={`history-diff:${index}`} className={diffLineClass(line)}>{line || " "}</span>
          ))}
        </pre>
      </section>
    </div>
  );
}

function GitFileGroup({
  title,
  group,
  files,
  collapsed,
  onToggle,
  selectedPath,
  onSelectedPathChange,
  onInsertReference,
}: {
  title: string;
  group: ProjectGitFileStatus["group"];
  files: ProjectGitFileStatus[];
  collapsed: boolean;
  onToggle: () => void;
  selectedPath: string | null;
  onSelectedPathChange: (relativePath: string) => void;
  onInsertReference: (file: ProjectGitFileStatus) => void;
}): ReactElement {
  if (files.length === 0) return <></>;
  return (
    <section className="project-git-group" data-git-group={group}>
      <button type="button" className="project-git-group-header" onClick={onToggle} aria-expanded={!collapsed}>
        <span>
          {collapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
          {title}
        </span>
        <small>{files.length}</small>
      </button>
      {!collapsed ? files.map((file) => (
        <GitFileRow
          key={`${file.group}:${file.relativePath}`}
          file={file}
          selected={selectedPath === file.relativePath}
          onSelect={() => onSelectedPathChange(file.relativePath)}
          onInsertReference={() => onInsertReference(file)}
        />
      )) : null}
    </section>
  );
}

function GitFileRow({
  file,
  selected,
  onSelect,
  onInsertReference,
}: {
  file: ProjectGitFileStatus;
  selected: boolean;
  onSelect: () => void;
  onInsertReference: () => void;
}): ReactElement {
  const pathParts = splitPath(file.relativePath);
  const counts = formatCounts(file);
  const status = gitFileStatusPresentation(file);
  return (
    <div
      className={`project-git-row ${selected ? "selected" : ""}`}
      data-testid="project-git-file-row"
      data-git-file-path={file.relativePath}
      data-git-status={status.symbol}
      title={file.relativePath}
    >
      <button type="button" className="project-git-file-button" aria-label={`${file.relativePath}，${status.label}`} onClick={onSelect}>
        <span className={`project-git-status ${status.className}`} title={status.label} aria-hidden="true">{status.symbol}</span>
        <span className="project-git-file-icon" aria-hidden="true">
          <FileText size={14} />
        </span>
        <span className="project-git-file-text">
          <span className="project-git-file-name">{pathParts.name}</span>
          {pathParts.dir ? <span className="project-git-file-dir">{pathParts.dir}</span> : null}
        </span>
        {counts ? <span className="project-git-counts">{counts}</span> : null}
      </button>
      <button
        type="button"
        className="project-git-ref-button"
        data-git-ref-button
        aria-label={`引用 ${file.relativePath} 到输入框`}
        title="引用到输入框"
        onClick={onInsertReference}
      >
        <Link2 size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

function splitPath(path: string): { name: string; dir: string } {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length === 0) return { name: path, dir: "" };
  return {
    name: parts[parts.length - 1] ?? path,
    dir: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
  };
}

function statusSymbol(file: ProjectGitFileStatus): string {
  if (file.indexStatus === "?" || file.worktreeStatus === "?") return "?";
  if (file.indexStatus === "A" || file.worktreeStatus === "A") return "A";
  if (file.indexStatus === "D" || file.worktreeStatus === "D") return "D";
  if (file.indexStatus === "R" || file.worktreeStatus === "R") return "R";
  if (file.indexStatus === "T" || file.worktreeStatus === "T") return "T";
  return "U";
}

export function gitFileStatusPresentation(file: ProjectGitFileStatus): { symbol: string; label: string; className: "added" | "deleted" | "renamed" | "modified" } {
  const symbol = statusSymbol(file);
  if (symbol === "?") return { symbol, label: "未跟踪", className: "added" };
  if (symbol === "A") return { symbol, label: "已添加", className: "added" };
  if (symbol === "D") return { symbol, label: "已删除", className: "deleted" };
  if (symbol === "R") return { symbol, label: "已重命名", className: "renamed" };
  if (symbol === "T") return { symbol, label: "类型已更改", className: "modified" };
  return { symbol, label: "已修改", className: "modified" };
}

function formatCounts(file: ProjectGitFileStatus): string | null {
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  if (additions === 0 && deletions === 0) return null;
  return `+${additions} -${deletions}`;
}

function statusClassFromSymbol(symbol: string): string {
  if (symbol === "A" || symbol === "?") return "added";
  if (symbol === "D") return "deleted";
  if (symbol === "R" || symbol === "C") return "renamed";
  return "modified";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function commitBody(summary: string | null | undefined, message: string | null | undefined): string {
  const normalized = (message ?? "").trim();
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/);
  if (summary && lines[0]?.trim() === summary.trim()) {
    return lines.slice(1).join("\n").trim();
  }
  return normalized;
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line meta";
  if (line.startsWith("@@")) return "diff-line hunk";
  if (line.startsWith("+")) return "diff-line addition";
  if (line.startsWith("-")) return "diff-line deletion";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "diff-line meta";
  return "diff-line context";
}
