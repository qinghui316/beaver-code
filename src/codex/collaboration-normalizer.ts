export type CodexCollaborationTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent";
export type CodexCollaborationToolStatus = "inProgress" | "completed" | "failed";

export interface CodexCollaborationToolCall {
  itemId: string;
  tool: CodexCollaborationTool;
  status: CodexCollaborationToolStatus;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
  agentsStates?: Record<string, unknown>;
}

export interface CodexSubAgentActivity {
  itemId: string;
  kind: "started" | "interacted" | "interrupted" | "completed";
  threadId: string;
  agentPath: string;
}

export interface CodexChildLifecycleEvent {
  kind: "started" | "continued" | "closed";
  activityId: string;
  parentThreadId: string;
  childThreadId: string;
  turnId?: string;
  roleHint?: string;
}

export interface CodexCollaborationNotification {
  toolCall: CodexCollaborationToolCall | null;
  subAgentActivity: CodexSubAgentActivity | null;
  lifecycleEvents: CodexChildLifecycleEvent[];
}

export class CodexCollaborationNormalizer {
  private readonly parentByChild = new Map<string, string>();
  private readonly roleHintByChild = new Map<string, string>();
  private readonly startedActivityByChild = new Map<string, string>();
  private readonly continuedActivityByChild = new Map<string, string>();
  private readonly emitted = new Set<string>();

  normalize(method: string, params: Record<string, unknown>): CodexCollaborationNotification {
    const toolCall = extractCodexCollaborationToolCall(method, params);
    const subAgentActivity = extractCodexSubAgentActivity(method, params);
    const notificationThreadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId) ?? stringValue(record(params.turn)?.id);
    const lifecycleEvents: CodexChildLifecycleEvent[] = [];

    if (toolCall) {
      for (const childThreadId of toolCall.receiverThreadIds) {
        this.parentByChild.set(childThreadId, toolCall.senderThreadId);
        const kind = lifecycleKindForTool(toolCall);
        if (!kind) continue;
        if (kind === "started") this.startedActivityByChild.set(childThreadId, toolCall.itemId);
        if (kind === "continued") this.continuedActivityByChild.set(childThreadId, toolCall.itemId);
        this.pushLifecycle(lifecycleEvents, {
          kind,
          activityId: toolCall.itemId,
          parentThreadId: toolCall.senderThreadId,
          childThreadId,
          ...(turnId ? { turnId } : {}),
          ...(this.roleHintByChild.get(childThreadId) ? { roleHint: this.roleHintByChild.get(childThreadId) } : {}),
        });
      }
    }

    if (subAgentActivity) {
      const parentThreadId = notificationThreadId ?? this.parentByChild.get(subAgentActivity.threadId);
      const roleHint = roleHintFromAgentPath(subAgentActivity.agentPath);
      if (parentThreadId) this.parentByChild.set(subAgentActivity.threadId, parentThreadId);
      if (roleHint) this.roleHintByChild.set(subAgentActivity.threadId, roleHint);
      const kind = subAgentActivity.kind === "started"
        ? "started" as const
        : subAgentActivity.kind === "interacted" ? "continued" as const : null;
      if (kind && parentThreadId) {
        const correlatedActivityId = kind === "started"
          ? this.startedActivityByChild.get(subAgentActivity.threadId)
          : this.continuedActivityByChild.get(subAgentActivity.threadId);
        const activityId = correlatedActivityId ?? subAgentActivity.itemId;
        if (kind === "started") this.startedActivityByChild.set(subAgentActivity.threadId, activityId);
        if (kind === "continued") this.continuedActivityByChild.set(subAgentActivity.threadId, activityId);
        this.pushLifecycle(lifecycleEvents, {
          kind,
          activityId,
          parentThreadId,
          childThreadId: subAgentActivity.threadId,
          ...(turnId ? { turnId } : {}),
          ...(roleHint ? { roleHint } : {}),
        });
      }
    }

    return { toolCall, subAgentActivity, lifecycleEvents };
  }

  roleHintForChild(childThreadId: string): string | undefined {
    return this.roleHintByChild.get(childThreadId);
  }

  private pushLifecycle(target: CodexChildLifecycleEvent[], event: CodexChildLifecycleEvent): void {
    const key = [event.kind, event.activityId, event.parentThreadId, event.childThreadId, event.roleHint ?? ""].join("\u0000");
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    target.push(event);
  }
}

export function extractCodexCollaborationToolCall(
  method: string,
  params: Record<string, unknown>,
): CodexCollaborationToolCall | null {
  if (method !== "item/started" && method !== "item/updated" && method !== "item/completed") return null;
  const item = record(params.item);
  if (!item || item.type !== "collabAgentToolCall") return null;
  const itemId = stringValue(item.id);
  const tool = collaborationTool(item.tool);
  const status = collaborationStatus(item.status);
  const senderThreadId = stringValue(item.senderThreadId);
  const receiverThreadIds = stringList(item.receiverThreadIds);
  if (!itemId || !tool || !status || !senderThreadId) return null;
  return {
    itemId,
    tool,
    status,
    senderThreadId,
    receiverThreadIds: [...new Set(receiverThreadIds)],
    ...(stringValue(item.prompt) ? { prompt: stringValue(item.prompt) } : {}),
    ...(stringValue(item.model) ? { model: stringValue(item.model) } : {}),
    ...(stringValue(item.reasoningEffort) ? { reasoningEffort: stringValue(item.reasoningEffort) } : {}),
    ...(record(item.agentsStates) ? { agentsStates: record(item.agentsStates) } : {}),
  };
}

export function extractCodexSubAgentActivity(
  method: string,
  params: Record<string, unknown>,
): CodexSubAgentActivity | null {
  if (method !== "item/started" && method !== "item/completed") return null;
  const item = record(params.item);
  if (!item || item.type !== "subAgentActivity") return null;
  const itemId = stringValue(item.id);
  const kind = item.kind === "started" || item.kind === "interacted" || item.kind === "interrupted" || item.kind === "completed" ? item.kind : null;
  const threadId = stringValue(item.agentThreadId);
  const agentPath = stringValue(item.agentPath);
  return itemId && kind && threadId && agentPath ? { itemId, kind, threadId, agentPath } : null;
}

export function roleHintFromAgentPath(agentPath: string): string | undefined {
  const segment = agentPath.split("/").filter(Boolean).at(-1)?.trim().toLowerCase();
  if (!segment || !/^[a-z0-9_]+$/.test(segment)) return undefined;
  return segment.replaceAll("_", "-");
}

function lifecycleKindForTool(call: CodexCollaborationToolCall): CodexChildLifecycleEvent["kind"] | null {
  if (call.tool === "closeAgent") return call.status === "completed" ? "closed" : null;
  if (call.status === "failed") return null;
  if (call.tool === "spawnAgent") return "started";
  if (call.tool === "sendInput" || call.tool === "resumeAgent") return "continued";
  return null;
}

function collaborationTool(value: unknown): CodexCollaborationTool | undefined {
  return value === "spawnAgent" || value === "sendInput" || value === "resumeAgent" || value === "wait" || value === "closeAgent"
    ? value
    : undefined;
}

function collaborationStatus(value: unknown): CodexCollaborationToolStatus | undefined {
  return value === "inProgress" || value === "completed" || value === "failed" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
