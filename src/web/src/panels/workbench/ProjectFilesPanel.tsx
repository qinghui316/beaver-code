import { File, Folder, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { fetchJson } from "../../api.js";
import { userFacingErrorMessage } from "../../presentation/user-facing-language.js";
import type { ProjectFilePreviewResult, ProjectFileTreeResult, TopicFileReference } from "../../types.js";

export function ProjectFilesPanel({
  projectId,
  selectedRefs,
  onSelectedRefsChange,
  onOpenTextDocument,
}: {
  projectId: string | null;
  selectedRefs: TopicFileReference[];
  onSelectedRefsChange: (refs: TopicFileReference[]) => void;
  onOpenTextDocument: (relativePath: string) => void;
}): ReactElement {
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState<ProjectFileTreeResult | null>(null);
  const [preview, setPreview] = useState<ProjectFilePreviewResult | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const entries = tree?.entries ?? [];
    if (!normalized) return entries;
    return entries.filter((entry) => entry.relativePath.toLowerCase().includes(normalized) || entry.name.toLowerCase().includes(normalized));
  }, [query, tree]);

  async function loadTree(nextPath = path): Promise<void> {
    if (!projectId) return;
    setLoadingTree(true);
    setFailureMessage(null);
    try {
      const result = await fetchJson<ProjectFileTreeResult>(`/api/projects/${encodeURIComponent(projectId)}/files/children?path=${encodeURIComponent(nextPath)}`);
      setTree(result);
      setPath(result.path);
    } catch (err) {
      setFailureMessage(userFacingErrorMessage(err, "files"));
    } finally {
      setLoadingTree(false);
    }
  }

  async function loadPreview(ref: TopicFileReference): Promise<void> {
    if (!projectId) return;
    setSelectedPath(ref.relativePath);
    if (ref.kind === "directory") {
      await loadTree(ref.relativePath);
      setPreview({
        path: ref.relativePath,
        name: ref.name,
        kind: "directory",
        status: "directory",
        message: "这是一个目录。展开目录以查看内容。",
      });
      return;
    }
    setLoadingPreview(true);
    setFailureMessage(null);
    try {
      setPreview(await fetchJson<ProjectFilePreviewResult>(`/api/projects/${encodeURIComponent(projectId)}/files/preview?path=${encodeURIComponent(ref.relativePath)}`));
    } catch (err) {
      setFailureMessage(userFacingErrorMessage(err, "files"));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function selectEntry(ref: TopicFileReference): Promise<void> {
    if (ref.kind === "file" && isWorkspaceTextDocument(ref)) {
      setSelectedPath(ref.relativePath);
      setPreview(null);
      onOpenTextDocument(ref.relativePath);
      return;
    }
    await loadPreview(ref);
  }

  function insertReference(ref?: TopicFileReference | null): void {
    if (!ref) return;
    if (selectedRefs.some((item) => item.relativePath === ref.relativePath)) return;
    onSelectedRefsChange([...selectedRefs, { ...ref, source: "composer" }]);
  }

  useEffect(() => {
    void loadTree("");
  }, [projectId]);

  const selectedRef = tree?.entries.find((entry) => entry.relativePath === selectedPath) ?? null;
  const crumbs = path ? path.split("/") : [];

  if (!projectId) {
    return <div className="project-files-panel empty-state" data-testid="project-files-panel">选择项目后可查看文件。</div>;
  }

  return (
    <section className="project-files-panel" data-testid="project-files-panel" aria-label="项目文件">
      <header className="project-files-header">
        <div>
          <strong>文件</strong>
          <small>只读浏览当前项目</small>
        </div>
        <button type="button" className="icon-button" aria-label="刷新文件" data-testid="project-files-refresh" onClick={() => void loadTree(path)}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </header>

      <label className="project-files-search">
        <Search size={15} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件" />
      </label>

      <div className="project-files-breadcrumb" aria-label="当前路径">
        <button type="button" onClick={() => void loadTree("")}>项目</button>
        {crumbs.map((part, index) => {
          const crumbPath = crumbs.slice(0, index + 1).join("/");
          return (
            <button type="button" key={crumbPath} onClick={() => void loadTree(crumbPath)}>
              / {part}
            </button>
          );
        })}
      </div>

      {failureMessage ? <div className="project-files-error">{failureMessage}</div> : null}

      <div className="project-files-list" data-testid="project-files-tree">
        {loadingTree ? <div className="project-files-empty">正在加载文件...</div> : null}
        {!loadingTree && visibleEntries.length === 0 ? <div className="project-files-empty">没有匹配的文件。</div> : null}
        {visibleEntries.map((entry) => (
          <button
            type="button"
            key={entry.relativePath}
            className={`project-files-row ${entry.relativePath === selectedPath ? "selected" : ""}`}
            onClick={() => void selectEntry(entry)}
          >
            {entry.kind === "directory" ? <Folder size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}
            <span>{entry.name}</span>
            <small>{entry.kind === "directory" ? "目录" : entry.extension ? `.${entry.extension}` : "文件"}</small>
          </button>
        ))}
      </div>

      <div className="project-files-preview" data-testid="project-files-preview">
        <div className="project-files-preview-header">
          <span>{preview?.path || selectedPath || "预览"}</span>
          <button
            type="button"
            className="secondary-button compact"
            disabled={!selectedRef}
            data-testid="project-files-insert-ref"
            onClick={() => insertReference(selectedRef)}
          >
            引用到输入框
          </button>
        </div>
        {loadingPreview ? <div className="project-files-empty">正在读取预览...</div> : null}
        {!loadingPreview && !preview ? <div className="project-files-empty">选择一个文件查看预览。</div> : null}
        {!loadingPreview && preview?.status === "text" ? (
          <>
            {preview.message ? <div className="project-files-note">{preview.message}</div> : null}
            <pre>{preview.content}</pre>
          </>
        ) : null}
        {!loadingPreview && preview && preview.status !== "text" ? (
          <div className="project-files-empty">{preview.message ?? "此文件不能预览。"}</div>
        ) : null}
      </div>
    </section>
  );
}

function isWorkspaceTextDocument(ref: TopicFileReference): boolean {
  const extension = (ref.extension ?? "").toLowerCase();
  return extension === "md" || extension === "markdown" || extension === "txt";
}
