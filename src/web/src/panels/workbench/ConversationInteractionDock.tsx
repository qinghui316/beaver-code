import {
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FilePenLine,
  Pencil,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  ConversationInteraction,
  ConversationInteractionQuestion,
  ConversationInteractionSettlement,
} from "../../../../workbench/conversation-interaction-contract.js";

export interface ConversationInteractionDockProps {
  interaction: ConversationInteraction;
  busy: boolean;
  canStop?: boolean;
  initialDraft?: ConversationInteractionDraft;
  onDraftChange?: (interactionId: string, draft: ConversationInteractionDraft) => void;
  onSettle: (interactionId: string, settlement: ConversationInteractionSettlement) => Promise<void>;
  onStop: () => Promise<void>;
}

export interface ConversationInteractionDraft {
  questionIndex: number;
  answers: Record<string, string | string[]>;
  skippedQuestionIds: string[];
  feedbackExpanded: boolean;
  feedback: string;
}

export function ConversationInteractionDock({
  interaction,
  ...props
}: ConversationInteractionDockProps): ReactElement {
  return <ConversationInteractionDockBody key={`${interaction.interactionId}:${interaction.status}`} interaction={interaction} {...props} />;
}

function ConversationInteractionDockBody({
  interaction,
  busy,
  canStop = false,
  initialDraft,
  onDraftChange,
  onSettle,
  onStop,
}: ConversationInteractionDockProps): ReactElement {
  const restorableDraft = restorableInteractionDraft(interaction, initialDraft);
  const [questionIndex, setQuestionIndex] = useState(restorableDraft.questionIndex);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(restorableDraft.answers);
  const [skippedQuestionIds, setSkippedQuestionIds] = useState<string[]>(initialDraft?.skippedQuestionIds ?? []);
  const [secretVisible, setSecretVisible] = useState(false);
  const [feedbackExpanded, setFeedbackExpanded] = useState(initialDraft?.feedbackExpanded ?? false);
  const [feedback, setFeedback] = useState(initialDraft?.feedback ?? "");
  const [pendingAction, setPendingAction] = useState<ConversationInteractionSettlement["action"] | "stop" | null>(null);

  useEffect(() => {
    onDraftChange?.(interaction.interactionId, {
      questionIndex,
      answers: restorableAnswers(interaction, answers),
      skippedQuestionIds,
      feedbackExpanded,
      feedback,
    });
  }, [answers, feedback, feedbackExpanded, interaction.interactionId, onDraftChange, questionIndex, skippedQuestionIds]);

  const disabled = busy || interaction.status === "submitting" || pendingAction !== null;

  async function settle(settlement: ConversationInteractionSettlement): Promise<void> {
    if (disabled) return;
    setPendingAction(settlement.action);
    try {
      await onSettle(interaction.interactionId, settlement);
    } finally {
      setPendingAction(null);
    }
  }

  async function close(): Promise<void> {
    if (interaction.kind === "provider-approval") return;
    await settle({ action: "skip" });
  }

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape" || interaction.kind === "provider-approval" || busy || pendingAction !== null) return;
      event.preventDefault();
      void close();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  });

  async function stop(): Promise<void> {
    if (disabled) return;
    setPendingAction("stop");
    try {
      await onStop();
    } finally {
      setPendingAction(null);
    }
  }

  if (interaction.kind === "provider-approval") {
    const Icon = interaction.approvalKind === "command-execution"
      ? Terminal
      : interaction.approvalKind === "file-change"
        ? FilePenLine
        : ShieldCheck;
    const summary = interaction.summary;
    return (
      <DockShell
        title={interaction.title}
        disabled={disabled}
        canStop={canStop}
        stopping={pendingAction === "stop"}
        onStop={() => void stop()}
      >
        <div className="interaction-dock-question interaction-dock-approval" data-approval-kind={interaction.approvalKind}>
          <div className="interaction-dock-approval-heading">
            <Icon size={18} aria-hidden="true" />
            <strong>{interaction.reason || approvalDescription(interaction.approvalKind)}</strong>
          </div>
          {summary.command ? <pre className="interaction-dock-approval-command">{summary.command}</pre> : null}
          {summary.cwd ? <p><strong>工作目录</strong><span>{summary.cwd}</span></p> : null}
          {summary.paths?.map((path) => <p key={path}><strong>目标</strong><span>{path}</span></p>)}
          {summary.network ? <p><strong>网络</strong><span>允许当前回合访问网络</span></p> : null}
          {summary.readPaths?.map((path) => <p key={`read:${path}`}><strong>读取</strong><span>{path}</span></p>)}
          {summary.writePaths?.map((path) => <p key={`write:${path}`}><strong>写入</strong><span>{path}</span></p>)}
          {interaction.readOnlyBlocked ? <p className="interaction-dock-approval-blocked">计划回合保持只读，无法批准该写入请求。</p> : null}
          <div className="interaction-dock-footer interaction-dock-footer-start">
            {interaction.availableDecisions.includes("approve-once") ? (
              <button type="button" className="interaction-dock-primary" disabled={disabled} onClick={() => void settle({ action: "approve-once" })}>
                {pendingAction === "approve-once" ? "正在提交" : "仅本次允许"}
              </button>
            ) : null}
            {interaction.availableDecisions.includes("approve-for-session") ? (
              <button type="button" className="interaction-dock-secondary" disabled={disabled} onClick={() => void settle({ action: "approve-for-session" })}>
                {pendingAction === "approve-for-session" ? "正在提交" : "本会话允许"}
              </button>
            ) : null}
            {interaction.availableDecisions.includes("decline") ? (
              <button type="button" className="interaction-dock-link" disabled={disabled} onClick={() => void settle({ action: "decline" })}>
                {pendingAction === "decline" ? "正在拒绝" : "拒绝"}
              </button>
            ) : null}
            {interaction.availableDecisions.includes("cancel-turn") ? (
              <button type="button" className="interaction-dock-link" disabled={disabled} onClick={() => void settle({ action: "cancel-turn" })}>
                {pendingAction === "cancel-turn" ? "正在停止" : "拒绝并停止"}
              </button>
            ) : null}
          </div>
        </div>
      </DockShell>
    );
  }

  if (interaction.kind === "plan") {
    return (
      <DockShell
        title="实施此计划？"
        disabled={disabled}
        canStop={canStop}
        stopping={pendingAction === "stop"}
        onClose={() => void close()}
        onStop={() => void stop()}
      >
        <div className="interaction-dock-plan-actions">
          <button
            type="button"
            className="interaction-dock-option"
            disabled={disabled}
            onClick={() => void settle({ action: "execute-plan" })}
          >
            <span className="interaction-dock-option-mark" aria-hidden="true">1</span>
            <span className="interaction-dock-option-copy"><strong>{pendingAction === "execute-plan" ? "正在提交" : "是，实施此计划"}</strong></span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="interaction-dock-option"
            disabled={disabled}
            aria-expanded={feedbackExpanded}
            onClick={() => setFeedbackExpanded(true)}
          >
            <span className="interaction-dock-option-mark interaction-dock-pencil-mark" aria-hidden="true"><Pencil size={13} /></span>
            <span className="interaction-dock-option-copy"><strong>否，并告诉 Agent 应该如何做得不同</strong></span>
          </button>
        </div>
        <div className="interaction-dock-footer">
          <button type="button" className="interaction-dock-link" disabled={disabled} onClick={() => void settle({ action: "skip" })}>
            跳过
          </button>
        </div>
        {feedbackExpanded ? (
          <div className="interaction-dock-feedback">
            <label htmlFor={`interaction-feedback-${interaction.interactionId}`}>修改意见</label>
            <textarea
              id={`interaction-feedback-${interaction.interactionId}`}
              value={feedback}
              disabled={disabled}
              autoFocus
              placeholder="说明希望规划 Agent 修改的内容"
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || !feedback.trim()) return;
                event.preventDefault();
                void settle({ action: "revise-plan", feedback: feedback.trim() });
              }}
            />
            <button
              type="button"
              className="interaction-dock-primary interaction-dock-feedback-submit"
              disabled={disabled || !feedback.trim()}
              onClick={() => void settle({ action: "revise-plan", feedback: feedback.trim() })}
            >
              {pendingAction === "revise-plan" ? "正在提交" : "提交修改意见"}
            </button>
          </div>
        ) : null}
      </DockShell>
    );
  }

  const questions = interaction.questions;
  const safeQuestionIndex = Math.min(questionIndex, Math.max(questions.length - 1, 0));
  const question = questions[safeQuestionIndex];

  function moveTo(index: number): void {
    setQuestionIndex(Math.max(0, Math.min(index, questions.length - 1)));
    setSecretVisible(false);
  }

  function submitDraft(nextAnswers: Record<string, string | string[]> = answers, nextSkipped = skippedQuestionIds): void {
    const unresolvedIndex = questions.findIndex((candidate) => (
      !(candidate.questionId in nextAnswers) && !nextSkipped.includes(candidate.questionId)
    ));
    if (unresolvedIndex >= 0) {
      moveTo(unresolvedIndex);
      return;
    }
    void settle({
      action: "answer",
      answers: nextAnswers,
      skippedQuestionIds: nextSkipped,
    });
  }

  function commitQuestion(value: string | string[]): void {
    if (!question) return;
    const normalized = Array.isArray(value) ? value.filter(Boolean) : value.trim();
    if (Array.isArray(normalized) ? normalized.length === 0 : !normalized) return;
    const nextAnswers = { ...answers, [question.questionId]: normalized };
    const nextSkipped = skippedQuestionIds.filter((questionId) => questionId !== question.questionId);
    setAnswers(nextAnswers);
    setSkippedQuestionIds(nextSkipped);
    if (safeQuestionIndex === questions.length - 1) submitDraft(nextAnswers, nextSkipped);
    else moveTo(safeQuestionIndex + 1);
  }

  function skipQuestion(): void {
    if (!question || !interaction.canSkip) return;
    const nextAnswers = { ...answers };
    delete nextAnswers[question.questionId];
    const nextSkipped = skippedQuestionIds.includes(question.questionId)
      ? skippedQuestionIds
      : [...skippedQuestionIds, question.questionId];
    setAnswers(nextAnswers);
    setSkippedQuestionIds(nextSkipped);
    if (safeQuestionIndex === questions.length - 1) submitDraft(nextAnswers, nextSkipped);
    else moveTo(safeQuestionIndex + 1);
  }

  return (
    <DockShell
      title={question?.title ?? interaction.title}
      disabled={disabled}
      canStop={canStop}
      stopping={pendingAction === "stop"}
      onClose={() => void close()}
      onStop={() => void stop()}
      navigation={questions.length > 0 ? (
        <div className="interaction-dock-navigation" aria-label="问题导航">
          <button
            type="button"
            className="interaction-dock-icon-button"
            disabled={disabled || safeQuestionIndex === 0}
            aria-label="上一题"
            onClick={() => moveTo(safeQuestionIndex - 1)}
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <span aria-live="polite">{safeQuestionIndex + 1} of {questions.length}</span>
          <button
            type="button"
            className="interaction-dock-icon-button"
            disabled={disabled || safeQuestionIndex === questions.length - 1}
            aria-label="下一题"
            onClick={() => moveTo(safeQuestionIndex + 1)}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      ) : undefined}
    >
      {question ? (
        <QuestionEditor
          question={question}
          answer={answers[question.questionId]}
          skipped={skippedQuestionIds.includes(question.questionId)}
          secretVisible={secretVisible}
          disabled={disabled}
          finalQuestion={safeQuestionIndex === questions.length - 1}
          onAnswerChange={(answer) => {
            setAnswers((current) => ({ ...current, [question.questionId]: answer }));
            setSkippedQuestionIds((current) => current.filter((questionId) => questionId !== question.questionId));
          }}
          onCommit={commitQuestion}
          onToggleSecret={() => setSecretVisible((visible) => !visible)}
          onSkip={skipQuestion}
          canSkip={interaction.canSkip}
        />
      ) : (
        <p className="interaction-dock-empty">当前交互没有可回答的问题。</p>
      )}
    </DockShell>
  );
}

function restorableInteractionDraft(
  interaction: ConversationInteraction,
  draft: ConversationInteractionDraft | undefined,
): Pick<ConversationInteractionDraft, "questionIndex" | "answers"> {
  const answers = restorableAnswers(interaction, draft?.answers ?? {});
  const requestedIndex = draft?.questionIndex ?? 0;
  const unresolvedSecretIndex = interaction.questions.findIndex((question, index) => (
    index <= requestedIndex
    && question.inputMode === "secret"
    && !(question.questionId in answers)
    && !draft?.skippedQuestionIds.includes(question.questionId)
  ));
  return {
    answers,
    questionIndex: unresolvedSecretIndex >= 0 ? unresolvedSecretIndex : requestedIndex,
  };
}

function restorableAnswers(
  interaction: ConversationInteraction,
  answers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const secretQuestionIds = new Set(interaction.questions
    .filter((question) => question.inputMode === "secret")
    .map((question) => question.questionId));
  return Object.fromEntries(Object.entries(answers).filter(([questionId]) => !secretQuestionIds.has(questionId)));
}

function DockShell({
  title,
  disabled,
  canStop,
  stopping,
  navigation,
  onClose,
  onStop,
  children,
}: {
  title: string;
  disabled: boolean;
  canStop: boolean;
  stopping: boolean;
  navigation?: ReactElement;
  onClose?: () => void;
  onStop: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="conversation-interaction-dock" data-testid="conversation-interaction-dock" aria-label="对话交互" aria-busy={disabled}>
      <header className="interaction-dock-header">
        <strong>{title}</strong>
        <div className="interaction-dock-header-actions">
          {navigation}
          {canStop ? <button
            type="button"
            className="interaction-dock-icon-button interaction-dock-stop"
            disabled={disabled}
            aria-label={stopping ? "正在停止当前执行" : "停止当前执行"}
            title={stopping ? "正在停止当前执行" : "停止当前执行"}
            onClick={onStop}
          >
            <Square size={15} fill="currentColor" aria-hidden="true" />
          </button> : null}
          {onClose ? <button
            type="button"
            className="interaction-dock-icon-button"
            disabled={disabled}
            aria-label="关闭并跳过"
            title="关闭并跳过"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button> : null}
        </div>
      </header>
      <div className="interaction-dock-body">{children}</div>
    </section>
  );
}

function approvalDescription(kind: "command-execution" | "file-change" | "permissions"): string {
  if (kind === "command-execution") return "Agent 请求运行该命令";
  if (kind === "file-change") return "Agent 请求应用文件修改";
  return "Agent 请求扩展当前回合的权限";
}

function QuestionEditor({
  question,
  answer,
  skipped,
  secretVisible,
  disabled,
  finalQuestion,
  canSkip,
  onAnswerChange,
  onCommit,
  onToggleSecret,
  onSkip,
}: {
  question: ConversationInteractionQuestion;
  answer: string | string[] | undefined;
  skipped: boolean;
  secretVisible: boolean;
  disabled: boolean;
  finalQuestion: boolean;
  canSkip: boolean;
  onAnswerChange: (answer: string | string[]) => void;
  onCommit: (answer: string | string[]) => void;
  onToggleSecret: () => void;
  onSkip: () => void;
}): ReactElement {
  const selectedValues = Array.isArray(answer) ? answer : typeof answer === "string" ? [answer] : [];
  const textAnswer = typeof answer === "string" ? answer : "";
  const showsTextInput = question.inputMode === "text" || question.inputMode === "secret" || question.allowCustom;
  const inputLabel = question.inputMode === "secret" ? "敏感回答" : "自定义回答";

  function handleTextKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || !textAnswer.trim()) return;
    event.preventDefault();
    onCommit(textAnswer);
  }

  return (
    <div className="interaction-dock-question" data-question-id={question.questionId}>
      {question.options.length > 0 ? (
        <div className="interaction-dock-options" aria-label="回答选项">
          {question.options.map((option, index) => {
            const selected = selectedValues.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className={`interaction-dock-option ${selected ? "is-selected" : ""}`}
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => {
                  if (question.inputMode === "multiple") {
                    const next = selected
                      ? selectedValues.filter((value) => value !== option.value)
                      : [...selectedValues, option.value];
                    onAnswerChange(next);
                  } else {
                    onCommit(option.value);
                  }
                }}
              >
                <span className="interaction-dock-option-mark" aria-hidden="true">
                  {question.inputMode === "multiple" && selected ? <Check size={14} /> : index + 1}
                </span>
                <span className="interaction-dock-option-copy">
                  <strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}
                </span>
                {question.inputMode === "single" ? <ChevronRight size={16} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {showsTextInput ? (
        <div className="interaction-dock-input-row">
          <Pencil className="interaction-dock-input-pencil" size={15} aria-hidden="true" />
          <label className="interaction-dock-text-input">
            <span className="interaction-dock-sr-only">{inputLabel}</span>
            <input
              type={question.inputMode === "secret" && !secretVisible ? "password" : "text"}
              value={textAnswer}
              disabled={disabled}
              placeholder=""
              aria-label={inputLabel}
              onChange={(event) => onAnswerChange(event.target.value)}
              onKeyDown={handleTextKeyDown}
            />
          </label>
          {question.inputMode === "secret" ? (
            <button
              type="button"
              className="interaction-dock-icon-button"
              disabled={disabled}
              aria-label={secretVisible ? "隐藏敏感回答" : "显示敏感回答"}
              title={secretVisible ? "隐藏敏感回答" : "显示敏感回答"}
              onClick={onToggleSecret}
            >
              {secretVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
            </button>
          ) : null}
          {canSkip ? (
            <button type="button" className="interaction-dock-link" disabled={disabled} onClick={onSkip}>
              {skipped ? "已跳过" : "跳过"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="interaction-dock-footer interaction-dock-footer-skip-only">
          {canSkip ? (
            <button type="button" className="interaction-dock-link" disabled={disabled} onClick={onSkip}>
              {skipped ? "已跳过" : "跳过"}
            </button>
          ) : null}
        </div>
      )}
      {question.inputMode === "multiple" ? (
        <div className="interaction-dock-footer interaction-dock-multiple-submit">
          <button
            type="button"
            className="interaction-dock-primary"
            disabled={disabled || selectedValues.length === 0 || selectedValues.every((value) => !value.trim())}
            onClick={() => onCommit(question.inputMode === "multiple" ? selectedValues : textAnswer)}
          >
            {finalQuestion ? "提交" : "下一步"}
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
