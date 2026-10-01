import { useCallback, useEffect, useRef, useState } from "react";
import { consumeWorkbenchLiveStream, postJson } from "../api.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type {
  AgentSurfaceProjectionItem,
  TextDocumentResource,
  WorkspaceResourceTab,
  WorkspaceResourceTarget,
  WorkbenchLiveEvent,
  ProductMode,
} from "../types.js";
import type { WorkbenchOperationToken } from "./useGlobalOperationGate.js";

export type WorkspaceResourceCleanupTransition =
  | "project-changed"
  | "conversation-changed"
  | "new-conversation"
  | "graph-scope-changed";

export type WorkspaceResourceControllerOptions = {
  projectId: string | null;
  conversationId: string | null;
  productMode?: ProductMode;
  resolveResource?: (projectId: string, target: Exclude<WorkspaceResourceTarget, { kind: "agent" }>) => Promise<TextDocumentResource>;
  loadAgentTranscript?: (target: Extract<WorkspaceResourceTarget, { kind: "agent" }>) => void | Promise<void>;
  sendAgentMessage?: (agent: AgentSurfaceProjectionItem, message: string) => Promise<void>;
  operation?: {
    begin(key: string): WorkbenchOperationToken;
    release(token: WorkbenchOperationToken): void;
  };
  routeProjectionEvent?: (projectId: string, event: WorkbenchLiveEvent) => void;
  calibrateAgentTranscript?: (projectId: string, conversationId: string, agentSurfaceId: string) => Promise<void>;
};

export function useWorkspaceResourceController({
  projectId,
  conversationId,
  productMode = "harness",
  resolveResource = resolveWorkspaceResource,
  loadAgentTranscript,
  sendAgentMessage,
  operation,
  routeProjectionEvent,
  calibrateAgentTranscript,
}: WorkspaceResourceControllerOptions) {
  const [tabs, setTabs] = useState<WorkspaceResourceTab[]>([]);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Record<string, TextDocumentResource>>({});
  const [loadingResourceIds, setLoadingResourceIds] = useState<string[]>([]);
  const [resourceErrors, setResourceErrors] = useState<Record<string, string>>({});
  const [agentDrafts, setAgentDrafts] = useState<Record<string, string>>({});
  const [pendingAgentMessages, setPendingAgentMessages] = useState<Record<string, string>>({});
  const requestGenerationsRef = useRef(new Map<string, number>());
  const loadedResourceIdsRef = useRef(new Set<string>());
  const inFlightRequestsRef = useRef(new Map<string, Promise<void>>());
  const submitGenerationsRef = useRef(new Map<string, number>());
  const pendingReleaseTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const scopeRef = useRef({ projectId, conversationId, productMode });
  scopeRef.current = { projectId, conversationId, productMode };
  const inputScope = `${projectId ?? ""}\0${productMode}\0`;
  useEffect(() => () => {
    for (const timer of pendingReleaseTimersRef.current.values()) globalThis.clearTimeout(timer);
    pendingReleaseTimersRef.current.clear();
    for (const resourceId of requestGenerationsRef.current.keys()) {
      requestGenerationsRef.current.set(resourceId, (requestGenerationsRef.current.get(resourceId) ?? 0) + 1);
    }
    for (const key of submitGenerationsRef.current.keys()) {
      submitGenerationsRef.current.set(key, (submitGenerationsRef.current.get(key) ?? 0) + 1);
    }
    inFlightRequestsRef.current.clear();
  }, []);

  const invalidateResource = useCallback((resourceId: string) => {
    requestGenerationsRef.current.set(resourceId, (requestGenerationsRef.current.get(resourceId) ?? 0) + 1);
  }, []);

  const ensureLoaded = useCallback((
    target: Exclude<WorkspaceResourceTarget, { kind: "agent" }>,
    resourceId = workspaceResourceId(target),
  ): Promise<void> => {
    if (!projectId || loadedResourceIdsRef.current.has(resourceId)) return Promise.resolve();
    const inFlight = inFlightRequestsRef.current.get(resourceId);
    if (inFlight) return inFlight;
    const requestProjectId = projectId;
    const requestScope = workspaceResourceRequestScope(requestProjectId, conversationId ?? "", target);
    const generation = (requestGenerationsRef.current.get(resourceId) ?? 0) + 1;
    requestGenerationsRef.current.set(resourceId, generation);
    setLoadingResourceIds((current) => addUnique(current, resourceId));
    setResourceErrors((current) => withoutKey(current, resourceId));
    const isCurrent = (): boolean => {
      const currentScope = scopeRef.current;
      return requestGenerationsRef.current.get(resourceId) === generation
        && currentScope.projectId === requestProjectId
        && currentScope.productMode === productMode
        && workspaceResourceRequestScope(requestProjectId, currentScope.conversationId ?? "", target) === requestScope;
    };
    const request = resolveResource(requestProjectId, target).then((resource) => {
      if (!isCurrent()) return;
      loadedResourceIdsRef.current.add(resourceId);
      setDocuments((current) => ({ ...current, [resourceId]: resource }));
    }).catch((cause: unknown) => {
      if (isCurrent()) {
        setResourceErrors((current) => ({
          ...current,
          [resourceId]: userFacingErrorMessage(cause, "load"),
        }));
      }
    }).finally(() => {
      if (inFlightRequestsRef.current.get(resourceId) === request) inFlightRequestsRef.current.delete(resourceId);
      if (isCurrent()) setLoadingResourceIds((current) => current.filter((id) => id !== resourceId));
    });
    inFlightRequestsRef.current.set(resourceId, request);
    return request;
  }, [conversationId, productMode, projectId, resolveResource]);

  const openResource = useCallback((target: WorkspaceResourceTarget): string => {
    const resourceId = workspaceResourceId(target);
    setTabs((current) => current.some((tab) => tab.resourceId === resourceId)
      ? current
      : [...current, { resourceId, target }]);
    setSelectedResourceId(resourceId);
    if (target.kind === "agent") void loadAgentTranscript?.(target);
    else void ensureLoaded(target, resourceId);
    return resourceId;
  }, [ensureLoaded, loadAgentTranscript]);

  const selectResource = useCallback((resourceId: string) => {
    setSelectedResourceId(resourceId);
    const tab = tabs.find((candidate) => candidate.resourceId === resourceId);
    if (tab?.target.kind === "agent") void loadAgentTranscript?.(tab.target);
    else if (tab) void ensureLoaded(tab.target, resourceId);
  }, [ensureLoaded, loadAgentTranscript, tabs]);

  const closeResource = useCallback((resourceId: string) => {
    invalidateResource(resourceId);
    loadedResourceIdsRef.current.delete(resourceId);
    inFlightRequestsRef.current.delete(resourceId);
    const index = tabs.findIndex((tab) => tab.resourceId === resourceId);
    const next = tabs.filter((tab) => tab.resourceId !== resourceId);
    setTabs(next);
    setSelectedResourceId((selected) => selected === resourceId
      ? next[Math.min(index, next.length - 1)]?.resourceId ?? null
      : selected);
    setDocuments((current) => withoutKey(current, resourceId));
    setLoadingResourceIds((current) => current.filter((id) => id !== resourceId));
    setResourceErrors((current) => withoutKey(current, resourceId));
    return next[Math.min(index, next.length - 1)]?.target ?? null;
  }, [invalidateResource, tabs]);

  const setAgentDraft = useCallback((agentSurfaceId: string, value: string) => {
    if (!conversationId) return;
    const key = inputScope + agentDraftKey(conversationId, agentSurfaceId);
    setAgentDrafts((current) => value ? { ...current, [key]: value } : withoutKey(current, key));
  }, [conversationId, inputScope]);

  const submitAgentMessage = useCallback(async (agent: AgentSurfaceProjectionItem): Promise<void> => {
    if (!conversationId || agent.readOnly || agent.status === "terminated") return;
    const key = inputScope + agentDraftKey(conversationId, agent.agentSurfaceId);
    const message = agentDrafts[key]?.trim() ?? "";
    if (!message || pendingAgentMessages[key]) return;
    const generation = (submitGenerationsRef.current.get(key) ?? 0) + 1;
    submitGenerationsRef.current.set(key, generation);
    const pendingId = `agent-message:${agent.agentSurfaceId}:${generation}`;
    setAgentDrafts((current) => withoutKey(current, key));
    setPendingAgentMessages((current) => ({ ...current, [key]: pendingId }));
    clearPendingTimer(key);
    pendingReleaseTimersRef.current.set(key, globalThis.setTimeout(() => {
      if (submitGenerationsRef.current.get(key) !== generation) return;
      setPendingAgentMessages((current) => current[key] === pendingId ? withoutKey(current, key) : current);
      pendingReleaseTimersRef.current.delete(key);
    }, 1200));
    try {
      if (sendAgentMessage) {
        await sendAgentMessage(agent, message);
      } else if (projectId) {
        const operationToken = operation?.begin(`agent.message.${agent.agentSurfaceId}`);
        try {
          await consumeWorkbenchLiveStream<WorkbenchLiveEvent>(
            `/api/projects/${encodeURIComponent(projectId)}/workbench/topics/${encodeURIComponent(conversationId)}/messages/live`,
            { mode: "chat", message, agentSurfaceId: agent.agentSurfaceId, productMode },
            (event) => {
              const active = scopeRef.current;
              if (active.projectId === projectId && active.conversationId === conversationId) {
                routeProjectionEvent?.(projectId, event);
              }
            },
          );
        } finally {
          try {
            await calibrateAgentTranscript?.(projectId, conversationId, agent.agentSurfaceId);
          } finally {
            if (operationToken) operation?.release(operationToken);
          }
        }
      }
    } catch (error) {
      if (submitGenerationsRef.current.get(key) === generation) {
        setAgentDrafts((current) => current[key] ? current : { ...current, [key]: message });
      }
      throw error;
    } finally {
      if (submitGenerationsRef.current.get(key) === generation) {
        clearPendingTimer(key);
        setPendingAgentMessages((current) => current[key] === pendingId ? withoutKey(current, key) : current);
      }
    }
  }, [agentDrafts, calibrateAgentTranscript, conversationId, inputScope, operation, pendingAgentMessages, productMode, projectId, routeProjectionEvent, sendAgentMessage]);

  const cleanupTransition = useCallback((transition: WorkspaceResourceCleanupTransition) => {
    const keepTab = (tab: WorkspaceResourceTab): boolean => {
      if (transition === "project-changed") return false;
      if (transition === "graph-scope-changed") return true;
      return tab.target.kind === "project-file";
    };
    const retained = tabs.filter(keepTab);
    const retainedIds = new Set(retained.map((tab) => tab.resourceId));
    for (const tab of tabs) {
      if (retainedIds.has(tab.resourceId)) continue;
      invalidateResource(tab.resourceId);
      loadedResourceIdsRef.current.delete(tab.resourceId);
      inFlightRequestsRef.current.delete(tab.resourceId);
    }
    setTabs(retained);
    setSelectedResourceId((selected) => selected && retainedIds.has(selected)
      ? selected
      : retained.at(-1)?.resourceId ?? null);
    setDocuments((currentDocuments) => retainKeys(currentDocuments, retainedIds));
    setLoadingResourceIds((currentLoading) => currentLoading.filter((id) => retainedIds.has(id)));
    setResourceErrors((currentErrors) => retainKeys(currentErrors, retainedIds));
  }, [invalidateResource, tabs]);

  function clearPendingTimer(key: string): void {
    const timer = pendingReleaseTimersRef.current.get(key);
    if (timer) globalThis.clearTimeout(timer);
    pendingReleaseTimersRef.current.delete(key);
  }

  return {
    tabs,
    selectedResourceId,
    documents,
    loadingResourceIds,
    resourceErrors,
    agentDrafts: scopedInputs(agentDrafts, inputScope),
    pendingAgentMessages: scopedInputs(pendingAgentMessages, inputScope),
    openResource,
    selectResource,
    closeResource,
    ensureLoaded,
    setAgentDraft,
    submitAgentMessage,
    cleanupTransition,
  };
}

export function workspaceResourceId(target: WorkspaceResourceTarget): string {
  if (target.kind === "agent") return `agent:${target.agentSurfaceId}`;
  if (target.kind === "document") return target.documentId;
  return `project-file:${target.relativePath.replace(/\\/g, "/")}`;
}

export function projectFileResourceTabs(tabs: WorkspaceResourceTab[]): WorkspaceResourceTab[] {
  return tabs.filter((tab) => tab.target.kind === "project-file");
}

export function workspaceResourceRequestScope(projectId: string, conversationId: string, target: WorkspaceResourceTarget): string {
  return target.kind === "project-file" ? `project:${projectId}` : `conversation:${projectId}:${conversationId}`;
}

export function agentDraftKey(conversationId: string, agentSurfaceId: string): string {
  return `${conversationId}\u0000${agentSurfaceId}`;
}

function scopedInputs(values: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length), value]));
}

async function resolveWorkspaceResource(
  projectId: string,
  target: Exclude<WorkspaceResourceTarget, { kind: "agent" }>,
): Promise<TextDocumentResource> {
  return postJson<TextDocumentResource>(
    `/api/projects/${encodeURIComponent(projectId)}/workspace-resources/resolve`,
    { target },
  );
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function retainKeys<T>(values: Record<string, T>, retained: Set<string>): Record<string, T> {
  const entries = Object.entries(values).filter(([key]) => retained.has(key));
  return entries.length === Object.keys(values).length ? values : Object.fromEntries(entries);
}

function withoutKey<T>(values: Record<string, T>, key: string): Record<string, T> {
  if (!(key in values)) return values;
  const next = { ...values };
  delete next[key];
  return next;
}
