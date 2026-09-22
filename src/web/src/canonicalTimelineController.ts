import { useCallback, useReducer, useRef } from "react";
import { fetchJson } from "./api.js";
import { userFacingErrorMessage } from "./presentation/user-facing-language.js";
import {
  canonicalTimelineReducer,
  canonicalTimelineScopeKey,
  createCanonicalTimelineState,
  type CanonicalTimelineRequestKind,
  type PendingUserIntentState,
} from "./canonicalTimelineStore.js";
import type { CanonicalTimelineEnvelope, CanonicalTimelinePage, CanonicalTimelineScope } from "./types.js";

export type CanonicalTimelineReconnectCandidate = {
  target: {
    kind: string;
    conversationId?: string;
    agentSurfaceId?: string;
  };
};

export function canonicalTimelineReconnectScopes(
  projectId: string,
  productMode: CanonicalTimelineScope["productMode"],
  conversationId: string,
  candidates: readonly CanonicalTimelineReconnectCandidate[],
): CanonicalTimelineScope[] {
  const surfaceIds = new Set(["main-agent"]);
  for (const candidate of candidates) {
    if (candidate.target.kind === "agent"
      && candidate.target.conversationId === conversationId
      && candidate.target.agentSurfaceId) {
      surfaceIds.add(candidate.target.agentSurfaceId);
    }
  }
  return [...surfaceIds].map((agentSurfaceId) => ({ projectId, productMode, conversationId, agentSurfaceId }));
}

export function fetchCanonicalTimelinePage(scope: CanonicalTimelineScope, beforeCursor?: string): Promise<CanonicalTimelinePage> {
  const params = new URLSearchParams({ productMode: scope.productMode, agentSurfaceId: scope.agentSurfaceId, limit: "100" });
  if (beforeCursor) params.set("beforeCursor", beforeCursor);
  return fetchJson<CanonicalTimelinePage>(
    `/api/projects/${encodeURIComponent(scope.projectId)}/workbench/conversations/${encodeURIComponent(scope.conversationId)}/timeline?${params}`,
  );
}

export function useCanonicalTimelineController(onError: (message: string) => void) {
  const [state, dispatch] = useReducer(canonicalTimelineReducer, undefined, createCanonicalTimelineState);
  const generationsRef = useRef(new Map<string, number>());

  const load = useCallback(async (
    scope: CanonicalTimelineScope,
    requestKind: CanonicalTimelineRequestKind,
    beforeCursor?: string,
  ): Promise<void> => {
    const generationKey = `${canonicalTimelineScopeKey(scope)}:${requestKind}`;
    const generation = (generationsRef.current.get(generationKey) ?? 0) + 1;
    generationsRef.current.set(generationKey, generation);
    dispatch({ type: "request.started", scope, requestKind, generation });
    try {
      const page = await fetchCanonicalTimelinePage(scope, beforeCursor);
      dispatch({ type: "page.received", scope, requestKind, generation, page });
    } catch (cause) {
      const message = userFacingErrorMessage(cause, "load");
      dispatch({ type: "request.failed", scope, requestKind, generation, error: message });
      onError(message);
    }
  }, [onError]);

  const loadLatest = useCallback((scope: CanonicalTimelineScope) => load(scope, "latest"), [load]);
  const loadEarlier = useCallback((scope: CanonicalTimelineScope, beforeCursor: string) => (
    load(scope, "before", beforeCursor)
  ), [load]);
  const ingestEnvelope = useCallback((projectId: string, envelope: CanonicalTimelineEnvelope): void => {
    dispatch({ type: "envelope.received", projectId, envelope });
  }, []);
  const showOptimisticUserIntent = useCallback((scope: CanonicalTimelineScope, clientRequestId: string, text: string): void => {
    const messageId = `optimistic:${clientRequestId}`;
    const timestamp = new Date().toISOString();
    dispatch({
      type: "optimistic.received",
      scope,
      envelope: {
        ...scope,
        messageId,
        clientRequestId,
        position: Number.MAX_SAFE_INTEGER,
        revision: 1,
        orderClass: "sequence",
        cells: [{
          id: `pending-user:${clientRequestId}`,
          kind: "user-message",
          source: "user",
          agentSurfaceId: scope.agentSurfaceId,
          timestamp,
          text,
          title: "正在发送",
          status: "sending",
          realtime: true,
          pendingIntent: { clientRequestId, canRetry: false, canRestore: false },
        }],
      },
    });
  }, []);
  const updateOptimisticUserIntent = useCallback((
    scope: CanonicalTimelineScope,
    clientRequestId: string,
    pendingState: PendingUserIntentState,
    failure?: string,
  ): void => {
    dispatch({ type: "optimistic.state-changed", scope, clientRequestId, state: pendingState, failure });
  }, []);
  const consumeOptimisticUserIntentActions = useCallback((
    scope: CanonicalTimelineScope,
    clientRequestId: string,
  ): void => {
    dispatch({ type: "optimistic.actions-consumed", scope, clientRequestId });
  }, []);
  const rekeyOptimisticUserIntent = useCallback((
    from: CanonicalTimelineScope,
    to: CanonicalTimelineScope,
    clientRequestId: string,
  ): void => {
    dispatch({ type: "optimistic.rekeyed", from, to, clientRequestId });
  }, []);
  const discardOptimisticUserIntent = useCallback((scope: CanonicalTimelineScope, clientRequestId: string): void => {
    dispatch({ type: "optimistic.discarded", scope, messageId: `optimistic:${clientRequestId}` });
  }, []);
  const showOptimisticSteer = useCallback((scope: CanonicalTimelineScope, clientRequestId: string, text: string): void => {
    const messageId = `optimistic-steer:${clientRequestId}`;
    const timestamp = new Date().toISOString();
    dispatch({
      type: "optimistic.received",
      scope,
      envelope: {
        ...scope,
        messageId,
        position: Number.MAX_SAFE_INTEGER,
        revision: 1,
        orderClass: "sequence",
        cells: [{
          id: messageId,
          kind: "user-message",
          source: "user",
          agentSurfaceId: scope.agentSurfaceId,
          timestamp,
          text,
          status: "submitting",
          realtime: true,
        }],
      },
    });
  }, []);
  const discardOptimisticSteer = useCallback((scope: CanonicalTimelineScope, clientRequestId: string): void => {
    dispatch({ type: "optimistic.discarded", scope, messageId: `optimistic-steer:${clientRequestId}` });
  }, []);
  const clearProject = useCallback((projectId: string) => {
    dispatch({ type: "project.cleaned", projectId });
  }, []);
  const clearConversation = useCallback((projectId: string, conversationId: string) => {
    dispatch({ type: "conversation.cleaned", projectId, conversationId });
  }, []);

  return {
    state,
    loadLatest,
    loadEarlier,
    ingestEnvelope,
    showOptimisticUserIntent,
    updateOptimisticUserIntent,
    consumeOptimisticUserIntentActions,
    rekeyOptimisticUserIntent,
    discardOptimisticUserIntent,
    showOptimisticSteer,
    discardOptimisticSteer,
    clearProject,
    clearConversation,
  };
}
