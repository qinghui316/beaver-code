import type { WorkbenchLiveEvent } from "./types.js";
import type { AgentSurfacesInvalidated } from "./agent-surface-contract.js";

type ProjectLiveSubscriber = (event: WorkbenchLiveEvent) => void;

const subscribers = new Map<string, Set<ProjectLiveSubscriber>>();

export function publishProjectLiveEvent(projectId: string, event: WorkbenchLiveEvent): void {
  for (const subscriber of subscribers.get(projectId) ?? []) subscriber(event);
}

export function publishAgentSurfacesInvalidated(projectId: string, data: AgentSurfacesInvalidated): void {
  publishProjectLiveEvent(projectId, { event: "agent-surfaces.invalidated", data });
}

export function publishConversationTurnControlInvalidated(projectId: string, data: {
  conversationId: string;
  attemptId: string;
}): void {
  publishProjectLiveEvent(projectId, { event: "conversation.turn-control.invalidated", data });
}

export function publishConversationContextInvalidated(projectId: string, data: { conversationId: string }): void {
  publishProjectLiveEvent(projectId, { event: "conversation.context.invalidated", data });
}

export function publishConversationForkCompleted(projectId: string, data: { sourceConversationId: string; targetConversationId: string }): void {
  publishProjectLiveEvent(projectId, { event: "conversation.fork.completed", data });
}

export function publishConversationTurnQueueInvalidated(projectId: string, data: { conversationId: string }): void {
  publishProjectLiveEvent(projectId, { event: "conversation.turn-queue.invalidated", data });
}

export function publishConversationLifecycleInvalidated(projectId: string, data: {
  conversationId: string;
  productMode: "agent" | "harness";
  state: "active" | "archived" | "deleted";
  lifecycleRevision: string;
}): void {
  publishProjectLiveEvent(projectId, { event: "conversation.lifecycle.invalidated", data });
}

export function publishConversationLifecycleSyncUpdated(projectId: string, data: {
  conversationId: string;
  productMode: "agent" | "harness";
  providerSyncStatus: "not-required" | "unsupported" | "submitting" | "completed" | "failed" | "uncertain";
}): void {
  publishProjectLiveEvent(projectId, { event: "conversation.lifecycle.sync-updated", data });
}

export function publishConversationReviewInvalidated(projectId: string, data: { conversationId: string }): void {
  publishProjectLiveEvent(projectId, { event: "conversation.review.invalidated", data });
}

export function subscribeProjectLiveEvents(projectId: string, subscriber: ProjectLiveSubscriber): () => void {
  const projectSubscribers = subscribers.get(projectId) ?? new Set<ProjectLiveSubscriber>();
  projectSubscribers.add(subscriber);
  subscribers.set(projectId, projectSubscribers);
  return () => {
    projectSubscribers.delete(subscriber);
    if (projectSubscribers.size === 0) subscribers.delete(projectId);
  };
}
