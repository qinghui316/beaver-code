import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";
import { materializeWorkbenchSchemaContract } from "../../src/workbench/persistence/schema-migrations.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Conversation Review schema compatibility", () => {
  it("migrates Schema 17 Turn rows and enforces Review mode isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "aho-review-schema-"));
    roots.push(root);
    const paths = resolveProjectRuntimePaths("review-schema-project", root);
    let store = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      seedConversation(store, "agent-conversation", "agent");
      seedConversation(store, "harness-conversation", "harness");
      store.providerAttempts.createProviderAttempt({
        projectId: paths.projectId,
        conversationId: "agent-conversation",
        attemptId: "legacy-attempt",
        productMode: "agent",
        agentTurnMode: "default",
        operationKind: "conversation-turn",
        graphScopeId: "agent-graph",
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        parentAgentSurfaceId: null,
        operationProfile: "agent",
        providerId: "codex",
        nativeSessionId: null,
        model: null,
        reasoningEffort: null,
        capabilitySnapshot: { providerId: "codex", effectiveModel: null } as never,
        effectiveSkillInputs: [],
        handoffHash: "legacy-handoff",
        deliveredThroughCompletedTurn: 0,
        worktreeId: null,
        status: "queued",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
      seedQueueItem(store, paths.projectId, "agent-conversation", "agent", "legacy-agent-item");
      seedQueueItem(store, paths.projectId, "harness-conversation", "harness", "legacy-harness-item");
    } finally {
      store.close();
    }

    const legacy = new Database(paths.workbenchDbPath);
    materializeWorkbenchSchemaContract(legacy, 17);
    legacy.close();

    store = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(store.providerAttempts.readProviderAttempt(paths.projectId, "legacy-attempt")).toMatchObject({
        operationKind: "conversation-turn",
        agentTurnMode: "default",
      });
      expect(store.conversationTurnQueues.readItem(paths.projectId, "agent-conversation", "legacy-agent-item")).toMatchObject({
        itemKind: "conversation-turn",
        reviewTargetJson: null,
      });
      expect(() => store.providerAttempts.createProviderAttempt({
        projectId: paths.projectId,
        conversationId: "harness-conversation",
        attemptId: "forged-harness-review",
        productMode: "harness",
        agentTurnMode: null,
        operationKind: "review",
        graphScopeId: "harness-graph",
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        parentAgentSurfaceId: null,
        operationProfile: "main",
        providerId: "codex",
        nativeSessionId: null,
        model: null,
        reasoningEffort: null,
        capabilitySnapshot: { providerId: "codex", effectiveModel: null } as never,
        effectiveSkillInputs: [],
        handoffHash: "forged-handoff",
        deliveredThroughCompletedTurn: 0,
        worktreeId: null,
        status: "queued",
        createdAt: "2026-09-01T00:00:01.000Z",
        updatedAt: "2026-09-01T00:00:01.000Z",
      })).toThrow(/agent_turn_mode must match product_mode/);
    } finally {
      store.close();
    }

    const verified = new Database(paths.workbenchDbPath);
    try {
      expect(verified.pragma("user_version", { simple: true })).toBe(WORKBENCH_SCHEMA_VERSION);
      expect(() => verified.prepare(`
        UPDATE conversation_turn_queue_items
        SET item_kind = 'review', review_target_json = '{"type":"uncommitted-changes"}'
        WHERE project_id = ? AND queue_item_id = ?
      `).run(paths.projectId, "legacy-harness-item")).toThrow(/fields must match product_mode/);
    } finally {
      verified.close();
    }
  });
});

function seedConversation(
  store: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  conversationId: string,
  productMode: "agent" | "harness",
): void {
  store.conversations.createConversation({
    projectId: "review-schema-project",
    conversationId,
    productMode,
    agentTurnMode: productMode === "agent" ? "default" : null,
    title: conversationId,
    state: "active",
    boundChangeId: null,
    currentGraphScopeId: `${productMode}-graph`,
    selectedProviderId: "codex",
    completedTurnSequence: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
  });
}

function seedQueueItem(
  store: Awaited<ReturnType<typeof openProjectRuntimeWorkbenchDatabase>>,
  projectId: string,
  conversationId: string,
  productMode: "agent" | "harness",
  queueItemId: string,
): void {
  const now = "2026-09-01T00:00:00.000Z";
  store.conversationTurnQueues.ensureQueue({ projectId, conversationId, productMode, updatedAt: now });
  store.conversationTurnQueues.insertItem({
    projectId,
    conversationId,
    productMode,
    queueItemId,
    clientRequestId: `${queueItemId}-client`,
    requestHash: `${queueItemId}-hash`,
    position: 1,
    status: "queued",
    retryCount: 0,
    predecessorExecutionRevision: "execution:legacy",
    dispatchRequestId: `${queueItemId}-dispatch`,
    itemKind: "conversation-turn",
    reviewTargetJson: null,
    text: "legacy turn",
    contextRefsJson: "[]",
    attachmentIdsJson: "[]",
    skillOverridesJson: "{}",
    providerId: "codex",
    agentTurnMode: productMode === "agent" ? "default" : null,
    agentModelId: null,
    agentReasoningEffort: null,
    diagnostic: null,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: null,
  });
}
