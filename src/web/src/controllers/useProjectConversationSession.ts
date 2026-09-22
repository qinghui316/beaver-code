import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { consumeWorkbenchLiveStream, fetchJson, postJson } from "../api.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import { projectDisplayName } from "../formatters.js";
import type { ProjectNavigationConversation } from "../presentation/project-navigation.js";
import type {
  AgentTurnMode,
  AppStatus,
  ConversationDeleteConfirmation,
  ConversationLifecycleReceipt,
  ProductMode,
  ProjectStatus,
  Snapshot,
  StreamPacket,
  Topic,
  TopicFileReference,
  WorkbenchLiveEvent,
  Workpad,
} from "../types.js";

const SELECTED_PROJECT_STORAGE_KEY = "aho.workbench.selectedProjectId";

export type PendingDemandConversation = {
  id: string;
  projectId: string;
  productMode: ProductMode;
  clientRequestId: string;
  title: string;
  body: string;
  startedAt: string;
  canonical: boolean;
  updatedAt?: string;
  selectedProviderId?: string;
};

type PendingDemandRekeyResult = "rekeyed" | "already-canonical" | "not-pending" | "rejected";

export type CreateDemandConversationInput = {
  agentAccessMode?: import("./conversation-access-contract.js").AgentAccessMode;
  projectId: string;
  productMode: ProductMode;
  agentTurnMode?: AgentTurnMode;
  modelId?: string | null;
  reasoningEffort?: string | null;
  clientRequestId: string;
  body: string;
  contextRefs: TopicFileReference[];
  attachmentIds: string[];
  providerId?: string;
  skillOverrides: Array<{ skillId: string; enabled: boolean }>;
  showPendingBeforeCreate: boolean;
};

export type ProjectRemovalConfirmation = {
  token: string;
  projectId: string;
  projectName: string;
  expiresAt: string;
};

export type SessionTransitionKind = "project-changed" | "conversation-changed" | "new-conversation";

export type SessionTransition = {
  kind: SessionTransitionKind;
  fromProjectId: string | null;
  fromProductMode: ProductMode;
  fromConversationId: string | null;
  toProjectId: string;
  toProductMode: ProductMode;
  toConversationId: string | null;
  resetComposerText: boolean;
};

export type WorkbenchRestoreParams = {
  projectId: string | null;
  topicId: string | null;
  orchestrationOpen: boolean;
  settingsOpen: boolean;
};

export interface ProjectConversationSessionApi {
  loadAppStatus(): Promise<AppStatus>;
  loadProjects(): Promise<ProjectStatus[]>;
  registerProject(path: string): Promise<{
    project: NonNullable<ProjectStatus["project"]>;
    status?: ProjectStatus;
  }>;
  loadSnapshot(projectId: string, productMode: ProductMode, conversationId: string | null): Promise<Snapshot>;
  loadNavigation(projectId: string, productMode: ProductMode): Promise<{ productMode: ProductMode; conversations: ProjectNavigationConversation[] }>;
  loadStream(projectId: string, runId: string): Promise<StreamPacket>;
  prepareProjectRemoval(projectId: string): Promise<ProjectRemovalConfirmation>;
  removeProject(projectId: string, confirmationToken: string): Promise<void>;
  prepareConversationDelete(projectId: string, conversationId: string, productMode: ProductMode, expectedLifecycleRevision: string): Promise<ConversationDeleteConfirmation>;
  settleConversationLifecycle(input: {
    projectId: string;
    conversationId: string;
    productMode: ProductMode;
    action: "archive" | "restore" | "delete";
    expectedLifecycleRevision: string;
    clientRequestId: string;
    confirmationToken?: string | null;
  }): Promise<ConversationLifecycleReceipt>;
  updateConversationTitle(projectId: string, conversationId: string, title: string): Promise<{ conversation: Topic }>;
  createDemandConversation(
    input: CreateDemandConversationInput,
    onEvent: (event: WorkbenchLiveEvent) => void,
  ): Promise<void>;
}

export interface ProjectConversationSessionPorts {
  productMode?: ProductMode;
  api?: Partial<ProjectConversationSessionApi>;
  navigation?: {
    readRestoreParams(): WorkbenchRestoreParams;
    readPersistedProjectId(): string | null;
    persistProjectId(projectId: string): void;
    clearPersistedProjectId(): void;
    syncLocation(projectId: string | null, conversationId: string | null): void;
  };
  timeline?: {
    invalidateProjection(): void;
    clearProject(projectId: string): void;
    clearConversation(projectId: string, conversationId: string): void;
    rekeyConversation?(from: { projectId: string; productMode: ProductMode; conversationId: string }, toConversationId: string, clientRequestId: string): void;
  };
  resources?: {
    cleanupTransition(kind: SessionTransitionKind): void;
  };
  operations?: {
    invalidate(): void;
  };
  ui?: {
    transition(event: SessionTransition): void;
    restoreView(view: Pick<WorkbenchRestoreParams, "orchestrationOpen" | "settingsOpen">): void;
    confirmRemoveProject(projectName: string, confirmation: ProjectRemovalConfirmation): boolean;
  };
  onError?(message: string): void;
  autoLoad?: boolean;
}

export function useProjectConversationSession(ports: ProjectConversationSessionPorts = {}) {
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const requestedProductMode = ports.productMode ?? "harness";
  const [productMode, setProductMode] = useState<ProductMode>(requestedProductMode);
  const [projects, setProjects] = useState<ProjectStatus[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => emptySnapshotForMode(requestedProductMode));
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [stream, setStream] = useState<StreamPacket | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [projectModeSnapshots, setProjectModeSnapshots] = useState<Record<string, Snapshot>>({});
  const [navigationLists, setNavigationLists] = useState<Record<string, ProjectNavigationConversation[]>>({});
  const [navigationErrors, setNavigationErrors] = useState<Record<string, string>>({});
  const [archivingKeys, setArchivingKeys] = useState<Set<string>>(new Set());
  const archivingKeysRef = useRef(new Set<string>());
  const navigationListsRef = useRef(navigationLists);
  navigationListsRef.current = navigationLists;
  const navigationRequestsRef = useRef(new Map<string, Promise<void>>());
  const navigationGenerationsRef = useRef(new Map<string, number>());
  const navigationDirtyRef = useRef(new Set<string>());
  const projectRequestGenerationRef = useRef(0);
  const [pendingDemandConversation, setPendingDemandConversation] = useState<PendingDemandConversation | null>(null);
  const requestGenerationRef = useRef(0);
  const productModeRef = useRef<ProductMode>(requestedProductMode);
  const streamEffectGenerationRef = useRef(0);
  const pendingDemandRef = useRef<PendingDemandConversation | null>(null);
  const stateRef = useRef({ projects, productMode, selectedProjectId, snapshot, selectedTopic, selectedRun, pendingDemandConversation });
  stateRef.current = { projects, productMode, selectedProjectId, snapshot, selectedTopic, selectedRun, pendingDemandConversation };
  const projectSnapshots = useMemo(
    () => snapshotsForMode(projectModeSnapshots, productMode),
    [productMode, projectModeSnapshots],
  );
  const projectNavigation = useMemo(
    () => Object.fromEntries(Object.entries(navigationLists)
      .filter(([key]) => key.endsWith(`\0${productMode}`))
      .map(([key, value]) => [key.slice(0, -productMode.length - 1), value.filter((item) =>
        !archivingKeys.has(`${key.slice(0, -productMode.length - 1)}\0${productMode}\0${item.id}`))])),
    [navigationLists, productMode, archivingKeys],
  );
  const projectNavigationErrors = useMemo(
    () => Object.fromEntries(Object.entries(navigationErrors)
      .filter(([key]) => key.endsWith(`\0${productMode}`))
      .map(([key, value]) => [key.slice(0, -productMode.length - 1), value])),
    [navigationErrors, productMode],
  );

  const reportError = useCallback((cause: unknown): void => {
    portsRef.current.onError?.(userFacingErrorMessage(cause, "load"));
  }, []);

  const loadNavigation = useCallback((projectId: string, mode: ProductMode, force = false): Promise<void> => {
    const key = snapshotCacheKey(projectId, mode);
    if (!force && navigationListsRef.current[key]) return Promise.resolve();
    const active = navigationRequestsRef.current.get(key);
    if (active) {
      if (force) {
        navigationDirtyRef.current.add(key);
        navigationGenerationsRef.current.set(key, (navigationGenerationsRef.current.get(key) ?? 0) + 1);
      }
      return active;
    }
    const generation = (navigationGenerationsRef.current.get(key) ?? 0) + 1;
    navigationGenerationsRef.current.set(key, generation);
    setNavigationErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    const request = sessionApi(portsRef.current).loadNavigation(projectId, mode)
      .then((result) => {
        if (navigationGenerationsRef.current.get(key) !== generation || result.productMode !== mode) return;
        setNavigationLists((current) => ({ ...current, [key]: result.conversations }));
      })
      .catch((cause: unknown) => {
        if (navigationGenerationsRef.current.get(key) !== generation) return;
        setNavigationErrors((current) => ({ ...current, [key]: userFacingErrorMessage(cause, "load") }));
        throw cause;
      })
      .finally(() => {
        if (navigationRequestsRef.current.get(key) !== request) return;
        navigationRequestsRef.current.delete(key);
        if (navigationDirtyRef.current.delete(key)) {
          void loadNavigation(projectId, mode, true).catch(reportError);
        }
      });
    navigationRequestsRef.current.set(key, request);
    return request;
  }, [reportError]);

  const invalidateNavigation = useCallback((projectId: string, mode?: ProductMode): void => {
    const modes: ProductMode[] = mode ? [mode] : ["agent", "harness"];
    for (const candidate of modes) {
      const key = snapshotCacheKey(projectId, candidate);
      if (mode || navigationListsRef.current[key] || navigationRequestsRef.current.has(key)) {
        void loadNavigation(projectId, candidate, true).catch(reportError);
      }
    }
  }, [loadNavigation, reportError]);
  const retryNavigation = useCallback((projectId: string): Promise<void> => loadNavigation(projectId, productModeRef.current, true).catch(() => undefined), [loadNavigation]);

  const refreshProjects = useCallback(async (): Promise<{ list: ProjectStatus[]; generation: number }> => {
    const generation = ++projectRequestGenerationRef.current;
    const list = await sessionApi(portsRef.current).loadProjects();
    if (generation === projectRequestGenerationRef.current) setProjects(list);
    return { list, generation };
  }, []);

  const beginTransition = useCallback((
    kind: SessionTransitionKind,
    projectId: string,
    conversationId: string | null,
    targetProductMode: ProductMode = productModeRef.current,
  ): number => {
    const generation = ++requestGenerationRef.current;
    const previous = stateRef.current;
    portsRef.current.operations?.invalidate();
    portsRef.current.resources?.cleanupTransition(kind);
    portsRef.current.ui?.transition({
      kind,
      fromProjectId: previous.selectedProjectId,
      fromProductMode: previous.productMode,
      fromConversationId: previous.selectedTopic,
      toProjectId: projectId,
      toProductMode: targetProductMode,
      toConversationId: conversationId,
      resetComposerText: kind === "new-conversation",
    });
    return generation;
  }, []);

  const commitProjectSelection = useCallback((projectId: string, conversationId: string | null): void => {
    stateRef.current.selectedProjectId = projectId;
    stateRef.current.selectedTopic = conversationId;
    setSelectedProjectId(projectId);
    setSelectedTopic(conversationId);
    setSnapshotError(null);
    setExpandedProjects((current) => new Set([...current, projectId]));
    navigation(portsRef.current).persistProjectId(projectId);
    navigation(portsRef.current).syncLocation(projectId, conversationId);
  }, []);

  const refreshAtGeneration = useCallback(async (
    projectId: string | null,
    conversationId: string | null,
    generation: number,
    requestProductMode: ProductMode = productModeRef.current,
    allowDeepLinkFallback = true,
  ): Promise<Snapshot | void> => {
    const api = sessionApi(portsRef.current);
    if (!isCurrentSelection(generation, requestProductMode, requestGenerationRef, productModeRef)) return;
    if (!projectId) return;
    const status = findProject(stateRef.current.projects, projectId);
    if (!canLoadWorkbenchSnapshot(status, requestProductMode)) {
      const next = snapshotForProject(status, requestProductMode);
      setSnapshot(next);
      setStream(null);
      setSelectedRun(null);
      setProjectModeSnapshots((current) => cacheSnapshot(current, projectId, requestProductMode, next));
      return next;
    }
    void loadNavigation(projectId, requestProductMode).catch(reportError);
    const next = await loadSnapshotWithDeepLinkFallback(api, projectId, requestProductMode, conversationId, allowDeepLinkFallback);
    if (!allowDeepLinkFallback && conversationId && next.center.selectedTopic?.id !== conversationId) {
      throw new Error("目标会话的内容与选择不一致。");
    }
    if (!isCurrentSelection(generation, requestProductMode, requestGenerationRef, productModeRef)) return;
    if (!snapshotMatchesMode(next, requestProductMode) || next.project?.id !== projectId) {
      throw new Error("目标会话的项目或模式与选择不一致。");
    }
    setSnapshot(next);
    setSnapshotError(null);
    setProjectModeSnapshots((current) => cacheSnapshot(current, projectId, requestProductMode, next));
    const resolvedConversationId = next.center.selectedTopic?.id ?? null;
    const pending = pendingDemandRef.current;
    if (pending?.canonical && pending.id === resolvedConversationId) {
      setPendingDemandConversation(null);
      pendingDemandRef.current = null;
    }
    if (stateRef.current.selectedTopic !== resolvedConversationId) {
      setSelectedTopic(resolvedConversationId);
      navigation(portsRef.current).syncLocation(projectId, resolvedConversationId);
    }
    portsRef.current.timeline?.invalidateProjection();
    const previousRun = stateRef.current.selectedRun;
    const runId = previousRun && next.center.agentLoop.runs.some((run) => run.id === previousRun)
      ? previousRun
      : next.center.agentLoop.runs[0]?.id ?? null;
    setSelectedRun(runId);
    if (!runId) {
      setStream(null);
      return next;
    }
    const nextStream = await api.loadStream(projectId, runId);
    if (isCurrentSelection(generation, requestProductMode, requestGenerationRef, productModeRef)) setStream(nextStream);
    return isCurrentSelection(generation, requestProductMode, requestGenerationRef, productModeRef) ? next : undefined;
  }, [loadNavigation, reportError]);

  const refresh = useCallback(async (
    projectId = stateRef.current.selectedProjectId,
    conversationId = stateRef.current.selectedTopic,
  ): Promise<Snapshot | void> => {
    const generation = ++requestGenerationRef.current;
    return refreshAtGeneration(projectId, conversationId, generation, productModeRef.current);
  }, [refreshAtGeneration]);

  const loadApp = useCallback(async (): Promise<void> => {
    const generation = ++requestGenerationRef.current;
    const requestProductMode = productModeRef.current;
    const currentPorts = portsRef.current;
    const restore = navigation(currentPorts).readRestoreParams();
    const api = sessionApi(currentPorts);
    const [status, projectRead] = await Promise.all([api.loadAppStatus(), refreshProjects()]);
    if (!isCurrentSelection(generation, requestProductMode, requestGenerationRef, productModeRef)
      || projectRead.generation !== projectRequestGenerationRef.current) return;
    const list = projectRead.list;
    setProjects(list);
    const urlProjectStatus = findProject(list, restore.projectId);
    if (restore.projectId && !urlProjectStatus) {
      setSelectedProjectId(null);
      setSelectedTopic(null);
      setSelectedRun(null);
      setStream(null);
      setSnapshot(emptySnapshotForMode(requestProductMode));
      return;
    }
    const persistedProjectId = navigation(currentPorts).readPersistedProjectId();
    const selectedStatus = urlProjectStatus
      ?? findProject(list, persistedProjectId)
      ?? findProject(list, status.directProjectId);
    const projectId = selectedStatus?.project?.id ?? null;
    currentPorts.ui?.restoreView({
      orchestrationOpen: restore.orchestrationOpen,
      settingsOpen: restore.settingsOpen,
    });
    if (!projectId) {
      if (persistedProjectId) navigation(currentPorts).clearPersistedProjectId();
      setSelectedProjectId(null);
      setSelectedTopic(null);
      setSelectedRun(null);
      setStream(null);
      setExpandedProjects(new Set());
      setPendingDemandConversation(null);
      pendingDemandRef.current = null;
      setSnapshot(emptySnapshotForMode(requestProductMode));
      return;
    }
    const conversationId = restore.topicId && (restore.projectId || urlProjectStatus) ? restore.topicId : null;
    setSelectedProjectId(projectId);
    setSelectedTopic(conversationId);
    setExpandedProjects(new Set([projectId]));
    navigation(currentPorts).persistProjectId(projectId);
    stateRef.current.projects = list;
    if (canLoadWorkbenchSnapshot(selectedStatus, requestProductMode)) {
      await refreshAtGeneration(projectId, conversationId, generation, requestProductMode);
    } else if (isCurrentSelection(generation, requestProductMode, requestGenerationRef, productModeRef)) {
      const next = snapshotForProject(selectedStatus, requestProductMode);
      setSnapshot(next);
      setProjectModeSnapshots((current) => cacheSnapshot(current, projectId, requestProductMode, next));
    }
  }, [refreshAtGeneration, refreshProjects]);

  const openProject = useCallback(async (projectId: string): Promise<void> => {
    const kind: SessionTransitionKind = stateRef.current.selectedProjectId === projectId
      ? "conversation-changed"
      : "project-changed";
    const generation = beginTransition(kind, projectId, null);
    commitProjectSelection(projectId, null);
    setSelectedRun(null);
    setStream(null);
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
    await refreshAtGeneration(projectId, null, generation, productModeRef.current);
  }, [beginTransition, commitProjectSelection, refreshAtGeneration]);

  const beginNewConversation = useCallback(async (projectId = stateRef.current.selectedProjectId ?? undefined): Promise<void> => {
    if (!projectId) {
      reportError("请先选择项目，再在该项目下新建需求对话。");
      return;
    }
    const status = findProject(stateRef.current.projects, projectId);
    if (!canLoadWorkbenchSnapshot(status, productModeRef.current)) {
      reportError("请先初始化这个项目，再新建需求对话。");
      return;
    }
    const generation = beginTransition("new-conversation", projectId, null);
    const requestProductMode = productModeRef.current;
    const cached = projectModeSnapshots[snapshotCacheKey(projectId, requestProductMode)];
    const baseSnapshot = cached
      ?? (status.project?.id === stateRef.current.selectedProjectId
        ? stateRef.current.snapshot
        : await sessionApi(portsRef.current).loadSnapshot(projectId, requestProductMode, null));
    if (!isCurrentSelection(generation, requestProductMode, requestGenerationRef, productModeRef)) return;
    commitProjectSelection(projectId, null);
    setSelectedRun(null);
    setStream(null);
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
    const next = newConversationSnapshot(baseSnapshot, status);
    setSnapshot(next);
    setProjectModeSnapshots((current) => cacheSnapshot(current, projectId, requestProductMode, next));
    portsRef.current.timeline?.invalidateProjection();
  }, [beginTransition, commitProjectSelection, projectModeSnapshots, reportError]);

  const toggleProjectFolder = useCallback(async (projectId: string): Promise<void> => {
    const requestProductMode = productModeRef.current;
    const shouldOpen = !expandedProjects.has(projectId);
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (shouldOpen) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
    if (!shouldOpen) return;
    const status = findProject(stateRef.current.projects, projectId);
    if (!canLoadWorkbenchSnapshot(status, requestProductMode)) return;
    await loadNavigation(projectId, requestProductMode).catch(() => undefined);
  }, [expandedProjects, loadNavigation]);

  const prepareProjectNavigationSearch = useCallback(async (): Promise<void> => {
    const requestProductMode = productModeRef.current;
    const requests = stateRef.current.projects.flatMap((status) => {
      const projectId = status.project?.id;
      if (!projectId || !canLoadWorkbenchSnapshot(status, requestProductMode)) return [];
      return [loadNavigation(projectId, requestProductMode)];
    });
    await Promise.allSettled(requests);
  }, [loadNavigation]);

  const chooseConversation = useCallback(async (projectId: string, conversationId: string): Promise<void> => {
    const kind: SessionTransitionKind = stateRef.current.selectedProjectId === projectId
      ? "conversation-changed"
      : "project-changed";
    const generation = beginTransition(kind, projectId, conversationId);
    commitProjectSelection(projectId, conversationId);
    setSelectedRun(null);
    setStream(null);
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
    try {
      await refreshAtGeneration(projectId, conversationId, generation, productModeRef.current, false);
    } catch (cause) {
      if (generation === requestGenerationRef.current && stateRef.current.selectedProjectId === projectId
        && stateRef.current.selectedTopic === conversationId) setSnapshotError(userFacingErrorMessage(cause, "conversation"));
    }
  }, [beginTransition, commitProjectSelection, refreshAtGeneration]);

  const removeProject = useCallback(async (projectId: string): Promise<void> => {
    const status = findProject(stateRef.current.projects, projectId);
    const name = projectDisplayName(status?.project, projectId);
    const api = sessionApi(portsRef.current);
    const confirmation = await api.prepareProjectRemoval(projectId);
    if (!(portsRef.current.ui?.confirmRemoveProject(name, confirmation)
      ?? defaultConfirmRemoveProject(name, confirmation))) return;
    ++requestGenerationRef.current;
    await api.removeProject(projectId, confirmation.token);
    for (const key of navigationGenerationsRef.current.keys()) {
      if (key.startsWith(`${projectId}\0`)) {
        navigationGenerationsRef.current.set(key, (navigationGenerationsRef.current.get(key) ?? 0) + 1);
        navigationDirtyRef.current.delete(key);
      }
    }
    portsRef.current.timeline?.clearProject(projectId);
    setProjectModeSnapshots((current) => withoutProjectSnapshots(current, projectId));
    setNavigationLists((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${projectId}\0`))));
    setNavigationErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${projectId}\0`))));
    setExpandedProjects((current) => withoutSetValue(current, projectId));
    if (stateRef.current.selectedProjectId === projectId) {
      portsRef.current.operations?.invalidate();
      portsRef.current.resources?.cleanupTransition("project-changed");
      navigation(portsRef.current).clearPersistedProjectId();
      navigation(portsRef.current).syncLocation(null, null);
      setSelectedProjectId(null);
      setSelectedTopic(null);
      setSelectedRun(null);
      setStream(null);
      setSnapshot(emptySnapshotForMode(productModeRef.current));
      setPendingDemandConversation(null);
      pendingDemandRef.current = null;
    }
    await refreshProjects();
    await refresh(null, null);
  }, [refresh, refreshProjects]);

  const settleConversationLifecycle = useCallback(async (input: {
    projectId: string;
    conversationId: string;
    action: "archive" | "restore" | "delete";
    expectedLifecycleRevision: string;
    confirmationToken?: string | null;
  }): Promise<void> => {
    const productMode = productModeRef.current;
    const archiveKey = `${input.projectId}\0${productMode}\0${input.conversationId}`;
    if (input.action === "archive") {
      if (archivingKeysRef.current.has(archiveKey)) return;
      archivingKeysRef.current.add(archiveKey);
      setArchivingKeys(new Set(archivingKeysRef.current));
    }
    const selectedProjectIdAtStart = stateRef.current.selectedProjectId;
    const selectedTopicAtStart = stateRef.current.selectedTopic;
    try {
      await sessionApi(portsRef.current).settleConversationLifecycle({
        ...input,
        productMode,
        clientRequestId: `conversation-lifecycle-${crypto.randomUUID()}`,
      });
    } catch (cause) {
      if (input.action === "archive") {
        archivingKeysRef.current.delete(archiveKey);
        setArchivingKeys(new Set(archivingKeysRef.current));
      }
      throw cause;
    }
    void loadNavigation(input.projectId, productMode, true).catch(reportError);
    if (input.action === "delete") portsRef.current.timeline?.clearConversation(input.projectId, input.conversationId);
    if (input.action === "archive") {
      if (productModeRef.current === productMode && stateRef.current.selectedProjectId === input.projectId
        && stateRef.current.selectedTopic === input.conversationId) {
        beginTransition("conversation-changed", input.projectId, null);
        commitProjectSelection(input.projectId, null);
        setSelectedRun(null);
        setStream(null);
        setPendingDemandConversation(null);
        pendingDemandRef.current = null;
        setSnapshot((current) => ({ ...current, center: { ...current.center, selectedTopic: null } }));
      }
      archivingKeysRef.current.delete(archiveKey);
      setArchivingKeys(new Set(archivingKeysRef.current));
      return;
    }
    if (productModeRef.current !== productMode
      || selectedProjectIdAtStart !== input.projectId
      || stateRef.current.selectedProjectId !== input.projectId) return;
    const wasSelected = selectedTopicAtStart === input.conversationId;
    const selectedTopic = stateRef.current.selectedTopic;
    const selectionUnchanged = selectedTopic === selectedTopicAtStart
      || (wasSelected && selectedTopic === null);
    if (!selectionUnchanged) return;
    const conversationToRefresh = input.action === "restore"
      ? input.conversationId
      : !wasSelected
      ? selectedTopic
      : null;
    const generation = wasSelected && input.action !== "restore"
      ? beginTransition("conversation-changed", input.projectId, null)
      : ++requestGenerationRef.current;
    if (wasSelected && input.action !== "restore") {
      setSelectedTopic(null);
      setSelectedRun(null);
      setStream(null);
      setPendingDemandConversation(null);
      pendingDemandRef.current = null;
      navigation(portsRef.current).syncLocation(input.projectId, null);
    }
    await refreshAtGeneration(input.projectId, conversationToRefresh, generation, productMode);
  }, [beginTransition, commitProjectSelection, loadNavigation, refreshAtGeneration, reportError]);

  const acceptLifecycleInvalidation = useCallback((input: {
    projectId: string;
    productMode: ProductMode;
    conversationId: string;
    state: "active" | "archived" | "deleted";
  }): void => {
    if (input.state === "active" || productModeRef.current !== input.productMode
      || stateRef.current.selectedProjectId !== input.projectId
      || stateRef.current.selectedTopic !== input.conversationId) return;
    beginTransition("conversation-changed", input.projectId, null);
    commitProjectSelection(input.projectId, null);
    setSelectedRun(null);
    setStream(null);
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
    setSnapshot((current) => ({ ...current, center: { ...current.center, selectedTopic: null } }));
  }, [beginTransition, commitProjectSelection]);

  const prepareConversationDelete = useCallback(async (
    projectId: string,
    conversationId: string,
    expectedLifecycleRevision: string,
  ): Promise<ConversationDeleteConfirmation> => sessionApi(portsRef.current).prepareConversationDelete(
    projectId,
    conversationId,
    productModeRef.current,
    expectedLifecycleRevision,
  ), []);

  const chooseRun = useCallback(async (runId: string): Promise<void> => {
    const projectId = stateRef.current.selectedProjectId;
    if (!projectId) return;
    const generation = ++requestGenerationRef.current;
    setSelectedRun(runId);
    const next = await sessionApi(portsRef.current).loadStream(projectId, runId);
    if (generation !== requestGenerationRef.current) return;
    setStream(next);
  }, []);

  const beginPendingDemand = useCallback((input: Omit<PendingDemandConversation, "id" | "startedAt" | "canonical" | "productMode"> & {
    id?: string;
    startedAt?: string;
    productMode?: ProductMode;
  }): PendingDemandConversation => {
    const pending: PendingDemandConversation = {
      ...input,
      productMode: input.productMode ?? productModeRef.current,
      id: input.id ?? `pending:${Date.now().toString(36)}`,
      startedAt: input.startedAt ?? new Date().toISOString(),
      canonical: false,
    };
    setSelectedProjectId(input.projectId);
    setSelectedTopic(pending.id);
    setSelectedRun(null);
    setStream(null);
    setPendingDemandConversation(pending);
    pendingDemandRef.current = pending;
    navigation(portsRef.current).persistProjectId(input.projectId);
    navigation(portsRef.current).syncLocation(input.projectId, pending.id);
    return pending;
  }, []);

  const ensureProjectRegistered = useCallback(async (projectId: string): Promise<string | null> => {
    const status = stateRef.current.projects.find((item) => item.project?.id === projectId) ?? null;
    if (!status?.project) {
      reportError("请先选择一个项目。");
      return null;
    }
    if (status.managed) return status.project.id;
    const saved = await sessionApi(portsRef.current).registerProject(status.path);
    if (saved.status) {
      stateRef.current.projects = [
        ...stateRef.current.projects.filter((candidate) => candidate.project?.id !== projectId && candidate.project?.id !== saved.project.id),
        saved.status,
      ];
      setProjects((current) => [
        ...current.filter((candidate) => candidate.project?.id !== projectId && candidate.project?.id !== saved.project.id),
        saved.status!,
      ]);
    }
    if (stateRef.current.selectedProjectId === projectId && saved.project.id !== projectId) {
      const selectedConversationId = stateRef.current.selectedTopic;
      const pending = pendingDemandRef.current;
      if (pending?.projectId === projectId) {
        const rekeyedPending = { ...pending, projectId: saved.project.id };
        pendingDemandRef.current = rekeyedPending;
        setPendingDemandConversation(rekeyedPending);
        stateRef.current = { ...stateRef.current, pendingDemandConversation: rekeyedPending };
      }
      setSelectedProjectId(saved.project.id);
      stateRef.current = { ...stateRef.current, selectedProjectId: saved.project.id };
      navigation(portsRef.current).persistProjectId(saved.project.id);
      navigation(portsRef.current).syncLocation(saved.project.id, selectedConversationId);
    }
    return saved.project.id;
  }, [reportError]);

  const rekeyPendingDemand = useCallback((input: {
    projectId: string;
    productMode: ProductMode;
    clientRequestId: string;
    conversationId: string;
    title: string;
    selectedProviderId?: string;
  }): PendingDemandRekeyResult => {
    const pending = pendingDemandRef.current;
    if (!pending) return "not-pending";
    if (pending.projectId !== input.projectId
      || input.productMode !== pending.productMode
      || input.productMode !== productModeRef.current
      || input.clientRequestId !== pending.clientRequestId) return "rejected";
    if (pending.canonical) {
      return pending.id === input.conversationId ? "already-canonical" : "rejected";
    }
    portsRef.current.timeline?.rekeyConversation?.({
      projectId: input.projectId,
      productMode: input.productMode,
      conversationId: pending.id,
    }, input.conversationId, input.clientRequestId);
    ++requestGenerationRef.current;
    setSelectedProjectId(input.projectId);
    setSelectedTopic(input.conversationId);
    navigation(portsRef.current).persistProjectId(input.projectId);
    navigation(portsRef.current).syncLocation(input.projectId, input.conversationId);
    const canonical = {
      ...pending,
      id: input.conversationId,
      title: input.title,
      canonical: true,
      selectedProviderId: input.selectedProviderId ?? pending.selectedProviderId,
    };
    setPendingDemandConversation(canonical);
    pendingDemandRef.current = canonical;
    return "rekeyed";
  }, []);

  const createDemandConversation = useCallback(async (
    request: CreateDemandConversationInput,
    routeEvent: (projectId: string, event: WorkbenchLiveEvent) => void,
  ): Promise<{ projectId: string; conversationId: string }> => {
    const previousConversationId = stateRef.current.selectedTopic;
    let boundConversationId: string | null = null;
    const requestOwnsCurrentSelection = request.productMode === productModeRef.current
      && stateRef.current.selectedProjectId === request.projectId;
    let requestGeneration = requestGenerationRef.current;
    if (request.showPendingBeforeCreate && requestOwnsCurrentSelection) {
      portsRef.current.ui?.restoreView({ orchestrationOpen: false, settingsOpen: false });
      beginPendingDemand({
        id: `pending:${request.clientRequestId}`,
        projectId: request.projectId,
        productMode: request.productMode,
        clientRequestId: request.clientRequestId,
        title: "新需求",
        body: request.body,
        selectedProviderId: request.providerId,
      });
      requestGeneration = requestGenerationRef.current;
    } else if (requestOwnsCurrentSelection) requestGeneration = ++requestGenerationRef.current;
    const canApplyToCurrentSelection = (): boolean => requestGenerationRef.current === requestGeneration
      && productModeRef.current === request.productMode
      && stateRef.current.selectedProjectId === request.projectId;
    try {
      await sessionApi(portsRef.current).createDemandConversation(request, (event) => {
          if (event.event === "topic.created") {
            if (!topicCreatedMatchesRequest(event, request)) return;
            const eventConversationId = event.data.topic.conversationId
              ?? event.data.topic.id
              ?? event.data.topic.changeId
              ?? null;
            if (!eventConversationId
              || (boundConversationId && boundConversationId !== eventConversationId)) return;
            if (!boundConversationId) {
              invalidateNavigation(request.projectId, request.productMode);
              if (canApplyToCurrentSelection()) {
                const rekeyResult = rekeyPendingDemand({
                  projectId: request.projectId,
                  productMode: request.productMode,
                  clientRequestId: request.clientRequestId,
                  conversationId: eventConversationId,
                  title: event.data.topic.title,
                  selectedProviderId: event.data.topic.selectedProviderId,
                });
                if (rekeyResult === "rejected") return;
                if (rekeyResult !== "not-pending") requestGeneration = requestGenerationRef.current;
              }
              boundConversationId = eventConversationId;
            }
            if (canApplyToCurrentSelection()) routeEvent(request.projectId, event);
            return;
          }
          if (!boundConversationId) return;
          const exactTurnControlInvalidation = event.event === "conversation.turn-control.invalidated"
            && event.data.conversationId === boundConversationId;
          if (canApplyToCurrentSelection() && (exactTurnControlInvalidation || eventMatchesConversationScope(event, {
            projectId: request.projectId,
            productMode: request.productMode,
            conversationId: boundConversationId,
          }))) {
            routeEvent(request.projectId, event);
            if (event.event === "conversation.turn-control.invalidated") {
              requestGeneration = ++requestGenerationRef.current;
              void refreshAtGeneration(
                request.projectId,
                boundConversationId,
                requestGeneration,
                request.productMode,
              ).catch(reportError);
            }
          }
        });
      if (!boundConversationId) throw new Error("Demand conversation was not created.");
      if (!canApplyToCurrentSelection()) return { projectId: request.projectId, conversationId: boundConversationId };
      ++requestGenerationRef.current;
      setSelectedProjectId(request.projectId);
      setProductMode(request.productMode);
      productModeRef.current = request.productMode;
      setSelectedTopic(boundConversationId);
      setPendingDemandConversation(null);
      pendingDemandRef.current = null;
      navigation(portsRef.current).persistProjectId(request.projectId);
      navigation(portsRef.current).syncLocation(request.projectId, boundConversationId);
      return { projectId: request.projectId, conversationId: boundConversationId };
    } catch (cause) {
      if (boundConversationId) {
        if (canApplyToCurrentSelection()) {
          ++requestGenerationRef.current;
          setPendingDemandConversation(null);
          pendingDemandRef.current = null;
          setSelectedProjectId(request.projectId);
          setSelectedTopic(boundConversationId);
          navigation(portsRef.current).syncLocation(request.projectId, boundConversationId);
          reportError(cause);
        }
        return { projectId: request.projectId, conversationId: boundConversationId };
      }
      if (!canApplyToCurrentSelection()) throw cause;
      ++requestGenerationRef.current;
      const pending = pendingDemandRef.current;
      const keepFailedPendingConversation = request.showPendingBeforeCreate
        && pending?.projectId === request.projectId
        && pending.productMode === request.productMode
        && pending.clientRequestId === request.clientRequestId
        && pending.id === `pending:${request.clientRequestId}`;
      if (!keepFailedPendingConversation) {
        setPendingDemandConversation(null);
        pendingDemandRef.current = null;
        setSelectedTopic(previousConversationId);
        navigation(portsRef.current).syncLocation(stateRef.current.selectedProjectId, previousConversationId);
      }
      throw cause;
    }
  }, [beginPendingDemand, invalidateNavigation, refreshAtGeneration, rekeyPendingDemand, reportError]);

  const acceptCanonicalConversation = useCallback((input: {
    projectId: string;
    productMode?: ProductMode;
    clientRequestId?: string;
    conversationId: string;
    title: string;
    selectedProviderId?: string;
  }): boolean => {
    if (!input.productMode || !input.clientRequestId) return false;
    const result = rekeyPendingDemand({ ...input, productMode: input.productMode, clientRequestId: input.clientRequestId });
    return result === "rekeyed" || result === "already-canonical";
  }, [rekeyPendingDemand]);

  const reconcileConversationTitle = useCallback((projectId: string, conversation: Topic): void => {
    if (conversation.productMode !== productModeRef.current) return;
    const patchSnapshot = (current: Snapshot): Snapshot => ({
      ...current,
      left: {
        ...current.left,
        topics: current.left.topics.map((topic) => topic.id === conversation.id
          && canApplyConversationVersion(topic, conversation)
          ? { ...topic, ...conversation }
          : topic),
        workpads: current.left.workpads?.map((workpad) => workpad.id === conversation.id
          && canApplyConversationVersion(workpad, conversation)
          ? { ...workpad, title: conversation.title, updatedAt: conversation.updatedAt ?? workpad.updatedAt }
          : workpad),
      },
      center: {
        ...current.center,
        selectedTopic: current.center.selectedTopic?.id === conversation.id
          && canApplyConversationVersion(current.center.selectedTopic, conversation)
          ? { ...current.center.selectedTopic, title: conversation.title, updatedAt: conversation.updatedAt }
          : current.center.selectedTopic,
      },
    });
    if (stateRef.current.selectedProjectId === projectId) setSnapshot(patchSnapshot);
    const cacheKey = snapshotCacheKey(projectId, productModeRef.current);
    setProjectModeSnapshots((current) => current[cacheKey]
      ? { ...current, [cacheKey]: patchSnapshot(current[cacheKey]!) }
      : current);
    setNavigationLists((current) => current[cacheKey]
      ? { ...current, [cacheKey]: current[cacheKey]!.map((item) => item.id === conversation.id
        && canApplyConversationVersion(item, conversation)
        ? { ...item, title: conversation.title, updatedAt: conversation.updatedAt }
        : item) }
      : current);
    setPendingDemandConversation((current) => current?.projectId === projectId && current.id === conversation.id
      && canApplyConversationVersion(current, conversation)
      ? { ...current, title: conversation.title, updatedAt: conversation.updatedAt }
      : current);
  }, []);

  const updateConversationTitle = useCallback(async (projectId: string, conversationId: string, title: string): Promise<void> => {
    const result = await sessionApi(portsRef.current).updateConversationTitle(projectId, conversationId, title);
    reconcileConversationTitle(projectId, result.conversation);
    void loadNavigation(projectId, productModeRef.current, true).catch(reportError);
  }, [loadNavigation, reconcileConversationTitle, reportError]);

  const completePendingDemand = useCallback((): void => {
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
  }, []);

  const cancelPendingDemand = useCallback((restoreConversationId: string | null): void => {
    ++requestGenerationRef.current;
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
    setSelectedTopic(restoreConversationId);
    navigation(portsRef.current).syncLocation(stateRef.current.selectedProjectId, restoreConversationId);
  }, []);

  const acceptSnapshot = useCallback((projectId: string, next: Snapshot, expectedEpoch = requestGenerationRef.current): void => {
    const expectedMode = productModeRef.current;
    if (stateRef.current.selectedProjectId !== projectId
      || !isCurrentSelection(expectedEpoch, expectedMode, requestGenerationRef, productModeRef)
      || !snapshotMatchesSelection(next, projectId, expectedMode, stateRef.current.selectedTopic)) return;
    const conversationId = next.center.selectedTopic?.id ?? null;
    const selectedConversationId = stateRef.current.selectedTopic;
    if (selectedConversationId && !selectedConversationId.startsWith("pending:") && conversationId !== selectedConversationId) return;
    setSnapshot(next);
    setProjectModeSnapshots((current) => cacheSnapshot(current, projectId, expectedMode, next));
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
  }, []);

  const updateSnapshot = useCallback((updater: (current: Snapshot) => Snapshot): void => {
    setSnapshot((current) => {
      const next = updater(current);
      const projectId = stateRef.current.selectedProjectId;
      const expectedMode = productModeRef.current;
      if (!snapshotMatchesSelection(current, projectId, expectedMode, stateRef.current.selectedTopic)
        || !snapshotMatchesSelection(next, projectId, expectedMode, stateRef.current.selectedTopic)) return current;
      if (projectId) {
        setProjectModeSnapshots((cached) => cacheSnapshot(cached, projectId, expectedMode, next));
      }
      return next;
    });
  }, []);

  const cacheProjectSnapshot = useCallback((projectId: string, next: Snapshot): void => {
    const expectedMode = productModeRef.current;
    if (!snapshotMatchesMode(next, expectedMode) || next.project?.id !== projectId) return;
    setProjectModeSnapshots((current) => cacheSnapshot(current, projectId, expectedMode, next));
  }, []);

  const upsertProjectStatus = useCallback((status: ProjectStatus): void => {
    const projectId = status.project?.id;
    if (!projectId) return;
    setProjects((current) => {
      const index = current.findIndex((candidate) => candidate.project?.id === projectId);
      if (index < 0) return [...current, status];
      const next = [...current];
      next[index] = status;
      return next;
    });
  }, []);

  const switchProductMode = useCallback(async (targetProductMode: ProductMode): Promise<void> => {
    if (targetProductMode === productModeRef.current) return;
    const projectId = stateRef.current.selectedProjectId;
    const generation = ++requestGenerationRef.current;
    const previous = stateRef.current;
    portsRef.current.operations?.invalidate();
    portsRef.current.resources?.cleanupTransition("conversation-changed");
    if (projectId) {
      portsRef.current.ui?.transition({
        kind: "conversation-changed",
        fromProjectId: previous.selectedProjectId,
        fromProductMode: previous.productMode,
        fromConversationId: previous.selectedTopic,
        toProjectId: projectId,
        toProductMode: targetProductMode,
        toConversationId: null,
        resetComposerText: false,
      });
    }
    productModeRef.current = targetProductMode;
    setProductMode(targetProductMode);
    for (const expandedProjectId of expandedProjects) {
      if (expandedProjectId === projectId) continue;
      const expandedStatus = findProject(stateRef.current.projects, expandedProjectId);
      if (canLoadWorkbenchSnapshot(expandedStatus, targetProductMode)) {
        void loadNavigation(expandedProjectId, targetProductMode).catch(reportError);
      }
    }
    setSelectedTopic(null);
    setSelectedRun(null);
    setStream(null);
    setPendingDemandConversation(null);
    pendingDemandRef.current = null;
    portsRef.current.timeline?.invalidateProjection();
    if (!projectId) {
      setSnapshot(emptySnapshotForMode(targetProductMode));
      return;
    }
    navigation(portsRef.current).syncLocation(projectId, null);
    const status = findProject(stateRef.current.projects, projectId);
    const cached = projectModeSnapshots[snapshotCacheKey(projectId, targetProductMode)];
    if (cached && snapshotMatchesMode(cached, targetProductMode)) {
      setSnapshot(cached);
    } else {
      setSnapshot(snapshotForProject(status, targetProductMode));
    }
    if (!canLoadWorkbenchSnapshot(status, targetProductMode)) return;
    await refreshAtGeneration(projectId, null, generation, targetProductMode);
  }, [expandedProjects, loadNavigation, projectModeSnapshots, refreshAtGeneration, reportError]);

  useEffect(() => {
    if (requestedProductMode === productModeRef.current) return;
    let active = true;
    switchProductMode(requestedProductMode).catch((cause: unknown) => {
      if (active && requestedProductMode === productModeRef.current) reportError(cause);
    });
    return () => { active = false; };
  }, [reportError, requestedProductMode, switchProductMode]);

  useEffect(() => {
    if (ports.autoLoad === false) return;
    let active = true;
    const loading = loadApp();
    const generation = requestGenerationRef.current;
    loading.catch((cause: unknown) => {
      if (active && generation === requestGenerationRef.current) reportError(cause);
    });
    return () => {
      active = false;
      requestGenerationRef.current += 1;
    };
  }, [loadApp, ports.autoLoad, reportError]);

  useEffect(() => {
    const projectId = selectedProjectId;
    const requestProductMode = productModeRef.current;
    const selectionGeneration = requestGenerationRef.current;
    if (!projectId || selectedTopic?.startsWith("pending:")
      || !snapshotMatchesSelection(snapshot, projectId, requestProductMode, selectedTopic)) return;
    const runs = snapshot.center.agentLoop.runs;
    const runId = selectedRun ?? runs[0]?.id ?? null;
    if (!runId) {
      setSelectedRun(null);
      setStream(null);
      return;
    }
    if (runId !== selectedRun) setSelectedRun(runId);
    const generation = ++streamEffectGenerationRef.current;
    sessionApi(portsRef.current).loadStream(projectId, runId)
      .then((next) => {
        if (generation === streamEffectGenerationRef.current
          && stateRef.current.selectedProjectId === projectId
          && isCurrentSelection(selectionGeneration, requestProductMode, requestGenerationRef, productModeRef)) setStream(next);
      })
      .catch((cause: unknown) => {
        if (generation === streamEffectGenerationRef.current
          && stateRef.current.selectedProjectId === projectId
          && isCurrentSelection(selectionGeneration, requestProductMode, requestGenerationRef, productModeRef)) {
          reportError(cause);
        }
      });
    return () => { streamEffectGenerationRef.current += 1; };
  }, [reportError, selectedProjectId, selectedRun, selectedTopic, snapshot.center.agentLoop.runs,
    snapshot.center.selectedTopic?.id, snapshot.productMode, snapshot.project?.id]);

  return {
    projects,
    productMode,
    selectionEpoch: requestGenerationRef.current,
    selectedProjectId,
    snapshot,
    snapshotError,
    selectedTopic,
    selectedRun,
    stream,
    expandedProjects,
    projectSnapshots,
    projectNavigation,
    projectNavigationErrors,
    archivingKeys,
    invalidateNavigation,
    retryNavigation,
    pendingDemandConversation,
    loadApp,
    refresh,
    openProject,
    beginNewConversation,
    toggleProjectFolder,
    prepareProjectNavigationSearch,
    chooseConversation,
    chooseRun,
    removeProject,
    settleConversationLifecycle,
    acceptLifecycleInvalidation,
    prepareConversationDelete,
    beginPendingDemand,
    ensureProjectRegistered,
    createDemandConversation,
    acceptCanonicalConversation,
    reconcileConversationTitle,
    updateConversationTitle,
    completePendingDemand,
    cancelPendingDemand,
    acceptSnapshot,
    updateSnapshot,
    cacheProjectSnapshot,
    upsertProjectStatus,
  };
}

function canApplyConversationVersion(
  current: { title: string; updatedAt?: string },
  incoming: { title: string; updatedAt?: string },
): boolean {
  if (!current.updatedAt) return true;
  if (!incoming.updatedAt) return false;
  if (incoming.updatedAt > current.updatedAt) return true;
  return incoming.updatedAt === current.updatedAt && incoming.title === current.title;
}

const defaultApi: ProjectConversationSessionApi = {
  loadAppStatus: () => fetchJson<AppStatus>("/api/app/status"),
  loadProjects: async () => (await fetchJson<{ projects: ProjectStatus[] }>("/api/projects")).projects,
  registerProject: (path) => postJson("/api/projects", { path, confirm: true }),
  loadSnapshot: (projectId, productMode, conversationId) => fetchSnapshot(
    `/api/projects/${encodeURIComponent(projectId)}/workbench/snapshot?productMode=${encodeURIComponent(productMode)}&compactThread=1${conversationId ? `&topic=${encodeURIComponent(conversationId)}` : ""}`,
  ),
  loadNavigation: (projectId, productMode) => fetchJson(
    `/api/projects/${encodeURIComponent(projectId)}/workbench/navigation?productMode=${encodeURIComponent(productMode)}&state=active`,
  ),
  loadStream: (projectId, runId) => fetchJson<StreamPacket>(
    `/api/projects/${encodeURIComponent(projectId)}/workbench/stream/${encodeURIComponent(runId)}`,
  ),
  prepareProjectRemoval: (projectId) => postJson<ProjectRemovalConfirmation>(
    `/api/projects/${encodeURIComponent(projectId)}/removal-confirmation`,
    {},
  ),
  removeProject: async (projectId, confirmationToken) => {
    await postJson(`/api/projects/${encodeURIComponent(projectId)}/remove`, {
      confirm: true,
      confirmationToken,
    });
  },
  prepareConversationDelete: (projectId, conversationId, productMode, expectedLifecycleRevision) => postJson(
    `/api/projects/${encodeURIComponent(projectId)}/workbench/conversations/${encodeURIComponent(conversationId)}/lifecycle/delete-confirmation`,
    { productMode, expectedLifecycleRevision },
  ),
  settleConversationLifecycle: (input) => postJson(
    `/api/projects/${encodeURIComponent(input.projectId)}/workbench/conversations/${encodeURIComponent(input.conversationId)}/lifecycle`,
    {
      productMode: input.productMode,
      action: input.action,
      expectedLifecycleRevision: input.expectedLifecycleRevision,
      clientRequestId: input.clientRequestId,
      confirmationToken: input.confirmationToken ?? null,
    },
  ),
  updateConversationTitle: (projectId, conversationId, title) => postJson(
    `/api/projects/${encodeURIComponent(projectId)}/workbench/topics/${encodeURIComponent(conversationId)}/title`,
    { title },
  ),
  createDemandConversation: (input, onEvent) => consumeWorkbenchLiveStream<WorkbenchLiveEvent>(
    `/api/projects/${encodeURIComponent(input.projectId)}/workbench/topics/live`,
    {
      body: input.body,
      contextRefs: input.contextRefs,
      attachmentIds: input.attachmentIds,
      confirm: true,
      providerId: input.providerId,
      productMode: input.productMode,
      agentTurnMode: input.agentTurnMode,
      agentAccessMode: input.agentAccessMode,
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      clientRequestId: input.clientRequestId,
      skillOverrides: input.skillOverrides,
    },
    onEvent,
  ),
};

function sessionApi(ports: ProjectConversationSessionPorts): ProjectConversationSessionApi {
  return { ...defaultApi, ...ports.api };
}

function navigation(ports: ProjectConversationSessionPorts) {
  return ports.navigation ?? defaultNavigation;
}

const defaultNavigation = {
  readRestoreParams: readWorkbenchRestoreParams,
  readPersistedProjectId(): string | null {
    try {
      const value = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
      return value?.trim() || null;
    } catch {
      return null;
    }
  },
  persistProjectId(projectId: string): void {
    try { window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId); } catch { /* preference only */ }
  },
  clearPersistedProjectId(): void {
    try { window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY); } catch { /* preference only */ }
  },
  syncLocation(projectId: string | null, conversationId: string | null): void {
    try {
      const url = new URL(window.location.href);
      if (projectId) url.searchParams.set("project", projectId);
      else url.searchParams.delete("project");
      if (projectId && conversationId && !conversationId.startsWith("pending:")) url.searchParams.set("topic", conversationId);
      else url.searchParams.delete("topic");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Session state remains usable without host History APIs.
    }
  },
};

function readWorkbenchRestoreParams(): WorkbenchRestoreParams {
  try {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab")?.trim().toLowerCase();
    return {
      projectId: nonEmpty(params.get("project")),
      topicId: nonEmpty(params.get("topic")),
      orchestrationOpen: tab === "orchestration",
      settingsOpen: tab === "settings",
    };
  } catch {
    return { projectId: null, topicId: null, orchestrationOpen: false, settingsOpen: false };
  }
}

function nonEmpty(value: string | null): string | null {
  return value?.trim() || null;
}

function findProject(projects: ProjectStatus[], projectId: string | null): ProjectStatus | null {
  return projectId ? projects.find((item) => item.project?.id === projectId) ?? null : null;
}

function canLoadWorkbenchSnapshot(
  status: ProjectStatus | null | undefined,
  productMode: ProductMode,
): status is ProjectStatus {
  return Boolean(
    status?.project
    && status.runtimeAvailability?.state !== "unavailable"
    && (productMode === "agent" || status.managed),
  );
}

function withoutSetValue(values: Set<string>, value: string): Set<string> {
  const next = new Set(values);
  next.delete(value);
  return next;
}

function defaultConfirmRemoveProject(
  projectName: string,
  _confirmation: ProjectRemovalConfirmation,
): boolean {
  return window.confirm(removalConfirmationMessage(projectName));
}

export function removalConfirmationMessage(projectName: string): string {
  return `永久移出“${projectName}”？\n\n这会停止该项目正在运行的 Agent，并永久删除 AHO 中的会话、执行记录和日志。删除后无法在 Workbench 中恢复。\n\n项目源码、项目协作配置、Git 独立工作区和 Git 历史会保留。`;
}

export function snapshotForProject(
  project: ProjectStatus | null | undefined,
  productMode: ProductMode = "harness",
): Snapshot {
  if (!project?.project) return emptySnapshotForMode(productMode);
  const empty = emptySnapshotForMode(productMode);
  return {
    ...empty,
    project: project.project,
    harness: {
      harnessReady: project.harness.readiness === "ready",
    },
    center: { ...empty.center, workpad: emptyWorkpad(projectDisplayName(project.project)) },
    warnings: project.managed ? [] : ["创建第一条会话即可开始使用。"],
  };
}

function newConversationSnapshot(base: Snapshot, status: ProjectStatus): Snapshot {
  return {
    ...base,
    center: {
      selectedTopic: null,
      workpad: emptyWorkpad(projectDisplayName(base.project ?? status.project, "当前项目")),
      thread: { items: [] },
      conversationInteractions: { productMode: base.productMode, items: [] },
      activeTab: "conversation",
      agentLoop: { runs: [] },
    },
    right: {
      ...base.right,
      decisionInspector: { primary: null, related: [], history: [] },
      confirmationQueue: { primary: null, current: [], otherDemands: [], maintenance: [], history: [] },
    },
  };
}

function emptyWorkpad(projectName = "未选择项目"): Workpad {
  return {
    title: "项目需求",
    subtitle: projectName,
    state: "diagnostic",
    userStatus: "later",
    userStatusLabel: "稍后处理",
    conversationLifecycle: "active",
    pendingFeedback: [],
    intake: {
      goal: "尚未选择可用需求对话。",
      currentUnderstanding: "选择项目并创建需求对话后，AHO 会在这里汇总目标、进度、证据和下一步。",
      source: "diagnostic",
      relatedArtifacts: [],
      missingInfo: [],
      confirmedConstraints: [],
      openQuestions: [],
      assumptions: [],
      pendingClarifications: [],
    },
    progress: {
      topicState: "none",
      spec: "unknown",
      plan: "unknown",
      tasks: "unknown",
      acCount: 0,
      taskCount: 0,
      runCount: 0,
    },
    tasks: [],
    codingPackages: [],
    taskGraph: { source: "missing", nodes: [], changeLevelEvidence: [], warnings: [] },
    evidence: [],
    blockers: [],
    warnings: [],
    nextAction: {
      id: "empty",
      label: "选择或创建需求对话",
      description: "先选择项目中的需求对话，或在输入框里创建新需求。",
      kind: "read-only",
      enabled: false,
      requiresConfirmation: false,
    },
  };
}

export const emptyWorkbenchSnapshot: Snapshot = {
  productMode: "harness",
  project: null,
  harness: {},
  left: { topics: [], workpads: [] },
  center: {
    selectedTopic: null,
    workpad: emptyWorkpad(),
    agentLoop: { runs: [] },
    thread: { items: [] },
    conversationInteractions: { productMode: "harness", items: [] },
    activeTab: "conversation",
  },
  right: {
    approvals: [],
    decisions: [],
    decisionInspector: { primary: null, related: [], history: [] },
    confirmationQueue: { primary: null, current: [], otherDemands: [], maintenance: [], history: [] },
  },
  harnessGaps: [],
  warnings: [],
};

export function emptySnapshotForMode(productMode: ProductMode): Snapshot {
  if (productMode === "harness") return emptyWorkbenchSnapshot;
  return {
    ...emptyWorkbenchSnapshot,
    productMode,
    center: {
      ...emptyWorkbenchSnapshot.center,
      conversationInteractions: { productMode, items: [] },
    },
  };
}

export function snapshotCacheKey(projectId: string, productMode: ProductMode): string {
  return `${projectId}\0${productMode}`;
}

function cacheSnapshot(
  current: Record<string, Snapshot>,
  projectId: string,
  productMode: ProductMode,
  snapshot: Snapshot,
): Record<string, Snapshot> {
  return { ...current, [snapshotCacheKey(projectId, productMode)]: snapshot };
}

function snapshotsForMode(
  current: Record<string, Snapshot>,
  productMode: ProductMode,
): Record<string, Snapshot> {
  const suffix = `\0${productMode}`;
  return Object.fromEntries(Object.entries(current)
    .filter(([key]) => key.endsWith(suffix))
    .map(([key, snapshot]) => [key.slice(0, -suffix.length), snapshot]));
}

function withoutProjectSnapshots(
  current: Record<string, Snapshot>,
  projectId: string,
): Record<string, Snapshot> {
  const prefix = `${projectId}\0`;
  return Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)));
}

function snapshotMatchesMode(snapshot: Snapshot, productMode: ProductMode): boolean {
  return snapshot.productMode === productMode
    && snapshot.center.conversationInteractions.productMode === productMode
    && (!snapshot.center.selectedTopic || snapshot.center.selectedTopic.productMode === productMode);
}

export function snapshotMatchesSelection(snapshot: Snapshot, projectId: string | null, productMode: ProductMode, conversationId: string | null): boolean {
  return snapshotMatchesMode(snapshot, productMode)
    && snapshot.project?.id === projectId
    && (conversationId?.startsWith("pending:") || (snapshot.center.selectedTopic?.id ?? null) === conversationId);
}

function isCurrentSelection(
  generation: number,
  productMode: ProductMode,
  generationRef: { current: number },
  productModeStateRef: { current: ProductMode },
): boolean {
  return generation === generationRef.current && productMode === productModeStateRef.current;
}

async function loadSnapshotWithDeepLinkFallback(
  api: ProjectConversationSessionApi,
  projectId: string,
  productMode: ProductMode,
  conversationId: string | null,
  allowFallback = true,
): Promise<Snapshot> {
  if (!conversationId) return api.loadSnapshot(projectId, productMode, null);
  try {
    return await api.loadSnapshot(projectId, productMode, conversationId);
  } catch (cause) {
    if (!allowFallback || !isUnavailableDeepLink(cause)) throw cause;
    return api.loadSnapshot(projectId, productMode, null);
  }
}

function isUnavailableDeepLink(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const status = "status" in cause && typeof cause.status === "number" ? cause.status : null;
  return cause.name === "Conflict" || cause.name === "NotFound" || status === 404 || status === 409;
}

async function fetchSnapshot(url: string): Promise<Snapshot> {
  const response = await fetch(url);
  if (!response.ok) throw new WorkbenchHttpError(response.status, await response.text());
  return response.json() as Promise<Snapshot>;
}

class WorkbenchHttpError extends Error {
  readonly technicalDetail: string;

  constructor(readonly status: number, technicalDetail: string) {
    super(`Workbench request failed (${status}).`);
    this.name = status === 409 ? "Conflict" : "WorkbenchHttpError";
    this.technicalDetail = technicalDetail;
  }
}

function eventMatchesConversationScope(event: WorkbenchLiveEvent, expected: {
  projectId: string;
  productMode: ProductMode;
  conversationId: string | null;
}): boolean {
  const data = event.data as Record<string, unknown>;
  const nestedConversation = data.conversation && typeof data.conversation === "object"
    ? data.conversation as Record<string, unknown>
    : null;
  const nestedTopic = data.topic && typeof data.topic === "object"
    ? data.topic as Record<string, unknown>
    : null;
  const center = data.center && typeof data.center === "object"
    ? data.center as Record<string, unknown>
    : null;
  const selectedTopic = center?.selectedTopic && typeof center.selectedTopic === "object"
    ? center.selectedTopic as Record<string, unknown>
    : null;
  const eventProjectId = typeof data.projectId === "string" ? data.projectId : expected.projectId;
  const eventProductMode = data.productMode === "agent" || data.productMode === "harness"
    ? data.productMode
    : nestedConversation?.productMode === "agent" || nestedConversation?.productMode === "harness"
      ? nestedConversation.productMode
      : nestedTopic?.productMode === "agent" || nestedTopic?.productMode === "harness"
        ? nestedTopic.productMode
        : selectedTopic?.productMode === "agent" || selectedTopic?.productMode === "harness"
          ? selectedTopic.productMode
          : undefined;
  const eventConversationId = typeof data.conversationId === "string"
    ? data.conversationId
    : typeof nestedConversation?.id === "string"
      ? nestedConversation.id
      : typeof nestedTopic?.id === "string"
        ? nestedTopic.id
        : typeof selectedTopic?.id === "string"
          ? selectedTopic.id
          : undefined;
  return eventProjectId === expected.projectId
    && eventProductMode === expected.productMode
    && Boolean(eventConversationId)
    && (!expected.conversationId || eventConversationId === expected.conversationId);
}

function topicCreatedMatchesRequest(
  event: WorkbenchLiveEvent,
  expected: Pick<CreateDemandConversationInput, "projectId" | "productMode" | "clientRequestId">,
): boolean {
  if (event.event !== "topic.created") return false;
  const data = event.data as Record<string, unknown>;
  return data.projectId === expected.projectId
    && data.productMode === expected.productMode
    && data.clientRequestId === expected.clientRequestId;
}
