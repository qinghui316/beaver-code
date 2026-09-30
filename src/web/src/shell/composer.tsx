import { ComposerActionButtons, ConversationTurnQueue, ConversationContextIndicator } from "./ComposerExecutionControls.js";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
export { ConversationTurnQueue, ConversationContextIndicator } from "./ComposerExecutionControls.js";
import { AgentAccessControl, type AgentAccessControlProps } from "./AgentAccessControl.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from "react";
import { ArrowLeft, Check, File, Lightbulb, LoaderCircle, Paperclip, Plus, Search, Sparkles, X } from "lucide-react";
import type { AgentTurnMode, ConversationContextSnapshot, ConversationTurnQueueSnapshot, ProductMode, ProjectGitReviewOptions, ProviderModelCatalogGroup, ProviderReviewTarget, SkillListItem, TopicAttachment, TopicFileReference, WorkpadRuntimeStatus } from "../types.js";
import { parseReviewCommand } from "../reviewCommand.js";
import { ComposerAttachmentList, ComposerFileInput, filesFromDrop, hasFileDrag, imageFilesFromPaste } from "./ComposerAttachments.js";
import { ConversationModelSelectors } from "./ConversationModelSelectors.js";
import { FileMentionPicker } from "./FileMentionPicker.js";
import { SkillMentionPicker } from "./SkillMentionPicker.js";
import { ComposerFrame } from "./ComposerFrame.js";
import {
  buildComposerActionProjection,
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
  conversationId,
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
  onGuideQueuedTurn,
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
  conversationId?: string | null;
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
  onGuideQueuedTurn?: (queueItemId: string) => void | Promise<void>;
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
  const canQueue = canSend && Boolean(turnQueue?.canEnqueue) && !queueBusy;
  const actionProjection = buildComposerActionProjection({
    running: runningConversation,
    queueBusy: Boolean(queueBusy),
    stopping: runControlState?.state === "stopping",
    steerSubmitting: runControlState?.steerState === "submitting",
    hasDraft: canSend,
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
        ? "输入下一条需求"
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
        submit();
      }}
      beforeEditor={<ConversationTurnQueue
        snapshot={turnQueue ?? null}
        busy={Boolean(queueBusy)}
        onReclaim={onReclaimQueuedTurn}
        onGuide={onGuideQueuedTurn}
        onRemove={onRemoveQueuedTurn}
        onRetry={onRetryQueuedTurn}
        onConfirmExecution={onConfirmQueuedTurnExecution}
      />}
      contextControl={<ConversationContextIndicator
        scopeKey={`${projectId}:${productMode}:${conversationId ?? turnQueue?.conversationId ?? ""}`}
        dismiss={Boolean(reviewOpen)}
        snapshot={conversationContext ?? null}
        submitting={Boolean(contextSubmitting)}
        onCompact={onCompactContext}
      />}
      trailingControls={
        <ComposerActionButtons
          projection={actionProjection}
          hasDraft={Boolean(value.trim() || hasAttachments || selectedFileRefs?.length)}
          mutationBusy={Boolean(queueBusy)}
          onSend={submit}
          onQueue={submit}
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
  const planDisabledDescriptionId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const restoreEditorFocusRef = useRef(false);

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
  function insertTrigger(trigger: "@" | "/"): void {
    const separator = value.length > 0 && !/\s$/.test(value) ? " " : "";
    onChange(`${value}${separator}${trigger}`);
    restoreEditorFocusRef.current = true;
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
        <div className="composer-leading-controls">
          <div className="composer-add-control">
            <ComposerFileInput inputRef={fileInputRef} onAttachFiles={onAttachFiles} />
            <DropdownMenu.Root open={addMenuOpen} onOpenChange={setAddMenuOpen}>
              <DropdownMenu.Trigger asChild>
                <button type="button" className="composer-add-trigger" aria-label="添加上下文" disabled={Boolean(disabledReason)}><Plus size={18} /></button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="composer-add-menu" side="top" align="start" sideOffset={8} collisionPadding={12} aria-label="添加到输入框" aria-describedby={productMode === "agent" && agentTurnMode !== "plan" && planModeDisabledReason ? planDisabledDescriptionId : undefined} onCloseAutoFocus={(event) => {
                  if (!restoreEditorFocusRef.current) return;
                  event.preventDefault();
                  restoreEditorFocusRef.current = false;
                  window.setTimeout(() => textareaRef.current?.focus(), 0);
                }}>
                  <DropdownMenu.Item className="composer-menu-item" onSelect={() => fileInputRef.current?.click()}><Paperclip size={15} />添加附件</DropdownMenu.Item>
                  <DropdownMenu.Item className="composer-menu-item" onSelect={() => insertTrigger("@") }><File size={15} />引用项目文件</DropdownMenu.Item>
                  <DropdownMenu.Item className="composer-menu-item" disabled={skills.length === 0} onSelect={() => insertTrigger("/")}><Sparkles size={15} />选择技能</DropdownMenu.Item>
                  {productMode === "agent" ? <DropdownMenu.CheckboxItem className="composer-menu-item" checked={agentTurnMode === "plan"} disabled={agentTurnMode !== "plan" && Boolean(planModeDisabledReason)} onSelect={() => void onSelectAgentTurnMode?.(agentTurnMode === "plan" ? "default" : "plan")}><Lightbulb size={15} />计划模式{agentTurnMode === "plan" ? <Check size={14} className="composer-menu-check" /> : null}</DropdownMenu.CheckboxItem> : null}
                  {productMode === "agent" && agentTurnMode !== "plan" && planModeDisabledReason ? <DropdownMenu.Label id={planDisabledDescriptionId} className="composer-menu-disabled-reason">{planModeDisabledReason}</DropdownMenu.Label> : null}
                  {productMode === "agent" ? <DropdownMenu.Item className="composer-menu-item" disabled={Boolean(reviewSubmitting)} onSelect={() => void onOpenReview?.()}><Search size={15} />代码审查</DropdownMenu.Item> : null}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
          {productMode === "agent" ? <AgentAccessControl accessView={accessView} onSelectAccess={onSelectAccess} onRefreshAccess={onRefreshAccess} /> : null}
          {productMode === "agent" && agentTurnMode === "plan" ? <span className="composer-plan-indicator" aria-label="当前为计划模式">
            <span className="composer-plan-divider" aria-hidden="true" />
            <Lightbulb size={15} aria-hidden="true" /><span>计划</span>
            <button type="button" className="composer-plan-exit" aria-label="退出计划模式" onClick={() => void onSelectAgentTurnMode?.("default")}><X size={13} /></button>
          </span> : null}
        </div>
        <div className="composer-end-controls">
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
        </div>
      </>}
    >
      {beforeEditor}
      {productMode === "agent" && accessView?.failure ? <div className="composer-access-failure" role="status">{accessView.failure}<button type="button" onClick={() => void onRefreshAccess?.()}>重新检测</button></div> : null}
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

function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const contentHeight = textarea.scrollHeight;
  textarea.style.height = `${Math.min(160, Math.max(44, contentHeight))}px`;
  textarea.style.overflowY = contentHeight > 160 ? "auto" : "hidden";
}
