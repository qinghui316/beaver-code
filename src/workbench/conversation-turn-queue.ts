import { createHash } from "node:crypto";
import {
  defaultExecutionContractRegistry,
  defaultProviderRegistry,
  type AgentTurnMode,
  type ExecutionContractIdentity,
  type ExecutionContractRegistry,
  type ProductMode,
  type ProviderId,
  type ProviderRegistry,
  type ProviderReviewTarget,
} from "../provider-runtime/index.js";
import type { ProjectRuntimeCoordinatorPort } from "../project-runtime/coordinator.js";
import type { ProjectRuntimePaths } from "../project-runtime/paths.js";
import type { ManagedProject } from "../types/index.js";
import { postConversationMessage, prepareConversationMessage } from "./conversation-service.js";
import type { ConversationTurnRoutingPort } from "./conversation-turn-contract.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type {
  StoredConversationQueuedTurn,
  StoredConversationTurnQueueContractConfirmation,
} from "./persistence/contracts.js";
import { ComposerDraftConflictError } from "./persistence/repositories/composer-draft-repository.js";
import { publishConversationTurnQueueInvalidated } from "./project-live-events.js";
import type { TopicFileReference, TopicMessageInput } from "./types.js";
import { deleteUnreferencedTopicAttachments } from "./attachments.js";
import { createConversationExecutionRevision } from "./conversation-execution-revision.js";
import type { ConversationQueuedReviewDispatchPort } from "./conversation-queued-review-dispatch.js";

export interface ConversationQueuedTurnInput {
  itemKind?: "conversation-turn" | "review";
  reviewTarget?: ProviderReviewTarget | null;
  text: string;
  contextRefs: TopicFileReference[];
  attachmentIds: string[];
  skillOverrides: Record<string, boolean>;
  providerId: ProviderId;
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
}

export interface ConversationQueuedTurn extends ConversationQueuedTurnInput {
  itemKind: "conversation-turn" | "review";
  reviewTarget: ProviderReviewTarget | null;
  queueItemId: string;
  clientRequestId: string;
  position: number;
  status: StoredConversationQueuedTurn["status"];
  retryCount: number;
  diagnostic?: string;
  createdAt: string;
  updatedAt: string;
  executionCompatibility: ConversationQueueExecutionCompatibility;
}

export interface ConversationQueueExecutionContractRef {
  family: string;
  epoch: number;
}

export type ConversationQueueExecutionCompatibility =
  | { state: "compatible" }
  | {
      state: "confirmation-required" | "legacy-confirmation-required";
      created: ConversationQueueExecutionContractRef;
      target: ConversationQueueExecutionContractRef;
      summary: string;
    };

export interface ConversationTurnQueueSnapshot {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  revision: string;
  executionRevision: string | null;
  items: ConversationQueuedTurn[];
  canEnqueue: boolean;
  canDispatch: boolean;
  disabledReason?: string;
}

export interface ConversationTurnEnqueueRequest extends ConversationQueuedTurnInput {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  clientRequestId: string;
  expectedRevision: string;
  expectedExecutionRevision: string;
  expectedDraftUpdatedAt: string | null;
}

export interface ConversationTurnQueueContractConfirmationRequest {
  productMode: ProductMode;
  conversationId: string;
  queueItemId: string;
  expectedRevision: string;
  clientRequestId: string;
  expectedCreatedContract: ConversationQueueExecutionContractRef;
  expectedTargetContract: ConversationQueueExecutionContractRef;
}

export class ConversationTurnQueueOwner {
  private readonly dispatchPauses = new Set<symbol>();

  pauseDispatch(): () => void {
    const token = Symbol();
    this.dispatchPauses.add(token);
    return () => { this.dispatchPauses.delete(token); };
  }
  constructor(private readonly options: {
    projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve">;
    turnRouter: ConversationTurnRoutingPort;
    prepareConversationMessage?: typeof prepareConversationMessage;
    postConversationMessage?: typeof postConversationMessage;
    reviewDispatch?: ConversationQueuedReviewDispatchPort;
    providerRegistry?: Pick<ProviderRegistry, "get">;
    executionContractRegistry?: ExecutionContractRegistry;
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
      const publicItems = storedItems.map((item) => toPublicItem(
        item,
        this.executionCompatibility(database, item),
      ));
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
        canDispatch: Boolean(!this.dispatchPauses.size && head?.status === "queued" && head.executionCompatibility.state === "compatible" && !busy),
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
      throw conflict(before.disabledReason ?? "Conversation execution or queue changed before enqueue.");
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
          agentModelId: normalized.modelId,
          agentReasoningEffort: normalized.reasoningEffort,
          diagnostic: null,
          createdAt: now,
          updatedAt: now,
          dispatchedAt: null,
        },
      });
    } catch (error) {
      if (error instanceof ComposerDraftConflictError) throw error;
      throw error;
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
          const currentContract = this.resolveQueueExecutionContract(current);
          const compatible = this.executionCompatibility(database, current, currentContract).state === "compatible";
          database.conversationTurnQueues.transitionItem({
            projectId: paths.projectId,
            conversationId: item.conversationId,
            queueItemId: item.queueItemId,
            expectedStatus: "dispatching",
            status: hasEvidence ? "dispatched" : compatible ? "queued" : "blocked",
            diagnostic: hasEvidence || compatible ? null : "Queued execution requires confirmation.",
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
      if (item.itemKind === "review") {
        if (!this.options.reviewDispatch) throw conflict("Conversation Review queue dispatch is not composed.");
        const current = await this.read(project, productMode, conversationId);
        const database = await openProjectRuntimeWorkbenchDatabase(await this.resolvePaths(project));
        let timelineRevision: number;
        try {
          timelineRevision = database.conversations.readConversation(project.id, conversationId)?.timelineRevision ?? -1;
        } finally { database.close(); }
        await this.options.reviewDispatch.dispatchQueuedReview(project, {
          conversationId,
          providerId: item.providerId,
          target: parseReviewTarget(item.reviewTargetJson),
          expectedTimelineRevision: timelineRevision,
          expectedExecutionRevision: current.executionRevision,
          clientRequestId: item.dispatchRequestId,
        });
        await this.settleDispatch(project, item, "dispatched");
        return;
      }
      const message: TopicMessageInput = {
        message: item.text,
        contextRefs: parseArray<TopicFileReference>(item.contextRefsJson),
        attachmentIds: parseArray<string>(item.attachmentIdsJson),
        skillOverrides: Object.entries(parseRecord(item.skillOverridesJson))
          .map(([skillId, enabled]) => ({ skillId, enabled })),
        providerId: item.providerId,
        productMode: item.productMode,
        ...(item.productMode === "agent" ? { agentTurnMode: item.agentTurnMode ?? "default" } : {}),
        modelId: item.agentModelId,
        reasoningEffort: item.agentReasoningEffort,
        queuedTurnDispatch: {
          queueItemId: item.queueItemId,
          dispatchRequestId: item.dispatchRequestId,
          requestHash: item.requestHash,
        },
      };
      const prepare = this.options.prepareConversationMessage ?? prepareConversationMessage;
      const post = this.options.postConversationMessage ?? postConversationMessage;
      const prepared = await prepare(project, conversationId, message, { turnRouter: this.options.turnRouter });
      await post(project, conversationId, message, undefined, { turnRouter: this.options.turnRouter, prepared });
      await this.settleDispatch(project, item, "dispatched");
    } catch (cause) {
      if (await this.hasDispatchEvidence(project, item)) {
        await this.settleDispatch(project, item, "dispatched");
      } else if (isExplicitZeroSideEffectFailure(cause) && item.retryCount === 0) {
        const revision = await this.settleDispatch(project, item, "queued", 1, boundedDiagnostic(cause));
        const refreshed = await this.read(project, productMode, conversationId);
        if (refreshed.canDispatch && refreshed.items[0]?.queueItemId === item.queueItemId) {
          await this.dispatchHead(project, productMode, conversationId, item.queueItemId, revision);
        }
      } else if (isExplicitZeroSideEffectFailure(cause)) {
        await this.settleDispatch(project, item, "blocked", 1, boundedDiagnostic(cause));
      } else {
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
        if (this.dispatchPauses.size) return null;
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
    const provider = (this.options.providerRegistry ?? defaultProviderRegistry).get(input.providerId);
    return (this.options.executionContractRegistry ?? defaultExecutionContractRegistry).resolve({
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
  const modelId = normalizeNullableValue(request.modelId, "modelId");
  const reasoningEffort = normalizeNullableValue(request.reasoningEffort, "reasoningEffort");
  return {
    ...request,
    itemKind,
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
    providerId: item.providerId, agentTurnMode: item.agentTurnMode, modelId: item.agentModelId,
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
function hashQueuedInput(input: ConversationTurnEnqueueRequest): string { return digest(JSON.stringify({ version: 2, projectId: input.projectId, productMode: input.productMode, conversationId: input.conversationId, expectedRevision: input.expectedRevision, expectedExecutionRevision: input.expectedExecutionRevision, expectedDraftUpdatedAt: input.expectedDraftUpdatedAt, itemKind: input.itemKind, reviewTarget: input.reviewTarget, text: input.text, contextRefs: input.contextRefs, attachmentIds: input.attachmentIds, skillOverrides: input.skillOverrides, providerId: input.providerId, agentTurnMode: input.agentTurnMode, modelId: input.modelId, reasoningEffort: input.reasoningEffort })); }
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
function isExplicitZeroSideEffectFailure(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "BadRequest" || cause.name === "Conflict" || cause.name === "NotFound");
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
function badRequest(message: string): Error { const error = new Error(message); error.name = "BadRequest"; return error; }
