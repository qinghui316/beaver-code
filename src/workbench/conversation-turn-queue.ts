import { createHash } from "node:crypto";
import { parseAgentAccessMode } from "../provider-runtime/agent-access-policy.js";
import {
  type ExecutionContractIdentity,
  type ExecutionContractRegistry,
  type ProductMode,
  type ProviderRegistry,
  type ProviderReviewTarget,
} from "../provider-runtime/index.js";
import type { ProjectRuntimeCoordinatorPort } from "../project-runtime/coordinator.js";
import type { ProjectRuntimePaths } from "../project-runtime/paths.js";
import type { ManagedProject } from "../types/index.js";
import type { ConversationInputDeliveryPort } from "./conversation-input-delivery.js";
import type { ConversationTurnControlOwner } from "./conversation-turn-control.js";
import type { ConversationQueueGuideRequest, ConversationDeliveryOperation } from "./conversation-turn-queue-contract.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type {
  StoredConversationQueuedTurn,
  StoredConversationTurnQueueContractConfirmation,
} from "./persistence/contracts.js";
import { publishConversationTurnQueueInvalidated } from "./project-live-events.js";
import type { TopicFileReference } from "./types.js";
import { deleteUnreferencedTopicAttachments, resolveTopicAttachments } from "./attachments.js";
import { createConversationExecutionRevision } from "./conversation-execution-revision.js";

import type { ConversationQueuedTurn, ConversationQueueExecutionContractRef, ConversationQueueExecutionCompatibility, ConversationTurnQueueSnapshot, ConversationTurnEnqueueRequest, ConversationTurnQueueContractConfirmationRequest } from "./conversation-turn-queue-contract.js";
export type { ConversationQueuedTurnInput, ConversationQueuedTurn, ConversationQueueExecutionContractRef, ConversationQueueExecutionCompatibility, ConversationTurnQueueSnapshot, ConversationTurnEnqueueRequest, ConversationTurnQueueContractConfirmationRequest } from "./conversation-turn-queue-contract.js";

export class ConversationTurnQueueOwner {
  private readonly dispatchPauses = new Set<symbol>();

  pauseDispatch(): () => void {
    const token = Symbol();
    this.dispatchPauses.add(token);
    return () => { this.dispatchPauses.delete(token); };
  }
  constructor(private readonly options: {
    projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve">;
    delivery: ConversationInputDeliveryPort;
    turnControl?: Pick<ConversationTurnControlOwner, "state">;
    providerRegistry: Pick<ProviderRegistry, "get">;
    executionContractRegistry: ExecutionContractRegistry;
  }) {}

  async read(project: ManagedProject, productMode: ProductMode, conversationId: string): Promise<ConversationTurnQueueSnapshot> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    if (project.id !== paths.projectId) throw conflict("Conversation Turn queue project identity does not match the selected project.");
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, conversationId);
      if (!conversation || conversation.deletedAt || conversation.productMode !== productMode) throw conflict("Conversation Turn queue identity does not match an active Conversation.");
      const queue = database.conversationTurnQueues.readQueue(paths.projectId, conversation.conversationId);
      const storedItems = database.conversationTurnQueues.listItems(paths.projectId, conversation.conversationId);
      const activeAttempts = database.providerAttempts.listProviderAttempts(paths.projectId, conversation.conversationId)
        .filter((attempt) => attempt.graphScopeId === conversation.currentGraphScopeId
          && (attempt.status === "queued" || attempt.status === "running"));
      const pendingInteraction = hasPendingInteraction(database.timeline.listConversationMessages(paths.projectId, conversation.conversationId));
      const pendingFork = database.conversationForks.listIncomplete(paths.projectId)
        .some((operation) => operation.sourceConversationId === conversation.conversationId);
      const pendingCompaction = database.timeline.listConversationMessages(paths.projectId, conversation.conversationId)
        .some((row) => row.type === "provider.context-compaction"
          && (row.status === "submitting" || row.status === "compacting"));
      const pendingGovernanceDecision = conversation.productMode === "harness" && Boolean(conversation.boundChangeId)
        && database.decisions.listDecisions(paths.projectId, conversation.boundChangeId ?? undefined)
          .some((decision) => decision.status === "pending" || decision.status === "requested-changes");
      const executionRevision = createConversationExecutionRevision(conversation.currentGraphScopeId, conversation.completedTurnSequence, activeAttempts.map((item) => item.attemptId));
      const unsettled = database.conversationTurnQueues.unsettledDelivery(paths.projectId, conversationId);
      const controls = this.options.turnControl?.state(paths.projectId, conversationId);
      const target = activeAttempts.find((attempt) => attempt.roleId === "main-agent" && attempt.attemptId === controls?.attemptId);
      const guideBlocked = Boolean(this.dispatchPauses.size || pendingInteraction || pendingFork || pendingCompaction || pendingGovernanceDecision || unsettled || storedItems.some((item) => item.status === "dispatching") || conversation.state !== "active");
      const deliveries = database.conversationTurnQueues.listDeliveries(paths.projectId, conversationId);
      const publicItems: ConversationQueuedTurn[] = storedItems.filter((item) => !deliveries.some((op) => op.queueItemId === item.queueItemId && op.phase === "accepted")).map((item) => {
        const view = toPublicItem(item, this.executionCompatibility(database, item));
        const operation = deliveries.filter((op) => op.queueItemId === item.queueItemId).at(-1);
        const available = !guideBlocked && target && controls?.state === "running" && controls.steerState !== "submitting"
          && view.status === "queued" && view.executionCompatibility.state === "compatible";
        const compatibleText = target && item.itemKind !== "review" && item.text.trim() && item.contextRefsJson === "[]"
          && item.attachmentIdsJson === "[]" && item.skillOverridesJson === "{}"
          && item.providerId === target?.providerId && item.agentTurnMode === target.agentTurnMode
          && (item.agentModelId ?? target.model?.modelId ?? null) === (target.model?.modelId ?? null)
          && (item.agentReasoningEffort ?? target.reasoningEffort) === target.reasoningEffort
          && (productMode !== "agent" || item.agentAccessMode === (target.accessPolicy?.requestedAccess ?? "default"));
        return { ...view,
          guideMode: available && compatibleText && controls.canSteer ? "steer" as const
            : available && controls?.canInterrupt ? "cutover" as const : "unavailable" as const,
          guideDisabledReason: available ? undefined : "当前执行或待处理请求暂不允许引导",
          deliveryPhase: operation?.phase,
          deliveryUncertain: operation?.phase === "uncertain" || (item.status === "dispatching" && !operation),
        };
      });
      await Promise.all(publicItems.map(async (item) => {
        item.attachments = await Promise.all(item.attachmentIds.map(async (id) => {
          try {
            const [attachment] = await resolveTopicAttachments(project, [id], { workbenchRoot: paths.workbenchRoot });
            return { id, fileName: attachment!.fileName, ...(attachment!.kind === "image" && attachment!.mediaType !== "image/svg+xml"
              ? { previewUrl: `/api/projects/${encodeURIComponent(project.id)}/attachments/${encodeURIComponent(id)}/preview` } : {}) };
          } catch { return { id, fileName: "附件" }; }
        }));
      }));
      const head = publicItems[0];
      const busy = activeAttempts.length > 0 || pendingInteraction || pendingFork || pendingCompaction || pendingGovernanceDecision;
      const disabledReason = conversation.state !== "active"
        ? "Conversation is read-only."
        : storedItems.length >= 20
          ? "Conversation Turn queue already contains 20 items."
          : undefined;
      return {
        projectId: paths.projectId,
        productMode,
        conversationId: conversation.conversationId,
        revision: encodeRevision(queue?.revision ?? 0),
        executionRevision,
        items: publicItems,
        canEnqueue: !disabledReason,
        canDispatch: Boolean(!this.dispatchPauses.size && !unsettled && head?.status === "queued" && head.executionCompatibility.state === "compatible" && !busy),
        guideMode: controls?.canSteer ? "steer" : controls?.canInterrupt ? "cutover" : "unavailable",
        guideTarget: target ? { providerId: target.providerId, attemptId: target.attemptId } : undefined,
        ...(disabledReason ? { disabledReason } : {}),
      };
    } finally {
      database.close();
    }
  }

  async enqueue(project: ManagedProject, request: ConversationTurnEnqueueRequest): Promise<ConversationTurnQueueSnapshot> {
    const normalized = normalizeRequest(request);
    const replayRuntime = await this.options.projectRuntimeCoordinator.resolve(project);
    const replayPaths = replayRuntime.state === "onboarding" ? replayRuntime.paths : replayRuntime.resolution.paths;
    if (project.id !== replayPaths.projectId || normalized.projectId !== replayPaths.projectId) {
      throw conflict("Queued Turn project identity does not match the selected project.");
    }
    const replay = await this.readEnqueueReplay(project, normalized);
    if (replay) return replay;
    const before = await this.read(project, normalized.productMode, normalized.conversationId);
    if (!before.canEnqueue || before.revision !== normalized.expectedRevision
      || before.executionRevision !== normalized.expectedExecutionRevision) {
      throw unacceptedQueueAdmission(conflict(before.disabledReason ?? "Conversation execution or queue changed before enqueue."));
    }
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    if (normalized.projectId !== paths.projectId) throw conflict("Queued Turn project identity does not match the selected project.");
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, normalized.conversationId);
      if (!conversation || conversation.deletedAt || conversation.productMode !== normalized.productMode
        || (conversation.productMode === "agent" && conversation.selectedProviderId !== normalized.providerId)) {
        throw conflict("Queued Turn no longer matches the Conversation.");
      }
      const requestHash = hashQueuedInput(normalized);
      const executionContract = this.resolveQueueExecutionContract({
        productMode: normalized.productMode,
        providerId: normalized.providerId,
        itemKind: normalized.itemKind ?? "conversation-turn",
      });
      const now = new Date().toISOString();
      database.unitOfWork.enqueueConversationTurn({
        expectedQueueRevision: decodeRevision(normalized.expectedRevision),
        expectedExecutionRevision: normalized.expectedExecutionRevision,
        expectedDraftUpdatedAt: normalized.expectedDraftUpdatedAt,
        expectedAccessRevision: normalized.expectedAccessRevision,
        item: {
          projectId: paths.projectId,
          conversationId: conversation.conversationId,
          productMode: conversation.productMode,
          queueItemId: `queued-turn-${digest(`${conversation.conversationId}\0${normalized.clientRequestId}`)}`,
          clientRequestId: normalized.clientRequestId,
          requestHash,
          status: "queued",
          retryCount: 0,
          predecessorExecutionRevision: normalized.expectedExecutionRevision,
          executionContractFamily: executionContract.family,
          executionContractEpoch: executionContract.epoch,
          dispatchRequestId: `queue-dispatch-${digest(`${conversation.conversationId}\0${normalized.clientRequestId}\0${requestHash}`)}`,
          itemKind: normalized.itemKind ?? "conversation-turn",
          reviewTargetJson: normalized.reviewTarget ? JSON.stringify(normalized.reviewTarget) : null,
          text: normalized.text,
          contextRefsJson: JSON.stringify(normalized.contextRefs),
          attachmentIdsJson: JSON.stringify(normalized.attachmentIds),
          skillOverridesJson: JSON.stringify(normalized.skillOverrides),
          providerId: normalized.providerId,
          agentTurnMode: normalized.agentTurnMode,
          agentAccessMode: normalized.agentAccessMode ?? null,
          agentModelId: normalized.modelId,
          agentReasoningEffort: normalized.reasoningEffort,
          diagnostic: null,
          createdAt: now,
          updatedAt: now,
          dispatchedAt: null,
        },
      });
    } catch (error) {
      throw unacceptedQueueAdmission(error);
    } finally {
      database.close();
    }
    publishConversationTurnQueueInvalidated(project.id, { conversationId: normalized.conversationId });
    return this.read(project, normalized.productMode, normalized.conversationId);
  }

  async confirmExecutionContract(
    project: ManagedProject,
    request: ConversationTurnQueueContractConfirmationRequest,
  ): Promise<ConversationTurnQueueSnapshot> {
    const productMode = request.productMode;
    const conversationId = boundedId(request.conversationId, "conversationId");
    const queueItemId = boundedId(request.queueItemId, "queueItemId");
    const clientRequestId = boundedId(request.clientRequestId, "clientRequestId");
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    let changed = false;
    try {
      database.immediateTransaction(() => {
        const item = database.conversationTurnQueues.readItem(paths.projectId, conversationId, queueItemId);
        const queue = database.conversationTurnQueues.readQueue(paths.projectId, conversationId);
        const conversation = database.conversations.readConversation(paths.projectId, conversationId);
        if (!item || !queue || !conversation || conversation.productMode !== productMode
          || item.productMode !== productMode || !["queued", "blocked"].includes(item.status)) {
          throw conflict("Conversation queued Turn changed before execution confirmation.");
        }
        const target = this.resolveQueueExecutionContract(item);
        const requestHash = hashContractConfirmation({
          projectId: paths.projectId,
          productMode,
          conversationId,
          queueItemId,
          expectedRevision: request.expectedRevision,
          expectedCreatedContract: request.expectedCreatedContract,
          expectedTargetContract: request.expectedTargetContract,
        });
        const replay = database.conversationTurnQueues.readContractConfirmationByRequestId(
          paths.projectId,
          conversationId,
          clientRequestId,
        );
        if (replay) {
          if (replay.requestHash !== requestHash
            || !this.confirmationMatchesItem(replay, item, target)) {
            throw conflict("Queue confirmation clientRequestId was used for different content.");
          }
          return;
        }
        if (queue.revision !== decodeRevision(request.expectedRevision)
          || !sameContractRef(request.expectedCreatedContract, {
            family: item.executionContractFamily,
            epoch: item.executionContractEpoch,
          })
          || !sameContractRef(request.expectedTargetContract, target)) {
          throw conflict("Queued execution contract changed before confirmation.");
        }
        const existing = database.conversationTurnQueues.readContractConfirmation(
          paths.projectId,
          conversationId,
          queueItemId,
          target.family,
          target.epoch,
        );
        if (existing) {
          if (!this.confirmationMatchesItem(existing, item, target)) {
            throw conflict("Stored Queue execution confirmation is invalid.");
          }
          return;
        }
        const now = new Date().toISOString();
        database.conversationTurnQueues.insertContractConfirmation({
          projectId: paths.projectId,
          conversationId,
          queueItemId,
          priorFamily: item.executionContractFamily,
          priorEpoch: item.executionContractEpoch,
          targetFamily: target.family,
          targetEpoch: target.epoch,
          clientRequestId,
          expectedRevision: request.expectedRevision,
          requestHash,
          confirmedAt: now,
        });
        if (item.status === "blocked") {
          database.conversationTurnQueues.transitionItem({
            projectId: paths.projectId,
            conversationId,
            queueItemId,
            expectedStatus: "blocked",
            status: "queued",
            retryCount: 0,
            diagnostic: null,
            updatedAt: now,
          });
        }
        database.conversationTurnQueues.advanceRevision(paths.projectId, conversationId, queue.revision, now);
        changed = true;
      });
    } finally {
      database.close();
    }
    if (changed) publishConversationTurnQueueInvalidated(project.id, { conversationId });
    return this.read(project, productMode, conversationId);
  }

  async remove(project: ManagedProject, productMode: ProductMode, conversationId: string, queueItemId: string, expectedRevision: string): Promise<ConversationTurnQueueSnapshot> {
    const removed = await this.transitionActiveItem(project, productMode, conversationId, queueItemId, expectedRevision, "cancelled");
    await this.cleanupUnreferencedAttachments(project, parseArray<string>(removed.attachmentIdsJson));
    return this.read(project, productMode, conversationId);
  }

  async retry(project: ManagedProject, productMode: ProductMode, conversationId: string, queueItemId: string, expectedRevision: string): Promise<ConversationTurnQueueSnapshot> {
    await this.transitionActiveItem(project, productMode, conversationId, queueItemId, expectedRevision, "queued", "blocked", true);
    return this.read(project, productMode, conversationId);
  }

  async reclaim(project: ManagedProject, productMode: ProductMode, conversationId: string, queueItemId: string, expectedRevision: string, expectedDraftUpdatedAt: string | null): Promise<ConversationTurnQueueSnapshot> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, conversationId);
      if (!conversation || conversation.productMode !== productMode) throw conflict("Conversation Turn queue identity changed.");
      database.unitOfWork.reclaimConversationQueuedTurn({
        projectId: paths.projectId, conversationId, queueItemId,
        expectedQueueRevision: decodeRevision(expectedRevision), expectedDraftUpdatedAt,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      database.close();
    }
    publishConversationTurnQueueInvalidated(project.id, { conversationId });
    return this.read(project, productMode, conversationId);
  }

  async dispatchNext(project: ManagedProject, productMode: ProductMode, conversationId: string, expectedRevision: string): Promise<ConversationTurnQueueSnapshot> {
    const snapshot = await this.read(project, productMode, conversationId);
    if (snapshot.revision !== expectedRevision) throw conflict("Conversation Turn queue changed before dispatch.");
    if (!snapshot.canDispatch || !snapshot.items[0]) return snapshot;
    await this.dispatchHead(project, productMode, conversationId, snapshot.items[0].queueItemId, decodeRevision(expectedRevision));
    return this.read(project, productMode, conversationId);
  }

  async guide(project: ManagedProject, request: ConversationQueueGuideRequest): Promise<ConversationTurnQueueSnapshot> {
    if (!request.clientRequestId.trim() || request.clientRequestId.length > 200) throw badRequest("Guide requires a bounded request identity.");
    const hash = createHash("sha256").update(JSON.stringify({ projectId: project.id, productMode: request.productMode, conversationId: request.conversationId, queueItemId: request.queueItemId, expectedRevision: request.expectedRevision, expectedExecutionRevision: request.expectedExecutionRevision, providerId: request.providerId, expectedAttemptId: request.expectedAttemptId, clientRequestId: request.clientRequestId })).digest("hex");
    const paths = await this.resolvePaths(project);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    let claimed: StoredConversationQueuedTurn | null = null;
    let operation: ConversationDeliveryOperation | null = null;
    try {
      const existing = database.conversationTurnQueues.readDelivery(project.id, request.conversationId, request.clientRequestId);
      if (existing) {
        if (existing.requestHash !== hash) throw conflict("Guide request identity is bound to another input or execution.");
      } else {
        const snapshot = await this.read(project, request.productMode, request.conversationId);
        const selected = snapshot.items.find((item) => item.queueItemId === request.queueItemId);
        if (snapshot.revision !== request.expectedRevision || snapshot.executionRevision !== request.expectedExecutionRevision
          || snapshot.guideTarget?.attemptId !== request.expectedAttemptId || snapshot.guideTarget.providerId !== request.providerId
          || !selected || !selected.guideMode || selected.guideMode === "unavailable") throw unacceptedQueueAdmission(conflict("Guide target or queue changed before acceptance."));
        try { database.immediateTransaction(() => {
          const conversation = database.conversations.readConversation(project.id, request.conversationId);
          const queue = database.conversationTurnQueues.readQueue(project.id, request.conversationId);
          const item = database.conversationTurnQueues.readItem(project.id, request.conversationId, request.queueItemId);
          const attempts = database.providerAttempts.listProviderAttempts(project.id, request.conversationId).filter((attempt) =>
            attempt.graphScopeId === conversation?.currentGraphScopeId && (attempt.status === "queued" || attempt.status === "running"));
          const control = this.options.turnControl?.state(project.id, request.conversationId);
          if (this.dispatchPauses.size || !conversation || conversation.deletedAt || conversation.state !== "active"
            || conversation.productMode !== request.productMode || queue?.revision !== decodeRevision(request.expectedRevision)
            || createConversationExecutionRevision(conversation.currentGraphScopeId, conversation.completedTurnSequence, attempts.map((attempt) => attempt.attemptId)) !== request.expectedExecutionRevision
            || control?.attemptId !== request.expectedAttemptId || control.state !== "running" || control.steerState === "submitting"
            || (selected.guideMode === "steer" ? !control.canSteer : !control.canInterrupt)
            || !item || item.status !== "queued" || this.executionCompatibility(database, item).state !== "compatible"
            || database.conversationTurnQueues.unsettledDelivery(project.id, request.conversationId)
            || hasGuidanceBlockers(database, conversation)) throw conflict("Guide admission no longer matches the selected execution.");
          const now = new Date().toISOString();
          const deliveryOperation: ConversationDeliveryOperation = { projectId: project.id, conversationId: request.conversationId, productMode: request.productMode,
            clientRequestId: request.clientRequestId, queueItemId: request.queueItemId, requestHash: hash,
            mode: selected.guideMode === "steer" ? "steer" : "cutover", providerId: request.providerId, attemptId: request.expectedAttemptId,
            executionRevision: request.expectedExecutionRevision, phase: "claimed", messageId: null, diagnostic: null, createdAt: now, updatedAt: now };
          operation = deliveryOperation;
          database.conversationTurnQueues.insertDelivery(deliveryOperation);
          claimed = database.conversationTurnQueues.transitionItem({ projectId: project.id, conversationId: request.conversationId,
            queueItemId: request.queueItemId, expectedStatus: "queued", status: "dispatching", updatedAt: now });
          database.conversationTurnQueues.advanceRevision(project.id, request.conversationId, queue.revision, now);
        }); } catch (cause) { throw unacceptedQueueAdmission(cause); }
      }
    } finally { database.close(); }
    if (!claimed || !operation) return this.read(project, request.productMode, request.conversationId);
    const item: StoredConversationQueuedTurn = claimed;
    const claimedOperation: ConversationDeliveryOperation = operation;
    publishConversationTurnQueueInvalidated(project.id, { conversationId: request.conversationId });
    let failure: unknown;
    let finished = false;
    // The HTTP action settles on acceptance. The admitted turn continues under
    // the same Owner and durable operation until its normal execution terminal.
    const completion = (async () => {
      try {
        await this.options.delivery.guide(project, item, claimedOperation, (phase) => this.updateDelivery(project, claimedOperation, phase));
        await this.settleDispatch(project, item, "dispatched");
      } catch (cause) {
        if (await this.hasDispatchEvidence(project, item)) await this.settleDispatch(project, item, "dispatched");
        else if (isDefiniteRejection(cause)) await this.settleDispatch(project, item, "blocked", item.retryCount, boundedDiagnostic(cause));
        else { await this.updateDelivery(project, claimedOperation, "uncertain"); failure = uncertainDispatch(cause); }
      } finally {
        finished = true;
        publishConversationTurnQueueInvalidated(project.id, { conversationId: request.conversationId });
      }
    })().catch((cause) => { failure = cause; finished = true; });
    while (!finished) {
      const db = await openProjectRuntimeWorkbenchDatabase(paths);
      let phase: ConversationDeliveryOperation["phase"] | undefined;
      try { phase = db.conversationTurnQueues.readDelivery(project.id, request.conversationId, request.clientRequestId)?.phase; }
      finally { db.close(); }
      if (phase === "accepted") return this.read(project, request.productMode, request.conversationId);
      await Promise.race([completion, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    }
    if (failure) throw failure;
    return this.read(project, request.productMode, request.conversationId);
  }

  private async deliverClaimed(project: ManagedProject, item: StoredConversationQueuedTurn): Promise<void> {
    const database = await openProjectRuntimeWorkbenchDatabase(await this.resolvePaths(project));
    let operation: ConversationDeliveryOperation;
    let timelineRevision: number;
    try {
      operation = database.conversationTurnQueues.unsettledDelivery(project.id, item.conversationId)!;
      timelineRevision = database.conversations.readConversation(project.id, item.conversationId)?.timelineRevision ?? -1;
    } finally { database.close(); }
    await this.options.delivery.dispatch(project, item, { timelineRevision, executionRevision: operation.executionRevision }, () => this.updateDelivery(project, operation, "invoking"));
  }

  private async updateDelivery(project: ManagedProject, operation: ConversationDeliveryOperation, phase: ConversationDeliveryOperation["phase"]): Promise<void> {
    const database = await openProjectRuntimeWorkbenchDatabase(await this.resolvePaths(project));
    try {
      const current = database.conversationTurnQueues.readDelivery(project.id, operation.conversationId, operation.clientRequestId);
      if (!current || current.requestHash !== operation.requestHash) throw conflict("Delivery identity changed.");
      database.conversationTurnQueues.transitionDelivery(current, phase);
    } finally { database.close(); }
    publishConversationTurnQueueInvalidated(project.id, { conversationId: operation.conversationId });
  }

  async reconcileProject(paths: ProjectRuntimePaths): Promise<number> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    const invalidated = new Set<string>();
    let reconciled = 0;
    try {
      for (const item of database.conversationTurnQueues.listDispatching(paths.projectId)) {
        const hasEvidence = item.itemKind === "review"
          ? Boolean(database.conversationReviews.read(paths.projectId, item.dispatchRequestId))
          : hasStoredDispatchEvidence(
            database.timeline.listConversationMessages(paths.projectId, item.conversationId),
            item,
          );
        database.transaction(() => {
          const current = database.conversationTurnQueues.readItem(paths.projectId, item.conversationId, item.queueItemId);
          const queue = database.conversationTurnQueues.readQueue(paths.projectId, item.conversationId);
          if (!current || current.status !== "dispatching" || !queue) return;
          const now = new Date().toISOString();
          const operation = database.conversationTurnQueues.listDeliveries(paths.projectId, item.conversationId).filter((candidate) => candidate.queueItemId === item.queueItemId).at(-1);
          const neverInvoked = operation?.phase === "claimed" || (operation?.mode === "cutover" && operation.phase === "waiting-terminal");
          if (operation && operation.phase !== "completed" && operation.phase !== "rejected") {
            database.conversationTurnQueues.transitionDelivery(operation, hasEvidence ? "completed" : neverInvoked ? "rejected" : "uncertain");
          }
          database.conversationTurnQueues.transitionItem({
            projectId: paths.projectId,
            conversationId: item.conversationId,
            queueItemId: item.queueItemId,
            expectedStatus: "dispatching",
            status: hasEvidence ? "dispatched" : neverInvoked ? "queued" : "dispatching",
            diagnostic: hasEvidence || neverInvoked ? null : "Delivery outcome needs confirmation; automatic replay is disabled.",
            updatedAt: now,
            dispatchedAt: hasEvidence ? now : null,
          });
          database.conversationTurnQueues.advanceRevision(paths.projectId, item.conversationId, queue.revision, now);
          invalidated.add(item.conversationId);
          reconciled += 1;
        });
      }
    } finally {
      database.close();
    }
    for (const conversationId of invalidated) {
      publishConversationTurnQueueInvalidated(paths.projectId, { conversationId });
    }
    return reconciled;
  }

  private async dispatchHead(project: ManagedProject, productMode: ProductMode, conversationId: string, queueItemId: string, expectedRevision: number): Promise<void> {
    const item = await this.claim(project, productMode, conversationId, queueItemId, expectedRevision);
    if (!item) return;
    publishConversationTurnQueueInvalidated(project.id, { conversationId });
    try {
      await this.deliverClaimed(project, item);
      await this.settleDispatch(project, item, "dispatched");
    } catch (cause) {
      if (await this.hasDispatchEvidence(project, item)) {
        await this.settleDispatch(project, item, "dispatched");
      } else if (isDefiniteRejection(cause) && item.retryCount === 0) {
        const revision = await this.settleDispatch(project, item, "queued", 1, boundedDiagnostic(cause));
        const refreshed = await this.read(project, productMode, conversationId);
        if (refreshed.canDispatch && refreshed.items[0]?.queueItemId === item.queueItemId) {
          await this.dispatchHead(project, productMode, conversationId, item.queueItemId, revision);
        }
      } else if (isDefiniteRejection(cause)) {
        await this.settleDispatch(project, item, "blocked", 1, boundedDiagnostic(cause));
      } else {
        const db = await openProjectRuntimeWorkbenchDatabase(await this.resolvePaths(project));
        try {
          const op = db.conversationTurnQueues.unsettledDelivery(project.id, conversationId);
          if (op) db.conversationTurnQueues.transitionDelivery(op, "uncertain", null, boundedDiagnostic(cause));
        } finally { db.close(); }
        throw uncertainDispatch(cause);
      }
    } finally {
      publishConversationTurnQueueInvalidated(project.id, { conversationId });
    }
  }

  private async claim(project: ManagedProject, productMode: ProductMode, conversationId: string, queueItemId: string, expectedRevision: number): Promise<StoredConversationQueuedTurn | null> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      return database.immediateTransaction(() => {
        if (this.dispatchPauses.size || database.conversationTurnQueues.unsettledDelivery(paths.projectId, conversationId)) return null;
        const conversation = database.conversations.readConversation(paths.projectId, conversationId);
        const queue = database.conversationTurnQueues.readQueue(paths.projectId, conversationId);
        const head = database.conversationTurnQueues.listItems(paths.projectId, conversationId)[0];
        const activeAttempts = database.providerAttempts.listProviderAttempts(paths.projectId, conversationId)
          .filter((attempt) => attempt.graphScopeId === conversation?.currentGraphScopeId
            && (attempt.status === "queued" || attempt.status === "running"));
        const rows = database.timeline.listConversationMessages(paths.projectId, conversationId);
        const busy = activeAttempts.length > 0
          || hasPendingInteraction(rows)
          || database.conversationForks.listIncomplete(paths.projectId)
            .some((operation) => operation.sourceConversationId === conversationId)
          || rows.some((row) => row.type === "provider.context-compaction"
            && (row.status === "submitting" || row.status === "compacting"))
          || Boolean(conversation?.productMode === "harness" && conversation.boundChangeId
            && database.decisions.listDecisions(paths.projectId, conversation.boundChangeId)
              .some((decision) => decision.status === "pending" || decision.status === "requested-changes"));
        if (!conversation || conversation.deletedAt || conversation.state !== "active"
          || conversation.productMode !== productMode || busy
          || !queue || queue.revision !== expectedRevision || head?.queueItemId !== queueItemId
          || head.status !== "queued" || head.productMode !== productMode
          || (productMode === "agent" && head.providerId !== conversation.selectedProviderId)) {
          throw conflict("Conversation queued Turn is no longer the dispatchable FIFO head.");
        }
        const currentContract = this.resolveQueueExecutionContract(head);
        if (this.executionCompatibility(database, head, currentContract).state !== "compatible") {
          const blocked = database.conversationTurnQueues.transitionItem({
            projectId: paths.projectId, conversationId, queueItemId,
            expectedStatus: "queued", status: "blocked",
            diagnostic: "Queued execution requires confirmation.",
            updatedAt: new Date().toISOString(),
          });
          database.conversationTurnQueues.advanceRevision(paths.projectId, conversationId, queue.revision, blocked.updatedAt);
          return null;
        }
        const claimed = database.conversationTurnQueues.transitionItem({
          projectId: paths.projectId, conversationId, queueItemId,
          expectedStatus: "queued", status: "dispatching", updatedAt: new Date().toISOString(),
        });
        const previous = database.conversationTurnQueues.readDelivery(paths.projectId, conversationId, claimed.dispatchRequestId);
        if (previous?.phase === "rejected") database.conversationTurnQueues.transitionDelivery(previous, "claimed");
        else database.conversationTurnQueues.insertDelivery({
          projectId: paths.projectId, productMode, conversationId, clientRequestId: claimed.dispatchRequestId,
          queueItemId, requestHash: claimed.requestHash, mode: "next-turn", providerId: claimed.providerId,
          attemptId: null, executionRevision: createConversationExecutionRevision(conversation.currentGraphScopeId, conversation.completedTurnSequence, []),
          phase: "claimed", messageId: null, diagnostic: null, createdAt: claimed.updatedAt, updatedAt: claimed.updatedAt,
        });
        database.conversationTurnQueues.advanceRevision(paths.projectId, conversationId, queue.revision, claimed.updatedAt);
        return claimed;
      });
    } finally {
      database.close();
    }
  }

  private async settleDispatch(project: ManagedProject, item: StoredConversationQueuedTurn, status: "queued" | "blocked" | "dispatched", retryCount = item.retryCount, diagnostic?: string): Promise<number> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      return database.transaction(() => {
        const queue = database.conversationTurnQueues.readQueue(paths.projectId, item.conversationId)!;
        const operation = database.conversationTurnQueues.unsettledDelivery(paths.projectId, item.conversationId);
        if (operation?.queueItemId === item.queueItemId) database.conversationTurnQueues.transitionDelivery(operation, status === "dispatched" ? "completed" : "rejected");
        const settled = database.conversationTurnQueues.transitionItem({
          projectId: paths.projectId, conversationId: item.conversationId, queueItemId: item.queueItemId,
          expectedStatus: "dispatching", status, retryCount, diagnostic: diagnostic ?? null,
          updatedAt: new Date().toISOString(), dispatchedAt: status === "dispatched" ? new Date().toISOString() : null,
        });
        return database.conversationTurnQueues.advanceRevision(paths.projectId, item.conversationId, queue.revision, settled.updatedAt).revision;
      });
    } finally {
      database.close();
    }
  }

  private async transitionActiveItem(
    project: ManagedProject,
    productMode: ProductMode,
    conversationId: string,
    queueItemId: string,
    expectedRevision: string,
    status: "queued" | "cancelled",
    requiredStatus?: "blocked",
    requireCompatibleExecution = false,
  ): Promise<StoredConversationQueuedTurn> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    let transitioned!: StoredConversationQueuedTurn;
    try {
      transitioned = database.transaction(() => {
        const conversation = database.conversations.readConversation(paths.projectId, conversationId);
        const queue = database.conversationTurnQueues.readQueue(paths.projectId, conversationId);
        const item = database.conversationTurnQueues.readItem(paths.projectId, conversationId, queueItemId);
        if (!conversation || conversation.productMode !== productMode || !queue || queue.revision !== decodeRevision(expectedRevision)
          || !item || item.productMode !== productMode || (requiredStatus ? item.status !== requiredStatus : !["queued", "blocked"].includes(item.status))) {
          throw conflict("Conversation queued Turn changed before the requested action.");
        }
        if (requireCompatibleExecution && this.executionCompatibility(database, item).state !== "compatible") {
          throw conflict("Queued execution requires confirmation.");
        }
        const changed = database.conversationTurnQueues.transitionItem({
          projectId: paths.projectId, conversationId, queueItemId,
          expectedStatus: item.status, status, retryCount: status === "queued" ? 0 : item.retryCount,
          diagnostic: null, updatedAt: new Date().toISOString(),
        });
        database.conversationTurnQueues.advanceRevision(paths.projectId, conversationId, queue.revision, changed.updatedAt);
        return changed;
      });
    } finally {
      database.close();
    }
    publishConversationTurnQueueInvalidated(project.id, { conversationId });
    return transitioned;
  }

  private async cleanupUnreferencedAttachments(project: ManagedProject, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    await deleteUnreferencedTopicAttachments(project, attachmentIds, paths);
  }

  private async hasDispatchEvidence(project: ManagedProject, item: StoredConversationQueuedTurn): Promise<boolean> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      if (item.itemKind === "review") {
        return Boolean(database.conversationReviews.read(paths.projectId, item.dispatchRequestId));
      }
      return hasStoredDispatchEvidence(
        database.timeline.listConversationMessages(paths.projectId, item.conversationId),
        item,
      );
    } finally { database.close(); }
  }

  private async resolvePaths(project: ManagedProject): Promise<ProjectRuntimePaths> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    return runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
  }

  private resolveQueueExecutionContract(input: {
    productMode: ProductMode;
    providerId: string;
    itemKind: "conversation-turn" | "review";
  }): ExecutionContractIdentity {
    const provider = this.options.providerRegistry.get(input.providerId);
    return this.options.executionContractRegistry.resolve({
      productMode: input.productMode,
      operationProfile: input.productMode === "agent" ? "agent" : "main",
      operationKind: input.itemKind,
      roleId: "main-agent",
      providerAdapterVersion: provider.adapter.version,
    });
  }

  private executionCompatibility(
    database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
    item: StoredConversationQueuedTurn,
    target = this.resolveQueueExecutionContract(item),
  ): ConversationQueueExecutionCompatibility {
    const created = {
      family: item.executionContractFamily,
      epoch: item.executionContractEpoch,
    };
    const confirmation = database.conversationTurnQueues.readContractConfirmation(
        item.projectId,
        item.conversationId,
        item.queueItemId,
        target.family,
        target.epoch,
      );
    if (sameContractRef(created, target)
      || (confirmation && this.confirmationMatchesItem(confirmation, item, target))) {
      return { state: "compatible" };
    }
    return {
      state: item.executionContractFamily === "legacy-v0"
        ? "legacy-confirmation-required"
        : "confirmation-required",
      created,
      target: { family: target.family, epoch: target.epoch },
      summary: "执行方式已更新，需要确认后发送",
    };
  }

  private confirmationMatchesItem(
    confirmation: StoredConversationTurnQueueContractConfirmation,
    item: StoredConversationQueuedTurn,
    target: ExecutionContractIdentity,
  ): boolean {
    const created = {
      family: item.executionContractFamily,
      epoch: item.executionContractEpoch,
    };
    if (confirmation.projectId !== item.projectId
      || confirmation.conversationId !== item.conversationId
      || confirmation.queueItemId !== item.queueItemId
      || !sameContractRef(created, {
        family: confirmation.priorFamily,
        epoch: confirmation.priorEpoch,
      })
      || !sameContractRef(target, {
        family: confirmation.targetFamily,
        epoch: confirmation.targetEpoch,
      })) {
      return false;
    }
    try {
      decodeRevision(confirmation.expectedRevision);
    } catch {
      return false;
    }
    return confirmation.requestHash === hashContractConfirmation({
      projectId: item.projectId,
      productMode: item.productMode,
      conversationId: item.conversationId,
      queueItemId: item.queueItemId,
      expectedRevision: confirmation.expectedRevision,
      expectedCreatedContract: created,
      expectedTargetContract: {
        family: target.family,
        epoch: target.epoch,
      },
    });
  }

  private async readEnqueueReplay(
    project: ManagedProject,
    request: ConversationTurnEnqueueRequest,
  ): Promise<ConversationTurnQueueSnapshot | null> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const existing = database.conversationTurnQueues.readByClientRequestId(
        paths.projectId,
        request.conversationId,
        request.clientRequestId,
      );
      if (!existing) return null;
      if (existing.productMode !== request.productMode || existing.requestHash !== hashQueuedInput(request)) {
        throw conflict("Queue clientRequestId was used for different content.");
      }
    } finally {
      database.close();
    }
    return this.read(project, request.productMode, request.conversationId);
  }

}

function normalizeRequest(request: ConversationTurnEnqueueRequest): ConversationTurnEnqueueRequest {
  if (request.productMode !== "agent" && request.productMode !== "harness") throw badRequest("Queued Turn productMode is invalid.");
  const projectId = boundedId(request.projectId, "projectId");
  const conversationId = boundedId(request.conversationId, "conversationId");
  const clientRequestId = boundedId(request.clientRequestId, "clientRequestId");
  const providerId = boundedId(request.providerId, "providerId");
  const itemKind = request.itemKind === "review" ? "review" : "conversation-turn";
  const text = typeof request.text === "string" ? request.text.trim() : "";
  if (text.length > 100_000) throw badRequest("Queued Turn text is too large.");
  if (!Array.isArray(request.attachmentIds) || request.attachmentIds.length > 100) throw badRequest("Queued Turn attachmentIds are invalid.");
  const attachmentIds = [...new Set(request.attachmentIds.map((item) => boundedAttachmentId(item)))];
  if (!Array.isArray(request.contextRefs) || request.contextRefs.length > 100) throw badRequest("Queued Turn contextRefs are invalid.");
  const contextRefs = request.contextRefs.map(normalizeContextRef);
  if (!request.skillOverrides || typeof request.skillOverrides !== "object" || Array.isArray(request.skillOverrides)) throw badRequest("Queued Turn Skill overrides are invalid.");
  const skillEntries = Object.entries(request.skillOverrides);
  if (skillEntries.length > 100 || skillEntries.some(([skillId, enabled]) => !skillId.trim() || typeof enabled !== "boolean")) {
    throw badRequest("Queued Turn Skill overrides are invalid.");
  }
  const expectedExecutionRevision = typeof request.expectedExecutionRevision === "string" ? request.expectedExecutionRevision.trim() : "";
  const reviewTarget = itemKind === "review" ? normalizeReviewTarget(request.reviewTarget) : null;
  if ((itemKind === "conversation-turn" && !text && attachmentIds.length === 0) || !expectedExecutionRevision) throw badRequest("Queued Turn requires content and exact request/execution identity.");
  if (itemKind === "review" && (request.productMode !== "agent" || text || attachmentIds.length > 0 || contextRefs.length > 0 || skillEntries.length > 0)) {
    throw conflict("Queued Review is Agent-only and cannot carry Turn draft content.");
  }
  decodeRevision(request.expectedRevision);
  if (itemKind === "conversation-turn" && request.productMode === "agent" && request.agentTurnMode !== "default" && request.agentTurnMode !== "plan") throw conflict("Agent queued Turn requires Default or Plan mode.");
  if (itemKind === "review" && (request.agentTurnMode !== null || request.modelId !== null || request.reasoningEffort !== null)) throw conflict("Queued Review cannot carry Agent Turn settings.");
  if (request.productMode === "harness" && request.agentTurnMode !== null) throw conflict("Harness queued Turn cannot carry Agent Turn mode.");
  if ((request.productMode !== "agent" || itemKind === "review")
    && (request.agentAccessMode != null || request.expectedAccessRevision !== undefined)) throw conflict("This queue item cannot carry Agent access settings.");
  const agentAccessMode = request.productMode === "agent" && itemKind === "conversation-turn"
    ? parseAgentAccessMode(request.agentAccessMode) : null;
  if ((request.agentAccessMode != null || request.expectedAccessRevision !== undefined)
    && (!Number.isSafeInteger(request.expectedAccessRevision) || request.expectedAccessRevision! < 0)) throw conflict("Queued access requires the current revision.");
  const modelId = normalizeNullableValue(request.modelId, "modelId");
  const reasoningEffort = normalizeNullableValue(request.reasoningEffort, "reasoningEffort");
  return {
    ...request,
    itemKind,
    agentAccessMode,
    reviewTarget,
    projectId,
    conversationId,
    clientRequestId,
    providerId,
    text,
    attachmentIds,
    contextRefs,
    expectedExecutionRevision,
    modelId,
    reasoningEffort,
    skillOverrides: Object.fromEntries(skillEntries
      .map(([id, enabled]): [string, boolean] => [id.trim(), enabled])
      .sort(([a], [b]) => a.localeCompare(b))),
  };
}

function boundedId(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) throw badRequest(`Queued Turn ${field} is invalid.`);
  return normalized;
}

function boundedAttachmentId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw badRequest("Queued Turn attachmentId is invalid.");
  return normalized;
}

function normalizeContextRef(value: TopicFileReference): TopicFileReference {
  if (!value || typeof value !== "object") throw badRequest("Queued Turn contextRef is invalid.");
  const relativePath = typeof value.relativePath === "string" ? value.relativePath.trim().replaceAll("\\", "/") : "";
  const segments = relativePath.split("/");
  if (!relativePath || relativePath.length > 1024 || relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)
    || segments.some((segment) => !segment || segment === "." || segment === "..")) throw badRequest("Queued Turn contextRef must be project-relative.");
  if (value.kind !== "file" && value.kind !== "directory") throw badRequest("Queued Turn contextRef kind is invalid.");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 255) throw badRequest("Queued Turn contextRef name is invalid.");
  if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) throw badRequest("Queued Turn contextRef size is invalid.");
  return { ...value, relativePath, name, source: "composer" };
}

function normalizeNullableValue(value: unknown, field: string): string | null {
  if (value === null) return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512) throw badRequest(`Queued Turn ${field} is invalid.`);
  return normalized;
}

function toPublicItem(
  item: StoredConversationQueuedTurn,
  executionCompatibility: ConversationQueueExecutionCompatibility,
): ConversationQueuedTurn {
  return {
    itemKind: item.itemKind, reviewTarget: item.reviewTargetJson ? parseReviewTarget(item.reviewTargetJson) : null,
    queueItemId: item.queueItemId, clientRequestId: item.clientRequestId, position: item.position,
    status: item.status, retryCount: item.retryCount, text: item.text,
    contextRefs: parseArray<TopicFileReference>(item.contextRefsJson),
    attachmentIds: parseArray<string>(item.attachmentIdsJson), skillOverrides: parseRecord(item.skillOverridesJson),
    providerId: item.providerId, agentTurnMode: item.agentTurnMode, agentAccessMode: item.agentAccessMode ?? null, modelId: item.agentModelId,
    reasoningEffort: item.agentReasoningEffort, ...(item.diagnostic ? { diagnostic: item.diagnostic } : {}),
    createdAt: item.createdAt, updatedAt: item.updatedAt,
    executionCompatibility,
  };
}

function encodeRevision(value: number): string { return `queue:${value}`; }
function decodeRevision(value: string): number {
  const match = /^queue:(\d+)$/.exec(value);
  if (!match) throw badRequest("Queue revision is invalid.");
  return Number(match[1]);
}
function hashQueuedInput(input: ConversationTurnEnqueueRequest): string { return digest(JSON.stringify({ version: 2, ...(input.agentAccessMode === "full-access" ? { agentAccessMode: "full-access" } : {}), projectId: input.projectId, productMode: input.productMode, conversationId: input.conversationId, expectedRevision: input.expectedRevision, expectedExecutionRevision: input.expectedExecutionRevision, expectedDraftUpdatedAt: input.expectedDraftUpdatedAt, itemKind: input.itemKind, reviewTarget: input.reviewTarget, text: input.text, contextRefs: input.contextRefs, attachmentIds: input.attachmentIds, skillOverrides: input.skillOverrides, providerId: input.providerId, agentTurnMode: input.agentTurnMode, modelId: input.modelId, reasoningEffort: input.reasoningEffort })); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameContractRef(
  left: ConversationQueueExecutionContractRef,
  right: ConversationQueueExecutionContractRef,
): boolean {
  return left.family === right.family && left.epoch === right.epoch;
}
function hashContractConfirmation(input: {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  queueItemId: string;
  expectedRevision: string;
  expectedCreatedContract: ConversationQueueExecutionContractRef;
  expectedTargetContract: ConversationQueueExecutionContractRef;
}): string {
  return digest(JSON.stringify({ version: 1, ...input }));
}
function parseArray<T>(value: string): T[] { try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; } }
function parseRecord(value: string): Record<string, boolean> { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) : {}; } catch { return {}; } }
function normalizeReviewTarget(value: unknown): ProviderReviewTarget {
  if (!value || typeof value !== "object") throw badRequest("Queued Review target is invalid.");
  const target = value as Partial<ProviderReviewTarget>;
  if (target.type === "uncommitted-changes") return { type: target.type };
  if (target.type === "base-branch" && "branch" in target && typeof target.branch === "string") {
    const branch = target.branch.trim();
    if (branch && branch.length <= 512) return { type: target.type, branch };
  }
  if (target.type === "commit" && "sha" in target && typeof target.sha === "string") {
    const sha = target.sha.trim();
    const title = "title" in target && typeof target.title === "string" ? target.title.trim() : "";
    if (sha && sha.length <= 512 && title.length <= 500) {
      return { type: target.type, sha, ...(title ? { title } : {}) };
    }
  }
  if (target.type === "custom" && "instructions" in target && typeof target.instructions === "string") {
    const instructions = target.instructions.trim();
    if (instructions && instructions.length <= 100_000) return { type: target.type, instructions };
  }
  throw badRequest("Queued Review target is invalid.");
}
function parseReviewTarget(value: string | null): ProviderReviewTarget {
  try { return normalizeReviewTarget(value ? JSON.parse(value) : null); } catch (cause) { if (cause instanceof Error && cause.name === "BadRequest") throw cause; throw badRequest("Queued Review target is invalid."); }
}
function hasPendingInteraction(rows: Array<{ rawJson: string }>): boolean { return rows.some((row) => { try { const raw = JSON.parse(row.rawJson) as { providerUserInput?: { status?: string }; providerApproval?: { status?: string }; clarification?: { status?: string } }; return [raw.providerUserInput?.status, raw.providerApproval?.status, raw.clarification?.status].some((status) => status === "pending" || status === "submitting"); } catch { return false; } }); }

function isDefiniteRejection(cause: unknown): boolean {
  return cause instanceof Error && "inputNotInvoked" in cause && cause.inputNotInvoked === true;
}

function hasGuidanceBlockers(database: import("./persistence/database.js").WorkbenchDatabase, conversation: import("./persistence/contracts.js").StoredConversation): boolean {
  const rows = database.timeline.listConversationMessages(conversation.projectId, conversation.conversationId);
  return hasPendingInteraction(rows)
    || rows.some((row) => row.type === "provider.context-compaction" && (row.status === "submitting" || row.status === "compacting"))
    || database.conversationForks.listIncomplete(conversation.projectId).some((op) => op.sourceConversationId === conversation.conversationId)
    || Boolean(conversation.productMode === "harness" && conversation.boundChangeId
      && database.decisions.listDecisions(conversation.projectId, conversation.boundChangeId).some((decision) => decision.status === "pending" || decision.status === "requested-changes"));
}
function hasStoredDispatchEvidence(rows: Array<{ rawJson: string }>, item: StoredConversationQueuedTurn): boolean {
  return rows.some((row) => {
    try {
      const raw = JSON.parse(row.rawJson) as { queuedTurnDispatch?: { dispatchRequestId?: string; requestHash?: string } };
      return raw.queuedTurnDispatch?.dispatchRequestId === item.dispatchRequestId
        && raw.queuedTurnDispatch.requestHash === item.requestHash;
    } catch {
      return false;
    }
  });
}
function uncertainDispatch(cause: unknown): Error {
  const error = new Error("Queued Turn dispatch outcome is uncertain and will not be sent again automatically.", { cause });
  error.name = "ConversationTurnQueueDispatchUncertain";
  return error;
}
function boundedDiagnostic(cause: unknown): string {
  if (!(cause instanceof Error)) return "Queued Turn dispatch was rejected before execution.";
  if (cause.name === "BadRequest") return "Queued Turn content is no longer valid for dispatch.";
  if (cause.name === "NotFound") return "A queued Turn dependency is no longer available.";
  return "Conversation state changed before the queued Turn could be dispatched.";
}
function conflict(message: string): Error { const error = new Error(message); error.name = "Conflict"; return error; }
function unacceptedQueueAdmission(cause: unknown): unknown {
  // Only explicit admission conflicts prove rejection. Storage/commit failures stay uncertain.
  return cause instanceof Error && cause.name === "Conflict"
    ? Object.assign(cause, { queueAdmissionRejected: true as const }) : cause;
}
function badRequest(message: string): Error { const error = new Error(message); error.name = "BadRequest"; return error; }
