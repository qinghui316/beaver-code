import type { ConversationTurnSteerRequest } from "./conversation-turn-control.js";
import { conversationSteerTimelineIds } from "./conversation-turn-control.js";
import type { WorkbenchDatabase } from "./persistence/database.js";
import type { StoredTopicMessage } from "./persistence/contracts.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import type { ConversationDeliveryOperation } from "./conversation-turn-queue-contract.js";

/** Provider acceptance remains valid if that exact execution finishes concurrently. */
export function commitAcceptedConversationInput(database: WorkbenchDatabase, request: ConversationTurnSteerRequest, runId: string, operation?: ConversationDeliveryOperation): StoredTopicMessage {
  return database.immediateTransaction(() => {
    const conversation = database.conversations.readConversation(request.projectId, request.conversationId);
    const attempt = database.providerAttempts.readProviderAttempt(request.projectId, request.expectedAttemptId);
    if (!conversation || conversation.productMode !== request.productMode
      || attempt?.conversationId !== request.conversationId || attempt.providerId !== request.providerId
      || attempt.roleId !== "main-agent") {
      throw new Error("Accepted input evidence does not match its original execution.");
    }
    const { userId } = conversationSteerTimelineIds(request.expectedAttemptId, request.clientRequestId);
    const existing = database.timeline.readMessage(request.projectId, request.conversationId, userId);
    if (existing) {
      if (JSON.parse(existing.rawJson).text !== request.text) throw new Error("Accepted input request identity has conflicting text.");
      return existing;
    }
    const queued = operation?.queueItemId ? database.conversationTurnQueues.readItem(request.projectId, request.conversationId, operation.queueItemId) : null;
    const row = database.timeline.appendMessage(toCanonicalTimelineMessage(request.projectId, request.conversationId, {
      id: userId, type: "user.message", timestamp: new Date().toISOString(), changeId: conversation.boundChangeId ?? "",
      conversationId: request.conversationId, graphScopeId: attempt.graphScopeId ?? undefined,
      text: request.text, status: "steering-sent", runId, providerId: request.providerId,
      attemptId: request.expectedAttemptId, clientRequestId: request.clientRequestId,
      agentSurfaceId: "main-agent",
      ...(queued ? { queuedTurnDispatch: { queueItemId: queued.queueItemId,
        dispatchRequestId: queued.dispatchRequestId, requestHash: queued.requestHash } } : {}),
    }));
    if (operation) database.conversationTurnQueues.transitionDelivery(operation, "accepted", row.id);
    return row;
  });
}
