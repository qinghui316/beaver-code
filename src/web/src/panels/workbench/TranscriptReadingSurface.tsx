import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ArrowUpRight, Bot, Brain, CheckCircle2, FilePenLine, FileSearch2, FileText, GitFork, LoaderCircle, RotateCcw, Search, Terminal, Undo2, Wrench } from "lucide-react";
import { artifactName } from "./RunReplayPanel.js";
import { formatTime, humanStatus } from "../../formatters.js";
import { cleanTranscriptText, cleanTranscriptTitle } from "./transcriptDisplay.js";
import { TranscriptCellVirtualList } from "./TranscriptCellVirtualList.js";
import { SentMessageContextSummary, type ComposerContextAttachment } from "../../shell/ComposerContextSources.js";
import {
  isLongTranscriptCell,
  transcriptCellDisplayText,
} from "./transcriptMeasurement.js";
import type { CanonicalDocumentReference, InteractionHistoryRecord, ParentAgentTranscriptCell, TextDocumentResource } from "../../types.js";

export function AgentTranscriptPane({ cells, emptyMessage = "暂无 Agent 消息。", testId = "agent-transcript-pane" }: {
  cells: ParentAgentTranscriptCell[];
  emptyMessage?: string;
  testId?: string;
}): ReactElement {
  return (
    <TranscriptCellVirtualList
      cells={cells}
      className="agent-transcript-pane"
      testId={testId}
      emptyMessage={emptyMessage}
      renderCell={(cell, expanded, onToggleExpanded) => (
        <ParentAgentTranscriptCellView
          cell={cell}
          expanded={expanded}
          onToggleExpanded={onToggleExpanded}
        />
      )}
    />
  );
}

export function ParentAgentTranscriptCellView({ cell, expanded, onToggleExpanded, onOpenAgent, canOpenAgent, onOpenDocument, onOpenProjectFile, documentResources, onEnsureDocument, onRetry, onFork, onRetryPending, onRestorePending }: {
  cell: ParentAgentTranscriptCell;
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenAgent?: (agentSurfaceId: string) => void;
  canOpenAgent?: (agentSurfaceId: string) => boolean;
  onOpenDocument?: (document: CanonicalDocumentReference) => void;
  onOpenProjectFile?: (relativePath: string) => void;
  documentResources?: Record<string, TextDocumentResource>;
  onEnsureDocument?: (document: CanonicalDocumentReference) => void;
  onRetry?: (target: NonNullable<ParentAgentTranscriptCell["retryTarget"]>) => Promise<void>;
  onFork?: (target: NonNullable<ParentAgentTranscriptCell["forkTarget"]>) => void;
  onRetryPending?: (clientRequestId: string) => Promise<void>;
  onRestorePending?: (clientRequestId: string) => void;
}): ReactElement {
  const isUser = cell.kind === "user-message";
  const rowKind = isUser ? "user" : "parent";
  return (
    <div
      className={`parent-agent-message-row transcript-cell-row ${rowKind} ${cell.kind}`}
      data-testid={isUser ? "parent-message-user" : "parent-message-parent-agent"}
      data-cell-id={cell.id}
      data-run-id={cell.runId}
      data-thread-id={cell.threadId}
      data-turn-id={cell.turnId}
      data-realtime={cell.realtime ? "true" : undefined}
    >
      <div className={`parent-agent-bubble transcript-cell-surface ${rowKind} ${cell.kind}`}>
        {cell.kind === "user-message" ? (
          <TranscriptUserMessage cell={cell} expanded={expanded} onToggleExpanded={onToggleExpanded} onRetryPending={onRetryPending} onRestorePending={onRestorePending} />
        ) : cell.kind === "assistant-message" ? (
          <TranscriptAssistantMessage cell={cell} expanded={expanded} onToggleExpanded={onToggleExpanded} />
        ) : cell.kind === "review-card" ? (
          <TranscriptReviewCard cell={cell} onFork={onFork} onOpenProjectFile={onOpenProjectFile} />
        ) : cell.kind === "user-input" && cell.interactionHistory ? (
          <InteractionHistoryView history={cell.interactionHistory} />
        ) : cell.kind === "document-preview" && cell.documentRef ? (
          <PlanDocumentPreview
            document={cell.documentRef}
            resource={documentResources?.[cell.documentRef.documentId] ?? null}
            onEnsure={() => onEnsureDocument?.(cell.documentRef!)}
            onOpen={() => onOpenDocument?.(cell.documentRef!)}
          />
        ) : (
          <TranscriptActivityRow cell={cell} expanded={expanded} onToggleExpanded={onToggleExpanded} onOpenAgent={onOpenAgent} canOpenAgent={canOpenAgent} onRetry={onRetry} onFork={onFork} />
        )}
      </div>
      {cell.timestamp && (cell.kind === "user-message" || cell.kind === "assistant-message") ? <time>{formatTime(cell.timestamp)}</time> : null}
    </div>
  );
}

export function TranscriptReviewCard({ cell, onFork, onOpenProjectFile }: {
  cell: ParentAgentTranscriptCell;
  onFork?: (target: NonNullable<ParentAgentTranscriptCell["forkTarget"]>) => void;
  onOpenProjectFile?: (relativePath: string) => void;
}): ReactElement {
  const running = cell.status === "submitting" || cell.status === "reviewing";
  const statusLabel = running ? "正在审查代码" : cell.status === "completed" ? "审查完成"
    : cell.status === "interrupted" ? "审查已中断" : "审查失败";
  return <section className={`transcript-review-card ${cell.isError ? "danger" : ""}`} aria-label={cell.title ?? "代码审查"}>
    <header>
      <FileSearch2 size={16} aria-hidden="true" />
      <div>
        <strong>{cell.title ?? "代码审查"}</strong>
        <span>{statusLabel}</span>
      </div>
      {running ? <LoaderCircle size={15} className="spin" aria-hidden="true" />
        : cell.status === "completed" ? <CheckCircle2 size={15} aria-hidden="true" /> : null}
      {cell.forkTarget?.recovery && onFork ? <button
        type="button"
        className="transcript-fork-button"
        title="创建恢复会话"
        aria-label="创建恢复会话"
        onClick={() => onFork(cell.forkTarget!)}
      ><GitFork size={15} aria-hidden="true" /></button> : null}
    </header>
    {cell.text ? <div className="transcript-review-body"><TranscriptMarkdownLite text={cell.text} idPrefix={cell.id} onOpenProjectFile={onOpenProjectFile} /></div> : null}
  </section>;
}

export function TranscriptUserMessage({ cell, expanded, onToggleExpanded, onRetryPending, onRestorePending }: {
  cell: ParentAgentTranscriptCell;
  expanded: boolean;
  onToggleExpanded: () => void;
  onRetryPending?: (clientRequestId: string) => Promise<void>;
  onRestorePending?: (clientRequestId: string) => void;
}): ReactElement {
  const [retrying, setRetrying] = useState(false);
  const pendingLabel = cell.status === "sending"
    ? "正在发送"
    : cell.status === "uncertain"
      ? "发送状态待确认"
      : cell.status === "failed"
        ? "发送失败"
        : null;
  return (
    <div className="transcript-user-message-wrap">
      <TranscriptMessageProse
        cell={cell}
        expanded={expanded}
        onToggleExpanded={onToggleExpanded}
        className="transcript-user-message"
      />
      {pendingLabel ? <div className={`transcript-user-delivery-state ${cell.status === "failed" ? "danger" : ""}`} role="status">
        {cell.status === "sending" ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : null}
        <span>{pendingLabel}</span>
        {cell.detailText ? <small>{cell.detailText}</small> : null}
        {cell.pendingIntent?.canRetry && onRetryPending ? <button type="button" disabled={retrying} onClick={() => {
          setRetrying(true);
          void onRetryPending(cell.pendingIntent!.clientRequestId).finally(() => setRetrying(false));
        }}>{retrying ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}重试</button> : null}
        {cell.pendingIntent?.canRestore && onRestorePending ? <button type="button" onClick={() => onRestorePending(cell.pendingIntent!.clientRequestId)}><Undo2 size={12} aria-hidden="true" />放回输入框</button> : null}
      </div> : null}
    </div>
  );
}

export function TranscriptAssistantMessage({ cell, expanded, onToggleExpanded }: {
  cell: ParentAgentTranscriptCell;
  expanded: boolean;
  onToggleExpanded: () => void;
}): ReactElement {
  return (
    <TranscriptMessageProse
      cell={cell}
      expanded={expanded}
      onToggleExpanded={onToggleExpanded}
      className="transcript-assistant-message"
    />
  );
}

function TranscriptMessageProse({ cell, expanded, onToggleExpanded, className }: {
  cell: ParentAgentTranscriptCell;
  expanded: boolean;
  onToggleExpanded: () => void;
  className: string;
}): ReactElement {
  const title = cleanTranscriptTitle(cell.title);
  const folded = isLongTranscriptCell(cell) && !expanded;
  const text = transcriptCellDisplayText(cell, expanded);
  return (
    <div className={`parent-agent-prose transcript-message-prose ${className} ${cell.isError ? "danger" : ""}`}>
      {title ? <strong className="transcript-message-title">{title}</strong> : null}
      <TranscriptMarkdownLite text={text} idPrefix={cell.id} />
      {cell.kind === "user-message" ? (
        <SentMessageContextSummary
          contextRefs={cell.contextRefs}
          attachments={cell.attachments as ComposerContextAttachment[] | undefined}
        />
      ) : null}
      {isLongTranscriptCell(cell) ? (
        <button type="button" className="transcript-expand-button" onClick={onToggleExpanded}>
          {folded ? "展开完整内容" : "收起"}
        </button>
      ) : null}
    </div>
  );
}

export function TranscriptActivityRow({ cell, expanded, onToggleExpanded, onOpenAgent, canOpenAgent, onRetry, onFork }: {
  cell: ParentAgentTranscriptCell;
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenAgent?: (agentSurfaceId: string) => void;
  canOpenAgent?: (agentSurfaceId: string) => boolean;
  onRetry?: (target: NonNullable<ParentAgentTranscriptCell["retryTarget"]>) => Promise<void>;
  onFork?: (target: NonNullable<ParentAgentTranscriptCell["forkTarget"]>) => void;
}): ReactElement {
  const [retrying, setRetrying] = useState(false);
  const elapsed = useElapsedSeconds(cell.realtime ? cell.timestamp : undefined);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const detailsPinnedRef = useRef(true);
  const evidenceRefs = dedupeParentCellEvidenceRefs(cell.evidenceRefs ?? []);
  const hasDetails = Boolean(cell.detailText?.trim()) || evidenceRefs.length > 0;
  const rawTitle = cleanTranscriptTitle(cell.title) || (cell.kind === "process-row" ? "运行" : "材料");
  const rawText = normalizeProviderTranscriptText(cleanTranscriptText(cell.text));
  const title = rawTitle === "已运行命令" && /^已运行\s+\d+\s+条命令/.test(rawText) ? rawText : rawTitle;
  const statusLabel = cell.status ? humanStatus(cell.status) : "";
  const text = isDuplicativeActivitySummary(rawText, title, statusLabel) ? "" : rawText;
  const detailText = normalizeProviderTranscriptText(cleanTranscriptText(cell.detailText));
  const visibleStatusLabel = cell.status && shouldShowTranscriptStatus(cell) ? humanStatus(cell.status) : null;
  const detailsId = `${cell.id}:details`;
  const tone = transcriptActivityTone(cell);
  const opensAgent = Boolean(cell.targetAgentSurfaceId && onOpenAgent && (canOpenAgent?.(cell.targetAgentSurfaceId) ?? true));
  const announceTurnPhase = cell.realtime && cell.activityKind === "turn";
  useEffect(() => {
    const node = detailsRef.current;
    if (expanded && node && detailsPinnedRef.current) node.scrollTop = node.scrollHeight;
  }, [detailText, expanded]);
  return (
    <div className={`parent-agent-tool-result transcript-activity-row compact ${cell.kind} tone-${tone} ${cell.activityKind ? `activity-${cell.activityKind}` : ""} ${cell.realtime ? "realtime" : ""} ${expanded ? "expanded" : ""} ${hasDetails ? "has-details" : ""} ${cell.isError ? "danger" : ""}`}>
      {announceTurnPhase ? <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{title}</span> : null}
      <div className="transcript-activity-header">
        <button
          type="button"
          className="transcript-activity-summary"
          onClick={opensAgent ? () => onOpenAgent?.(cell.targetAgentSurfaceId!) : hasDetails ? onToggleExpanded : undefined}
          aria-expanded={hasDetails ? expanded : undefined}
          aria-controls={hasDetails ? detailsId : undefined}
        >
          <ActivityGlyph cell={cell} />
          <span className="tool-result-heading transcript-activity-heading">
            <span className="transcript-activity-title" aria-hidden={announceTurnPhase ? "true" : undefined}>{title}{cell.realtime && elapsed !== null ? ` · ${elapsed} 秒` : ""}</span>
            {visibleStatusLabel ? <span>{visibleStatusLabel}</span> : null}
          </span>
          {opensAgent ? <span className="transcript-activity-disclosure" aria-hidden="true">打开</span> : hasDetails ? <span className="transcript-activity-disclosure" aria-hidden="true">{expanded ? "收起" : "详情"}</span> : null}
        </button>
        {cell.retryTarget && onRetry ? (
          <button
            type="button"
            className="transcript-retry-button"
            title="重试上一条消息"
            aria-label="重试上一条消息"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void onRetry(cell.retryTarget!).catch(() => undefined).finally(() => setRetrying(false));
            }}
          >
            {retrying ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}
          </button>
        ) : null}
        {cell.forkTarget && onFork ? (
          <button
            type="button"
            className="transcript-fork-button"
            title={cell.forkTarget.recovery ? "创建恢复会话" : "从这里创建新会话"}
            aria-label={cell.forkTarget.recovery ? "创建恢复会话" : "从这里创建新会话"}
            onClick={() => onFork(cell.forkTarget!)}
          >
            <GitFork size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {text ? <TranscriptMarkdownLite text={text} idPrefix={`${cell.id}:summary`} compact /> : null}
      {hasDetails && expanded ? (
        <div
          ref={detailsRef}
          className="tool-result-details transcript-activity-details"
          id={detailsId}
          onScroll={(event) => {
            const node = event.currentTarget;
            detailsPinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
          }}
        >
          {detailText ? <pre>{detailText}</pre> : null}
          {evidenceRefs.length ? (
            <div className="tool-result-evidence">
              {evidenceRefs.map((ref) => <span key={`${ref.kind}:${ref.ref}`}>材料：{artifactName(ref.ref)}</span>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlanDocumentPreview({ document, resource, onEnsure, onOpen }: {
  document: CanonicalDocumentReference;
  resource: TextDocumentResource | null;
  onEnsure: () => void;
  onOpen: () => void;
}): ReactElement {
  useEffect(() => {
    if (!resource) onEnsure();
  }, [document.documentId, onEnsure, resource]);
  return (
    <button type="button" className="plan-document-preview" data-testid="plan-document-preview" onClick={onOpen}>
      <span className="plan-document-preview-heading"><FileText size={16} aria-hidden="true" /><span>{document.title}</span><ArrowUpRight size={14} aria-hidden="true" /></span>
      <span className="plan-document-preview-body">
        {resource ? <TranscriptMarkdownLite text={resource.content} idPrefix={`plan-preview:${document.documentId}`} compact /> : <span className="plan-document-preview-loading">正在读取计划...</span>}
      </span>
      <span className="plan-document-preview-fade" aria-hidden="true" />
    </button>
  );
}

function InteractionHistoryView({ history }: { history: InteractionHistoryRecord }): ReactElement {
  const skipped = new Set(history.skippedQuestionIds ?? []);
  return (
    <div className="interaction-history" data-testid="interaction-history">
      {(history.questions ?? []).map((question) => {
        const answer = history.answers?.[question.questionId];
        const text = skipped.has(question.questionId)
          ? "已跳过"
          : answer
            ? `你的回答：${Array.isArray(answer) ? answer.join("、") : answer}`
            : history.status === "pending" || history.status === "submitting" ? "等待回答" : "未回答";
        return (
          <div key={question.questionId} className="interaction-history-item">
            <strong>{question.title}</strong>
            <p>{text}</p>
          </div>
        );
      })}
    </div>
  );
}

function ActivityGlyph({ cell }: { cell: ParentAgentTranscriptCell }): ReactElement {
  const size = 14;
  const icon = cell.activityKind === "command"
    ? <Terminal size={size} />
    : cell.activityKind === "file"
      ? <FilePenLine size={size} />
      : cell.activityKind === "search"
        ? <Search size={size} />
        : cell.activityKind === "agent"
          ? <Bot size={size} />
          : cell.activityKind === "reasoning"
            ? <Brain size={size} />
            : cell.activityKind === "turn"
              ? cell.realtime ? <LoaderCircle className="transcript-activity-spinner" size={size} /> : <CheckCircle2 size={size} />
              : <Wrench size={size} />;
  return <span className="transcript-activity-icon" aria-hidden="true">{icon}</span>;
}

function useElapsedSeconds(startedAt?: string): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() => elapsedSeconds(startedAt));
  useEffect(() => {
    setElapsed(elapsedSeconds(startedAt));
    if (!startedAt) return;
    const timer = window.setInterval(() => setElapsed(elapsedSeconds(startedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return elapsed;
}

function elapsedSeconds(startedAt?: string): number | null {
  if (!startedAt) return null;
  const time = Date.parse(startedAt);
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 1000)) : null;
}

function dedupeParentCellEvidenceRefs(refs: NonNullable<ParentAgentTranscriptCell["evidenceRefs"]>): NonNullable<ParentAgentTranscriptCell["evidenceRefs"]> {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shouldShowTranscriptStatus(cell: ParentAgentTranscriptCell): boolean {
  if (!cell.status) return false;
  if (cell.activityKind === "command") return false;
  if (cell.isError) return true;
  return ["running", "queued", "waiting-user", "needs-user-input", "failed"].includes(cell.status);
}

function transcriptActivityTone(cell: ParentAgentTranscriptCell): "subtle" | "active" | "attention" | "danger" {
  if (cell.isError || cell.status === "failed") return "danger";
  if (["blocked", "waiting-user", "needs-user-input", "waiting-decision"].includes(cell.status ?? "")) return "attention";
  if (["running", "queued", "streaming", "preparing", "started"].includes(cell.status ?? "")) return "active";
  return "subtle";
}

function isDuplicativeActivitySummary(summary: string, title: string, statusLabel: string): boolean {
  const normalizedSummary = normalizeActivityCopy(summary);
  if (!normalizedSummary) return true;
  const normalizedTitle = normalizeActivityCopy(title);
  const normalizedStatus = normalizeActivityCopy(statusLabel);
  const candidates = [
    normalizedTitle,
    normalizedStatus ? `${normalizedTitle} ${normalizedStatus}` : "",
    normalizedStatus ? `${normalizedTitle}${normalizedStatus}` : "",
    normalizedStatus ? `${normalizedStatus} ${normalizedTitle}` : "",
  ].filter(Boolean);
  return candidates.includes(normalizedSummary);
}

function normalizeActivityCopy(value: string): string {
  return value.replace(/[·:：.。]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeProviderTranscriptText(value: string): string {
  return value.trim();
}

export function TranscriptMarkdownLite({ text, idPrefix, compact = false, onOpenProjectFile }: {
  text: string;
  idPrefix: string;
  compact?: boolean;
  onOpenProjectFile?: (relativePath: string) => void;
}): ReactElement {
  const blocks = splitMarkdownBlocks(text);
  return (
    <>
      {blocks.map((block, index) => renderMarkdownBlock(block, `${idPrefix}:block:${index}`, compact, onOpenProjectFile))}
    </>
  );
}

function renderMarkdownBlock(block: string, keyPrefix: string, compact: boolean, onOpenProjectFile?: (relativePath: string) => void): ReactElement {
  const lines = block.split(/\n/).map((line) => line.trimEnd()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  const heading = /^(#{1,3})\s+(.+)$/.exec(firstLine);
  if (!compact && heading && lines.length === 1) {
    const level = heading[1]?.length ?? 1;
    return <strong key={keyPrefix} className={`markdown-lite-heading level-${level}`}>{heading[2]}</strong>;
  }
  if (lines.length > 0 && lines.every((line) => /^[-*]\s+/.test(line))) {
    return (
      <ul key={keyPrefix} className={compact ? "markdown-lite-list compact" : "markdown-lite-list"}>
        {lines.map((line, lineIndex) => <li key={`${keyPrefix}:li:${lineIndex}`}>{renderInlineMarkdown(line.replace(/^[-*]\s+/, ""), `${keyPrefix}:li:${lineIndex}`, onOpenProjectFile)}</li>)}
      </ul>
    );
  }
  if (lines.length > 0 && lines.every((line) => /^\d+[.)]\s+/.test(line))) {
    return (
      <ol key={keyPrefix} className={compact ? "markdown-lite-list markdown-lite-ordered compact" : "markdown-lite-list markdown-lite-ordered"}>
        {lines.map((line, lineIndex) => <li key={`${keyPrefix}:oli:${lineIndex}`}>{renderInlineMarkdown(line.replace(/^\d+[.)]\s+/, ""), `${keyPrefix}:oli:${lineIndex}`, onOpenProjectFile)}</li>)}
      </ol>
    );
  }
  if (lines.length > 0 && lines.every((line) => /^>\s?/.test(line))) {
    return (
      <blockquote key={keyPrefix} className="markdown-lite-quote">
        {lines.map((line, lineIndex) => <p key={`${keyPrefix}:quote:${lineIndex}`}>{renderInlineMarkdown(line.replace(/^>\s?/, ""), `${keyPrefix}:quote:${lineIndex}`, onOpenProjectFile)}</p>)}
      </blockquote>
    );
  }
  if (lines.length > 1 && /^[^。.!?]{2,48}:$/.test(lines[0] ?? "") && lines.slice(1).every((line) => /^[-*]\s+/.test(line))) {
    return (
      <div key={keyPrefix} className="markdown-lite-section-list">
        <strong className="markdown-lite-heading">{(lines[0] ?? "").replace(/:$/, "")}</strong>
        <ul className={compact ? "markdown-lite-list compact" : "markdown-lite-list"}>
          {lines.slice(1).map((line, lineIndex) => <li key={`${keyPrefix}:section-li:${lineIndex}`}>{renderInlineMarkdown(line.replace(/^[-*]\s+/, ""), `${keyPrefix}:section-li:${lineIndex}`, onOpenProjectFile)}</li>)}
        </ul>
      </div>
    );
  }
  const fence = parseFencedCodeBlock(block);
  if (fence) {
    const { language, code } = fence;
    return (
      <div key={keyPrefix} className="markdown-lite-code-block">
        {language ? <span className="markdown-lite-code-label">{language}</span> : null}
        <pre className="markdown-lite-code">{code}</pre>
      </div>
    );
  }
  if (!compact && lines.length === 1 && /^[^。.!?]{2,32}:$/.test(lines[0] ?? "")) {
    return <strong key={keyPrefix} className="markdown-lite-heading">{(lines[0] ?? "").replace(/:$/, "")}</strong>;
  }
  return <p key={keyPrefix}>{renderInlineMarkdown(block, keyPrefix, onOpenProjectFile)}</p>;
}

function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  const openingFence = /^```[^\r\n]*(?:\r\n|\n|\r|$)/gm;
  let cursor = 0;
  let opening: RegExpExecArray | null;
  while ((opening = openingFence.exec(text)) !== null) {
    pushProseBlocks(blocks, text.slice(cursor, opening.index));
    const closingFence = /^```[ \t]*(?:\r\n|\n|\r|$)/gm;
    closingFence.lastIndex = openingFence.lastIndex;
    const closing = closingFence.exec(text);
    const end = closing ? closing.index + closing[0].length : text.length;
    blocks.push(text.slice(opening.index, end));
    cursor = end;
    openingFence.lastIndex = end;
  }
  pushProseBlocks(blocks, text.slice(cursor));
  return blocks;
}

function pushProseBlocks(blocks: string[], value: string): void {
  for (const block of value.split(/(?:\r\n|\n|\r){2,}/)) {
    if (block.trim()) blocks.push(block.trim());
  }
}

function parseFencedCodeBlock(block: string): { language: string; code: string } | null {
  const opening = /^```([^\r\n`]*)[ \t]*(?:\r\n|\n|\r|$)/.exec(block);
  if (!opening) return null;
  const rest = block.slice(opening[0].length);
  const closing = /(?:\r\n|\n|\r)```[ \t]*(?:\r\n|\n|\r)?$/.exec(rest);
  return {
    language: opening[1]?.trim() ?? "",
    code: closing ? rest.slice(0, closing.index) : rest,
  };
}

function renderInlineMarkdown(text: string, keyPrefix: string, onOpenProjectFile?: (relativePath: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|(?<![A-Za-z0-9_./\\])((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+(?::\d+(?:-\d+)?)?)(?![A-Za-z0-9_/\\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[1]) {
      nodes.push(<code key={`${keyPrefix}:code:${match.index}`}>{match[1]}</code>);
    } else if (match[2]) {
      const relativePath = projectFilePathFromMarkdownHref(match[3] ?? "");
      nodes.push(relativePath && onOpenProjectFile
        ? <button key={`${keyPrefix}:link:${match.index}`} type="button" className="markdown-lite-link" onClick={() => onOpenProjectFile(relativePath)}>{match[2]}</button>
        : <span key={`${keyPrefix}:link:${match.index}`} className="markdown-lite-link">{match[2]}</span>);
    } else if (match[4]) {
      const relativePath = projectFilePathFromMarkdownHref(match[4]);
      nodes.push(relativePath && onOpenProjectFile
        ? <button key={`${keyPrefix}:path:${match.index}`} type="button" className="markdown-lite-link" onClick={() => onOpenProjectFile(relativePath)}>{match[4]}</button>
        : match[4]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function projectFilePathFromMarkdownHref(value: string): string | null {
  const href = value.trim();
  const withoutFragment = href.replace(/#L\d+(?::?L?\d+)?$/i, "").replace(/:\d+(?:-\d+)?(?::\d+(?:-\d+)?)?$/, "");
  if (!withoutFragment || href.includes("?") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(withoutFragment)
    || withoutFragment.startsWith("/") || withoutFragment.startsWith("\\")) return null;
  const normalized = withoutFragment.replace(/^\.\//, "").replaceAll("\\", "/");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}
