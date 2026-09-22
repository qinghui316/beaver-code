import { createHash, randomUUID } from "node:crypto";
import type { ProductMode, ProviderId } from "../provider-runtime/index.js";
import type { ProviderRegistry } from "../provider-runtime/registry.js";
import type { ProjectRuntimeCoordinatorPort } from "../project-runtime/coordinator.js";
import type { ProjectRuntimePaths } from "../project-runtime/paths.js";
import type { ManagedProject } from "../types/index.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type {
  StoredConversation,
  StoredConversationLifecycleAction,
  StoredConversationLifecycleOperation,
  StoredConversationProviderSyncStatus,
} from "./persistence/contracts.js";
import { publishConversationLifecycleInvalidated, publishConversationLifecycleSyncUpdated } from "./project-live-events.js";
import type { ConversationTurnControlOwner } from "./conversation-turn-control.js";
import { deleteUnreferencedTopicAttachments } from "./attachments.js";

export type ConversationLifecycleAction = StoredConversationLifecycleAction;
export type ConversationArchiveOrigin = "agent-user" | "harness-workflow" | null;

export interface ConversationLifecycleSnapshot {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  state: "active" | "archived";
  archiveOrigin: ConversationArchiveOrigin;
  lifecycleRevision: string;
  updatedAt: string;
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
  activity: "running" | "awaiting-input" | null;
  disabledReason?: string;
}

export interface ConversationLifecycleRequest {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  action: ConversationLifecycleAction;
  expectedLifecycleRevision: string;
  clientRequestId: string;
  confirmationToken?: string | null;
}

export interface ConversationLifecycleReceipt {
  status: "completed" | "replayed";
  action: ConversationLifecycleAction;
  conversationId: string;
  snapshot: ConversationLifecycleSnapshot | null;
  providerSyncStatus: StoredConversationProviderSyncStatus;
  diagnostic?: string;
}

export interface ConversationDeleteConfirmation {
  token: string;
  expiresAt: string;
  conversationId: string;
  lifecycleRevision: string;
  effect: string;
}

type Confirmation = {
  projectId: string;
  productMode: ProductMode;
  conversationId: string;
  lifecycleRevision: number;
  expiresAt: number;
};

export class ConversationLifecycleOwner {
  private readonly confirmations = new Map<string, Confirmation>();
  private readonly submissions = new Map<string, { requestHash: string; promise: Promise<ConversationLifecycleReceipt> }>();
  private readonly archiveSyncTasks = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    providerRegistry: ProviderRegistry;
    projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve">;
    turnControl: ConversationTurnControlOwner;
  }) {}

  async read(project: ManagedProject, productMode: ProductMode, conversationId: string): Promise<ConversationLifecycleSnapshot> {
    const paths = await this.resolvePaths(project);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, conversationId);
      if (!conversation || conversation.productMode !== productMode) throw notFound("Conversation not found.");
      return this.snapshot(database, conversation);
    } finally {
      database.close();
    }
  }

  async readMany(project: ManagedProject, productMode: ProductMode): Promise<ConversationLifecycleSnapshot[]> {
    const paths = await this.resolvePaths(project);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      return await Promise.all(database.conversations.listConversations(paths.projectId, productMode)
        .map((conversation) => this.snapshot(database, conversation)));
    } finally {
      database.close();
    }
  }

  async prepareDelete(
    project: ManagedProject,
    productMode: ProductMode,
    conversationId: string,
    expectedLifecycleRevision: string,
  ): Promise<ConversationDeleteConfirmation> {
    const paths = await this.resolvePaths(project);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = requireConversation(database, paths.projectId, productMode, conversationId);
      const revision = parseRevision(expectedLifecycleRevision);
      if (conversation.lifecycleRevision !== revision) throw conflict("Conversation lifecycle revision is stale.");
      if (conversation.state !== "archive") throw conflict("Only an archived Conversation can be permanently deleted.");
      const blocker = lifecycleBlocker(database, conversation, this.options);
      if (blocker) throw conflict(blocker.reason);
      const token = randomUUID();
      const expiresAt = Date.now() + 5 * 60_000;
      this.confirmations.set(token, { projectId: paths.projectId, productMode, conversationId, lifecycleRevision: revision, expiresAt });
      return {
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        conversationId,
        lifecycleRevision: revisionToken(revision),
        effect: productMode === "harness"
          ? "删除本地会话展示数据，但保留 Harness Change 和治理证据。"
          : "删除本地会话历史，并要求 Provider 保持会话归档；项目文件不会改变。",
      };
    } finally {
      database.close();
    }
  }

  async settle(project: ManagedProject, request: ConversationLifecycleRequest): Promise<ConversationLifecycleReceipt> {
    const normalized = normalizeRequest(request);
    if (normalized.projectId !== project.id) throw conflict("Conversation lifecycle project identity does not match.");
    const requestHash = stableHash(normalized);
    const key = `${normalized.projectId}\0${normalized.clientRequestId}`;
    const active = this.submissions.get(key);
    if (active) {
      if (active.requestHash !== requestHash) throw conflict("Conversation lifecycle request id is bound to another request.");
      return active.promise;
    }
    const promise = this.submit(project, normalized, requestHash).finally(() => this.submissions.delete(key));
    this.submissions.set(key, { requestHash, promise });
    return promise;
  }

  async reconcileProject(paths: ProjectRuntimePaths): Promise<number> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      let changed = 0;
      const now = new Date().toISOString();
      for (const operation of database.conversationLifecycle.listIncomplete(paths.projectId)) {
        const conversation = database.conversations.readConversation(paths.projectId, operation.conversationId, { includeDeleted: true });
        const localCompleted = operation.action === "archive"
          ? conversation?.state === "archive"
          : operation.action === "delete"
            ? Boolean(conversation?.deletedAt)
            : conversation?.state === "active";
        database.conversationLifecycle.transition({
          projectId: paths.projectId,
          clientRequestId: operation.clientRequestId,
          expectedStatus: operation.status,
          status: localCompleted ? "completed" : "interrupted",
          providerSyncStatus: operation.providerSyncStatus === "submitting" ? "uncertain" : operation.providerSyncStatus,
          diagnostic: localCompleted
            ? "Local lifecycle state was recovered; prior Provider synchronization outcome remains uncertain."
            : "Lifecycle operation was interrupted because no exact live Provider proof survived restart.",
          updatedAt: now,
        });
        changed += 1;
      }
      return changed;
    } finally {
      database.close();
    }
  }

  private async submit(
    project: ManagedProject,
    request: ConversationLifecycleRequest & { expectedLifecycleRevision: string },
    requestHash: string,
  ): Promise<ConversationLifecycleReceipt> {
    const paths = await this.resolvePaths(project);
    const revision = parseRevision(request.expectedLifecycleRevision);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    let conversation: StoredConversation;
    let operation: StoredConversationLifecycleOperation;
    let shouldSync = false;
    let sessionId: string | null = null;
    let providerId: ProviderId | null = null;
    let capabilityDiagnostic: string | null = null;
    let attachmentIds: string[] = [];
    let cleanupDiagnostic: string | undefined;
    let localArchiveReceipt: ConversationLifecycleReceipt | null = null;
    try {
      const replay = database.conversationLifecycle.read(paths.projectId, request.clientRequestId);
      if (replay) {
        if (replay.requestHash !== requestHash) throw conflict("Conversation lifecycle request id is bound to another request.");
        const current = database.conversations.readConversation(paths.projectId, request.conversationId);
        if ((replay.status === "pending" || replay.status === "submitting")
          && !(replay.action === "archive" && current?.state === "archive")) {
          throw uncertain("Conversation lifecycle outcome is uncertain and cannot be resent automatically.");
        }
        return receipt(replay, current ? await this.snapshot(database, current) : null, true);
      }
      conversation = requireConversation(database, paths.projectId, request.productMode, request.conversationId);
      if (conversation.lifecycleRevision !== revision) throw conflict("Conversation lifecycle revision is stale.");
      assertActionAllowed(conversation, request.action);
      const blocker = lifecycleBlocker(database, conversation, this.options);
      if (blocker) throw conflict(blocker.reason);
      const priorLifecycle = database.conversationLifecycle.readLatest(paths.projectId, conversation.conversationId);
      providerId = conversation.selectedProviderId;
      const binding = providerId
        ? database.providerAttempts.readConversationProviderBinding(paths.projectId, conversation.conversationId, providerId)
        : null;
      sessionId = binding?.nativeSessionId ?? null;
      if (providerId && sessionId && request.action !== "archive") {
        try {
          const capability = await this.options.providerRegistry.get(providerId)
            .capabilitySnapshot(project, request.productMode, project.path);
          shouldSync = capability.capabilities.some((item) => item.key === "session.archive" && item.runtime === "ready");
        } catch {
          capabilityDiagnostic = "Provider session lifecycle capability could not be verified; local state remains authoritative.";
        }
        const refreshedBinding = database.providerAttempts.readConversationProviderBinding(
          paths.projectId,
          conversation.conversationId,
          providerId,
        );
        if (refreshedBinding?.nativeSessionId !== sessionId) {
          throw conflict("Provider session binding changed during lifecycle admission.");
        }
      }
      if (request.action === "restore" && priorLifecycle?.action === "archive"
        && (priorLifecycle.providerSyncStatus === "completed" || priorLifecycle.providerSyncStatus === "uncertain")) {
        if (!providerId || !sessionId || priorLifecycle.providerBindingHash !== bindingHash(providerId, sessionId)) {
          throw conflict("Provider session binding changed after archive; the Conversation remains archived.");
        }
        if (!shouldSync) {
          throw conflict("Provider session may still be archived and cannot be safely restored until unarchive is available.");
        }
      }
      const finalBlocker = lifecycleBlocker(database, conversation, this.options);
      if (finalBlocker) throw conflict(finalBlocker.reason);
      if (request.action === "delete") this.consumeConfirmation(request, revision);
      operation = {
        projectId: paths.projectId,
        conversationId: conversation.conversationId,
        productMode: conversation.productMode,
        clientRequestId: request.clientRequestId,
        requestHash,
        action: request.action,
        expectedLifecycleRevision: revision,
        status: request.action === "archive" && !sessionId ? "completed" : "pending",
        providerId,
        providerBindingHash: sessionId ? bindingHash(providerId!, sessionId) : null,
        providerSyncStatus: sessionId
          ? (request.action === "archive" || shouldSync ? "submitting" : "unsupported")
          : "not-required",
        diagnostic: capabilityDiagnostic,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (request.action === "archive") {
        database.immediateTransaction(() => {
          conversation = requireConversation(database, paths.projectId, request.productMode, request.conversationId);
          if (conversation.lifecycleRevision !== revision) throw conflict("Conversation lifecycle revision is stale.");
          assertActionAllowed(conversation, request.action);
          const transactionalBlocker = lifecycleBlocker(database, conversation, this.options);
          if (transactionalBlocker) throw conflict(transactionalBlocker.reason);
          database.conversationLifecycle.create(operation);
          conversation = database.conversations.archiveAgentConversation(paths.projectId, conversation.conversationId, revision, operation.createdAt);
        });
        const syncPending = Boolean(sessionId);
        localArchiveReceipt = receipt(operation, {
          projectId: paths.projectId,
          productMode: conversation.productMode,
          conversationId: conversation.conversationId,
          state: "archived",
          archiveOrigin: conversation.archiveOrigin,
          lifecycleRevision: revisionToken(conversation.lifecycleRevision),
          updatedAt: conversation.updatedAt,
          canArchive: false,
          canRestore: !syncPending,
          canDelete: !syncPending,
          activity: null,
          ...(syncPending ? { disabledReason: "会话归档同步仍在处理。" } : {}),
        }, false);
      } else if (request.action === "delete") {
        attachmentIds = attachmentIdsForConversation(database, paths.projectId, conversation.conversationId);
        database.immediateTransaction(() => {
          conversation = requireConversation(database, paths.projectId, request.productMode, request.conversationId);
          if (conversation.lifecycleRevision !== revision) throw conflict("Conversation lifecycle revision is stale.");
          assertActionAllowed(conversation, request.action);
          const transactionalBlocker = lifecycleBlocker(database, conversation, this.options);
          if (transactionalBlocker) throw conflict(transactionalBlocker.reason);
          database.conversationLifecycle.create(operation);
          database.unitOfWork.deleteArchivedConversation({
            projectId: paths.projectId,
            conversationId: conversation.conversationId,
            productMode: conversation.productMode,
            expectedLifecycleRevision: revision,
            deletedAt: operation.createdAt,
          });
        });
      } else {
        database.immediateTransaction(() => {
          conversation = requireConversation(database, paths.projectId, request.productMode, request.conversationId);
          if (conversation.lifecycleRevision !== revision) throw conflict("Conversation lifecycle revision is stale.");
          assertActionAllowed(conversation, request.action);
          const transactionalBlocker = lifecycleBlocker(database, conversation, this.options);
          if (transactionalBlocker) throw conflict(transactionalBlocker.reason);
          database.conversationLifecycle.create(operation);
        });
      }
    } finally {
      database.close();
    }

    if (request.action === "archive") {
      try { publishConversationLifecycleInvalidated(paths.projectId, {
        conversationId: request.conversationId,
        productMode: request.productMode,
        state: "archived",
        lifecycleRevision: localArchiveReceipt!.snapshot!.lifecycleRevision,
      }); }
      catch (error) { process.emitWarning(`Conversation archive event delivery failed: ${String(error)}`); }
      if (providerId && sessionId) this.scheduleArchiveSync(paths, project, operation!, providerId, sessionId);
      return localArchiveReceipt!;
    }

    if (request.action === "delete" && attachmentIds.length > 0) {
      try {
        await deleteUnreferencedTopicAttachments(project, attachmentIds, paths);
      } catch {
        cleanupDiagnostic = "Unreferenced managed attachment cleanup could not be completed.";
      }
    }

    if (request.action === "restore") {
      if (shouldSync && providerId && sessionId) {
        await this.syncProvider(paths, project, operation!, providerId, sessionId, false, true);
      }
      const restoreDatabase = await openProjectRuntimeWorkbenchDatabase(paths);
      try {
        const restoredAt = new Date().toISOString();
        restoreDatabase.transaction(() => {
          restoreDatabase.conversations.restoreAgentConversation(paths.projectId, request.conversationId, revision, restoredAt);
          restoreDatabase.conversationLifecycle.transition({
            projectId: paths.projectId, clientRequestId: request.clientRequestId,
            expectedStatus: shouldSync ? "submitting" : "pending", status: "completed",
            providerSyncStatus: sessionId ? shouldSync ? "completed" : "unsupported" : "not-required",
            diagnostic: capabilityDiagnostic,
            updatedAt: restoredAt,
          });
        });
        const current = restoreDatabase.conversations.readConversation(paths.projectId, request.conversationId)!;
        publishConversationLifecycleInvalidated(paths.projectId, {
          conversationId: request.conversationId,
          productMode: request.productMode,
          state: "active",
          lifecycleRevision: revisionToken(current.lifecycleRevision),
        });
        return receipt(restoreDatabase.conversationLifecycle.read(paths.projectId, request.clientRequestId)!, await this.snapshot(restoreDatabase, current), false);
      } finally {
        restoreDatabase.close();
      }
    }

    let providerSyncStatus: StoredConversationProviderSyncStatus = sessionId ? shouldSync ? "submitting" : "unsupported" : "not-required";
    let diagnostic: string | undefined = cleanupDiagnostic;
    if (shouldSync && providerId && sessionId) {
      const sync = await this.syncProvider(
        paths,
        project,
        operation!,
        providerId,
        sessionId,
        true,
        false,
        request.action !== "delete",
      );
      providerSyncStatus = sync.status;
      diagnostic = [cleanupDiagnostic, sync.diagnostic].filter(Boolean).join(" ") || undefined;
    }
    const finishDatabase = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const completed = finishDatabase.conversationLifecycle.transition({
        projectId: paths.projectId,
        clientRequestId: request.clientRequestId,
        expectedStatus: shouldSync ? "submitting" : "pending",
        status: "completed",
        providerSyncStatus,
        diagnostic: diagnostic ?? capabilityDiagnostic,
        updatedAt: new Date().toISOString(),
      });
      const current = finishDatabase.conversations.readConversation(paths.projectId, request.conversationId);
      publishConversationLifecycleInvalidated(paths.projectId, {
        conversationId: request.conversationId,
        productMode: request.productMode,
        state: "deleted",
        lifecycleRevision: revisionToken(revision + 1),
      });
      return receipt(completed, current ? await this.snapshot(finishDatabase, current) : null, false);
    } finally {
      finishDatabase.close();
    }
  }

  private scheduleArchiveSync(
    paths: ProjectRuntimePaths,
    project: ManagedProject,
    operation: StoredConversationLifecycleOperation,
    providerId: ProviderId,
    sessionId: string,
  ): void {
    const key = `${paths.projectId}\0${operation.clientRequestId}`;
    if (this.archiveSyncTasks.has(key)) return;
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.finishArchiveSync(paths, project, operation, providerId, sessionId))
      .catch(async (error: unknown) => {
        process.emitWarning(`Conversation archive sync status could not be persisted for ${operation.clientRequestId}: ${String(error)}`);
        try {
          const database = await openProjectRuntimeWorkbenchDatabase(paths);
          try {
            const current = database.conversationLifecycle.read(paths.projectId, operation.clientRequestId);
            if (current && (current.status === "pending" || current.status === "submitting")) {
              database.conversationLifecycle.transition({
                projectId: paths.projectId, clientRequestId: operation.clientRequestId,
                expectedStatus: current.status, status: "completed", providerSyncStatus: "uncertain",
                diagnostic: "Provider archive synchronization stopped unexpectedly; the outcome is uncertain.",
                updatedAt: new Date().toISOString(),
              });
              publishConversationLifecycleSyncUpdated(paths.projectId, {
                conversationId: operation.conversationId, productMode: operation.productMode,
                providerSyncStatus: "uncertain",
              });
            }
          } finally { database.close(); }
        } catch (persistenceError) {
          process.emitWarning(`Conversation archive sync recovery is deferred until startup: ${String(persistenceError)}`);
        }
      })
      .finally(() => { this.archiveSyncTasks.delete(key); });
    this.archiveSyncTasks.set(key, task);
  }

  private async finishArchiveSync(
    paths: ProjectRuntimePaths,
    project: ManagedProject,
    operation: StoredConversationLifecycleOperation,
    providerId: ProviderId,
    sessionId: string,
  ): Promise<void> {
    let result: { status: StoredConversationProviderSyncStatus; diagnostic?: string } | null = null;
    let capabilityState: "ready" | "unsupported" | "unavailable" = "unavailable";
    try {
      const capability = await this.options.providerRegistry.get(providerId)
        .capabilitySnapshot(project, operation.productMode, project.path);
      const archiveCapability = capability.capabilities.find((item) => item.key === "session.archive");
      capabilityState = archiveCapability?.spec === "unsupported" ? "unsupported"
        : archiveCapability?.spec === "supported" && archiveCapability.runtime === "ready" ? "ready" : "unavailable";
    } catch (error) {
      result = {
        status: "failed",
        diagnostic: `Provider archive capability could not be checked: ${error instanceof Error ? error.name : "unknown error"}.`,
      };
    }
    if (result === null) {
      if (capabilityState === "unsupported") result = { status: "unsupported" };
      else if (capabilityState === "unavailable") result = {
        status: "failed", diagnostic: "Provider archive capability is temporarily unavailable.",
      };
      else {
        try {
          result = await this.syncProvider(paths, project, operation, providerId, sessionId, true, false);
        } catch (error) {
          result = {
            status: "uncertain",
            diagnostic: `Provider archive synchronization outcome is uncertain: ${error instanceof Error ? error.name : "unknown error"}.`,
          };
        }
      }
    }
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const current = database.conversationLifecycle.read(paths.projectId, operation.clientRequestId);
      if (!current || (current.status !== "pending" && current.status !== "submitting")) return;
      database.conversationLifecycle.transition({
        projectId: paths.projectId,
        clientRequestId: operation.clientRequestId,
        expectedStatus: current.status,
        status: "completed",
        providerSyncStatus: result.status,
        diagnostic: result.diagnostic,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      database.close();
    }
    publishConversationLifecycleSyncUpdated(paths.projectId, {
      conversationId: operation.conversationId,
      productMode: operation.productMode,
      providerSyncStatus: result.status,
    });
  }

  private async syncProvider(
    paths: ProjectRuntimePaths,
    project: ManagedProject,
    operation: StoredConversationLifecycleOperation,
    providerId: ProviderId,
    sessionId: string,
    archived: boolean,
    failRestore: boolean,
    verifyCurrentBinding = true,
  ): Promise<{ status: StoredConversationProviderSyncStatus; diagnostic?: string }> {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.conversationLifecycle.transition({
        projectId: paths.projectId, clientRequestId: operation.clientRequestId,
        expectedStatus: "pending", status: "submitting", providerSyncStatus: "submitting",
        updatedAt: new Date().toISOString(),
      });
      const currentBinding = verifyCurrentBinding
        ? database.providerAttempts.readConversationProviderBinding(
            paths.projectId,
            operation.conversationId,
            providerId,
          )
        : null;
      if (verifyCurrentBinding && (!currentBinding?.nativeSessionId
        || bindingHash(providerId, currentBinding.nativeSessionId) !== operation.providerBindingHash)) {
        const diagnostic = "Provider session binding changed before lifecycle synchronization.";
        if (failRestore) {
          database.conversationLifecycle.transition({
            projectId: paths.projectId,
            clientRequestId: operation.clientRequestId,
            expectedStatus: "submitting",
            status: "failed",
            providerSyncStatus: "failed",
            diagnostic,
            updatedAt: new Date().toISOString(),
          });
          throw conflict(diagnostic);
        }
        return { status: "failed", diagnostic };
      }
    } finally {
      database.close();
    }
    try {
      await this.options.providerRegistry.get(providerId).conversation.setSessionArchived({
        providerId, projectId: paths.projectId, cwd: project.path,
        session: { providerId, sessionId }, archived,
      });
      return { status: "completed" };
    } catch (error) {
      const explicit = error instanceof Error && error.name === "ProviderSessionArchiveRejected";
      const status: StoredConversationProviderSyncStatus = explicit ? "failed" : "uncertain";
      const diagnostic = explicit
        ? "Provider explicitly rejected session lifecycle synchronization."
        : "Provider session lifecycle transport outcome is uncertain; the request was not replayed.";
      if (failRestore) {
        const failureDatabase = await openProjectRuntimeWorkbenchDatabase(paths);
        try {
          failureDatabase.conversationLifecycle.transition({
            projectId: paths.projectId, clientRequestId: operation.clientRequestId,
            expectedStatus: "submitting", status: explicit ? "failed" : "submitting",
            providerSyncStatus: status, diagnostic, updatedAt: new Date().toISOString(),
          });
        } finally {
          failureDatabase.close();
        }
        throw explicit ? conflict(diagnostic) : uncertain(diagnostic, error);
      }
      return { status, diagnostic };
    }
  }

  private async snapshot(
    database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
    conversation: StoredConversation,
  ): Promise<ConversationLifecycleSnapshot> {
    const blocker = lifecycleBlocker(database, conversation, this.options);
    const active = conversation.state === "active";
    return {
      projectId: conversation.projectId,
      productMode: conversation.productMode,
      conversationId: conversation.conversationId,
      state: active ? "active" : "archived",
      archiveOrigin: conversation.archiveOrigin,
      lifecycleRevision: revisionToken(conversation.lifecycleRevision),
      updatedAt: conversation.updatedAt,
      canArchive: active && conversation.productMode === "agent" && !blocker,
      canRestore: !active && conversation.productMode === "agent" && conversation.archiveOrigin === "agent-user" && !blocker,
      canDelete: !active && !blocker,
      activity: blocker?.activity ?? null,
      ...(blocker ? { disabledReason: blocker.reason } : {}),
    };
  }

  private consumeConfirmation(request: ConversationLifecycleRequest, revision: number): void {
    const token = request.confirmationToken ?? "";
    const confirmation = this.confirmations.get(token);
    this.confirmations.delete(token);
    if (!confirmation || confirmation.expiresAt < Date.now()
      || confirmation.projectId !== request.projectId
      || confirmation.productMode !== request.productMode
      || confirmation.conversationId !== request.conversationId
      || confirmation.lifecycleRevision !== revision) {
      throw conflict("Conversation delete confirmation is missing, expired, or stale.");
    }
  }

  private async resolvePaths(project: ManagedProject): Promise<ProjectRuntimePaths> {
    const runtime = await this.options.projectRuntimeCoordinator.resolve(project);
    return runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
  }
}

function requireConversation(
  database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  projectId: string,
  productMode: ProductMode,
  conversationId: string,
): StoredConversation {
  const conversation = database.conversations.readConversation(projectId, conversationId);
  if (!conversation || conversation.productMode !== productMode) throw notFound("Conversation not found.");
  return conversation;
}

function attachmentIdsForConversation(
  database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  projectId: string,
  conversationId: string,
): string[] {
  const ids = new Set<string>();
  for (const row of database.timeline.listConversationMessages(projectId, conversationId)) {
    try {
      const raw = JSON.parse(row.rawJson) as { attachments?: Array<{ id?: string }> };
      for (const attachment of raw.attachments ?? []) if (typeof attachment.id === "string") ids.add(attachment.id);
    } catch {
      return [];
    }
  }
  return [...ids];
}

function lifecycleBlocker(
  database: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  conversation: StoredConversation,
  options: { providerRegistry: ProviderRegistry; turnControl: ConversationTurnControlOwner },
): { reason: string; activity: ConversationLifecycleSnapshot["activity"] } | null {
  const { compacting, awaitingInput } = database.timeline.inspectLifecycleInteractionState(
    conversation.projectId, conversation.conversationId,
  );
  const pendingActivity = awaitingInput ? "awaiting-input" as const : null;
  if (options.turnControl.state(conversation.projectId, conversation.conversationId).state !== "idle"
    || options.providerRegistry.findActiveTurn(conversation.conversationId)) {
    return { reason: "当前会话仍在运行、停止或实时引导中。", activity: pendingActivity ?? "running" };
  }
  if (database.providerAttempts.listProviderAttempts(conversation.projectId, conversation.conversationId)
    .some((attempt) => attempt.status === "queued" || attempt.status === "running")) {
    return { reason: "当前会话仍有运行中的 Provider Attempt。", activity: pendingActivity ?? "running" };
  }
  if (database.conversationTurnQueues.listItems(conversation.projectId, conversation.conversationId)
    .some((item) => item.status === "queued" || item.status === "dispatching" || item.status === "blocked")) {
    return { reason: "请先处理待发送队列，再归档或删除会话。", activity: pendingActivity };
  }
  if (database.conversationForks.listIncomplete(conversation.projectId)
    .some((operation) => operation.sourceConversationId === conversation.conversationId)) {
    return { reason: "会话分叉仍在处理。", activity: pendingActivity };
  }
  if (database.conversationLifecycle.hasIncomplete(conversation.projectId, conversation.conversationId)) {
    return { reason: "另一个会话生命周期操作仍在处理。", activity: pendingActivity };
  }
  if (compacting) return { reason: "上下文压缩仍在处理。", activity: pendingActivity };
  if (awaitingInput) return { reason: "当前会话仍在等待用户输入、审批或确认。", activity: "awaiting-input" };
  return null;
}

function assertActionAllowed(conversation: StoredConversation, action: ConversationLifecycleAction): void {
  if (action === "archive") {
    if (conversation.productMode !== "agent") throw conflict("Harness Conversations are archived only by Harness workflow authority.");
    if (conversation.state !== "active") throw conflict("Only an active Agent Conversation can be archived.");
    return;
  }
  if (action === "restore") {
    if (conversation.productMode !== "agent" || conversation.state !== "archive" || conversation.archiveOrigin !== "agent-user") {
      throw conflict("Only a user-archived Agent Conversation can be restored.");
    }
    return;
  }
  if (conversation.state !== "archive") throw conflict("Only an archived Conversation can be permanently deleted.");
}

function normalizeRequest(request: ConversationLifecycleRequest): ConversationLifecycleRequest & { expectedLifecycleRevision: string } {
  if (!request.projectId.trim() || !request.conversationId.trim() || !request.clientRequestId.trim()) {
    throw conflict("Conversation lifecycle identity is incomplete.");
  }
  parseRevision(request.expectedLifecycleRevision);
  return {
    ...request,
    projectId: request.projectId.trim(),
    conversationId: request.conversationId.trim(),
    clientRequestId: request.clientRequestId.trim(),
    expectedLifecycleRevision: request.expectedLifecycleRevision.trim(),
  };
}

function stableHash(request: ConversationLifecycleRequest): string {
  return createHash("sha256").update(JSON.stringify({
    projectId: request.projectId,
    productMode: request.productMode,
    conversationId: request.conversationId,
    action: request.action,
    expectedLifecycleRevision: request.expectedLifecycleRevision,
  })).digest("hex");
}

function bindingHash(providerId: ProviderId, sessionId: string): string {
  return createHash("sha256").update(`${providerId}\0${sessionId}`).digest("hex");
}

function revisionToken(revision: number): string {
  return `conversation-lifecycle:${revision}`;
}

function parseRevision(value: string): number {
  const match = /^conversation-lifecycle:(\d+)$/.exec(value.trim());
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < 0) throw conflict("Conversation lifecycle revision is invalid.");
  return revision;
}

function receipt(
  operation: StoredConversationLifecycleOperation,
  snapshot: ConversationLifecycleSnapshot | null,
  replayed: boolean,
): ConversationLifecycleReceipt {
  return {
    status: replayed ? "replayed" : "completed",
    action: operation.action,
    conversationId: operation.conversationId,
    snapshot,
    providerSyncStatus: operation.providerSyncStatus,
    ...(operation.diagnostic ? { diagnostic: operation.diagnostic } : {}),
  };
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFound";
  return error;
}

function uncertain(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "ProviderTransportUncertain";
  return error;
}
