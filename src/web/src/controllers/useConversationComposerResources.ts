import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ComposerDraftDiagnostic, SkillListItem, TopicAttachment } from "../types.js";
import {
  activeComposerSkillIds,
  composerErrorMessage,
  mergeTopicAttachments,
  skillRequestIdentity,
  skillRequestIdentityKey,
  type ConversationComposerResourcePorts,
  type ConversationComposerScope,
  type CurrentValueRef,
  type SkillRequestIdentity,
} from "./conversation-composer-contract.js";
import {
  defaultComposerAttachmentApi,
  defaultComposerSkillApi,
  readComposerFileAsDataUrl,
} from "./conversation-composer-http-adapters.js";
import { subscribeSkillCatalogChanges } from "./skills-settings-http-adapter.js";

interface ComposerResourceDraftPort {
  draftSkillOverrides: Record<string, boolean>;
  draftLoadedScopeKey: string | null;
  stateRef: MutableRefObject<{ skillOverrides: Record<string, boolean> }>;
  markDirty(): void;
  setAttachmentsRaw(next: TopicAttachment[] | ((current: TopicAttachment[]) => TopicAttachment[])): void;
  setSkillOverridesRaw(next: Record<string, boolean> | ((current: Record<string, boolean>) => Record<string, boolean>)): void;
  setDiagnosticsRaw(next: ComposerDraftDiagnostic[] | ((current: ComposerDraftDiagnostic[]) => ComposerDraftDiagnostic[])): void;
}

export interface ConversationComposerResources {
  hasPendingUploads(): boolean;
  skillItems: SkillListItem[];
  activeSkillIds: string[];
  enabledSkillCount: number;
  reloadSkills(projectId?: string | null, capturedIdentity?: SkillRequestIdentity): Promise<void>;
  toggleSkill(skillId: string): Promise<void>;
  appendAttachments(files: File[]): Promise<TopicAttachment[]>;
  removeAttachment(attachmentId: string): Promise<void>;
  setAttachments(next: TopicAttachment[] | ((current: TopicAttachment[]) => TopicAttachment[])): void;
  applySkillOverrides(identity: SkillRequestIdentity, overrides: Record<string, boolean>): Promise<void>;
  invalidateRequests(): void;
}

export function useConversationComposerResources(
  scope: ConversationComposerScope,
  portsRef: CurrentValueRef<ConversationComposerResourcePorts>,
  scopeRef: MutableRefObject<ConversationComposerScope>,
  scopeGenerationRef: MutableRefObject<number>,
  draft: ComposerResourceDraftPort,
): ConversationComposerResources {
  const [skillItems, setSkillItems] = useState<SkillListItem[]>([]);
  const [skillsLoadedIdentity, setSkillsLoadedIdentity] = useState<string | null>(null);
  const skillRequestGenerationRef = useRef(0);

  const activeSkillIds = useMemo(
    () => activeComposerSkillIds(skillItems, scope.conversation?.id ?? null, draft.draftSkillOverrides),
    [draft.draftSkillOverrides, scope.conversation?.id, skillItems],
  );

  const reloadSkills = useCallback(async (
    projectId = scopeRef.current.projectId,
    capturedIdentity?: SkillRequestIdentity,
  ): Promise<void> => {
    const generation = ++skillRequestGenerationRef.current;
    if (!projectId || !scopeRef.current.projectRegistered) {
      setSkillItems([]);
      setSkillsLoadedIdentity(null);
      return;
    }
    try {
      const identity = capturedIdentity ?? skillRequestIdentity({ ...scopeRef.current, projectId });
      const next = await (portsRef.current.skills ?? defaultComposerSkillApi).load(identity);
      if (generation !== skillRequestGenerationRef.current
        || skillRequestIdentityKey(identity) !== skillRequestIdentityKey(skillRequestIdentity(scopeRef.current))) return;
      setSkillItems(next);
      setSkillsLoadedIdentity(skillRequestIdentityKey(identity));
    } catch (cause) {
      if (generation === skillRequestGenerationRef.current) portsRef.current.onError(composerErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void reloadSkills(scope.projectId);
    return () => { skillRequestGenerationRef.current += 1; };
  }, [reloadSkills, scope.projectRegistered, scope.productMode, scope.projectId, scope.conversation?.id,
    scope.conversation?.productMode, scope.conversation?.selectedProviderId, scope.selectedProviderId]);

  useEffect(() => subscribeSkillCatalogChanges((providerId) => {
    const identity = skillRequestIdentity(scopeRef.current);
    if (!providerId || !identity.providerId || identity.providerId === providerId) void reloadSkills();
  }), [reloadSkills]);

  useEffect(() => {
    if (!draft.draftLoadedScopeKey || scope.conversation || !skillsLoadedIdentity
      || skillsLoadedIdentity !== skillRequestIdentityKey(skillRequestIdentity(scope))) return;
    const known = new Set(skillItems.map((skill) => skill.skillId));
    const unavailable = Object.keys(draft.draftSkillOverrides).filter((skillId) => !known.has(skillId));
    if (unavailable.length === 0) return;
    draft.setSkillOverridesRaw((current) => Object.fromEntries(
      Object.entries(current).filter(([skillId]) => known.has(skillId)),
    ));
    draft.setDiagnosticsRaw((current) => [
      ...current.filter((item) => item.code !== "unavailable-skill"),
      { code: "unavailable-skill", message: "部分已保存的技能当前不可用，已从草稿中停用。" },
    ]);
    draft.markDirty();
  }, [draft.draftLoadedScopeKey, draft.draftSkillOverrides, scope, skillItems, skillsLoadedIdentity]);

  const toggleSkill = useCallback(async (skillId: string): Promise<void> => {
    const currentScope = scopeRef.current;
    if (!currentScope.projectId) return;
    const currentlyActive = activeComposerSkillIds(
      skillItems,
      currentScope.conversation?.id ?? null,
      draft.stateRef.current.skillOverrides,
    ).includes(skillId);
    if (!currentScope.conversation) {
      draft.setSkillOverridesRaw((current) => ({ ...current, [skillId]: !currentlyActive }));
      draft.markDirty();
      return;
    }
    const generation = scopeGenerationRef.current;
    const identity = skillRequestIdentity(currentScope);
    const identityKey = skillRequestIdentityKey(identity);
    const ownsCurrentScope = (): boolean => generation === scopeGenerationRef.current
      && identityKey === skillRequestIdentityKey(skillRequestIdentity(scopeRef.current));
    try {
      await (portsRef.current.skills ?? defaultComposerSkillApi).setEnabled(identity, skillId, !currentlyActive);
      if (ownsCurrentScope()) {
        draft.setSkillOverridesRaw((current) => ({ ...current, [skillId]: !currentlyActive }));
        draft.markDirty();
        await reloadSkills(currentScope.projectId, identity);
      }
    } catch (cause) {
      if (ownsCurrentScope()) portsRef.current.onError(composerErrorMessage(cause));
      throw cause;
    }
  }, [reloadSkills, skillItems]);

  const uploadFilesForProject = useCallback(async (projectId: string, files: File[]): Promise<TopicAttachment[]> => {
    const uploaded: TopicAttachment[] = [];
    try {
      for (const file of files) {
        const data = await readComposerFileAsDataUrl(file);
        const attachment = await (portsRef.current.attachments ?? defaultComposerAttachmentApi).upload(projectId, {
          fileName: file.name,
          mediaType: file.type || "application/octet-stream",
          data,
        });
        uploaded.push({ ...attachment, previewUrl: attachment.kind === "image" ? data : undefined });
      }
      return uploaded;
    } catch (cause) {
      await Promise.allSettled(uploaded.map((attachment) => (
        portsRef.current.attachments ?? defaultComposerAttachmentApi
      ).remove(projectId, attachment.id)));
      throw cause;
    }
  }, []);

  const appendAttachments = useCallback(async (files: File[]): Promise<TopicAttachment[]> => {
    const projectId = scopeRef.current.projectId;
    if (!projectId || files.length === 0) return [];
    const generation = scopeGenerationRef.current;
    pendingUploads.current += 1;
    try {
      const uploaded = await uploadFilesForProject(projectId, files);
      if (generation !== scopeGenerationRef.current || projectId !== scopeRef.current.projectId) {
        await Promise.allSettled(uploaded.map((attachment) => (
          portsRef.current.attachments ?? defaultComposerAttachmentApi
        ).remove(projectId, attachment.id)));
        return [];
      }
      draft.setAttachmentsRaw((current) => mergeTopicAttachments(current, uploaded));
      draft.markDirty();
      return uploaded;
    } catch (cause) {
      portsRef.current.onError(composerErrorMessage(cause));
      return [];
    } finally {
      pendingUploads.current -= 1;
    }
  }, [uploadFilesForProject]);

  const removeAttachment = useCallback(async (attachmentId: string): Promise<void> => {
    const projectId = scopeRef.current.projectId;
    draft.setAttachmentsRaw((current) => current.filter((attachment) => attachment.id !== attachmentId));
    draft.markDirty();
    if (!projectId) return;
    try {
      await (portsRef.current.attachments ?? defaultComposerAttachmentApi).remove(projectId, attachmentId);
    } catch (cause) {
      portsRef.current.onError(composerErrorMessage(cause));
    }
  }, []);

  const setAttachments = useCallback((next: TopicAttachment[] | ((current: TopicAttachment[]) => TopicAttachment[])): void => {
    draft.setAttachmentsRaw(next);
    draft.markDirty();
  }, [draft]);

  async function applySkillOverrides(identity: SkillRequestIdentity, overrides: Record<string, boolean>): Promise<void> {
    for (const [skillId, enabled] of Object.entries(overrides)) {
      await (portsRef.current.skills ?? defaultComposerSkillApi).setEnabled(identity, skillId, enabled);
    }
  }

  const invalidateRequests = useCallback((): void => {
    skillRequestGenerationRef.current += 1;
  }, []);

  const pendingUploads = useRef(0);

  return {
    hasPendingUploads: () => pendingUploads.current > 0,
    skillItems,
    activeSkillIds,
    enabledSkillCount: activeSkillIds.length,
    reloadSkills,
    toggleSkill,
    appendAttachments,
    removeAttachment,
    setAttachments,
    applySkillOverrides,
    invalidateRequests,
  };
}
