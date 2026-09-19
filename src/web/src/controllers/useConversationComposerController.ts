import { useEffect, useRef } from "react";
import { projectComposerModelLabel } from "./ComposerExperienceProjection.js";
import {
  composerProductMode,
  composerScopeIdentity,
  resolveAgentTurnModeDisabledReason,
  resolveAgentTurnModelDisabledReason,
  resolveAttachmentCapabilityDisabledReason,
  resolveDraftProviderDisabledReason,
  type ConversationComposerPorts,
  type ConversationComposerScope,
} from "./conversation-composer-contract.js";
import { useConversationComposerResources } from "./useConversationComposerResources.js";
import { useConversationAccessController } from "./useConversationAccessController.js";
import { createConversationComposerPortViews } from "./conversation-composer-port-views.js";
import { useConversationDraftLifecycle } from "./useConversationDraftLifecycle.js";
import { useConversationExecutionActions } from "./useConversationExecutionActions.js";
import { useConversationSubmissionCoordinator } from "./useConversationSubmissionCoordinator.js";
import { rendererUpdateParticipants } from "./RendererUpdateParticipants.js";
import { composerDraftContent, effectiveComposerProviderId } from "./conversation-composer-contract.js";

export * from "./conversation-composer-contract.js";
export type {
  ComposerAttachmentUpload,
  ComposerCreateConversationRequest,
  ComposerCreatedConversation,
  ComposerMessageRequest,
  ComposerSkillOverride,
} from "./conversation-submission-contract.js";

export function useConversationComposerController(
  scope: ConversationComposerScope,
  ports: ConversationComposerPorts,
) {
  const scopeRef = useRef(scope);
  const portViews = createConversationComposerPortViews(ports);
  const draftPortsRef = useRef(portViews.draft);
  const resourcePortsRef = useRef(portViews.resources);
  const submissionPortsRef = useRef(portViews.submission);
  const executionPortsRef = useRef(portViews.execution);
  const scopeGenerationRef = useRef(0);
  const scopeIdentityRef = useRef(composerScopeIdentity(scope));
  scopeRef.current = scope;
  draftPortsRef.current = portViews.draft;
  resourcePortsRef.current = portViews.resources;
  submissionPortsRef.current = portViews.submission;
  executionPortsRef.current = portViews.execution;

  useEffect(() => {
    const identity = composerScopeIdentity(scope);
    if (identity === scopeIdentityRef.current) return;
    scopeIdentityRef.current = identity;
    scopeGenerationRef.current += 1;
  }, [
    scope.productMode,
    scope.projectId,
    scope.conversation?.id,
    scope.conversation?.productMode,
    scope.conversation?.selectedProviderId,
    scope.selectedProviderId,
  ]);

  const draft = useConversationDraftLifecycle(scope, draftPortsRef, scopeRef, scopeGenerationRef);
  const resources = useConversationComposerResources(scope, resourcePortsRef, scopeRef, scopeGenerationRef, draft);
  const access = useConversationAccessController(scope, ports.access);
  const submission = useConversationSubmissionCoordinator(
    submissionPortsRef,
    scopeRef,
    scopeGenerationRef,
    draft,
    resources,
    access,
  );
  const execution = useConversationExecutionActions(
    executionPortsRef,
    scopeRef,
    scopeGenerationRef,
    draft,
    resources,
    submission,
    access,
  );
  const latestForUpdate = useRef({ draft, resources });
  latestForUpdate.current = { draft, resources };
  useEffect(() => rendererUpdateParticipants.register(async (updateId) => {
    const { draft: currentDraft, resources: currentResources } = latestForUpdate.current;
    const currentScope = scopeRef.current;
    if (currentResources.hasPendingUploads()) throw new Error("Attachments are still uploading.");
    const scopeIdentity = composerScopeIdentity(currentScope);
    const mutationToken = currentDraft.controller.read().mutationToken;
    if (currentScope.projectId && currentScope.projectRegistered) {
      if (!currentDraft.draftLoadedScopeKey) throw new Error("Draft restoration is not complete.");
      const value = currentDraft.stateRef.current;
      currentDraft.syncOwner.schedule(composerDraftContent({
        projectId: currentScope.projectId, productMode: composerProductMode(currentScope),
        text: value.text, contextRefs: value.contextRefs, attachments: value.attachments,
        skillOverrides: value.skillOverrides, agentTurnMode: value.agentTurnMode,
        agentModelId: value.modelId, agentReasoningEffort: value.reasoningEffort,
        selectedProviderId: effectiveComposerProviderId(currentScope),
      }));
    }
    const receipt = await currentDraft.syncOwner.saveForUpdate(updateId);
    return () => scopeIdentity === composerScopeIdentity(scopeRef.current)
      && !latestForUpdate.current.resources.hasPendingUploads()
      && currentDraft.controller.read().mutationToken === mutationToken
      && currentDraft.syncOwner.isSaveReceiptCurrent(receipt);
  }), []);

  const agentTurnModeDisabledReason = resolveDraftProviderDisabledReason(scope)
    ?? resolveAgentTurnModeDisabledReason(scope, draft.agentTurnMode)
    ?? resolveAgentTurnModelDisabledReason(
      scope,
      draft.agentTurnMode,
      draft.agentModelId,
      draft.agentReasoningEffort,
    )
    ?? resolveAttachmentCapabilityDisabledReason(scope, draft.attachments);
  const modelLabel = projectComposerModelLabel({
    productMode: composerProductMode(scope),
    composerModelId: draft.agentModelId,
    savedConversationModelId: scope.conversation?.agentModelId ?? null,
    modelSettings: scope.providerModelSettings ?? null,
  });

  return {
    accessView: access.view,
    selectAccess: access.select,
    refreshAccess: access.refresh,
    composerText: draft.composerText,
    setComposerText: draft.setComposerText,
    skillItems: resources.skillItems,
    activeSkillIds: resources.activeSkillIds,
    enabledSkillCount: resources.enabledSkillCount,
    draftSkillOverrides: draft.draftSkillOverrides,
    fileRefs: draft.fileRefs,
    setFileRefs: draft.setFileRefs,
    addFileReference: draft.addFileReference,
    attachments: draft.attachments,
    draftDiagnostics: draft.draftDiagnostics,
    agentTurnMode: draft.agentTurnMode,
    agentModelId: draft.agentModelId,
    agentReasoningEffort: draft.agentReasoningEffort,
    modelLabel,
    selectAgentTurnMode: draft.selectAgentTurnMode,
    selectAgentModel: draft.selectAgentModel,
    selectAgentProviderModel: draft.selectAgentProviderModel,
    selectAgentReasoningEffort: draft.selectAgentReasoningEffort,
    selectProvider: draft.selectProvider,
    agentTurnModeDisabledReason,
    planModeDisabledReason: resolveAgentTurnModeDisabledReason({ ...scope, running: false }, "plan"),
    setAttachments: resources.setAttachments,
    reloadSkills: resources.reloadSkills,
    toggleSkill: resources.toggleSkill,
    appendAttachments: resources.appendAttachments,
    removeAttachment: resources.removeAttachment,
    createConversation: submission.createConversation,
    enqueue: execution.enqueue,
    reclaimQueuedTurn: execution.reclaimQueuedTurn,
    flushDraft: draft.flushDraft,
    captureDraftMutationToken: draft.captureDraftMutationToken,
    clearAcceptedReviewCommand: draft.clearAcceptedReviewCommand,
    send: execution.send,
    retryPendingIntent: submission.retryPendingIntent,
    restorePendingIntent: submission.restorePendingIntent,
    stop: execution.stop,
    cleanupTransition: execution.cleanupTransition,
  };
}
