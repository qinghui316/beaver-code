import type { IncomingMessage, ServerResponse } from "node:http";
import { createWorkbenchConversation, updateWorkbenchConversationTitle } from "../../workbench/conversation-service.js";

import { openProjectRuntimeWorkbenchDatabase } from "../../workbench/persistence/open-workbench-database.js";
import { ComposerDraftConflictError } from "../../workbench/persistence/repositories/composer-draft-repository.js";
import { nextComposerDraftTimestamp } from "../../workbench/composer-draft-recovery.js";
import {
  getWorkbenchSnapshot,
  getWorkbenchNavigation,
  getWorkbenchStream,
  getWorkbenchTopic,
  listWorkbenchApprovals,
  listWorkbenchTopics,
  type WorkbenchProjectInput,
} from "../../workbench/projections/read-model/implementation.js";
import { getCanonicalTimelinePage } from "../../workbench/canonical-timeline-query.js";
import { getWorkbenchProjection } from "./projections.js";
import { readWorkbenchActionEvents, sendActionEventReplay } from "./live.js";
import { assertRegisteredProject, readJsonBody, requireProductMode, requireExpectedUpdatedAt, sendJson } from "./http.js";
import { handleIntakeReanalyze, handleIntakeScan } from "./intake.js";
import { sendConversationInteractionSettlement } from "./conversation-interactions.js";
import { sendWorkbenchActionLive } from "./live-actions.js";
import { readCreateTopicBody, sendConversationMessageLive, sendCreateTopicLive } from "./topic-messages.js";
import { executeWorkbenchAction } from "./actions.js";
import { sendProjectLiveEvents } from "./project-live-events.js";
import type { ConversationContextCompactBody, ConversationDeleteConfirmationBody, ConversationForkBody, ConversationLifecycleBody, IntakeRequest, UpdateConversationTitleRequest, WorkbenchActionRequest, WorkbenchServerContext } from "./types.js";
import { sendConversationRetryLive } from "./conversation-retry.js";
import { configureConversationAccess } from "../../workbench/conversation-service.js";

import { handleConversationDeliveryApi } from "./conversation-delivery-routes.js";

export async function handleProjectWorkbenchApi(context: WorkbenchServerContext, input: WorkbenchProjectInput, request: IncomingMessage, response: ServerResponse, rest: string, url: URL): Promise<void> {
  if (await handleConversationDeliveryApi(context, input, request, response, rest, url)) return;
  const accessMatch = rest.match(/^conversations\/([^/]+)\/access$/);
  if ((request.method === "GET" || request.method === "POST") && accessMatch?.[1]) {
    assertRegisteredProject(input);
    const body = request.method === "POST"
      ? await readJsonBody<Record<string, unknown>>(request)
      : { productMode: url.searchParams.get("productMode"), providerId: url.searchParams.get("providerId") };
    sendJson(response, 200, await configureConversationAccess(input.project, decodeURIComponent(accessMatch[1]), {
      productMode: body.productMode, providerId: body.providerId,
      ...(request.method === "POST" ? { accessMode: body.accessMode, expectedRevision: body.expectedRevision,
        confirmFullAccess: body.confirmFullAccess } : {}),
    }, { runtimeStateResolver: (project) => context.projectRuntimeCoordinator.resolve(project), providerRegistry: context.providerRegistry }));
    return;
  }
  if (request.method === "GET" && rest === "events/live") {
    assertRegisteredProject(input);
    await sendProjectLiveEvents(input, request, response);
    return;
  }
  if (request.method === "GET" && rest === "snapshot") {
    const productMode = requireProductMode(url.searchParams.get("productMode"));
    sendJson(response, 200, await getWorkbenchSnapshot(input, { topicId: url.searchParams.get("topic") ?? undefined, productMode,
      compactThread: url.searchParams.get("compactThread") === "1" }));
    return;
  }
  if (request.method === "GET" && rest === "mode-activity") {
    assertRegisteredProject(input);
    sendJson(response, 200, await context.productModeActivity.read(input));
    return;
  }
  if (request.method === "POST" && rest === "reviews") {
    assertRegisteredProject(input);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    if (productMode !== "agent") {
      const error = new Error("Native Code Review is available only in Agent mode.");
      error.name = "Conflict";
      throw error;
    }
    sendJson(response, 200, await context.conversationReview.start(input.project!, {
      productMode,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      providerId: requireReviewString(body.providerId, "providerId"),
      target: body.target as import("../../provider-runtime/index.js").ProviderReviewTarget,
      expectedTimelineRevision: typeof body.expectedTimelineRevision === "number" ? body.expectedTimelineRevision : null,
      expectedExecutionRevision: typeof body.expectedExecutionRevision === "string" ? body.expectedExecutionRevision : null,
      clientRequestId: requireReviewString(body.clientRequestId, "clientRequestId"),
    }));
    return;
  }
  if (request.method === "GET" && rest.startsWith("projections/")) {
    sendJson(response, 200, await getWorkbenchProjection(input, rest.slice("projections/".length), url.searchParams));
    return;
  }
  if (request.method === "GET" && rest === "topics") {
    sendJson(response, 200, await listWorkbenchTopics(input, requireProductMode(url.searchParams.get("productMode"))));
    return;
  }
  if (request.method === "GET" && rest === "navigation") {
    const state = url.searchParams.get("state");
    if (state !== null && state !== "active" && state !== "archive" && state !== "all") {
      const error = new Error("Conversation navigation state must be active, archive, or all.");
      error.name = "BadRequest";
      throw error;
    }
    sendJson(response, 200, await getWorkbenchNavigation(input, requireProductMode(url.searchParams.get("productMode")), state ?? "all"));
    return;
  }
  if (rest === "composer-draft" && request.method === "GET") {
    assertRegisteredProject(input);
    const productMode = requireProductMode(url.searchParams.get("productMode"));
    const runtime = await input.runtimeStateResolver!(input.project!);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const draft = await context.composerDraftRecovery.restore(
        input.project!,
        database.drafts.readDraft(paths.projectId, productMode),
      );
      sendJson(response, 200, { draft });
    } finally {
      database.close();
    }
    return;
  }
  if (rest === "composer-draft" && request.method === "PUT") {
    assertRegisteredProject(input);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const productMode = requireProductMode(body.productMode);
    const expectedUpdatedAt = requireExpectedUpdatedAt(body.expectedUpdatedAt);
    const runtime = await input.runtimeStateResolver!(input.project!);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const current = database.drafts.readDraft(paths.projectId, productMode);
      const write = await context.composerDraftRecovery.prepareWrite(
        input.project!,
        { ...body, productMode },
        nextComposerDraftTimestamp(current),
      );
      try {
        const stored = database.drafts.upsertDraft(write, expectedUpdatedAt);
        sendJson(response, 200, { draft: await context.composerDraftRecovery.restore(input.project!, stored) });
      } catch (cause) {
        if (!(cause instanceof ComposerDraftConflictError)) throw cause;
        sendJson(response, 409, {
          error: cause.message,
          draft: await context.composerDraftRecovery.restore(input.project!, cause.current),
        });
      }
    } finally {
      database.close();
    }
    return;
  }
  if (rest === "composer-draft" && request.method === "DELETE") {
    assertRegisteredProject(input);
    const productMode = requireProductMode(url.searchParams.get("productMode"));
    const expectedUpdatedAt = requireExpectedUpdatedAt(url.searchParams.get("expectedUpdatedAt"));
    const runtime = await input.runtimeStateResolver!(input.project!);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      try {
        const deleted = database.drafts.deleteDraft(paths.projectId, productMode, expectedUpdatedAt);
        sendJson(response, 200, { deleted });
      } catch (cause) {
        if (!(cause instanceof ComposerDraftConflictError)) throw cause;
        sendJson(response, 409, {
          error: cause.message,
          draft: await context.composerDraftRecovery.restore(input.project!, cause.current),
        });
      }
    } finally {
      database.close();
    }
    return;
  }
  if (request.method === "POST" && rest === "topics/live") {
    assertRegisteredProject(input);
    await sendCreateTopicLive(input, request, response, context.turnRouter);
    return;
  }
  if (request.method === "POST" && rest === "topics") {
    assertRegisteredProject(input);
    const body = await readCreateTopicBody(request);
    const topic = await createWorkbenchConversation(input.project, body, undefined, { runMainAgent: false, turnRouter: context.turnRouter });
    sendJson(response, 200, {
      topic: {
        id: topic.conversationId,
        conversationId: topic.conversationId,
        productMode: topic.productMode,
        clientRequestId: topic.clientRequestId,
        replayed: topic.replayed,
        title: topic.title,
        state: topic.state,
        agentTurnMode: topic.agentTurnMode,
        agentModelId: topic.agentModelId,
        agentReasoningEffort: topic.agentReasoningEffort,
      },
      snapshot: await getWorkbenchSnapshot(input, { topicId: topic.conversationId, productMode: topic.productMode }),
    });
    return;
  }
  if (request.method === "POST" && rest === "intake/scan") {
    assertRegisteredProject(input);
    sendJson(response, 200, await handleIntakeScan(input, await readJsonBody<IntakeRequest>(request)));
    return;
  }
  if (request.method === "POST" && rest === "intake/reanalyze") {
    assertRegisteredProject(input);
    sendJson(response, 200, await handleIntakeReanalyze(input, await readJsonBody<IntakeRequest>(request)));
    return;
  }
  const timelineMatch = rest.match(/^conversations\/([^/]+)\/timeline$/);
  if (request.method === "GET" && timelineMatch?.[1]) {
    const conversationId = decodeURIComponent(timelineMatch[1]);
    const agentSurfaceId = url.searchParams.get("agentSurfaceId")?.trim();
    if (!agentSurfaceId) {
      const error = new Error("Canonical Timeline requires agentSurfaceId.");
      error.name = "BadRequest";
      throw error;
    }
    const limitRaw = url.searchParams.get("limit");
    sendJson(response, 200, await getCanonicalTimelinePage(
      input,
      conversationId,
      agentSurfaceId,
      requireProductMode(url.searchParams.get("productMode")),
      {
      limit: limitRaw === null ? undefined : Number(limitRaw),
      beforeCursor: url.searchParams.get("beforeCursor") ?? undefined,
      },
    ));
    return;
  }
  const topicTitleMatch = rest.match(/^topics\/([^/]+)\/title$/);
  if (request.method === "POST" && topicTitleMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<UpdateConversationTitleRequest>(request);
    if (typeof body.title !== "string") {
      const error = new Error("Conversation title is required.");
      error.name = "BadRequest";
      throw error;
    }
    const conversation = await updateWorkbenchConversationTitle(input.project, decodeURIComponent(topicTitleMatch[1]), { title: body.title }, {
      runtimeStateResolver: input.runtimeStateResolver,
    });
    sendJson(response, 200, { conversation });
    return;
  }
  const interactionSettlementMatch = rest.match(/^conversations\/([^/]+)\/interactions\/([^/]+)\/settle$/);
  if (request.method === "POST" && interactionSettlementMatch?.[1] && interactionSettlementMatch[2]) {
    assertRegisteredProject(input);
    await sendConversationInteractionSettlement(
      input,
      decodeURIComponent(interactionSettlementMatch[1]),
      decodeURIComponent(interactionSettlementMatch[2]),
      request,
      response,
      context.turnRouter,
      context.providerRegistry,
    );
    return;
  }
  const contextCompactMatch = rest.match(/^conversations\/([^/]+)\/context\/compact$/);
  if (request.method === "POST" && contextCompactMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationContextCompactBody>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    if (typeof body.providerId !== "string" || !body.providerId.trim()
      || typeof body.contextRevision !== "string" || !body.contextRevision.trim()
      || typeof body.clientRequestId !== "string" || !body.clientRequestId.trim()) {
      const error = new Error("Context compaction requires providerId, contextRevision, and clientRequestId.");
      error.name = "BadRequest";
      throw error;
    }
    sendJson(response, 200, await context.conversationContext.compact(input.project, {
      projectId: input.project.id,
      productMode,
      conversationId: decodeURIComponent(contextCompactMatch[1]),
      providerId: body.providerId.trim(),
      contextRevision: body.contextRevision.trim(),
      clientRequestId: body.clientRequestId.trim(),
    }));
    return;
  }
  const lifecycleMatch = rest.match(/^conversations\/([^/]+)\/lifecycle$/);
  if (request.method === "GET" && lifecycleMatch?.[1]) {
    assertRegisteredProject(input);
    sendJson(response, 200, await context.conversationLifecycle.read(
      input.project,
      requireProductMode(url.searchParams.get("productMode")),
      decodeURIComponent(lifecycleMatch[1]),
    ));
    return;
  }
  if (request.method === "POST" && lifecycleMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationLifecycleBody>(request);
    const action = requireLifecycleAction(body.action);
    sendJson(response, 200, await context.conversationLifecycle.settle(input.project, {
      projectId: input.project.id,
      productMode: requireProductMode(typeof body.productMode === "string" ? body.productMode : null),
      conversationId: decodeURIComponent(lifecycleMatch[1]),
      action,
      expectedLifecycleRevision: requireLifecycleString(body.expectedLifecycleRevision, "expectedLifecycleRevision"),
      clientRequestId: requireLifecycleString(body.clientRequestId, "clientRequestId"),
      confirmationToken: action === "delete"
        ? requireLifecycleString(body.confirmationToken, "confirmationToken")
        : null,
    }));
    return;
  }
  const deleteConfirmationMatch = rest.match(/^conversations\/([^/]+)\/lifecycle\/delete-confirmation$/);
  if (request.method === "POST" && deleteConfirmationMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationDeleteConfirmationBody>(request);
    sendJson(response, 200, await context.conversationLifecycle.prepareDelete(
      input.project,
      requireProductMode(typeof body.productMode === "string" ? body.productMode : null),
      decodeURIComponent(deleteConfirmationMatch[1]),
      requireLifecycleString(body.expectedLifecycleRevision, "expectedLifecycleRevision"),
    ));
    return;
  }
  const conversationForkMatch = rest.match(/^conversations\/([^/]+)\/fork$/);
  if (request.method === "POST" && conversationForkMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationForkBody>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    if (productMode !== "agent") {
      const error = new Error("Conversation fork is available only in Agent mode.");
      error.name = "Conflict";
      throw error;
    }
    if (typeof body.providerId !== "string" || !body.providerId.trim()
      || typeof body.sourceMessageId !== "string" || !body.sourceMessageId.trim()
      || typeof body.expectedCompletedTurnSequence !== "number" || !Number.isSafeInteger(body.expectedCompletedTurnSequence)
      || typeof body.expectedTimelineRevision !== "number" || !Number.isSafeInteger(body.expectedTimelineRevision)
      || typeof body.contextRevision !== "string" || !body.contextRevision.trim()
      || typeof body.clientRequestId !== "string" || !body.clientRequestId.trim()) {
      const error = new Error("Conversation fork requires Provider, anchor, Timeline, context, and client request identity.");
      error.name = "BadRequest";
      throw error;
    }
    sendJson(response, 200, await context.conversationFork.fork(input.project, {
      projectId: input.project.id,
      productMode,
      conversationId: decodeURIComponent(conversationForkMatch[1]),
      providerId: body.providerId.trim(),
      sourceMessageId: body.sourceMessageId.trim(),
      expectedCompletedTurnSequence: body.expectedCompletedTurnSequence,
      expectedTimelineRevision: body.expectedTimelineRevision,
      contextRevision: body.contextRevision.trim(),
      clientRequestId: body.clientRequestId.trim(),
    }));
    return;
  }
  const turnRetryMatch = rest.match(/^conversations\/([^/]+)\/turn\/retry\/live$/);
  if (request.method === "POST" && turnRetryMatch?.[1]) {
    assertRegisteredProject(input);
    await sendConversationRetryLive(
      input,
      decodeURIComponent(turnRetryMatch[1]),
      request,
      response,
      context.turnRetry,
    );
    return;
  }
  const topicMessagesLiveMatch = rest.match(/^topics\/([^/]+)\/messages\/live$/);
  if (request.method === "POST" && topicMessagesLiveMatch?.[1]) {
    assertRegisteredProject(input);
    const id = decodeURIComponent(topicMessagesLiveMatch[1]);
    await sendConversationMessageLive(input, id, request, response, context.turnRouter);
    return;
  }
  if (request.method === "GET" && /^topics\/[^/]+\/messages(?:\/stream)?$/.test(rest)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  if (request.method === "GET" && rest.startsWith("topics/")) {
    sendJson(response, 200, await getWorkbenchTopic(
      input,
      decodeURIComponent(rest.slice("topics/".length)),
      requireProductMode(url.searchParams.get("productMode")),
    ));
    return;
  }
  if (request.method === "GET" && rest.startsWith("stream/")) {
    sendJson(response, 200, await getWorkbenchStream(input, decodeURIComponent(rest.slice("stream/".length))));
    return;
  }
  if (request.method === "GET" && rest === "approvals") {
    sendJson(response, 200, await listWorkbenchApprovals(input, {
      topicId: url.searchParams.get("topic") ?? undefined,
      productMode: requireProductMode(url.searchParams.get("productMode")),
    }));
    return;
  }
  if (request.method === "POST" && rest === "actions") {
    sendJson(response, 200, await executeWorkbenchAction(input, await readJsonBody<WorkbenchActionRequest>(request), undefined, context.turnRouter));
    return;
  }
  if (request.method === "POST" && rest === "actions/live") {
    assertRegisteredProject(input);
    await sendWorkbenchActionLive(input, request, response, context.turnRouter);
    return;
  }
  const actionEventsMatch = rest.match(/^actions\/([^/]+)\/events$/);
  if (request.method === "GET" && actionEventsMatch?.[1]) {
    assertRegisteredProject(input);
    await sendActionEventReplay(input.project, decodeURIComponent(actionEventsMatch[1]), response);
    return;
  }
  const actionMatch = rest.match(/^actions\/([^/]+)$/);
  if (request.method === "GET" && actionMatch?.[1]) {
    assertRegisteredProject(input);
    sendJson(response, 200, { events: await readWorkbenchActionEvents(input.project, decodeURIComponent(actionMatch[1])) });
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

function requireLifecycleString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512) {
    const error = new Error(`Conversation lifecycle ${field} must be a non-empty bounded string.`);
    error.name = "BadRequest";
    throw error;
  }
  return normalized;
}

function requireLifecycleAction(value: unknown): "archive" | "restore" | "delete" {
  if (value === "archive" || value === "restore" || value === "delete") return value;
  const error = new Error("Conversation lifecycle action must be archive, restore, or delete.");
  error.name = "BadRequest";
  throw error;
}

function requireReviewString(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512) {
    const error = new Error(`Code Review ${field} must be a non-empty bounded string.`);
    error.name = "BadRequest";
    throw error;
  }
  return normalized;
}
