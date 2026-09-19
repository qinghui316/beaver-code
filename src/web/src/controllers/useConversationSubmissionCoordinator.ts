import { useCallback, useRef, type MutableRefObject } from "react";
import type { ConversationAccessCapturePort } from "./conversation-access-contract.js";
import type { SkillListItem, TopicAttachment, TopicFileReference } from "../types.js";
import type {
  ComposerDraftCheckpoint,
  ComposerDraftContent,
  ComposerDraftSettlementOptions,
  ComposerDraftSyncOwner,
} from "./ComposerDraftSyncOwner.js";
import { createDraftSubmissionSnapshot } from "./conversation-submission-contract.js";
import {
  ConversationTurnSubmissionController,
  type PendingConversationSubmission,
} from "./ConversationTurnSubmissionController.js";
import { createConversationSubmissionPorts } from "./ConversationSubmissionComposition.js";
import type { ConversationDraftController, ConversationDraftViewModel } from "./ConversationDraftController.js";
import {
  composerDraftContent,
  composerActionOwnsCurrentScope,
  composerProductMode,
  composerRequestOwnsCurrentScope,
  defaultAttachmentPrompt,
  defaultComposerIds,
  effectiveComposerProviderId,
  prepareComposerInput,
  resolveAgentTurnModeDisabledReason,
  resolveAgentTurnModelDisabledReason,
  resolveAttachmentCapabilityDisabledReason,
  resolveDraftProviderDisabledReason,
  topicAttachmentCapabilityProbe,
  workbenchEventMatchesConversation,
  type ConversationComposerScope,
  type ConversationSubmissionCoordinatorPorts,
  type CreateConversationComposerInput,
  type CurrentValueRef,
  type SkillRequestIdentity,
} from "./conversation-composer-contract.js";
import { defaultComposerAttachmentApi } from "./conversation-composer-http-adapters.js";

interface ConversationSubmissionDraftPort {
  controller: Pick<ConversationDraftController, "read" | "clearAcceptedSnapshot" | "restore" | "settlementGuard">;
  syncOwner: Pick<ComposerDraftSyncOwner, "checkpoint" | "flush">;
  settleAcceptedDraft(
    accepted: ComposerDraftContent,
    options?: ComposerDraftSettlementOptions,
    checkpoint?: ComposerDraftCheckpoint,
    guard?: ReturnType<ConversationDraftController["settlementGuard"]>,
  ): Promise<void>;
  setComposerText(next: string | ((current: string) => string)): void;
  setFileRefs(next: TopicFileReference[]): void;
}

interface ConversationSubmissionResourcePort {
  skillItems: SkillListItem[];
  reloadSkills(projectId?: string | null, capturedIdentity?: SkillRequestIdentity): Promise<void>;
  applySkillOverrides(identity: SkillRequestIdentity, overrides: Record<string, boolean>): Promise<void>;
  appendAttachments(files: File[]): Promise<TopicAttachment[]>;
}

export interface ConversationSubmissionCoordinator {
  createConversation(input?: CreateConversationComposerInput): Promise<{ projectId: string; conversationId: string } | null>;
  submitMessage(): Promise<void>;
  retryPendingIntent(clientRequestId: string): Promise<void>;
  restorePendingIntent(clientRequestId: string): void;
}

export function useConversationSubmissionCoordinator(
  portsRef: CurrentValueRef<ConversationSubmissionCoordinatorPorts>,
  scopeRef: MutableRefObject<ConversationComposerScope>,
  scopeGenerationRef: MutableRefObject<number>,
  draft: ConversationSubmissionDraftPort,
  resources: ConversationSubmissionResourcePort,
  access?: ConversationAccessCapturePort,
): ConversationSubmissionCoordinator {
  const submissionOwnerRef = useRef<ConversationTurnSubmissionController | null>(null);
  const submissionIntentsRef = useRef(new Set<string>());

  function submissionOwner(): ConversationTurnSubmissionController {
    if (!submissionOwnerRef.current) {
      submissionOwnerRef.current = new ConversationTurnSubmissionController(createConversationSubmissionPorts({
        operation: () => portsRef.current.operation,
        ids: () => portsRef.current.ids ?? defaultComposerIds,
        session: () => portsRef.current.session,
        actions: () => portsRef.current.actions,
        timeline: () => portsRef.current.timeline,
        projection: () => portsRef.current.projection,
        attachments: () => portsRef.current.attachments ?? defaultComposerAttachmentApi,
        drafts: () => ({
          checkpoint: (projectId, productMode) => draft.syncOwner.checkpoint(projectId, productMode),
          flush: (projectId, productMode) => draft.syncOwner.flush(projectId, productMode),
          settleAccepted: (accepted, checkpoint, mutationToken) => draft.settleAcceptedDraft(
            accepted,
            undefined,
            checkpoint,
            draft.controller.settlementGuard(mutationToken, accepted),
          ),
        }),
        skills: () => ({
          apply: resources.applySkillOverrides,
          reload: (identity) => resources.reloadSkills(identity.projectId, identity),
        }),
        onError: (message) => portsRef.current.onError(message),
      }));
    }
    return submissionOwnerRef.current;
  }

  const createConversation = useCallback(async (
    input: CreateConversationComposerInput = {},
  ): Promise<{ projectId: string; conversationId: string } | null> => {
    const currentScope = scopeRef.current;
    const generation = scopeGenerationRef.current;
    const capturedDraft = draft.controller.read();
    const capturedProjectId = currentScope.projectId;
    const capturedProductMode = composerProductMode(currentScope);
    const capturedProviderId = effectiveComposerProviderId(currentScope);
    const clientRequestId = (portsRef.current.ids ?? defaultComposerIds).createClientRequestId();
    const body = input.body ?? capturedDraft.text;
    const selectedRefs = input.fileRefs ?? capturedDraft.contextRefs;
    const attachmentIds = input.attachmentIds ?? capturedDraft.attachments.map((attachment) => attachment.id);
    const attachmentFiles = input.attachmentFiles ?? [];
    const capturedAttachments = capturedDraft.attachments.filter((attachment) => attachmentIds.includes(attachment.id));
    const acceptedDraft = { ...capturedDraft, text: body, contextRefs: selectedRefs, attachments: capturedAttachments };
    if (!capturedProjectId || (!body.trim() && attachmentIds.length === 0 && attachmentFiles.length === 0)) return null;
    const turnModeError = resolveAgentTurnModeDisabledReason(currentScope, capturedDraft.agentTurnMode)
      ?? resolveAgentTurnModelDisabledReason(
        currentScope,
        capturedDraft.agentTurnMode,
        capturedDraft.modelId,
        capturedDraft.reasoningEffort,
      );
    const providerError = resolveDraftProviderDisabledReason(currentScope);
    if (providerError ?? turnModeError) {
      portsRef.current.onError(providerError ?? turnModeError);
      return null;
    }
    const attachmentError = resolveAttachmentCapabilityDisabledReason(currentScope, [
      ...capturedAttachments,
      ...attachmentFiles.map(topicAttachmentCapabilityProbe),
    ]);
    if (attachmentError) {
      portsRef.current.onError(attachmentError);
      return null;
    }
    const prepared = prepareComposerInput({
      body,
      selectedRefs,
      skills: resources.skillItems,
      conversationId: null,
      draftSkillOverrides: capturedDraft.skillOverrides,
    });
    const acceptedDraftContent = composerDraftContent({
      projectId: capturedProjectId,
      productMode: capturedProductMode,
      agentTurnMode: capturedDraft.agentTurnMode,
      agentModelId: capturedDraft.modelId,
      agentReasoningEffort: capturedDraft.reasoningEffort,
      text: acceptedDraft.text,
      contextRefs: acceptedDraft.contextRefs,
      attachments: acceptedDraft.attachments,
      skillOverrides: acceptedDraft.skillOverrides,
      selectedProviderId: capturedProviderId,
    });
    if (currentScope.providerCount > 1 && !currentScope.selectedProviderId) {
      portsRef.current.onError("请先选择本次对话使用的 Agent。");
      return null;
    }
    const demandBody = prepared.text || defaultAttachmentPrompt(attachmentIds.length + attachmentFiles.length);
    let accessSnapshot: Awaited<ReturnType<ConversationAccessCapturePort["capture"]>>;
    try {
      const capturedAccess = access?.capture() ?? {};
      accessSnapshot = capturedAccess instanceof Promise ? await capturedAccess : capturedAccess;
    } catch {
      if (composerActionOwnsCurrentScope(generation, currentScope, scopeGenerationRef, scopeRef)) {
        portsRef.current.onError("权限设置尚未就绪，请重新检测后发送。");
      }
      return null;
    }
    const snapshot = createDraftSubmissionSnapshot({
      ...accessSnapshot,
      projectId: capturedProjectId,
      productMode: capturedProductMode,
      conversationId: null,
      clientRequestId,
      draftRevision: null,
      text: demandBody,
      contextRefs: prepared.contextRefs,
      attachments: capturedAttachments,
      skillOverrides: prepared.skillOverrides,
      providerId: capturedProviderId,
      agentTurnMode: capturedProductMode === "agent" ? capturedDraft.agentTurnMode : null,
      modelId: capturedProductMode === "agent" ? capturedDraft.modelId : null,
      reasoningEffort: capturedProductMode === "agent" ? capturedDraft.reasoningEffort : null,
    });
    return submissionOwner().submitCreate({
      snapshot,
      attachments: capturedAttachments,
      attachmentFiles,
      acceptedDraft: acceptedDraftContent,
      acceptedDraftMutationToken: acceptedDraft.mutationToken ?? null,
      isCurrent: (created) => composerRequestOwnsCurrentScope(
        generation,
        [capturedProjectId, ...(created ? [created.projectId] : [])],
        capturedProductMode,
        capturedProviderId,
        scopeGenerationRef,
        scopeRef,
        created?.conversationId,
      ),
      onPending: () => {
        if (!composerRequestOwnsCurrentScope(
          generation, [capturedProjectId], capturedProductMode, capturedProviderId,
          scopeGenerationRef, scopeRef,
        )) return;
        draft.controller.clearAcceptedSnapshot(acceptedDraft, { text: true });
        portsRef.current.onError(null);
      },
      onAccepted: async (created) => {
        draft.controller.clearAcceptedSnapshot(acceptedDraft);
        await resources.reloadSkills(created.projectId);
      },
    });
  }, [draft, resources]);

  const submitMessage = useCallback(async (): Promise<void> => {
    const currentScope = scopeRef.current;
    const generation = scopeGenerationRef.current;
    const productMode = composerProductMode(currentScope);
    const captured = draft.controller.read();
    const attachmentIds = captured.attachments.map((attachment) => attachment.id);
    if (!currentScope.projectId || !currentScope.conversation || (!captured.text.trim() && attachmentIds.length === 0)) return;
    if (currentScope.conversation.productMode && currentScope.conversation.productMode !== productMode) {
      portsRef.current.onError("Conversation productMode does not match the selected application mode.");
      return;
    }
    if (currentScope.conversation.state !== "active") {
      portsRef.current.onError("已完成或稍后处理的需求对话为只读，不能继续发送消息。");
      return;
    }
    const prepared = prepareComposerInput({
      body: captured.text,
      selectedRefs: captured.contextRefs,
      skills: resources.skillItems,
      conversationId: currentScope.conversation.id,
      draftSkillOverrides: captured.skillOverrides,
    });
    if (!prepared.text && attachmentIds.length === 0) {
      if (composerActionOwnsCurrentScope(generation, currentScope, scopeGenerationRef, scopeRef)) {
        draft.setComposerText("");
        draft.setFileRefs([]);
      }
      return;
    }
    const turnModeError = resolveAgentTurnModeDisabledReason(currentScope, captured.agentTurnMode)
      ?? resolveAgentTurnModelDisabledReason(currentScope, captured.agentTurnMode, captured.modelId, captured.reasoningEffort);
    const providerError = resolveDraftProviderDisabledReason(currentScope);
    if (providerError ?? turnModeError) {
      portsRef.current.onError(providerError ?? turnModeError);
      return;
    }
    const attachmentError = resolveAttachmentCapabilityDisabledReason(currentScope, captured.attachments);
    if (attachmentError) {
      portsRef.current.onError(attachmentError);
      return;
    }
    const acceptedDraftContent = composerDraftContent({
      projectId: currentScope.projectId,
      productMode,
      agentTurnMode: captured.agentTurnMode,
      agentModelId: captured.modelId,
      agentReasoningEffort: captured.reasoningEffort,
      text: captured.text,
      contextRefs: captured.contextRefs,
      attachments: captured.attachments,
      skillOverrides: captured.skillOverrides,
      selectedProviderId: effectiveComposerProviderId(currentScope),
    });
    const clientRequestId = (portsRef.current.ids ?? defaultComposerIds).createClientRequestId();
    let accessSnapshot: Awaited<ReturnType<ConversationAccessCapturePort["capture"]>>;
    try {
      const capturedAccess = access?.capture() ?? {};
      accessSnapshot = capturedAccess instanceof Promise ? await capturedAccess : capturedAccess;
    } catch {
      if (composerActionOwnsCurrentScope(generation, currentScope, scopeGenerationRef, scopeRef)) {
        portsRef.current.onError("权限设置尚未就绪，请重新检测后发送。");
      }
      return;
    }
    const snapshot = createDraftSubmissionSnapshot({
      ...accessSnapshot,
      projectId: currentScope.projectId,
      productMode,
      conversationId: currentScope.conversation.id,
      clientRequestId,
      draftRevision: null,
      text: prepared.text || defaultAttachmentPrompt(attachmentIds.length),
      contextRefs: prepared.contextRefs,
      attachments: captured.attachments,
      skillOverrides: prepared.skillOverrides,
      providerId: effectiveComposerProviderId(currentScope),
      agentTurnMode: productMode === "agent" ? captured.agentTurnMode : null,
      modelId: captured.modelId,
      reasoningEffort: captured.reasoningEffort,
    });
    await submissionOwner().submitMessage({
      snapshot,
      attachments: captured.attachments,
      acceptedDraft: acceptedDraftContent,
      acceptedDraftMutationToken: captured.mutationToken ?? null,
      skillIdentity: {
        projectId: currentScope.projectId,
        productMode,
        conversationId: currentScope.conversation.id,
        providerId: currentScope.conversation.selectedProviderId ?? null,
      },
      providerSwitchIntent: currentScope.selectedProviderId
        && currentScope.selectedProviderId !== currentScope.conversation.selectedProviderId
        ? "resume-workflow" : undefined,
      isCurrent: () => composerActionOwnsCurrentScope(generation, currentScope, scopeGenerationRef, scopeRef),
      acceptsEvent: (event) => workbenchEventMatchesConversation(event, {
        projectId: snapshot.projectId,
        productMode: snapshot.productMode,
        conversationId: snapshot.conversationId!,
      }),
      onPending: () => {
        if (!composerActionOwnsCurrentScope(generation, currentScope, scopeGenerationRef, scopeRef)) return;
        draft.controller.clearAcceptedSnapshot(captured, { text: true });
        portsRef.current.onError(null);
      },
      onAccepted: () => {
        draft.controller.clearAcceptedSnapshot(captured, { contextRefs: true, attachments: true, skillOverrides: true });
      },
    });
  }, [draft, resources]);

  const retryPendingIntent = useCallback(async (clientRequestId: string): Promise<void> => {
    const currentScope = scopeRef.current;
    const generation = scopeGenerationRef.current;
    await submissionOwner().retryPendingIntent(clientRequestId, {
      matchesCurrent: (submission) => generation === scopeGenerationRef.current
        && currentScope.projectId === submission.snapshot.projectId
        && composerProductMode(currentScope) === submission.snapshot.productMode
        && (submission.kind === "create" || currentScope.conversation?.id === submission.snapshot.conversationId),
      selectedConversationProviderId: currentScope.conversation?.selectedProviderId ?? null,
      isCurrent: (snapshot, created) => composerRequestOwnsCurrentScope(
        generation,
        [snapshot.projectId, ...(created ? [created.projectId] : [])],
        snapshot.productMode,
        snapshot.providerId,
        scopeGenerationRef,
        scopeRef,
        created?.conversationId,
      ),
      acceptsEvent: (snapshot, event) => workbenchEventMatchesConversation(event, {
        projectId: snapshot.projectId,
        productMode: snapshot.productMode,
        conversationId: snapshot.conversationId!,
      }),
      onAccepted: async (submission, created) => {
        const accepted = pendingSubmissionDraftViewModel(submission);
        if (accepted) draft.controller.clearAcceptedSnapshot(accepted, {
          contextRefs: true,
          attachments: true,
          skillOverrides: true,
        });
        if (created) await resources.reloadSkills(created.projectId);
      },
    });
  }, [draft, resources]);

  const restorePendingIntent = useCallback((clientRequestId: string): void => {
    const pending = submissionOwner().inspect(clientRequestId);
    if (!pending) return;
    const currentScope = scopeRef.current;
    const snapshot = pending.snapshot;
    if (currentScope.projectId !== snapshot.projectId || composerProductMode(currentScope) !== snapshot.productMode) {
      portsRef.current.onError("这条消息不属于当前项目或模式，无法放回输入框。");
      return;
    }
    if (pending.kind === "message" && currentScope.conversation?.id !== snapshot.conversationId) {
      portsRef.current.onError("请切回原会话，再把这条消息放回输入框。");
      return;
    }
    const submission = submissionOwner().restore(clientRequestId);
    if (!submission) return;
    draft.controller.restore(snapshot, submission.attachments, {
      restoreSkillOverrides: submission.kind === "create",
      restoreConfiguration: true,
    });
    if (submission.attachmentFiles.length > 0) void resources.appendAttachments(submission.attachmentFiles);
    portsRef.current.onError(null);
  }, [draft, resources]);

  async function reserveSubmission<T>(action: () => Promise<T>, duplicate: T): Promise<T> {
    const scope = scopeRef.current;
    const key = JSON.stringify([scope.projectId, composerProductMode(scope), scope.conversation?.id,
      effectiveComposerProviderId(scope), draft.controller.read().mutationToken]);
    if (submissionIntentsRef.current.has(key)) return duplicate;
    submissionIntentsRef.current.add(key);
    try { return await action(); } finally { submissionIntentsRef.current.delete(key); }
  }

  return {
    createConversation: (input) => reserveSubmission(() => createConversation(input), null),
    submitMessage: () => reserveSubmission(submitMessage, undefined),
    retryPendingIntent,
    restorePendingIntent,
  };
}

function pendingSubmissionDraftViewModel(submission: PendingConversationSubmission): ConversationDraftViewModel | null {
  const accepted = submission.acceptedDraft;
  if (!accepted) return null;
  const acceptedAttachmentIds = new Set(accepted.attachmentIds);
  return {
    text: accepted.text,
    contextRefs: accepted.contextRefs.map((reference) => ({ ...reference })),
    attachments: submission.attachments
      .filter((attachment) => acceptedAttachmentIds.has(attachment.id))
      .map((attachment: TopicAttachment) => ({ ...attachment })),
    skillOverrides: { ...accepted.skillOverrides },
    agentTurnMode: accepted.agentTurnMode ?? "default",
    modelId: accepted.agentModelId,
    reasoningEffort: accepted.agentReasoningEffort,
    mutationToken: submission.acceptedDraftMutationToken ?? undefined,
  };
}
