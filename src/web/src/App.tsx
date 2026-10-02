import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type PointerEvent as ReactPointerEvent } from "react";
import { fetchJson } from "./api.js";
import { MainConversationView,
  AgentOfficePanel,
  RightToolRailShell,
  DecisionInspectorPane,
  ProjectFilesPanel,
  ProjectGitPanel,
  RuntimeDiagnosticsRailPanel,
  ResourceWorkspacePanel,
  TerminalDock,
  WorkspaceDockToggleBar,
  type RightToolRailTab,
  type RightToolRailState,
  type TerminalTab,
} from "./panels/WorkbenchPanels.js";
import {
  ProjectConversationSidebarFeature,
  TopicComposerFeature,
  UnmanagedProjectView,
  currentWorkpadSummary,
} from "./shell/WorkbenchShellParts.js";
import {
  ProjectHomeView,
  ProjectReadinessHomeFeature,
} from "./panels/ProjectHome.js";
import { SettingsSurface, type SettingsSection } from "./panels/SettingsSurface.js";
import {
  canonicalTimelineScopeKey,
  selectCanonicalTimelineSurface,
  selectCanonicalTimelineTranscript,
} from "./canonicalTimelineStore.js";
import { canonicalTimelineReconnectScopes, useCanonicalTimelineController } from "./canonicalTimelineController.js";
import { useWorkbenchProjectionStream } from "./workbenchProjectionStream.js";
import {
  projectDisplayName,
  stateLabel,
} from "./formatters.js";
import type {
  Snapshot,
  ProductMode,
  ParentAgentTranscript,
  Workpad,
  WorkbenchLiveEvent,
  TopicAttachment,
  TopicFileReference,
  RuntimeActivityLogSnapshot,
  RuntimeDiagnosticsSnapshot,
  CanonicalTimelineScope,
  CanonicalDocumentReference,
  ConversationInteractionSettlement,
  WorkspaceResourceTarget,
} from "./types.js";
import { ConversationInteractionDock } from "./panels/workbench/ConversationInteractionDock.js";
import { useGlobalOperationGate } from "./controllers/useGlobalOperationGate.js";
import { useMainConversationViewport } from "./controllers/useMainConversationViewport.js";
import { useApplicationNavigationController } from "./controllers/useApplicationNavigationController.js";
import { browserSessionNavigation } from "./controllers/useProjectConversationSession.js";
import { useWorkspaceResourceController } from "./controllers/useWorkspaceResourceController.js";
import { workspaceResourceModeHandoff } from "./controllers/workspaceResourceModeHandoff.js";
import { useProviderConfigurationController } from "./controllers/useProviderConfigurationController.js";
import { useConversationActionController } from "./controllers/useConversationActionController.js";
import { useDecisionInspectorController } from "./controllers/useDecisionInspectorController.js";
import { useAgentSurfaceController } from "./controllers/useAgentSurfaceController.js";
import { useProductModeActivityController } from "./controllers/useProductModeActivityController.js";
import { useProjectNavigationOverlayController } from "./controllers/useProjectNavigationOverlayController.js";
import { useConversationContextController } from "./controllers/useConversationContextController.js";
import { useConversationTurnQueueController } from "./controllers/useConversationTurnQueueController.js";
import { useConversationReviewController } from "./controllers/useConversationReviewController.js";
import { OfficeLoadingScreen } from "./office/OfficeLoadingScreen.js";
import {
  useConversationComposerController,
  type ComposerActionRequest,
} from "./controllers/useConversationComposerController.js";
import { emptySnapshotForMode, removalConfirmationMessage, snapshotMatchesSelection, useProjectConversationSession } from "./controllers/useProjectConversationSession.js";
import { useAppModeController } from "./controllers/AppModeController.js";
import { modePresentationPolicy } from "./presentation/ModePresentationPolicy.js";
import {
  projectConversationWorkspaceChrome,
  projectReadinessComposerSurface,
  topicComposerSurface,
} from "./presentation/conversation-workspace.js";
import { productModeToggleViewModel } from "./presentation/core-workbench-experience.js";
import { projectNavigationSurface } from "./presentation/project-navigation.js";
import { sanitizeTechnicalDetail, userFacingErrorMessage } from "./presentation/user-facing-language.js";
import { DesktopTitleBar } from "./shell/DesktopTitleBar.js";
import { WorkspaceNavigationHeader } from "./shell/WorkspaceNavigationHeader.js";

const LEFT_SIDEBAR_DEFAULT_WIDTH = 280;
const LEFT_SIDEBAR_MIN_WIDTH = 220;
const LEFT_SIDEBAR_MAX_WIDTH = 420;
const RIGHT_RAIL_DEFAULT_WIDTH = 320;
const RIGHT_RAIL_MIN_WIDTH = 280;
const RIGHT_RAIL_MAX_WIDTH = 560;
const SHELL_COLUMN_KEYBOARD_STEP = 16;
const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 720px)";
const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");
type BottomDockKind = "terminal" | null;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pointerClientX(event: { clientX?: number; pageX?: number; screenX?: number }): number {
  if (Number.isFinite(event.clientX)) return event.clientX ?? 0;
  if (Number.isFinite(event.pageX)) return event.pageX ?? 0;
  if (Number.isFinite(event.screenX)) return event.screenX ?? 0;
  return 0;
}

function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.isContentEditable
    || element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    setMatches(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [query]);
  return matches;
}

export function App(): ReactElement {
  const appMode = useAppModeController();
  const appNavigation = useApplicationNavigationController(appMode.productMode);
  const presentation = useMemo(() => modePresentationPolicy(appMode.productMode), [appMode.productMode]);
  const [orchestrationOpen, setOrchestrationOpen] = useState(appNavigation.location.surface === "orchestration");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileSidebarViewport = useMediaQuery(MOBILE_SIDEBAR_MEDIA_QUERY);
  const mobileSidebarModalOpen = mobileSidebarViewport && mobileSidebarOpen;
  const mobileSidebarRef = useRef<HTMLElement | null>(null);
  const mobileSidebarToggleRef = useRef<HTMLButtonElement | null>(null);
  const mobileSidebarWasOpenRef = useRef(false);
  const navigationOverlay = useProjectNavigationOverlayController();
  const navigationOverlayKindRef = useRef(navigationOverlay.state.kind);
  navigationOverlayKindRef.current = navigationOverlay.state.kind;
  const sidebarLocalDialogOpenRef = useRef(false);
  const setSidebarLocalDialogOpen = useCallback((open: boolean) => {
    sidebarLocalDialogOpenRef.current = open;
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(appNavigation.location.surface === "settings");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(appNavigation.location.settingsSection);
  const [managementRefreshVersions, setManagementRefreshVersions] = useState<Record<string, number>>({});
  const invalidateManagement = (projectId: string, productMode: ProductMode) => {
    const key = `${projectId}\0${productMode}`;
    setManagementRefreshVersions((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
  };
  const [homeComposerResetToken, setHomeComposerResetToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timeline = useCanonicalTimelineController(setError);
  const operationGate = useGlobalOperationGate();
  const actionRunning = operationGate.activeKey;
  const [selectedGitDiffPath, setSelectedGitDiffPath] = useState<string | null>(null);
  const [bottomDockKind, setBottomDockKind] = useState<BottomDockKind>(null);
  const [terminalDockHeight, setTerminalDockHeight] = useState(280);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnosticsSnapshot | null>(null);
  const [runtimeDiagnosticsLoading, setRuntimeDiagnosticsLoading] = useState(false);
  const [runtimeActivityLog, setRuntimeActivityLog] = useState<RuntimeActivityLogSnapshot | null>(null);
  const [runtimeActivityLogLoading, setRuntimeActivityLogLoading] = useState(false);
  const [rightToolRailState, setRightToolRailState] = useState<RightToolRailState>({ mode: "closed" });
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  const [rightToolRailWidth, setRightToolRailWidth] = useState(RIGHT_RAIL_DEFAULT_WIDTH);
  const [projectionVersion, setProjectionVersion] = useState(0);
  const selectedProjectIdRef = useRef<string | null>(null);
  const selectedConversationIdRef = useRef<string | null>(null);
  const projectionEventRouterRef = useRef<(projectId: string, event: WorkbenchLiveEvent) => void>(() => undefined);
  const session = useProjectConversationSession({
    autoLoad: false,
    productMode: appMode.productMode,
    navigation: { ...browserSessionNavigation,
      syncLocation: (projectId, conversationId) => appNavigation.syncSession(projectId, conversationId, appMode.productMode),
      conversationCreated: appNavigation.rekey,
    },
    timeline: {
      cacheEvent: timeline.ingestScopedEvent,
      invalidateProjection: invalidateProjectionCache,
      clearProject: timeline.clearProject,
      clearConversation: timeline.clearConversation,
      rekeyConversation: (from, toConversationId, clientRequestId) => timeline.rekeyOptimisticUserIntent({
        ...from,
        agentSurfaceId: "main-agent",
      }, {
        ...from,
        conversationId: toConversationId,
        agentSurfaceId: "main-agent",
      }, clientRequestId),
    },
    resources: {
      cleanupTransition: (kind) => workspaceResources.cleanupTransition(kind),
    },
    operations: operationGate,
    ui: {
      transition: (event) => {
        composer.cleanupTransition(event.kind);
        setRuntimeActivityLog(null);
        setOrchestrationOpen(false);
        setRightToolRailState({ mode: "closed" });
        if (event.resetComposerText) setHomeComposerResetToken((value) => value + 1);
      },
      restoreView: (view) => {
        setOrchestrationOpen(view.orchestrationOpen);
        if (view.settingsOpen) {
          setSettingsSection(appNavigation.getLocation().settingsSection);
          setSettingsOpen(true);
        }
      },
      confirmRemoveProject: (projectName) => window.confirm(removalConfirmationMessage(projectName)),
    },
    onError: setError,
  });
  const projects = session.projects;
  const selectedProjectId = session.selectedProjectId;
  const snapshot = session.snapshot;
  const selectedTopic = session.selectedTopic;
  const expandedProjects = session.expandedProjects;
  const projectSnapshots = session.projectSnapshots;
  const pendingDemandConversation = session.pendingDemandConversation;
  const modeActivity = useProductModeActivityController(selectedProjectId, appMode.productMode);

  useEffect(() => {
    if (!presentation.harness["governance-approvals"]
      && rightToolRailState.mode === "tool"
      && rightToolRailState.tool === "confirm") {
      setRightToolRailState({ mode: "launcher" });
    }
  }, [presentation.harness, rightToolRailState]);

  const appShellStyle = !settingsOpen ? ({
    "--left-sidebar-width": `${leftSidebarWidth}px`,
    "--right-rail-width": `${rightToolRailWidth}px`,
  } as CSSProperties) : undefined;

  function beginShellColumnResize(event: ReactPointerEvent, side: "left" | "right"): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = pointerClientX(event);
    const startWidth = side === "left" ? leftSidebarWidth : rightToolRailWidth;
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "ew-resize";
    document.body.classList.add("is-resizing-column");
    function onPointerMove(moveEvent: PointerEvent): void {
      const delta = pointerClientX(moveEvent) - startX;
      if (side === "left") {
        setLeftSidebarWidth(clampNumber(startWidth + delta, LEFT_SIDEBAR_MIN_WIDTH, LEFT_SIDEBAR_MAX_WIDTH));
      } else {
        setRightToolRailWidth(clampNumber(startWidth - delta, RIGHT_RAIL_MIN_WIDTH, RIGHT_RAIL_MAX_WIDTH));
      }
    }
    function onPointerUp(): void {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      document.body.style.cursor = previousCursor;
      document.body.classList.remove("is-resizing-column");
    }
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp, { once: true });
    document.addEventListener("pointercancel", onPointerUp, { once: true });
  }

  function ensureTerminalTab(): string {
    if (activeTerminalId && terminalTabs.some((tab) => tab.id === activeTerminalId)) return activeTerminalId;
    const id = `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setTerminalTabs((current) => [...current, { id, title: `终端 ${current.length + 1}` }]);
    setActiveTerminalId(id);
    return id;
  }

  function openTerminalDock(): void {
    ensureTerminalTab();
    setBottomDockKind("terminal");
  }

  function toggleTerminalDock(): void {
    if (bottomDockKind === "terminal") {
      setBottomDockKind(null);
      return;
    }
    openTerminalDock();
  }

  function createTerminalTab(): void {
    const id = `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setTerminalTabs((current) => [...current, { id, title: `终端 ${current.length + 1}` }]);
    setActiveTerminalId(id);
    setBottomDockKind("terminal");
  }

  function closeTerminalTab(id: string): void {
    if (selectedProjectId) {
      void fetch(`/api/projects/${encodeURIComponent(selectedProjectId)}/terminal/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
    setTerminalTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeTerminalId === id) setActiveTerminalId(next[0]?.id ?? null);
      if (next.length === 0 && bottomDockKind === "terminal") setBottomDockKind(null);
      return next;
    });
  }

  async function loadRuntimeDiagnostics(projectId = selectedProjectId): Promise<void> {
    setRuntimeDiagnosticsLoading(true);
    try {
      const path = projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/runtime/diagnostics`
        : "/api/runtime/diagnostics";
      setRuntimeDiagnostics(await fetchJson<RuntimeDiagnosticsSnapshot>(path));
    } catch (cause) {
      setRuntimeDiagnostics({
        generatedAt: new Date().toISOString(),
        summary: { status: "error", issueCount: 1, degradedCount: 0 },
        items: [{
          id: "diagnostics:load-error",
          title: "诊断读取失败",
          status: "error",
          summary: "无法读取运行诊断。",
          detail: sanitizeTechnicalDetail(cause instanceof Error ? ("technicalDetail" in cause && typeof cause.technicalDetail === "string" ? cause.technicalDetail : cause.message) : String(cause)),
        }],
      });
    } finally {
      setRuntimeDiagnosticsLoading(false);
    }
  }

  async function loadRuntimeActivityLog(projectId = selectedProjectId, topicId = activeTopic?.id ?? null): Promise<void> {
    if (!projectId) {
      setRuntimeActivityLog(null);
      return;
    }
    setRuntimeActivityLogLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (topicId) params.set("topicId", topicId);
      setRuntimeActivityLog(await fetchJson<RuntimeActivityLogSnapshot>(
        `/api/projects/${encodeURIComponent(projectId)}/runtime/activity?${params.toString()}`,
      ));
    } catch (cause) {
      const generatedAt = new Date().toISOString();
      setRuntimeActivityLog({
        generatedAt,
        projectId,
        topicId,
        limit: 100,
        truncated: false,
        items: [{
          id: "runtime-activity:load-error",
          timestamp: generatedAt,
          type: "action-error",
          severity: "error",
          title: "运行日志读取失败",
          summary: userFacingErrorMessage(cause, "load"),
          refs: [],
        }],
      });
    } finally {
      setRuntimeActivityLogLoading(false);
    }
  }

  async function loadApp(): Promise<void> {
    await session.loadApp({ restoreSelection: false });
  }

  async function loadSkillSummary(projectId = selectedProjectId, topicId = selectedTopic): Promise<void> {
    void topicId;
    await composer.reloadSkills(projectId);
  }

  async function refresh(projectId = selectedProjectId, topic = selectedTopic): Promise<Snapshot | void> {
    return session.refresh(projectId, topic);
  }

  function resizeShellColumnWithKeyboard(event: ReactKeyboardEvent, side: "left" | "right"): void {
    const isHorizontalArrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (!isHorizontalArrow && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const min = side === "left" ? LEFT_SIDEBAR_MIN_WIDTH : RIGHT_RAIL_MIN_WIDTH;
    const max = side === "left" ? LEFT_SIDEBAR_MAX_WIDTH : RIGHT_RAIL_MAX_WIDTH;
    const setWidth = side === "left" ? setLeftSidebarWidth : setRightToolRailWidth;
    setWidth((current) => {
      if (event.key === "Home") return min;
      if (event.key === "End") return max;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const sideDirection = side === "left" ? direction : -direction;
      return clampNumber(current + sideDirection * SHELL_COLUMN_KEYBOARD_STEP, min, max);
    });
  }

  async function openProject(projectId: string): Promise<void> {
    await appNavigation.visit({ projectId, conversationId: null, surface: "workspace", resource: null });
    setMobileSidebarOpen(false);
  }

  async function beginNewConversation(projectId = selectedProjectId ?? undefined): Promise<void> {
    if (projectId) await appNavigation.visit({ projectId, conversationId: null, surface: "workspace", resource: null });
    setMobileSidebarOpen(false);
  }

  async function toggleProjectFolder(projectId: string): Promise<void> {
    await session.toggleProjectFolder(projectId);
  }

  async function chooseConversation(projectId: string, conversationId: string): Promise<void> {
    setMobileSidebarOpen(false);
    await appNavigation.visit({ projectId, conversationId, surface: "workspace", resource: null });
  }

  async function removeProject(projectId: string): Promise<void> {
    await session.removeProject(projectId);
  }

  async function archiveConversation(projectId: string, conversationId: string, lifecycleRevision: string): Promise<void> {
    await session.settleConversationLifecycle({ projectId, conversationId, action: "archive", expectedLifecycleRevision: lifecycleRevision });
  }

  async function restoreConversation(projectId: string, conversationId: string, lifecycleRevision: string): Promise<void> {
    await session.settleConversationLifecycle({ projectId, conversationId, action: "restore", expectedLifecycleRevision: lifecycleRevision });
  }

  async function deleteConversation(projectId: string, conversationId: string, lifecycleRevision: string, confirmationToken: string): Promise<void> {
    await session.settleConversationLifecycle({ projectId, conversationId, action: "delete", expectedLifecycleRevision: lifecycleRevision, confirmationToken });
  }

  async function chooseRun(runId: string): Promise<void> {
    await session.chooseRun(runId);
  }

  function openSettings(section: SettingsSection = "basic"): void {
    setMobileSidebarOpen(false);
    navigationOverlay.close();
    void appNavigation.visit({ surface: "settings", settingsSection: section });
  }

  function changeSettingsSection(section: SettingsSection): void {
    void appNavigation.visit({ surface: "settings", settingsSection: section });
  }

  async function toggleComposerSkill(skillId: string): Promise<void> {
    await composer.toggleSkill(skillId);
  }

  async function appendComposerAttachments(files: File[]): Promise<TopicAttachment[]> {
    return composer.appendAttachments(files);
  }

  async function removeComposerAttachment(attachmentId: string): Promise<void> {
    await composer.removeAttachment(attachmentId);
  }

  async function createTopicFromText(body: string, fileRefs: TopicFileReference[] = [], attachmentIds: string[] = [], attachmentFiles: File[] = []): Promise<void> {
    await composer.createConversation({ body, fileRefs, attachmentIds, attachmentFiles });
  }

  async function sendTopicMessage(): Promise<void> {
    await composer.send();
  }

  async function stopAndContinueCurrentRun(): Promise<void> {
    await composer.stop();
  }

  async function settleConversationInteraction(interactionId: string, settlement: ConversationInteractionSettlement): Promise<void> {
    await conversationActions.settleInteraction(interactionId, settlement);
  }

  async function runComposerStopRequest(request: ComposerActionRequest): Promise<void> {
    if (!request.providerId || !request.expectedAttemptId) throw new Error("当前执行状态已经变化，请刷新后重试。");
    await conversationActions.interruptTurn({
      projectId: request.projectId, conversationId: request.conversationId, productMode: request.productMode,
      providerId: request.providerId, expectedAttemptId: request.expectedAttemptId,
    });
  }

  function openChildAgentWorkspace(agentSurfaceId: string): void {
    if (!agentSurfaceId || agentSurfaceId === "main-agent") return;
    const registered = agentSurfaces.surfaces.some((surface) => surface.kind === "agent" && surface.agentSurfaceId === agentSurfaceId);
    if (!registered) return;
    const conversationId = activeTopic?.id;
    if (!conversationId || !selectedProjectId) return;
    openWorkspaceResource({ kind: "agent", conversationId, agentSurfaceId });
    void timeline.loadLatest({ projectId: selectedProjectId, productMode: activeTopic.productMode, conversationId, agentSurfaceId });
  }

  function openWorkspaceResource(target: WorkspaceResourceTarget): void {
    void appNavigation.visit({ resource: target });
  }

  function selectWorkspaceResource(resourceId: string): void {
    const tab = workspaceResources.tabs.find((item) => item.resourceId === resourceId);
    if (tab) void appNavigation.visit({ resource: tab.target });
  }

  function closeWorkspaceResource(resourceId: string): void {
    const nextTarget = workspaceResources.closeResource(resourceId);
    if (workspaceResources.selectedResourceId === resourceId) appNavigation.replace({ resource: nextTarget });
  }

  function invalidateProjectionCache(): void {
    setProjectionVersion((value) => value + 1);
  }

  const snapshotMatchesCurrentMode = session.productMode === appMode.productMode
    && snapshotMatchesSelection(snapshot, selectedProjectId, appMode.productMode, selectedTopic);
  const activeModeSnapshot = snapshotMatchesCurrentMode
    ? snapshot
    : { ...emptySnapshotForMode(appMode.productMode), project: projects.find((item) => item.project?.id === selectedProjectId)?.project ?? null };
  const selectedTopicForMode = selectedTopic;
  const archivingSelected = Boolean(selectedProjectId && selectedTopicForMode
    && session.archivingKeys.has(`${selectedProjectId}\0${appMode.productMode}\0${selectedTopicForMode}`));
  const activePendingConversation = pendingDemandConversation
    && selectedProjectId === pendingDemandConversation.projectId
    && pendingDemandConversation.productMode === appMode.productMode
    && selectedTopicForMode === pendingDemandConversation.id
    ? pendingDemandConversation
    : null;
  const targetConversationMetadata = selectedProjectId && selectedTopicForMode && !selectedTopicForMode.startsWith("pending:")
    ? session.projectNavigation[selectedProjectId]?.find((conversation) => conversation.id === selectedTopicForMode) ?? null
    : null;
  const activeTopic = activePendingConversation
    ? {
      id: activePendingConversation.id,
      productMode: activePendingConversation.productMode,
      title: activePendingConversation.title,
      state: "active" as const,
      acCount: 0,
      taskCount: 0,
      kind: "conversation" as const,
      boundChangeId: null,
      selectedProviderId: activePendingConversation.selectedProviderId,
    }
    : archivingSelected ? null : activeModeSnapshot.center.selectedTopic ?? (selectedTopicForMode ? {
      id: selectedTopicForMode,
      productMode: appMode.productMode,
      title: targetConversationMetadata?.title ?? "需求对话",
      state: targetConversationMetadata?.state ?? "loading",
      acCount: 0,
      taskCount: 0,
      kind: "conversation" as const,
      boundChangeId: null,
      selectedProviderId: undefined,
    } : null);
  const activeConversationSnapshotReady = Boolean(
    snapshotMatchesCurrentMode
      && activeTopic?.id
      && activeModeSnapshot.center.selectedTopic?.id === activeTopic.id,
  );
  const readyConversationId = activeConversationSnapshotReady ? activeTopic?.id ?? null : null;
  const workspaceResources = useWorkspaceResourceController(workspaceResourceModeHandoff({ productMode: appMode.productMode }, {
    projectId: selectedProjectId,
    conversationId: readyConversationId,
    loadAgentTranscript: (target) => {
      if (!selectedProjectId) return;
      return timeline.loadLatest({
        projectId: selectedProjectId,
        productMode: appMode.productMode,
        conversationId: target.conversationId,
        agentSurfaceId: target.agentSurfaceId,
      });
    },
    operation: operationGate,
    routeProjectionEvent: routeProjectionEventForProject,
    calibrateAgentTranscript: (projectId, conversationId, agentSurfaceId) => timeline.loadLatest({
      projectId,
      productMode: appMode.productMode,
      conversationId,
      agentSurfaceId,
    }),
  }));
  const workspaceResourceTabs = workspaceResources.tabs;
  const selectedWorkspaceResourceId = workspaceResources.selectedResourceId;
  const workspaceDocuments = workspaceResources.documents;
  const workspaceResourceErrors = workspaceResources.resourceErrors;
  const loadingWorkspaceResourceIds = workspaceResources.loadingResourceIds;
  const activeTopicIsConversation = activeTopic?.kind === "conversation";
  selectedProjectIdRef.current = selectedProjectId;
  selectedConversationIdRef.current = activeTopic?.id ?? null;
  const selectedProjectDefaultProviderId = projects.find((item) => item.project?.id === selectedProjectId)?.project?.defaultProviderId ?? null;
  const providerConfiguration = useProviderConfigurationController({
    projectId: selectedProjectId,
    productMode: appMode.productMode,
    projectDefaultProviderId: selectedProjectDefaultProviderId,
    conversationProviderId: activeTopic?.selectedProviderId ?? null,
  });
  const providerDiagnostics = providerConfiguration.diagnostics;
  const providerModelSettings = providerConfiguration.modelSettings;
  const providerCapabilities = providerConfiguration.capabilities;
  const providerModelCatalogs = providerConfiguration.modelCatalogs;
  const composerProviderId = providerConfiguration.selectedProviderId;
  const composerProviderOptions = providerCapabilities.map((provider) => ({ id: provider.providerId, label: provider.displayName }));
  const isPendingTopic = Boolean(activePendingConversation && !activePendingConversation.canonical);
  const activeWorkpad = activePendingConversation ? emptyWorkpad(activePendingConversation.title) : activeModeSnapshot.center.workpad ?? emptyWorkpad(activeTopic?.title ?? projectDisplayName(snapshot.project));
  const conversationRunControl = activeWorkpad.runControlState;
  const agentRunControl = appMode.productMode === "agent" ? conversationRunControl : undefined;
  const composerRunning = appMode.productMode === "agent"
    ? Boolean(agentRunControl?.attemptId && agentRunControl.providerId && agentRunControl.state !== "idle")
    : activeWorkpad.conversationLifecycle === "running"
      || Boolean(activeWorkpad.runControlState?.canStop)
      || currentWorkpadSummary(activeModeSnapshot, activeTopic)?.runtimeStatus === "running";
  const conversationTurnQueue = useConversationTurnQueueController({
    projectId: selectedProjectId,
    productMode: appMode.productMode,
    conversationId: readyConversationId,
    executionKey: [
      conversationRunControl?.state ?? "idle",
      conversationRunControl?.providerId ?? "",
      conversationRunControl?.attemptId ?? "",
      conversationRunControl?.runId ?? "",
    ].join("\0"),
    onError: setError,
  });
  const selectedProjectStatus = useMemo(() => projects.find((item) => item.project?.id === selectedProjectId) ?? null, [projects, selectedProjectId]);
  const composer = useConversationComposerController({
    projectId: selectedProjectId,
    productMode: appMode.productMode,
    conversation: activeTopic && activeConversationSnapshotReady ? {
      id: activeTopic.id,
      productMode: activeTopic.productMode,
      agentTurnMode: activeTopic.agentTurnMode,
      agentModelId: activeTopic.agentModelId,
      agentReasoningEffort: activeTopic.agentReasoningEffort,
      state: activeTopic.state,
      selectedProviderId: activeTopic.selectedProviderId,
    } : null,
    projectRegistered: Boolean(selectedProjectStatus?.project),
    running: composerRunning,
    runControlState: conversationRunControl,
    selectedProviderId: composerProviderId,
    providerCount: providerCapabilities.length,
    providerCapabilities,
    providerCapabilitiesLoading: providerConfiguration.capabilitiesLoading,
    providerCapabilitiesError: providerConfiguration.capabilitiesError,
    providerModelSettings: providerModelSettings ?? providerDiagnostics?.models ?? null,
    providerModelCatalogs,
  }, {
    operation: operationGate,
    session: {
      ensureProjectRegistered: session.ensureProjectRegistered,
      createConversation: (request) => session.createDemandConversation(request, routeProjectionEventForProject),
      beginPendingConversation: (input) => { session.beginPendingDemand(input); },
      restoreDraftProvider: providerConfiguration.restoreDraftProvider,
      selectProvider: providerConfiguration.selectProvider,
    },
    actions: {
      stop: runComposerStopRequest,
    },
    projection: {
      refreshConversation: async (projectId, conversationId) => { await refresh(projectId, conversationId); },
      routeEvent: routeProjectionEventForProject,
    },
    timeline: {
      calibrate: (projectId, conversationId, agentSurfaceId) => timeline.loadLatest({ projectId, productMode: appMode.productMode, conversationId, agentSurfaceId }),
      showPending: (scope, clientRequestId, text) => timeline.showOptimisticUserIntent({ ...scope, agentSurfaceId: "main-agent" }, clientRequestId, text),
      markPending: (scope, clientRequestId, state, failure) => timeline.updateOptimisticUserIntent({ ...scope, agentSurfaceId: "main-agent" }, clientRequestId, state, failure),
      consumePending: (scope, clientRequestId) => timeline.consumeOptimisticUserIntentActions({ ...scope, agentSurfaceId: "main-agent" }, clientRequestId),
      rekeyPending: (from, to, clientRequestId) => timeline.rekeyOptimisticUserIntent(
        { ...from, agentSurfaceId: "main-agent" },
        { ...to, agentSurfaceId: "main-agent" },
        clientRequestId,
      ),
    },
    queue: conversationTurnQueue,
    onError: setError,
  });
  const conversationContext = useConversationContextController({
    projectId: selectedProjectId,
    productMode: appMode.productMode,
    conversationId: readyConversationId,
    snapshot: activeModeSnapshot.center.conversationContext ?? null,
    refreshConversation: async (projectId, conversationId) => { await refresh(projectId, conversationId); },
    onError: setError,
  });
  const conversationReview = useConversationReviewController({
    projectId: selectedProjectId,
    productMode: appMode.productMode,
    conversationId: readyConversationId,
    providerId: composerProviderId,
    expectedTimelineRevision: activeTopic?.timelineRevision ?? null,
    running: composerRunning,
    queue: conversationTurnQueue,
    flushDraft: composer.flushDraft,
    captureDraftMutationToken: composer.captureDraftMutationToken,
    clearAcceptedCommand: composer.clearAcceptedReviewCommand,
    navigateConversation: chooseConversation,
    onError: setError,
  });
  const composerText = composer.composerText;
  const setComposerText = composer.setComposerText;
  const skillItems = composer.skillItems;
  const selectedComposerSkillIds = composer.activeSkillIds;
  const enabledSkillCount = composer.enabledSkillCount;
  const composerFileRefs = composer.fileRefs;
  const setComposerFileRefs = composer.setFileRefs;
  const composerAttachments = composer.attachments;
  const activeTimelineScope = useMemo<CanonicalTimelineScope | null>(() => (
    selectedProjectId && activeTopic?.id && !isPendingTopic && activeConversationSnapshotReady
      ? { projectId: selectedProjectId, productMode: activeTopic.productMode, conversationId: activeTopic.id, agentSurfaceId: "main-agent" }
      : null
  ), [activeConversationSnapshotReady, activeTopic?.id, activeTopic?.productMode, isPendingTopic, selectedProjectId]);
  const activeTranscriptScope = useMemo<CanonicalTimelineScope | null>(() => (
    selectedProjectId && activeTopic?.id
      ? { projectId: selectedProjectId, productMode: activeTopic.productMode, conversationId: activeTopic.id, agentSurfaceId: "main-agent" }
      : null
  ), [activeTopic?.id, activeTopic?.productMode, selectedProjectId]);
  const activeTranscript = useMemo<ParentAgentTranscript>(() => activeTranscriptScope
    ? selectCanonicalTimelineTranscript(timeline.state, activeTranscriptScope)
    : {
      conversationId: activeTopic?.id,
      title: activeTopic?.title ?? "需求对话",
      cells: [],
      items: [],
      emptyMessage: activePendingConversation ? "正在等待主 Agent 回复。" : "暂无对话内容。",
    }, [activePendingConversation, activeTopic?.id, activeTopic?.title, activeTranscriptScope, timeline.state]);
  const activeTimelineSurface = activeTimelineScope
    ? selectCanonicalTimelineSurface(timeline.state, activeTimelineScope)
    : null;
  const loadingEarlierTranscript = activeTimelineSurface?.requests.before.status === "loading";
  const mainViewport = useMainConversationViewport({
    scopeKey: activeTimelineScope ? canonicalTimelineScopeKey(activeTimelineScope) : null,
    mutation: activeTimelineSurface?.lastMutation ?? null,
    hasMoreBefore: Boolean(activeTranscript.paging?.hasMoreBefore),
    loadingEarlier: loadingEarlierTranscript,
    loadEarlier: loadEarlierTranscriptPage,
    visible: !settingsOpen && !orchestrationOpen,
  });
  const resourceRestore = useRef<{ location: ReturnType<typeof appNavigation.getLocation>; isCurrent: () => boolean } | null>(null);
  appNavigation.ports.current = {
    captureLeaving: () => {
      mainViewport.captureReadingPosition();
      void composer.flushDraft().catch((cause: unknown) => setError(userFacingErrorMessage(cause, "conversation")));
      navigationOverlay.close();
      setMobileSidebarOpen(false);
    },
    restore: async (location, isCurrent) => {
      appMode.selectMode(location.productMode);
      setSettingsOpen(location.surface === "settings");
      setSettingsSection(location.settingsSection);
      resourceRestore.current = { location, isCurrent };
      const resolved = await session.restoreSelection(location);
      if (!isCurrent()) return;
      if (resolved.projectId !== location.projectId || resolved.conversationId !== location.conversationId) {
        appNavigation.replace({ ...resolved, resource: null, surface: location.surface === "settings" ? "settings" : "workspace" });
        resourceRestore.current = null;
      }
      setSettingsOpen(location.surface === "settings");
      setSettingsSection(location.settingsSection);
      setOrchestrationOpen(location.surface === "orchestration" && Boolean(resolved.conversationId));
    },
    onError: (cause) => setError(userFacingErrorMessage(cause, "load")),
  };
  useEffect(() => {
    let active = true;
    void session.loadApp({ restoreSelection: false }).then(() => { if (active) return appNavigation.initialize(); })
      .catch((cause: unknown) => { if (active) setError(userFacingErrorMessage(cause, "load")); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const pending = resourceRestore.current;
    if (!pending || !pending.isCurrent()) return;
    const { location } = pending;
    if (session.selectedProjectId !== location.projectId || session.selectedTopic !== location.conversationId
      || session.productMode !== location.productMode || appMode.productMode !== location.productMode) return;
    if (location.conversationId && !location.conversationId.startsWith("pending:")
      && !snapshotMatchesSelection(session.snapshot, location.projectId, location.productMode, location.conversationId)) return;
    resourceRestore.current = null;
    if (location.resource && location.surface !== "settings") {
      workspaceResources.openResource(location.resource);
      setRightToolRailState({ mode: "tool", tool: "agent" });
    } else if (location.surface !== "settings") {
      setRightToolRailState((current) => current.mode === "tool" && current.tool === "agent" ? { mode: "closed" } : current);
    }
  }, [session.selectedProjectId, session.selectedTopic, session.productMode, session.snapshot,
    appMode.productMode, settingsOpen, appNavigation.location, workspaceResources.openResource]);
  const activeDecisionInspector = activeModeSnapshot.right.decisionInspector ?? { primary: null, related: [], history: [] };
  const activeConfirmationQueue = activeModeSnapshot.right.confirmationQueue ?? { primary: null, current: [], otherDemands: [], maintenance: [], history: [] };
  const agentSurfaces = useAgentSurfaceController({
    projectId: selectedProjectId,
    productMode: appMode.productMode,
    conversationId: readyConversationId,
    officeViewOpen: orchestrationOpen,
    ports: {
      cleanupResources: workspaceResources.cleanupTransition,
      openAgentSurface: ({ conversationId, agentSurfaceId }) => {
        openWorkspaceResource({ kind: "agent", conversationId, agentSurfaceId });
        if (selectedProjectId) void timeline.loadLatest({ projectId: selectedProjectId, productMode: appMode.productMode, conversationId, agentSurfaceId });
        if (globalThis.matchMedia?.("(max-width: 720px)").matches) closeOrchestrationOverlay();
      },
      closeOfficeView: closeOrchestrationOverlay,
    },
  });
  const activeAgentSurfaces = agentSurfaces.surfaces.filter((surface) => surface.kind !== "main-agent");
  const activeAgentTranscripts = useMemo<Record<string, ParentAgentTranscript>>(() => {
    if (!selectedProjectId || !activeTopic?.id) return {};
    return Object.fromEntries(activeAgentSurfaces.map((agent) => [
      agent.agentSurfaceId,
      selectCanonicalTimelineTranscript(timeline.state, {
        projectId: selectedProjectId,
        productMode: activeTopic.productMode,
        conversationId: activeTopic.id,
        agentSurfaceId: agent.agentSurfaceId,
      }),
    ]));
  }, [activeAgentSurfaces, activeTopic?.id, activeTopic?.productMode, selectedProjectId, timeline.state]);
  const projectionStream = useWorkbenchProjectionStream(selectedProjectId, {
    timeline: {
      patch: (projectId, envelope) => {
        timeline.ingestEnvelope(projectId, envelope);
      },
    },
    topic: {
      created: (projectId, data) => {
        const topicId = data.topic.conversationId ?? data.topic.id ?? data.topic.changeId;
        if (!topicId) return;
        const accepted = session.acceptCanonicalConversation({
          projectId,
          productMode: data.productMode,
          clientRequestId: data.clientRequestId,
          conversationId: topicId,
          title: data.topic.title,
          selectedProviderId: data.topic.selectedProviderId,
        });
        if (accepted) {
          selectedConversationIdRef.current = topicId;
          void refresh(projectId, topicId);
        }
      },
      updated: (projectId, data) => {
        session.reconcileConversationTitle(projectId, data.conversation);
      },
    },
    interaction: {
      updated: (projectId, queue) => {
        if (selectedProjectIdRef.current !== projectId
          || !activeTopic?.id
          || queue.productMode !== activeTopic.productMode
          || queue.conversationId !== activeTopic.id) return;
        session.updateSnapshot((current) => ({
          ...current,
          center: { ...current.center, conversationInteractions: queue },
        }));
      },
    },
    snapshot: {
      received: (projectId, next) => {
        if (selectedProjectIdRef.current !== projectId) return;
        session.acceptSnapshot(projectId, next);
      },
    },
    agentSurfaces: {
      invalidate: ({ projectId, conversationId, graphScopeId, reason }) => {
        if (selectedProjectIdRef.current === projectId) {
          agentSurfaces.invalidate({ conversationId, graphScopeId, reason });
        }
      },
    },
    turnControl: {
      invalidate: (projectId, data) => {
        if (selectedProjectIdRef.current !== projectId || selectedConversationIdRef.current !== data.conversationId) return;
        void refresh(projectId, data.conversationId);
      },
    },
    conversationContext: {
      invalidate: (projectId, data) => {
        if (selectedProjectIdRef.current !== projectId || selectedConversationIdRef.current !== data.conversationId) return;
        void refresh(projectId, data.conversationId);
      },
    },
    conversationReview: {
      invalidate: (projectId, data) => {
        if (selectedProjectIdRef.current !== projectId || selectedConversationIdRef.current !== data.conversationId) return;
        void refresh(projectId, data.conversationId);
        void timeline.loadLatest({
          projectId,
          productMode: appMode.productMode,
          conversationId: data.conversationId,
          agentSurfaceId: "main-agent",
        });
      },
    },
    modeActivity: {
      invalidate: modeActivity.invalidate,
    },
    error: {
      received: (projectId, data) => {
        if (selectedProjectIdRef.current !== projectId || isTransientReconnectMessage(data.message)) return;
        setError(userFacingErrorMessage(new Error(data.message), "load"));
      },
    },
  }, {
    onConnected: (projectId) => {
      if (selectedProjectIdRef.current !== projectId) return;
      void providerConfiguration.reload().catch(() => undefined);
      void modeActivity.refresh(projectId);
      const conversationId = readyConversationId;
      if (!conversationId) return;
      void refresh(projectId, conversationId);
      agentSurfaces.invalidate({ conversationId, reason: "snapshot" });
      for (const scope of canonicalTimelineReconnectScopes(projectId, appMode.productMode, conversationId, workspaceResourceTabs)) {
        void timeline.loadLatest(scope);
      }
    },
  });
  projectionEventRouterRef.current = projectionStream.routeEventForProject;
  const conversationActions = useConversationActionController({
    session: {
      projectId: selectedProjectId,
      conversationId: readyConversationId,
      selectedTopicId: selectedTopicForMode,
      snapshot: activeModeSnapshot,
      composerText,
    },
    ports: {
      operationGate,
      routeProjectionEvent: projectionStream.routeEventForProject,
      refreshSession: (projectId, conversationId) => refresh(projectId, conversationId),
      calibrateTimeline: timeline.loadLatest,
      applySnapshot: (next) => {
        if (selectedProjectId) session.acceptSnapshot(selectedProjectId, next);
      },
      cacheProjectSnapshot: session.cacheProjectSnapshot,
      setComposerText,
      setError,
      chooseRun,
      openOrchestration: () => {
        void appNavigation.visit({ surface: "orchestration", resource: null });
      },
      navigateConversation: async (conversationId) => {
        if (!selectedProjectId) return;
        await chooseConversation(selectedProjectId, conversationId);
      },
    },
  });
  const decisionSnapshotReady = !selectedProjectId || snapshotMatchesSelection(activeModeSnapshot, selectedProjectId, appMode.productMode, selectedTopicForMode);
  const decisionInspector = useDecisionInspectorController({
    projectId: selectedProjectId,
    productMode: appMode.productMode,
    conversationId: selectedTopicForMode,
    inspector: decisionSnapshotReady ? activeDecisionInspector : { primary: null, related: [], history: [] },
    queue: decisionSnapshotReady ? activeConfirmationQueue : { primary: null, current: [], otherDemands: [], maintenance: [], history: [] },
    busy: actionRunning !== null,
    loading: !decisionSnapshotReady && !session.snapshotError,
    loadFailure: session.snapshotError,
    decisions: decisionSnapshotReady ? activeModeSnapshot.right.decisions : [],
    actions: {
      executeDecisionAction: conversationActions.executeDecisionAction,
      requestDecisionFeedback: conversationActions.requestDecisionFeedback,
      refresh: () => refresh(),
      openConversation: chooseConversation,
    },
  });
  const activeConversationInteraction = activeModeSnapshot.center.conversationInteractions?.items[0] ?? null;
  useEffect(() => {
    if (mobileSidebarModalOpen) {
      mobileSidebarWasOpenRef.current = true;
      mobileSidebarRef.current?.focus();
      return;
    }
    if (!mobileSidebarWasOpenRef.current) return;
    mobileSidebarWasOpenRef.current = false;
    if (!settingsOpen && mobileSidebarViewport) mobileSidebarToggleRef.current?.focus();
  }, [mobileSidebarModalOpen, mobileSidebarViewport, settingsOpen]);
  useEffect(() => {
    if (mobileSidebarViewport || !mobileSidebarOpen) return;
    setMobileSidebarOpen(false);
  }, [mobileSidebarOpen, mobileSidebarViewport]);
  useEffect(() => {
    if (!mobileSidebarModalOpen) return;
    const closeMobileSidebarOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.isComposing) return;
      if (navigationOverlayKindRef.current !== "closed" || sidebarLocalDialogOpenRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMobileSidebarOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const sidebar = mobileSidebarRef.current;
      if (!sidebar) return;
      const focusable = [...sidebar.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)]
        .filter((element) => element.tabIndex >= 0 && !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        sidebar.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !sidebar.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || activeElement === sidebar || !sidebar.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeMobileSidebarOnEscape, true);
    return () => window.removeEventListener("keydown", closeMobileSidebarOnEscape, true);
  }, [mobileSidebarModalOpen]);
  useEffect(() => {
    if (appMode.productMode !== "agent"
      || !agentRunControl?.canStop
      || agentRunControl.state === "stopping"
      || !agentRunControl.attemptId
      || !agentRunControl.providerId
      || actionRunning
      || activeConversationInteraction) return;
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      if (isEditableElement(document.activeElement)) return;
      event.preventDefault();
      void stopAndContinueCurrentRun();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    actionRunning,
    activeConversationInteraction,
    agentRunControl?.attemptId,
    agentRunControl?.canStop,
    agentRunControl?.providerId,
    agentRunControl?.state,
    appMode.productMode,
  ]);
  const workspaceChrome = projectConversationWorkspaceChrome({
    governanceVisible: presentation.harness["governance-approvals"],
    primaryConfirmationPresent: Boolean(activeConfirmationQueue.primary),
    otherConfirmationCount: activeConfirmationQueue.otherDemands.length,
    maintenanceConfirmationCount: activeConfirmationQueue.maintenance.length,
    providerDiagnosticName: providerDiagnostics?.displayName,
    selectedProviderId: composerProviderId,
    providerOptions: composerProviderOptions,
  });
  const visiblePendingConfirmationCount = workspaceChrome.pendingConfirmationCount;
  const officeSurfaceProjection = agentSurfaces.projection;
  const providerModelLabel = composer.modelLabel;
  const providerDisplayName = workspaceChrome.providerDisplayName;

  function appendComposerFileRefs(refs: TopicFileReference[]): void {
    composer.setFileRefs([...composerFileRefs, ...refs]);
  }

  function toggleRightToolRail(): void {
    setRightToolRailState((current) => current.mode === "closed" ? { mode: "launcher" } : { mode: "closed" });
  }

  function openRightToolPanel(tab: RightToolRailTab): void {
    if (tab === "confirm" && !presentation.harness["governance-approvals"]) return;
    setRightToolRailState({ mode: "tool", tool: tab });
    if (tab === "agent") {
      if (!selectedWorkspaceResourceId && workspaceResourceTabs.length === 0) {
        const agentId = activeAgentSurfaces.find((agent) => agent.status === "running")?.agentSurfaceId
          ?? activeAgentSurfaces[0]?.agentSurfaceId;
        if (agentId) openChildAgentWorkspace(agentId);
      }
    }
    if (tab === "diagnostics") {
      void loadRuntimeDiagnostics();
      void loadRuntimeActivityLog();
    }
  }

  function closeOrchestrationOverlay(): void {
    void appNavigation.visit({ surface: "workspace" });
  }

  function routeProjectionEventForProject(projectId: string, event: WorkbenchLiveEvent): void {
    projectionEventRouterRef.current(projectId, event);
    conversationTurnQueue.handleEvent(projectId, event);
    if (event.event === "topic.created") session.invalidateNavigation(projectId, event.data.productMode);
    if (event.event === "topic.updated") session.invalidateNavigation(projectId, event.data.conversation.productMode);
    if (event.event === "conversation.lifecycle.invalidated") {
      session.invalidateNavigation(projectId, event.data.productMode);
      session.acceptLifecycleInvalidation({ projectId, ...event.data });
      invalidateManagement(projectId, event.data.productMode);
    }
    if (event.event === "conversation.lifecycle.sync-updated") invalidateManagement(projectId, event.data.productMode);
  }

  function toggleOrchestrationOverlay(): void {
    if (!activeTopic?.id) return;
    if (orchestrationOpen) closeOrchestrationOverlay();
    else {
      void appNavigation.visit({ surface: "orchestration", resource: null });
    }
  }

  useEffect(() => {
    setRuntimeActivityLog(null);
  }, [activeTopic?.id, isPendingTopic]);


  async function loadEarlierTranscriptPage(): Promise<void> {
    if (!activeTimelineScope || loadingEarlierTranscript) return;
    const cursor = activeTranscript.paging?.nextBeforeCursor;
    if (!cursor || activeTranscript.paging?.hasMoreBefore === false) return;
    await timeline.loadEarlier(activeTimelineScope, cursor);
  }

  useEffect(() => {
    if (!activeTimelineScope) return;
    void timeline.loadLatest(activeTimelineScope);
  }, [activeTimelineScope, projectionVersion, timeline.loadLatest]);

  const agentModeActivityState = modeActivity.snapshot?.agent.state;
  const harnessModeActivityState = modeActivity.snapshot?.harness.state;
  const modeToggle = productModeToggleViewModel(appMode.productMode, {
    agent: agentModeActivityState,
    harness: harnessModeActivityState,
  });
  const projectNavigation = projectNavigationSurface({
    projects,
    selectedProjectId,
    selectedTopicId: activeTopic?.id ?? selectedTopicForMode,
    snapshots: snapshotMatchesCurrentMode ? projectSnapshots : {},
    navigation: session.projectNavigation,
    navigationErrors: session.projectNavigationErrors,
    snapshot: activeModeSnapshot,
    expandedProjects,
    overlay: navigationOverlay.state,
    archivingKeys: session.archivingKeys,
  }, {
    onCloseOverlay: navigationOverlay.close,
    onOpenSearch: navigationOverlay.openSearch,
    onSetSearchQuery: navigationOverlay.setSearchQuery,
    onSetSearchActiveIndex: navigationOverlay.setSearchActiveIndex,
    onPrepareSearch: session.prepareProjectNavigationSearch,
    onOpenProjectCreateActions: navigationOverlay.openProjectCreateActions,
    onOpenProjectActions: navigationOverlay.openProjectActions,
    onOpenConversationActions: navigationOverlay.openConversationActions,
    onOpenProjectForm: navigationOverlay.openProjectForm,
    onOpenRenameConversation: navigationOverlay.openRenameConversation,
    onNewConversation: beginNewConversation,
    onOpenProject: openProject,
    onToggleProject: toggleProjectFolder,
    onRetryNavigation: session.retryNavigation,
    onChooseConversation: chooseConversation,
    onArchiveConversation: archiveConversation,
    onRestoreConversation: restoreConversation,
    onPrepareConversationDelete: session.prepareConversationDelete,
    onDeleteConversation: deleteConversation,
    onRenameConversation: session.updateConversationTitle,
    onRemoveProject: removeProject,
    onRefresh: loadApp,
    onOpenSettings: () => openSettings("basic"),
    onOpenProjectSettings: (projectId: string) => {
      void (async () => {
        if (projectId !== selectedProjectId) await openProject(projectId);
        openSettings("project");
      })();
    },
  });
  const readinessComposer = selectedProjectStatus?.project
    ? projectReadinessComposerSurface({
        project: selectedProjectStatus,
        providerDisplayName,
        modelLabel: providerModelLabel,
        projects,
        selectedProjectId,
        draft: composerText,
        draftFileRefs: composerFileRefs,
        draftAttachments: composerAttachments,
        selectedProviderId: composerProviderId ?? undefined,
        productMode: appMode.productMode,
        accessView: composer.accessView,
        agentTurnMode: composer.agentTurnMode,
        agentTurnModeDisabledReason: composer.agentTurnModeDisabledReason,
        planModeDisabledReason: composer.planModeDisabledReason,
        agentModelId: composer.agentModelId,
        agentReasoningEffort: composer.agentReasoningEffort,
        submissionBusy: composer.submissionBusy,
        providerModelCatalogs,
        providerModelCatalogsBusy: providerConfiguration.modelCatalogsBusy,
        enabledSkillCount,
        skills: skillItems,
        activeSkillIds: selectedComposerSkillIds,
        resetToken: homeComposerResetToken,
        reviewOpen: conversationReview.open,
        reviewOptions: conversationReview.options,
        reviewLoading: conversationReview.loading,
        reviewSubmitting: conversationReview.submitting,
      }, {
        onCreateDemand: createTopicFromText,
        onDraftChange: setComposerText,
        onDraftFileRefsChange: setComposerFileRefs,
        onAttachFiles: appendComposerAttachments,
        onRemoveAttachment: removeComposerAttachment,
        onSelectAccess: composer.selectAccess,
        onRefreshAccess: composer.refreshAccess,
        onSelectAgentTurnMode: composer.selectAgentTurnMode,
        onSelectAgentProviderModel: composer.selectAgentProviderModel,
        onSelectAgentReasoningEffort: composer.selectAgentReasoningEffort,
        onRefreshProviderModels: providerConfiguration.reload,
        onToggleSkill: toggleComposerSkill,
        onOpenProject: openProject,
        onRefresh: loadApp,
        onOpenReview: conversationReview.openSelector,
        onCloseReview: conversationReview.closeSelector,
        onStartReview: conversationReview.startSelected,
        onStartReviewCommand: conversationReview.start,
        onReviewCommandError: setError,
      })
    : null;
  const activeComposer = activeTopic
    ? topicComposerSurface({
        value: composerText,
        providerDisplayName,
        modelLabel: providerModelLabel,
        enabledSkillCount,
        projectId: selectedProjectId,
        conversationId: activeTopic.id,
        skills: skillItems,
        activeSkillIds: selectedComposerSkillIds,
        selectedFileRefs: composerFileRefs,
        attachments: composerAttachments,
        disabledReason: activeTopic.state !== "active"
          ? "已完成或稍后处理的需求对话为只读。"
          : !activeConversationSnapshotReady
            ? "正在确认会话"
            : undefined,
        productMode: appMode.productMode,
        accessView: composer.accessView,
        agentTurnMode: composer.agentTurnMode,
        agentTurnModeDisabledReason: composer.agentTurnModeDisabledReason,
        planModeDisabledReason: composer.planModeDisabledReason,
        agentModelId: composer.agentModelId,
        agentReasoningEffort: composer.agentReasoningEffort,
        providerModelCatalogs,
        providerModelCatalogsBusy: providerConfiguration.modelCatalogsBusy,
        actionRunning,
        currentWorkpadStatus: composerRunning ? "running" : currentWorkpadSummary(activeModeSnapshot, activeTopic)?.runtimeStatus,
        runControlState: activeWorkpad.runControlState,
        selectedProviderId: composerProviderId ?? activeTopic.selectedProviderId,
        conversationContext: conversationContext.snapshot,
        contextSubmitting: conversationContext.submitting,
        turnQueue: conversationTurnQueue.snapshot,
        queueAvailable: Boolean(conversationTurnQueue.snapshot),
        queueBusy: conversationTurnQueue.loading || conversationTurnQueue.mutating,
        reviewOpen: conversationReview.open,
        reviewOptions: conversationReview.options,
        reviewLoading: conversationReview.loading,
        reviewSubmitting: conversationReview.submitting,
      }, {
        onChange: setComposerText,
        onAttachFiles: (files) => { void appendComposerAttachments(files); },
        onRemoveAttachment: removeComposerAttachment,
        onToggleSkill: toggleComposerSkill,
        onSelectedFileRefsChange: setComposerFileRefs,
        onSelectAccess: composer.selectAccess,
        onRefreshAccess: composer.refreshAccess,
        onSelectAgentTurnMode: composer.selectAgentTurnMode,
        onSelectAgentProviderModel: composer.selectAgentProviderModel,
        onSelectAgentReasoningEffort: composer.selectAgentReasoningEffort,
        onRefreshProviderModels: providerConfiguration.reload,
        onSend: sendTopicMessage,
        onStopAndContinue: stopAndContinueCurrentRun,
        onCompactContext: conversationContext.compact,
        onGuideQueuedTurn: async (queueItemId) => { await conversationTurnQueue.guide(queueItemId); },
        onReclaimQueuedTurn: composer.reclaimQueuedTurn,
        onRemoveQueuedTurn: (queueItemId) => { void conversationTurnQueue.remove(queueItemId); },
        onRetryQueuedTurn: (queueItemId) => { void conversationTurnQueue.retry(queueItemId); },
        onConfirmQueuedTurnExecution: (queueItemId) => { void conversationTurnQueue.confirmExecutionContract(queueItemId); },
        onOpenReview: conversationReview.openSelector,
        onCloseReview: conversationReview.closeSelector,
        onStartReview: conversationReview.startSelected,
        onStartReviewCommand: conversationReview.start,
        onReviewCommandError: setError,
      })
    : null;

  return (
    <div
      className={`app-shell ${settingsOpen ? "settings-open" : rightToolRailState.mode === "closed" ? "right-rail-closed" : "right-rail-open"} sidebar-expanded${orchestrationOpen ? " orchestration-open" : ""}${mobileSidebarModalOpen ? " mobile-sidebar-open" : ""}`}
      style={appShellStyle}
    >
      <DesktopTitleBar onError={setError} navigation={appNavigation} />
      {!settingsOpen ? (
        <WorkspaceNavigationHeader
          mode={modeToggle}
          onToggleMode={() => {
            setMobileSidebarOpen(false);
            void appNavigation.visit({ productMode: modeToggle.targetMode, conversationId: null, resource: null });
          }}
          navigation={projectNavigation}
          mobileSidebarOpen={mobileSidebarModalOpen}
          onToggleMobileSidebar={() => {
            if (mobileSidebarOpen) navigationOverlay.close();
            setMobileSidebarOpen((open) => !open);
          }}
          mobileSidebarToggleRef={mobileSidebarToggleRef}
        />
      ) : null}
      {!settingsOpen && mobileSidebarModalOpen ? (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label="关闭会话栏"
          onClick={() => {
            navigationOverlay.close();
            setMobileSidebarOpen(false);
          }}
        />
      ) : null}
      {!settingsOpen ? (
        <aside
          ref={mobileSidebarRef}
          id="project-conversation-sidebar"
          className="sidebar sidebar-expanded"
          aria-label="左侧项目栏"
          role={mobileSidebarModalOpen ? "dialog" : undefined}
          aria-modal={mobileSidebarModalOpen || undefined}
          tabIndex={mobileSidebarModalOpen ? -1 : undefined}
        >
          <div className="workspace-navigation-header-spacer" aria-hidden="true" />
              <ProjectConversationSidebarFeature surface={projectNavigation} onLocalDialogOpenChange={setSidebarLocalDialogOpen} />
          <div
            className="shell-resize-grip sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整左侧项目栏宽度"
            tabIndex={mobileSidebarModalOpen ? -1 : 0}
            aria-valuemin={LEFT_SIDEBAR_MIN_WIDTH}
            aria-valuemax={LEFT_SIDEBAR_MAX_WIDTH}
            aria-valuenow={leftSidebarWidth}
            aria-valuetext={`${leftSidebarWidth} 像素`}
            onPointerDown={(event) => beginShellColumnResize(event, "left")}
            onKeyDown={(event) => resizeShellColumnWithKeyboard(event, "left")}
          />
        </aside>
      ) : null}

      <main
        className={`workspace${settingsOpen ? " settings-workspace" : ""}`}
        inert={mobileSidebarModalOpen ? true : undefined}
      >
        <div className="workspace-main" data-testid="workspace-main">
        {error ? <div className="application-operation-notice" role="alert"><span>{sanitizeTechnicalDetail(error)}</span><button className="outline-button" aria-label="关闭操作提示" onClick={() => setError(null)}>关闭</button></div> : null}
        {providerConfiguration.failureNotice ? <div className="application-operation-notice" data-testid="provider-configuration-notice" role="alert"><span>{sanitizeTechnicalDetail(providerConfiguration.failureNotice.message)}</span><button className="outline-button" aria-label="关闭服务提示" onClick={providerConfiguration.dismissFailureNotice}>关闭</button></div> : null}
        {settingsOpen ? (
          <SettingsSurface
            section={settingsSection}
            onSectionChange={changeSettingsSection}
            project={selectedProjectStatus}
            projects={projects}
            productMode={appMode.productMode}
            conversationId={activeTopic?.id ?? null}
            selectedProviderId={activeTopic?.selectedProviderId ?? composerProviderId}
            diagnostics={providerDiagnostics}
            modelSettings={providerModelSettings}
            providerCapabilities={providerCapabilities}
            modelSettingsBusy={providerConfiguration.modelCatalogsBusy}
            managementRefreshVersions={managementRefreshVersions}
            onManagementChanged={(item, action) => {
              session.invalidateNavigation(item.projectId, item.productMode);
              if (action === "archive" || action === "delete") session.acceptLifecycleInvalidation({
                projectId: item.projectId, productMode: item.productMode,
                conversationId: item.conversationId, state: action === "archive" ? "archived" : "deleted",
              });
              invalidateManagement(item.projectId, item.productMode);
            }}
            onRefresh={() => loadApp().then(() => providerConfiguration.reload()).then(() => loadSkillSummary())}
          />
        ) : !selectedProjectId ? (
          <ProjectHomeView
            projects={projects}
            onOpenProject={openProject}
            onRefresh={loadApp}
          />
        ) : !selectedProjectStatus?.project ? (
          <ProjectHomeView
            projects={projects}
            onOpenProject={openProject}
            onRefresh={loadApp}
          />
        ) : selectedProjectStatus.runtimeAvailability?.state === "unavailable" ? (
          <UnmanagedProjectView
            project={selectedProjectStatus}
            onRetry={loadApp}
            onOpenDiagnostics={() => openRightToolPanel("diagnostics")}
          />
        ) : archivingSelected ? (
          <section className="empty-workbench" role="status"><h1>正在归档会话</h1></section>
        ) : !activeTopic ? (
          readinessComposer ? <ProjectReadinessHomeFeature surface={readinessComposer} /> : null
        ) : (
          <>
            <header className="thread-header">
              <div className="thread-title-block" title={activeTopic.title}>
                <strong>{activeTopic.title}</strong>
                <span>
                  {activeTopicIsConversation
                    ? `${projectDisplayName(activeModeSnapshot.project, "project")} · ${stateLabel(activeTopic.state)}`
                    : `${projectDisplayName(activeModeSnapshot.project, "project")} · ${stateLabel(activeTopic.state)} · 验收 ${activeTopic.acCount ?? 0} · 任务 ${activeTopic.taskCount ?? 0}`}
                </span>
              </div>
              {session.snapshotError && activeTopic.id === selectedTopic ? (
                <div className="conversation-local-error" role="alert">
                  <span>{session.snapshotError}</span>
                  <button type="button" className="outline-button" onClick={() => {
                    if (activePendingConversation?.canonical) {
                      void session.reconcileCreatedConversation(
                        selectedProjectId,
                        activePendingConversation.productMode,
                        activePendingConversation.id,
                        activePendingConversation.clientRequestId,
                      );
                    } else {
                      void session.chooseConversation(selectedProjectId, activeTopic.id);
                    }
                  }}>重试</button>
                </div>
              ) : null}
            </header>
            {activeTopic.forkBoundary ? (
              <div className="conversation-fork-boundary" data-testid="conversation-fork-boundary">
                <span>此会话从第 {activeTopic.forkBoundary.completedTurnSequence} 个已完成回合分叉，{activeTopic.forkBoundary.sourceDeleted ? "源会话已删除。" : "源会话保持不变。"}</span>
                {!activeTopic.forkBoundary.sourceDeleted ? (
                  <button type="button" className="outline-button" onClick={() => selectedProjectId && void chooseConversation(selectedProjectId, activeTopic.forkBoundary!.sourceConversationId)}>查看源会话</button>
                ) : null}
              </div>
            ) : null}

            <section className={`center-grid${orchestrationOpen ? " agent-office-center-grid" : ""}`}>
              {orchestrationOpen ? (
                <div className="agent-office-center-view" data-testid="agent-office-center-view">
                  {(agentSurfaces.loadState === "idle" || agentSurfaces.loadState === "loading") && !officeSurfaceProjection ? (
                    <OfficeLoadingScreen progress={agentSurfaces.loadState === "loading" ? 18 : 8} />
                  ) : agentSurfaces.loadState === "error" || !officeSurfaceProjection || !selectedProjectId ? (
                    <div className="agent-office-view-state error" role="alert">
                      <strong>Agent 办公室加载失败</strong>
                      <span>{agentSurfaces.loadError ?? "请稍后重试。"}</span>
                      <button type="button" className="outline-button" onClick={agentSurfaces.reload}>重试</button>
                    </div>
                  ) : (
                    <AgentOfficePanel
                      projectId={selectedProjectId}
                      projection={officeSurfaceProjection}
                      onOpenSurface={(agentSurfaceId) => agentSurfaces.openExactSurface(agentSurfaceId, officeSurfaceProjection.graphScopeId)}
                    />
                  )}
                </div>
              ) : (
              <div className="timeline-panel">
                <div
                  className="thread-scroll"
                  ref={mainViewport.scrollContainerRef}
                  onScroll={mainViewport.onUserScroll}
                >
                  <MainConversationView
                    key={`timeline:${selectedProjectId ?? ""}:${activeTopic.id}:main-agent`}
                    transcript={activeTranscript}
                    scrollContainerRef={mainViewport.scrollContainerRef}
                    loadingEarlierTranscript={loadingEarlierTranscript}
                    onOpenAgent={openChildAgentWorkspace}
                    canOpenAgent={(agentSurfaceId) => agentSurfaces.surfaces.some((surface) => surface.kind === "agent" && surface.agentSurfaceId === agentSurfaceId)}
                    onOpenDocument={(document: CanonicalDocumentReference) => {
                      if (!activeTopic?.id) return;
                      openWorkspaceResource({ kind: "document", conversationId: activeTopic.id, documentId: document.documentId });
                    }}
                    onOpenProjectFile={(relativePath) => openWorkspaceResource({ kind: "project-file", relativePath })}
                    documentResources={workspaceDocuments}
                    onEnsureDocument={(document: CanonicalDocumentReference) => {
                      if (!activeTopic?.id) return;
                      void workspaceResources.ensureLoaded({
                        kind: "document",
                        conversationId: activeTopic.id,
                        documentId: document.documentId,
                      });
                    }}
                    onRetry={activeWorkpad.conversationLifecycle === "running" ? undefined : async (target) => {
                      if (!selectedProjectId || !activeTopic?.id || appMode.productMode !== "agent") return;
                      await conversationActions.retryAgentTurn({
                        projectId: selectedProjectId,
                        conversationId: activeTopic.id,
                        providerId: target.providerId,
                        expectedAttemptId: target.failedAttemptId,
                        sourceMessageId: target.rootSourceMessageId,
                        clientRequestId: `retry-${globalThis.crypto?.randomUUID?.()
                          ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
                      });
                    }}
                    onRetryPending={composer.retryPendingIntent}
                    onRestorePending={composer.restorePendingIntent}
                    onFork={appMode.productMode !== "agent"
                      || activeWorkpad.conversationLifecycle === "running"
                      || !activeModeSnapshot.center.conversationContext?.contextRevision
                      || activeTopic.timelineRevision === undefined
                      ? undefined
                      : async (target) => {
                          if (!selectedProjectId || !activeTopic?.id) return;
                          await conversationActions.forkAgentConversation({
                            projectId: selectedProjectId,
                            conversationId: activeTopic.id,
                            providerId: target.providerId,
                            sourceMessageId: target.sourceMessageId,
                            expectedCompletedTurnSequence: target.completedTurnSequence,
                            expectedTimelineRevision: activeTopic.timelineRevision!,
                            contextRevision: activeModeSnapshot.center.conversationContext!.contextRevision,
                            clientRequestId: `fork-${globalThis.crypto?.randomUUID?.()
                              ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
                          });
                        }}
                  />
                </div>
                {mainViewport.showLatest ? <button className="latest-button" onClick={mainViewport.scrollToLatest}>最新</button> : null}
              </div>
              )}
              {activeConversationInteraction && !orchestrationOpen ? (
                <ConversationInteractionDock
                  interaction={activeConversationInteraction}
                  busy={Boolean(actionRunning?.startsWith("interaction."))}
                  canStop={appMode.productMode === "agent" ? Boolean(agentRunControl?.canStop) : activeWorkpad.conversationLifecycle === "running" || Boolean(activeWorkpad.runControlState?.canStop)}
                  initialDraft={conversationActions.getInteractionDraft(activeConversationInteraction.interactionId)}
                  onDraftChange={conversationActions.setInteractionDraft}
                  onSettle={settleConversationInteraction}
                  onStop={stopAndContinueCurrentRun}
                />
              ) : !orchestrationOpen && activeComposer
                ? <TopicComposerFeature surface={activeComposer} />
                : null}
            </section>
          </>
        )}
        </div>
        {!settingsOpen ? <WorkspaceDockToggleBar
          orchestrationActive={orchestrationOpen}
          orchestrationNeedsAttention={agentSurfaces.surfaces.some((surface) => surface.status === "waiting-user")}
          orchestrationDisabled={!activeTopic?.id}
          onToggleOrchestration={toggleOrchestrationOverlay}
          terminalActive={bottomDockKind === "terminal"}
          terminalDisabled={!selectedProjectId}
          onToggleTerminal={toggleTerminalDock}
          rightRailOpen={rightToolRailState.mode !== "closed"}
          rightRailPendingCount={visiblePendingConfirmationCount}
          onToggleRightRail={toggleRightToolRail}
        /> : null}
        {!settingsOpen ? <TerminalDock
          projectId={selectedProjectId}
          open={bottomDockKind === "terminal"}
          height={terminalDockHeight}
          tabs={terminalTabs}
          activeTabId={activeTerminalId}
          onOpen={() => setBottomDockKind("terminal")}
          onCollapse={() => setBottomDockKind(null)}
          onHeightChange={setTerminalDockHeight}
          onNewTab={createTerminalTab}
          onSelectTab={(id) => {
            setActiveTerminalId(id);
            setBottomDockKind("terminal");
          }}
          onCloseTab={closeTerminalTab}
        /> : null}
      </main>

      {!settingsOpen && rightToolRailState.mode !== "closed" ? <RightToolRailShell
        state={rightToolRailState}
        pendingCount={visiblePendingConfirmationCount}
        hasPrimary={presentation.harness["governance-approvals"] && Boolean(activeConfirmationQueue.primary)}
        showGovernance={presentation.harness["governance-approvals"]}
        onCollapse={() => setRightToolRailState({ mode: "closed" })}
        onToolOpen={openRightToolPanel}
        onBackToLauncher={() => setRightToolRailState({ mode: "launcher" })}
        agentPanel={
          <ResourceWorkspacePanel
            agents={activeAgentSurfaces}
            agentTranscripts={activeAgentTranscripts}
            conversationId={activeTopic?.id ?? ""}
            tabs={workspaceResourceTabs}
            selectedResourceId={selectedWorkspaceResourceId}
            documents={workspaceDocuments}
            loadingResourceIds={loadingWorkspaceResourceIds}
            resourceErrors={workspaceResourceErrors}
            onSelectResource={selectWorkspaceResource}
            onCloseResource={closeWorkspaceResource}
            onBack={() => setRightToolRailState({ mode: "launcher" })}
            agentDrafts={workspaceResources.agentDrafts}
            pendingAgentMessages={workspaceResources.pendingAgentMessages}
            onAgentDraftChange={workspaceResources.setAgentDraft}
            onSubmitAgentMessage={workspaceResources.submitAgentMessage}
            onLoadEarlierAgentTranscript={async (agentSurfaceId, cursor) => {
              if (!selectedProjectId || !activeTopic?.id) return;
              await timeline.loadEarlier({
                projectId: selectedProjectId,
                productMode: activeTopic.productMode,
                conversationId: activeTopic.id,
                agentSurfaceId,
              }, cursor);
            }}
            providerDisplayName={providerDisplayName}
            modelLabel={providerModelLabel}
          />
        }
        confirmPanel={
          <DecisionInspectorPane controller={decisionInspector} />
        }
        filesPanel={
          <ProjectFilesPanel
            projectId={selectedProjectId}
            selectedRefs={composerFileRefs}
            onSelectedRefsChange={appendComposerFileRefs}
            onOpenTextDocument={(relativePath) => openWorkspaceResource({ kind: "project-file", relativePath })}
          />
        }
        gitPanel={
          <ProjectGitPanel
            projectId={selectedProjectId}
            selectedPath={selectedGitDiffPath}
            selectedRefs={composerFileRefs}
            onSelectedPathChange={(relativePath) => {
              setSelectedGitDiffPath(relativePath);
            }}
            onSelectedRefsChange={appendComposerFileRefs}
          />
        }
        diagnosticsPanel={
          <RuntimeDiagnosticsRailPanel
            snapshot={runtimeDiagnostics}
            loading={runtimeDiagnosticsLoading}
            onRefresh={() => void loadRuntimeDiagnostics()}
            runtimeLog={runtimeActivityLog}
            runtimeLogLoading={runtimeActivityLogLoading}
            onRefreshRuntimeLog={() => void loadRuntimeActivityLog()}
            workspace={{
              projectPath: snapshot.left.repo?.path ?? selectedProjectStatus?.path ?? "-",
              ready: Boolean(snapshot.harness.harnessReady ?? selectedProjectStatus?.harness.readiness === "ready"),
              currentTitle: activeTopic?.title ?? "无",
              currentKind: activeTopic?.kind === "conversation" ? "当前对话" : "当前需求",
              issueCount: snapshot.warnings.length + (activeTopic?.closeGate?.blockingIssues.length ?? 0),
            }}
            workpad={activeWorkpad}
          />
        }
        resizeMin={RIGHT_RAIL_MIN_WIDTH}
        resizeMax={RIGHT_RAIL_MAX_WIDTH}
        resizeValue={rightToolRailWidth}
        onResizeStart={(event) => beginShellColumnResize(event, "right")}
        onResizeKeyDown={(event) => resizeShellColumnWithKeyboard(event, "right")}
      /> : null}

    </div>
  );
}

function isTransientReconnectMessage(message: string): boolean {
  return /^reconnecting(?:\.\.\.)?\s*\d+\/\d+/i.test(message.trim());
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
