import { useEffect, useRef, useState } from "react";
import { composerProductMode, effectiveComposerProviderId, type ConversationComposerScope } from "./conversation-composer-contract.js";
import { conversationAccessApi } from "./conversation-access-http-adapter.js";
import type { AgentAccessMode, ConversationAccessApi, ConversationAccessIdentity, ConversationAccessSelection, ConversationAccessView } from "./conversation-access-contract.js";

type AccessState = { key: string; selection: ConversationAccessSelection; busy: boolean; failure: string | null };

export function useConversationAccessController(scope: ConversationComposerScope, api: ConversationAccessApi = conversationAccessApi) {
  const providerId = effectiveComposerProviderId(scope);
  const enabled = composerProductMode(scope) === "agent" && Boolean(scope.projectId && providerId);
  const identity: ConversationAccessIdentity = { projectId: scope.projectId ?? "", conversationId: scope.conversation?.id ?? null, providerId: providerId ?? "" };
  const key = JSON.stringify([enabled, identity.projectId, identity.conversationId, identity.providerId]);
  const initial: AccessState = { key, selection: { accessMode: "default", revision: 0, providerId: identity.providerId },
    busy: enabled && Boolean(identity.conversationId), failure: null };
  const [state, setState] = useState(initial);
  const current = useRef({ key, identity, enabled });
  current.current = { key, identity, enabled };
  const stateRef = useRef(state);
  const visible = state.key === key ? state : initial;
  stateRef.current = visible;
  const pending = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const generation = useRef(0);
  const commit = (next: AccessState) => { stateRef.current = next; setState(next); };

  function refresh(): Promise<void> {
    const captured = current.current;
    const token = ++generation.current;
    const empty = { key: captured.key, selection: { accessMode: "default" as const, revision: 0, providerId: captured.identity.providerId }, busy: false, failure: null };
    if (!captured.enabled || !captured.identity.conversationId) { commit(empty); return Promise.resolve(); }
    commit({ ...empty, busy: true });
    const promise = api.read(captured.identity).then((selection) => {
      if (current.current.key === captured.key && generation.current === token) commit({ ...empty, selection });
    }).catch(() => {
      if (current.current.key === captured.key && generation.current === token) commit({ ...empty, failure: "权限设置暂时无法读取，请重新检测。" });
    });
    pending.current = { key: captured.key, promise };
    return promise;
  }

  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [key]);

  async function select(mode: AgentAccessMode, confirmed = false): Promise<void> {
    const captured = current.current;
    const prior = stateRef.current;
    if (!captured.enabled || prior.key !== captured.key || prior.busy || prior.failure) return;
    if (mode === "full-access" && !confirmed) return;
    const token = ++generation.current;
    commit({ ...prior, busy: true, failure: null });
    const promise = (async () => {
      try {
        const selection = captured.identity.conversationId
          ? await api.save(captured.identity, prior.selection, mode, confirmed)
          : { ...prior.selection, accessMode: mode };
        if (current.current.key === captured.key && generation.current === token) commit({ ...prior, selection, busy: false });
      } catch {
        if (current.current.key === captured.key && generation.current === token) {
          // Reload on conflict; never display an optimistic privilege value as saved.
          let selection = prior.selection;
          try { selection = await api.read(captured.identity); } catch { /* Keep last verified selection. */ }
          if (current.current.key === captured.key && generation.current === token) commit({ ...prior, selection, busy: false,
            failure: "权限设置未保存，请重新检测后再选择。" });
        }
      }
    })();
    pending.current = { key: captured.key, promise };
    await promise;
  }

  function capture() {
    const capturedKey = current.current.key;
    if (!current.current.enabled) return {};
    if (stateRef.current.busy && pending.current?.key === capturedKey) {
      return pending.current.promise.then(() => {
        if (current.current.key !== capturedKey) throw new Error("当前会话已切换，请重新发送。");
        return captureReady(capturedKey);
      });
    }
    return captureReady(capturedKey);
  }

  function captureReady(capturedKey: string) {
    const value = stateRef.current;
    if (current.current.key !== capturedKey || value.key !== capturedKey || value.busy || value.failure) {
      throw new Error("权限设置尚未就绪，请重新检测后发送。");
    }
    if (current.current.identity.conversationId) return verifyCapturedSelection(capturedKey, value);
    return { agentAccessMode: value.selection.accessMode,
      expectedAccessRevision: current.current.identity.conversationId ? value.selection.revision : undefined };
  }

  async function verifyCapturedSelection(capturedKey: string, value: AccessState) {
    const captured = current.current;
    const token = generation.current;
    let selection: ConversationAccessSelection;
    try { selection = await api.read(captured.identity); } catch {
      if (current.current.key === capturedKey && generation.current === token) {
        commit({ ...value, failure: "权限设置暂时无法读取，请重新检测。" });
      }
      throw new Error("权限设置尚未就绪，请重新检测后发送。");
    }
    if (current.current.key !== capturedKey || generation.current !== token) {
      throw new Error("权限设置已变化，请确认后重新发送。");
    }
    if (selection.revision !== value.selection.revision || selection.accessMode !== value.selection.accessMode
      || selection.providerId !== value.selection.providerId) {
      commit({ ...value, selection, failure: "权限设置已在其他窗口更改，请重新检测并确认后发送。" });
      throw new Error("权限设置已变化，请确认后重新发送。");
    }
    return { agentAccessMode: selection.accessMode, expectedAccessRevision: selection.revision };
  }

  const capabilities = scope.providerCapabilities?.find((candidate) => candidate.providerId === providerId);
  const view: ConversationAccessView = { scopeKey: key, visible: enabled, mode: visible.selection.accessMode,
    busy: visible.busy, failure: visible.failure,
    fullAccessAvailable: capabilities?.capabilities.some((capability) => capability.key === "workspace.full-access" && capability.runtime === "ready") ?? false };
  return { view, select, refresh, capture };
}
