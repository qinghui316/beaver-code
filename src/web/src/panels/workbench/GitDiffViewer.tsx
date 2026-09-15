import { RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import { fetchJson } from "../../api.js";
import { userFacingErrorMessage } from "../../presentation/user-facing-language.js";
import type { ProjectGitDiffResult, ProjectGitDiffSection } from "../../types.js";

export function GitDiffViewer({
  projectId,
  selectedPath,
  variant = "full",
}: {
  projectId: string | null;
  selectedPath: string | null;
  variant?: "full" | "rail";
}): ReactElement {
  const [diff, setDiff] = useState<ProjectGitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  async function loadDiff(): Promise<void> {
    if (!projectId || !selectedPath) return;
    setLoading(true);
    setFailureMessage(null);
    try {
      setDiff(await fetchJson<ProjectGitDiffResult>(`/api/projects/${encodeURIComponent(projectId)}/git/diff?path=${encodeURIComponent(selectedPath)}`));
    } catch (err) {
      setFailureMessage(userFacingErrorMessage(err, "git"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setDiff(null);
    void loadDiff();
  }, [projectId, selectedPath]);

  return (
    <section className={`git-diff-viewer ${variant === "rail" ? "git-diff-viewer-rail" : ""}`} data-testid="git-diff-viewer" aria-label="Git Diff">
      <header className="git-diff-header">
        <div>
          {variant === "full" ? <p className="eyebrow">Git Diff</p> : null}
          <h2>{selectedPath ? pathLeaf(selectedPath) : "Diff 预览"}</h2>
          {selectedPath ? <p>{selectedPath}</p> : null}
        </div>
        <button type="button" className="icon-button" aria-label="刷新 diff" disabled={!selectedPath} onClick={() => void loadDiff()}>
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </header>
      {failureMessage ? <div className="project-files-error">{failureMessage}</div> : null}
      {loading ? <div className="git-diff-empty">正在读取 diff...</div> : null}
      {!loading && !selectedPath ? (
        <div className="git-diff-empty">
          <strong>选择变更文件</strong>
          <span>Diff 会显示在这里。</span>
        </div>
      ) : null}
      {!loading && selectedPath && diff && diff.status !== "text" && diff.status !== "too-large" ? (
        <div className="git-diff-empty">
          <strong>{diff.name}</strong>
          <span>{diff.message ?? "此文件没有可显示的文本 diff。"}</span>
        </div>
      ) : null}
      {!loading && diff && (diff.status === "text" || diff.status === "too-large") ? (
        <div className="git-diff-content">
          {diff.message ? <div className="project-files-note">{diff.message}</div> : null}
          <div className="git-diff-stats">+{diff.additions ?? 0} -{diff.deletions ?? 0}</div>
          {diff.sections.map((section) => <DiffSection key={`${section.kind}:${diff.relativePath}`} section={section} />)}
        </div>
      ) : null}
    </section>
  );
}

function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function DiffSection({ section }: { section: ProjectGitDiffSection }): ReactElement {
  return (
    <section className="git-diff-section">
      <h3>{section.label}{section.truncated ? " · 已截断" : ""}</h3>
      <pre>
        {section.patch.split(/\n/).map((line, index) => (
          <span key={`${section.kind}:${index}`} className={diffLineClass(line)}>
            {line || " "}
          </span>
        ))}
      </pre>
    </section>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line meta";
  if (line.startsWith("@@")) return "diff-line hunk";
  if (line.startsWith("+")) return "diff-line addition";
  if (line.startsWith("-")) return "diff-line deletion";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "diff-line meta";
  return "diff-line context";
}
