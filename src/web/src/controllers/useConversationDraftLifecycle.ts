import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AgentTurnMode, ComposerDraftDiagnostic, ComposerDraftSnapshot, TopicAttachment, TopicFileReference } from "../types.js";
import {
  ComposerDraftSyncOwner,
  defaultComposerDraftApi,
  type ComposerDraftCheckpoint,
  type ComposerDraftContent,
  type ComposerDraftSettlementGuard,
  type ComposerDraftSettlementOptions,
} from "./ComposerDraftSyncOwner.js";
import { ConversationDraftController, type ConversationDraftViewModel } from "./ConversationDraftController.js";
import {
  composerDraftContent,
  composerErrorMessage,
  composerProductMode,
  draftScopeIdentity,
  effectiveComposerProviderId,
  initialAgentModelId,
  initialAgentReasoningEffort,
  initialAgentTurnMode,
  normalizeComposerRefs,
  normalizeNullableSelection,
  parseDraftScopeIdentity,
  resolveSelectedModelCandidate,
  type ComposerTransition,
  type ConversationComposerScope,
  type ConversationDraftLifecyclePorts,
  type CurrentValueRef,
} from "./conversation-composer-contract.js";

export interface ConversationDraftLifecycle {
  composerText: string;
  draftSkillOverrides: Record<string, boolean>;
  fileRefs: TopicFileReference[];
  attachments: TopicAttachment[];
  agentTurnMode: AgentTurnMode;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  draftDiagnostics: ComposerDraftDiagnostic[];
  draftLoadedScopeKey: string | null;
  stateRef: MutableRefObject<ConversationDraftViewModel>;
  controller: ConversationDraftController;
  syncOwner: ComposerDraftSyncOwner;
  markDirty(): void;
  setComposerText(next: string | ((current: string) => string)): void;
  setFileRefs(next: TopicFileReference[]): void;
  addFileReference(ref: TopicFileReference): void;
  setAttachmentsRaw(next: TopicAttachment[] | ((current: TopicAttachment[]) => TopicAttachment[])): void;
  setSkillOverridesRaw(next: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)): void;
  setDiagnosticsRaw(next: ComposerDraftDiagnostic[] | ((current: ComposerDraftDiagnostic[]) => ComposerDraftDiagnostic[])): void;
  selectAgentTurnMode(nextMode: AgentTurnMode): Promise<void>;
  selectAgentModel(nextModelId: string | null): void;
  selectAgentProviderModel(providerId: string, nextModelId: string | null): Promise<void>;
  selectAgentReasoningEffort(nextEffort: string | null): void;
  selectProvider(providerId: string): Promise<void>;
  cleanupTransition(transition: ComposerTransition): void;
  flushDraft(): Promise<string | null>;
  captureDraftMutationToken(): string | null;
  settleAcceptedDraft(
    accepted: ComposerDraftContent,
    options?: ComposerDraftSettlementOptions,
    checkpoint?: ComposerDraftCheckpoint,
    guard?: ComposerDraftSettlementGuard,
  ): Promise<void>;
  clearAcceptedReviewCommand(
    capturedText: string,
    expectedDraftUpdatedAt: string | null,
    capturedMutationToken?: string | null,
  ): Promise<void>;
  applyRestoredSnapshot(snapshot: ComposerDraftSnapshot): void;
}

export function useConversationDraftLifecycle(
  scope: ConversationComposerScope,
  portsRef: CurrentValueRef<ConversationDraftLifecyclePorts>,
  scopeRef: MutableRefObject<ConversationComposerScope>,
  scopeGenerationRef: MutableRefObject<number>,
): ConversationDraftLifecycle {
  const [composerText, setComposerTextState] = useState("");
  const [draftSkillOverrides, setDraftSkillOverrides] = useState<Record<string, boolean>>({});
  const [fileRefs, setFileRefsState] = useState<TopicFileReference[]>([]);
  const [attachments, setAttachments] = useState<TopicAttachment[]>([]);
  const [agentTurnMode, setAgentTurnMode] = useState<AgentTurnMode>(() => initialAgentTurnMode(scope));
  const [agentModelId, setAgentModelId] = useState<string | null>(() => initialAgentModelId(scope));
  const [agentReasoningEffort, setAgentReasoningEffort] = useState<string | null>(() => initialAgentReasoningEffort(scope));
  const [draftDiagnostics, setDraftDiagnostics] = useState<ComposerDraftDiagnostic[]>([]);
  const [draftLoadedScopeKey, setDraftLoadedScopeKey] = useState<string | null>(null);
  const [draftDirtyRevision, setDraftDirtyRevision] = useState(0);
  const draftRequestGenerationRef = useRef(0);
  const draftMutationGenerationsRef = useRef(new Map<string, number>());
  const turnModeOwnerIdentityRef = useRef<string | null>(null);
  const draftLoadIdentityRef = useRef<string | null>(null);
  const confirmedTurnModesRef = useRef(new Map<string, AgentTurnMode>());
  const draftFingerprintsRef = useRef(new Map<string, string>());
  const draftScheduledRevisionsRef = useRef(new Map<string, number>());
  const draftObservedProvidersRef = useRef(new Map<string, string | null>());
  const draftRestoredModesRef = useRef(new Map<string, AgentTurnMode>());
  const draftRestoredModelSelectionsRef = useRef(new Map<string, { modelId: string | null; reasoningEffort: string | null }>());
  const invalidModelNoticeRef = useRef(new Set<string>());
  const pendingProviderSelectionRef = useRef<string | null>(null);
  const stateRef = useRef<ConversationDraftViewModel>({
    text: composerText,
    contextRefs: fileRefs,
    attachments,
    skillOverrides: draftSkillOverrides,
    agentTurnMode,
    modelId: agentModelId,
    reasoningEffort: agentReasoningEffort,
  });
  stateRef.current = {
    text: composerText,
    contextRefs: fileRefs,
    attachments,
    skillOverrides: draftSkillOverrides,
    agentTurnMode,
    modelId: agentModelId,
    reasoningEffort: agentReasoningEffort,
  };
  const writeText = (update: (current: string) => string): void => {
    const value = update(stateRef.current.text);
    stateRef.current = { ...stateRef.current, text: value };
    setComposerTextState(value);
  };
  const writeContextRefs = (update: (current: TopicFileReference[]) => TopicFileReference[]): void => {
    const value = update(stateRef.current.contextRefs);
    stateRef.current = { ...stateRef.current, contextRefs: value };
    setFileRefsState(value);
  };
  const writeAttachments = (update: (current: TopicAttachment[]) => TopicAttachment[]): void => {
    const value = update(stateRef.current.attachments);
    stateRef.current = { ...stateRef.current, attachments: value };
    setAttachments(value);
  };
  const writeSkillOverrides = (update: (current: Record<string, boolean>) => Record<string, boolean>): void => {
    const value = update(stateRef.current.skillOverrides);
    stateRef.current = { ...stateRef.current, skillOverrides: value };
    setDraftSkillOverrides(value);
  };

  const writeAgentTurnMode = (value: AgentTurnMode): void => {
    stateRef.current = { ...stateRef.current, agentTurnMode: value };
    setAgentTurnMode(value);
  };
  const writeAgentModelId = (value: string | null): void => {
    stateRef.current = { ...stateRef.current, modelId: value };
    setAgentModelId(value);
  };
  const writeAgentReasoningEffort = (value: string | null): void => {
    stateRef.current = { ...stateRef.current, reasoningEffort: value };
    setAgentReasoningEffort(value);
  };
  const syncOwnerRef = useRef<ComposerDraftSyncOwner | null>(null);
  const controllerRef = useRef<ConversationDraftController | null>(null);

  function markDirty(): void {
    const currentScope = scopeRef.current;
    const key = draftScopeIdentity(currentScope.projectId, composerProductMode(currentScope));
    draftMutationGenerationsRef.current.set(key, (draftMutationGenerationsRef.current.get(key) ?? 0) + 1);
    setDraftDirtyRevision((value) => value + 1);
  }

  if (!syncOwnerRef.current) {
    syncOwnerRef.current = new ComposerDraftSyncOwner(
      portsRef.current.drafts ?? defaultComposerDraftApi,
      (message) => portsRef.current.onError(message),
    );
  }
  if (!controllerRef.current) {
    controllerRef.current = new ConversationDraftController({
      read: () => stateRef.current,
      setText: writeText,
      setContextRefs: writeContextRefs,
      setAttachments: writeAttachments,
      setSkillOverrides: writeSkillOverrides,
      setAgentTurnMode: writeAgentTurnMode,
      setModelId: writeAgentModelId,
      setReasoningEffort: writeAgentReasoningEffort,
      markDirty,
    });
  }

  useEffect(() => {
    const productMode = composerProductMode(scope);
    const ownerIdentity = draftScopeIdentity(scope.projectId, productMode);
    const ownerChanged = ownerIdentity !== turnModeOwnerIdentityRef.current;
    const loadIdentity = scope.projectId && scope.projectRegistered ? ownerIdentity : null;
    if (!ownerChanged && loadIdentity === draftLoadIdentityRef.current) return;
    const previousScope = ownerChanged ? turnModeOwnerIdentityRef.current : null;
    if (ownerChanged) turnModeOwnerIdentityRef.current = ownerIdentity;
    draftLoadIdentityRef.current = loadIdentity;
    const generation = ++draftRequestGenerationRef.current;
    const mutationGeneration = draftMutationGenerationsRef.current.get(ownerIdentity) ?? 0;
    const storedConversationMode = scope.conversation && productMode === "agent" ? initialAgentTurnMode(scope) : null;
    if (storedConversationMode) confirmedTurnModesRef.current.set(ownerIdentity, storedConversationMode);
    const restoredMode = draftRestoredModesRef.current.get(ownerIdentity);
    const restoredModelSelection = draftRestoredModelSelectionsRef.current.get(ownerIdentity);
    const immediate = storedConversationMode
      ?? restoredMode
      ?? confirmedTurnModesRef.current.get(ownerIdentity)
      ?? initialAgentTurnMode(scope);
    if (ownerChanged || !loadIdentity) {
      writeAgentTurnMode(immediate);
      writeAgentModelId(restoredModelSelection
        ? restoredModelSelection.modelId
        : storedConversationMode ? scope.conversation?.agentModelId ?? null : null);
      writeAgentReasoningEffort(restoredModelSelection
        ? restoredModelSelection.reasoningEffort
        : storedConversationMode ? scope.conversation?.agentReasoningEffort ?? null : null);
      setDraftLoadedScopeKey(null);
      setDraftDirtyRevision(0);
      setComposerTextState("");
      setFileRefsState([]);
      setAttachments([]);
      setDraftSkillOverrides({});
      setDraftDiagnostics([]);
    }
    if (previousScope) {
      const [previousProjectId, previousProductMode] = parseDraftScopeIdentity(previousScope);
      void syncOwnerRef.current!.flush(previousProjectId, previousProductMode)
        .catch((cause) => portsRef.current.onError(composerErrorMessage(cause)));
    }
    if (!loadIdentity || !scope.projectId) return;
    void syncOwnerRef.current!.load(scope.projectId, productMode)
      .then((draft) => {
        if (generation !== draftRequestGenerationRef.current
          || ownerIdentity !== draftScopeIdentity(scopeRef.current.projectId, composerProductMode(scopeRef.current))) return;
        setDraftLoadedScopeKey(ownerIdentity);
        draftScheduledRevisionsRef.current.set(ownerIdentity, draftDirtyRevision);
        if (!draft) {
          const emptyContent: ComposerDraftContent = {
            projectId: scope.projectId!, productMode,
            agentTurnMode: productMode === "agent" ? immediate : null,
            agentModelId: null, agentReasoningEffort: null, text: "", contextRefs: [], attachmentIds: [], skillOverrides: {},
            selectedProviderId: scope.selectedProviderId,
          };
          draftFingerprintsRef.current.set(ownerIdentity, composerDraftFingerprint(emptyContent));
          draftObservedProvidersRef.current.set(ownerIdentity, emptyContent.selectedProviderId);
          return;
        }
        const restoredContent = contentFromSnapshot(draft);
        draftFingerprintsRef.current.set(ownerIdentity, composerDraftFingerprint(restoredContent));
        draftObservedProvidersRef.current.set(ownerIdentity, restoredContent.selectedProviderId);
        if (mutationGeneration !== (draftMutationGenerationsRef.current.get(ownerIdentity) ?? 0)) return;
        const draftMode = productMode === "agent" ? draft.agentTurnMode ?? immediate : "default";
        draftRestoredModesRef.current.set(ownerIdentity, draftMode);
        confirmedTurnModesRef.current.set(ownerIdentity, draftMode);
        const draftModelSelection = productMode === "agent"
          ? { modelId: draft.agentModelId, reasoningEffort: draft.agentReasoningEffort }
          : { modelId: null, reasoningEffort: null };
        draftRestoredModelSelectionsRef.current.set(ownerIdentity, draftModelSelection);
        const currentConversation = scopeRef.current.conversation;
        writeAgentTurnMode(productMode === "agent" && currentConversation
          ? currentConversation.agentTurnMode ?? "default"
          : draftMode);
        writeAgentModelId(draftModelSelection.modelId);
        writeAgentReasoningEffort(draftModelSelection.reasoningEffort);
        setComposerTextState(draft.text);
        setFileRefsState(normalizeComposerRefs(draft.contextRefs));
        setAttachments(draft.attachments);
        setDraftSkillOverrides(draft.skillOverrides);
        setDraftDiagnostics(draft.diagnostics);
        portsRef.current.session.restoreDraftProvider?.(draft.selectedProviderId);
        if (draft.diagnostics.length > 0) portsRef.current.onError(draft.diagnostics.map((item) => item.message).join(" "));
      })
      .catch((cause: unknown) => {
        if (generation === draftRequestGenerationRef.current
          && ownerIdentity === draftScopeIdentity(scopeRef.current.projectId, composerProductMode(scopeRef.current))) {
          portsRef.current.onError(composerErrorMessage(cause));
        }
      });
  }, [scope.productMode, scope.projectId, scope.projectRegistered]);

  useEffect(() => {
    const productMode = composerProductMode(scope);
    if (productMode !== "agent") return writeAgentTurnMode("default");
    if (scope.conversation) return writeAgentTurnMode(scope.conversation.agentTurnMode ?? "default");
    const restored = draftRestoredModesRef.current.get(draftScopeIdentity(scope.projectId, productMode));
    if (restored) writeAgentTurnMode(restored);
  }, [scope.conversation?.agentTurnMode, scope.conversation?.id, scope.productMode, scope.projectId]);

  useEffect(() => {
    const productMode = composerProductMode(scope);
    if (productMode !== "agent") {
      writeAgentModelId(null);
      writeAgentReasoningEffort(null);
      return;
    }
    const restored = draftRestoredModelSelectionsRef.current.get(draftScopeIdentity(scope.projectId, productMode));
    if (restored) {
      writeAgentModelId(restored.modelId);
      writeAgentReasoningEffort(restored.reasoningEffort);
      return;
    }
    if (scope.conversation) {
      writeAgentModelId(scope.conversation.agentModelId ?? null);
      writeAgentReasoningEffort(scope.conversation.agentReasoningEffort ?? null);
    }
  }, [scope.conversation?.agentModelId, scope.conversation?.agentReasoningEffort, scope.conversation?.id, scope.productMode, scope.projectId]);

  useEffect(() => {
    if (composerProductMode(scope) !== "agent") return;
    const providerId = effectiveComposerProviderId(scope);
    if (pendingProviderSelectionRef.current && pendingProviderSelectionRef.current !== providerId) return;
    if (pendingProviderSelectionRef.current === providerId) pendingProviderSelectionRef.current = null;
    const group = scope.providerModelCatalogs?.find((item) => item.providerId === providerId);
    if (!providerId || group?.status !== "ready" || !group.snapshot) return;
    const currentModelId = stateRef.current.modelId;
    const candidate = resolveSelectedModelCandidate(group.snapshot, currentModelId);
    const invalidModel = Boolean(currentModelId && !candidate);
    const invalidEffort = Boolean(stateRef.current.reasoningEffort
      && (!candidate || !candidate.supportedReasoningEfforts.some((option) => option.value === stateRef.current.reasoningEffort)));
    if (!invalidModel && !invalidEffort) return;
    const key = draftScopeIdentity(scope.projectId, composerProductMode(scope));
    const nextModelId = invalidModel ? null : currentModelId;
    const nextEffort = invalidModel || invalidEffort ? null : stateRef.current.reasoningEffort;
    writeAgentModelId(nextModelId);
    writeAgentReasoningEffort(nextEffort);
    draftRestoredModelSelectionsRef.current.set(key, { modelId: nextModelId, reasoningEffort: nextEffort });
    markDirty();
    const noticeKey = `${key}\0${providerId}\0${currentModelId ?? ""}\0${stateRef.current.reasoningEffort ?? ""}`;
    if (!invalidModelNoticeRef.current.has(noticeKey)) {
      invalidModelNoticeRef.current.add(noticeKey);
      portsRef.current.onError(invalidModel
        ? "之前选择的模型已不可用，已恢复为该服务的默认模型。"
        : "之前选择的思考强度已不受支持，已恢复为模型默认值。");
    }
  }, [scope.productMode, scope.projectId, scope.selectedProviderId, scope.conversation?.selectedProviderId, scope.providerModelCatalogs]);

  useEffect(() => {
    if (!scope.projectId || !scope.projectRegistered || !draftLoadedScopeKey) return;
    const productMode = composerProductMode(scope);
    const key = draftScopeIdentity(scope.projectId, productMode);
    if (key !== draftLoadedScopeKey) return;
    const selectedProviderId = effectiveComposerProviderId(scope);
    const dirtyChanged = draftScheduledRevisionsRef.current.get(key) !== draftDirtyRevision;
    const providerChanged = draftObservedProvidersRef.current.get(key) !== selectedProviderId;
    if (!dirtyChanged && !providerChanged) return;
    const content = composerDraftContent({
      projectId: scope.projectId, productMode, agentTurnMode, agentModelId, agentReasoningEffort,
      text: composerText, contextRefs: fileRefs, attachments, skillOverrides: draftSkillOverrides, selectedProviderId,
    });
    const fingerprint = composerDraftFingerprint(content);
    if (draftFingerprintsRef.current.get(key) === fingerprint) return;
    draftScheduledRevisionsRef.current.set(key, draftDirtyRevision);
    draftObservedProvidersRef.current.set(key, selectedProviderId);
    draftFingerprintsRef.current.set(key, fingerprint);
    syncOwnerRef.current!.schedule(content);
  }, [agentTurnMode, agentModelId, agentReasoningEffort, attachments, composerText, draftDirtyRevision, draftLoadedScopeKey,
    draftSkillOverrides, fileRefs, scope.projectRegistered, scope.productMode, scope.projectId, scope.selectedProviderId,
    scope.conversation?.selectedProviderId]);

  useEffect(() => {
    const flush = (): void => { void syncOwnerRef.current?.flushAll(); };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const selectAgentTurnMode = useCallback(async (nextMode: AgentTurnMode): Promise<void> => {
    const currentScope = scopeRef.current;
    if (composerProductMode(currentScope) !== "agent" || stateRef.current.agentTurnMode === nextMode) return;
    const key = draftScopeIdentity(currentScope.projectId, composerProductMode(currentScope));
    confirmedTurnModesRef.current.set(key, nextMode);
    draftRestoredModesRef.current.set(key, nextMode);
    writeAgentTurnMode(nextMode);
    markDirty();
  }, []);

  const selectAgentModel = useCallback((nextModelId: string | null): void => {
    const currentScope = scopeRef.current;
    if (composerProductMode(currentScope) !== "agent") return;
    const normalized = normalizeNullableSelection(nextModelId);
    if (stateRef.current.modelId === normalized) return;
    const nextCandidate = resolveSelectedModelCandidate(currentScope.providerModelSettings, normalized);
    const currentEffort = stateRef.current.reasoningEffort;
    const nextEffort = currentEffort && nextCandidate?.supportedReasoningEfforts.some((option) => option.value === currentEffort)
      ? currentEffort : null;
    writeAgentModelId(normalized);
    writeAgentReasoningEffort(nextEffort);
    draftRestoredModelSelectionsRef.current.set(
      draftScopeIdentity(currentScope.projectId, composerProductMode(currentScope)),
      { modelId: normalized, reasoningEffort: nextEffort },
    );
    markDirty();
  }, []);

  const selectAgentReasoningEffort = useCallback((nextEffort: string | null): void => {
    const currentScope = scopeRef.current;
    if (composerProductMode(currentScope) !== "agent") return;
    const normalized = normalizeNullableSelection(nextEffort);
    if (stateRef.current.reasoningEffort === normalized) return;
    writeAgentReasoningEffort(normalized);
    draftRestoredModelSelectionsRef.current.set(
      draftScopeIdentity(currentScope.projectId, composerProductMode(currentScope)),
      { modelId: stateRef.current.modelId, reasoningEffort: normalized },
    );
    markDirty();
  }, []);

  const selectAgentProviderModel = useCallback(async (providerId: string, nextModelId: string | null): Promise<void> => {
    const currentScope = scopeRef.current;
    if (composerProductMode(currentScope) !== "agent") return;
    const normalized = normalizeNullableSelection(nextModelId);
    const group = currentScope.providerModelCatalogs?.find((item) => item.providerId === providerId);
    const nextCandidate = resolveSelectedModelCandidate(group?.snapshot, normalized);
    const currentEffort = stateRef.current.reasoningEffort;
    const nextEffort = currentEffort && nextCandidate?.supportedReasoningEfforts.some((option) => option.value === currentEffort)
      ? currentEffort : null;
    const providerChanged = providerId !== effectiveComposerProviderId(currentScope);
    if (!providerChanged && stateRef.current.modelId === normalized && stateRef.current.reasoningEffort === nextEffort) return;
    scopeGenerationRef.current += providerChanged ? 1 : 0;
    writeAgentModelId(normalized);
    writeAgentReasoningEffort(nextEffort);
    draftRestoredModelSelectionsRef.current.set(
      draftScopeIdentity(currentScope.projectId, composerProductMode(currentScope)),
      { modelId: normalized, reasoningEffort: nextEffort },
    );
    markDirty();
    if (providerChanged) {
      pendingProviderSelectionRef.current = providerId;
      await portsRef.current.session.selectProvider?.(providerId);
    }
  }, []);

  const selectProvider = useCallback(async (providerId: string): Promise<void> => {
    const currentScope = scopeRef.current;
    if (providerId === effectiveComposerProviderId(currentScope)) return;
    scopeGenerationRef.current += 1;
    writeAgentModelId(null);
    writeAgentReasoningEffort(null);
    draftRestoredModelSelectionsRef.current.set(
      draftScopeIdentity(currentScope.projectId, composerProductMode(currentScope)),
      { modelId: null, reasoningEffort: null },
    );
    markDirty();
    await portsRef.current.session.selectProvider?.(providerId);
  }, []);

  const cleanupTransition = useCallback((transition: ComposerTransition): void => {
    scopeGenerationRef.current += 1;
    const currentScope = scopeRef.current;
    if (currentScope.projectId && currentScope.projectRegistered) {
      void syncOwnerRef.current!.flush(currentScope.projectId, composerProductMode(currentScope))
        .catch((cause) => portsRef.current.onError(composerErrorMessage(cause)));
    }
    if (transition === "project-changed") return;
    setDraftSkillOverrides({});
    setFileRefsState([]);
    setAttachments([]);
    if (transition === "new-conversation") setComposerTextState("");
    markDirty();
  }, []);

  const flushDraft = useCallback(async (): Promise<string | null> => {
    const currentScope = scopeRef.current;
    if (!currentScope.projectId) return null;
    return syncOwnerRef.current!.flush(currentScope.projectId, composerProductMode(currentScope));
  }, []);

  const captureDraftMutationToken = useCallback((): string | null => (
    controllerRef.current!.read().mutationToken ?? null
  ), []);

  const settleAcceptedDraft = useCallback(async (
    accepted: ComposerDraftContent,
    options?: ComposerDraftSettlementOptions,
    checkpoint?: ComposerDraftCheckpoint,
    guard?: ComposerDraftSettlementGuard,
  ): Promise<void> => {
    try {
      await syncOwnerRef.current!.settleAccepted(accepted, options, checkpoint, guard);
    } catch {
      try {
        await syncOwnerRef.current!.load(accepted.projectId, accepted.productMode);
        const currentScope = scopeRef.current;
        if (currentScope.projectId === accepted.projectId
          && composerProductMode(currentScope) === accepted.productMode
          && currentScope.projectRegistered) {
          syncOwnerRef.current!.schedule(composerDraftContent({
            projectId: accepted.projectId, productMode: accepted.productMode,
            agentTurnMode: stateRef.current.agentTurnMode, agentModelId: stateRef.current.modelId,
            agentReasoningEffort: stateRef.current.reasoningEffort, text: stateRef.current.text,
            contextRefs: stateRef.current.contextRefs, attachments: stateRef.current.attachments,
            skillOverrides: stateRef.current.skillOverrides, selectedProviderId: effectiveComposerProviderId(currentScope),
          }));
        }
        portsRef.current.onError("消息已发送，草稿已重新同步。");
      } catch {
        portsRef.current.onError("消息已发送，草稿暂时无法同步。请刷新后确认输入框内容。");
      }
    }
  }, []);

  const clearAcceptedReviewCommand = useCallback(async (
    capturedText: string,
    _expectedDraftUpdatedAt: string | null,
    capturedMutationToken?: string | null,
  ): Promise<void> => {
    const currentScope = scopeRef.current;
    const draft = controllerRef.current!.read();
    if (!currentScope.projectId) return;
    const productMode = composerProductMode(currentScope);
    const checkpoint = syncOwnerRef.current!.checkpoint(currentScope.projectId, productMode);
    const captured = {
      ...draft,
      text: capturedText,
      mutationToken: capturedMutationToken ?? draft.mutationToken,
    };
    const accepted = composerDraftContent({
      projectId: currentScope.projectId, productMode, agentTurnMode: draft.agentTurnMode,
      agentModelId: draft.modelId, agentReasoningEffort: draft.reasoningEffort, text: capturedText,
      contextRefs: draft.contextRefs, attachments: draft.attachments, skillOverrides: draft.skillOverrides,
      selectedProviderId: effectiveComposerProviderId(currentScope),
    });
    controllerRef.current!.clearAcceptedSnapshot(captured, { text: true });
    await settleAcceptedDraft(
      accepted,
      { text: true },
      checkpoint,
      controllerRef.current!.settlementGuard(captured.mutationToken, accepted),
    );
  }, [settleAcceptedDraft]);

  const applyRestoredSnapshot = useCallback((restored: ComposerDraftSnapshot): void => {
    setComposerTextState(restored.text);
    setFileRefsState(restored.contextRefs);
    setAttachments(restored.attachments);
    setDraftSkillOverrides(restored.skillOverrides);
    if (restored.productMode !== "agent") return;
    const restoredMode = restored.agentTurnMode ?? "default";
    writeAgentTurnMode(restoredMode);
    writeAgentModelId(restored.agentModelId);
    writeAgentReasoningEffort(restored.agentReasoningEffort);
    const key = draftScopeIdentity(restored.projectId, restored.productMode);
    draftRestoredModesRef.current.set(key, restoredMode);
    draftRestoredModelSelectionsRef.current.set(key, {
      modelId: restored.agentModelId,
      reasoningEffort: restored.agentReasoningEffort,
    });
  }, []);

  return {
    composerText, draftSkillOverrides, fileRefs, attachments, agentTurnMode, agentModelId, agentReasoningEffort,
    draftDiagnostics, draftLoadedScopeKey, stateRef, controller: controllerRef.current, syncOwner: syncOwnerRef.current,
    markDirty,
    setComposerText: (next) => {
      const value = typeof next === "function" ? next(controllerRef.current!.read().text) : next;
      controllerRef.current!.updateText(value);
    },
    setFileRefs: (next) => { controllerRef.current!.updateContextRefs(() => normalizeComposerRefs(next)); markDirty(); },
    addFileReference: (ref) => { controllerRef.current!.updateContextRefs((current) => normalizeComposerRefs([...current, ref])); markDirty(); },
    setAttachmentsRaw: (next) => controllerRef.current!.updateAttachments(
      typeof next === "function" ? next : () => next,
    ),
    setSkillOverridesRaw: (next) => controllerRef.current!.updateSkillOverrides(
      typeof next === "function" ? next : () => next,
    ),
    setDiagnosticsRaw: setDraftDiagnostics,
    selectAgentTurnMode, selectAgentModel, selectAgentProviderModel, selectAgentReasoningEffort, selectProvider, cleanupTransition,
    flushDraft, captureDraftMutationToken, settleAcceptedDraft, clearAcceptedReviewCommand, applyRestoredSnapshot,
  };
}

function contentFromSnapshot(snapshot: ComposerDraftSnapshot): ComposerDraftContent {
  return {
    projectId: snapshot.projectId, productMode: snapshot.productMode, agentTurnMode: snapshot.agentTurnMode,
    agentModelId: snapshot.agentModelId, agentReasoningEffort: snapshot.agentReasoningEffort, text: snapshot.text,
    contextRefs: snapshot.contextRefs, attachmentIds: snapshot.attachments.map((attachment) => attachment.id),
    skillOverrides: snapshot.skillOverrides, selectedProviderId: snapshot.selectedProviderId,
  };
}

function composerDraftFingerprint(content: ComposerDraftContent): string {
  return JSON.stringify(content);
}
