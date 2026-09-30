import type { ManagedProject } from "../types/index.js";
import type { ProjectRuntimeCoordinatorPort } from "../project-runtime/coordinator.js";
import type { ConversationTurnRoutingPort } from "./conversation-turn-contract.js";
import type { ConversationQueuedReviewDispatchPort } from "./conversation-queued-review-dispatch.js";
import type { StoredConversationQueuedTurn } from "./persistence/contracts.js";
import type { ConversationDeliveryOperation } from "./conversation-turn-queue-contract.js";
import { prepareConversationMessage, postConversationMessage } from "./conversation-service.js";
import type { ConversationTurnControlOwner, ConversationTurnSteerRequest, ConversationTurnSteerReceipt } from "./conversation-turn-control.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import { commitAcceptedConversationInput } from "./conversation-input-commit.js";
import { publishCommittedCanonicalTimelineRow } from "./canonical-timeline-delivery.js";
import { publishProjectLiveEvent } from "./project-live-events.js";
import type { TopicMessageInput } from "./types.js";
import { createConversationExecutionRevision } from "./conversation-execution-revision.js";

export interface ConversationInputDeliveryPort {
  dispatch(project: ManagedProject, item: StoredConversationQueuedTurn, context: { timelineRevision: number; executionRevision: string | null }, beforeInvoke: () => Promise<void>): Promise<void>;
  guide(project: ManagedProject, item: StoredConversationQueuedTurn, operation: ConversationDeliveryOperation, phase: (phase: "invoking" | "waiting-terminal") => Promise<void>): Promise<void>;
}

/** A definite admission rejection is distinct from a transport failure after invocation. */
export class ConversationInputRejected extends Error {
  readonly inputNotInvoked = true;
  readonly name = "ConversationInputRejected";
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : "Input was not accepted.", { cause }); }
}

export class ConversationInputDeliveryService implements ConversationInputDeliveryPort {
  constructor(private readonly options: {
    projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve">;
    turnRouter: ConversationTurnRoutingPort;
    turnControl: Pick<ConversationTurnControlOwner, "steer" | "interrupt" | "waitForTerminal">;
    reviewDispatch: ConversationQueuedReviewDispatchPort;
    prepare?: typeof prepareConversationMessage;
    post?: typeof postConversationMessage;
  }) {}

  async dispatch(project: ManagedProject, item: StoredConversationQueuedTurn, context: { timelineRevision: number; executionRevision: string | null }, beforeInvoke: () => Promise<void>): Promise<void> {
    if (item.itemKind === "review") {
      await beforeInvoke();
      await this.options.reviewDispatch.dispatchQueuedReview(project, {
        conversationId: item.conversationId, providerId: item.providerId,
        target: JSON.parse(item.reviewTargetJson!), expectedTimelineRevision: context.timelineRevision,
        expectedExecutionRevision: context.executionRevision, clientRequestId: item.dispatchRequestId,
      });
      return;
    }
    const message = queuedMessageInput(item);
    let prepared: Awaited<ReturnType<typeof prepareConversationMessage>>;
    try {
      prepared = await (this.options.prepare ?? prepareConversationMessage)(project, item.conversationId, message, { turnRouter: this.options.turnRouter });
    } catch (cause) { throw new ConversationInputRejected(cause); }
    await beforeInvoke();
    await (this.options.post ?? postConversationMessage)(project, item.conversationId, message, { emit: (event) => publishProjectLiveEvent(project.id, event) }, { turnRouter: this.options.turnRouter, prepared });
  }

  async guide(project: ManagedProject, item: StoredConversationQueuedTurn, operation: ConversationDeliveryOperation, phase: (phase: "invoking" | "waiting-terminal") => Promise<void>): Promise<void> {
    const target = {
      projectId: project.id, productMode: item.productMode, conversationId: item.conversationId,
      providerId: operation.providerId, expectedAttemptId: operation.attemptId!,
    };
    if (operation.mode === "steer") {
      await phase("invoking");
      const receipt = await this.steer(project, { ...target, clientRequestId: operation.clientRequestId, text: item.text }, operation);
      if (receipt.status === "already-terminal") throw new ConversationInputRejected(new Error("The target Turn ended before input acceptance."));
      return;
    }
    await phase("waiting-terminal");
    try {
      await this.options.turnControl.interrupt(project, target);
      await this.options.turnControl.waitForTerminal(project, target);
    } catch (cause) { throw new ConversationInputRejected(cause); }
    // Full admission runs again after the durable terminal. Captured settings,
    // files, permissions, skills and review target remain owned by the item.
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const db = await openProjectRuntimeWorkbenchDatabase(runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths);
    let context: { timelineRevision: number; executionRevision: string | null };
    try {
      const conversation = db.conversations.readConversation(project.id, item.conversationId);
      const active = db.providerAttempts.listProviderAttempts(project.id, item.conversationId)
        .filter((attempt) => attempt.graphScopeId === conversation?.currentGraphScopeId && (attempt.status === "running" || attempt.status === "queued"));
      context = { timelineRevision: conversation?.timelineRevision ?? -1, executionRevision: conversation
        ? createConversationExecutionRevision(conversation.currentGraphScopeId, conversation.completedTurnSequence, active.map((attempt) => attempt.attemptId)) : null };
    } finally { db.close(); }
    await this.dispatch(project, item, context, () => phase("invoking"));
  }

  async steer(project: ManagedProject, request: ConversationTurnSteerRequest, operation?: ConversationDeliveryOperation): Promise<ConversationTurnSteerReceipt> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    const db = await openProjectRuntimeWorkbenchDatabase(runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths);
    try {
      return await this.options.turnControl.steer(project, request, (receipt) => {
        const current = operation ? db.conversationTurnQueues.readDelivery(project.id, request.conversationId, operation.clientRequestId) ?? undefined : undefined;
        const row = commitAcceptedConversationInput(db, request, receipt.runId, current);
        publishCommittedCanonicalTimelineRow((envelope) => publishProjectLiveEvent(project.id, { event: "timeline.patch", data: envelope }), row, request.productMode);
      });
    } finally { db.close(); }
  }
}

function queuedMessageInput(item: StoredConversationQueuedTurn): TopicMessageInput {
  return {
    message: item.text, contextRefs: JSON.parse(item.contextRefsJson), attachmentIds: JSON.parse(item.attachmentIdsJson),
    skillOverrides: Object.entries(JSON.parse(item.skillOverridesJson) as Record<string, boolean>).map(([skillId, enabled]) => ({ skillId, enabled })),
    providerId: item.providerId, productMode: item.productMode,
    ...(item.productMode === "agent" ? { agentTurnMode: item.agentTurnMode ?? "default", agentAccessMode: item.agentAccessMode ?? "default" } : {}),
    modelId: item.agentModelId, reasoningEffort: item.agentReasoningEffort,
    clientRequestId: item.dispatchRequestId,
    queuedTurnDispatch: { queueItemId: item.queueItemId, dispatchRequestId: item.dispatchRequestId, requestHash: item.requestHash },
  };
}
