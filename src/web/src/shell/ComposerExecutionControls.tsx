import { DialogSurface } from "../presentation/DialogSurface.js";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { AlertCircle, ArrowUp, CornerDownRight, ListEnd, Paperclip, CheckCircle2, Gauge, LoaderCircle, MoreHorizontal, RefreshCw, RotateCcw, Square, Trash2, Undo2 } from "lucide-react";
import type { ConversationContextSnapshot, ConversationTurnQueueSnapshot, ProviderReviewTarget } from "../types.js";
import type { ComposerActionProjection } from "../controllers/ComposerExperienceProjection.js";

export function ComposerActionButtons({ projection, hasDraft, mutationBusy, onSend, onQueue, onStop }: {
  projection: ComposerActionProjection;
  hasDraft: boolean;
  mutationBusy: boolean;
  onSend: () => void;
  onQueue: () => void;
  onStop: () => void;
}): ReactElement {
  const queued = projection.primaryIntent === "queue";
  const stop = projection.canStop && !hasDraft;
  return <div className="composer-action-group" data-primary-intent={projection.primaryIntent}>
    <div className="composer-primary-action">
      <button type="button" className={stop ? "composer-stop" : "composer-send"} disabled={!stop && (mutationBusy || !projection.canSubmitDraft)} title={stop ? "停止当前执行" : projection.disabledReason ?? (queued ? "加入待发送" : "发送")} aria-label={stop ? "停止当前执行" : queued ? "加入待发送" : "发送"} onClick={stop ? onStop : queued ? onQueue : onSend}>
        {stop ? <Square size={14} fill="currentColor" /> : mutationBusy ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} />}
      </button>
    </div>
  </div>;
}

export function ConversationTurnQueue({ snapshot, busy, onGuide, onReclaim, onRemove, onRetry, onConfirmExecution }: {
  snapshot: ConversationTurnQueueSnapshot | null;
  busy: boolean;
  onGuide?: (queueItemId: string) => void | Promise<void>;
  onReclaim?: (queueItemId: string) => void | Promise<void>;
  onRemove?: (queueItemId: string) => void | Promise<void>;
  onRetry?: (queueItemId: string) => void | Promise<void>;
  onConfirmExecution?: (queueItemId: string) => void | Promise<void>;
}): ReactElement | null {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => { setExpandedId(null); }, [snapshot?.projectId, snapshot?.productMode, snapshot?.conversationId]);
  if (!snapshot?.items?.length) return null;
  return <div className="conversation-turn-queue" aria-label="待发送内容">
    <ol>
      {snapshot.items.map((item) => {
        const pending = item.status === "dispatching";
        const confirmationRequired = item.executionCompatibility.state !== "compatible";
        const guideTitle = item.guideMode === "steer" ? "补充给当前执行" : item.guideMode === "cutover" ? "停止当前执行后发送这条需求" : item.guideDisabledReason ?? "等待当前执行结束";
        return <li key={item.queueItemId} data-attention={item.status === "blocked" || item.deliveryUncertain ? "true" : undefined}>
          <span className="conversation-turn-queue-icon" aria-hidden="true">{item.attachments?.find((attachment) => attachment.previewUrl) ? <img src={item.attachments.find((attachment) => attachment.previewUrl)!.previewUrl} alt="" loading="lazy" /> : <ListEnd size={15} />}</span>
          <span className="conversation-turn-queue-copy" title={item.itemKind === "review" ? reviewTargetPreview(item.reviewTarget) : item.text}>
            <span>{item.itemKind === "review" ? reviewTargetPreview(item.reviewTarget) : queuePreview(item.text)}</span>
            {item.deliveryUncertain ? <small>发送状态待确认</small> : item.status === "blocked" ? <small>发送失败</small> : null}
          </span>
          {item.attachmentIds.length ? <span className="conversation-turn-queue-attachments" aria-label={`${item.attachmentIds.length} 个附件`}><Paperclip size={13} />{item.attachmentIds.length}</span> : null}
          <span className="conversation-turn-queue-actions">
            <button type="button" className="conversation-turn-queue-guide" title={guideTitle} aria-label="引导" disabled={busy || pending || !onGuide || !item.guideMode || item.guideMode === "unavailable"} onClick={() => void onGuide?.(item.queueItemId)}><CornerDownRight size={14} /><span>引导</span></button>
            <button type="button" title="删除待发送内容" aria-label="删除待发送内容" disabled={busy || pending} onClick={() => void onRemove?.(item.queueItemId)}><Trash2 size={14} /></button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild><button type="button" title="更多" aria-label="待发送内容菜单"><MoreHorizontal size={15} /></button></DropdownMenu.Trigger>
              <DropdownMenu.Portal><DropdownMenu.Content className="composer-action-menu" side="top" align="end" sideOffset={8} collisionPadding={12}>
                <DropdownMenu.Item className="composer-menu-item" onSelect={() => setExpandedId(item.queueItemId)}>查看完整内容</DropdownMenu.Item>
                <DropdownMenu.Item className="composer-menu-item" disabled={busy || pending} onSelect={() => void onReclaim?.(item.queueItemId)}><Undo2 size={14} />移回输入框</DropdownMenu.Item>
                {confirmationRequired ? <DropdownMenu.Item className="composer-menu-item" disabled={busy || pending} onSelect={() => void onConfirmExecution?.(item.queueItemId)}>按当前方式发送</DropdownMenu.Item> : null}
                {item.status === "blocked" && !confirmationRequired && !item.deliveryUncertain ? <DropdownMenu.Item className="composer-menu-item" disabled={busy} onSelect={() => void onRetry?.(item.queueItemId)}><RotateCcw size={14} />重试</DropdownMenu.Item> : null}
              </DropdownMenu.Content></DropdownMenu.Portal>
            </DropdownMenu.Root>
          </span>
          {expandedId === item.queueItemId ? <DialogSurface open onClose={() => setExpandedId(null)} panelClassName="conversation-turn-queue-detail" ariaLabel="待发送内容详情" portal>
            <p>{item.itemKind === "review" ? reviewTargetPreview(item.reviewTarget) : item.text}</p>
            {item.executionCompatibility.state !== "compatible" ? <p>{item.executionCompatibility.summary}</p> : null}
            {item.diagnostic ? <p>{item.diagnostic}</p> : null}
            <button type="button" onClick={() => setExpandedId(null)}>关闭</button>
          </DialogSurface> : null}
        </li>;
      })}
    </ol>
  </div>;
}

function reviewTargetPreview(target: ProviderReviewTarget | null): string {
  if (!target) return "代码审查";
  if (target.type === "uncommitted-changes") return "审查未提交改动";
  if (target.type === "base-branch") return `代码审查 · ${target.branch}`;
  if (target.type === "commit") return `代码审查 · ${target.sha.slice(0, 7)}`;
  const text = target.instructions.replace(/\s+/g, " ").trim();
  return `代码审查 · ${text.length > 72 ? `${text.slice(0, 71)}...` : text}`;
}

function queuePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 95)}...` : normalized;
}

export function ConversationContextIndicator({
  snapshot,
  submitting,
  onCompact,
  scopeKey,
  dismiss,
}: {
  snapshot: ConversationContextSnapshot | null;
  submitting: boolean;
  onCompact?: () => void | Promise<void>;
  scopeKey?: string;
  dismiss?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => { setOpen(false); }, [scopeKey, dismiss]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  const lifecycle = submitting ? "submitting" : snapshot?.lifecycle ?? "idle";
  const busy = lifecycle === "submitting" || lifecycle === "compacting";
  const failed = lifecycle === "failed" || lifecycle === "interrupted";
  const title = failed
    ? lifecycle === "failed" ? "上下文压缩失败" : "上下文压缩已中断"
    : busy
      ? "正在压缩上下文"
      : snapshot?.usedPercent !== null && snapshot?.usedPercent !== undefined
        ? `上下文已使用 ${snapshot.usedPercent}%`
        : "上下文用量";
  return <div className="conversation-context-control" ref={controlRef}>
    <button
      ref={triggerRef}
      type="button"
      className={`conversation-context-indicator ${busy ? "is-busy" : ""} ${failed ? "is-error" : ""}`}
      aria-label={title}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-controls={open ? panelId : undefined}
      title={title}
      onClick={() => setOpen((value) => !value)}
    >
      {busy ? <RefreshCw size={15} /> : failed ? <AlertCircle size={15} /> : lifecycle === "completed" ? <CheckCircle2 size={15} /> : <Gauge size={15} />}
      {snapshot?.usedPercent !== null && snapshot?.usedPercent !== undefined ? <span>{snapshot.usedPercent}%</span> : null}
    </button>
    {open ? <div id={panelId} className="conversation-context-popover" role="dialog" aria-label="会话上下文">
      <div className="conversation-context-popover-header">
        <strong>会话上下文</strong>
        <span>{contextUsageLabel(snapshot)}</span>
      </div>
      <dl>
        <div><dt>已用</dt><dd>{formatTokens(snapshot?.usage?.contextUsedTokens)}</dd></div>
        <div><dt>剩余</dt><dd>{snapshot?.remainingPercent === null || snapshot?.remainingPercent === undefined ? "未知" : `${snapshot.remainingPercent}%`}</dd></div>
        <div><dt>窗口</dt><dd>{formatTokens(snapshot?.usage?.modelContextWindow)}</dd></div>
        <div><dt>最近一轮输入</dt><dd>{formatTokens(snapshot?.usage?.last.inputTokens)}</dd></div>
        <div><dt>缓存输入</dt><dd>{formatTokens(snapshot?.usage?.last.cachedInputTokens)}</dd></div>
        <div><dt>最近压缩</dt><dd>{formatContextTime(snapshot?.lastCompactedAt)}</dd></div>
      </dl>
      <button
        type="button"
        className="conversation-context-compact"
        disabled={!snapshot?.canCompact || busy || !onCompact}
        title={snapshot?.disabledReason ?? "压缩当前会话上下文"}
        onClick={() => void onCompact?.()}
      >
        <RefreshCw size={14} />
        <span>压缩上下文</span>
      </button>
      {snapshot?.disabledReason ? <p>{snapshot.disabledReason}</p> : null}
    </div> : null}
  </div>;
}

function contextUsageLabel(snapshot: ConversationContextSnapshot | null): string {
  if (!snapshot?.usage) return "暂无可靠用量";
  return snapshot.usedPercent === null ? formatTokens(snapshot.usage.contextUsedTokens) : `${snapshot.usedPercent}% 已用`;
}

function formatTokens(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "未知";
}

function formatContextTime(value: string | null | undefined): string {
  if (!value) return "尚未压缩";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString();
}

