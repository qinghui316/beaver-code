import { File, Folder, X } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";
import type { TopicFileReference } from "../types.js";
import {
  findFileMentionTrigger,
  mergeFileRefs,
  removeFileRef,
  replaceFileMentionTrigger,
} from "../input/mentions.js";

export function FileMentionPicker({
  projectId,
  value,
  onChange,
  selectedRefs,
  onSelectedRefsChange,
}: {
  projectId: string | null;
  value: string;
  onChange: (value: string) => void;
  selectedRefs: TopicFileReference[];
  onSelectedRefsChange: (refs: TopicFileReference[]) => void;
}): ReactElement | null {
  const trigger = findFileMentionTrigger(value);
  const [results, setResults] = useState<TopicFileReference[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId || !trigger) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetch(`/api/projects/${encodeURIComponent(projectId)}/files/search?q=${encodeURIComponent(trigger.query)}&limit=30`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(await response.text());
          return response.json() as Promise<{ files?: TopicFileReference[] }>;
        })
        .then((payload) => setResults(Array.isArray(payload.files) ? payload.files : []))
        .catch((error: unknown) => {
          if ((error as { name?: string }).name !== "AbortError") setResults([]);
        })
        .finally(() => setLoading(false));
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, trigger?.query, trigger?.start, trigger?.end]);

  if (!projectId) return null;
  return (
    <div className="file-mention-surface" data-testid="file-mention-surface">
      {selectedRefs.length > 0 ? (
        <div className="file-selected-row" aria-label="已引用文件">
          {selectedRefs.map((ref) => (
            <button
              key={ref.relativePath}
              type="button"
              className="file-selected-chip"
              onClick={() => onSelectedRefsChange(removeFileRef(selectedRefs, ref.relativePath))}
              title="移除这个文件引用"
            >
              {ref.kind === "directory" ? <Folder size={12} /> : <File size={12} />}
              {ref.name}
              <X size={12} />
            </button>
          ))}
        </div>
      ) : null}
      {trigger ? (
        <div className="file-mention-menu" role="listbox" aria-label="选择项目文件" data-testid="file-mention-menu">
          {loading ? <div className="file-mention-empty">搜索文件...</div> : null}
          {!loading && results.length === 0 ? <div className="file-mention-empty">没有匹配的项目文件</div> : null}
          {results.map((ref) => (
            <button
              key={ref.relativePath}
              type="button"
              role="option"
              className="file-mention-option"
              onClick={() => {
                onChange(replaceFileMentionTrigger(value, trigger, ref));
                onSelectedRefsChange(mergeFileRefs(selectedRefs, ref));
              }}
            >
              <span className="file-mention-icon">{ref.kind === "directory" ? <Folder size={15} /> : <File size={15} />}</span>
              <span className="file-mention-main">
                <strong>{ref.name}</strong>
                <small>{ref.relativePath}</small>
              </span>
              <span className="file-kind">{ref.kind === "directory" ? "目录" : "文件"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
