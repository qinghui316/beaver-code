import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readConversationThread } from "../../conversation-thread-log.js";
import { normalizeMainAgentExecutionAction } from "../../../workflow-actions/main-agent-execution.js";
import type { AssistantTurnActivity, AssistantTurnBlock, TopicThreadEntry } from "../../types.js";
import type { ClarificationRequest, WorkbenchIntakeIteration, WorkbenchIntakeScan } from "../../intake.js";
import type { AuditSummary, RunEvent, RunMetadata, ValidationSummary } from "../../../types/index.js";
import type { ProjectRunsPathPort, ProjectWorkbenchPathPort } from "../../../project-runtime/paths.js";
import type {
  ThreadStreamEvidence,
  ThreadStreamItem,
  WorkbenchDecisionItem,
  WorkbenchThreadEvent,
  WorkbenchTopicSummary,
} from "../../read-model-types.js";
interface ThreadStreamDraft extends ThreadStreamItem {
  sortKey: number;
  subOrder: number;
}

export async function buildThreadStream(
  runtime: ProjectWorkbenchPathPort,
  topic: WorkbenchTopicSummary,
  runs: RunMetadata[],
  validations: unknown[],
  audits: unknown[],
  decisions: WorkbenchDecisionItem[],
  options: { messages?: TopicThreadEntry[]; includeChangeState?: boolean } = {},
): Promise<ThreadStreamItem[]> {
  const messages = options.messages ?? await readConversationThread(runtime, topic.id).catch(() => []);
  const { items, runAnchors } = buildThreadStreamMessageDrafts(topic, messages, options.includeChangeState ?? true);
  for (const run of runs) {
    if (!runAnchors.has(run.id)) runAnchors.set(run.id, timestampSortKey(run.finishedAt ?? run.startedAt, 3000));
  }

  for (const validation of validations as ValidationSummary[]) {
    const anchor = validation.runId ? runAnchors.get(validation.runId) : undefined;
    const evidence = {
      id: `validation:${validation.id}`,
      label: `Validation ${validation.status}`,
      timestamp: validation.finishedAt,
      body: `${validation.commandCount} command${validation.commandCount === 1 ? "" : "s"} · ${validation.executionMode}`,
      source: "validation",
      status: validation.status,
      runId: validation.runId,
    } satisfies ThreadStreamEvidence;
    items.push({
      ...evidence,
      kind: "evidence",
      sortKey: anchor !== undefined ? anchor : timestampSortKey(validation.finishedAt, 4000),
      subOrder: 20,
    });
  }
  for (const audit of audits as AuditSummary[]) {
    const anchor = audit.runId ? runAnchors.get(audit.runId) : undefined;
    const evidence = {
      id: `audit:${audit.id}`,
      label: `Audit ${audit.status}`,
      timestamp: audit.finishedAt,
      body: `${audit.findingCount} finding${audit.findingCount === 1 ? "" : "s"}`,
      source: "audit",
      status: audit.status,
      runId: audit.runId,
    } satisfies ThreadStreamEvidence;
    items.push({
      ...evidence,
      kind: "evidence",
      sortKey: anchor !== undefined ? anchor : timestampSortKey(audit.finishedAt, 5000),
      subOrder: 30,
    });
  }
  for (const decision of decisions.filter((item) => !item.id.startsWith("workflow:"))) {
    items.push({
      id: `decision:${decision.id}`,
      kind: "decision",
      label: decision.label,
      timestamp: decision.completedAt ?? decision.updatedAt,
      body: decision.summary,
      source: "decision",
      artifact: decision.artifact,
      status: decision.status,
      runId: decision.runId,
      sortKey: timestampSortKey(decision.completedAt ?? decision.updatedAt, 6000),
      subOrder: 40,
    });
  }

  return finalizeThreadStreamItems(items);
}

export async function buildThreadStreamFromMessages(
  topic: WorkbenchTopicSummary,
  messages: TopicThreadEntry[],
  options: { includeChangeState?: boolean } = {},
): Promise<ThreadStreamItem[]> {
  const { items } = buildThreadStreamMessageDrafts(topic, messages, Boolean(options.includeChangeState));
  return finalizeThreadStreamItems(items);
}

function buildThreadStreamMessageDrafts(
  topic: WorkbenchTopicSummary,
  messages: TopicThreadEntry[],
  includeChangeState: boolean,
): {
  items: ThreadStreamDraft[];
  runAnchors: Map<string, number>;
} {
  const items: ThreadStreamDraft[] = [{
    id: `${topic.id}:change-state`,
    kind: "change-state",
    label: topic.state === "archive" ? `Archived: ${topic.title}` : `Topic: ${topic.title}`,
    timestamp: topic.updatedAt ?? topic.createdAt,
    body: topic.path,
    source: "change",
    artifact: topic.path,
    status: topic.state,
    sortKey: 0,
    subOrder: 0,
  }];
  if (!includeChangeState) items.length = 0;
  const terminalWorkflowByAction = new Map<string, TopicThreadEntry>();
  const workflowStartedByAction = new Map<string, TopicThreadEntry>();
  const runAnchors = new Map<string, number>();

  messages.forEach((message, index) => {
    const sortKey = message.position ?? index + 1;
    if (message.type === "workflow.started" && message.actionRunId) {
      workflowStartedByAction.set(message.actionRunId, message);
      return;
    }
    if ((message.type === "workflow.completed" || message.type === "workflow.failed") && message.actionRunId) {
      terminalWorkflowByAction.set(message.actionRunId, message);
      if (message.runId) runAnchors.set(message.runId, sortKey);
      return;
    }
    const mapped = threadItemFromMessage(message, sortKey);
    if (mapped) {
      items.push(mapped);
    }
  });

  for (const [actionRunId, started] of workflowStartedByAction) {
    const terminal = terminalWorkflowByAction.get(actionRunId);
    const message = terminal ?? started;
    const sortKey = message.position ?? started.position ?? messages.length + items.length + 1;
    const workflowItem = workflowItemFromMessage(message, sortKey);
    items.push(workflowItem);
    if (message.runId) runAnchors.set(message.runId, sortKey);
  }
  return { items, runAnchors };
}

async function finalizeThreadStreamItems(items: ThreadStreamDraft[]): Promise<ThreadStreamItem[]> {
  for (const item of items) {
    item.blocks = finalizeAssistantBlocks(item);
  }
  return uniqueThreadItemsById(items)
    .sort((a, b) => a.sortKey - b.sortKey || a.subOrder - b.subOrder || (a.timestamp ?? "").localeCompare(b.timestamp ?? "") || a.id.localeCompare(b.id))
    .map(({ sortKey: _sortKey, subOrder: _subOrder, ...item }) => item);
}

function threadItemFromMessage(message: TopicThreadEntry, sortKey: number): ThreadStreamDraft | null {
  if (message.status === "retry-requested") return null;
  if (message.type === "user.message") {
    return {
      id: message.id,
      kind: "user-message",
      label: "User",
      timestamp: message.timestamp,
      body: message.text,
      source: "chat",
      status: message.status,
      graphScopeId: message.graphScopeId,
      providerId: message.providerId,
      attemptId: message.attemptId,
      runId: message.runId,
      threadId: message.threadId,
      parentThreadId: message.parentThreadId,
      turnId: message.turnId,
      itemId: message.itemId,
      agentRoleId: message.agentRoleId,
      agentTaskId: message.agentTaskId,
      initialThreadInput: message.initialThreadInput,
      contextRefs: message.contextRefs,
      attachments: message.attachments,
      sortKey,
      subOrder: 0,
    };
  }
  if (message.type === "assistant.message" || message.type === "assistant.transcript-segment") {
    return {
      id: message.id,
      kind: "assistant-turn",
      label: "AI",
      timestamp: message.timestamp,
      body: message.text,
      transcriptReading: message.transcriptReading,
      source: "chat",
      artifact: message.artifact,
      status: message.status,
      graphScopeId: message.graphScopeId,
      runId: message.runId,
      threadId: message.threadId,
      parentThreadId: message.parentThreadId,
      turnId: message.turnId,
      agentRoleId: message.agentRoleId,
      agentTaskId: message.agentTaskId,
      actionType: undefined,
      activity: message.activity,
      blocks: blocksFromMessage(message),
      providerUserInput: message.providerUserInput,
      retryTarget: message.retryTarget,
      forkTarget: message.forkTarget,
      sortKey,
      subOrder: 0,
    };
  }
  if (message.type === "orchestrator.plan") {
    return {
      id: message.id,
      kind: "assistant-turn",
      label: "AI",
      timestamp: message.timestamp,
      body: message.text,
      source: "chat",
      artifact: message.artifact,
      graphScopeId: message.graphScopeId,
      runId: message.runId,
      threadId: message.threadId,
      parentThreadId: message.parentThreadId,
      turnId: message.turnId,
      agentRoleId: message.agentRoleId,
      agentTaskId: message.agentTaskId,
      actionType: undefined,
      activity: message.activity,
      blocks: blocksFromMessage(message),
      sortKey,
      subOrder: 0,
    };
  }
  if (message.type === "intake.scan") {
    const intake = parseIntakePayload(message.intake);
    return {
      id: message.id,
      kind: "intake-summary",
      label: "需求分析",
      timestamp: message.timestamp,
      body: message.text,
      source: "intake",
      artifact: message.artifact,
      runId: message.runId,
      intake,
      sortKey,
      subOrder: 0,
    };
  }
  if (message.type === "intake.iteration") {
    const intake = parseIntakePayload(message.intake);
    return {
      id: message.id,
      kind: "intake-summary",
      label: "当前需求理解",
      timestamp: message.timestamp,
      body: message.text,
      source: "intake",
      artifact: message.artifact,
      intake,
      sortKey,
      subOrder: 0,
    };
  }
  if (message.type === "clarification.request" || message.type === "clarification.answer" || message.type === "clarification.skip") {
    const clarification = parseClarificationPayload(message.clarification);
    return {
      id: message.id,
      kind: "clarification",
      label: message.type === "clarification.request" ? "需要确认" : message.type === "clarification.answer" ? "已回答确认" : "已跳过确认",
      timestamp: message.timestamp,
      body: message.text,
      source: "intake",
      runId: message.runId,
      clarification,
      status: clarification?.status,
      sortKey,
      subOrder: 0,
    };
  }
  return null;
}

function parseIntakePayload(value: unknown): ThreadStreamItem["intake"] | undefined {
  if (!isRecord(value)) return undefined;
  const result: ThreadStreamItem["intake"] = {};
  if (isRecord(value.scan)) result.scan = value.scan as unknown as WorkbenchIntakeScan;
  if (isRecord(value.iteration)) result.iteration = value.iteration as unknown as WorkbenchIntakeIteration;
  return result.scan || result.iteration ? result : undefined;
}

function parseClarificationPayload(value: unknown): ClarificationRequest | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.questions)) return undefined;
  return value as unknown as ClarificationRequest;
}

function workflowItemFromMessage(message: TopicThreadEntry, sortKey: number): ThreadStreamDraft {
  const evidence = workflowEvidenceFromMessage(message);
  return {
    id: `assistant-turn:${message.runId ?? message.actionRunId ?? message.id}`,
    kind: "workflow-summary",
    label: workflowLabel(message.actionType, message.status),
    timestamp: message.timestamp,
    body: workflowDisplayBody(message),
    source: "workflow",
    artifact: message.artifact,
    status: message.status,
    runId: message.runId,
    actionType: undefined,
    actionRunId: message.actionRunId,
    activity: message.activity,
    evidence: [evidence],
    blocks: undefined,
    sortKey,
    subOrder: 10,
  };
}

function workflowEvidenceFromMessage(message: TopicThreadEntry): ThreadStreamEvidence {
  return {
    id: `workflow:${message.actionRunId ?? message.id}`,
    label: workflowLabel(message.actionType, message.status),
    source: "workflow",
    timestamp: message.timestamp,
    body: workflowDisplayBody(message),
    artifact: message.artifact,
    status: message.status,
    runId: message.runId,
    actionRunId: message.actionRunId,
  };
}

function blocksFromMessage(message: TopicThreadEntry, evidence?: ThreadStreamEvidence): AssistantTurnBlock[] | undefined {
  const explicit = normalizeBlocks(message.blocks);
  const blocks: AssistantTurnBlock[] = explicit.length > 0 ? [...explicit] : [];
  const hasExplicitBlocks = blocks.length > 0;
  let sequence = nextBlockSequence(blocks);
  const displayText = terminalWorkflowResultSummary(message) ?? message.text;
  if (blocks.length === 0 && displayText?.trim()) {
    blocks.push({
      id: `message-prose:${message.id}`,
      runId: message.runId,
      sequence: sequence++,
      kind: "prose",
      timestamp: message.timestamp,
      source: message.type === "workflow.completed" || message.type === "workflow.failed" ? "workflow" : "aho",
      title: message.type === "workflow.completed" || message.type === "workflow.failed" ? "执行结果" : undefined,
      text: displayText,
      isError: message.status === "failed",
    });
  }
  if (blocks.length === 0 && message.error?.trim()) {
    blocks.push({
      id: `message-error:${message.id}`,
      runId: message.runId,
      sequence: sequence++,
      kind: "error",
      timestamp: message.timestamp,
      source: "workflow",
      title: "执行失败",
      text: message.error,
      isError: true,
    });
  }
  if (!hasExplicitBlocks) {
    for (const block of blocksFromActivity(message.activity, message)) {
      block.sequence = sequence++;
      blocks.push(block);
    }
  }
  if (evidence) {
    blocks.push(workflowEvidenceBlock(evidence, sequence++, evidence.source));
  }
  return blocks.length > 0 ? blocks.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)) : undefined;
}

function workflowDisplayBody(message: TopicThreadEntry): string {
  return terminalWorkflowResultSummary(message) ?? message.text ?? message.error ?? workflowBody(message.actionType, message.status);
}

function terminalWorkflowResultSummary(message: TopicThreadEntry): string | undefined {
  if (message.type !== "workflow.completed" && message.type !== "workflow.failed") return undefined;
  return message.resultSummary?.trim() || undefined;
}

function normalizeBlocks(blocks: AssistantTurnBlock[] | undefined): AssistantTurnBlock[] {
  return (blocks ?? [])
    .filter((block) => isMainThreadBlock(block))
    .map((block) => ({ ...block, preview: hasInternalRunMetadata(block.preview) ? undefined : block.preview }));
}

function blocksFromActivity(activity: AssistantTurnActivity[] | undefined, message: TopicThreadEntry): AssistantTurnBlock[] {
  const blocks: AssistantTurnBlock[] = [];
  for (const [index, event] of (activity ?? []).entries()) {
    if (event.kind === "assistant-event") {
      const assistantEvent = event.event;
      if (!hasCanonicalActivityItemIdentity(assistantEvent)) continue;
      const kind = assistantEventBlockKind(assistantEvent.kind);
      const block: AssistantTurnBlock = {
        id: `${kind}:${assistantEvent.providerId}:${assistantEvent.attemptId}:${assistantEvent.threadId}:${assistantEvent.turnId}:${assistantEvent.itemId}`,
        providerId: assistantEvent.providerId,
        attemptId: assistantEvent.attemptId,
        runId: assistantEvent.runId ?? message.runId,
        threadId: assistantEvent.threadId,
        turnId: assistantEvent.turnId,
        sequence: index + 1,
        kind,
        timestamp: assistantEvent.timestamp ?? event.timestamp,
        source: "provider",
        status: assistantEvent.phase,
        title: assistantEvent.title ?? assistantEventTitle(assistantEvent.kind),
        text: assistantEvent.summary,
        command: assistantEvent.command,
        cwd: assistantEvent.cwd,
        exitCode: assistantEvent.exitCode,
        preview: hasInternalRunMetadata(assistantEvent.preview) ? undefined : assistantEvent.preview,
        artifactRef: assistantEvent.artifactRef,
        isError: assistantEvent.isError,
        truncated: assistantEvent.truncated,
        itemId: assistantEvent.itemId,
      };
      if (isMainThreadBlock(block)) blocks.push(block);
    } else if (event.kind === "tool" && event.tool.phase !== "stderr" && event.tool.command) {
      if (!hasCanonicalActivityItemIdentity(event.tool)) continue;
      blocks.push({
        id: `command:${event.tool.providerId}:${event.tool.attemptId}:${event.tool.threadId}:${event.tool.turnId}:${event.tool.itemId}`,
        providerId: event.tool.providerId,
        attemptId: event.tool.attemptId,
        runId: event.tool.runId,
        threadId: event.tool.threadId,
        turnId: event.tool.turnId,
        itemId: event.tool.itemId,
        sequence: index + 1,
        kind: "command",
        timestamp: event.timestamp,
        source: "provider",
        status: event.tool.status ?? event.tool.phase,
        title: event.tool.isError ? "命令失败" : event.tool.phase === "started" ? "正在运行命令" : "命令完成",
        command: event.tool.command,
        exitCode: event.tool.exitCode,
        preview: hasInternalRunMetadata(event.tool.outputTail) ? undefined : event.tool.outputTail,
        isError: event.tool.isError,
      });
    }
  }
  return blocks;
}

function hasCanonicalActivityItemIdentity(value: {
  providerId?: string;
  attemptId?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
}): value is typeof value & Required<Pick<typeof value, "providerId" | "attemptId" | "threadId" | "turnId" | "itemId">> {
  return Boolean(value.providerId && value.attemptId && value.threadId && value.turnId && value.itemId);
}

function workflowEvidenceBlock(evidence: ThreadStreamEvidence, sequence: number, source: AssistantTurnBlock["source"]): AssistantTurnBlock {
  return {
    id: `evidence-block:${evidence.id}`,
    runId: evidence.runId,
    sequence,
    kind: "workflow-evidence",
    timestamp: evidence.timestamp ?? new Date().toISOString(),
    source,
    status: evidence.status,
    title: evidenceLabel(evidence),
    text: evidence.body,
    artifactRef: evidence.artifact,
    isError: evidence.status === "failed" || evidence.status === "blocked",
  };
}

function finalizeAssistantBlocks(item: ThreadStreamItem): AssistantTurnBlock[] | undefined {
  if (item.kind !== "assistant-turn") return item.blocks;
  let blocks = normalizeBlocks(item.blocks);
  let sequence = nextBlockSequence(blocks);
  if (blocks.length === 0 && item.body?.trim()) {
    blocks.push({
      id: `final-prose:${item.id}`,
      runId: item.runId,
      sequence: sequence++,
      kind: "prose",
      timestamp: item.timestamp ?? new Date().toISOString(),
      source: item.source === "workflow" ? "workflow" : "aho",
      title: item.source === "workflow" ? "执行结果" : undefined,
      text: item.body,
      isError: item.status === "failed",
    });
  }
  for (const evidence of item.evidence ?? []) {
    blocks.push(workflowEvidenceBlock(evidence, sequence++, evidence.source));
  }
  blocks = blocks.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return blocks.length > 0 ? blocks : undefined;
}

function nextBlockSequence(blocks: AssistantTurnBlock[] | undefined): number {
  const max = Math.max(0, ...(blocks ?? []).map((block) => block.sequence));
  return max + 1;
}

function isMainThreadBlock(block: AssistantTurnBlock): boolean {
  if (block.kind !== "status") return true;
  const normalized = `${block.title ?? ""} ${block.text ?? ""} ${block.status ?? ""}`.toLowerCase();
  if (isAgentLifecycleStatus(normalized)) return true;
  return Boolean(block.isError) || normalized.includes("validation") || normalized.includes("audit") || normalized.includes("failed") || normalized.includes("blocked");
}

function assistantEventBlockKind(kind: string): AssistantTurnBlock["kind"] {
  if (kind === "reasoning-summary") return "reasoning-summary";
  if (kind === "command") return "command";
  if (kind === "file-change") return "file-change";
  if (kind === "usage") return "usage";
  if (kind === "error") return "error";
  if (kind === "status") return "status";
  return "tool-result";
}

function assistantEventTitle(kind: string): string {
  if (kind === "reasoning-summary") return "工作摘要";
  if (kind === "command") return "命令";
  if (kind === "file-change") return "文件变更";
  if (kind === "mcp-tool") return "工具调用";
  if (kind === "web-search") return "网页搜索";
  if (kind === "plan-update") return "计划更新";
  if (kind === "usage") return "用量";
  if (kind === "error") return "错误";
  return "运行状态";
}

function isAgentLifecycleStatus(normalized: string): boolean {
  return normalized.includes("agent-task-created")
    || normalized.includes("agent-running")
    || normalized.includes("agent-completed")
    || normalized.includes("planning-agent")
    || normalized.includes("coder")
    || normalized.includes("validator")
    || normalized.includes("auditor")
    || normalized.includes("rework");
}

function evidenceLabel(item: ThreadStreamEvidence): string {
  if (item.source === "validation") return `验证：${item.status ?? item.label}`;
  if (item.source === "audit") return `审查：${item.status ?? item.label}`;
  if (item.source === "workflow") return "执行结果";
  if (item.source === "decision") return "决策";
  return item.label;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasInternalRunMetadata(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  const artifactSignals = ["provider-events.jsonl", "events.jsonl", "stdout.log", "stderr.log", "last-message.md"];
  const hasArtifactSignal = artifactSignals.some((signal) => normalized.includes(signal));
  const hasRunMetadataShape = normalized.includes('"runtime"') && normalized.includes('"artifacts"') && normalized.includes('"promptstack"');
  return hasRunMetadataShape || (hasArtifactSignal && normalized.includes('"artifacts"'));
}

function workflowLabel(actionType: string | undefined, status: string | undefined): string {
  const label = actionType ? workflowActionLabel(actionType) : "Workflow action";
  if (status === "failed") return `${label} failed`;
  if (status === "running") return `${label} running`;
  return `${label} completed`;
}

function workflowBody(actionType: string | undefined, status: string | undefined): string {
  if (status === "running") return "The action has started and is waiting for a terminal result.";
  if (status === "failed") return "The action failed. See Run Replay for low-level events and artifacts.";
  if (actionType === "code.run") return "Coder, validation, and audit ran as the sequential confirmed workflow.";
  return "The confirmed workflow action completed.";
}

function workflowActionLabel(actionType: string): string {
  const mainAgentExecutionAction = normalizeMainAgentExecutionAction(actionType);
  if (mainAgentExecutionAction === "main-agent.execution.start") return "Main-agent execution";
  if (mainAgentExecutionAction === "main-agent.execution.stop") return "Main-agent execution stop";
  if (mainAgentExecutionAction === "main-agent.execution.continue") return "Main-agent execution continue";
  if (mainAgentExecutionAction === "main-agent.execution.reconcile") return "Main-agent execution reconcile";

  switch (actionType) {
    case "planning.scheduler.worker.start-first": return "Scheduler current worker start";
    case "planning.scheduler.worker.start-next": return "Scheduler next worker start";
    case "planning.scheduler.worker.reconcile-result": return "Scheduler current worker result reconcile";
    case "planning.scheduler.worker.validate-first": return "Scheduler current worker validation";
    case "planning.scheduler.worker.audit-first": return "Scheduler current worker audit";
    case "planning.scheduler.worker.rework-plan.compile": return "Scheduler current worker rework plan";
    case "planning.scheduler.worker.rework-start-first": return "Scheduler current worker rework start";
    case "planning.scheduler.worker.rework-reconcile-result": return "Scheduler current worker rework result";
    case "planning.scheduler.worker.rework-validate-first": return "Scheduler current worker rework validation";
    case "planning.scheduler.worker.rework-audit-first": return "Scheduler current worker rework audit";
    case "workflow.run.start": return "TaskQueue start confirmation";
    case "code.run": return "Code workflow";
    case "validate.run": return "Validation";
    case "audit.run": return "Audit";
    case "spec-test.drift": return "Spec-Test drift";
    default: return actionType;
  }
}

function timestampSortKey(timestamp: string | undefined, offset: number): number {
  const millis = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(millis) ? 100000 + millis / 1000 + offset : 100000 + offset;
}

function uniqueThreadItemsById(items: ThreadStreamDraft[]): ThreadStreamDraft[] {
  const seen = new Set<string>();
  const result: ThreadStreamDraft[] = [];
  for (const item of items) {
    const key = item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export async function readRunEvents(runtime: ProjectRunsPathPort, run: RunMetadata): Promise<WorkbenchThreadEvent[]> {
  const eventsPath = join(runtime.runsRoot, run.id, "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  const content = await readFile(eventsPath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseRunEventLine(line, index, run))
    .filter((item): item is WorkbenchThreadEvent => item !== null);
}

function parseRunEventLine(line: string, index: number, run: RunMetadata): WorkbenchThreadEvent | null {
  try {
    const event = JSON.parse(line) as RunEvent;
    return {
      id: `${run.id}:event:${index}`,
      type: event.type,
      label: event.type,
      timestamp: event.timestamp,
      source: sourceForEvent(event.type),
      artifact: run.artifacts.directory,
      status: typeof event.data?.status === "string" ? event.data.status : undefined,
      runId: run.id,
    };
  } catch {
    return null;
  }
}

function sourceForEvent(type: string): WorkbenchThreadEvent["source"] {
  if (type.startsWith("validation.")) return "validation";
  if (type.startsWith("audit.")) return "audit";
  if (type.startsWith("worktree.")) return "worktree";
  if (type.startsWith("spec-test.")) return "spec-test";
  return "run";
}
