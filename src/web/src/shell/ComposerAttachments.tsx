import { useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement } from "react";
import { FileText, ImageIcon, Paperclip, X } from "lucide-react";
import type { TopicAttachment } from "../types.js";

const IMAGE_PREFIX = "image/";

export function ComposerAttachButton({
  disabled,
  onAttachFiles,
}: {
  disabled?: boolean;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="composer-tool-button"
        disabled={disabled}
        title="添加附件"
        aria-label="添加附件"
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip size={15} />
      </button>
      <input
        ref={inputRef}
        className="visually-hidden-file-input"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        multiple
        accept="image/*,.txt,.md,.markdown,.json,.jsonc,.yaml,.yml,.js,.jsx,.ts,.tsx,.css,.scss,.html,.xml,.py,.ps1,.sh,.sql,.toml,.ini,.env"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) void onAttachFiles?.(files);
        }}
      />
    </>
  );
}

export type ComposerAttachmentListItem = Pick<TopicAttachment, "id" | "fileName" | "kind" | "size" | "previewUrl">;

export function ComposerAttachmentList({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachmentListItem[];
  onRemove: (id: string) => void | Promise<void>;
}): ReactElement | null {
  const [preview, setPreview] = useState<ComposerAttachmentListItem | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className="composer-attachment-list" aria-label="附件">
        {attachments.map((attachment) => {
          const previewable = attachment.kind === "image" && Boolean(attachment.previewUrl);
          return (
            <div
              className={`composer-attachment-chip ${previewable ? "is-previewable" : ""}`}
              key={attachment.id}
              title={attachment.fileName}
              onClick={() => {
                if (previewable) setPreview(attachment);
              }}
            >
              {attachment.kind === "image" && attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt={attachment.fileName} />
              ) : attachment.kind === "image" ? (
                <ImageIcon size={16} />
              ) : (
                <FileText size={16} />
              )}
              <span>{attachment.fileName}</span>
              <small>{formatAttachmentSize(attachment.size)}</small>
              <button
                type="button"
                aria-label={`移除 ${attachment.fileName}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void onRemove(attachment.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      {preview?.previewUrl ? (
        <div className="composer-attachment-preview" role="dialog" aria-label={`${preview.fileName} 预览`} onClick={() => setPreview(null)}>
          <div className="composer-attachment-preview-frame" onClick={(event) => event.stopPropagation()}>
            <img src={preview.previewUrl} alt={preview.fileName} />
            <button type="button" aria-label="关闭预览" onClick={() => setPreview(null)}>
              <X size={15} />
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function imageFilesFromPaste(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith(IMAGE_PREFIX))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

export function filesFromDrop(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer?.files ?? []);
}

export function hasFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function formatAttachmentSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${size} B`;
}
