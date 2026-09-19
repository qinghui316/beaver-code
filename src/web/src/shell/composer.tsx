import { AgentAccessControl, type AgentAccessControlProps } from "./AgentAccessControl.js";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { AlertCircle, ArrowLeft, ArrowUp, Check, CheckCircle2, ChevronDown, File, Gauge, ListPlus, LoaderCircle, Paperclip, Plus, RefreshCw, RotateCcw, Search, Sparkles, Square, Trash2, Undo2, X } from "lucide-react";
import type { AgentTurnMode, ConversationContextSnapshot, ConversationTurnQueueSnapshot, ProductMode, ProjectGitReviewOptions, ProviderModelCatalogGroup, ProviderReviewTarget, SkillListItem, TopicAttachment, TopicFileReference, WorkpadRuntimeStatus } from "../types.js";
import { parseReviewCommand } from "../reviewCommand.js";
import { ComposerAttachButton, ComposerAttachmentList, filesFromDrop, hasFileDrag, imageFilesFromPaste } from "./ComposerAttachments.js";
import { ConversationModelSelectors } from "./ConversationModelSelectors.js";
import { FileMentionPicker } from "./FileMentionPicker.js";
import { SkillMentionPicker } from "./SkillMentionPicker.js";
import { ComposerFrame } from "./ComposerFrame.js";
import {
  buildComposerActionProjection,
  type ComposerActionProjection,
  type ComposerPrimaryIntent,
} from "../controllers/ComposerExperienceProjection.js";
import type { TopicComposerFeatureSurface } from "../presentation/conversation-workspace.js";

export { buildComposerActionProjection } from "../controllers/ComposerExperienceProjection.js";
export type { ComposerActionProjection, ComposerPrimaryIntent } from "../controllers/ComposerExperienceProjection.js";

export function TopicComposerFeature({ surface }: { surface: TopicComposerFeatureSurface }): ReactElement {
  return <TopicComposer {...surface.view} {...surface.actions} />;
}

export function TopicComposer({
  value,
  onChange,
  providerDisplayName,
  modelLabel,
  projectId,
  skills,
  activeSkillIds,
  selectedFileRefs,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  onToggleSkill,
  onSelectedFileRefsChange,
  disabledReason,
  agentTurnMode,
  accessView,
  onSelectAccess,
  onRefreshAccess,
  onSelectAgentTurnMode,
  agentTurnModeDisabledReason,
  planModeDisabledReason,
  agentModelId,
  agentReasoningEffort,
  providerModelCatalogs,
  providerModelCatalogsBusy,
  onRefreshProviderModels,
  onSelectAgentProviderModel,
  onSelectAgentReasoningEffort,
  productMode,
  onSend,
  onStopAndContinue,
  actionRunning,
  currentWorkpadStatus,
  runControlState,
  selectedProviderId,
  conversationContext,
  contextSubmitting,
  onCompactContext,
  turnQueue,
  queueAvailable,
  queueBusy,
  onEnqueue,
  onReclaimQueuedTurn,
  onRemoveQueuedTurn,
  onRetryQueuedTurn,
  onConfirmQueuedTurnExecution,
  reviewOpen,
  reviewOptions,
  reviewLoading,
  reviewSubmitting,
  onOpenReview,
  onCloseReview,
  onStartReview,
  onStartReviewCommand,
  onReviewCommandError,
}: {
  value: string;
  onChange: (value: string) => void;
  providerDisplayName?: string;
  modelLabel: string;
  enabledSkillCount?: number;
  projectId: string | null;
  skills?: SkillListItem[];
  activeSkillIds?: string[];
  selectedFileRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemoveAttachment?: (id: string) => void | Promise<void>;
  onToggleSkill?: (skillId: string) => void | Promise<void>;
  onSelectedFileRefsChange?: (refs: TopicFileReference[]) => void;
  disabledReason?: string;
  productMode?: ProductMode;
  agentTurnMode?: AgentTurnMode;
  accessView?: AgentAccessControlProps["accessView"];
  onSelectAccess?: AgentAccessControlProps["onSelectAccess"];
  onRefreshAccess?: AgentAccessControlProps["onRefreshAccess"];
  onSelectAgentTurnMode?: (mode: AgentTurnMode) => void | Promise<void>;
  agentTurnModeDisabledReason?: string | null;
  planModeDisabledReason?: string | null;
  agentModelId?: string | null;
  agentReasoningEffort?: string | null;
  providerModelCatalogs?: ProviderModelCatalogGroup[];
  providerModelCatalogsBusy?: boolean;
  onRefreshProviderModels?: () => void | Promise<void>;
  onSelectAgentProviderModel?: (providerId: string, modelId: string | null) => void | Promise<void>;
  onSelectAgentReasoningEffort?: (effort: string | null) => void | Promise<void>;
  onSend: () => Promise<void>;
  onStopAndContinue?: () => Promise<void>;
  actionRunning: string | null;
  currentWorkpadStatus?: WorkpadRuntimeStatus;
  runControlState?: {
    state?: "idle" | "running" | "stopping";
    canStop: boolean;
    canSteer?: boolean;
    steerState?: "idle" | "submitting";
    providerId?: string;
    attemptId?: string;
    runId?: string;
  };
  selectedProviderId?: string;
  conversationContext?: ConversationContextSnapshot | null;
  contextSubmitting?: boolean;
  onCompactContext?: () => void | Promise<void>;
  turnQueue?: ConversationTurnQueueSnapshot | null;
  queueAvailable?: boolean;
  queueBusy?: boolean;
  onEnqueue?: () => void | Promise<void>;
  onReclaimQueuedTurn?: (queueItemId: string) => void | Promise<void>;
  onRemoveQueuedTurn?: (queueItemId: string) => void | Promise<void>;
  onRetryQueuedTurn?: (queueItemId: string) => void | Promise<void>;
  onConfirmQueuedTurnExecution?: (queueItemId: string) => void | Promise<void>;
  reviewOpen?: boolean;
  reviewOptions?: ProjectGitReviewOptions | null;
  reviewLoading?: boolean;
  reviewSubmitting?: boolean;
  onOpenReview?: (capturedCommand?: string) => void | Promise<void>;
  onCloseReview?: () => void;
  onStartReview?: (target: ProviderReviewTarget, capturedCommand?: string) => void | Promise<void>;
  onStartReviewCommand?: (target: ProviderReviewTarget, capturedCommand: string) => void | Promise<void>;
  onReviewCommandError?: (message: string) => void;
}): ReactElement {
  const runningConversation = Boolean(actionRunning) || currentWorkpadStatus === "running";
  const canStop = runningConversation
    && Boolean(onStopAndContinue)
    && Boolean(runControlState?.canStop);
  const hasAttachments = (attachments?.length ?? 0) > 0;
  const canSend = Boolean(value.trim()) || hasAttachments;
  const steerIdentityReady = productMode === "harness"
    || Boolean(runControlState?.providerId && runControlState.attemptId);
  const canSteerText = runningConversation
    && Boolean(value.trim())
    && Boolean(runControlState?.canSteer)
    && steerIdentityReady
    && runControlState?.steerState !== "submitting"
    && runControlState?.state !== "stopping";
  const canQueue = canSend && Boolean(turnQueue?.canEnqueue) && !queueBusy;
  const hasNextTurnContext = hasAttachments || (selectedFileRefs?.length ?? 0) > 0;
  const actionProjection = buildComposerActionProjection({
    running: runningConversation,
    queueBusy: Boolean(queueBusy),
    stopping: runControlState?.state === "stopping",
    steerSubmitting: runControlState?.steerState === "submitting",
    hasDraft: canSend,
    hasNextTurnContext,
    canSteer: canSteerText,
    canQueue,
    canStop,
    queueHasItems: Boolean(turnQueue?.items?.length),
    queueReady: queueAvailable !== false,
    disabledReason: disabledReason ?? (!runningConversation ? agentTurnModeDisabledReason : null),
  });
  function submit(): void {
    if (productMode === "agent") {
      const command = parseReviewCommand(value);
      if (command.kind === "open-selector") {
        void onOpenReview?.(value);
        return;
      }
      if (command.kind === "target") {
        void onStartReviewCommand?.(command.target, value);
        return;
      }
      if (command.kind === "invalid") {
        onReviewCommandError?.(command.message);
        return;
      }
    }
    void onSend();
  }
  return (
    <ConversationComposerSurface
      ariaLabel="需求对话输入框"
      inputAriaLabel="需求对话输入框"
      value={value}
      onChange={onChange}
      disabledReason={disabledReason}
      placeholder={runningConversation
        ? runControlState?.canSteer ? "补充当前执行" : "输入下一回合"
        : "输入问题或下一步需求"}
      projectId={projectId}
      skills={skills}
      activeSkillIds={activeSkillIds}
      selectedFileRefs={selectedFileRefs}
      attachments={attachments}
      onAttachFiles={onAttachFiles}
      onRemoveAttachment={onRemoveAttachment}
      onToggleSkill={onToggleSkill}
      onSelectedFileRefsChange={onSelectedFileRefsChange}
      productMode={productMode}
      accessView={accessView}
      onSelectAccess={onSelectAccess}
      onRefreshAccess={onRefreshAccess}
      agentTurnMode={agentTurnMode}
      onSelectAgentTurnMode={onSelectAgentTurnMode}
      planModeDisabledReason={planModeDisabledReason}
      agentTurnModeDisabledReason={agentTurnModeDisabledReason}
      providerDisplayName={providerDisplayName}
      modelLabel={modelLabel}
      selectedProviderId={selectedProviderId}
      agentModelId={agentModelId}
      agentReasoningEffort={agentReasoningEffort}
      providerModelCatalogs={providerModelCatalogs}
      providerModelCatalogsBusy={providerModelCatalogsBusy}
      onRefreshProviderModels={onRefreshProviderModels}
      onSelectAgentProviderModel={onSelectAgentProviderModel}
      onSelectAgentReasoningEffort={onSelectAgentReasoningEffort}
      reviewOpen={reviewOpen}
      reviewOptions={reviewOptions}
      reviewLoading={reviewLoading}
      reviewSubmitting={reviewSubmitting}
      onOpenReview={onOpenReview}
      onCloseReview={onCloseReview}
      onStartReview={onStartReview}
      onSubmit={() => {
        if (!actionProjection.canSubmitDraft) return;
        if (actionProjection.primaryIntent === "queue") void onEnqueue?.();
        else submit();
      }}
      beforeEditor={<ConversationTurnQueue
        snapshot={turnQueue ?? null}
        busy={Boolean(queueBusy)}
        onReclaim={onReclaimQueuedTurn}
        onRemove={onRemoveQueuedTurn}
        onRetry={onRetryQueuedTurn}
        onConfirmExecution={onConfirmQueuedTurnExecution}
      />}
      contextControl={<ConversationContextIndicator
        snapshot={conversationContext ?? null}
        submitting={Boolean(contextSubmitting)}
        onCompact={onCompactContext}
      />}
      trailingControls={
        <ComposerActionButtons
          projection={actionProjection}
          mutationBusy={Boolean(queueBusy)}
          onSend={submit}
          onQueue={() => void onEnqueue?.()}
          onStop={() => void onStopAndContinue?.()}
        />
      }
    />
  );
}

export function ConversationComposerSurface({
  ariaLabel,
  inputAriaLabel,
  className,
  value,
  onChange,
  disabledReason,
  placeholder,
  projectId,
  skills = [],
  activeSkillIds = [],
  selectedFileRefs = [],
  attachments = [],
  onAttachFiles,
  onRemoveAttachment,
  onToggleSkill,
  onSelectedFileRefsChange,
  productMode,
  agentTurnMode,
  accessView,
  onSelectAccess,
  onRefreshAccess,
  onSelectAgentTurnMode,
  planModeDisabledReason,
  selectedProviderId,
  agentModelId,
  agentReasoningEffort,
  providerModelCatalogs,
  providerModelCatalogsBusy,
  onRefreshProviderModels,
  onSelectAgentProviderModel,
  onSelectAgentReasoningEffort,
  reviewOpen,
  reviewOptions,
  reviewLoading,
  reviewSubmitting,
  onOpenReview,
  onCloseReview,
  onStartReview,
  onSubmit,
  focusToken,
  beforeEditor,
  contextControl,
  trailingControls,
}: {
  ariaLabel: string;
  inputAriaLabel: string;
  className?: string;
  value: string;
  onChange: (value: string) => void;
  disabledReason?: string;
  placeholder: string;
  projectId: string | null;
  skills?: SkillListItem[];
  activeSkillIds?: string[];
  selectedFileRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onRemoveAttachment?: (id: string) => void | Promise<void>;
  onToggleSkill?: (skillId: string) => void | Promise<void>;
  onSelectedFileRefsChange?: (refs: TopicFileReference[]) => void;
  productMode?: ProductMode;
  agentTurnMode?: AgentTurnMode;
  accessView?: AgentAccessControlProps["accessView"];
  onSelectAccess?: AgentAccessControlProps["onSelectAccess"];
  onRefreshAccess?: AgentAccessControlProps["onRefreshAccess"];
  onSelectAgentTurnMode?: (mode: AgentTurnMode) => void | Promise<void>;
  agentTurnModeDisabledReason?: string | null;
  planModeDisabledReason?: string | null;
  providerDisplayName?: string;
  modelLabel: string;
  selectedProviderId?: string;
  agentModelId?: string | null;
  agentReasoningEffort?: string | null;
  providerModelCatalogs?: ProviderModelCatalogGroup[];
  providerModelCatalogsBusy?: boolean;
  onRefreshProviderModels?: () => void | Promise<void>;
  onSelectAgentProviderModel?: (providerId: string, modelId: string | null) => void | Promise<void>;
  onSelectAgentReasoningEffort?: (effort: string | null) => void | Promise<void>;
  reviewOpen?: boolean;
  reviewOptions?: ProjectGitReviewOptions | null;
  reviewLoading?: boolean;
  reviewSubmitting?: boolean;
  onOpenReview?: (capturedCommand?: string) => void | Promise<void>;
  onCloseReview?: () => void;
  onStartReview?: (target: ProviderReviewTarget, capturedCommand?: string) => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
  focusToken?: number;
  beforeEditor?: ReactNode;
  contextControl?: ReactNode;
  trailingControls: ReactNode;
}): ReactElement {
  const [dragOver, setDragOver] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusToken === undefined) return;
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [focusToken]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    resizeComposerTextarea(textarea);
  }, [value]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    let observedWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? textarea.getBoundingClientRect().width;
      if (nextWidth === observedWidth) return;
      observedWidth = nextWidth;
      resizeComposerTextarea(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !addMenuRef.current?.contains(event.target)) setAddMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnPointerDown);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnPointerDown);
    };
  }, [addMenuOpen]);

  function insertTrigger(trigger: "@" | "/"): void {
    const separator = value.length > 0 && !/\s$/.test(value) ? " " : "";
    onChange(`${value}${separator}${trigger}`);
    setAddMenuOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  return (
    <ComposerFrame
      className={`${className ?? ""}${dragOver ? `${className ? " " : ""}is-drag-over` : ""}`}
      aria-label={ariaLabel}
      controls={null}
      onDragOver={(event) => {
        if (disabledReason || !hasFileDrag(event)) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        if (disabledReason) return;
        const files = filesFromDrop(event);
        if (files.length === 0) return;
        event.preventDefault();
        setDragOver(false);
        void onAttachFiles?.(files);
      }}
      toolbar={<>
        <div className="composer-add-control" ref={addMenuRef}>
          <button type="button" className="composer-add-trigger" aria-label="添加上下文" aria-expanded={addMenuOpen} disabled={Boolean(disabledReason)} onClick={() => setAddMenuOpen((current) => !current)}><Plus size={18} /></button>
          {addMenuOpen ? <div className="composer-add-menu" role="menu" aria-label="添加到输入框">
            <div className="composer-add-attachment"><ComposerAttachButton disabled={Boolean(disabledReason)} onAttachFiles={(files) => { setAddMenuOpen(false); return onAttachFiles?.(files); }} /><span><Paperclip size={14} />添加附件</span></div>
            <button type="button" role="menuitem" onClick={() => insertTrigger("@") }><File size={15} />引用项目文件</button>
            <button type="button" role="menuitem" disabled={skills.length === 0} onClick={() => insertTrigger("/")}><Sparkles size={15} />选择技能</button>
            {productMode === "agent" ? <button type="button" role="menuitemcheckbox" aria-checked={agentTurnMode === "plan"} disabled={agentTurnMode !== "plan" && Boolean(planModeDisabledReason)} title={planModeDisabledReason ?? undefined} onClick={() => { setAddMenuOpen(false); void onSelectAgentTurnMode?.(agentTurnMode === "plan" ? "default" : "plan"); }}><ListPlus size={15} />计划模式</button> : null}
            {productMode === "agent" ? <button type="button" role="menuitem" disabled={Boolean(reviewSubmitting)} onClick={() => { setAddMenuOpen(false); void onOpenReview?.(); }}><Search size={15} />代码审查</button> : null}
          </div> : null}
        </div>
        {productMode === "agent" ? <AgentAccessControl accessView={accessView} onSelectAccess={onSelectAccess} onRefreshAccess={onRefreshAccess} planning={agentTurnMode === "plan"} /> : null}
        <span className="composer-spacer" />
        {contextControl}
        {onSelectAgentProviderModel && onSelectAgentReasoningEffort ? <ConversationModelSelectors
          catalogs={providerModelCatalogs ?? []}
          selectedProviderId={selectedProviderId ?? null}
          modelId={agentModelId ?? null}
          reasoningEffort={agentReasoningEffort ?? null}
          loading={providerModelCatalogsBusy}
          onRefresh={onRefreshProviderModels}
          onSelectProviderModel={onSelectAgentProviderModel}
          onSelectReasoningEffort={onSelectAgentReasoningEffort}
        /> : null}
        {trailingControls}
      </>}
    >
      {beforeEditor}
      {productMode === "agent" && accessView?.failure ? <div className="composer-access-failure" role="status">{accessView.failure}<button type="button" onClick={() => void onRefreshAccess?.()}>重新检测</button></div> : null}
      {productMode === "agent" && agentTurnMode === "plan" ? <div className="composer-selected-context"><span className="composer-selected-item"><ListPlus size={13} aria-hidden="true" />计划<button type="button" aria-label="退出计划模式" onClick={() => void onSelectAgentTurnMode?.("default")}><X size={12} /></button></span></div> : null}
      {productMode === "agent" && reviewOpen ? <ReviewInlineSelector options={reviewOptions ?? null} loading={Boolean(reviewLoading)} submitting={Boolean(reviewSubmitting)} onClose={() => onCloseReview?.()} onStart={(target) => onStartReview?.(target)} /> : null}
      <SkillMentionPicker value={value} onChange={onChange} skills={skills} activeSkillIds={activeSkillIds} onToggleSkill={onToggleSkill ?? (() => undefined)} />
      <FileMentionPicker projectId={projectId} value={value} onChange={onChange} selectedRefs={selectedFileRefs} onSelectedRefsChange={onSelectedFileRefsChange ?? (() => undefined)} />
      <ComposerSelectedContextItems
        skills={skills}
        activeSkillIds={activeSkillIds}
        fileRefs={selectedFileRefs}
        onToggleSkill={onToggleSkill}
        onFileRefsChange={onSelectedFileRefsChange}
      />
      <ComposerAttachmentList attachments={attachments} onRemove={onRemoveAttachment ?? (() => undefined)} />
      <textarea
        ref={textareaRef}
        aria-label={inputAriaLabel}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void onSubmit();
          }
        }}
        onPaste={(event) => {
          const files = imageFilesFromPaste(event);
          if (files.length === 0) return;
          event.preventDefault();
          void onAttachFiles?.(files);
        }}
        disabled={Boolean(disabledReason)}
        placeholder={disabledReason ?? placeholder}
      />
    </ComposerFrame>
  );
}

function ComposerSelectedContextItems({ skills, activeSkillIds, fileRefs, onToggleSkill, onFileRefsChange }: {
  skills: SkillListItem[];
  activeSkillIds: string[];
  fileRefs: TopicFileReference[];
  onToggleSkill?: (skillId: string) => void | Promise<void>;
  onFileRefsChange?: (refs: TopicFileReference[]) => void;
}): ReactElement | null {
  const selectedSkills = activeSkillIds.map((skillId) => skills.find((skill) => skill.skillId === skillId)).filter((skill): skill is SkillListItem => Boolean(skill));
  if (selectedSkills.length === 0 && fileRefs.length === 0) return null;
  return <div className="composer-selected-context" aria-label="已选上下文">
    {fileRefs.map((file) => <span className="composer-selected-item" key={`file:${file.relativePath}`} title={file.relativePath}><File size={13} aria-hidden="true" /><span>{file.name}</span><button type="button" aria-label={`移除文件 ${file.name}`} onClick={() => onFileRefsChange?.(fileRefs.filter((item) => item.relativePath !== file.relativePath))}><X size={12} /></button></span>)}
    {selectedSkills.map((skill) => <span className="composer-selected-item" key={`skill:${skill.skillId}`} title={skill.description}><Sparkles size={13} aria-hidden="true" /><span>{skill.name}</span><button type="button" aria-label={`移除技能 ${skill.name}`} onClick={() => void onToggleSkill?.(skill.skillId)}><X size={12} /></button></span>)}
  </div>;
}

function ComposerActionButtons({ projection, mutationBusy, onSend, onQueue, onStop }: {
  projection: ComposerActionProjection;
  mutationBusy: boolean;
  onSend: () => void;
  onQueue: () => void;
  onStop: () => void;
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const intent = projection.primaryIntent;
  const contextIntent = projection.canStop && (intent === "steer" || intent === "queue" || intent === "jump-to-request" || intent === "wait")
    ? intent
    : null;
  const primaryIntent: ComposerPrimaryIntent = projection.canStop ? "stop" : intent;
  const primaryLabel = composerActionLabel(primaryIntent, projection.canStop ? null : projection.disabledReason);
  const contextLabel = contextIntent ? composerActionLabel(contextIntent, projection.disabledReason) : "";
  const invokePrimary = () => {
    if (primaryIntent === "send") onSend();
    else if (primaryIntent === "queue") onQueue();
    else if (primaryIntent === "stop") onStop();
  };
  const invokeContext = () => {
    if (contextIntent === "steer") onSend();
    else if (contextIntent === "queue") onQueue();
  };
  return <div className="composer-action-group" data-primary-intent={primaryIntent}>
    <div className={`composer-context-action-slot ${contextIntent ? "is-visible" : ""}`} aria-hidden={contextIntent ? undefined : "true"}>
      <div className={`composer-context-action-wrap ${projection.alternativeIntent ? "has-alternative" : ""}`}>
        <button type="button" className="composer-context-action" tabIndex={contextIntent ? undefined : -1} disabled={!contextIntent || mutationBusy || !projection.canSubmitDraft} title={contextLabel} aria-label={contextLabel || "当前没有其他操作"} onClick={invokeContext}>
          {contextIntent === "wait" ? <LoaderCircle size={14} className="spin" /> : contextIntent === "queue" ? <ListPlus size={14} /> : <ArrowUp size={14} />}
          <span>{contextLabel}</span>
        </button>
        {contextIntent === "steer" && projection.alternativeIntent === "queue" ? <>
          <button type="button" className="composer-action-alternative-trigger" aria-label="其他发送方式" aria-expanded={menuOpen} onClick={() => setMenuOpen((current) => !current)}><ChevronDown size={13} /></button>
          {menuOpen ? <div className="composer-action-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onQueue(); }}><ListPlus size={14} />稍后发送</button></div> : null}
        </> : null}
      </div>
    </div>
    <div className="composer-primary-action">
      <button type="button" className="composer-send" disabled={primaryIntent === "stop" ? false : mutationBusy || !projection.canSubmitDraft} title={primaryLabel} aria-label={primaryLabel} onClick={invokePrimary}>
        {primaryIntent === "stop" ? <Square size={14} fill="currentColor" /> : primaryIntent === "queue" ? <ListPlus size={16} /> : primaryIntent === "wait" ? <LoaderCircle size={16} className={mutationBusy ? "spin" : undefined} /> : <ArrowUp size={17} />}
      </button>
    </div>
  </div>;
}

function composerActionLabel(intent: ComposerPrimaryIntent, disabledReason: string | null): string {
  if (disabledReason) return disabledReason;
  if (intent === "steer") return "发送给当前执行";
  if (intent === "queue") return "稍后发送";
  if (intent === "stop") return "停止当前执行";
  if (intent === "jump-to-request") return "查看待处理请求";
  if (intent === "wait") return "暂时不可发送";
  return "发送";
}

export function ConversationTurnQueue({
  snapshot,
  busy,
  onReclaim,
  onRemove,
  onRetry,
  onConfirmExecution,
}: {
  snapshot: ConversationTurnQueueSnapshot | null;
  busy: boolean;
  onReclaim?: (queueItemId: string) => void | Promise<void>;
  onRemove?: (queueItemId: string) => void | Promise<void>;
  onRetry?: (queueItemId: string) => void | Promise<void>;
  onConfirmExecution?: (queueItemId: string) => void | Promise<void>;
}): ReactElement | null {
  if (!snapshot?.items?.length) return null;
  return <div className="conversation-turn-queue" aria-label="待发送内容">
    <div className="conversation-turn-queue-heading">
      <span>待发送</span>
      <span>{snapshot.items.length}</span>
    </div>
    <ol>
      {snapshot.items.map((item, index) => {
        const needsAttention = queuedTurnNeedsAttention(item.status);
        const settlementPending = queuedTurnSettlementPending(item.status);
        const confirmationRequired = item.executionCompatibility.state !== "compatible";
        return <li key={item.queueItemId} data-attention={needsAttention ? "true" : undefined}>
          <span className="conversation-turn-queue-index">{index + 1}</span>
          <span className="conversation-turn-queue-copy">
            <span>{item.itemKind === "review" ? reviewTargetPreview(item.reviewTarget) : queuePreview(item.text)}</span>
            <small>{confirmationRequired
              ? queueExecutionCompatibilitySummary(item.executionCompatibility)
              : queuedTurnStatusLabel(item.status, item.attachmentIds.length)}</small>
            {item.itemKind !== "review" && item.agentAccessMode != null ? <small>
              {item.agentTurnMode === "plan" ? "计划中仅分析" : item.agentAccessMode === "full-access" ? "完全访问" : "默认权限"}
            </small> : null}
          </span>
          <span className="conversation-turn-queue-actions">
            {confirmationRequired ? <button
              type="button"
              className="conversation-turn-queue-confirm"
              title="按当前方式发送"
              disabled={busy || settlementPending}
              onClick={() => void onConfirmExecution?.(item.queueItemId)}
            >按当前方式发送</button> : needsAttention ? <button
              type="button"
              title="重新尝试"
              aria-label="重新尝试发送"
              disabled={busy}
              onClick={() => void onRetry?.(item.queueItemId)}
            ><RotateCcw size={14} /></button> : null}
            <button
              type="button"
              title="移回输入框"
              aria-label="移回输入框"
              disabled={busy || settlementPending}
              onClick={() => void onReclaim?.(item.queueItemId)}
            ><Undo2 size={14} /></button>
            <button
              type="button"
              title="删除待发送内容"
              aria-label="删除待发送内容"
              disabled={busy || settlementPending}
              onClick={() => void onRemove?.(item.queueItemId)}
            ><Trash2 size={14} /></button>
          </span>
        </li>;
      })}
    </ol>
  </div>;
}

function queueExecutionCompatibilitySummary(
  compatibility: ConversationTurnQueueSnapshot["items"][number]["executionCompatibility"],
): string {
  return compatibility.state === "compatible" ? "" : compatibility.summary;
}

function reviewTargetPreview(target: ProviderReviewTarget | null): string {
  if (!target) return "代码审查";
  if (target.type === "uncommitted-changes") return "审查未提交改动";
  if (target.type === "base-branch") return `代码审查 · ${target.branch}`;
  if (target.type === "commit") return `代码审查 · ${target.sha.slice(0, 7)}`;
  const text = target.instructions.replace(/\s+/g, " ").trim();
  return `代码审查 · ${text.length > 72 ? `${text.slice(0, 71)}...` : text}`;
}

type ReviewSelectorStep = "preset" | "base" | "commit" | "custom";

export function ReviewInlineSelector({ options, loading, submitting, onClose, onStart }: {
  options: ProjectGitReviewOptions | null;
  loading: boolean;
  submitting: boolean;
  onClose(): void;
  onStart(target: ProviderReviewTarget): void | Promise<void>;
}): ReactElement {
  const [step, setStep] = useState<ReviewSelectorStep>("preset");
  const [activeIndex, setActiveIndex] = useState(0);
  const [custom, setCustom] = useState("");
  const selectorRef = useRef<HTMLDivElement | null>(null);
  const presets: Array<{ label: string; detail?: string; step?: ReviewSelectorStep; target?: ProviderReviewTarget }> = [
    { label: "对比基准分支", detail: "PR 风格", step: "base" },
    { label: "审查未提交改动", target: { type: "uncommitted-changes" } },
    { label: "审查指定 Commit", step: "commit" },
    { label: "自定义审查要求", step: "custom" },
  ];
  const entries: Array<{ label: string; detail?: string; step?: ReviewSelectorStep; target?: ProviderReviewTarget }> = step === "preset" ? presets
    : step === "base" ? (options?.branches ?? []).map((branch) => ({ label: branch.name, target: { type: "base-branch", branch: branch.name } as ProviderReviewTarget }))
      : step === "commit" ? (options?.commits ?? []).map((commit) => ({ label: commit.summary || commit.shortSha, detail: commit.shortSha, target: { type: "commit", sha: commit.sha, title: commit.summary } as ProviderReviewTarget }))
        : [];
  useEffect(() => setActiveIndex(0), [step]);
  useEffect(() => selectorRef.current?.focus(), []);

  function choose(index: number): void {
    const entry = entries[index];
    if (!entry || submitting) return;
    if ("step" in entry && entry.step) setStep(entry.step);
    else if (entry.target) void onStart(entry.target);
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (step === "preset") onClose(); else setStep("preset");
      return;
    }
    if (step === "custom") {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && custom.trim()) {
        event.preventDefault();
        void onStart({ type: "custom", instructions: custom.trim() });
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => entries.length ? (current + direction + entries.length) % entries.length : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex);
    }
  }

  return <div ref={selectorRef} className="review-inline-selector" role="dialog" aria-label="选择代码审查方式" tabIndex={-1} onKeyDown={onKeyDown}>
    <header>
      <div>
        <strong>{step === "preset" ? "代码审查" : step === "base" ? "选择基准分支" : step === "commit" ? "选择 Commit" : "自定义审查要求"}</strong>
        <span>{options?.branch ? `当前分支 ${options.branch}` : "当前项目"}</span>
      </div>
      <div>
        {step !== "preset" ? <button type="button" title="返回" aria-label="返回" onClick={() => setStep("preset")}><ArrowLeft size={15} /></button> : null}
        <button type="button" title="关闭" aria-label="关闭代码审查选择器" onClick={onClose}><X size={15} /></button>
      </div>
    </header>
    {loading ? <div className="review-inline-empty"><LoaderCircle size={15} className="spin" /> 正在读取 Git 状态</div>
      : !options?.isGitRepository ? <div className="review-inline-empty">{options?.message ?? "当前项目不是 Git 仓库。"}</div>
        : step === "custom" ? <div className="review-inline-custom">
          <textarea autoFocus rows={4} value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="说明重点、范围或风险..." />
          <button type="button" disabled={submitting || !custom.trim()} onClick={() => void onStart({ type: "custom", instructions: custom.trim() })}>开始审查</button>
        </div>
          : <div className="review-inline-options" role="listbox">
            {entries.length ? entries.map((entry, index) => <button
              key={`${step}:${entry.label}:${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "is-active" : ""}
              disabled={submitting}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            ><span><strong>{entry.label}</strong>{entry.detail ? <small>{entry.detail}</small> : null}</span>{index === activeIndex ? <Check size={15} /> : null}</button>)
              : <div className="review-inline-empty">没有可用选项。</div>}
          </div>}
  </div>;
}

function queuePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 95)}...` : normalized;
}

function queuedTurnStatusLabel(status: string, attachmentCount: number): string {
  const statusLabel = status === "dispatching" ? "正在提交"
    : status === "blocked" ? "需要处理"
      : "等待发送";
  return attachmentCount > 0 ? `${statusLabel} · ${attachmentCount} 个附件` : statusLabel;
}

function queuedTurnNeedsAttention(status: string): boolean {
  return status === "blocked";
}

function queuedTurnSettlementPending(status: string): boolean {
  return status === "dispatching";
}

export function ConversationContextIndicator({
  snapshot,
  submitting,
  onCompact,
}: {
  snapshot: ConversationContextSnapshot | null;
  submitting: boolean;
  onCompact?: () => void | Promise<void>;
}): ReactElement {
  const [open, setOpen] = useState(false);
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
  return <div className="conversation-context-control">
    <button
      type="button"
      className={`conversation-context-indicator ${busy ? "is-busy" : ""} ${failed ? "is-error" : ""}`}
      aria-label={title}
      title={title}
      onClick={() => setOpen((value) => !value)}
    >
      {busy ? <RefreshCw size={15} /> : failed ? <AlertCircle size={15} /> : lifecycle === "completed" ? <CheckCircle2 size={15} /> : <Gauge size={15} />}
      {snapshot?.usedPercent !== null && snapshot?.usedPercent !== undefined ? <span>{snapshot.usedPercent}%</span> : null}
    </button>
    {open ? <div className="conversation-context-popover" role="dialog" aria-label="会话上下文">
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

function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const contentHeight = textarea.scrollHeight;
  textarea.style.height = `${Math.min(160, Math.max(44, contentHeight))}px`;
  textarea.style.overflowY = contentHeight > 160 ? "auto" : "hidden";
}
