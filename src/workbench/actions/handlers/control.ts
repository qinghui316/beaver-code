import { requestRunStop } from "../../../run/control.js";
import type { ManagedProject, RunMetadata } from "../../../types/index.js";
import { appendCanonicalTimelineEntry } from "../../canonical-timeline-command.js";
import { emitAssistantEvent } from "../../live-events.js";
import type { WorkbenchLiveSink } from "../../types.js";

export interface ConversationControlDeps {
  findRunningRunForChange(project: ManagedProject, changeId: string): Promise<RunMetadata | null>;
  interruptProviderTurn?: (
    project: ManagedProject,
    conversationId: string,
  ) => Promise<import("../../conversation-turn-control.js").ConversationTurnInterruptReceipt | null>;
  steerProviderTurn?: (
    project: ManagedProject,
    conversationId: string,
    clientRequestId: string,
    text: string,
  ) => Promise<import("../../conversation-turn-control.js").ConversationTurnSteerReceipt | null>;
}

export async function stopRunningPipeline(
  project: ManagedProject,
  changeId: string,
  prompt: string | undefined,
  live: WorkbenchLiveSink | undefined,
  deps: ConversationControlDeps,
): Promise<unknown> {
  const runningRun = await deps.findRunningRunForChange(project, changeId);
  if (!runningRun) {
    const message = prompt?.trim()
      ? "当前执行已经结束，这条输入会作为完成后的修改反馈处理。"
      : "当前没有正在执行的本地 run。";
    await appendCanonicalTimelineEntry(project, changeId, { type: "assistant.message", status: "stop-not-needed", text: message }, live);
    return { status: "already-completed", message };
  }
  requestRunStop(runningRun.id, prompt?.trim() || "User requested stop from the main conversation.");
  if (prompt?.trim()) {
    await appendCanonicalTimelineEntry(project, changeId, { type: "user.message", text: prompt.trim(), status: "stop-and-continue", runId: runningRun.id }, live);
  }
  await appendCanonicalTimelineEntry(project, changeId, {
    type: "assistant.message",
    status: "stop-requested",
    runId: runningRun.id,
    text: "已请求停止当前本地执行。停止证据会保留，随后会基于你的新指令进入下一轮方案或修改。",
  }, live);
  emitAssistantEvent(live, {
    runId: runningRun.id,
    kind: "status",
    phase: "stopping",
    title: "Stop requested",
    summary: "AHO requested local runner termination; the current evidence remains available for reconciliation.",
  });
  return { status: "stop-requested", runId: runningRun.id };
}

export async function steerConversation(
  project: ManagedProject,
  changeId: string,
  conversationId: string | undefined,
  prompt: string | undefined,
  clientRequestId: string | undefined,
  live: WorkbenchLiveSink | undefined,
  deps: ConversationControlDeps,
): Promise<unknown> {
  const message = prompt?.trim();
  if (!message) throw new Error("conversation.steer requires prompt.");
  const requestId = clientRequestId?.trim();
  if (!requestId) throw new Error("conversation.steer requires clientRequestId.");
  const receipt = conversationId && deps.steerProviderTurn
    ? await deps.steerProviderTurn(project, conversationId, requestId, message)
    : null;
  if (!receipt) {
    const error = new Error("Current Harness execution cannot accept realtime steering; enqueue a complete next Turn instead.");
    error.name = "Conflict";
    throw error;
  }
  if (receipt.status === "already-terminal") return { ...receipt, realtime: false };

  emitAssistantEvent(live, {
    runId: receipt.runId,
    kind: "status",
    phase: "steered",
    title: "已发送给当前执行",
    summary: "这条输入已发送给当前运行中的 Agent。",
  });
  return { status: "steered", realtime: true, runId: receipt.runId, roleId: "main-agent" };
}

export async function interruptConversation(
  project: ManagedProject,
  changeId: string,
  conversationId: string | undefined,
  prompt: string | undefined,
  live: WorkbenchLiveSink | undefined,
  deps: ConversationControlDeps,
): Promise<unknown> {
  const receipt = conversationId && deps.interruptProviderTurn
    ? await deps.interruptProviderTurn(project, conversationId)
    : null;
  if (!receipt || receipt.status === "already-terminal") {
    return stopRunningPipeline(project, changeId, prompt, live, deps);
  }
  const message = prompt?.trim();
  if (message) {
    await appendCanonicalTimelineEntry(project, changeId, { type: "user.message", text: message, status: "interrupt-requested", runId: receipt.runId }, live);
  }
  await appendCanonicalTimelineEntry(project, changeId, {
    type: "assistant.message",
    status: "interrupt-requested",
    runId: receipt.runId,
    text: "已请求停止当前执行。停止证据会保留，你可以继续用自然语言说明下一步。",
  }, live);
  emitAssistantEvent(live, {
    runId: receipt.runId,
    kind: "status",
    phase: "interrupt-requested",
    title: "已请求停止当前执行",
    summary: "AHO sent an interrupt request to the active provider turn.",
    isError: true,
  });
  return { status: receipt.status, realtime: true, runId: receipt.runId, roleId: "main-agent" };
}
