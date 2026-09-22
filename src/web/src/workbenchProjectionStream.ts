import { useCallback, useEffect, useRef } from "react";
import type {
  CanonicalTimelineEnvelope,
  ConversationInteractionQueue,
  Snapshot,
  WorkbenchLiveEvent,
} from "./types.js";

export type WorkbenchProjectionRoutePorts = {
  timeline: {
    patch: (projectId: string, envelope: CanonicalTimelineEnvelope) => void;
  };
  topic: {
    created: (projectId: string, data: Extract<WorkbenchLiveEvent, { event: "topic.created" }>["data"]) => void;
    updated: (projectId: string, data: Extract<WorkbenchLiveEvent, { event: "topic.updated" }>["data"]) => void;
  };
  interaction: {
    updated: (projectId: string, queue: ConversationInteractionQueue) => void;
  };
  snapshot: {
    received: (projectId: string, snapshot: Snapshot) => void;
  };
  agentSurfaces: {
    invalidate: (input: {
      projectId: string;
      conversationId: string;
      graphScopeId?: string;
      reason: Extract<WorkbenchLiveEvent, { event: "agent-surfaces.invalidated" }>["data"]["reason"];
    }) => void;
  };
  turnControl?: {
    invalidate: (projectId: string, data: Extract<WorkbenchLiveEvent, { event: "conversation.turn-control.invalidated" }>["data"]) => void;
  };
  conversationContext?: {
    invalidate: (projectId: string, data: Extract<WorkbenchLiveEvent, { event: "conversation.context.invalidated" }>["data"]) => void;
  };
  conversationReview?: {
    invalidate: (projectId: string, data: Extract<WorkbenchLiveEvent, { event: "conversation.review.invalidated" }>["data"]) => void;
  };
  modeActivity?: {
    invalidate: (projectId: string) => void;
  };
  error?: {
    received: (projectId: string, data: Extract<WorkbenchLiveEvent, { event: "error" }>["data"]) => void;
  };
};

export type WorkbenchProjectionRouteResult = {
  handled: boolean;
  event: WorkbenchLiveEvent["event"];
};

export function routeWorkbenchProjectionEvent(
  projectId: string,
  event: WorkbenchLiveEvent,
  ports: WorkbenchProjectionRoutePorts,
): WorkbenchProjectionRouteResult {
  const activityInvalidated = MODE_ACTIVITY_INVALIDATION_EVENTS.has(event.event);
  if (activityInvalidated) ports.modeActivity?.invalidate(projectId);
  switch (event.event) {
    case "timeline.patch":
      ports.timeline.patch(projectId, event.data);
      return { handled: true, event: event.event };
    case "topic.created":
      ports.topic.created(projectId, event.data);
      return { handled: true, event: event.event };
    case "topic.updated":
      ports.topic.updated(projectId, event.data);
      return { handled: true, event: event.event };
    case "conversation.interactions.updated":
      ports.interaction.updated(projectId, event.data);
      return { handled: true, event: event.event };
    case "agent-surfaces.invalidated":
      ports.agentSurfaces.invalidate({ projectId, ...event.data });
      return { handled: true, event: event.event };
    case "conversation.turn-control.invalidated":
      ports.turnControl?.invalidate(projectId, event.data);
      return { handled: Boolean(ports.turnControl), event: event.event };
    case "conversation.context.invalidated":
      ports.conversationContext?.invalidate(projectId, event.data);
      return { handled: Boolean(ports.conversationContext), event: event.event };
    case "conversation.review.invalidated":
      ports.conversationReview?.invalidate(projectId, event.data);
      return { handled: Boolean(ports.conversationReview), event: event.event };
    case "snapshot":
      ports.snapshot.received(projectId, event.data);
      return { handled: true, event: event.event };
    case "error":
      ports.error?.received(projectId, event.data);
      return { handled: Boolean(ports.error), event: event.event };
    default:
      return { handled: activityInvalidated && Boolean(ports.modeActivity), event: event.event };
  }
}

const MODE_ACTIVITY_INVALIDATION_EVENTS = new Set<WorkbenchLiveEvent["event"]>([
  "topic.created",
  "topic.updated",
  "timeline.patch",
  "conversation.interactions.updated",
  "agent-surfaces.invalidated",
  "conversation.turn-control.invalidated",
  "conversation.context.invalidated",
  "conversation.review.invalidated",
  "conversation.lifecycle.invalidated",
  "conversation.lifecycle.sync-updated",
  "run.started",
  "run.status",
  "snapshot",
  "done",
  "error",
]);

export interface WorkbenchProjectionEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  close(): void;
}

export type WorkbenchProjectionStreamOptions = {
  createEventSource?: (url: string) => WorkbenchProjectionEventSource;
  onConnected?: (projectId: string) => void;
  onMalformedEvent?: (projectId: string, cause: unknown) => void;
};

export function useWorkbenchProjectionStream(
  projectId: string | null,
  ports: WorkbenchProjectionRoutePorts,
  options: WorkbenchProjectionStreamOptions = {},
): {
  routeEvent: (event: WorkbenchLiveEvent) => WorkbenchProjectionRouteResult;
  routeEventForProject: (projectId: string, event: WorkbenchLiveEvent) => WorkbenchProjectionRouteResult;
} {
  const projectIdRef = useRef(projectId);
  const portsRef = useRef(ports);
  const optionsRef = useRef(options);
  projectIdRef.current = projectId;
  portsRef.current = ports;
  optionsRef.current = options;

  const routeEventForProject = useCallback((eventProjectId: string, event: WorkbenchLiveEvent): WorkbenchProjectionRouteResult => (
    routeWorkbenchProjectionEvent(eventProjectId, event, portsRef.current)
  ), []);

  const routeEvent = useCallback((event: WorkbenchLiveEvent): WorkbenchProjectionRouteResult => {
    const currentProjectId = projectIdRef.current;
    if (!currentProjectId) return { handled: false, event: event.event };
    return routeEventForProject(currentProjectId, event);
  }, [routeEventForProject]);

  useEffect(() => {
    if (!projectId) return;
    const factory = optionsRef.current.createEventSource
      ?? (typeof EventSource === "undefined" ? null : (url: string) => new EventSource(url));
    if (!factory) return;

    const source = factory(`/api/projects/${encodeURIComponent(projectId)}/workbench/events/live`);
    source.onopen = () => optionsRef.current.onConnected?.(projectId);
    source.onmessage = (message) => {
      try {
        routeWorkbenchProjectionEvent(
          projectId,
          JSON.parse(message.data) as WorkbenchLiveEvent,
          portsRef.current,
        );
      } catch (cause) {
        optionsRef.current.onMalformedEvent?.(projectId, cause);
      }
    };
    return () => source.close();
  }, [projectId]);

  return { routeEvent, routeEventForProject };
}
