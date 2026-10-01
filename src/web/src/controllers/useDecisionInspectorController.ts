import { useRef, useState } from "react";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type {
  ConfirmationQueue, ConfirmationQueueItem, DecisionAction, DecisionActionResult, DecisionContext,
  DecisionInspector, DecisionInspectorControls, DecisionInspectorEntry, DecisionInspectorSurface,
  DecisionInspectorTarget, ProductMode, Decision,
} from "../types.js";

interface Options {
  projectId: string | null;
  productMode: ProductMode;
  conversationId: string | null;
  inspector: DecisionInspector;
  queue: ConfirmationQueue;
  busy: boolean;
  loading?: boolean;
  loadFailure?: string | null;
  decisions?: Decision[];
  actions: {
    executeDecisionAction: (action: DecisionAction, context: DecisionContext) => Promise<DecisionActionResult>;
    requestDecisionFeedback: (context: DecisionContext, action: DecisionAction, feedback: string) => Promise<DecisionActionResult>;
    refresh: () => Promise<unknown>;
    openConversation: (projectId: string, conversationId: string) => Promise<void>;
  };
}
interface ItemState {
  confirming: string | null;
  feedbackActionId: string | null;
  feedback: string;
  version: number;
  pending: number | null;
  locked: boolean;
  issue: DecisionInspectorSurface["issue"];
  proof?: { id: string; changeId?: string; baseline: string };
}
const initialState = (): ItemState => ({ confirming: null, feedbackActionId: null, feedback: "", version: 0, pending: null, locked: false, issue: null });

/** Owns presentation state only; the existing action owner remains the execution path. */
export function useDecisionInspectorController(options: Options): DecisionInspectorControls {
  const latest = useRef(options);
  latest.current = options;
  const selections = useRef(new Map<string, DecisionInspectorTarget>());
  const states = useRef(new Map<string, ItemState>());
  const counter = useRef(0);
  const [, setRevision] = useState(0);
  const redraw = (): void => setRevision((value) => value + 1);
  const scope = JSON.stringify([options.projectId, options.productMode, options.conversationId]);
  const generation = useRef({ scope, value: 0 });
  if (generation.current.scope !== scope) generation.current = { scope, value: generation.current.value + 1 };
  const loadState = useRef<{ scope: string; failure: string | null; pending: boolean }>({ scope, failure: null, pending: false });
  if (loadState.current.scope !== scope) loadState.current = { scope, failure: null, pending: false };
  const entries = projectEntries(options);
  const history = projectHistory(options);
  const target = selections.current.get(scope);
  const selected = [...entries, ...history].find((entry) => sameTarget(entry.target, target)) ?? entries[0] ?? null;
  const key = selected ? JSON.stringify([scope, selected.target.source, selected.target.id]) : "";
  const state = states.current.get(key) ?? initialState();
  if (state.issue?.kind === "uncertain" && state.proof) {
    const receipt = options.decisions?.find((decision) => decision.id === state.proof?.id && decision.changeId === state.proof?.changeId);
    if (receipt && (receipt.status === "accepted" || receipt.status === "completed")
      && JSON.stringify([receipt.status, receipt.updatedAt]) !== state.proof.baseline) {
      state.issue = { kind: "accepted", message: "已确认此操作提交成功。" };
      state.confirming = null;
    }
  }
  const update = (entryKey: string, change: Partial<ItemState>): void => {
    states.current.set(entryKey, { ...(states.current.get(entryKey) ?? initialState()), ...change });
    redraw();
  };
  const view: DecisionInspectorSurface = {
    entries, history, selected, confirming: state.confirming, feedbackActionId: state.feedbackActionId,
    feedback: state.feedback, busy: options.busy || state.pending !== null, locked: state.locked,
    issue: state.issue, loading: Boolean(options.loading) || loadState.current.pending,
    loadFailure: options.loadFailure ?? loadState.current.failure,
  };
  const run = async (action: DecisionAction, feedback?: string): Promise<void> => {
    const current = states.current.get(key) ?? initialState();
    if (!selected || selected.readOnly || !action.enabled || current.pending !== null || current.locked || latest.current.busy) return;
    if (!selected.context.actions.some((candidate) => candidate.id === action.id && candidate.enabled)) return;
    const token = ++counter.current;
    const capturedVersion = current.version;
    const epoch = generation.current.value;
    const decisionId = action.kind === "approval" && action.action
      ? `approval:${action.action.actionId}:${action.action.args.join(":")}` : null;
    const receipt = decisionId ? options.decisions?.find((decision) => decision.id === decisionId) : undefined;
    update(key, { pending: token, issue: null, proof: decisionId ? { id: decisionId, changeId: selected.context.changeId,
      baseline: receipt ? JSON.stringify([receipt.status, receipt.updatedAt]) : "" } : undefined });
    let result: DecisionActionResult;
    try {
      result = feedback === undefined
        ? await options.actions.executeDecisionAction(action, selected.context)
        : await options.actions.requestDecisionFeedback(selected.context, action, feedback);
    } catch {
      result = { status: "uncertain", message: "操作结果待确认，请重新读取状态。" };
    }
    const stored = states.current.get(key);
    if (!stored || stored.pending !== token) return;
    const accepted = result.status === "accepted";
    const unchanged = stored.version === capturedVersion;
    const issue: ItemState["issue"] = result.status !== "accepted"
      ? { kind: result.status, message: result.message }
      : result.refresh === "failed" ? { kind: "accepted", message: "操作已提交，状态刷新失败。请重新读取。" } : null;
    update(key, {
      pending: null,
      locked: result.status === "uncertain" || (result.status === "accepted" && (result.refresh === "failed" || (feedback === undefined && action.kind !== "evidence"))),
      issue,
      ...(generation.current.value === epoch ? { confirming: accepted ? null : stored.confirming } : {}),
      ...(accepted && feedback !== undefined && unchanged ? { feedback: "", feedbackActionId: null, version: stored.version + 1 } : {}),
    });
  };
  return {
    view,
    select: (next) => {
      if (!sameTarget(next, selected?.target)) {
        if (key) update(key, { confirming: null });
        selections.current.set(scope, next);
        redraw();
      }
    },
    confirm: (id) => { if (selected && !selected.readOnly && !view.busy && !view.locked) update(key, { confirming: id }); },
    beginFeedback: (id) => { if (selected && !selected.readOnly && !view.busy && !view.locked) update(key, { feedbackActionId: id, confirming: null }); },
    setFeedback: (text) => {
      if (!selected || selected.readOnly) return;
      const current = states.current.get(key) ?? initialState();
      update(key, { feedback: text, version: current.version + 1 });
    },
    cancelFeedback: () => { if (!view.busy) { const current = states.current.get(key) ?? initialState(); update(key, { feedbackActionId: null, feedback: "", version: current.version + 1 }); } },
    execute: async (action) => {
      const current = states.current.get(key) ?? initialState();
      if (action.requiresConfirmation && current.confirming !== action.id) return;
      await run(action);
    },
    submitFeedback: async () => {
      const current = states.current.get(key) ?? initialState();
      const action = selected?.context.actions.find((item) => item.id === current.feedbackActionId && item.kind === "feedback");
      if (action && current.feedback.trim()) await run(action, current.feedback.trim());
    },
    refresh: async () => {
      if (loadState.current.pending) return;
      const owner = loadState.current;
      owner.pending = true; owner.failure = null; redraw();
      try { await options.actions.refresh(); }
      catch (cause) { if (loadState.current === owner) owner.failure = userFacingErrorMessage(cause, "load"); }
      finally { if (loadState.current === owner) { owner.pending = false; redraw(); } }
    },
    openConversation: async () => {
      if (!selected?.projectId || !selected.conversationId || view.busy) return;
      try { await options.actions.openConversation(selected.projectId, selected.conversationId); }
      catch (cause) { update(key, { issue: { kind: "failed", message: userFacingErrorMessage(cause, "load") } }); }
    },
  };
}

function sameTarget(a: DecisionInspectorTarget | undefined, b: DecisionInspectorTarget | undefined): boolean {
  return Boolean(a && b && a.source === b.source && a.id === b.id);
}

function projectEntries(options: Options): DecisionInspectorEntry[] {
  const result: DecisionInspectorEntry[] = [];
  const seen = new Set<string>();
  const add = (item: ConfirmationQueueItem, source: DecisionInspectorTarget["source"]): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    result.push(queueEntry(item, source, options));
  };
  if (options.queue.primary) add(options.queue.primary, "current");
  for (const item of options.queue.current) add(item, "current");
  for (const item of options.queue.otherDemands) add(item, "other");
  for (const item of options.queue.maintenance) add(item, "maintenance");
  return result;
}

function projectHistory(options: Options): DecisionInspectorEntry[] {
  const result = options.inspector.history.map((context): DecisionInspectorEntry => ({
    target: { source: "history", id: context.id }, context, projectId: options.projectId, conversationId: null, readOnly: true,
  }));
  for (const item of options.queue.history) {
    if (!result.some((entry) => entry.target.id === item.id)) result.push(queueEntry(item, "history", options));
  }
  return result;
}

function queueEntry(item: ConfirmationQueueItem, source: DecisionInspectorTarget["source"], options: Options): DecisionInspectorEntry {
  const projectId = item.projectId ?? options.projectId;
  const conversationId = item.conversationId ?? null;
  return {
    target: { source, id: item.id }, projectId, conversationId,
    readOnly: source === "history" || projectId !== options.projectId || Boolean(conversationId && conversationId !== options.conversationId),
    context: {
      id: item.id, kind: item.kind, title: item.whyNeedsConfirmation, summary: item.summary,
      resultSummary: item.summary, recommendation: item.confirmEffect, explanation: item.riskSummary,
      severity: item.status === "failed" ? "blocking" : "info", changeId: item.changeId ?? item.conversationId,
      runId: item.runId, targetId: item.worktreeId ?? item.applyCheckId ?? item.resultId,
      artifact: item.evidenceRefs[0], evidenceRefs: item.evidenceRefs, actions: item.actions,
      userStatus: source === "history" ? undefined : "waiting-confirmation",
    },
  };
}
