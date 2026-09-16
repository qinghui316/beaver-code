import type { AgentTurnMode, TopicAttachment, TopicFileReference } from "../types.js";
import type {
  ComposerDraftSettlementGuard,
  ConversationDraftSettlementIdentity,
} from "./conversation-draft-settlement-contract.js";
import type { DraftSubmissionSnapshot } from "./conversation-submission-contract.js";

type StateUpdater<T> = (current: T) => T;

export interface ConversationDraftViewModel {
  text: string;
  contextRefs: TopicFileReference[];
  attachments: TopicAttachment[];
  skillOverrides: Record<string, boolean>;
  agentTurnMode: AgentTurnMode;
  modelId: string | null;
  reasoningEffort: string | null;
  /** Opaque, Renderer-local settlement identity. It is never persisted as canonical evidence. */
  mutationToken?: string;
}

export interface ConversationDraftStatePort {
  read(): ConversationDraftViewModel;
  setText(update: StateUpdater<string>): void;
  setContextRefs(update: StateUpdater<TopicFileReference[]>): void;
  setAttachments(update: StateUpdater<TopicAttachment[]>): void;
  setSkillOverrides(update: StateUpdater<Record<string, boolean>>): void;
  setAgentTurnMode(value: AgentTurnMode): void;
  setModelId(value: string | null): void;
  setReasoningEffort(value: string | null): void;
  markDirty(): void;
}

export interface ClearAcceptedDraftOptions {
  text?: boolean;
  contextRefs?: boolean;
  attachments?: boolean;
  skillOverrides?: boolean;
}

export interface RestoreSubmissionOptions {
  restoreSkillOverrides?: boolean;
  restoreConfiguration?: boolean;
}

/**
 * Owns in-memory draft reads and value-bound settlement. Persistence and CAS remain owned by
 * ComposerDraftSyncOwner; this owner never performs network or canonical Timeline writes.
 */
export class ConversationDraftController {
  private static nextInstanceId = 0;
  private readonly instanceId = `draft-${++ConversationDraftController.nextInstanceId}`;
  private mutationRevision = 0;
  private textMutationRevision = 0;
  private readonly contextMutationRevisions = new Map<string, number>();
  private readonly attachmentMutationRevisions = new Map<string, number>();
  private readonly skillMutationRevisions = new Map<string, number>();

  constructor(private readonly port: ConversationDraftStatePort) {}

  read(): ConversationDraftViewModel {
    return { ...cloneDraft(this.port.read()), mutationToken: `${this.instanceId}:${this.mutationRevision}` };
  }

  updateText(text: string): void {
    if (this.port.read().text === text) return;
    this.textMutationRevision = this.nextMutationRevision();
    this.port.setText(() => text);
    this.port.markDirty();
  }

  updateContextRefs(update: StateUpdater<TopicFileReference[]>): void {
    const current = this.port.read().contextRefs;
    const next = update(current).map((reference) => ({ ...reference }));
    this.recordIdentityMutations(current, next, referenceIdentity, this.contextMutationRevisions);
    this.port.setContextRefs(() => next);
  }

  updateAttachments(update: StateUpdater<TopicAttachment[]>): void {
    const current = this.port.read().attachments;
    const next = update(current).map((attachment) => ({ ...attachment }));
    this.recordIdentityMutations(current, next, (attachment) => attachment.id, this.attachmentMutationRevisions);
    this.port.setAttachments(() => next);
  }

  updateSkillOverrides(update: StateUpdater<Record<string, boolean>>): void {
    const current = this.port.read().skillOverrides;
    const next = { ...update(current) };
    const changed = new Set([...Object.keys(current), ...Object.keys(next)]);
    const revision = this.mutationRevision + 1;
    let mutated = false;
    for (const skillId of changed) {
      if (current[skillId] === next[skillId] && Object.hasOwn(current, skillId) === Object.hasOwn(next, skillId)) continue;
      this.skillMutationRevisions.set(skillId, revision);
      mutated = true;
    }
    if (mutated) this.mutationRevision = revision;
    this.port.setSkillOverrides(() => next);
  }

  updateConfiguration(input: {
    agentTurnMode: AgentTurnMode;
    modelId: string | null;
    reasoningEffort: string | null;
  }): void {
    this.port.setAgentTurnMode(input.agentTurnMode);
    this.port.setModelId(input.modelId);
    this.port.setReasoningEffort(input.reasoningEffort);
    this.port.markDirty();
  }

  clearAcceptedSnapshot(
    snapshot: ConversationDraftViewModel,
    options: ClearAcceptedDraftOptions = { text: true, contextRefs: true, attachments: true, skillOverrides: true },
  ): void {
    const checkpointRevision = this.checkpointRevision(snapshot);
    if (options.text) {
      this.port.setText((current) => current === snapshot.text && this.textMutationRevision <= checkpointRevision ? "" : current);
    }
    if (options.contextRefs) {
      this.port.setContextRefs((current) => removeAcceptedReferences(
        current,
        snapshot.contextRefs,
        (identity) => (this.contextMutationRevisions.get(identity) ?? 0) <= checkpointRevision,
      ));
    }
    if (options.attachments) {
      this.port.setAttachments((current) => removeAcceptedAttachments(
        current,
        snapshot.attachments,
        (identity) => (this.attachmentMutationRevisions.get(identity) ?? 0) <= checkpointRevision,
      ));
    }
    if (options.skillOverrides) {
      this.port.setSkillOverrides((current) => removeAcceptedOverrides(
        current,
        snapshot.skillOverrides,
        (identity) => (this.skillMutationRevisions.get(identity) ?? 0) <= checkpointRevision,
      ));
    }
  }

  settlementGuard(
    mutationToken: string | null | undefined,
    accepted: ConversationDraftSettlementIdentity,
  ): ComposerDraftSettlementGuard {
    const checkpointRevision = this.checkpointRevisionFromToken(mutationToken);
    return {
      preserveText: this.textMutationRevision > checkpointRevision,
      preserveContextRefIdentities: accepted.contextRefs
        .map(referenceIdentity)
        .filter((identity) => (this.contextMutationRevisions.get(identity) ?? 0) > checkpointRevision),
      preserveAttachmentIds: accepted.attachmentIds
        .filter((identity) => (this.attachmentMutationRevisions.get(identity) ?? 0) > checkpointRevision),
      preserveSkillIds: Object.keys(accepted.skillOverrides)
        .filter((identity) => (this.skillMutationRevisions.get(identity) ?? 0) > checkpointRevision),
    };
  }

  restore(
    snapshot: DraftSubmissionSnapshot,
    attachments: readonly TopicAttachment[],
    options: RestoreSubmissionOptions = {},
  ): void {
    const current = this.port.read();
    const currentDraftIsEmpty = !current.text.trim()
      && current.contextRefs.length === 0
      && current.attachments.length === 0
      && Object.keys(current.skillOverrides).length === 0;
    this.port.setText((value) => mergeRestoredText(value, snapshot.text));
    this.port.setContextRefs((value) => mergeReferences(value, snapshot.contextRefs));
    this.port.setAttachments((value) => mergeAttachments(value, attachments));
    if (options.restoreSkillOverrides) {
      this.port.setSkillOverrides((value) => ({ ...snapshot.skillOverrides, ...value }));
    }
    if (options.restoreConfiguration && currentDraftIsEmpty) {
      if (snapshot.productMode === "agent") this.port.setAgentTurnMode(snapshot.agentTurnMode ?? "default");
      this.port.setModelId(snapshot.modelId);
      this.port.setReasoningEffort(snapshot.reasoningEffort);
    }
    this.port.markDirty();
  }

  private nextMutationRevision(): number {
    this.mutationRevision += 1;
    return this.mutationRevision;
  }

  private checkpointRevision(snapshot: ConversationDraftViewModel): number {
    return this.checkpointRevisionFromToken(snapshot.mutationToken);
  }

  private checkpointRevisionFromToken(mutationToken: string | null | undefined): number {
    const prefix = `${this.instanceId}:`;
    if (!mutationToken?.startsWith(prefix)) return this.mutationRevision;
    const revision = Number.parseInt(mutationToken.slice(prefix.length), 10);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : this.mutationRevision;
  }

  private recordIdentityMutations<T>(
    current: readonly T[],
    next: readonly T[],
    identityOf: (item: T) => string,
    revisions: Map<string, number>,
  ): void {
    const currentIds = new Set(current.map(identityOf));
    const nextIds = new Set(next.map(identityOf));
    const identities = new Set([...currentIds, ...nextIds]);
    const changed = [...identities].filter((identity) => currentIds.has(identity) !== nextIds.has(identity));
    if (changed.length === 0) return;
    const revision = this.nextMutationRevision();
    for (const identity of changed) revisions.set(identity, revision);
  }
}

function cloneDraft(draft: ConversationDraftViewModel): ConversationDraftViewModel {
  return {
    ...draft,
    contextRefs: draft.contextRefs.map((reference) => ({ ...reference })),
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
    skillOverrides: { ...draft.skillOverrides },
  };
}

function mergeRestoredText(current: string, restored: string): string {
  const existing = current.trimEnd();
  const recovered = restored.trim();
  if (!existing) return recovered;
  if (!recovered) return current;
  return `${existing}\n\n${recovered}`;
}

function mergeReferences(
  current: readonly TopicFileReference[],
  next: readonly TopicFileReference[],
): TopicFileReference[] {
  const seen = new Set<string>();
  const result: TopicFileReference[] = [];
  for (const reference of [...current, ...next]) {
    const normalized = { ...reference, source: "composer" as const };
    const key = `${normalized.kind}:${normalized.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function mergeAttachments(
  current: readonly TopicAttachment[],
  next: readonly TopicAttachment[],
): TopicAttachment[] {
  const seen = new Set(current.map((attachment) => attachment.id));
  return [...current.map((attachment) => ({ ...attachment })), ...next.flatMap((attachment) => {
    if (seen.has(attachment.id)) return [];
    seen.add(attachment.id);
    return [{ ...attachment }];
  })];
}

function removeAcceptedReferences(
  current: readonly TopicFileReference[],
  accepted: readonly TopicFileReference[],
  mayRemove: (identity: string) => boolean = () => true,
): TopicFileReference[] {
  const acceptedKeys = new Set(accepted.map(referenceIdentity));
  return current
    .filter((reference) => {
      const identity = referenceIdentity(reference);
      return !acceptedKeys.has(identity) || !mayRemove(identity);
    })
    .map((reference) => ({ ...reference }));
}

function referenceIdentity(reference: TopicFileReference): string {
  return `${reference.kind}:${reference.relativePath}`;
}

function removeAcceptedAttachments(
  current: readonly TopicAttachment[],
  accepted: readonly TopicAttachment[],
  mayRemove: (identity: string) => boolean = () => true,
): TopicAttachment[] {
  const acceptedIds = new Set(accepted.map((attachment) => attachment.id));
  return current
    .filter((attachment) => !acceptedIds.has(attachment.id) || !mayRemove(attachment.id))
    .map((attachment) => ({ ...attachment }));
}

function removeAcceptedOverrides(
  current: Readonly<Record<string, boolean>>,
  accepted: Readonly<Record<string, boolean>>,
  mayRemove: (identity: string) => boolean = () => true,
): Record<string, boolean> {
  const next = { ...current };
  for (const [skillId, acceptedValue] of Object.entries(accepted)) {
    if (next[skillId] === acceptedValue && mayRemove(skillId)) delete next[skillId];
  }
  return next;
}
