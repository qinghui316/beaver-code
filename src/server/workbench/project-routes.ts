import type { IncomingMessage, ServerResponse } from "node:http";
import { createWorkbenchConversation, updateWorkbenchConversationTitle } from "../../workbench/conversation-service.js";
import { parseAgentAccessMode } from "../../provider-runtime/agent-access-policy.js";

import { openProjectRuntimeWorkbenchDatabase } from "../../workbench/persistence/open-workbench-database.js";
import { CanonicalTimelineDelivery } from "../../workbench/canonical-timeline-delivery.js";
import { toCanonicalTimelineMessage } from "../../workbench/canonical-timeline-message.js";
import type { ConversationTurnSteerRequest } from "../../workbench/conversation-turn-control.js";
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
import { assertRegisteredProject, readJsonBody, requireProductMode, sendJson } from "./http.js";
import { handleIntakeReanalyze, handleIntakeScan } from "./intake.js";
import { sendConversationInteractionSettlement } from "./conversation-interactions.js";
import { sendWorkbenchActionLive } from "./live-actions.js";
import { readCreateTopicBody, sendConversationMessageLive, sendCreateTopicLive } from "./topic-messages.js";
import { executeWorkbenchAction } from "./actions.js";
import { sendProjectLiveEvents } from "./project-live-events.js";
import type { ConversationContextCompactBody, ConversationDeleteConfirmationBody, ConversationForkBody, ConversationLifecycleBody, ConversationTurnInterruptBody, ConversationTurnQueueActionBody, ConversationTurnQueueBody, ConversationTurnQueueContractConfirmationBody, ConversationTurnSteerBody, IntakeRequest, UpdateConversationTitleRequest, WorkbenchActionRequest, WorkbenchServerContext } from "./types.js";
import type { AgentTurnMode, ProductMode } from "../../provider-runtime/index.js";
import type { TopicFileReference } from "../../workbench/types.js";
import { conversationSteerTimelineIds } from "../../workbench/conversation-turn-control.js";
import { sendConversationRetryLive } from "./conversation-retry.js";
import { configureConversationAccess } from "../../workbench/conversation-service.js";

function requireAccessRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    const error = new Error("Access revision is invalid.");
    error.name = "BadRequest";
    throw error;
  }
  return value;
}

export async function handleProjectWorkbenchApi(context: WorkbenchServerContext, input: WorkbenchProjectInput, request: IncomingMessage, response: ServerResponse, rest: string, url: URL): Promise<void> {
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
    sendJson(response, 200, await getWorkbenchNavigation(input, requireProductMode(url.searchParams.get("productMode"))));
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
  const turnInterruptMatch = rest.match(/^conversations\/([^/]+)\/turn\/interrupt$/);
  if (request.method === "POST" && turnInterruptMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnInterruptBody>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    if (productMode !== "agent") {
      const error = new Error("The direct Conversation interrupt endpoint is available only in Agent mode.");
      error.name = "Conflict";
      throw error;
    }
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
  const turnQueueMatch = rest.match(/^conversations\/([^/]+)\/turn-queue$/);
  if (request.method === "GET" && turnQueueMatch?.[1]) {
    assertRegisteredProject(input);
    sendJson(response, 200, await context.conversationTurnQueue.read(
      input.project,
      requireProductMode(url.searchParams.get("productMode")),
      decodeURIComponent(turnQueueMatch[1]),
    ));
    return;
  }
  if (request.method === "POST" && turnQueueMatch?.[1]) {
    assertRegisteredProject(input);
    const body = await readJsonBody<ConversationTurnQueueBody>(request);
    const productMode = requireProductMode(typeof body.productMode === "string" ? body.productMode : null);
    const itemKind = body.itemKind === "review" ? "review" : "conversation-turn";
    sendJson(response, 200, await context.conversationTurnQueue.enqueue(input.project, {
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
    }));
    return;
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
    return;
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
    return;
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
    return;
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
    return;
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
    return;
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
    const receipt = await context.turnControl.steer(input.project, steerRequest);
    if (receipt.status === "steer-accepted") {
      await persistAgentSteer(input, steerRequest, receipt.runId);
    }
    sendJson(response, 200, receipt);
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

async function persistAgentSteer(
  input: WorkbenchProjectInput & { project: NonNullable<WorkbenchProjectInput["project"]> },
  request: ConversationTurnSteerRequest,
  runId: string,
): Promise<void> {
  const runtime = await input.runtimeStateResolver!(input.project);
  const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const conversation = database.conversations.readConversation(paths.projectId, request.conversationId);
    const attempt = database.providerAttempts.readProviderAttempt(paths.projectId, request.expectedAttemptId);
    if (!conversation || conversation.deletedAt
      || conversation.productMode !== "agent"
      || conversation.selectedProviderId !== request.providerId
      || attempt?.conversationId !== conversation.conversationId
      || attempt.graphScopeId !== conversation.currentGraphScopeId
      || attempt.providerId !== request.providerId
      || attempt.roleId !== "main-agent") {
      const error = new Error("Accepted steering evidence no longer matches the current Agent Turn.");
      error.name = "Conflict";
      throw error;
    }
    const { userId, ackId } = conversationSteerTimelineIds(request.expectedAttemptId, request.clientRequestId);
    const timestamp = database.timeline.readMessage(paths.projectId, conversation.conversationId, userId)?.timestamp
      ?? new Date().toISOString();
    const delivery = new CanonicalTimelineDelivery(database, "agent");
    delivery.upsert(toCanonicalTimelineMessage(paths.projectId, conversation.conversationId, {
      id: userId,
      type: "user.message",
      timestamp,
      changeId: "",
      conversationId: conversation.conversationId,
      graphScopeId: conversation.currentGraphScopeId ?? undefined,
      text: request.text,
      status: "steering-sent",
      runId,
      providerId: request.providerId,
      agentSurfaceId: "main-agent",
    }));
    delivery.upsert(toCanonicalTimelineMessage(paths.projectId, conversation.conversationId, {
      id: ackId,
      type: "assistant.message",
      timestamp,
      changeId: "",
      conversationId: conversation.conversationId,
      graphScopeId: conversation.currentGraphScopeId ?? undefined,
      text: "已发送给当前执行。",
      status: "steering-sent",
      runId,
      providerId: request.providerId,
      agentSurfaceId: "main-agent",
    }));
  } finally {
    database.close();
  }
}

function requireExpectedUpdatedAt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))) return value;
  const error = new Error("Composer draft expectedUpdatedAt must be null or a valid timestamp.");
  error.name = "BadRequest";
  throw error;
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
