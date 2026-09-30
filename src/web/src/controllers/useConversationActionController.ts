import { useCallback, useRef } from "react";
import { consumeWorkbenchLiveStream, postJson } from "../api.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type { ConversationInteractionDraft } from "../panels/workbench/ConversationInteractionDock.js";
import type {
  ConversationInteractionSettlement,
  DecisionAction,
  DecisionContext,
  Snapshot,
  ProductMode,
  WorkbenchLiveEvent,
} from "../types.js";
import { workflowActionPayloadFromScope } from "../workflow-actions.js";
import type { WorkbenchOperationToken } from "./useGlobalOperationGate.js";

export interface ConversationActionOperationGate {
  begin: (key: string) => WorkbenchOperationToken;
  release: (token: WorkbenchOperationToken) => void;
}

export interface ConversationActionSession {
  projectId: string | null;
  conversationId: string | null;
  selectedTopicId: string | null;
  snapshot: Snapshot;
  composerText: string;
}

export interface ConversationActionPorts {
  operationGate: ConversationActionOperationGate;
  routeProjectionEvent: (projectId: string, event: WorkbenchLiveEvent) => void;
  refreshSession: (projectId: string, conversationId: string | null) => Promise<Snapshot | null | void>;
  calibrateTimeline: (input: {
    projectId: string;
    productMode: Snapshot["productMode"];
    conversationId: string;
    agentSurfaceId: "main-agent";
  }) => Promise<void>;
  postJson?: <T>(url: string, body: unknown) => Promise<T>;
  consumeLiveStream?: (
    url: string,
    body: unknown,
    onEvent: (event: WorkbenchLiveEvent) => void,
  ) => Promise<void>;
  applySnapshot: (snapshot: Snapshot) => void;
  cacheProjectSnapshot: (projectId: string, snapshot: Snapshot) => void;
  setComposerText: (value: string) => void;
  setError: (message: string | null) => void;
  clearConfirmation: () => void;
  chooseRun: (runId: string) => Promise<void>;
  openOrchestration: () => void;
  navigateConversation: (conversationId: string) => Promise<void>;
  requestReanalysisMessage?: () => string | null;
}

export interface UseConversationActionControllerOptions {
  session: ConversationActionSession;
  ports: ConversationActionPorts;
}

export type ConversationSteerOutcome =
  | { status: "accepted" }
  | { status: "already-terminal" };

export interface ConversationActionController {
  executeDecisionAction: (action: DecisionAction, context: DecisionContext) => Promise<void>;
  requestDecisionFeedback: (context: DecisionContext, action: DecisionAction, feedback: string) => Promise<void>;
  runWorkflowAction: (actionType: string, options?: Record<string, unknown>) => Promise<void>;
  interruptTurn: (request: {
    productMode?: ProductMode;
    projectId: string;
    conversationId: string;
    providerId: string;
    expectedAttemptId: string;
  }) => Promise<void>;
  steerAgentTurn: (request: {
    projectId: string;
    conversationId: string;
    providerId: string;
    expectedAttemptId: string;
    clientRequestId: string;
    text: string;
  }) => Promise<ConversationSteerOutcome>;
  steerHarnessTurn: (request: {
    projectId: string;
    conversationId: string;
    clientRequestId: string;
    text: string;
  }) => Promise<ConversationSteerOutcome>;
  retryAgentTurn: (request: {
    projectId: string;
    conversationId: string;
    providerId: string;
    expectedAttemptId: string;
    sourceMessageId: string;
    clientRequestId: string;
  }) => Promise<void>;
  forkAgentConversation: (request: {
    projectId: string;
    conversationId: string;
    providerId: string;
    sourceMessageId: string;
    expectedCompletedTurnSequence: number;
    expectedTimelineRevision: number;
    contextRevision: string;
    clientRequestId: string;
  }) => Promise<{ targetConversationId: string }>;
  settleInteraction: (interactionId: string, settlement: ConversationInteractionSettlement) => Promise<void>;
  getInteractionDraft: (interactionId: string) => ConversationInteractionDraft | undefined;
  setInteractionDraft: (interactionId: string, draft: ConversationInteractionDraft) => void;
  clearInteractionDrafts: (scope?: { projectId?: string; conversationId?: string }) => void;
}

export function useConversationActionController({
  session,
  ports,
}: UseConversationActionControllerOptions): ConversationActionController {
  const sessionRef = useRef(session);
  const portsRef = useRef(ports);
  const interactionDraftsRef = useRef(new Map<string, ConversationInteractionDraft>());
  const retryRequestRef = useRef<{ key: string; clientRequestId: string } | null>(null);
  const forkRequestRef = useRef<{ key: string; clientRequestId: string } | null>(null);
  sessionRef.current = session;
  portsRef.current = ports;
  const isCurrentScope = (projectId: string, conversationId: string | null): boolean => (
    sessionRef.current.projectId === projectId && sessionRef.current.conversationId === conversationId
  );

  const runWorkflowAction = useCallback(async (
    actionType: string,
    options: Record<string, unknown> = {},
  ): Promise<void> => {
    const current = sessionRef.current;
    const actionPorts = portsRef.current;
    const request = actionPorts.postJson ?? postJson;
    const consume = actionPorts.consumeLiveStream
      ?? ((url, body, onEvent) => consumeWorkbenchLiveStream<WorkbenchLiveEvent>(url, body, onEvent));
    const { preserveSelectedTopic, ...actionOptions } = options;
    const shouldPreserveSelectedTopic = preserveSelectedTopic === true;
    if (!current.projectId || !current.conversationId) return;

    const projectId = current.projectId;
    const conversationId = current.conversationId;
    const topicBeforeAction = conversationId ?? current.selectedTopicId;
    const snapshotBeforeAction = current.snapshot;
    const operationToken = actionPorts.operationGate.begin(actionType);
    actionPorts.setError(null);
    try {
      if (actionType === "intake.scan") {
        const result = await request<{ snapshot: Snapshot }>(
          `/api/projects/${encodeURIComponent(projectId)}/workbench/intake/scan`,
          {
            changeId: conversationId,
            prompt: current.composerText.trim() || snapshotBeforeAction.center.selectedTopic?.title || "",
          },
        );
        if (isCurrentScope(projectId, conversationId)) {
          actionPorts.applySnapshot(result.snapshot);
          if (current.composerText.trim()) actionPorts.setComposerText("");
        }
        return;
      }

      if (actionType === "intake.reanalyze") {
        const requested = actionPorts.requestReanalysisMessage
          ? actionPorts.requestReanalysisMessage()
          : typeof window === "undefined" ? null : window.prompt("补充需求或回答需要确认的问题");
        const message = (current.composerText.trim() || requested || "").trim();
        if (!message) return;
        const result = await request<{ snapshot: Snapshot }>(
          `/api/projects/${encodeURIComponent(projectId)}/workbench/intake/reanalyze`,
          { changeId: conversationId, message },
        );
        if (isCurrentScope(projectId, conversationId)) {
          actionPorts.applySnapshot(result.snapshot);
          actionPorts.setComposerText("");
        }
        return;
      }

      await consume(
        `/api/projects/${encodeURIComponent(projectId)}/workbench/actions/live`,
        {
          actionType,
          changeId: conversationId,
          confirm: true,
          prompt: current.composerText.trim() || undefined,
          ...actionOptions,
        },
        (event) => {
          if (isCurrentScope(projectId, conversationId)) actionPorts.routeProjectionEvent(projectId, event);
        },
      );

      if (shouldPreserveSelectedTopic && topicBeforeAction && isCurrentScope(projectId, conversationId)) {
        const refreshed = await actionPorts.refreshSession(projectId, topicBeforeAction);
        if (refreshed && !refreshed.center.selectedTopic && snapshotBeforeAction.center.selectedTopic?.id === topicBeforeAction) {
          const restored = preserveSelectedWorkbenchTopic(refreshed, snapshotBeforeAction);
          actionPorts.applySnapshot(restored);
          actionPorts.cacheProjectSnapshot(projectId, restored);
        }
      }
      if (current.composerText.trim() && isCurrentScope(projectId, conversationId)) actionPorts.setComposerText("");
    } finally {
      try {
        if (isCurrentScope(projectId, conversationId)) {
          await actionPorts.calibrateTimeline({ projectId, productMode: current.snapshot.productMode, conversationId, agentSurfaceId: "main-agent" });
        }
      } finally {
        actionPorts.operationGate.release(operationToken);
      }
    }
  }, []);

  const executeDecisionAction = useCallback(async (
    action: DecisionAction,
    context: DecisionContext,
  ): Promise<void> => {
    const current = sessionRef.current;
    const actionPorts = portsRef.current;
    if (!current.projectId || !action.enabled) return;

    if (action.kind === "workflow-action" && action.actionType) {
      await runWorkflowAction(action.actionType, workflowActionPayloadFromScope(action, {
        changeId: action.changeId ?? context.changeId,
        worktreeId: action.worktreeId ?? context.targetId,
      }));
      return;
    }

    if (action.kind === "evidence" && context.runId) {
      await actionPorts.chooseRun(context.runId);
      actionPorts.openOrchestration();
      return;
    }

    if (action.kind !== "approval" && action.kind !== "abandon") return;
    if (action.kind === "approval" && !action.action) return;

    const projectId = current.projectId;
    const currentTopic = current.snapshot.center.selectedTopic?.id === current.conversationId
      ? current.snapshot.center.selectedTopic
      : current.snapshot.left.topics.find((topic) => topic.id === current.conversationId);
    if (action.kind === "abandon" && (!context.changeId || !current.conversationId || !currentTopic?.graphScopeId)) {
      throw new Error("Abandon requires the current Conversation, graph, and Change identity.");
    }
    const operationToken = actionPorts.operationGate.begin(`decision.${action.id}`);
    try {
      const body = action.kind === "approval"
        ? action.options
          ? { action: action.action, confirm: true, options: action.options }
          : { action: action.action, confirm: true }
        : {
            abandon: {
              changeId: context.changeId,
              conversationId: current.conversationId,
              graphScopeId: currentTopic?.graphScopeId,
              reason: "用户选择放弃这个需求。",
            },
            confirm: true,
            feedbackContext: {
              contextId: context.id,
              changeId: context.changeId,
              targetId: context.targetId,
              runId: context.runId,
            },
          };
      await (actionPorts.postJson ?? postJson)(`/api/projects/${encodeURIComponent(projectId)}/workbench/actions`, body);
      actionPorts.clearConfirmation();
      if (isCurrentScope(projectId, current.conversationId)) {
        await actionPorts.refreshSession(projectId, current.conversationId);
      }
    } finally {
      actionPorts.operationGate.release(operationToken);
    }
  }, [runWorkflowAction]);

  const interruptTurn = useCallback(async (request: {
    productMode?: ProductMode;
    projectId: string;
    conversationId: string;
    providerId: string;
    expectedAttemptId: string;
  }): Promise<void> => {
    await (portsRef.current.postJson ?? postJson)(
      `/api/projects/${encodeURIComponent(request.projectId)}/workbench/conversations/${encodeURIComponent(request.conversationId)}/turn/interrupt`,
      {
        productMode: request.productMode ?? "agent",
        providerId: request.providerId,
        expectedAttemptId: request.expectedAttemptId,
      },
    );
  }, []);

  const steerAgentTurn = useCallback(async (request: {
    projectId: string;
    conversationId: string;
    providerId: string;
    expectedAttemptId: string;
    clientRequestId: string;
    text: string;
  }): Promise<ConversationSteerOutcome> => {
    const receipt = await (portsRef.current.postJson ?? postJson)<unknown>(
      `/api/projects/${encodeURIComponent(request.projectId)}/workbench/conversations/${encodeURIComponent(request.conversationId)}/turn/steer`,
      {
        productMode: "agent",
        providerId: request.providerId,
        expectedAttemptId: request.expectedAttemptId,
        clientRequestId: request.clientRequestId,
        text: request.text,
      },
    );
    return conversationSteerOutcome(receipt);
  }, []);

  const steerHarnessTurn = useCallback(async (request: {
    projectId: string;
    conversationId: string;
    clientRequestId: string;
    text: string;
  }): Promise<ConversationSteerOutcome> => {
    const actionPorts = portsRef.current;
    const response = await (actionPorts.postJson ?? postJson)<{ result: unknown; snapshot: Snapshot }>(
      `/api/projects/${encodeURIComponent(request.projectId)}/workbench/actions`,
      {
        actionType: "conversation.steer",
        changeId: request.conversationId,
        confirm: true,
        clientRequestId: request.clientRequestId,
        prompt: request.text,
      },
    );
    if (isCurrentScope(request.projectId, request.conversationId)) {
      actionPorts.applySnapshot(response.snapshot);
      actionPorts.cacheProjectSnapshot(request.projectId, response.snapshot);
    }
    return conversationSteerOutcomeFromWorkflowAction(response.result);
  }, []);

  const retryAgentTurn = useCallback(async (request: {
    projectId: string;
    conversationId: string;
    providerId: string;
    expectedAttemptId: string;
    sourceMessageId: string;
    clientRequestId: string;
  }): Promise<void> => {
    const actionPorts = portsRef.current;
    const retryKey = [
      request.projectId,
      request.conversationId,
      request.providerId,
      request.expectedAttemptId,
      request.sourceMessageId,
    ].join("\0");
    const clientRequestId = retryRequestRef.current?.key === retryKey
      ? retryRequestRef.current.clientRequestId
      : request.clientRequestId;
    retryRequestRef.current = { key: retryKey, clientRequestId };
    const operationToken = actionPorts.operationGate.begin(`conversation.retry.${request.expectedAttemptId}`);
    actionPorts.setError(null);
    let liveFailure: string | null = null;
    const ownsScope = (): boolean => {
      const current = sessionRef.current;
      const topic = current.snapshot.center.selectedTopic?.id === request.conversationId
        ? current.snapshot.center.selectedTopic
        : current.snapshot.left.topics.find((candidate) => candidate.id === request.conversationId);
      return current.projectId === request.projectId
        && current.conversationId === request.conversationId
        && current.snapshot.productMode === "agent"
        && topic?.selectedProviderId === request.providerId;
    };
    try {
      await (actionPorts.consumeLiveStream ?? ((url, body, onEvent) => consumeWorkbenchLiveStream<WorkbenchLiveEvent>(url, body, onEvent)))(
        `/api/projects/${encodeURIComponent(request.projectId)}/workbench/conversations/${encodeURIComponent(request.conversationId)}/turn/retry/live`,
        {
          productMode: "agent",
          providerId: request.providerId,
          expectedAttemptId: request.expectedAttemptId,
          sourceMessageId: request.sourceMessageId,
          clientRequestId,
        },
        (event) => {
          if (event.event === "error") liveFailure = event.data.message;
          if (event.event === "done" && event.data.status === "failed" && !liveFailure) {
            liveFailure = "重试未能完成，请再试一次。";
          }
          if (ownsScope()) actionPorts.routeProjectionEvent(request.projectId, event);
        },
      );
      if (liveFailure) throw new Error(liveFailure);
      if (retryRequestRef.current?.key === retryKey
        && retryRequestRef.current.clientRequestId === clientRequestId) {
        retryRequestRef.current = null;
      }
    } catch (error) {
      if (ownsScope()) actionPorts.setError(userFacingErrorMessage(error, "conversation"));
      throw error;
    } finally {
      try {
        if (ownsScope()) {
          await actionPorts.calibrateTimeline({
            projectId: request.projectId,
            productMode: "agent",
            conversationId: request.conversationId,
            agentSurfaceId: "main-agent",
          });
          await actionPorts.refreshSession(request.projectId, request.conversationId);
        }
      } finally {
        actionPorts.operationGate.release(operationToken);
      }
    }
  }, []);

  const forkAgentConversation = useCallback(async (request: {
    projectId: string;
    conversationId: string;
    providerId: string;
    sourceMessageId: string;
    expectedCompletedTurnSequence: number;
    expectedTimelineRevision: number;
    contextRevision: string;
    clientRequestId: string;
  }): Promise<{ targetConversationId: string }> => {
    const actionPorts = portsRef.current;
    const forkKey = [
      request.projectId,
      request.conversationId,
      request.providerId,
      request.sourceMessageId,
      request.expectedCompletedTurnSequence,
      request.expectedTimelineRevision,
      request.contextRevision,
    ].join("\0");
    const clientRequestId = forkRequestRef.current?.key === forkKey
      ? forkRequestRef.current.clientRequestId
      : request.clientRequestId;
    forkRequestRef.current = { key: forkKey, clientRequestId };
    const operationToken = actionPorts.operationGate.begin(`conversation.fork.${request.sourceMessageId}`);
    actionPorts.setError(null);
    const ownsSourceScope = (): boolean => {
      const current = sessionRef.current;
      const topic = current.snapshot.center.selectedTopic;
      return current.projectId === request.projectId
        && current.conversationId === request.conversationId
        && current.snapshot.productMode === "agent"
        && topic?.id === request.conversationId
        && topic.selectedProviderId === request.providerId
        && topic.timelineRevision === request.expectedTimelineRevision
        && current.snapshot.center.conversationContext?.contextRevision === request.contextRevision;
    };
    try {
      const receipt = await (actionPorts.postJson ?? postJson)<{
        status: "forked" | "replayed";
        sourceConversationId: string;
        targetConversationId: string;
      }>(
        `/api/projects/${encodeURIComponent(request.projectId)}/workbench/conversations/${encodeURIComponent(request.conversationId)}/fork`,
        {
          productMode: "agent",
          providerId: request.providerId,
          sourceMessageId: request.sourceMessageId,
          expectedCompletedTurnSequence: request.expectedCompletedTurnSequence,
          expectedTimelineRevision: request.expectedTimelineRevision,
          contextRevision: request.contextRevision,
          clientRequestId,
        },
      );
      if (receipt.sourceConversationId !== request.conversationId || !receipt.targetConversationId) {
        throw new Error("Conversation fork returned invalid target identity.");
      }
      if (ownsSourceScope()) await actionPorts.navigateConversation(receipt.targetConversationId);
      if (forkRequestRef.current?.key === forkKey && forkRequestRef.current.clientRequestId === clientRequestId) {
        forkRequestRef.current = null;
      }
      return { targetConversationId: receipt.targetConversationId };
    } catch (error) {
      if (ownsSourceScope()) actionPorts.setError(userFacingErrorMessage(error, "conversation"));
      throw error;
    } finally {
      actionPorts.operationGate.release(operationToken);
    }
  }, []);

  const requestDecisionFeedback = useCallback(async (
    context: DecisionContext,
    action: DecisionAction,
    feedback: string,
  ): Promise<void> => {
    const current = sessionRef.current;
    const trimmedFeedback = feedback.trim();
    if (!current.projectId || !trimmedFeedback) return;
    if (action.actionType) {
      await runWorkflowAction(action.actionType, {
        ...workflowActionPayloadFromScope(action, {
          changeId: action.changeId ?? context.changeId,
          worktreeId: action.worktreeId ?? context.targetId,
        }),
        feedback: trimmedFeedback,
      });
      return;
    }

    const projectId = current.projectId;
    const actionPorts = portsRef.current;
    const operationToken = actionPorts.operationGate.begin(`decision.feedback.${action.id}`);
    try {
      await (actionPorts.postJson ?? postJson)(`/api/projects/${encodeURIComponent(projectId)}/workbench/actions`, {
        action: action.action,
        feedback: trimmedFeedback,
        feedbackContext: {
          contextId: context.id,
          actionId: action.id,
          actionKind: action.kind,
          actionType: action.actionType,
          approvalActionId: action.action?.actionId,
          approvalId: action.approvalId,
          changeId: context.changeId,
          targetId: context.targetId,
          runId: context.runId,
          worktreeId: action.worktreeId ?? context.targetId,
          applyCheckId: action.applyCheckId,
          landingPackageId: action.landingPackageId,
          artifact: action.artifact ?? context.artifact,
        },
      });
      if (isCurrentScope(projectId, current.conversationId)) {
        await actionPorts.refreshSession(projectId, current.conversationId);
      }
    } finally {
      actionPorts.operationGate.release(operationToken);
    }
  }, [runWorkflowAction]);

  const settleInteraction = useCallback(async (
    interactionId: string,
    settlement: ConversationInteractionSettlement,
  ): Promise<void> => {
    const current = sessionRef.current;
    const actionPorts = portsRef.current;
    if (!current.projectId || !current.conversationId) return;
    const projectId = current.projectId;
    const conversationId = current.conversationId;
    const draftKey = interactionDraftKey(projectId, conversationId, interactionId);
    const operationToken = actionPorts.operationGate.begin(`interaction.${settlement.action}`);
    actionPorts.setError(null);
    let failed = false;
    try {
      await (actionPorts.consumeLiveStream ?? ((url, body, onEvent) => consumeWorkbenchLiveStream<WorkbenchLiveEvent>(url, body, onEvent)))(
        `/api/projects/${encodeURIComponent(projectId)}/workbench/conversations/${encodeURIComponent(conversationId)}/interactions/${encodeURIComponent(interactionId)}/settle`,
        { ...settlement, productMode: current.snapshot.productMode },
        (event) => {
          if (event.event === "error") failed = true;
          if (event.event === "snapshot") {
            const interaction = event.data.center.conversationInteractions?.items.find(
              (item) => item.interactionId === interactionId,
            );
            if (interaction?.status === "submitting") interactionDraftsRef.current.delete(draftKey);
          }
          if (isCurrentScope(projectId, conversationId)) actionPorts.routeProjectionEvent(projectId, event);
        },
      );
      if (!failed) interactionDraftsRef.current.delete(draftKey);
    } finally {
      try {
        if (isCurrentScope(projectId, conversationId)) {
          await actionPorts.calibrateTimeline({ projectId, productMode: current.snapshot.productMode, conversationId, agentSurfaceId: "main-agent" });
        }
      } finally {
        actionPorts.operationGate.release(operationToken);
      }
    }
  }, []);

  const getInteractionDraft = useCallback((interactionId: string): ConversationInteractionDraft | undefined => {
    const current = sessionRef.current;
    if (!current.projectId || !current.conversationId) return undefined;
    return interactionDraftsRef.current.get(interactionDraftKey(current.projectId, current.conversationId, interactionId));
  }, []);

  const setInteractionDraft = useCallback((interactionId: string, draft: ConversationInteractionDraft): void => {
    const current = sessionRef.current;
    if (!current.projectId || !current.conversationId) return;
    interactionDraftsRef.current.set(interactionDraftKey(current.projectId, current.conversationId, interactionId), draft);
  }, []);

  const clearInteractionDrafts = useCallback((scope?: { projectId?: string; conversationId?: string }): void => {
    if (!scope?.projectId && !scope?.conversationId) {
      interactionDraftsRef.current.clear();
      return;
    }
    for (const key of interactionDraftsRef.current.keys()) {
      const [projectId, conversationId] = JSON.parse(key) as [string, string, string];
      if (scope.projectId && scope.projectId !== projectId) continue;
      if (scope.conversationId && scope.conversationId !== conversationId) continue;
      interactionDraftsRef.current.delete(key);
    }
  }, []);

  return {
    executeDecisionAction,
    requestDecisionFeedback,
    runWorkflowAction,
    interruptTurn,
    steerAgentTurn,
    steerHarnessTurn,
    retryAgentTurn,
    forkAgentConversation,
    settleInteraction,
    getInteractionDraft,
    setInteractionDraft,
    clearInteractionDrafts,
  };
}

function conversationSteerOutcome(value: unknown): ConversationSteerOutcome {
  const status = value && typeof value === "object" && "status" in value
    ? (value as { status?: unknown }).status
    : undefined;
  if (status === "steer-accepted" || status === "steered") return { status: "accepted" };
  if (status === "already-terminal") return { status: "already-terminal" };
  throw new Error("Conversation steering returned an invalid settlement.");
}

function conversationSteerOutcomeFromWorkflowAction(value: unknown): ConversationSteerOutcome {
  if (!value || typeof value !== "object") {
    throw new Error("Conversation steering returned an invalid workflow settlement.");
  }
  const action = value as { status?: unknown; result?: unknown; error?: unknown };
  if (action.status === "failed") {
    throw new Error(typeof action.error === "string" && action.error.trim()
      ? action.error
      : "Conversation steering failed.");
  }
  if (action.status !== "completed") {
    throw new Error("Conversation steering returned an invalid workflow settlement.");
  }
  return conversationSteerOutcome(action.result);
}

export function preserveSelectedWorkbenchTopic(next: Snapshot, previous: Snapshot): Snapshot {
  return {
    ...next,
    center: {
      ...next.center,
      selectedTopic: previous.center.selectedTopic,
      workpad: previous.center.workpad,
      agentLoop: previous.center.agentLoop,
    },
    right: {
      ...next.right,
    },
  };
}

function interactionDraftKey(projectId: string, conversationId: string, interactionId: string): string {
  return JSON.stringify([projectId, conversationId, interactionId]);
}
