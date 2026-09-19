import type { TopicAttachment, WorkbenchLiveEvent } from "../types.js";
import type { ComposerDraftCheckpoint, ComposerDraftContent } from "./ComposerDraftSyncOwner.js";
import type {
  ComposerCreateConversationRequest,
  ComposerCreatedConversation,
  ComposerMessageRequest,
  ConversationSubmissionPorts,
  ConversationSubmissionScope,
  ConversationSubmissionSkillIdentity,
  DraftSubmissionSnapshot,
} from "./conversation-submission-contract.js";

export type PendingSubmissionState = "sending" | "uncertain" | "failed";

export interface PendingConversationSubmission {
  kind: "create" | "message";
  snapshot: DraftSubmissionSnapshot;
  attachments: TopicAttachment[];
  attachmentFiles: File[];
  acceptedDraft: ComposerDraftContent | null;
  acceptedDraftMutationToken: string | null;
  draftCheckpoint: ComposerDraftCheckpoint;
  skillIdentity: ConversationSubmissionSkillIdentity;
  state: PendingSubmissionState;
}

export interface CreateConversationSubmissionInput {
  snapshot: DraftSubmissionSnapshot;
  attachments: TopicAttachment[];
  attachmentFiles: File[];
  acceptedDraft: ComposerDraftContent;
  acceptedDraftMutationToken?: string | null;
  isCurrent(created?: ComposerCreatedConversation): boolean;
  onPending(): void;
  onAccepted(created: ComposerCreatedConversation): Promise<void>;
}

export interface MessageSubmissionInput {
  snapshot: DraftSubmissionSnapshot;
  attachments: TopicAttachment[];
  acceptedDraft: ComposerDraftContent | null;
  acceptedDraftMutationToken?: string | null;
  skillIdentity: ConversationSubmissionSkillIdentity;
  providerSwitchIntent?: "resume-workflow";
  isCurrent(): boolean;
  acceptsEvent(event: WorkbenchLiveEvent): boolean;
  onPending(): void;
  onAccepted(): void;
}

export interface RetrySubmissionInput {
  matchesCurrent(submission: PendingConversationSubmission): boolean;
  selectedConversationProviderId: string | null;
  isCurrent(snapshot: DraftSubmissionSnapshot, created?: ComposerCreatedConversation): boolean;
  acceptsEvent(snapshot: DraftSubmissionSnapshot, event: WorkbenchLiveEvent): boolean;
  onAccepted(submission: PendingConversationSubmission, created?: ComposerCreatedConversation): void | Promise<void>;
}

export class ConversationTurnSubmissionController {
  private readonly submissions = new Map<string, PendingConversationSubmission>();

  constructor(private readonly ports: ConversationSubmissionPorts) {}

  async submitCreate(input: CreateConversationSubmissionInput): Promise<ComposerCreatedConversation | null> {
    let pendingScope = pendingScopeFor(input.snapshot);
    let snapshot = cloneSnapshot(input.snapshot);
    const draftCheckpoint = this.ports.drafts.checkpoint(snapshot.projectId, snapshot.productMode);
    this.begin({
      kind: "create",
      snapshot,
      attachments: input.attachments,
      attachmentFiles: input.attachmentFiles,
      acceptedDraft: input.acceptedDraft,
      acceptedDraftMutationToken: input.acceptedDraftMutationToken ?? null,
      draftCheckpoint,
      skillIdentity: skillIdentityFromSnapshot(snapshot),
    });
    this.showPending(pendingScope, snapshot);
    input.onPending();
    this.ports.session.beginPendingConversation?.({
      id: pendingScope.conversationId,
      projectId: snapshot.projectId,
      productMode: snapshot.productMode,
      clientRequestId: snapshot.clientRequestId,
      title: "新需求",
      body: snapshot.text,
      selectedProviderId: snapshot.providerId ?? undefined,
    });

    try {
      const draftRevision = await this.ports.drafts.flush(snapshot.projectId, snapshot.productMode);
      snapshot = { ...snapshot, draftRevision };
      this.updateSnapshot(snapshot.clientRequestId, snapshot);
    } catch (cause) {
      this.markFailure(pendingScope, snapshot.clientRequestId, cause, false, input.isCurrent());
      return null;
    }

    const token = this.ports.operation.begin("topic.create");
    let uploadedDraft: TopicAttachment[] = [];
    let uploadProjectId: string | null = null;
    let created: ComposerCreatedConversation | null = null;
    let transportStarted = false;
    try {
      this.ports.onError(null);
      const effectiveProjectId = await this.ports.session.ensureProjectRegistered(snapshot.projectId);
      if (!effectiveProjectId) {
        const message = "项目暂时无法打开，请检查后重试。";
        this.fail(snapshot.clientRequestId, "failed");
        this.ports.timeline.markPending?.(pendingScope, snapshot.clientRequestId, "failed", message);
        if (input.isCurrent()) this.ports.onError(message);
        return null;
      }
      if (effectiveProjectId !== pendingScope.projectId) {
        const nextScope = { ...pendingScope, projectId: effectiveProjectId };
        this.ports.timeline.rekeyPending?.(pendingScope, nextScope, snapshot.clientRequestId);
        pendingScope = nextScope;
      }
      snapshot = { ...snapshot, projectId: effectiveProjectId };
      this.updateSnapshot(snapshot.clientRequestId, snapshot);
      uploadProjectId = effectiveProjectId;
      uploadedDraft = await this.uploadFiles(effectiveProjectId, input.attachmentFiles);
      snapshot = {
        ...snapshot,
        attachmentIds: [...snapshot.attachmentIds, ...uploadedDraft.map((attachment) => attachment.id)],
      };
      this.updateSnapshot(snapshot.clientRequestId, snapshot);
      transportStarted = true;
      created = await this.ports.session.createConversation(createRequest(snapshot));
      uploadedDraft = [];
      this.settle(snapshot.clientRequestId);
      await this.ports.drafts.settleAccepted(
        input.acceptedDraft,
        draftCheckpoint,
        input.acceptedDraftMutationToken ?? null,
      );
      if (input.isCurrent(created)) {
        await input.onAccepted(created);
        if (input.isCurrent(created)) {
          await this.ports.projection.refreshConversation(created.projectId, created.conversationId);
        }
      }
      return created;
    } catch (cause) {
      if (uploadedDraft.length > 0) {
        snapshot = { ...snapshot, attachmentIds: [...input.snapshot.attachmentIds] };
        this.updateSnapshot(snapshot.clientRequestId, snapshot);
      }
      this.markFailure(pendingScope, snapshot.clientRequestId, cause, transportStarted, input.isCurrent(created ?? undefined));
      throw cause;
    } finally {
      await this.removeTemporaryUploads(uploadProjectId, uploadedDraft);
      if (created && input.isCurrent(created)) {
        await this.calibrate(created.projectId, created.conversationId, () => input.isCurrent(created!));
      }
      this.ports.operation.release(token);
    }
  }

  async submitMessage(input: MessageSubmissionInput): Promise<void> {
    const snapshot = cloneSnapshot(input.snapshot);
    const pendingScope = pendingScopeFor(snapshot);
    const draftCheckpoint = this.ports.drafts.checkpoint(snapshot.projectId, snapshot.productMode);
    this.begin({
      kind: "message",
      snapshot,
      attachments: input.attachments,
      attachmentFiles: [],
      acceptedDraft: input.acceptedDraft,
      acceptedDraftMutationToken: input.acceptedDraftMutationToken ?? null,
      draftCheckpoint,
      skillIdentity: input.skillIdentity,
    });
    this.showPending(pendingScope, snapshot);
    input.onPending();

    try {
      const draftRevision = await this.ports.drafts.flush(snapshot.projectId, snapshot.productMode);
      this.updateSnapshot(snapshot.clientRequestId, { ...snapshot, draftRevision });
    } catch (cause) {
      this.markFailure(pendingScope, snapshot.clientRequestId, cause, false, input.isCurrent());
      return;
    }

    const token = this.ports.operation.begin("chat.ask");
    let transportStarted = false;
    try {
      await this.ports.skills.apply(input.skillIdentity, snapshot.skillOverrides);
      if (Object.keys(snapshot.skillOverrides).length > 0) await this.ports.skills.reload(input.skillIdentity);
      const request = messageRequest(snapshot, input.providerSwitchIntent);
      transportStarted = true;
      await this.ports.transport.sendMessage(request, (projectId, event) => {
        if (input.isCurrent() && input.acceptsEvent(event)) this.ports.projection.routeEvent?.(projectId, event);
      });
      this.settle(snapshot.clientRequestId);
      if (input.acceptedDraft) {
        await this.ports.drafts.settleAccepted(
          input.acceptedDraft,
          draftCheckpoint,
          input.acceptedDraftMutationToken ?? null,
        );
      }
      if (input.isCurrent()) input.onAccepted();
    } catch (cause) {
      this.markFailure(pendingScope, snapshot.clientRequestId, cause, transportStarted, input.isCurrent());
      throw cause;
    } finally {
      if (input.isCurrent()) await this.calibrate(snapshot.projectId, snapshot.conversationId!, input.isCurrent);
      this.ports.operation.release(token);
    }
  }

  async retryPendingIntent(clientRequestId: string, input: RetrySubmissionInput): Promise<void> {
    const retryable = this.inspect(clientRequestId);
    if (!retryable || retryable.state !== "failed") return;
    if (!input.matchesCurrent(retryable)) {
      this.ports.onError("这条消息不属于当前会话，请切回原会话后重试。");
      return;
    }
    const nextClientRequestId = this.ports.ids.createClientRequestId();
    this.consume(clientRequestId, retryable);
    const submission = cloneSubmission({
      ...retryable,
      state: "sending",
      snapshot: { ...retryable.snapshot, clientRequestId: nextClientRequestId },
    });
    this.submissions.set(nextClientRequestId, cloneSubmission(submission));

    let snapshot = submission.snapshot;
    let pendingScope = pendingScopeFor(snapshot);
    this.showPending(pendingScope, snapshot);
    if (submission.kind === "create") {
      this.ports.session.beginPendingConversation?.({
        id: pendingScope.conversationId,
        projectId: snapshot.projectId,
        productMode: snapshot.productMode,
        clientRequestId: nextClientRequestId,
        title: "新需求",
        body: snapshot.text,
        selectedProviderId: snapshot.providerId ?? undefined,
      });
    }

    const token = this.ports.operation.begin(submission.kind === "create" ? "topic.create.retry" : "chat.ask.retry");
    let uploadedDraft: TopicAttachment[] = [];
    let uploadProjectId: string | null = null;
    let transportStarted = false;
    try {
      this.ports.onError(null);
      if (submission.kind === "create") {
        const effectiveProjectId = await this.ports.session.ensureProjectRegistered(snapshot.projectId);
        if (!effectiveProjectId) throw new Error("项目暂时无法打开，请检查后重试。");
        if (effectiveProjectId !== pendingScope.projectId) {
          const nextScope = { ...pendingScope, projectId: effectiveProjectId };
          this.ports.timeline.rekeyPending?.(pendingScope, nextScope, nextClientRequestId);
          pendingScope = nextScope;
        }
        snapshot = { ...snapshot, projectId: effectiveProjectId };
        this.updateSnapshot(nextClientRequestId, snapshot);
        uploadProjectId = effectiveProjectId;
        uploadedDraft = await this.uploadFiles(effectiveProjectId, submission.attachmentFiles);
        snapshot = {
          ...snapshot,
          attachmentIds: [...snapshot.attachmentIds, ...uploadedDraft.map((attachment) => attachment.id)],
        };
        this.updateSnapshot(nextClientRequestId, snapshot);
        transportStarted = true;
        const created = await this.ports.session.createConversation(createRequest(snapshot));
        uploadedDraft = [];
        this.settle(nextClientRequestId);
        if (submission.acceptedDraft) {
          await this.ports.drafts.settleAccepted(
            submission.acceptedDraft,
            submission.draftCheckpoint,
            submission.acceptedDraftMutationToken ?? null,
          );
        }
        if (input.isCurrent(snapshot, created)) {
          await input.onAccepted(submission, created);
          await this.ports.projection.refreshConversation(created.projectId, created.conversationId);
          await this.calibrate(created.projectId, created.conversationId, () => input.isCurrent(snapshot, created));
        }
        return;
      }

      if (!snapshot.conversationId) throw new Error("无法确认原会话，请放回输入框后重新发送。");
      await this.ports.skills.apply(submission.skillIdentity, snapshot.skillOverrides);
      const providerSwitchIntent = snapshot.providerId && snapshot.providerId !== input.selectedConversationProviderId
        ? "resume-workflow" as const
        : undefined;
      transportStarted = true;
      await this.ports.transport.sendMessage(messageRequest(snapshot, providerSwitchIntent), (projectId, event) => {
        if (input.isCurrent(snapshot) && input.acceptsEvent(snapshot, event)) {
          this.ports.projection.routeEvent?.(projectId, event);
        }
      });
      this.settle(nextClientRequestId);
      if (submission.acceptedDraft) {
        await this.ports.drafts.settleAccepted(
          submission.acceptedDraft,
          submission.draftCheckpoint,
          submission.acceptedDraftMutationToken ?? null,
        );
      }
      if (input.isCurrent(snapshot)) {
        await input.onAccepted(submission);
        await this.calibrate(snapshot.projectId, snapshot.conversationId, () => input.isCurrent(snapshot));
      }
    } catch (cause) {
      if (uploadedDraft.length > 0) {
        snapshot = { ...snapshot, attachmentIds: [...submission.snapshot.attachmentIds] };
        this.updateSnapshot(nextClientRequestId, snapshot);
      }
      this.markFailure(
        pendingScope,
        nextClientRequestId,
        cause,
        transportStarted,
        input.isCurrent(snapshot),
      );
    } finally {
      await this.removeTemporaryUploads(uploadProjectId, uploadedDraft);
      this.ports.operation.release(token);
    }
  }

  inspect(clientRequestId: string): PendingConversationSubmission | null {
    const current = this.submissions.get(clientRequestId);
    return current && current.state !== "sending" ? cloneSubmission(current) : null;
  }

  restore(clientRequestId: string): PendingConversationSubmission | null {
    const current = this.inspect(clientRequestId);
    if (!current) return null;
    this.consume(clientRequestId, current);
    return current;
  }

  private begin(input: Omit<PendingConversationSubmission, "state">): void {
    const submission = cloneSubmission({ ...input, state: "sending" });
    this.submissions.set(submission.snapshot.clientRequestId, submission);
  }

  private updateSnapshot(clientRequestId: string, snapshot: DraftSubmissionSnapshot): void {
    const current = this.submissions.get(clientRequestId);
    if (current) this.submissions.set(clientRequestId, cloneSubmission({ ...current, snapshot }));
  }

  private settle(clientRequestId: string): void {
    this.submissions.delete(clientRequestId);
  }

  private fail(clientRequestId: string, state: Exclude<PendingSubmissionState, "sending">): PendingConversationSubmission | null {
    const current = this.submissions.get(clientRequestId);
    if (!current) return null;
    const failed = cloneSubmission({ ...current, state });
    this.submissions.set(clientRequestId, failed);
    return cloneSubmission(failed);
  }

  private consume(clientRequestId: string, submission: PendingConversationSubmission): void {
    this.submissions.delete(clientRequestId);
    this.ports.timeline.consumePending?.(pendingScopeFor(submission.snapshot), clientRequestId);
  }

  private showPending(scope: ConversationSubmissionScope, snapshot: DraftSubmissionSnapshot): void {
    this.ports.timeline.showPending?.(scope, snapshot.clientRequestId, snapshot.text);
  }

  private markFailure(
    scope: ConversationSubmissionScope,
    clientRequestId: string,
    cause: unknown,
    transportStarted: boolean,
    showError = true,
  ): void {
    const failureState = this.ports.errors.classify(cause, transportStarted);
    const message = this.ports.errors.describe(cause);
    this.fail(clientRequestId, failureState);
    this.ports.timeline.markPending?.(scope, clientRequestId, failureState, message);
    if (showError) this.ports.onError(message);
  }

  private async uploadFiles(projectId: string, files: readonly File[]): Promise<TopicAttachment[]> {
    const uploaded: TopicAttachment[] = [];
    try {
      for (const file of files) {
        uploaded.push(await this.ports.attachments.upload(projectId, {
          fileName: file.name,
          mediaType: file.type || "application/octet-stream",
          data: await readFileAsDataUrl(file),
        }));
      }
      return uploaded;
    } catch (cause) {
      await this.removeTemporaryUploads(projectId, uploaded);
      throw cause;
    }
  }

  private async removeTemporaryUploads(projectId: string | null, attachments: readonly TopicAttachment[]): Promise<void> {
    if (!projectId || attachments.length === 0) return;
    await Promise.allSettled(attachments.map((attachment) => this.ports.attachments.remove(projectId, attachment.id)));
  }

  private async calibrate(projectId: string, conversationId: string, stillCurrent: () => boolean): Promise<void> {
    try {
      await this.ports.timeline.calibrate(projectId, conversationId, "main-agent");
    } catch (cause) {
      if (stillCurrent()) this.ports.onError(this.ports.errors.describe(cause));
    }
  }
}

function createRequest(snapshot: DraftSubmissionSnapshot): ComposerCreateConversationRequest {
  return {
    projectId: snapshot.projectId,
    productMode: snapshot.productMode,
    clientRequestId: snapshot.clientRequestId,
    body: snapshot.text,
    contextRefs: snapshot.contextRefs,
    attachmentIds: snapshot.attachmentIds,
    providerId: snapshot.providerId ?? undefined,
    skillOverrides: normalizeSkillOverrides(snapshot.skillOverrides),
    agentAccessMode: snapshot.productMode === "agent" ? snapshot.agentAccessMode : undefined,
    agentTurnMode: snapshot.productMode === "agent" ? snapshot.agentTurnMode ?? undefined : undefined,
    modelId: snapshot.modelId,
    reasoningEffort: snapshot.reasoningEffort,
    showPendingBeforeCreate: true,
  };
}

function skillIdentityFromSnapshot(snapshot: DraftSubmissionSnapshot): ConversationSubmissionSkillIdentity {
  return {
    projectId: snapshot.projectId,
    productMode: snapshot.productMode,
    conversationId: snapshot.conversationId,
    providerId: snapshot.providerId,
  };
}

function messageRequest(snapshot: DraftSubmissionSnapshot, providerSwitchIntent?: "resume-workflow"): ComposerMessageRequest {
  if (!snapshot.conversationId) throw new Error("无法确认原会话，请放回输入框后重新发送。");
  return {
    clientRequestId: snapshot.clientRequestId,
    projectId: snapshot.projectId,
    productMode: snapshot.productMode,
    conversationId: snapshot.conversationId,
    message: snapshot.text,
    contextRefs: snapshot.contextRefs,
    attachmentIds: snapshot.attachmentIds,
    providerId: snapshot.providerId ?? undefined,
    providerSwitchIntent,
    agentAccessMode: snapshot.productMode === "agent" ? snapshot.agentAccessMode : undefined,
    expectedAccessRevision: snapshot.productMode === "agent" ? snapshot.expectedAccessRevision : undefined,
    agentTurnMode: snapshot.productMode === "agent" ? snapshot.agentTurnMode ?? undefined : undefined,
    modelId: snapshot.modelId,
    reasoningEffort: snapshot.reasoningEffort,
  };
}

function normalizeSkillOverrides(overrides: Record<string, boolean>) {
  return Object.entries(overrides)
    .map(([skillId, enabled]) => ({ skillId: skillId.trim(), enabled }))
    .filter((override) => override.skillId.length > 0)
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
}

function pendingScopeFor(snapshot: DraftSubmissionSnapshot): ConversationSubmissionScope {
  return {
    projectId: snapshot.projectId,
    productMode: snapshot.productMode,
    conversationId: snapshot.conversationId ?? `pending:${snapshot.clientRequestId}`,
  };
}

function cloneSnapshot(snapshot: DraftSubmissionSnapshot): DraftSubmissionSnapshot {
  return {
    ...snapshot,
    contextRefs: snapshot.contextRefs.map((reference) => ({ ...reference })),
    attachmentIds: [...snapshot.attachmentIds],
    skillOverrides: { ...snapshot.skillOverrides },
  };
}

function cloneSubmission(submission: PendingConversationSubmission): PendingConversationSubmission {
  return {
    ...submission,
    snapshot: cloneSnapshot(submission.snapshot),
    attachments: submission.attachments.map((attachment) => ({ ...attachment })),
    attachmentFiles: [...submission.attachmentFiles],
    acceptedDraft: submission.acceptedDraft ? cloneDraftContent(submission.acceptedDraft) : null,
    acceptedDraftMutationToken: submission.acceptedDraftMutationToken,
    draftCheckpoint: { ...submission.draftCheckpoint },
    skillIdentity: { ...submission.skillIdentity },
  };
}

function cloneDraftContent(content: ComposerDraftContent): ComposerDraftContent {
  return {
    ...content,
    contextRefs: content.contextRefs.map((reference) => ({ ...reference })),
    attachmentIds: [...content.attachmentIds],
    skillOverrides: { ...content.skillOverrides },
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment."));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Attachment reader did not return a data URL."));
    reader.readAsDataURL(file);
  });
}
