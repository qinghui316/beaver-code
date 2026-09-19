import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductMode } from "../../src/provider-runtime/index.js";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import type { ManagedProject } from "../../src/types/index.js";
import { ConversationLifecycleOwner } from "../../src/workbench/conversation-lifecycle.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { applyCurrentWorkbenchSchema, WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";
import { migrateWorkbenchSchema } from "../../src/workbench/persistence/schema-migrations.js";

const projectId = "conversation-lifecycle-project";
let root: string;
let paths: ProjectRuntimePaths;
let project: ManagedProject;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-conversation-lifecycle-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  paths = resolveProjectRuntimePaths(projectId, join(root, "aho-home"));
  project = {
    id: projectId,
    name: "Conversation Lifecycle",
    path: projectRoot,
    addedAt: "2026-08-31T00:00:00.000Z",
    lastSeenAt: "2026-08-31T00:00:00.000Z",
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("ConversationLifecycleOwner", () => {
  it("archives, restores, and permanently deletes an Agent Conversation with exact replay", async () => {
    await seedConversation("agent-conversation", "agent");
    await seedCompletedReviewOperation("agent-conversation", "review-before-delete");
    const setSessionArchived = vi.fn(async () => ({ status: "completed" as const }));
    const owner = createOwner(setSessionArchived);

    const archived = await owner.settle(project, request("agent-conversation", "agent", "archive", 0, "archive-1"));
    expect(archived).toMatchObject({
      status: "completed",
      providerSyncStatus: "completed",
      snapshot: { state: "archived", archiveOrigin: "agent-user", lifecycleRevision: "conversation-lifecycle:1" },
    });
    await expect(owner.settle(project, request("agent-conversation", "agent", "archive", 0, "archive-1")))
      .resolves.toMatchObject({ status: "replayed" });
    expect(setSessionArchived).toHaveBeenCalledTimes(1);

    await expect(owner.settle(project, request("agent-conversation", "agent", "restore", 1, "restore-1")))
      .resolves.toMatchObject({ snapshot: { state: "active", lifecycleRevision: "conversation-lifecycle:2" } });
    await owner.settle(project, request("agent-conversation", "agent", "archive", 2, "archive-2"));
    const confirmation = await owner.prepareDelete(project, "agent", "agent-conversation", "conversation-lifecycle:3");
    await expect(owner.settle(project, {
      ...request("agent-conversation", "agent", "delete", 3, "delete-1"),
      confirmationToken: confirmation.token,
    })).resolves.toMatchObject({ snapshot: null, providerSyncStatus: "completed" });
    await expect(owner.read(project, "agent", "agent-conversation")).rejects.toMatchObject({ name: "NotFound" });
    expect(setSessionArchived.mock.calls.map(([call]) => call.archived)).toEqual([true, false, true, true]);

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversations.readConversation(projectId, "agent-conversation", { includeDeleted: true }))
        .toMatchObject({ deletedAt: expect.any(String), state: "archive", archiveOrigin: "agent-user" });
      expect(database.timeline.listConversationMessages(projectId, "agent-conversation")).toEqual([]);
      expect(database.conversationReviews.read(projectId, "review-before-delete")).toBeNull();
      expect(database.conversationLifecycle.read(projectId, "delete-1")).toMatchObject({ status: "completed" });
    } finally {
      database.close();
    }
  });

  it("keeps uncertain Provider archive local and requires safe unarchive before restore", async () => {
    await seedConversation("uncertain-conversation", "agent");
    const uncertain = createOwner(vi.fn(async () => { throw new Error("connection lost after request write"); }));
    await expect(uncertain.settle(project, request("uncertain-conversation", "agent", "archive", 0, "archive-uncertain")))
      .resolves.toMatchObject({ providerSyncStatus: "uncertain", snapshot: { state: "archived" } });

    const unavailable = createOwner(vi.fn(), { archiveCapability: false });
    await expect(unavailable.settle(project, request("uncertain-conversation", "agent", "restore", 1, "restore-unavailable")))
      .rejects.toMatchObject({ name: "Conflict" });
    await expect(unavailable.read(project, "agent", "uncertain-conversation"))
      .resolves.toMatchObject({ state: "archived" });

    const unarchive = vi.fn(async () => ({ status: "completed" as const }));
    await expect(createOwner(unarchive).settle(project, request("uncertain-conversation", "agent", "restore", 1, "restore-safe")))
      .resolves.toMatchObject({ snapshot: { state: "active" } });
    expect(unarchive).toHaveBeenCalledWith(expect.objectContaining({ archived: false }));
  });

  it("reserves restore atomically across Owners before calling Provider unarchive", async () => {
    await seedConversation("restore-race", "agent");
    await createOwner(vi.fn(async () => ({ status: "completed" as const })))
      .settle(project, request("restore-race", "agent", "archive", 0, "archive-before-restore-race"));

    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const setSessionArchived = vi.fn(async () => {
      await providerGate;
      return { status: "completed" as const };
    });
    const first = createOwner(setSessionArchived).settle(
      project,
      request("restore-race", "agent", "restore", 1, "restore-race-first"),
    );
    await vi.waitFor(() => expect(setSessionArchived).toHaveBeenCalledTimes(1));

    await expect(createOwner(setSessionArchived).settle(
      project,
      request("restore-race", "agent", "restore", 1, "restore-race-second"),
    )).rejects.toMatchObject({ name: "Conflict" });
    expect(setSessionArchived).toHaveBeenCalledTimes(1);

    releaseProvider();
    await expect(first).resolves.toMatchObject({ snapshot: { state: "active" } });
  });

  it("rejects a Provider binding change before local or Provider lifecycle side effects", async () => {
    await seedConversation("binding-race", "agent");
    const setSessionArchived = vi.fn(async () => ({ status: "completed" as const }));
    const owner = createOwner(setSessionArchived, {
      onCapabilitySnapshot: async () => {
        const database = await openProjectRuntimeWorkbenchDatabase(paths);
        try {
          database.providerAttempts.writeConversationProviderBinding({
            projectId,
            conversationId: "binding-race",
            providerId: "codex",
            nativeSessionId: "replacement-private-session",
            lastDeliveredCompletedTurn: 0,
            preferredModel: null,
            lastUsedAt: "2026-08-31T00:00:01.000Z",
            bindingStatus: "ready",
          });
        } finally {
          database.close();
        }
      },
    });

    await expect(owner.settle(project, request("binding-race", "agent", "archive", 0, "archive-binding-race")))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(setSessionArchived).not.toHaveBeenCalled();
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversations.readConversation(projectId, "binding-race")).toMatchObject({ state: "active" });
      expect(database.conversationLifecycle.read(projectId, "archive-binding-race")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("does not expose Harness restore and preserves its governance identity on local deletion", async () => {
    await seedConversation("harness-conversation", "harness", { boundChangeId: "change-1" });
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.conversations.archiveBoundConversation(
        projectId,
        "harness-conversation",
        "change-1",
        "graph-harness-conversation",
        "2026-08-31T00:01:00.000Z",
      );
    } finally {
      database.close();
    }
    const setSessionArchived = vi.fn(async () => ({ status: "already-matched" as const }));
    const owner = createOwner(setSessionArchived);
    const snapshot = await owner.read(project, "harness", "harness-conversation");
    expect(snapshot).toMatchObject({ archiveOrigin: "harness-workflow", canRestore: false, canDelete: true });
    await expect(owner.settle(project, request("harness-conversation", "harness", "restore", 1, "restore-harness")))
      .rejects.toMatchObject({ name: "Conflict" });

    const confirmation = await owner.prepareDelete(project, "harness", "harness-conversation", snapshot.lifecycleRevision);
    await owner.settle(project, {
      ...request("harness-conversation", "harness", "delete", 1, "delete-harness"),
      confirmationToken: confirmation.token,
    });
    expect(setSessionArchived).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
    const inspected = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(inspected.conversations.readConversation(projectId, "harness-conversation", { includeDeleted: true }))
        .toMatchObject({ boundChangeId: "change-1", archiveOrigin: "harness-workflow", deletedAt: expect.any(String) });
      expect(inspected.providerAttempts.readConversationProviderBinding(projectId, "harness-conversation", "codex"))
        .toBeNull();
      expect(inspected.conversations.readConversationGraphScope(projectId, "graph-harness-conversation"))
        .toMatchObject({ graphScopeId: "graph-harness-conversation" });
    } finally {
      inspected.close();
    }
  });

  it("blocks an active runtime before lifecycle or Provider side effects", async () => {
    await seedConversation("running-conversation", "agent");
    const setSessionArchived = vi.fn();
    const owner = createOwner(setSessionArchived, { turnState: "running" });
    await expect(owner.settle(project, request("running-conversation", "agent", "archive", 0, "archive-running")))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(setSessionArchived).not.toHaveBeenCalled();
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversations.readConversation(projectId, "running-conversation")).toMatchObject({ state: "active" });
      expect(database.conversationLifecycle.read(projectId, "archive-running")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("atomically fences Provider Attempt creation against a pending lifecycle operation", async () => {
    await seedConversation("lifecycle-race", "agent");
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const now = "2026-08-31T00:01:30.000Z";
      database.conversationLifecycle.create({
        projectId,
        conversationId: "lifecycle-race",
        productMode: "agent",
        clientRequestId: "archive-race",
        requestHash: "archive-race-hash",
        action: "archive",
        expectedLifecycleRevision: 0,
        status: "pending",
        providerId: "codex",
        providerBindingHash: "opaque",
        providerSyncStatus: "submitting",
        diagnostic: null,
        createdAt: now,
        updatedAt: now,
      });
      expect(() => database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId: "lifecycle-race",
        attemptId: "attempt-after-lifecycle",
        productMode: "agent",
        agentTurnMode: "default",
        graphScopeId: "graph-lifecycle-race",
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        parentAgentSurfaceId: null,
        operationProfile: "agent",
        providerId: "codex",
        nativeSessionId: null,
        model: null,
        reasoningEffort: null,
        capabilitySnapshot: capabilitySnapshot(true),
        effectiveSkillInputs: [],
        handoffHash: "race-handoff",
        deliveredThroughCompletedTurn: 0,
        worktreeId: null,
        status: "running",
        createdAt: now,
        updatedAt: now,
      })).toThrowError(expect.objectContaining({ name: "Conflict" }));
      expect(database.providerAttempts.readProviderAttempt(projectId, "attempt-after-lifecycle")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("reconciles a locally committed archive with unproven Provider synchronization as uncertain", async () => {
    await seedConversation("restart-archive", "agent");
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const now = "2026-08-31T00:02:00.000Z";
      database.transaction(() => {
        database.conversationLifecycle.create({
          projectId,
          conversationId: "restart-archive",
          productMode: "agent",
          clientRequestId: "archive-before-restart",
          requestHash: "restart-request-hash",
          action: "archive",
          expectedLifecycleRevision: 0,
          status: "pending",
          providerId: "codex",
          providerBindingHash: "opaque-binding-hash",
          providerSyncStatus: "submitting",
          diagnostic: null,
          createdAt: now,
          updatedAt: now,
        });
        database.conversations.archiveAgentConversation(projectId, "restart-archive", 0, now);
      });
    } finally {
      database.close();
    }

    await expect(createOwner(vi.fn()).reconcileProject(paths)).resolves.toBe(1);
    const inspected = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(inspected.conversationLifecycle.read(projectId, "archive-before-restart"))
        .toMatchObject({ status: "completed", providerSyncStatus: "uncertain" });
    } finally {
      inspected.close();
    }
  });
});

describe("Schema 17 lifecycle migration", () => {
  it("backfills archive origin without reviving deleted Conversations", () => {
    const db = new Database(":memory:");
    applyCurrentWorkbenchSchema(db);
    db.exec(`
      ALTER TABLE conversations DROP COLUMN agent_access_mode;
      ALTER TABLE conversations DROP COLUMN agent_access_revision;
      ALTER TABLE conversation_turn_queue_items DROP COLUMN agent_access_mode;
      ALTER TABLE provider_attempts DROP COLUMN access_policy_json;
    `);
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>) {
      db.exec(`DROP TRIGGER IF EXISTS ${row.name}`);
    }
    db.exec(`
      DELETE FROM conversations;
      DROP TABLE conversation_review_operations;
      ALTER TABLE provider_attempts DROP COLUMN operation_kind;
      ALTER TABLE conversation_turn_queue_items DROP COLUMN review_target_json;
      ALTER TABLE conversation_turn_queue_items DROP COLUMN item_kind;
      DROP TABLE conversation_lifecycle_operations;
      ALTER TABLE conversations DROP COLUMN lifecycle_revision;
      ALTER TABLE conversations DROP COLUMN archived_at;
      ALTER TABLE conversations DROP COLUMN archive_origin;
      INSERT INTO conversations VALUES
        ('p', 'agent-archive', 'agent', 'default', NULL, NULL, NULL, NULL, 'Agent', 'archive', 'user', NULL, NULL, 'codex', 0, 0, 0, '2026-08-01', '2026-08-02', NULL),
        ('p', 'harness-archive', 'harness', NULL, NULL, NULL, NULL, NULL, 'Harness', 'archive', 'user', 'change-1', NULL, 'codex', 0, 0, 0, '2026-08-01', '2026-08-03', NULL),
        ('p', 'deleted', 'agent', 'default', NULL, NULL, NULL, NULL, 'Deleted', 'active', 'user', NULL, NULL, 'codex', 0, 0, 0, '2026-08-01', '2026-08-04', '2026-08-05');
      PRAGMA user_version = 16;
    `);
    migrateWorkbenchSchema(db, 16);
    expect(db.pragma("user_version", { simple: true })).toBe(WORKBENCH_SCHEMA_VERSION);
    expect(db.prepare("SELECT conversation_id, archive_origin, archived_at, lifecycle_revision, deleted_at FROM conversations ORDER BY conversation_id").all())
      .toEqual([
        { conversation_id: "agent-archive", archive_origin: "agent-user", archived_at: "2026-08-02", lifecycle_revision: 0, deleted_at: null },
        { conversation_id: "deleted", archive_origin: null, archived_at: null, lifecycle_revision: 0, deleted_at: "2026-08-05" },
        { conversation_id: "harness-archive", archive_origin: "harness-workflow", archived_at: "2026-08-03", lifecycle_revision: 0, deleted_at: null },
      ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_lifecycle_operations'").get())
      .toBeTruthy();
    db.close();
  });
});

function createOwner(
  setSessionArchived: (request: { archived: boolean }) => Promise<{ status: "completed" | "already-matched" }>,
  options: {
    archiveCapability?: boolean;
    turnState?: "idle" | "running" | "stopping";
    onCapabilitySnapshot?: () => Promise<void>;
  } = {},
): ConversationLifecycleOwner {
  return new ConversationLifecycleOwner({
    providerRegistry: {
      get: () => ({
        capabilitySnapshot: async () => {
          await options.onCapabilitySnapshot?.();
          return capabilitySnapshot(options.archiveCapability ?? true);
        },
        conversation: { setSessionArchived },
      }),
      findActiveTurn: () => null,
    } as never,
    projectRuntimeCoordinator: { resolve: async () => ({ state: "onboarding", paths }) } as never,
    turnControl: { state: () => ({ state: options.turnState ?? "idle", canStop: false, explanation: "idle" }) } as never,
  });
}

async function seedConversation(
  conversationId: string,
  productMode: ProductMode,
  options: { boundChangeId?: string } = {},
): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const now = "2026-08-31T00:00:00.000Z";
    const graphScopeId = `graph-${conversationId}`;
    database.conversations.createConversation({
      projectId,
      conversationId,
      productMode,
      agentTurnMode: productMode === "agent" ? "default" : null,
      title: conversationId,
      state: "active",
      boundChangeId: options.boundChangeId ?? null,
      currentGraphScopeId: graphScopeId,
      selectedProviderId: "codex",
      completedTurnSequence: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    database.conversations.initializeConversationGraphScope(projectId, conversationId, graphScopeId, now);
    database.providerAttempts.writeConversationProviderBinding({
      projectId,
      conversationId,
      providerId: "codex",
      nativeSessionId: `private-${conversationId}`,
      lastDeliveredCompletedTurn: 0,
      preferredModel: null,
      lastUsedAt: now,
      bindingStatus: "ready",
    });
  } finally {
    database.close();
  }
}

async function seedCompletedReviewOperation(conversationId: string, clientRequestId: string): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const now = "2026-08-31T00:00:00.000Z";
    const attemptId = `attempt-${clientRequestId}`;
    database.providerAttempts.createProviderAttempt({
      projectId,
      conversationId,
      attemptId,
      productMode: "agent",
      agentTurnMode: null,
      operationKind: "review",
      graphScopeId: `graph-${conversationId}`,
      changeId: null,
      agentTaskId: null,
      roleId: "main-agent",
      operationProfile: "agent",
      providerId: "codex",
      nativeSessionId: `session-${conversationId}`,
      model: null,
      reasoningEffort: null,
      capabilitySnapshot: capabilitySnapshot(true),
      effectiveSkillInputs: [],
      handoffHash: `handoff-${clientRequestId}`,
      deliveredThroughCompletedTurn: 0,
      worktreeId: null,
      status: "completed",
      createdAt: now,
      updatedAt: now,
    });
    database.conversationReviews.create({
      projectId,
      conversationId,
      graphScopeId: `graph-${conversationId}`,
      clientRequestId,
      requestHash: `hash-${clientRequestId}`,
      providerId: "codex",
      reviewTargetJson: JSON.stringify({ type: "uncommitted-changes" }),
      gitAdmissionJson: JSON.stringify({}),
      attemptId,
      status: "completed",
      sessionBindingHash: null,
      turnIdentityHash: null,
      source: "direct",
      diagnostic: null,
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    database.close();
  }
}

function request(
  conversationId: string,
  productMode: ProductMode,
  action: "archive" | "restore" | "delete",
  revision: number,
  clientRequestId: string,
) {
  return {
    projectId,
    productMode,
    conversationId,
    action,
    expectedLifecycleRevision: `conversation-lifecycle:${revision}`,
    clientRequestId,
    confirmationToken: null,
  };
}

function capabilitySnapshot(archiveReady: boolean) {
  return {
    providerId: "codex",
    displayName: "Codex",
    productMode: "agent" as const,
    status: "ready" as const,
    runnable: true,
    checkedAt: "2026-08-31T00:00:00.000Z",
    snapshotHash: "lifecycle-capability",
    snapshotVersion: 1,
    effectiveModel: "gpt-test",
    effectiveModelSource: "provider-default" as const,
    degradedReasons: [],
    capabilities: archiveReady ? [{
      key: "session.archive" as const,
      label: "Session archive",
      spec: "supported" as const,
      runtime: "ready" as const,
      summary: "ready",
    }] : [],
  };
}
