import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, postJson } from "../api.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type {
  ConversationTurnQueueSnapshot,
  ProductMode,
  WorkbenchLiveEvent,
} from "../types.js";
import type { ConversationTurnQueueEnqueueInput } from "./conversation-turn-queue-contract.js";

export function useConversationTurnQueueController(input: {
  projectId: string | null;
  productMode: ProductMode;
  conversationId: string | null;
  executionKey?: string | null;
  onError(message: string): void;
}) {
  const [snapshot, setSnapshot] = useState<ConversationTurnQueueSnapshot | null>(null);
  const [snapshotCalibrationKey, setSnapshotCalibrationKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const identity = queueIdentity(input);
  const identityRef = useRef(identity);
  const inputRef = useRef(input);
  const snapshotRef = useRef(snapshot);
  const snapshotCalibrationKeyRef = useRef<string | null>(null);
  const responseGenerationRef = useRef(0);
  const dispatchRevisionRef = useRef<string | null>(null);
  const enqueueRetryRef = useRef(new Map<string, ConversationTurnQueueEnqueueInput & { productMode: ProductMode; clientRequestId: string; expectedRevision: string; expectedExecutionRevision: string }>());
  const guideRetryRef = useRef(new Map<string, Record<string, unknown>>());
  const confirmationRetryRef = useRef<{ key: string; clientRequestId: string } | null>(null);
  const invalidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executionKeyRef = useRef(input.executionKey ?? "");
  identityRef.current = identity;
  inputRef.current = input;
  snapshotRef.current = snapshot;

  const load = useCallback(async (): Promise<ConversationTurnQueueSnapshot | null> => {
    const current = inputRef.current;
    if (!current.projectId || !isCanonicalConversationId(current.conversationId)) {
      setSnapshot(null);
      return null;
    }
    const requestIdentity = queueIdentity(current);
    const requestCalibrationKey = queueCalibrationKey(current);
    const generation = ++responseGenerationRef.current;
    setLoading(true);
    try {
      const result = await fetchJson<ConversationTurnQueueSnapshot>(queueReadUrl(current));
      if (identityRef.current === requestIdentity && generation === responseGenerationRef.current) {
        setSnapshot(result);
        snapshotRef.current = result;
        setSnapshotCalibrationKey(requestCalibrationKey);
        snapshotCalibrationKeyRef.current = requestCalibrationKey;
      }
      return result;
    } catch (cause) {
      if (identityRef.current === requestIdentity && generation === responseGenerationRef.current) {
        current.onError(errorMessage(cause));
      }
      return null;
    } finally {
      if (identityRef.current === requestIdentity && generation === responseGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    dispatchRevisionRef.current = null;
    confirmationRetryRef.current = null;
    setMutating(false);
    setSnapshot(null);
    setSnapshotCalibrationKey(null);
    snapshotCalibrationKeyRef.current = null;
    void load();
  }, [identity, load]);

  useEffect(() => {
    const nextExecutionKey = input.executionKey ?? "";
    if (executionKeyRef.current === nextExecutionKey) return;
    executionKeyRef.current = nextExecutionKey;
    void load();
  }, [input.executionKey, load]);

  useEffect(() => () => {
    if (invalidationTimerRef.current) clearTimeout(invalidationTimerRef.current);
  }, []);

  const applyMutation = useCallback(async (
    action: (current: typeof input, snapshot: ConversationTurnQueueSnapshot) => Promise<ConversationTurnQueueSnapshot>,
  ): Promise<ConversationTurnQueueSnapshot | null> => {
    const current = inputRef.current;
    const currentSnapshot = snapshotRef.current;
    if (!current.projectId || !isCanonicalConversationId(current.conversationId) || !currentSnapshot
      || snapshotCalibrationKeyRef.current !== queueCalibrationKey(current)) return null;
    const requestIdentity = queueIdentity(current);
    const responseGeneration = ++responseGenerationRef.current;
    setMutating(true);
    try {
      const result = await action(current, currentSnapshot);
      if (identityRef.current === requestIdentity && responseGeneration === responseGenerationRef.current) {
        setSnapshot(result);
        snapshotRef.current = result;
        const calibrationKey = queueCalibrationKey(current);
        setSnapshotCalibrationKey(calibrationKey);
        snapshotCalibrationKeyRef.current = calibrationKey;
      }
      return result;
    } catch (cause) {
      if (identityRef.current === requestIdentity && responseGeneration === responseGenerationRef.current) {
        current.onError(errorMessage(cause));
        await load();
      }
      throw cause;
    } finally {
      if (identityRef.current === requestIdentity) setMutating(false);
    }
  }, [load]);

  const enqueue = useCallback(async (queuedInput: ConversationTurnQueueEnqueueInput) => {
    const key = `${identityRef.current}\0${JSON.stringify({ ...queuedInput, expectedDraftUpdatedAt: undefined })}`;
    const result = await applyMutation((current, currentSnapshot) => {
      if (!currentSnapshot.executionRevision) throw new Error("Conversation execution identity is unavailable.");
      if (!enqueueRetryRef.current.has(key)) enqueueRetryRef.current.set(key, structuredClone({
        ...queuedInput, productMode: current.productMode, clientRequestId: createRequestId("turn-queue"),
        expectedRevision: currentSnapshot.revision, expectedExecutionRevision: currentSnapshot.executionRevision,
      }));
      return postJson<ConversationTurnQueueSnapshot>(baseQueueUrl(current), enqueueRetryRef.current.get(key)!);
    });
    if (result) enqueueRetryRef.current.delete(key);
    return result;
  }, [applyMutation]);

  const remove = useCallback((queueItemId: string) => applyMutation(async (current, currentSnapshot) => {
    const response = await fetch(`${baseQueueUrl(current)}/${encodeURIComponent(queueItemId)}?${new URLSearchParams({
      productMode: current.productMode,
      expectedRevision: currentSnapshot.revision,
    }).toString()}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<ConversationTurnQueueSnapshot>;
  }), [applyMutation]);

  const guide = useCallback(async (queueItemId: string) => {
    const key = `${identityRef.current}\0${queueItemId}`;
    const result = await applyMutation((current, currentSnapshot) => {
      const item = currentSnapshot.items.find((candidate) => candidate.queueItemId === queueItemId);
      if (!guideRetryRef.current.has(key)) {
        if (!currentSnapshot.guideTarget || !currentSnapshot.executionRevision || !item?.guideMode || item.guideMode === "unavailable") throw new Error("当前执行暂不允许引导。");
        guideRetryRef.current.set(key, {
          productMode: current.productMode, expectedRevision: currentSnapshot.revision,
          expectedExecutionRevision: currentSnapshot.executionRevision, providerId: currentSnapshot.guideTarget.providerId,
          expectedAttemptId: currentSnapshot.guideTarget.attemptId, clientRequestId: createRequestId("turn-queue-guide"),
        });
      }
      return postJson<ConversationTurnQueueSnapshot>(`${baseQueueUrl(current)}/${encodeURIComponent(queueItemId)}/guide`, guideRetryRef.current.get(key)!);
    });
    if (result) guideRetryRef.current.delete(key);
    return result;
  }, [applyMutation]);

  const reclaim = useCallback((queueItemId: string, expectedDraftUpdatedAt: string | null) => applyMutation(
    (current, currentSnapshot) => postJson<ConversationTurnQueueSnapshot>(
      `${baseQueueUrl(current)}/${encodeURIComponent(queueItemId)}/reclaim`,
      { productMode: current.productMode, expectedRevision: currentSnapshot.revision, expectedDraftUpdatedAt },
    ),
  ), [applyMutation]);

  const retry = useCallback((queueItemId: string) => applyMutation(
    (current, currentSnapshot) => postJson<ConversationTurnQueueSnapshot>(
      `${baseQueueUrl(current)}/${encodeURIComponent(queueItemId)}/retry`,
      { productMode: current.productMode, expectedRevision: currentSnapshot.revision },
    ),
  ), [applyMutation]);

  const confirmExecutionContract = useCallback(async (queueItemId: string) => {
    const item = snapshotRef.current?.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || item.executionCompatibility.state === "compatible") return snapshotRef.current;
    const compatibility = item.executionCompatibility;
    const key = JSON.stringify({
      queueItemId,
      created: compatibility.created,
      target: compatibility.target,
    });
    const clientRequestId = confirmationRetryRef.current?.key === key
      ? confirmationRetryRef.current.clientRequestId
      : createRequestId("queue-execution-confirmation");
    confirmationRetryRef.current = { key, clientRequestId };
    const result = await applyMutation((current, currentSnapshot) => postJson<ConversationTurnQueueSnapshot>(
      `${baseQueueUrl(current)}/${encodeURIComponent(queueItemId)}/confirm-execution`,
      {
        productMode: current.productMode,
        expectedRevision: currentSnapshot.revision,
        clientRequestId,
        expectedCreatedContract: compatibility.created,
        expectedTargetContract: compatibility.target,
      },
    ));
    if (result && confirmationRetryRef.current?.key === key) confirmationRetryRef.current = null;
    return result;
  }, [applyMutation]);

  const dispatchNext = useCallback(async (): Promise<ConversationTurnQueueSnapshot | null> => {
    const current = inputRef.current;
    const currentSnapshot = snapshotRef.current;
    if (!current.projectId || !isCanonicalConversationId(current.conversationId) || !currentSnapshot) return null;
    const requestIdentity = queueIdentity(current);
    try {
      const result = await postJson<ConversationTurnQueueSnapshot>(
        `${baseQueueUrl(current)}/dispatch-next`,
        { productMode: current.productMode, expectedRevision: currentSnapshot.revision },
      );
      if (identityRef.current === requestIdentity) {
        dispatchRevisionRef.current = null;
        await load();
      }
      return result;
    } catch (cause) {
      if (identityRef.current === requestIdentity) {
        dispatchRevisionRef.current = null;
        current.onError(errorMessage(cause));
        await load();
      }
      throw cause;
    }
  }, [load]);

  const currentCalibrationKey = queueCalibrationKey(input);
  const currentSnapshot = snapshotCalibrationKey === currentCalibrationKey ? snapshot : null;

  useEffect(() => {
    if (!currentSnapshot?.canDispatch) {
      dispatchRevisionRef.current = null;
      return;
    }
    if (mutating || dispatchRevisionRef.current === currentSnapshot.revision) return;
    dispatchRevisionRef.current = currentSnapshot.revision;
    void dispatchNext().catch(() => undefined);
  }, [currentSnapshot?.canDispatch, currentSnapshot?.revision, dispatchNext, mutating, snapshotCalibrationKey]);

  const handleEvent = useCallback((projectId: string, event: WorkbenchLiveEvent): void => {
    const current = inputRef.current;
    if (projectId !== current.projectId || !isCanonicalConversationId(current.conversationId)
      || !eventInvalidatesSelectedConversation(event, current.conversationId)) return;
    if (invalidationTimerRef.current) clearTimeout(invalidationTimerRef.current);
    invalidationTimerRef.current = setTimeout(() => {
      invalidationTimerRef.current = null;
      void load();
    }, 80);
  }, [load]);

  const calibrating = Boolean(input.projectId && isCanonicalConversationId(input.conversationId))
    && snapshotCalibrationKey !== currentCalibrationKey;
  return {
    snapshot: currentSnapshot,
    loading: (loading && !currentSnapshot) || calibrating,
    mutating,
    load,
    enqueue,
    guide,
    remove,
    reclaim,
    retry,
    confirmExecutionContract,
    dispatchNext,
    handleEvent,
  };
}

function eventInvalidatesSelectedConversation(event: WorkbenchLiveEvent, conversationId: string): boolean {
  switch (event.event) {
    case "snapshot":
      return true;
    case "topic.created":
      return event.data.conversationId === conversationId;
    case "topic.updated":
      return event.data.conversation.id === conversationId;
    case "conversation.interactions.updated":
    case "agent-surfaces.invalidated":
    case "conversation.turn-control.invalidated":
    case "conversation.context.invalidated":
    case "conversation.turn-queue.invalidated":
    case "run.started":
    case "run.status":
    case "assistant.delta":
    case "usage":
    case "error":
    case "done":
      return event.data.conversationId === conversationId;
    case "conversation.fork.completed":
      return event.data.sourceConversationId === conversationId || event.data.targetConversationId === conversationId;
    case "assistant.event":
    case "tool.event":
      return event.data.conversationId === conversationId;
    default:
      return false;
  }
}

function queueIdentity(input: { projectId: string | null; productMode: ProductMode; conversationId: string | null }): string {
  return [input.projectId ?? "", input.productMode, input.conversationId ?? ""].join("\0");
}

function queueCalibrationKey(input: {
  projectId: string | null;
  productMode: ProductMode;
  conversationId: string | null;
  executionKey?: string | null;
}): string {
  return [queueIdentity(input), input.executionKey ?? ""].join("\0");
}

function baseQueueUrl(input: { projectId: string | null; conversationId: string | null }): string {
  return `/api/projects/${encodeURIComponent(input.projectId!)}/workbench/conversations/${encodeURIComponent(input.conversationId!)}/turn-queue`;
}

function queueReadUrl(input: { projectId: string | null; productMode: ProductMode; conversationId: string | null }): string {
  return `${baseQueueUrl(input)}?productMode=${encodeURIComponent(input.productMode)}`;
}

function createRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function errorMessage(cause: unknown): string {
  return userFacingErrorMessage(cause, "queue");
}

function isCanonicalConversationId(conversationId: string | null): conversationId is string {
  return Boolean(conversationId && !conversationId.startsWith("pending:"));
}
