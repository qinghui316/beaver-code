import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkbenchProjectInput } from "../../workbench/read-model-types.js";
import { parseAgentAccessMode } from "../../provider-runtime/agent-access-policy.js";
import type { AgentTurnMode, ProductMode } from "../../provider-runtime/index.js";
import type { TopicFileReference } from "../../workbench/types.js";
import { assertRegisteredProject, readJsonBody, requireProductMode, requireExpectedUpdatedAt, requireAccessRevision, sendJson } from "./http.js";
import type { ConversationTurnInterruptBody, ConversationTurnQueueActionBody, ConversationTurnQueueBody, ConversationTurnQueueContractConfirmationBody, ConversationTurnSteerBody, WorkbenchServerContext } from "./types.js";

export async function handleConversationDeliveryApi(context: WorkbenchServerContext, input: WorkbenchProjectInput, request: IncomingMessage, response: ServerResponse, rest: string, url: URL): Promise<boolean> {
  const guideMatch = rest.match(/^conversations\/([^/]+)\/turn-queue\/([^/]+)\/guide$/);
  if (request.method === "POST" && guideMatch?.[1] && guideMatch[2]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const guideRequest = {
      productMode: requireProductMode(typeof body.productMode === "string" ? body.productMode : null),
      conversationId: decodeURIComponent(guideMatch[1]), queueItemId: decodeURIComponent(guideMatch[2]),
      expectedRevision: requireQueueString(body.expectedRevision, "expectedRevision"),
      expectedExecutionRevision: requireQueueString(body.expectedExecutionRevision, "expectedExecutionRevision"),
      providerId: requireQueueString(body.providerId, "providerId"), expectedAttemptId: requireQueueString(body.expectedAttemptId, "expectedAttemptId"),
      clientRequestId: requireQueueString(body.clientRequestId, "clientRequestId"),
    };
    await sendQueueAdmission(response, { status: "not-accepted", action: "guide", projectId: input.project.id,
      productMode: guideRequest.productMode, conversationId: guideRequest.conversationId,
      queueItemId: guideRequest.queueItemId, clientRequestId: guideRequest.clientRequestId },
      () => context.conversationTurnQueue.guide(input.project, guideRequest));
    return true;
  }
  const turnInterruptMatch = rest.match(/^conversations\/([^/]+)\/turn\/interrupt$/);
  if (request.method === "POST" && turnInterruptMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnInterruptBody>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    if (typeof body.providerId !== "string" || !body.providerId.trim()
      || typeof body.expectedAttemptId !== "string" || !body.expectedAttemptId.trim()) {
      const error = new Error("Conversation interrupt requires providerId and expectedAttemptId.");
      error.name = "BadRequest";
      throw error;
    }
    const conversationId = decodeURIComponent(turnInterruptMatch[1]);
    sendJson(response, 200, await context.turnControl.interrupt(input.project, {
      projectId: input.project.id,
      productMode,
      conversationId,
      providerId: body.providerId.trim(),
      expectedAttemptId: body.expectedAttemptId.trim(),
    }));
    return true;
  }
  const turnQueueMatch = rest.match(/^conversations\/([^/]+)\/turn-queue$/);
  if (request.method === "GET" && turnQueueMatch?.[1]) {
    assertRegisteredProject(input);
    sendJson(response, 200, await context.conversationTurnQueue.read(
      input.project,
      requireProductMode(url.searchParams.get("productMode")),
      decodeURIComponent(turnQueueMatch[1]),
    ));
    return true;
  }
  if (request.method === "POST" && turnQueueMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnQueueBody>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    const itemKind = body.itemKind === "review" ? "review" : "conversation-turn";
    const enqueueRequest: import("../../workbench/conversation-turn-queue-contract.js").ConversationTurnEnqueueRequest = {
      projectId: input.project.id,
      productMode,
      conversationId: decodeURIComponent(turnQueueMatch[1]),
      clientRequestId: requireQueueString(body.clientRequestId, "clientRequestId"),
      expectedRevision: requireQueueString(body.expectedRevision, "expectedRevision"),
      expectedExecutionRevision: requireQueueString(body.expectedExecutionRevision, "expectedExecutionRevision"),
      expectedDraftUpdatedAt: requireExpectedUpdatedAt(body.expectedDraftUpdatedAt),
      itemKind,
      reviewTarget: itemKind === "review" ? body.reviewTarget as import("../../provider-runtime/index.js").ProviderReviewTarget : null,
      text: typeof body.text === "string" ? body.text : "",
      contextRefs: requireQueueContextRefs(body.contextRefs ?? []),
      attachmentIds: requireQueueStringArray(body.attachmentIds ?? [], "attachmentIds"),
      skillOverrides: requireQueueSkillOverrides(body.skillOverrides ?? {}),
      providerId: requireQueueString(body.providerId, "providerId"),
      agentTurnMode: itemKind === "review" ? null : requireQueuedAgentTurnMode(productMode, body.agentTurnMode),
      agentAccessMode: body.agentAccessMode === undefined ? undefined : parseAgentAccessMode(body.agentAccessMode),
      expectedAccessRevision: body.expectedAccessRevision === undefined ? undefined : requireAccessRevision(body.expectedAccessRevision),
      modelId: itemKind === "review" ? null : requireQueueNullableString(body.modelId, "modelId"),
      reasoningEffort: itemKind === "review" ? null : requireQueueNullableString(body.reasoningEffort, "reasoningEffort"),
    };
    await sendQueueAdmission(response, { status: "not-accepted", action: "enqueue", projectId: input.project.id,
      productMode, conversationId: enqueueRequest.conversationId, clientRequestId: enqueueRequest.clientRequestId },
      () => context.conversationTurnQueue.enqueue(input.project, enqueueRequest));
    return true;
  }
  const turnQueueItemMatch = rest.match(/^conversations\/([^/]+)\/turn-queue\/([^/]+)$/);
  if (request.method === "DELETE" && turnQueueItemMatch?.[1] && turnQueueItemMatch[2]) {
    assertRegisteredProject(input);
    sendJson(response, 200, await context.conversationTurnQueue.remove(
      input.project,
      requireProductMode(url.searchParams.get("productMode")),
      decodeURIComponent(turnQueueItemMatch[1]),
      decodeURIComponent(turnQueueItemMatch[2]),
      requireQueueString(url.searchParams.get("expectedRevision"), "expectedRevision"),
    ));
    return true;
  }
  const turnQueueReclaimMatch = rest.match(/^conversations\/([^/]+)\/turn-queue\/([^/]+)\/reclaim$/);
  if (request.method === "POST" && turnQueueReclaimMatch?.[1] && turnQueueReclaimMatch[2]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnQueueActionBody>(request);
    sendJson(response, 200, await context.conversationTurnQueue.reclaim(
      input.project,
      requireProductMode(typeof body.productMode === "string" ? body.productMode : null),
      decodeURIComponent(turnQueueReclaimMatch[1]),
      decodeURIComponent(turnQueueReclaimMatch[2]),
      requireQueueString(body.expectedRevision, "expectedRevision"),
      requireExpectedUpdatedAt(body.expectedDraftUpdatedAt),
    ));
    return true;
  }
  const turnQueueRetryMatch = rest.match(/^conversations\/([^/]+)\/turn-queue\/([^/]+)\/retry$/);
  if (request.method === "POST" && turnQueueRetryMatch?.[1] && turnQueueRetryMatch[2]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnQueueActionBody>(request);
    sendJson(response, 200, await context.conversationTurnQueue.retry(
      input.project,
      requireProductMode(typeof body.productMode === "string" ? body.productMode : null),
      decodeURIComponent(turnQueueRetryMatch[1]),
      decodeURIComponent(turnQueueRetryMatch[2]),
      requireQueueString(body.expectedRevision, "expectedRevision"),
    ));
    return true;
  }
  const turnQueueConfirmContractMatch = rest.match(/^conversations\/([^/]+)\/turn-queue\/([^/]+)\/confirm-execution$/);
  if (request.method === "POST" && turnQueueConfirmContractMatch?.[1] && turnQueueConfirmContractMatch[2]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnQueueContractConfirmationBody>(request);
    sendJson(response, 200, await context.conversationTurnQueue.confirmExecutionContract(input.project, {
      productMode: requireProductMode(typeof body.productMode === "string" ? body.productMode : null),
      conversationId: decodeURIComponent(turnQueueConfirmContractMatch[1]),
      queueItemId: decodeURIComponent(turnQueueConfirmContractMatch[2]),
      expectedRevision: requireQueueString(body.expectedRevision, "expectedRevision"),
      clientRequestId: requireQueueString(body.clientRequestId, "clientRequestId"),
      expectedCreatedContract: requireQueueExecutionContractRef(body.expectedCreatedContract, "expectedCreatedContract"),
      expectedTargetContract: requireQueueExecutionContractRef(body.expectedTargetContract, "expectedTargetContract"),
    }));
    return true;
  }
  const turnQueueDispatchMatch = rest.match(/^conversations\/([^/]+)\/turn-queue\/dispatch-next$/);
  if (request.method === "POST" && turnQueueDispatchMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnQueueActionBody>(request);
    sendJson(response, 200, await context.conversationTurnQueue.dispatchNext(
      input.project,
      requireProductMode(typeof body.productMode === "string" ? body.productMode : null),
      decodeURIComponent(turnQueueDispatchMatch[1]),
      requireQueueString(body.expectedRevision, "expectedRevision"),
    ));
    return true;
  }
  const turnSteerMatch = rest.match(/^conversations\/([^/]+)\/turn\/steer$/);
  if (request.method === "POST" && turnSteerMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnSteerBody>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    if (productMode !== "agent") {
      const error = new Error("The direct Conversation steering endpoint is available only in Agent mode.");
      error.name = "Conflict";
      throw error;
    }
    if (typeof body.providerId !== "string" || !body.providerId.trim()
      || typeof body.expectedAttemptId !== "string" || !body.expectedAttemptId.trim()
      || typeof body.clientRequestId !== "string" || !body.clientRequestId.trim()
      || typeof body.text !== "string" || !body.text.trim()) {
      const error = new Error("Conversation steering requires providerId, expectedAttemptId, clientRequestId, and text.");
      error.name = "BadRequest";
      throw error;
    }
    const conversationId = decodeURIComponent(turnSteerMatch[1]);
    const steerRequest = {
      projectId: input.project.id,
      productMode,
      conversationId,
      providerId: body.providerId.trim(),
      expectedAttemptId: body.expectedAttemptId.trim(),
      clientRequestId: body.clientRequestId.trim(),
      text: body.text.trim(),
    } as const;
    const receipt = await context.inputDelivery.steer(input.project, steerRequest);
    sendJson(response, 200, receipt);
    return true;
  }
  return false;
}

function requireQueueString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512) throw badQueueRequest(`${field} must be a non-empty bounded string.`);
  return normalized;
}

function requireQueueNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireQueueString(value, field);
}

function requireQueueExecutionContractRef(
  value: unknown,
  field: string,
): { family: string; epoch: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badQueueRequest(field + " must be an execution contract reference.");
  }
  const record = value as Record<string, unknown>;
  const family = requireQueueString(record.family, field + ".family");
  const epoch = record.epoch;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 0) {
    throw badQueueRequest(field + ".epoch must be a non-negative safe integer.");
  }
  return { family, epoch: Number(epoch) };
}

function requireQueueStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw badQueueRequest(`${field} must be a bounded string array.`);
  const result = value.map((item) => requireQueueString(item, field));
  if (new Set(result).size !== result.length) throw badQueueRequest(`${field} cannot contain duplicates.`);
  return result;
}

function requireQueueContextRefs(value: unknown): TopicFileReference[] {
  if (!Array.isArray(value) || value.length > 100) throw badQueueRequest("contextRefs must be a bounded array.");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badQueueRequest("Each contextRef must be an object.");
    const item = raw as Record<string, unknown>;
    const relativePath = requireQueueString(item.relativePath, "contextRef.relativePath").replaceAll("\\", "/");
    const segments = relativePath.split("/");
    if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)
      || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw badQueueRequest("contextRef.relativePath must stay project-relative.");
    }
    const kind = item.kind === "file" || item.kind === "directory" ? item.kind : null;
    if (!kind) throw badQueueRequest("contextRef.kind must be file or directory.");
    const size = item.size === undefined ? undefined : item.size;
    if (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)) {
      throw badQueueRequest("contextRef.size must be a non-negative safe integer.");
    }
    return {
      relativePath,
      name: requireQueueString(item.name, "contextRef.name"),
      kind,
      ...(typeof item.extension === "string" && item.extension.trim() ? { extension: item.extension.trim().slice(0, 32) } : {}),
      ...(typeof size === "number" ? { size } : {}),
      source: "composer" as const,
    };
  });
}

function requireQueueSkillOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badQueueRequest("skillOverrides must be an object.");
  const entries = Object.entries(value);
  if (entries.length > 100) throw badQueueRequest("skillOverrides contains too many entries.");
  return Object.fromEntries(entries.map(([skillId, enabled]): [string, boolean] => {
    const normalizedId = requireQueueString(skillId, "skillOverrides skillId");
    if (typeof enabled !== "boolean") throw badQueueRequest("skillOverrides values must be boolean.");
    return [normalizedId, enabled];
  }).sort(([left], [right]) => left.localeCompare(right)));
}

function requireQueuedAgentTurnMode(productMode: ProductMode, value: unknown): AgentTurnMode | null {
  if (productMode === "harness") {
    if (value !== null) throw conflictQueueRequest("Harness queued Turns cannot carry Agent mode.");
    return null;
  }
  if (value !== "default" && value !== "plan") throw badQueueRequest("Agent queued Turns require default or plan mode.");
  return value;
}

function badQueueRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}

function conflictQueueRequest(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

async function sendQueueAdmission(response: ServerResponse,
  rejection: import("../../workbench/conversation-turn-queue-contract.js").ConversationQueueAdmissionRejection,
  action: () => Promise<unknown>): Promise<void> {
  try { sendJson(response, 200, await action()); }
  catch (cause) {
    if (!(cause instanceof Error) || !("queueAdmissionRejected" in cause) || cause.queueAdmissionRejected !== true) throw cause;
    sendJson(response, 409, { error: cause.message, queueAdmission: rejection });
  }
}
