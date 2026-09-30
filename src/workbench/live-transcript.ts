import type { AssistantTurnActivity, AssistantTurnBlock, AssistantTurnBlockKind, WorkbenchAssistantEvent, WorkbenchLiveEvent, WorkbenchLiveIdentity, WorkbenchLiveSink, WorkbenchLiveToolEvent } from "./types.js";
import { composeAgentDisplayLabel } from "../agent-display-label.js";
import { agentThreadSurfaceId } from "../provider-runtime/agent-surface-id.js";

export function createAssistantTranscriptCapture(
  live: WorkbenchLiveSink | undefined,
  persistBeforeEmit?: (capture: AssistantTranscriptCapture) => boolean,
): AssistantTranscriptCapture {
  const activity: AssistantTurnActivity[] = [];
  const blocks: AssistantTurnBlock[] = [];
  const mainCaptures = new Map<string, MainTranscriptCapture>();
  const childCaptures = new Map<string, ChildTranscriptCapture>();
  const thinkingTurns = new Set<string>();
  const observedDeltaTurns = new Set<string>();
  const terminalTurns = new Set<string>();
  const terminalAttemptThreads = new Set<string>();
  let sequence = 0;

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  function appendProseTo(target: AssistantTurnBlock[], delta: string, identity: WorkbenchLiveIdentity): void {
    if (!delta || !hasCanonicalItemIdentity(identity)) return;
    const last = target.at(-1);
    if (last?.kind === "prose" && last.source === "provider" && canonicalBlockIdentity(last) === canonicalItemKey("prose", identity)) {
      last.text = `${last.text ?? ""}${delta}`;
      return;
    }
    const currentSequence = nextSequence();
    upsertTranscriptBlock(target, {
      id: canonicalItemKey("prose", identity),
      providerId: identity.providerId,
      attemptId: identity.attemptId,
      runId: identity.runId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      itemId: identity.itemId,
      sequence: currentSequence,
      kind: "prose",
      timestamp: new Date().toISOString(),
      source: "provider",
      text: delta,
    });
  }

  function appendProse(delta: string, identity: WorkbenchLiveIdentity): void {
    appendProseTo(blocks, delta, identity);
  }

  function existingMainCaptureFor(identity: WorkbenchLiveIdentity): MainTranscriptCapture | null {
    if (!hasCanonicalTurnIdentity(identity)) return null;
    return mainCaptures.get(canonicalTurnKey(identity)) ?? null;
  }

  function existingChildCaptureFor(identity: WorkbenchLiveIdentity): ChildTranscriptCapture | null {
    if (!hasCanonicalTurnIdentity(identity) || !identity.agentRoleId || identity.agentRoleId === "main-agent") return null;
    return childCaptures.get(canonicalTurnKey(identity)) ?? null;
  }

  function appendTurnStatus(target: AssistantTurnActivity[], label: string, detail: string | undefined, timestamp: string): AssistantTurnActivity {
    const status: AssistantTurnActivity = { kind: "status", label, detail, timestamp };
    target.push(status);
    return status;
  }

  function mainCaptureFor(identity: WorkbenchLiveIdentity): MainTranscriptCapture | null {
    if (!hasCanonicalTurnIdentity(identity)) return null;
    const exactKey = canonicalTurnKey(identity);
    const existing = mainCaptures.get(exactKey);
    if (existing) {
      existing.runId = identity.runId ?? existing.runId;
      return existing;
    }
    const created: MainTranscriptCapture = {
      canonicalId: `main:${canonicalTurnKey(identity)}`,
      providerId: identity.providerId,
      attemptId: identity.attemptId,
      runId: identity.runId,
      threadId: identity.threadId,
      turnId: identity.turnId,
      text: "",
      activity: [],
      blocks: [],
      inputBoundaries: [],
    };
    mainCaptures.set(exactKey, created);
    return created;
  }

  function childCaptureFor(identity: WorkbenchLiveIdentity): ChildTranscriptCapture | null {
    if (!hasCanonicalTurnIdentity(identity) || !identity.agentRoleId || identity.agentRoleId === "main-agent") return null;
    if (identity.agentDisplayName && identity.providerId) {
      const targetSurfaceId = agentThreadSurfaceId(identity.providerId, identity.threadId);
      const targetDisplayName = composeAgentDisplayLabel(identity.agentRoleId, identity.agentDisplayName);
      updateTargetAgentBlocks(targetSurfaceId, targetDisplayName);
    }
    const exactKey = canonicalTurnKey(identity);
    const existing = childCaptures.get(exactKey);
    if (existing) {
      existing.runId = identity.runId ?? existing.runId;
      existing.parentThreadId = identity.parentThreadId ?? existing.parentThreadId;
      existing.displayName = identity.agentDisplayName ?? existing.displayName;
      return existing;
    }
    const created: ChildTranscriptCapture = {
      canonicalId: `child:${canonicalTurnKey(identity)}`,
      providerId: identity.providerId,
      attemptId: identity.attemptId,
      runId: identity.runId,
      threadId: identity.threadId,
      parentThreadId: identity.parentThreadId,
      turnId: identity.turnId,
      roleId: identity.agentRoleId,
      displayName: identity.agentDisplayName,
      activity: [],
      blocks: [],
    };
    childCaptures.set(exactKey, created);
    return created;
  }

  function updateTargetAgentBlocks(targetSurfaceId: string, targetDisplayName: string, status?: string): void {
    const targets = [blocks, ...[...mainCaptures.values()].map((capture) => capture.blocks)];
    for (const target of targets) {
      for (const block of target) {
        if (block.targetAgentSurfaceId !== targetSurfaceId) continue;
        block.targetAgentDisplayName = targetDisplayName;
        block.title = targetDisplayName;
        if (status) block.status = status;
      }
    }
  }

  function appendAssistantEventBlock(event: WorkbenchAssistantEvent, timestamp: string): void {
    const block = assistantEventToBlock(event, timestamp, nextSequence());
    if (block) upsertTranscriptBlock(blocks, block);
  }

  function appendToolEventBlock(event: WorkbenchLiveToolEvent, timestamp: string): void {
    const block = toolEventToBlock(event, timestamp, nextSequence());
    if (block) upsertTranscriptBlock(blocks, block);
  }

  const capture: AssistantTranscriptCapture = {
    text: "",
    activity,
    blocks,
    mainCaptures,
    childCaptures,
    acceptInput(clientRequestId, userMessageId) {
      const main = [...mainCaptures.values()].at(-1);
      if (!main || main.inputBoundaries.some((boundary) => boundary.clientRequestId === clientRequestId)) return;
      main.inputBoundaries.push({ clientRequestId, userMessageId, timestamp: new Date().toISOString(),
        textOffset: main.text.length, blocks: structuredClone(main.blocks) });
      // Reserve the new segment immediately after the committed user input,
      // even when the same Provider item continues or no delta follows.
      if (persistBeforeEmit && !persistBeforeEmit(capture)) throw new Error("Accepted input boundary could not be persisted.");
    },
    updateTargetAgent(targetSurfaceId, roleId, displayName, status) {
      updateTargetAgentBlocks(targetSurfaceId, composeAgentDisplayLabel(roleId, displayName), status);
    },
    sink: {
      emit(event: WorkbenchLiveEvent): void {
        const timestamp = new Date().toISOString();
        if (event.event === "run.started") {
          // Transport acknowledgement is not a user-visible thinking phase. The exact provider
          // turn/started notification arrives as run.status=thinking and owns the timer.
        } else if (event.event === "run.status") {
          if (!hasCanonicalTurnIdentity(event.data)) return;
          const turnKey = canonicalTurnKey(event.data);
          const isThinking = event.data.status === "thinking";
          const isTerminal = isTerminalTurnStatus(event.data.status);
          if (!isThinking && !isTerminal && !thinkingTurns.has(turnKey)) return;
          if (terminalTurns.has(turnKey)) return;
          if (isThinking && observedDeltaTurns.has(turnKey)) return;
          const child = isThinking ? childCaptureFor(event.data) : existingChildCaptureFor(event.data);
          const main = child ? null : isThinking ? mainCaptureFor(event.data) : existingMainCaptureFor(event.data);
          const target = child?.activity ?? main?.activity;
          if (!target) return;
          if (isThinking) {
            if (thinkingTurns.has(turnKey)) return;
            thinkingTurns.add(turnKey);
          }
          const status = appendTurnStatus(target, event.data.status, event.data.label, timestamp);
          if (isTerminal) {
            terminalTurns.add(turnKey);
            terminalAttemptThreads.add(canonicalAttemptThreadKey(event.data));
          }
          if (!child) activity.push(status);
        } else if (event.event === "assistant.delta") {
          if (!hasCanonicalItemIdentity(event.data)) return;
          const turnKey = canonicalTurnKey(event.data);
          if (terminalTurns.has(turnKey)
            || (terminalAttemptThreads.has(canonicalAttemptThreadKey(event.data)) && !thinkingTurns.has(turnKey))) return;
          observedDeltaTurns.add(turnKey);
          const child = existingChildCaptureFor(event.data) ?? childCaptureFor(event.data);
          if (child) {
            if (thinkingTurns.has(turnKey) && latestStatus(child.activity) !== "replying") {
              appendTurnStatus(child.activity, "replying", "正在回复", timestamp);
            }
            appendProseTo(child.blocks, event.data.delta, event.data);
          } else {
            const main = existingMainCaptureFor(event.data) ?? mainCaptureFor(event.data);
            if (!main) return;
            if (thinkingTurns.has(turnKey) && latestStatus(main.activity) !== "replying") {
              const replying = appendTurnStatus(main.activity, "replying", "正在回复", timestamp);
              activity.push(replying);
            }
            main.text += event.data.delta;
            appendProseTo(main.blocks, event.data.delta, event.data);
            capture.text += event.data.delta;
            appendProse(event.data.delta, event.data);
          }
        } else if (event.event === "assistant.event") {
          if (!hasCanonicalItemIdentity(event.data)) return;
          const child = childCaptureFor(event.data);
          if (child) {
            child.activity.push({ kind: "assistant-event", event: { ...event.data, timestamp: event.data.timestamp ?? timestamp }, timestamp });
            const block = assistantEventToBlock({ ...event.data, timestamp: event.data.timestamp ?? timestamp }, timestamp, nextSequence());
            if (block) upsertTranscriptBlock(child.blocks, block);
          } else {
            const main = mainCaptureFor(event.data);
            if (!main) return;
            main.activity.push({
              kind: "assistant-event",
              event: { ...event.data, timestamp: event.data.timestamp ?? timestamp },
              timestamp,
            });
            const mainBlock = assistantEventToBlock({ ...event.data, timestamp: event.data.timestamp ?? timestamp }, timestamp, nextSequence());
            if (mainBlock) upsertTranscriptBlock(main.blocks, mainBlock);
            activity.push({
              kind: "assistant-event",
              event: { ...event.data, timestamp: event.data.timestamp ?? timestamp },
              timestamp,
            });
            appendAssistantEventBlock({ ...event.data, timestamp: event.data.timestamp ?? timestamp }, timestamp);
          }
        } else if (event.event === "tool.event") {
          if (!hasCanonicalItemIdentity(event.data)) return;
          const child = childCaptureFor(event.data);
          if (child) {
            child.activity.push({ kind: "tool", tool: event.data, timestamp });
            const block = toolEventToBlock(event.data, timestamp, nextSequence());
            if (block) upsertTranscriptBlock(child.blocks, block);
          } else {
            const main = mainCaptureFor(event.data);
            if (!main) return;
            main.activity.push({ kind: "tool", tool: event.data, timestamp });
            const mainBlock = toolEventToBlock(event.data, timestamp, nextSequence());
            if (mainBlock) upsertTranscriptBlock(main.blocks, mainBlock);
            activity.push({ kind: "tool", tool: event.data, timestamp });
            appendToolEventBlock(event.data, timestamp);
          }
        } else if (event.event === "usage" && isRecord(event.data.usage)) {
          const child = childCaptureFor(event.data);
          const main = child ? null : mainCaptureFor(event.data);
          if (!child && !main) return;
          const targetActivity = child?.activity ?? activity;
          const targetBlocks = child?.blocks ?? blocks;
          if (!child) {
            main!.activity.push({ kind: "usage", usage: event.data.usage, timestamp });
          }
          targetActivity.push({ kind: "usage", usage: event.data.usage, timestamp });
          if (hasCanonicalItemIdentity(event.data)) {
            const currentSequence = nextSequence();
            upsertTranscriptBlock(targetBlocks, {
              id: canonicalItemKey("usage", event.data),
              providerId: event.data.providerId,
              attemptId: event.data.attemptId,
              runId: event.data.runId,
              threadId: event.data.threadId,
              turnId: event.data.turnId,
              itemId: event.data.itemId,
              sequence: currentSequence,
              kind: "usage",
              timestamp,
              source: "provider",
              title: "Usage recorded",
              text: formatUsageSummary(event.data.usage),
            });
          }
        } else if (event.event === "error") {
          if (!hasCanonicalTurnIdentity(event.data)) return;
          if (isTransientReconnectMessage(event.data.message)) {
            activity.push({ kind: "status", label: "connecting", detail: "正在重新连接", timestamp });
            emitLive(live, { event: "run.status", data: { ...event.data, status: "connecting", label: "正在重新连接" } });
            return;
          }
          const child = childCaptureFor(event.data);
          const targetActivity = child?.activity ?? activity;
          const targetBlocks = child?.blocks ?? blocks;
          const main = child ? null : mainCaptureFor(event.data);
          if (main) main.activity.push({ kind: "error", message: event.data.message, timestamp });
          targetActivity.push({ kind: "error", message: event.data.message, timestamp });
          if (hasCanonicalItemIdentity(event.data)) {
            const currentSequence = nextSequence();
            targetBlocks.push({
              id: canonicalItemKey("error", event.data),
              providerId: event.data.providerId,
              attemptId: event.data.attemptId,
              runId: event.data.runId,
              threadId: event.data.threadId,
              turnId: event.data.turnId,
              itemId: event.data.itemId,
              sequence: currentSequence,
              kind: "error",
              timestamp,
              source: "provider",
              title: isConnectionFailureMessage(event.data.message) ? "连接失败" : "运行出错",
              text: event.data.message,
              isError: true,
            });
            if (main) upsertTranscriptBlock(main.blocks, targetBlocks.at(-1)!);
          }
        }
        if (persistBeforeEmit && !persistBeforeEmit(capture)) return;
        emitLive(live, event);
      },
    },
  };
  return capture;
}

export interface AssistantTranscriptCapture {
  sink: WorkbenchLiveSink;
  text: string;
  activity: AssistantTurnActivity[];
  blocks: AssistantTurnBlock[];
  mainCaptures: Map<string, MainTranscriptCapture>;
  childCaptures: Map<string, ChildTranscriptCapture>;
  acceptInput(clientRequestId: string, userMessageId: string): void;
  updateTargetAgent: (targetSurfaceId: string, roleId: string, displayName?: string, status?: string) => void;
}

export interface MainTranscriptCapture {
  canonicalId: string;
  providerId: string;
  attemptId: string;
  runId?: string;
  threadId: string;
  turnId: string;
  text: string;
  activity: AssistantTurnActivity[];
  blocks: AssistantTurnBlock[];
  inputBoundaries: TranscriptInputBoundary[];
}

export interface TranscriptInputBoundary {
  clientRequestId: string;
  userMessageId: string;
  timestamp: string;
  textOffset: number;
  blocks: AssistantTurnBlock[];
}

export interface ChildTranscriptCapture {
  canonicalId: string;
  providerId: string;
  attemptId: string;
  runId?: string;
  threadId: string;
  parentThreadId?: string;
  turnId: string;
  roleId: string;
  displayName?: string;
  activity: AssistantTurnActivity[];
  blocks: AssistantTurnBlock[];
}

export function childTranscriptCapturesForThread(
  captures: Map<string, ChildTranscriptCapture>,
  threadId: string,
): ChildTranscriptCapture[] {
  return [...captures.values()]
    .filter((capture) => capture.threadId === threadId)
    .sort((left, right) => childCaptureTimestamp(left).localeCompare(childCaptureTimestamp(right)));
}

function childCaptureTimestamp(capture: ChildTranscriptCapture): string {
  return capture.blocks[0]?.timestamp ?? capture.activity[0]?.timestamp ?? "";
}

function latestStatus(activity: AssistantTurnActivity[]): string | undefined {
  return [...activity].reverse().find((item): item is Extract<AssistantTurnActivity, { kind: "status" }> => item.kind === "status")?.label;
}

function isTerminalTurnStatus(status: string): boolean {
  return status === "completed"
    || status === "failed"
    || status === "blocked"
    || status === "cancelled"
    || status === "interrupted"
    || status === "stopped";
}

function hasCanonicalTurnIdentity<T extends WorkbenchLiveIdentity>(identity: T): identity is T & Required<Pick<WorkbenchLiveIdentity, "providerId" | "attemptId" | "threadId" | "turnId">> {
  return Boolean(identity.providerId && identity.attemptId && identity.threadId && identity.turnId);
}

function hasCanonicalItemIdentity<T extends WorkbenchLiveIdentity>(identity: T): identity is T & Required<Pick<WorkbenchLiveIdentity, "providerId" | "attemptId" | "threadId" | "turnId" | "itemId">> {
  return hasCanonicalTurnIdentity(identity) && Boolean(identity.itemId);
}

function canonicalTurnKey(identity: WorkbenchLiveIdentity & Required<Pick<WorkbenchLiveIdentity, "providerId" | "attemptId" | "threadId" | "turnId">>): string {
  return `${identity.providerId}:${identity.attemptId}:${identity.threadId}:${identity.turnId}`;
}

function canonicalAttemptThreadKey(identity: WorkbenchLiveIdentity & Required<Pick<WorkbenchLiveIdentity, "providerId" | "attemptId" | "threadId">>): string {
  return `${identity.providerId}:${identity.attemptId}:${identity.threadId}`;
}

function canonicalItemKey(kind: AssistantTurnBlockKind, identity: WorkbenchLiveIdentity & Required<Pick<WorkbenchLiveIdentity, "providerId" | "attemptId" | "threadId" | "turnId" | "itemId">>): string {
  return `${kind}:${canonicalTurnKey(identity)}:${identity.itemId}`;
}

function assistantEventToBlock(event: WorkbenchAssistantEvent, timestamp: string, sequence: number): AssistantTurnBlock | null {
  if (!hasCanonicalItemIdentity(event) || !isMainThreadAssistantStatus(event)) return null;
  const kind = assistantEventBlockKind(event.kind);
  const text = event.summary ?? (kind === "usage" ? undefined : event.preview);
  return {
    id: canonicalItemKey(kind, event),
    providerId: event.providerId,
    attemptId: event.attemptId,
    runId: event.runId,
    threadId: event.threadId,
    turnId: event.turnId,
    sequence,
    kind,
    timestamp: event.timestamp ?? timestamp,
    source: "provider",
    status: event.status ?? event.phase,
    title: event.title ?? assistantEventTitle(event.kind),
    text,
    command: event.command,
    cwd: event.cwd,
    exitCode: event.exitCode,
    preview: kind === "usage" ? event.summary : event.preview,
    artifactRef: event.artifactRef,
    isError: event.isError,
    truncated: event.truncated,
    itemId: event.itemId,
    targetAgentSurfaceId: event.targetAgentSurfaceId,
    targetAgentDisplayName: event.targetAgentDisplayName,
  };
}

function toolEventToBlock(event: WorkbenchLiveToolEvent, timestamp: string, sequence: number): AssistantTurnBlock | null {
  if (!hasCanonicalItemIdentity(event)) return null;
  if (event.phase === "stderr") return null;
  if (!event.command && event.phase === "status" && !event.isError) return null;
  return {
    id: canonicalItemKey(event.command ? "command" : "status", event),
    providerId: event.providerId,
    attemptId: event.attemptId,
    runId: event.runId,
    threadId: event.threadId,
    turnId: event.turnId,
    sequence,
    kind: event.command ? "command" : "status",
    timestamp,
    source: "provider",
    status: event.status ?? event.phase,
    title: event.command
      ? commandResultTitle(event.status ?? event.phase)
      : event.name ?? "Run status",
    text: event.name,
    command: event.command,
    exitCode: event.exitCode,
    preview: event.outputTail,
    isError: event.isError,
    truncated: event.outputTail?.includes("[truncated") ? true : undefined,
    itemId: event.itemId,
  };
}

function upsertTranscriptBlock(blocks: AssistantTurnBlock[], block: AssistantTurnBlock): void {
  const key = canonicalBlockIdentity(block);
  const index = blocks.findIndex((item) => canonicalBlockIdentity(item) === key);
  if (index === -1) {
    blocks.push(block);
    return;
  }
  blocks[index] = updateCanonicalBlock(blocks[index], block);
}

function updateCanonicalBlock(existing: AssistantTurnBlock, incoming: AssistantTurnBlock): AssistantTurnBlock {
  const reasoningDelta = existing.kind === "reasoning-summary" && incoming.kind === "reasoning-summary" && incoming.status === "updated";
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    sequence: existing.sequence,
    timestamp: existing.timestamp,
    threadId: incoming.threadId ?? existing.threadId,
    turnId: incoming.turnId ?? existing.turnId,
    text: reasoningDelta ? `${existing.text ?? ""}${incoming.text ?? ""}` : incoming.text ?? existing.text,
    preview: incoming.preview ?? existing.preview,
    title: incoming.title ?? existing.title,
    status: incoming.status ?? existing.status,
    command: incoming.command ?? existing.command,
    cwd: incoming.cwd ?? existing.cwd,
    exitCode: incoming.exitCode ?? existing.exitCode,
    artifactRef: incoming.artifactRef ?? existing.artifactRef,
    truncated: incoming.truncated ?? existing.truncated,
    isError: incoming.isError ?? existing.isError,
  };
}

function canonicalBlockIdentity(block: AssistantTurnBlock): string {
  return hasCanonicalItemIdentity(block) ? canonicalItemKey(block.kind, block) : block.id;
}

function commandResultTitle(status: string | undefined): string {
  if (status === "failed") return "Command failed";
  if (status === "completed") return "Command completed";
  return "Command started";
}

function assistantEventBlockKind(kind: WorkbenchAssistantEvent["kind"]): AssistantTurnBlockKind {
  if (kind === "plan-update") return "prose";
  if (kind === "reasoning-summary") return "reasoning-summary";
  if (kind === "command") return "command";
  if (kind === "file-change") return "file-change";
  if (kind === "usage") return "usage";
  if (kind === "error") return "error";
  if (kind === "status") return "status";
  return "tool-result";
}

function assistantEventTitle(kind: WorkbenchAssistantEvent["kind"]): string {
  if (kind === "reasoning-summary") return "Reasoning summary";
  if (kind === "command") return "Command";
  if (kind === "file-change") return "File change";
  if (kind === "mcp-tool") return "Tool call";
  if (kind === "web-search") return "Web search";
  if (kind === "plan-update") return "Plan update";
  if (kind === "tool-result") return "Tool result";
  if (kind === "usage") return "Usage";
  if (kind === "error") return "Error";
  return "Run status";
}

function isMainThreadAssistantStatus(event: WorkbenchAssistantEvent): boolean {
  if (event.kind !== "status") return true;
  const normalized = `${event.title ?? ""} ${event.summary ?? ""} ${event.phase ?? ""}`.toLowerCase();
  if (isAgentLifecycleStatus(normalized)) return true;
  return Boolean(event.isError) || normalized.includes("validation") || normalized.includes("audit") || normalized.includes("failed") || normalized.includes("blocked");
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

function emitLive(live: WorkbenchLiveSink | undefined, event: WorkbenchLiveEvent): void {
  try {
    live?.emit(event);
  } catch {
    // Live transport is best-effort; persisted thread/run artifacts remain canonical.
  }
}

function formatUsageSummary(usage: Record<string, unknown>): string {
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const pieces = [
    input === undefined ? null : `${input} input tokens`,
    output === undefined ? null : `${output} output tokens`,
  ].filter((item): item is string => Boolean(item));
  return pieces.length > 0 ? `Usage: ${pieces.join(" ? ")}` : "Usage recorded";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTransientReconnectMessage(message: string): boolean {
  return /^reconnecting(?:\.\.\.)?\s*\d+\/\d+/i.test(message.trim());
}

function isConnectionFailureMessage(message: string): boolean {
  return /connect|socket|network|transport|reconnect/i.test(message);
}
