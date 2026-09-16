import type { AssistantTurnActivity, AssistantTurnBlock, WorkbenchProviderUserInputRequest } from "./types.js";
import type { InteractionHistoryRecord } from "./conversation-interaction-contract.js";
import type { TopicAttachment, TopicFileReference } from "./timeline-cell-contract.js";
export type {
  ParentAgentEvidenceRef,
  ParentAgentTranscriptActor,
  ParentAgentTranscriptBlock,
  ParentAgentTranscriptBlockKind,
  ParentAgentTranscriptBlockSource,
  ParentAgentTranscriptCell,
  ParentAgentTranscriptCellKind,
  ParentAgentTranscriptItem,
} from "./timeline-cell-contract.js";
import type {
  ParentAgentTranscriptBlockSource,
  ParentAgentTranscriptCell,
  ParentAgentTranscriptItem,
} from "./timeline-cell-contract.js";
import { commandDetailText, commandGroupDetailText, commandGroupSummary, commandRowTitle, groupConsecutiveCommandBlocks } from "../command-transcript.js";

export interface ParentAgentTranscript {
  conversationId?: string;
  changeId?: string;
  title: string;
  cells: ParentAgentTranscriptCell[];
  items: ParentAgentTranscriptItem[];
  emptyMessage?: string;
  paging?: ParentAgentTranscriptPaging;
}

export interface ParentAgentTranscriptPaging {
  limit: number;
  totalCount: number;
  hasMoreBefore: boolean;
  nextBeforeCursor?: string;
}

interface TranscriptThreadItemInput {
  id: string;
  kind: string;
  label: string;
  body?: string;
  actionType?: string;
  timestamp?: string;
  source?: string;
  status?: string;
  providerId?: string;
  attemptId?: string;
  runId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  itemId?: string;
  artifact?: string;
  agentRoleId?: string;
  agentTaskId?: string;
  initialThreadInput?: boolean;
  activity?: AssistantTurnActivity[];
  blocks?: AssistantTurnBlock[];
  contextRefs?: TopicFileReference[];
  attachments?: TopicAttachment[];
  providerUserInput?: WorkbenchProviderUserInputRequest;
  providerReview?: import("./types.js").ConversationReviewEvidence;
  error?: string;
  retryTarget?: import("./types.js").ConversationRetryTargetEvidence;
  forkTarget?: import("./types.js").ConversationForkTargetEvidence;
}

export function canonicalTranscriptCellsFromThreadItem(
  item: TranscriptThreadItemInput,
  options: { forceAgentRoleId?: string; parentVisible?: boolean } = {},
): ParentAgentTranscriptCell[] {
  const agentRoleId = options.forceAgentRoleId ?? item.agentRoleId;
  if (item.kind === "user-message") {
    const text = canonicalMessageText(item.body ?? item.label);
    return text
      ? [{
          id: `cell:user:${item.id}`,
          kind: "user-message",
          source: item.providerId ? "provider-runtime" : "user",
          timestamp: item.timestamp,
          agentRoleId,
          agentTaskId: item.agentTaskId,
          initialThreadInput: item.initialThreadInput,
          runId: item.runId,
          providerId: item.providerId,
          attemptId: item.attemptId,
          threadId: item.threadId,
          parentThreadId: item.parentThreadId,
          turnId: item.turnId,
          itemId: item.itemId,
          text,
          contextRefs: item.contextRefs?.length ? item.contextRefs : undefined,
          attachments: item.attachments?.length ? item.attachments : undefined,
        }]
      : [];
  }

  if (item.providerReview) {
    const status = item.status ?? "submitting";
    const failed = status === "failed" || status === "interrupted";
    return [{
      id: `cell:review:${item.id}`,
      kind: "review-card",
      source: "provider-runtime",
      timestamp: item.timestamp,
      agentRoleId,
      runId: item.runId,
      providerId: item.providerId,
      attemptId: item.attemptId,
      threadId: item.threadId,
      turnId: item.turnId,
      title: reviewTargetTitle(item.providerReview.target),
      text: item.body?.trim() || item.error?.trim() || "",
      status,
      isError: failed,
      realtime: status === "submitting" || status === "reviewing",
      activityKind: "status",
      providerReview: item.providerReview,
      forkTarget: item.forkTarget?.recovery ? item.forkTarget : undefined,
    }];
  }

  if (item.providerUserInput) {
    const request = item.providerUserInput;
    if (request.status === "pending" || request.status === "submitting") return [];
    const questionText = request.questions.map((question) => question.question).filter(Boolean).join("\n");
    return [{
      id: `cell:provider-user-input:${request.requestKey}`,
      kind: "user-input",
      source: "provider-runtime",
      timestamp: item.timestamp,
      agentRoleId,
      title: request.status === "submitted" ? "已回答" : "需要你回答",
      text: questionText || "Agent 需要你的回答。",
      status: request.status,
      interactionHistory: providerInteractionHistory(request),
    }];
  }

  const cells: ParentAgentTranscriptCell[] = [];
  for (const block of groupConsecutiveCommandBlocks(item.blocks ?? [])) {
    const providerIdentity = canonicalProviderBlockIdentity(block);
    if (block.source === "provider" && !providerIdentity) continue;
    const cell = transcriptCellFromAssistantBlock(block, item);
    if (cell) {
      cells.push({
        ...cell,
        agentRoleId,
        agentTaskId: item.agentTaskId,
        runId: cell.runId ?? item.runId,
        providerId: providerIdentity?.providerId,
        attemptId: providerIdentity?.attemptId,
        status: cell.status ?? item.status,
        threadId: cell.threadId ?? block.threadId ?? item.threadId,
        parentThreadId: cell.parentThreadId ?? item.parentThreadId,
        turnId: cell.turnId ?? block.turnId,
        itemId: providerIdentity?.itemId,
        targetAgentSurfaceId: block.targetAgentSurfaceId,
        targetAgentDisplayName: block.targetAgentDisplayName,
        evidenceRefs: item.artifact && block.document
          ? [{ label: "Plan proposal", ref: item.artifact, kind: "artifact" }, ...(cell.evidenceRefs ?? [])]
          : cell.evidenceRefs,
      });
    }
  }
  const activityCells = activityCellsFromThreadItem(item, agentRoleId);
  cells.push(...activityCells);
  if (item.status === "failed" && (item.retryTarget || item.forkTarget?.recovery)
    && !activityCells.some((cell) => cell.activityKind === "turn")) {
    cells.push({
      id: `cell:turn-retry:${item.id}`,
      kind: "process-row",
      source: "provider-runtime",
      timestamp: item.timestamp,
      agentRoleId,
      agentTaskId: item.agentTaskId,
      runId: item.runId,
      providerId: item.providerId,
      attemptId: item.attemptId,
      threadId: item.threadId,
      parentThreadId: item.parentThreadId,
      turnId: item.turnId,
      itemId: item.itemId,
      title: "本轮需要处理",
      text: "本轮需要处理",
      status: "failed",
      isError: true,
      activityKind: "turn",
      retryTarget: item.retryTarget,
      forkTarget: item.forkTarget?.recovery ? item.forkTarget : undefined,
    });
  }
  return normalizeCellEvidenceRefs(cells.filter((cell) => (
    cell.activityKind === "turn"
    || Boolean(cell.text.trim() || cell.detailText?.trim())
  )));
}

function reviewTargetTitle(target: import("../provider-runtime/index.js").ProviderReviewTarget): string {
  if (target.type === "uncommitted-changes") return "审查未提交改动";
  if (target.type === "base-branch") return `对比 ${target.branch}`;
  if (target.type === "commit") return `审查提交 ${target.sha.slice(0, 7)}`;
  return "自定义代码审查";
}

export function providerInteractionHistory(request: WorkbenchProviderUserInputRequest): InteractionHistoryRecord {
  const status = request.status === "submitted"
    ? request.disposition === "skipped" ? "skipped" : "answered"
    : request.status;
  return {
    kind: "provider-input",
    status,
    questions: request.questions.map((question) => ({ questionId: question.id, title: question.question })),
    answers: request.publicAnswers,
    skippedQuestionIds: request.skippedQuestionIds,
  };
}

function activityCellsFromThreadItem(item: TranscriptThreadItemInput, agentRoleId?: string): ParentAgentTranscriptCell[] {
  if (!hasCanonicalTurnIdentity(item)) return [];
  if (item.source === "workflow") return [];
  const activities = item.activity ?? [];
  if (activities.length === 0) return [];
  const startedAt = activities.find((activity) => activity.kind === "status" && activity.label === "thinking")?.timestamp;
  const observedTerminal = [...activities].reverse().find((activity): activity is Extract<AssistantTurnActivity, { kind: "status" }> =>
    activity.kind === "status" && ["completed", "failed", "blocked", "cancelled", "interrupted", "stopped"].includes(activity.label));
  if (!startedAt) return [];
  if (!observedTerminal) {
    const latest = [...activities].reverse().find((activity): activity is Extract<AssistantTurnActivity, { kind: "status" }> => activity.kind === "status");
    const title = liveActivityTitle(latest?.label);
    return [{
      id: `cell:turn:${canonicalTurnIdentity(item)}`,
      kind: "process-row",
      source: "provider-runtime",
      timestamp: startedAt,
      agentRoleId,
      agentTaskId: item.agentTaskId,
      runId: item.runId,
      providerId: item.providerId,
      attemptId: item.attemptId,
      threadId: item.threadId,
      parentThreadId: item.parentThreadId,
          turnId: item.turnId,
          itemId: item.itemId,
      title,
      text: "",
      status: latest?.label ?? "running",
      realtime: true,
      activityKind: "turn",
    }];
  }
  const terminal = item.status === "failed" && observedTerminal.label === "completed"
    ? { ...observedTerminal, label: "failed" }
    : observedTerminal;
  const elapsedSeconds = Math.max(1, Math.round((Date.parse(terminal.timestamp) - Date.parse(startedAt)) / 1000));
  const failed = terminal.label !== "completed";
  const title = failed ? `本轮需要处理 · ${elapsedSeconds} 秒` : `已完成 · ${elapsedSeconds} 秒`;
  return [{
    id: `cell:turn:${canonicalTurnIdentity(item)}`,
    kind: "process-row",
    source: "provider-runtime",
    timestamp: item.timestamp,
    agentRoleId,
    agentTaskId: item.agentTaskId,
    runId: item.runId,
    providerId: item.providerId,
    attemptId: item.attemptId,
    threadId: item.threadId,
    parentThreadId: item.parentThreadId,
    turnId: item.turnId,
    title,
    text: title,
    status: terminal.label,
    isError: failed,
    activityKind: "turn",
      retryTarget: failed ? item.retryTarget : undefined,
      forkTarget: !failed || item.forkTarget?.recovery ? item.forkTarget : undefined,
  }];
}

function liveActivityTitle(status: string | undefined): string {
  if (status === "connecting") return "正在连接";
  if (status === "replying" || status === "streaming") return "正在回复";
  if (status === "waiting-user") return "等待你回答";
  if (status === "tool" || status === "tool-running") return "正在调用工具";
  return "正在思考";
}

function transcriptCellFromAssistantBlock(
  block: AssistantTurnBlock,
  item: TranscriptThreadItemInput,
): ParentAgentTranscriptCell | null {
  if (block.kind === "usage") return null;
  const source: ParentAgentTranscriptBlockSource =
    block.source === "provider" ? "provider-runtime" : block.source === "workflow" ? "workflow-evidence" : "aho-orchestration";
  const rawText = block.text ?? block.preview ?? "";
  const text = isGeneratedRunContext(rawText)
    ? ""
    : block.kind === "prose" ? canonicalMessageText(rawText) : cleanPrimaryText(rawText);
  const itemId = item.id;
  const timestamp = item.timestamp;

  if (block.documentRef?.documentKind === "plan") {
    return {
      id: `cell:document:${block.documentRef.documentId}`,
      kind: "document-preview",
      source: "aho-orchestration",
      timestamp,
      title: block.documentRef.title,
      text: block.documentRef.title,
      status: block.status,
      documentRef: block.documentRef,
    };
  }

  if (block.kind === "workflow-evidence") return null;
  if (source === "workflow-evidence" && block.kind === "prose") {
    if (!text) return null;
    return {
      id: `cell:workflow-result:${block.id ?? itemId}`,
      kind: "assistant-message",
      source,
      timestamp,
      title: cleanToolTitle(block.title),
      text,
      status: block.status,
      isError: block.isError,
    };
  }
  if (block.kind === "reasoning-summary") {
    if (source !== "provider-runtime" || !text) return null;
    return {
      id: transcriptCellIdForBlock(block, "reasoning"),
      kind: "process-row",
      source,
      timestamp,
      title: "思考摘要",
      text: "",
      detailText: text,
      status: block.status,
      isError: block.isError,
      ...(isActiveAssistantTurn(item) ? { realtime: true } : {}),
      activityKind: "reasoning",
    };
  }
  if (block.kind === "prose") {
    if (source !== "provider-runtime") return null;
    if (!text) return null;
    return {
      id: transcriptCellIdForBlock(block, "assistant"),
      kind: "assistant-message",
      source,
      timestamp,
      title: cleanToolTitle(block.title),
      text,
      status: block.status,
      isError: block.isError,
      ...(isActiveAssistantTurn(item) ? { realtime: true } : {}),
      activityKind: "status",
    };
  }

  if (block.kind === "status") {
    const statusText = cleanPrimaryText([block.title, block.text ?? block.preview].filter(Boolean).join("\n"));
    if (!statusText) return null;
    if (source !== "provider-runtime" && !block.isError && !isAgentLifecycleStatus(statusText.toLowerCase())) return null;
    return {
      id: transcriptCellIdForBlock(block, "status"),
      kind: block.isError || source !== "provider-runtime" ? "process-row" : "detail-only",
      source,
      timestamp,
      title: block.isError ? "过程需要关注" : cleanToolTitle(block.title),
      text: statusText,
      status: block.status,
      isError: block.isError,
    };
  }

  if (source !== "provider-runtime" && block.kind !== "error") return null;

  if (block.kind === "command-group") {
    const failedCount = block.children?.filter((child) => child.kind === "command" && child.isError).length ?? 0;
    const commandText = commandGroupSummary(block);
    const detailText = commandGroupDetailText(block.children ?? []);
    return {
      id: transcriptCellIdForBlock(block, "command"),
      kind: "process-row",
      source,
      timestamp,
      title: commandText,
      text: commandText,
      status: block.status,
      isError: block.isError || failedCount > 0,
      activityKind: "command",
      detailText,
    };
  }

  if (block.kind === "command") {
    const title = commandRowTitle(block);
    return {
      id: transcriptCellIdForBlock(block, "command"),
      kind: "process-row",
      source,
      timestamp,
      title,
      text: title,
      status: block.status,
      isError: block.isError,
      activityKind: "command",
      detailText: commandDetailText(block),
    };
  }

  if (block.kind === "tool-result" || block.kind === "file-change") {
    const targetLabel = block.targetAgentSurfaceId && block.targetAgentDisplayName
      ? cleanToolTitle(block.targetAgentDisplayName)
      : "";
    const title = targetLabel
      ? agentLifecycleTitle(targetLabel, block.status)
      : block.kind === "file-change" ? "文件变更" : cleanToolTitle(block.title);
    const summary = targetLabel
      ? title
      : block.kind === "file-change"
      ? "文件已变更"
      : title
        ? `${title} 已完成`
        : block.isError
          ? "工具调用失败"
          : "工具调用已完成";
    const detailText = cleanPrimaryText([block.text, block.preview].filter(Boolean).join("\n\n"));
    return {
      id: transcriptCellIdForBlock(block, block.kind),
      kind: "process-row",
      source,
      timestamp,
      title,
      text: summary || "工具调用已完成",
      status: block.status,
      isError: block.isError,
      activityKind: block.targetAgentSurfaceId ? "agent" : block.kind === "file-change" ? "file" : /search/i.test(block.title ?? "") ? "search" : "tool",
      detailText: detailText || undefined,
      evidenceRefs: block.artifactRef ? [{ label: title || "详情", ref: block.artifactRef, kind: "artifact" }] : undefined,
    };
  }

  if (block.kind === "error") {
    const title = cleanToolTitle(block.title) || "运行出错";
    return {
      id: transcriptCellIdForBlock(block, "error"),
      kind: "process-row",
      source: "aho-orchestration",
      timestamp,
      title,
      text: title === "连接失败"
        ? "暂时无法连接到当前 Agent，请稍后重试。"
        : "当前 Agent 未能完成本轮，请稍后重试。",
      status: block.status,
      isError: true,
      activityKind: "status",
    };
  }

  return assertNever(block.kind);
}

function agentLifecycleTitle(label: string, status?: string): string {
  if (status === "failed") return `${label} 执行失败`;
  if (status === "completed") return `${label} 已完成`;
  return `${label} ${label.startsWith("Plan Agent") ? "正在规划" : "正在工作"}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported assistant turn block kind: ${String(value)}`);
}

function transcriptCellIdForBlock(block: AssistantTurnBlock, kind: string): string {
  const canonical = canonicalProviderBlockIdentity(block);
  const identity = canonical ? `${canonicalTurnIdentity(canonical)}:${canonical.itemId}` : block.id;
  return `cell:${kind}:${identity}`;
}

function isActiveAssistantTurn(item: TranscriptThreadItemInput): boolean {
  if (["completed", "failed", "blocked", "cancelled", "interrupted", "stopped"].includes(item.status ?? "")) return false;
  const statuses = (item.activity ?? []).filter((activity): activity is Extract<AssistantTurnActivity, { kind: "status" }> => activity.kind === "status");
  if (statuses.some((activity) => ["completed", "failed", "blocked", "cancelled", "interrupted", "stopped"].includes(activity.label))) return false;
  return statuses.some((activity) => ["started", "connecting", "thinking", "replying", "streaming", "tool", "tool-running", "waiting-user"].includes(activity.label));
}

function normalizeCellEvidenceRefs(cells: ParentAgentTranscriptCell[]): ParentAgentTranscriptCell[] {
  return cells.map((cell) => {
    const seenRefs = new Set<string>();
    const refs = cell.evidenceRefs?.filter((ref) => {
      const key = `${ref.kind}:${ref.ref}`;
      if (seenRefs.has(key)) return false;
      seenRefs.add(key);
      return true;
    });
    return { ...cell, ...(refs?.length ? { evidenceRefs: refs } : { evidenceRefs: undefined }) };
  });
}

function isAgentLifecycleStatus(value: string): boolean {
  return /(委派|创建|运行中|返回结果|失败).{0,24}(planning-agent|coder-agent|validator|auditor|rework|scheduler worker)/i.test(value)
    || /(planning-agent|coder-agent|validator|auditor|rework|scheduler worker).{0,24}(委派|创建|运行中|返回结果|失败)/i.test(value);
}

function isGeneratedRunContext(value: string | undefined): boolean {
  const text = value ?? "";
  return text.includes("# AHO 需求对话 Chat")
    || text.includes("# Run Context Projection")
    || text.includes("You are answering inside the AHO Workbench")
    || text.includes("## Current User Message")
    || text.includes("## User Message");
}

function cleanToolTitle(value: string | undefined): string | undefined {
  const text = cleanPrimaryText(value ?? "");
  if (!text || text === "AI" || text === "AI 回复" || text === "执行结果") return undefined;
  if (text === "Command completed") return "命令已完成";
  if (text === "Command started") return "正在运行命令";
  if (text === "Command failed") return "命令执行失败";
  if (text === "Planning draft generated") return "计划已生成";
  if (text === "Planning draft revised") return "计划已修改";
  if (text === "Planning confirmed") return "计划已确认";
  return text;
}

type CanonicalTurnIdentity = Required<Pick<TranscriptThreadItemInput, "providerId" | "attemptId" | "threadId" | "turnId">>;
type CanonicalBlockIdentity = Required<Pick<AssistantTurnBlock, "providerId" | "attemptId" | "threadId" | "turnId" | "itemId">>;

function hasCanonicalTurnIdentity(item: TranscriptThreadItemInput): item is TranscriptThreadItemInput & CanonicalTurnIdentity {
  return Boolean(item.providerId && item.attemptId && item.threadId && item.turnId);
}

function canonicalProviderBlockIdentity(block: AssistantTurnBlock): CanonicalBlockIdentity | null {
  const candidate = block.kind === "command-group" ? block.children?.[0] : block;
  return candidate?.providerId && candidate.attemptId && candidate.threadId && candidate.turnId && candidate.itemId
    ? candidate as CanonicalBlockIdentity
    : null;
}

function canonicalTurnIdentity(identity: CanonicalTurnIdentity): string {
  return `${identity.providerId}:${identity.attemptId}:${identity.threadId}:${identity.turnId}`;
}

function cleanPrimaryText(value: string | undefined): string {
  return (value ?? "").trim();
}

function canonicalMessageText(value: string | undefined): string {
  const text = value ?? "";
  return text.trim() ? text : "";
}
