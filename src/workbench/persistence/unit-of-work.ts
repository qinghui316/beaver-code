import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentTurnMode, ProductMode, ProviderId } from "../../provider-runtime/index.js";
import { agentThreadSurfaceId } from "../../provider-runtime/agent-surface-id.js";
import type {
  StoredConversation,
  StoredConversationProviderBinding,
  StoredConversationQueuedTurn,
  StoredConversationTurnQueue,
  StoredProviderAttempt,
  StoredProviderResumePoint,
  StoredTopicMessage,
  StoredTopicMessageWrite,
} from "./contracts.js";
import type { ConversationRepository } from "./repositories/conversation-repository.js";
import type { InteractionRepository } from "./repositories/interaction-repository.js";
import type { ProviderAttemptRepository } from "./repositories/provider-attempt-repository.js";
import type { TimelineRepository } from "./repositories/timeline-repository.js";
import type { SkillRepository } from "./repositories/skill-repository.js";
import { ComposerDraftConflictError, type ComposerDraftRepository } from "./repositories/composer-draft-repository.js";
import type { ConversationTurnQueueRepository } from "./repositories/conversation-turn-queue-repository.js";
import type { ConversationReviewRepository } from "./repositories/conversation-review-repository.js";
import type { ConversationQueuedTurnDispatchEvidence } from "../types.js";

export class WorkbenchUnitOfWork {
  constructor(
    private readonly db: Database.Database,
    private readonly timeline: TimelineRepository,
    private readonly conversations: ConversationRepository,
    private readonly providerAttempts: ProviderAttemptRepository,
    private readonly interactions: InteractionRepository,
    private readonly skills: SkillRepository,
    private readonly drafts: ComposerDraftRepository,
    private readonly conversationTurnQueues: ConversationTurnQueueRepository,
    private readonly conversationReviews: ConversationReviewRepository,
  ) {}

  enqueueConversationTurn(input: {
    item: Omit<StoredConversationQueuedTurn, "position">;
    expectedQueueRevision: number;
    expectedExecutionRevision: string;
    expectedDraftUpdatedAt: string | null;
  }): { queue: StoredConversationTurnQueue; item: StoredConversationQueuedTurn } {
    return this.db.transaction(() => {
      const existing = this.conversationTurnQueues.readByClientRequestId(
        input.item.projectId,
        input.item.conversationId,
        input.item.clientRequestId,
      );
      if (existing) {
        if (existing.requestHash !== input.item.requestHash) throw conflict("Queue clientRequestId was used for different content.");
        return {
          queue: this.conversationTurnQueues.readQueue(input.item.projectId, input.item.conversationId)!,
          item: existing,
        };
      }
      const queue = this.conversationTurnQueues.ensureQueue({
        projectId: input.item.projectId,
        conversationId: input.item.conversationId,
        productMode: input.item.productMode,
        updatedAt: input.item.updatedAt,
      });
      if (queue.revision !== input.expectedQueueRevision) throw conflict("Conversation Turn queue changed in another window.");
      const conversation = this.conversations.readConversation(input.item.projectId, input.item.conversationId);
      const activeAttemptIds = this.providerAttempts.listProviderAttempts(input.item.projectId, input.item.conversationId)
        .filter((attempt) => attempt.graphScopeId === conversation?.currentGraphScopeId
          && (attempt.status === "queued" || attempt.status === "running"))
        .map((attempt) => attempt.attemptId);
      if (!conversation || conversation.deletedAt || conversation.state !== "active"
        || conversation.productMode !== input.item.productMode
        || (conversation.productMode === "agent" && conversation.selectedProviderId !== input.item.providerId)
        || executionRevision(conversation.currentGraphScopeId, conversation.completedTurnSequence, activeAttemptIds)
          !== input.expectedExecutionRevision) {
        throw conflict("Conversation execution changed before the queued Turn could be captured.");
      }
      if (this.conversationTurnQueues.listItems(input.item.projectId, input.item.conversationId).length >= 20) {
        throw conflict("Conversation Turn queue already contains 20 active items.");
      }
      const item = { ...input.item, position: this.conversationTurnQueues.nextPosition(input.item.projectId, input.item.conversationId) };
      this.conversationTurnQueues.insertItem(item);
      const draft = this.drafts.readDraft(input.item.projectId, input.item.productMode);
      if ((draft?.updatedAt ?? null) !== input.expectedDraftUpdatedAt) {
        throw new ComposerDraftConflictError(draft);
      }
      if (draft && item.itemKind === "conversation-turn") {
        this.drafts.upsertDraft({
          projectId: draft.projectId,
          productMode: draft.productMode,
          agentTurnMode: draft.agentTurnMode,
          agentModelId: draft.agentModelId,
          agentReasoningEffort: draft.agentReasoningEffort,
          text: "",
          contextRefsJson: "[]",
          attachmentIdsJson: "[]",
          skillOverridesJson: "{}",
          selectedProviderId: draft.selectedProviderId,
          updatedAt: input.item.updatedAt,
        }, draft.updatedAt);
      }
      return {
        queue: this.conversationTurnQueues.advanceRevision(
          input.item.projectId,
          input.item.conversationId,
          queue.revision,
          input.item.updatedAt,
        ),
        item,
      };
    }).immediate();
  }

  reclaimConversationQueuedTurn(input: {
    projectId: string;
    conversationId: string;
    queueItemId: string;
    expectedQueueRevision: number;
    expectedDraftUpdatedAt: string | null;
    updatedAt: string;
  }): StoredConversationTurnQueue {
    return this.db.transaction(() => {
      const queue = this.conversationTurnQueues.readQueue(input.projectId, input.conversationId);
      const item = this.conversationTurnQueues.readItem(input.projectId, input.conversationId, input.queueItemId);
      if (!queue || queue.revision !== input.expectedQueueRevision || !item || !["queued", "blocked"].includes(item.status)) {
        throw conflict("Conversation queued Turn changed before it could be reclaimed.");
      }
      const draft = this.drafts.readDraft(input.projectId, item.productMode);
      if ((draft?.updatedAt ?? null) !== input.expectedDraftUpdatedAt) {
        throw new ComposerDraftConflictError(draft);
      }
      if (draft && this.drafts.hasSendableContent(draft)) {
        throw conflict("Current Composer draft must be empty before reclaiming a queued Turn.");
      }
      const reviewText = this.conversationTurnQueues.reclaimText(item);
      this.drafts.upsertDraft({
        projectId: item.projectId,
        productMode: item.productMode,
        agentTurnMode: item.itemKind === "review" ? draft?.agentTurnMode ?? "default" : item.agentTurnMode,
        agentModelId: item.itemKind === "review" ? draft?.agentModelId ?? null : item.agentModelId,
        agentReasoningEffort: item.itemKind === "review" ? draft?.agentReasoningEffort ?? null : item.agentReasoningEffort,
        text: reviewText,
        contextRefsJson: item.itemKind === "review" ? draft?.contextRefsJson ?? "[]" : item.contextRefsJson,
        attachmentIdsJson: item.itemKind === "review" ? draft?.attachmentIdsJson ?? "[]" : item.attachmentIdsJson,
        skillOverridesJson: item.itemKind === "review" ? draft?.skillOverridesJson ?? "{}" : item.skillOverridesJson,
        selectedProviderId: item.itemKind === "review" ? draft?.selectedProviderId ?? item.providerId : item.providerId,
        updatedAt: input.updatedAt,
      }, draft?.updatedAt ?? null);
      this.conversationTurnQueues.transitionItem({
        projectId: input.projectId,
        conversationId: input.conversationId,
        queueItemId: item.queueItemId,
        expectedStatus: item.status,
        status: "cancelled",
        updatedAt: input.updatedAt,
      });
      return this.conversationTurnQueues.advanceRevision(
        input.projectId,
        input.conversationId,
        queue.revision,
        input.updatedAt,
      );
    }).immediate();
  }

  createConversationWithInitialMessage(
    conversation: Omit<StoredConversation, "timelinePosition" | "timelineRevision" | "archiveOrigin" | "archivedAt" | "lifecycleRevision">
      & Partial<Pick<StoredConversation, "timelinePosition" | "timelineRevision" | "archiveOrigin" | "archivedAt" | "lifecycleRevision">>,
    message: StoredTopicMessageWrite,
  ): StoredTopicMessage {
    return this.db.transaction(() => {
      this.conversations.createConversation(conversation);
      if (conversation.currentGraphScopeId) {
        this.conversations.initializeConversationGraphScope(
          conversation.projectId,
          conversation.conversationId,
          conversation.currentGraphScopeId,
          conversation.updatedAt,
        );
      }
      return this.timeline.appendMessage(message);
    })();
  }

  createConversationFromFirstSend(input: {
    conversation: Omit<StoredConversation, "timelinePosition" | "timelineRevision" | "archiveOrigin" | "archivedAt" | "lifecycleRevision">
      & Partial<Pick<StoredConversation, "timelinePosition" | "timelineRevision" | "archiveOrigin" | "archivedAt" | "lifecycleRevision">>;
    message: StoredTopicMessageWrite;
    skillOverrides: Array<{ skillId: string; enabled: boolean }>;
  }): { conversation: StoredConversation; message: StoredTopicMessage | null; replayed: boolean } {
    return this.db.transaction(() => {
      const requestId = input.conversation.clientCreateRequestId;
      const requestHash = input.conversation.clientCreateRequestHash;
      if (!requestId || !requestHash) {
        throw new Error("First-send Conversation creation requires a client request id and hash.");
      }
      const existing = this.conversations.readConversationByClientCreateRequestId(
        input.conversation.projectId,
        requestId,
      );
      if (existing) {
        if (existing.productMode !== input.conversation.productMode
          || existing.clientCreateRequestHash !== requestHash) {
          const error = new Error("clientRequestId was already used for a different Conversation request.");
          error.name = "Conflict";
          throw error;
        }
        return { conversation: existing, message: null, replayed: true };
      }
      this.conversations.createConversation(input.conversation);
      if (input.conversation.currentGraphScopeId) {
        this.conversations.initializeConversationGraphScope(
          input.conversation.projectId,
          input.conversation.conversationId,
          input.conversation.currentGraphScopeId,
          input.conversation.updatedAt,
        );
      }
      const message = this.timeline.appendMessage(input.message);
      for (const override of input.skillOverrides) {
        this.skills.setSkillEnablement({
          projectId: input.conversation.projectId,
          changeId: input.conversation.conversationId,
          skillId: override.skillId,
          scope: "topic",
          enabled: override.enabled,
          updatedAt: input.conversation.updatedAt,
        });
      }
      return {
        conversation: this.conversations.readConversation(
          input.conversation.projectId,
          input.conversation.conversationId,
        )!,
        message,
        replayed: false,
      };
    }).immediate();
  }

  commitAgentConversationMessage(input: {
    projectId: string;
    conversationId: string;
    graphScopeId: string;
    expectedAgentTurnMode: AgentTurnMode;
    expectedAgentModelId: string | null;
    expectedAgentReasoningEffort: string | null;
    agentTurnMode: AgentTurnMode;
    agentModelId: string | null;
    agentReasoningEffort: string | null;
    skillOverrides: Array<{ skillId: string; enabled: boolean }>;
    queuedTurnDispatch?: ConversationQueuedTurnDispatchEvidence;
    allowActiveQueue?: boolean;
    updatedAt: string;
    message: StoredTopicMessageWrite;
  }): { message: StoredTopicMessage; graphScopeRows: StoredTopicMessage[]; replayed: boolean } {
    return this.db.transaction(() => {
      const replay = this.timeline.readCanonicalRequestReplay(input.message);
      if (replay) return { message: replay, graphScopeRows: [], replayed: true };
      this.assertConversationQueueCommit(
        input.projectId,
        input.conversationId,
        input.queuedTurnDispatch,
        input.allowActiveQueue ?? false,
      );
      const graphScopeRows = this.startConversationGraphScopeCore(
        input.projectId,
        input.conversationId,
        input.graphScopeId,
        input.updatedAt,
      );
      this.conversations.updateAgentTurnPreferences(input);
      const message = this.timeline.appendMessage(input.message);
      this.applyConversationSkillOverrides(input.projectId, input.conversationId, input.skillOverrides, input.updatedAt);
      return { message, graphScopeRows, replayed: false };
    }).immediate();
  }

  commitConversationMessage(input: {
    projectId: string;
    conversationId: string;
    graphScopeId: string;
    message: StoredTopicMessageWrite;
    skillOverrides: Array<{ skillId: string; enabled: boolean }>;
    queuedTurnDispatch?: ConversationQueuedTurnDispatchEvidence;
    allowActiveQueue?: boolean;
    expectedModelId: string | null;
    expectedReasoningEffort: string | null;
    modelId: string | null;
    reasoningEffort: string | null;
    updatedAt: string;
  }): { message: StoredTopicMessage; graphScopeRows: StoredTopicMessage[]; replayed: boolean } {
    return this.db.transaction(() => {
      const replay = this.timeline.readCanonicalRequestReplay(input.message);
      if (replay) return { message: replay, graphScopeRows: [], replayed: true };
      this.assertConversationQueueCommit(
        input.projectId,
        input.conversationId,
        input.queuedTurnDispatch,
        input.allowActiveQueue ?? false,
      );
      const graphScopeRows = this.startConversationGraphScopeCore(
        input.projectId,
        input.conversationId,
        input.graphScopeId,
        input.updatedAt,
      );
      this.conversations.updateConversationModelSelection({
        projectId: input.projectId,
        conversationId: input.conversationId,
        expectedModelId: input.expectedModelId,
        expectedReasoningEffort: input.expectedReasoningEffort,
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
        updatedAt: input.updatedAt,
      });
      const message = this.timeline.appendMessage(input.message);
      this.applyConversationSkillOverrides(input.projectId, input.conversationId, input.skillOverrides, input.updatedAt);
      return { message, graphScopeRows, replayed: false };
    }).immediate();
  }

  private assertConversationQueueCommit(
    projectId: string,
    conversationId: string,
    dispatch: ConversationQueuedTurnDispatchEvidence | undefined,
    allowActiveQueue: boolean,
  ): void {
    const head = this.conversationTurnQueues.listItems(projectId, conversationId)[0];
    if (allowActiveQueue) {
      if (dispatch) throw conflict("A governance settlement cannot impersonate a queued Turn dispatch.");
      return;
    }
    if (!head) {
      if (dispatch) throw conflict("Queued Turn dispatch no longer matches an active FIFO item.");
      return;
    }
    if (!dispatch || head.status !== "dispatching"
      || head.queueItemId !== dispatch.queueItemId
      || head.dispatchRequestId !== dispatch.dispatchRequestId
      || head.requestHash !== dispatch.requestHash) {
      throw conflict("An active Conversation Turn queue must dispatch its exact FIFO head before another Turn.");
    }
  }

  private applyConversationSkillOverrides(
    projectId: string,
    conversationId: string,
    skillOverrides: Array<{ skillId: string; enabled: boolean }>,
    updatedAt: string,
  ): void {
    for (const override of skillOverrides) {
      this.skills.setSkillEnablement({
        projectId,
        changeId: conversationId,
        skillId: override.skillId,
        scope: "topic",
        enabled: override.enabled,
        updatedAt,
      });
    }
  }

  commitProviderTurnTerminal(input: {
    projectId: string;
    conversationId: string;
    runId: string;
    mainAttemptId: string;
    expectedGraphScopeId: string;
    mainStatus: StoredProviderAttempt["status"];
    mainNativeSessionId: string | null;
    childAttempts: Array<{
      attemptId: string;
      status: StoredProviderAttempt["status"];
      nativeSessionId: string | null;
    }>;
    expectedCompletedTurnSequence: number;
    advanceCompletedTurn: boolean;
    binding?: Omit<StoredConversationProviderBinding, "lastDeliveredCompletedTurn">;
    updatedAt: string;
    timelineMessages?: StoredTopicMessageWrite[];
  }): { timelineRows: StoredTopicMessage[]; interactionRows: StoredTopicMessage[]; completedTurnSequence: number } {
    return this.db.transaction(() => {
      this.providerAttempts.assertCurrentRunningAttemptGraph(
        input.projectId,
        input.conversationId,
        input.mainAttemptId,
        input.expectedGraphScopeId,
      );
      const timelineMessages = input.timelineMessages ?? [];
      if (new Set(timelineMessages.map((message) => message.id)).size !== timelineMessages.length) {
        throw new Error("Provider terminal commit requires one final mutation per canonical message.");
      }
      const timelineRows = timelineMessages.map((message) =>
        this.timeline.readMessage(message.projectId, message.conversationId, message.id)
          ? this.timeline.updateMessage(message)
          : this.timeline.appendMessage(message));
      const interactionRows = this.interactions.terminalizeProviderUserInputRequests(
        input.projectId,
        input.conversationId,
        input.runId,
        input.updatedAt,
      );
      for (const child of input.childAttempts) {
        this.providerAttempts.completeProviderAttempt(
          input.projectId,
          child.attemptId,
          child.status,
          child.nativeSessionId,
          input.updatedAt,
        );
      }
      this.providerAttempts.completeProviderAttempt(
        input.projectId,
        input.mainAttemptId,
        input.mainStatus,
        input.mainNativeSessionId,
        input.updatedAt,
      );
      const completedTurnSequence = input.advanceCompletedTurn
        ? this.conversations.advanceCompletedTurnSequence(
            input.projectId,
            input.conversationId,
            input.expectedCompletedTurnSequence,
            input.updatedAt,
          )
        : input.expectedCompletedTurnSequence;
      if (input.binding) {
        this.providerAttempts.writeConversationProviderBinding({
          ...input.binding,
          lastDeliveredCompletedTurn: completedTurnSequence,
        });
      }
      return { timelineRows, interactionRows, completedTurnSequence };
    })();
  }

  deleteArchivedConversation(input: {
    projectId: string;
    conversationId: string;
    productMode: ProductMode;
    expectedLifecycleRevision: number;
    deletedAt: string;
  }): void {
    this.db.transaction(() => {
      this.timeline.deleteMessages(input.projectId, input.conversationId);
      this.conversationTurnQueues.deleteConversationQueue(input.projectId, input.conversationId);
      this.conversationReviews.deleteConversation(input.projectId, input.conversationId);
      this.providerAttempts.deleteConversationRuntimeState(input.projectId, input.conversationId);
      this.skills.deleteConversationEnablement(input.projectId, input.conversationId);
      if (input.productMode === "agent") {
        this.conversations.deleteConversationGraphScopes(input.projectId, input.conversationId);
      }
      this.conversations.deleteArchivedConversation(
        input.projectId,
        input.conversationId,
        input.expectedLifecycleRevision,
        input.deletedAt,
      );
    })();
  }

  acceptConversationChangeBinding(
    projectId: string,
    conversationId: string,
    changeId: string,
    linkedAt: string,
    acceptanceId?: string,
    proposalHash?: string,
    scopeTransition?: {
      graphScopeId: string;
      previousGraphScopeId: string;
      runId?: string;
      mainAttemptId: string;
      plannerThreadId?: string;
    },
    expectedCurrentGraphScopeId?: string,
    expectedMainAttemptId?: string,
  ): StoredTopicMessage[] {
    return this.db.transaction(() => {
      const currentGraphScopeId = this.conversations.readConversation(projectId, conversationId)?.currentGraphScopeId;
      if (expectedCurrentGraphScopeId !== undefined && currentGraphScopeId !== expectedCurrentGraphScopeId) {
        throw new Error("Planning acceptance no longer matches the current conversation graph scope.");
      }
      if (expectedMainAttemptId !== undefined) {
        if (!expectedCurrentGraphScopeId) {
          throw new Error("Planning acceptance Main-attempt fencing requires the expected graph scope.");
        }
        this.providerAttempts.assertCurrentRunningAttemptGraph(
          projectId,
          conversationId,
          expectedMainAttemptId,
          expectedCurrentGraphScopeId,
          "Planning acceptance Main attempt no longer owns the current conversation graph.",
        );
      }
      let timelineRows: StoredTopicMessage[] = [];
      if (scopeTransition) {
        if (!scopeTransition.runId || !scopeTransition.plannerThreadId) {
          throw new Error("A superseding planning acceptance requires durable provider lineage.");
        }
        timelineRows = this.moveConversationRunToGraphScope(
          projectId,
          conversationId,
          scopeTransition.runId,
          {
            mainAttemptId: scopeTransition.mainAttemptId,
            plannerThreadId: scopeTransition.plannerThreadId,
            previousGraphScopeId: scopeTransition.previousGraphScopeId,
            graphScopeId: scopeTransition.graphScopeId,
          },
          linkedAt,
        );
      }
      const graphScopeId = this.conversations.readConversation(projectId, conversationId)?.currentGraphScopeId;
      if (!graphScopeId) throw new Error("Planning acceptance requires the current graph scope.");
      this.conversations.linkConversationChange(projectId, conversationId, changeId, linkedAt);
      this.providerAttempts.attachChangeToGraphScope(
        projectId,
        conversationId,
        graphScopeId,
        changeId,
        linkedAt,
      );
      if (acceptanceId && proposalHash) {
        this.conversations.recordPlanningAcceptance(
          acceptanceId,
          projectId,
          conversationId,
          changeId,
          graphScopeId,
          proposalHash,
          linkedAt,
        );
      }
      return timelineRows;
    })();
  }

  startConversationGraphScope(projectId: string, conversationId: string, graphScopeId: string, updatedAt: string): StoredTopicMessage[] {
    return this.db.transaction(() => this.startConversationGraphScopeCore(
      projectId,
      conversationId,
      graphScopeId,
      updatedAt,
    ))();
  }

  private startConversationGraphScopeCore(
    projectId: string,
    conversationId: string,
    graphScopeId: string,
    updatedAt: string,
  ): StoredTopicMessage[] {
    let rows: StoredTopicMessage[] = [];
    const currentScopeId = this.conversations.readConversation(projectId, conversationId)?.currentGraphScopeId;
    if (currentScopeId && currentScopeId !== graphScopeId) {
      rows = this.interactions.supersedeGraphScope(projectId, conversationId, currentScopeId, updatedAt);
    }
    this.conversations.activateGraphScope(projectId, conversationId, graphScopeId, updatedAt);
    return rows;
  }

  createProviderChildCallback(input: {
    attempt: StoredProviderAttempt;
    parentAttemptId: string;
    requireRunningParent?: boolean;
    thread: {
      threadId: string;
      parentThreadId: string;
      parentAgentSurfaceId: string;
      displayName?: string | null;
      runId: string;
    };
    timelineMessages?: StoredTopicMessageWrite[];
  }): StoredTopicMessage[] {
    return this.db.transaction(() => {
      if (!input.attempt.conversationId || !input.attempt.graphScopeId) {
        throw new Error("Provider child callback requires Conversation and graph scope identity.");
      }
      this.providerAttempts[input.requireRunningParent === false ? "assertCurrentAttemptGraph" : "assertCurrentRunningAttemptGraph"](
        input.attempt.projectId,
        input.attempt.conversationId,
        input.parentAttemptId,
        input.attempt.graphScopeId,
      );
      const parentAttempt = this.providerAttempts.readProviderAttempt(input.attempt.projectId, input.parentAttemptId);
      const parentLink = this.providerAttempts.listProviderThreads(input.attempt.projectId, input.attempt.conversationId)
        .find((candidate) => candidate.attemptId === input.parentAttemptId);
      const expectedParentSurface = parentLink?.roleId === "main-agent"
        ? "main-agent"
        : parentLink ? agentThreadSurfaceId(input.attempt.providerId, parentLink.providerThreadId) : null;
      if (!parentAttempt || !parentLink
        || parentAttempt.conversationId !== input.attempt.conversationId
        || parentAttempt.providerId !== input.attempt.providerId
        || parentAttempt.graphScopeId !== input.attempt.graphScopeId
        || parentAttempt.nativeSessionId !== input.thread.parentThreadId
        || parentLink.providerId !== input.attempt.providerId
        || parentLink.providerThreadId !== input.thread.parentThreadId
        || parentLink.graphScopeId !== input.attempt.graphScopeId
        || input.thread.parentAgentSurfaceId !== expectedParentSurface
        || input.attempt.parentAgentSurfaceId !== expectedParentSurface) {
        throw new Error("Provider child callback parent Attempt and ThreadLink lineage do not match.");
      }
      this.providerAttempts.createProviderAttempt(input.attempt);
      this.providerAttempts.bindProviderAttemptThread(
        input.attempt.projectId,
        { attemptId: input.attempt.attemptId, ...input.thread },
        input.attempt.updatedAt,
      );
      return (input.timelineMessages ?? []).map((message) => this.timeline.appendMessage(message));
    })();
  }

  terminalizeConversationGraphScope(
    projectId: string,
    conversationId: string,
    graphScopeId: string,
    updatedAt: string,
  ): StoredTopicMessage[] {
    return this.db.transaction(() => {
      const rows = this.interactions.supersedeGraphScope(projectId, conversationId, graphScopeId, updatedAt);
      this.conversations.markConversationGraphScopeTerminal(projectId, conversationId, graphScopeId, updatedAt);
      return rows;
    })();
  }

  moveConversationRunToGraphScope(
    projectId: string,
    conversationId: string,
    runId: string,
    lineage: {
      mainAttemptId: string;
      plannerThreadId: string;
      previousGraphScopeId: string;
      graphScopeId: string;
    },
    updatedAt: string,
  ): StoredTopicMessage[] {
    return this.db.transaction(() => {
      const rows = this.startConversationGraphScope(projectId, conversationId, lineage.graphScopeId, updatedAt);
      this.providerAttempts.moveConversationThreadsToGraphScope(
        projectId,
        conversationId,
        lineage,
        updatedAt,
      );
      return [...rows, ...this.timeline.moveRunToGraphScope(projectId, conversationId, runId, lineage.graphScopeId)];
    })();
  }

  commitProviderCallback(input: {
    projectId: string;
    conversationId: string;
    attemptId: string;
    expectedGraphScopeId: string;
    updatedAt: string;
    terminal?: {
      status: StoredProviderAttempt["status"];
      nativeSessionId: string | null;
    };
    thread?: {
      threadId: string;
      parentThreadId?: string | null;
      parentAgentSurfaceId?: string | null;
      displayName?: string | null;
      runId?: string | null;
    };
    timelineMessages?: StoredTopicMessageWrite[];
  }): StoredTopicMessage[] {
    return this.db.transaction(() => {
      if (input.terminal?.status === "terminated") {
        this.providerAttempts.assertCurrentAttemptGraph(
          input.projectId,
          input.conversationId,
          input.attemptId,
          input.expectedGraphScopeId,
        );
      } else {
        this.providerAttempts.assertCurrentRunningAttemptGraph(
          input.projectId,
          input.conversationId,
          input.attemptId,
          input.expectedGraphScopeId,
        );
      }
      if (input.thread) {
        this.providerAttempts.bindProviderAttemptThread(
          input.projectId,
          { attemptId: input.attemptId, ...input.thread },
          input.updatedAt,
        );
      }
      const timelineMessages = input.timelineMessages ?? [];
      if (new Set(timelineMessages.map((message) => message.id)).size !== timelineMessages.length) {
        throw new Error("Provider callback requires one mutation per canonical message.");
      }
      const rows = timelineMessages.map((message) =>
        this.timeline.readMessage(message.projectId, message.conversationId, message.id)
          ? this.timeline.updateMessage(message)
          : this.timeline.appendMessage(message));
      if (input.terminal) {
        this.providerAttempts.completeProviderAttempt(
          input.projectId,
          input.attemptId,
          input.terminal.status,
          input.terminal.nativeSessionId,
          input.updatedAt,
        );
      }
      return rows;
    })();
  }

  commitProviderTerminalSupplement(input: {
    projectId: string;
    conversationId: string;
    attemptId: string;
    expectedGraphScopeId: string;
    timelineMessages: StoredTopicMessageWrite[];
  }): StoredTopicMessage[] {
    return this.db.transaction(() => {
      this.providerAttempts.assertCurrentAttemptGraph(
        input.projectId,
        input.conversationId,
        input.attemptId,
        input.expectedGraphScopeId,
        { allowTerminated: true },
      );
      const attempt = this.providerAttempts.readProviderAttempt(input.projectId, input.attemptId);
      if (!attempt || attempt.status === "queued" || attempt.status === "running") {
        throw new Error(`Provider terminal supplement requires a terminal Attempt: ${input.attemptId}.`);
      }
      if (new Set(input.timelineMessages.map((message) => message.id)).size !== input.timelineMessages.length) {
        throw new Error("Provider terminal supplement requires one mutation per canonical message.");
      }
      return input.timelineMessages.map((message) =>
        this.timeline.readMessage(message.projectId, message.conversationId, message.id)
          ? this.timeline.updateMessage(message)
          : this.timeline.appendMessage(message));
    })();
  }

  commitProviderRecoveryTerminal(input: {
    projectId: string;
    conversationId: string;
    attemptId: string;
    expectedGraphScopeId: string;
    nativeSessionId: string | null;
    updatedAt: string;
    timelineMessage: StoredTopicMessageWrite;
  }): StoredTopicMessage {
    return this.db.transaction(() => {
      this.providerAttempts.assertCurrentAttemptGraph(
        input.projectId,
        input.conversationId,
        input.attemptId,
        input.expectedGraphScopeId,
      );
      const row = this.timeline.readMessage(input.timelineMessage.projectId, input.timelineMessage.conversationId, input.timelineMessage.id)
        ? this.timeline.updateMessage(input.timelineMessage)
        : this.timeline.appendMessage(input.timelineMessage);
      this.providerAttempts.completeProviderAttempt(
        input.projectId,
        input.attemptId,
        "failed",
        input.nativeSessionId,
        input.updatedAt,
      );
      return row;
    })();
  }

  commitHistoricalNativeChildRecovery(input: {
    projectId: string;
    conversationId: string;
    attemptId: string;
    providerId: string;
    graphScopeId: string;
    nativeSessionId: string;
    parentThreadId: string | null;
    updatedAt: string;
    timelineMessage: StoredTopicMessageWrite;
  }): StoredTopicMessage {
    return this.db.transaction(() => {
      const attempt = this.providerAttempts.readProviderAttempt(input.projectId, input.attemptId);
      const link = this.providerAttempts.listProviderThreads(input.projectId, input.conversationId)
        .find((candidate) => candidate.attemptId === input.attemptId);
      if (!attempt
        || attempt.conversationId !== input.conversationId
        || attempt.productMode !== "agent"
        || attempt.roleId !== "native-child-agent"
        || attempt.operationProfile !== "agent"
        || attempt.providerId !== input.providerId
        || attempt.graphScopeId !== input.graphScopeId
        || attempt.nativeSessionId !== input.nativeSessionId
        || (link && (link.providerId !== input.providerId
          || link.providerThreadId !== input.nativeSessionId
          || link.parentThreadId !== input.parentThreadId
          || link.graphScopeId !== input.graphScopeId))
        || (!link && (input.parentThreadId !== null || attempt.status !== "queued"))) {
        throw new Error("Restart recovery native child lineage is malformed.");
      }
      const row = this.timeline.readMessage(input.timelineMessage.projectId, input.timelineMessage.conversationId, input.timelineMessage.id)
        ? this.timeline.updateMessage(input.timelineMessage)
        : this.timeline.appendMessage(input.timelineMessage);
      this.providerAttempts.completeProviderAttempt(input.projectId, input.attemptId, "failed", input.nativeSessionId, input.updatedAt);
      return row;
    })();
  }

  commitNativeChildRecoveryQuarantine(input: {
    projectId: string;
    conversationId: string;
    attemptId: string;
    providerId: string;
    graphScopeId: string | null;
    nativeSessionId: string | null;
    updatedAt: string;
    timelineMessage: StoredTopicMessageWrite;
  }): StoredTopicMessage {
    return this.db.transaction(() => {
      const attempt = this.providerAttempts.readProviderAttempt(input.projectId, input.attemptId);
      if (!attempt
        || attempt.conversationId !== input.conversationId
        || attempt.productMode !== "agent"
        || attempt.roleId !== "native-child-agent"
        || attempt.operationProfile !== "agent"
        || attempt.providerId !== input.providerId
        || attempt.graphScopeId !== input.graphScopeId
        || attempt.nativeSessionId !== input.nativeSessionId
        || (attempt.status !== "queued" && attempt.status !== "running")
        || input.timelineMessage.projectId !== input.projectId
        || input.timelineMessage.conversationId !== input.conversationId) {
        throw new Error("Restart recovery quarantine Attempt identity is mismatched.");
      }
      const row = this.timeline.readMessage(input.timelineMessage.projectId, input.timelineMessage.conversationId, input.timelineMessage.id)
        ? this.timeline.updateMessage(input.timelineMessage)
        : this.timeline.appendMessage(input.timelineMessage);
      this.providerAttempts.completeProviderAttempt(input.projectId, input.attemptId, "failed", input.nativeSessionId, input.updatedAt);
      return row;
    })();
  }

  commitNativeChildPersistenceFailure(input: {
    projectId: string;
    conversationId: string;
    attemptId: string;
    providerId: string;
    graphScopeId: string;
    nativeSessionId: string;
    updatedAt: string;
    timelineMessage: StoredTopicMessageWrite;
  }): StoredTopicMessage {
    return this.db.transaction(() => {
      const attempt = this.providerAttempts.readProviderAttempt(input.projectId, input.attemptId);
      if (!attempt
        || attempt.conversationId !== input.conversationId
        || attempt.productMode !== "agent"
        || attempt.roleId !== "native-child-agent"
        || attempt.operationProfile !== "agent"
        || attempt.providerId !== input.providerId
        || attempt.graphScopeId !== input.graphScopeId
        || attempt.nativeSessionId !== input.nativeSessionId
        || attempt.status === "terminated"
        || input.timelineMessage.projectId !== input.projectId
        || input.timelineMessage.conversationId !== input.conversationId) {
        throw new Error("Native child persistence failure Attempt identity is mismatched.");
      }
      const row = this.timeline.readMessage(input.timelineMessage.projectId, input.timelineMessage.conversationId, input.timelineMessage.id)
        ? this.timeline.updateMessage(input.timelineMessage)
        : this.timeline.appendMessage(input.timelineMessage);
      this.providerAttempts.completeProviderAttempt(input.projectId, input.attemptId, "failed", input.nativeSessionId, input.updatedAt);
      return row;
    })();
  }

  commitRecoveryDiagnostic(message: StoredTopicMessageWrite): StoredTopicMessage {
    return this.db.transaction(() => this.timeline.readMessage(message.projectId, message.conversationId, message.id)
      ? this.timeline.updateMessage(message)
      : this.timeline.appendMessage(message))();
  }

  commitConversationRetryClaim(message: StoredTopicMessageWrite): { message: StoredTopicMessage; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.timeline.readMessage(message.projectId, message.conversationId, message.id);
      return existing
        ? { message: existing, created: false }
        : { message: this.timeline.appendMessage(message), created: true };
    })();
  }

  commitAgentMainAttemptRecovery(input: {
    projectId: string;
    conversationId: string;
    attemptId: string;
    providerId: string;
    graphScopeId: string | null;
    nativeSessionId: string | null;
    updatedAt: string;
    timelineMessage: StoredTopicMessageWrite;
  }): StoredTopicMessage {
    return this.db.transaction(() => {
      const conversation = this.conversations.readConversation(input.projectId, input.conversationId);
      const attempt = this.providerAttempts.readProviderAttempt(input.projectId, input.attemptId);
      if (!conversation
        || conversation.productMode !== "agent"
        || !attempt
        || attempt.conversationId !== input.conversationId
        || attempt.productMode !== "agent"
        || attempt.roleId !== "main-agent"
        || attempt.operationProfile !== "agent"
        || attempt.providerId !== input.providerId
        || attempt.graphScopeId !== input.graphScopeId
        || attempt.nativeSessionId !== input.nativeSessionId
        || (attempt.status !== "queued" && attempt.status !== "running")) {
        throw new Error("Restart recovery Agent main Attempt identity is mismatched.");
      }
      const row = this.timeline.readMessage(input.timelineMessage.projectId, input.timelineMessage.conversationId, input.timelineMessage.id)
        ? this.timeline.updateMessage(input.timelineMessage)
        : this.timeline.appendMessage(input.timelineMessage);
      this.providerAttempts.completeProviderAttempt(input.projectId, input.attemptId, "failed", input.nativeSessionId, input.updatedAt);
      const binding = this.providerAttempts.readConversationProviderBinding(input.projectId, input.conversationId, input.providerId);
      if (binding) this.providerAttempts.writeConversationProviderBinding({ ...binding, bindingStatus: "stale", lastUsedAt: input.updatedAt });
      return row;
    })();
  }

  commitConversationProviderSwitch(
    point: StoredProviderResumePoint,
    binding: StoredConversationProviderBinding,
    expectedProviderId: ProviderId,
    resumeAttempt: StoredProviderAttempt,
  ): void {
    this.db.transaction(() => {
      this.conversations.switchSelectedProvider(
        point.projectId,
        point.conversationId,
        expectedProviderId,
        point.targetProviderId,
        point.createdAt,
      );
      this.providerAttempts.writeProviderResumePoint(point);
      this.providerAttempts.writeConversationProviderBinding(binding);
      this.providerAttempts.createProviderAttempt(resumeAttempt);
    })();
  }
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function executionRevision(graphScopeId: string | null, completedTurnSequence: number, attemptIds: string[]): string {
  const payload = JSON.stringify({ graphScopeId, completedTurnSequence, attemptIds: [...attemptIds].sort() });
  return `execution:${createHash("sha256").update(payload).digest("hex")}`;
}
