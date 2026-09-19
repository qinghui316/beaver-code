import type { IncomingMessage, ServerResponse } from "node:http";
import { createSseResponse } from "../sse.js";
import {
  createWorkbenchConversation,
  postConversationMessage,
  normalizeConversationClientRequestId,
  prepareConversationMessage,
  prepareWorkbenchConversation,
} from "../../workbench/conversation-service.js";
import { getWorkbenchSnapshot, type WorkbenchProjectInput } from "../../workbench/projections/read-model/implementation.js";
import type { WorkbenchLiveSink } from "../../workbench/types.js";
import type { ManagedProject } from "../../types/index.js";
import { createLiveSink } from "./live.js";
import { readJsonBody, requireProductMode } from "./http.js";
import type {
  CreateTopicRequest,
  TopicMessageRequest,
} from "./types.js";
import type { ConversationTurnRoutingPort } from "../../workbench/conversation-turn-contract.js";

export async function readCreateTopicBody(request: IncomingMessage): Promise<{
  body?: string;
  contextRefs?: CreateTopicRequest["contextRefs"];
  attachmentIds?: string[];
  providerId?: string;
  productMode: import("../../provider-runtime/index.js").ProductMode;
  clientRequestId: string;
  skillOverrides?: CreateTopicRequest["skillOverrides"];
  agentTurnMode?: CreateTopicRequest["agentTurnMode"];
  agentAccessMode?: CreateTopicRequest["agentAccessMode"];
  modelId?: CreateTopicRequest["modelId"];
  reasoningEffort?: CreateTopicRequest["reasoningEffort"];
}> {
  const body = await readJsonBody<CreateTopicRequest>(request);
  if (body.confirm !== true) {
    const error = new Error("Creating a demand conversation requires confirm: true.");
    error.name = "Conflict";
    throw error;
  }
  const hasText = typeof body.body === "string" && body.body.trim() !== "";
  const hasAttachments = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
  if (!hasText && !hasAttachments) {
    const error = new Error("Demand conversation text or attachment is required.");
    error.name = "BadRequest";
    throw error;
  }
  if (typeof body.clientRequestId !== "string") {
    const error = new Error("Creating a conversation requires clientRequestId.");
    error.name = "BadRequest";
    throw error;
  }
  return {
    body: body.body,
    contextRefs: body.contextRefs,
    attachmentIds: body.attachmentIds,
    providerId: body.providerId,
    productMode: requireProductMode(body.productMode),
    clientRequestId: body.clientRequestId,
    skillOverrides: body.skillOverrides,
    agentTurnMode: body.agentTurnMode,
    agentAccessMode: body.agentAccessMode,
    modelId: body.modelId,
    reasoningEffort: body.reasoningEffort,
  };
}

export async function readTopicMessageBody(request: IncomingMessage): Promise<TopicMessageRequest> {
  const raw = await readJsonBody<TopicMessageRequest>(request);
  const message: TopicMessageRequest = {
    clientRequestId: raw.clientRequestId === undefined
      ? undefined
      : normalizeConversationClientRequestId(raw.clientRequestId),
    text: raw.text,
    message: raw.message,
    mode: raw.mode,
    contextRefs: raw.contextRefs,
    attachmentIds: raw.attachmentIds,
    providerId: raw.providerId,
    providerSwitchIntent: raw.providerSwitchIntent,
    agentSurfaceId: raw.agentSurfaceId,
    productMode: requireProductMode(raw.productMode),
    agentTurnMode: raw.agentTurnMode,
    agentAccessMode: raw.agentAccessMode,
    expectedAccessRevision: raw.expectedAccessRevision,
    modelId: raw.modelId,
    reasoningEffort: raw.reasoningEffort,
  };
  assertTopicMessageText(message);
  return message;
}

export async function sendCreateTopicLive(
  input: WorkbenchProjectInput & { project: ManagedProject },
  request: IncomingMessage,
  response: ServerResponse,
  turnRouter: ConversationTurnRoutingPort,
): Promise<void> {
  const body = await readCreateTopicBody(request);
  const prepared = await prepareWorkbenchConversation(input.project, body, { turnRouter });
  const sse = createSseResponse(response);
  let conversationId: string | undefined;
  const downstream = createLiveSink(sse, input.project.id);
  const sink: WorkbenchLiveSink = {
    emit(event): void {
      if (event.event === "topic.created") conversationId = event.data.conversationId;
      downstream.emit(event);
    },
    isClosed: () => downstream.isClosed?.() ?? false,
  };
  try {
    const topic = await createWorkbenchConversation(input.project, body, sink, { turnRouter, prepared });
    conversationId = topic.conversationId;
    sink.emit({ event: "snapshot", data: await getWorkbenchSnapshot(input, { topicId: topic.conversationId, productMode: topic.productMode }) });
    sink.emit({ event: "done", data: { projectId: input.project.id, productMode: topic.productMode, conversationId: topic.conversationId, status: "completed" } });
  } catch (cause) {
    sink.emit({ event: "error", data: { projectId: input.project.id, productMode: body.productMode, conversationId, message: cause instanceof Error ? cause.message : String(cause) } });
    sink.emit({ event: "snapshot", data: await getWorkbenchSnapshot(input, { topicId: conversationId, productMode: body.productMode }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })) });
    sink.emit({ event: "done", data: { projectId: input.project.id, productMode: body.productMode, conversationId, status: "failed" } });
  } finally {
    sse.end();
  }
}

export async function sendConversationMessageLive(
  input: WorkbenchProjectInput & { project: ManagedProject },
  conversationId: string,
  request: IncomingMessage,
  response: ServerResponse,
  turnRouter: ConversationTurnRoutingPort,
): Promise<void> {
  const message = await readTopicMessageBody(request);
  const prepared = message.productMode === "agent" && !message.agentSurfaceId
    ? await prepareConversationMessage(input.project, conversationId, message, { turnRouter })
    : undefined;
  const sse = createSseResponse(response);
  const sink = createLiveSink(sse, input.project.id);
  let resolvedConversationId = conversationId;
  try {
    const result = await postConversationMessage(input.project, resolvedConversationId, message, sink, { turnRouter, prepared });
    resolvedConversationId = result.user.conversationId ?? resolvedConversationId;
    sink.emit({ event: "snapshot", data: await getWorkbenchSnapshot(input, { topicId: resolvedConversationId, productMode: message.productMode }) });
    sink.emit({ event: "done", data: { projectId: input.project.id, productMode: message.productMode, conversationId: resolvedConversationId, status: "completed" } });
  } catch (cause) {
    sink.emit({ event: "error", data: { projectId: input.project.id, productMode: message.productMode, conversationId: resolvedConversationId, message: cause instanceof Error ? cause.message : String(cause) } });
    sink.emit({ event: "snapshot", data: await getWorkbenchSnapshot(input, { topicId: resolvedConversationId, productMode: message.productMode }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })) });
    sink.emit({ event: "done", data: { projectId: input.project.id, productMode: message.productMode, conversationId: resolvedConversationId, status: "failed" } });
  } finally {
    sse.end();
  }
}

function assertTopicMessageText(message: TopicMessageRequest): void {
  const hasText = typeof (message.message ?? message.text) === "string" && (message.message ?? message.text ?? "").trim() !== "";
  const hasAttachments = Array.isArray(message.attachmentIds) && message.attachmentIds.length > 0;
  if (!hasText && !hasAttachments) {
    const error = new Error("Message text is required.");
    error.name = "BadRequest";
    throw error;
  }
}
