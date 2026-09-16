import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStoredExecutionContract, type ProviderCapabilitySnapshot } from "../../src/provider-runtime/index.js";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { WorkbenchDatabase } from "../../src/workbench/persistence/database.js";
import type { StoredTopicMessageWrite } from "../../src/workbench/persistence/contracts.js";
import { applyCurrentWorkbenchSchema, WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";
import { materializeWorkbenchSchemaContract } from "../../src/workbench/persistence/schema-migrations.js";

let root: string;
const projectId = "persistence-owner";
const now = "2026-07-17T00:00:00.000Z";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-persistence-owner-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Workbench persistence owners", () => {
  it("materializes a preselected Conversation graph scope without superseding it", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      const createdAt = "2026-08-29T00:00:00.000Z";
      database.conversations.createConversation({
        projectId,
        conversationId: "conversation-preselected-scope",
        productMode: "harness",
        agentTurnMode: null,
        agentModelId: null,
        agentReasoningEffort: null,
        title: "Preselected scope",
        state: "active",
        boundChangeId: null,
        currentGraphScopeId: "graph-preselected",
        selectedProviderId: "codex",
        completedTurnSequence: 0,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      });

      expect(database.conversations.readConversationGraphScope(projectId, "graph-preselected")).toBeNull();
      expect(database.unitOfWork.startConversationGraphScope(
        projectId,
        "conversation-preselected-scope",
        "graph-preselected",
        createdAt,
      )).toEqual([]);
      expect(database.conversations.readConversationGraphScope(projectId, "graph-preselected")).toMatchObject({
        conversationId: "conversation-preselected-scope",
        graphScopeId: "graph-preselected",
        status: "active",
      });
    } finally {
      database.close();
    }
  });

  it("persists shared model selection in Composer drafts while rejecting Harness turn-mode leakage", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      expect(database.drafts.readDraft(projectId, "agent")).toBeNull();
      const first = database.drafts.upsertDraft({
        projectId,
        productMode: "agent",
        agentTurnMode: "plan",
        text: "recover this",
        contextRefsJson: JSON.stringify([{ relativePath: "src/app.ts", name: "app.ts", kind: "file" }]),
        attachmentIdsJson: JSON.stringify(["attachment-1"]),
        skillOverridesJson: JSON.stringify({ reviewer: true }),
        selectedProviderId: "codex",
        updatedAt: now,
      }, null);
      expect(first).toMatchObject({
        projectId,
        productMode: "agent",
        agentTurnMode: "plan",
        text: "recover this",
        selectedProviderId: "codex",
      });
      expect(() => database.drafts.upsertDraft({
        ...first,
        contextRefsJson: first.contextRefsJson,
        attachmentIdsJson: first.attachmentIdsJson,
        skillOverridesJson: first.skillOverridesJson,
        text: "stale write",
        updatedAt: "2026-07-17T00:00:01.000Z",
      }, null)).toThrow(/changed since it was loaded/);
      expect(() => database.drafts.upsertDraft({
        projectId,
        productMode: "harness",
        agentTurnMode: "plan",
        text: "",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        selectedProviderId: "codex",
        updatedAt: now,
      }, null)).toThrow(/must match product_mode/);
      expect(database.drafts.upsertDraft({
        projectId,
        productMode: "harness",
        agentTurnMode: null,
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
        text: "AHO draft",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        selectedProviderId: "codex",
        updatedAt: now,
      }, null)).toMatchObject({
        productMode: "harness",
        agentTurnMode: null,
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
      });
      expect(database.drafts.deleteDraft(projectId, "agent", now)).toBe(true);
      expect(database.drafts.readDraft(projectId, "agent")).toBeNull();
    } finally {
      database.close();
    }
  });

  it.each([16, 17] as const)("migrates revision %i to the current schema without losing Conversation continuity", async (revision) => {
    await createLegacyWorkbenchDatabase(revision);

    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      expect(database.conversations.readConversation(projectId, "legacy-conversation")).toMatchObject({
        productMode: "harness",
        clientCreateRequestId: null,
        clientCreateRequestHash: null,
        title: "Legacy conversation",
      });
      expect(database.timeline.listConversationMessages(projectId, "legacy-conversation")).toEqual([
        expect.objectContaining({ id: "legacy-message", text: "Preserve this message." }),
      ]);
      expect(database.providerAttempts.readConversationProviderBinding(projectId, "legacy-conversation", "codex")).toMatchObject({
        nativeSessionId: "legacy-session",
        lastDeliveredCompletedTurn: 1,
      });
      expect(database.providerAttempts.readProviderAttempt(projectId, "legacy-attempt")).toMatchObject({
        productMode: "harness",
        effectiveSkillInputs: [],
        nativeSessionId: "legacy-session",
        status: "completed",
      });
    } finally {
      database.close();
    }

    const inspected = new Database(runtimePaths().workbenchDbPath);
    try {
      expect(Number(inspected.pragma("user_version", { simple: true }))).toBe(WORKBENCH_SCHEMA_VERSION);
      expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'composer_drafts'").get()).toBeTruthy();
      expect(() => inspected.prepare(`
        INSERT INTO conversations (
          project_id, conversation_id, product_mode, title, state, surface_kind,
          selected_provider_id, completed_turn_sequence, timeline_position, timeline_revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 'user', 'codex', 0, 0, 0, ?, ?)
      `).run(projectId, "invalid-mode", "invalid", "Invalid", now, now)).toThrow();
      expect(() => inspected.prepare(`
        UPDATE conversations SET product_mode = 'agent'
        WHERE project_id = ? AND conversation_id = ?
      `).run(projectId, "legacy-conversation")).toThrow(/immutable/);
      expect(() => inspected.prepare(`
        INSERT INTO provider_attempts (
          project_id, conversation_id, attempt_id, product_mode, agent_turn_mode, provider_id, role_id,
          operation_profile, capability_snapshot_json, effective_skill_inputs_json,
          handoff_hash, delivered_through_completed_turn, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'agent', 'default', 'codex', 'main-agent', 'main', '{}', '[]', '', 0, 'queued', ?, ?)
      `).run(projectId, "legacy-conversation", "wrong-mode-attempt", now, now)).toThrow(/must match Conversation/);
    } finally {
      inspected.close();
    }
  });

  it("migrates Schema 18 Attempts and queued Turns as honest legacy execution contracts", async () => {
    const paths = runtimePaths();
    const current = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      current.conversations.createConversation(conversation("conversation-1"));
      current.providerAttempts.createProviderAttempt(providerAttempt("legacy-attempt", "codex"));
      current.conversationTurnQueues.ensureQueue({ projectId, conversationId: "conversation-1", productMode: "harness", updatedAt: now });
      current.conversationTurnQueues.insertItem({
        projectId,
        conversationId: "conversation-1",
        productMode: "harness",
        queueItemId: "legacy-queue-item",
        clientRequestId: "legacy-queue-request",
        requestHash: "legacy-request-hash",
        position: 1,
        status: "queued",
        retryCount: 0,
        predecessorExecutionRevision: "legacy-execution-revision",
        dispatchRequestId: "legacy-dispatch-request",
        executionContractFamily: "aho.main",
        executionContractEpoch: 1,
        itemKind: "conversation-turn",
        reviewTargetJson: null,
        text: "keep queued content",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        providerId: "codex",
        agentTurnMode: null,
        agentModelId: null,
        agentReasoningEffort: null,
        diagnostic: null,
        createdAt: now,
        updatedAt: now,
        dispatchedAt: null,
      });
    } finally {
      current.close();
    }

    const legacy = new Database(paths.workbenchDbPath);
    materializeWorkbenchSchemaContract(legacy, 18);
    legacy.close();
    const migrated = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(migrated.providerAttempts.readProviderAttempt(projectId, "legacy-attempt")?.executionContract)
        .toEqual({ kind: "legacy", family: "legacy-v0", epoch: 0, policyHash: null, providerAdapterVersion: null });
      expect(migrated.conversationTurnQueues.readItem(projectId, "conversation-1", "legacy-queue-item"))
        .toMatchObject({ text: "keep queued content", executionContractFamily: "legacy-v0", executionContractEpoch: 0 });
    } finally {
      migrated.close();
    }
  });

  it("updates a Conversation title only inside the exact project scope", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      const updated = database.conversations.updateConversationTitle(projectId, "conversation-1", "Renamed", "2026-07-28T00:00:00.000Z");
      const monotonic = database.conversations.updateConversationTitle(projectId, "conversation-1", "Renamed again", "2026-07-28T00:00:00.000Z");

      expect(updated).toMatchObject({ projectId, conversationId: "conversation-1", title: "Renamed" });
      expect(monotonic.updatedAt).toBe("2026-07-28T00:00:00.001Z");
      expect(() => database.conversations.updateConversationTitle("other-project", "conversation-1", "Wrong", now)).toThrow("Conversation not found");
      expect(database.conversations.readConversation(projectId, "conversation-1")?.title).toBe("Renamed again");
    } finally {
      database.close();
    }
  });

  it("rolls back Conversation creation when the initial canonical item fails", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.unitOfWork.createConversationWithInitialMessage(conversation("conversation-1"), message("shared-message", "conversation-1"));

      expect(() => database.unitOfWork.createConversationWithInitialMessage(
        conversation("conversation-2"),
        message("shared-message", "conversation-2"),
      )).toThrow();

      expect(database.conversations.readConversation(projectId, "conversation-2")).toBeNull();
      expect(database.timeline.listConversationMessages(projectId, "conversation-2")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rolls back the entire first-send transaction including Skill overrides and draft deletion", async () => {
    const paths = runtimePaths();
    const initialized = await openProjectRuntimeWorkbenchDatabase(paths);
    initialized.close();
    const raw = new Database(paths.workbenchDbPath);
    raw.prepare(`
      INSERT INTO composer_drafts (
        project_id, product_mode, text, context_refs_json, attachment_ids_json,
        skill_overrides_json, selected_provider_id, updated_at
      ) VALUES (?, 'harness', 'draft', '[]', '[]', '[]', 'codex', ?)
    `).run(projectId, now);
    raw.close();

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.unitOfWork.createConversationWithInitialMessage(
        conversation("conversation-1"),
        message("shared-message", "conversation-1"),
      );
      expect(() => database.unitOfWork.createConversationFromFirstSend({
        conversation: {
          ...conversation("conversation-2"),
          clientCreateRequestId: "rollback-first-send",
          clientCreateRequestHash: "rollback-hash",
        },
        message: message("shared-message", "conversation-2"),
        skillOverrides: [{ skillId: "must-not-persist", enabled: true }],
      })).toThrow();

      expect(database.conversations.readConversation(projectId, "conversation-2")).toBeNull();
      expect(database.timeline.listConversationMessages(projectId, "conversation-2")).toEqual([]);
      expect(database.skills.listSkillEnablement(projectId)).not.toContainEqual(expect.objectContaining({
        skillId: "must-not-persist",
      }));
    } finally {
      database.close();
    }

    const inspected = new Database(paths.workbenchDbPath, { readonly: true });
    try {
      expect(inspected.prepare(`
        SELECT text FROM composer_drafts WHERE project_id = ? AND product_mode = 'harness'
      `).get(projectId)).toMatchObject({ text: "draft" });
    } finally {
      inspected.close();
    }
  });

  it("commits queued Turn Skill overrides with the canonical message and rolls both back together", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      database.conversations.createConversation(conversation("conversation-2"));
      database.unitOfWork.commitConversationMessage({
        projectId,
        conversationId: "conversation-1",
        graphScopeId: "graph-1",
        message: message("shared-message", "conversation-1"),
        skillOverrides: [{ skillId: "queued-skill", enabled: true }],
        expectedModelId: null,
        expectedReasoningEffort: null,
        modelId: null,
        reasoningEffort: null,
        updatedAt: now,
      });

      expect(database.skills.listSkillEnablement(projectId)).toContainEqual(expect.objectContaining({
        changeId: "conversation-1",
        skillId: "queued-skill",
        enabled: true,
      }));
      expect(() => database.unitOfWork.commitConversationMessage({
        projectId,
        conversationId: "conversation-2",
        graphScopeId: "graph-1",
        message: message("shared-message", "conversation-2"),
        skillOverrides: [{ skillId: "must-not-persist", enabled: true }],
        expectedModelId: null,
        expectedReasoningEffort: null,
        modelId: null,
        reasoningEffort: null,
        updatedAt: now,
      })).toThrow();
      expect(database.timeline.listConversationMessages(projectId, "conversation-2")).toEqual([]);
      expect(database.skills.listSkillEnablement(projectId)).not.toContainEqual(expect.objectContaining({
        skillId: "must-not-persist",
      }));
    } finally {
      database.close();
    }
  });

  it("rolls back interaction, attempt, and binding terminal state when the turn CAS fails", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId: "conversation-1",
        attemptId: "attempt-1",
        productMode: "harness",
        graphScopeId: "graph-1",
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        operationProfile: "main",
        providerId: "codex",
        executionContract: testExecutionContract(),
        nativeSessionId: null,
        model: null,
        capabilitySnapshot: { providerId: "codex", effectiveModel: null } as unknown as ProviderCapabilitySnapshot,
        effectiveSkillInputs: [],
        handoffHash: "handoff-1",
        deliveredThroughCompletedTurn: 0,
        worktreeId: null,
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      database.timeline.appendMessage({
        ...message("request-1", "conversation-1"),
        runId: "run-1",
        status: "pending",
        rawJson: JSON.stringify({
          graphScopeId: "graph-1",
          providerUserInput: { requestKey: "request-key", runId: "run-1", status: "pending" },
        }),
      });

      expect(() => database.unitOfWork.commitProviderTurnTerminal({
        projectId,
        conversationId: "conversation-1",
        runId: "run-1",
        mainAttemptId: "attempt-1",
        expectedGraphScopeId: "graph-1",
        mainStatus: "completed",
        mainNativeSessionId: "thread-1",
        childAttempts: [],
        expectedCompletedTurnSequence: 9,
        advanceCompletedTurn: true,
        binding: {
          projectId,
          conversationId: "conversation-1",
          providerId: "codex",
          nativeSessionId: "thread-1",
          preferredModel: null,
          lastUsedAt: now,
          bindingStatus: "ready",
        },
        updatedAt: now,
        timelineMessages: [{ ...message("terminal-row", "conversation-1"), type: "assistant.message", status: "completed" }],
      })).toThrow("completed-turn sequence changed concurrently");

      expect(database.providerAttempts.readProviderAttempt(projectId, "attempt-1")?.status).toBe("running");
      expect(database.interactions.readProviderUserInputRequest(projectId, "conversation-1", "request-key")?.status).toBe("pending");
      expect(database.providerAttempts.readConversationProviderBinding(projectId, "conversation-1", "codex")).toBeNull();
      expect(database.timeline.readMessage(projectId, "conversation-1", "terminal-row")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("rolls back provider selection, resume point, and binding when resume attempt creation fails", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation({ ...conversation("conversation-1"), selectedProviderId: "alpha" });
      const duplicateAttempt = providerAttempt("resume-attempt", "beta");
      database.providerAttempts.createProviderAttempt(duplicateAttempt);

      expect(() => database.unitOfWork.commitConversationProviderSwitch({
        projectId,
        conversationId: "conversation-1",
        resumePointId: "resume-point-1",
        graphScopeId: "graph-1",
        changeId: null,
        previousProviderId: "alpha",
        targetProviderId: "beta",
        snapshotJson: "{}",
        snapshotHash: "snapshot-1",
        createdAt: now,
      }, {
        projectId,
        conversationId: "conversation-1",
        providerId: "beta",
        nativeSessionId: null,
        lastDeliveredCompletedTurn: 0,
        preferredModel: null,
        lastUsedAt: now,
        bindingStatus: "ready",
      }, "alpha", duplicateAttempt)).toThrow();

      expect(database.conversations.readConversation(projectId, "conversation-1")?.selectedProviderId).toBe("alpha");
      expect(database.providerAttempts.readLatestProviderResumePoint(projectId, "conversation-1")).toBeNull();
      expect(database.providerAttempts.readConversationProviderBinding(projectId, "conversation-1", "beta")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("returns revisioned rows when a graph scope supersedes an interaction and moves its run", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      database.timeline.appendMessage({
        ...message("request-1", "conversation-1"),
        runId: "run-1",
        status: "pending",
        rawJson: JSON.stringify({
          graphScopeId: "graph-1",
          providerUserInput: { requestKey: "request-key", runId: "run-1", status: "pending" },
        }),
      });
      database.providerAttempts.createProviderAttempt(providerAttempt("attempt-main", "codex"));
      database.providerAttempts.bindProviderAttemptThread(projectId, {
        attemptId: "attempt-main",
        threadId: "thread-main",
        parentThreadId: null,
        parentAgentSurfaceId: null,
      }, now);
      database.providerAttempts.createProviderAttempt({
        ...providerAttempt("attempt-plan", "codex"),
        roleId: "planning-agent",
        operationProfile: "planning",
        executionContract: testExecutionContract("planning", "planning-agent"),
      });
      database.providerAttempts.bindProviderAttemptThread(projectId, {
        attemptId: "attempt-plan",
        threadId: "thread-plan",
        parentThreadId: "thread-main",
      }, now);

      const rows = database.unitOfWork.moveConversationRunToGraphScope(
        projectId,
        "conversation-1",
        "run-1",
        {
          mainAttemptId: "attempt-main",
          plannerThreadId: "thread-plan",
          previousGraphScopeId: "graph-1",
          graphScopeId: "graph-2",
        },
        now,
      );

      expect(rows.map((row) => [row.id, row.revision])).toEqual([
        ["request-1", 2],
        ["request-1", 3],
      ]);
      const stored = database.timeline.readMessage(projectId, "conversation-1", "request-1");
      expect(stored).toMatchObject({ revision: 3, status: "superseded" });
      expect(JSON.parse(stored!.rawJson)).toMatchObject({
        graphScopeId: "graph-2",
        providerUserInput: { status: "superseded" },
      });
    } finally {
      database.close();
    }
  });

  it("rejects a terminal callback after the Conversation advances to another graph", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId: "conversation-1",
        attemptId: "attempt-graph-a",
        graphScopeId: "graph-1",
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        operationProfile: "main",
        providerId: "codex",
        executionContract: testExecutionContract(),
        nativeSessionId: "thread-graph-a",
        model: null,
        capabilitySnapshot: { providerId: "codex", effectiveModel: null } as unknown as ProviderCapabilitySnapshot,
        handoffHash: "handoff-graph-a",
        deliveredThroughCompletedTurn: 0,
        worktreeId: null,
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      database.unitOfWork.startConversationGraphScope(
        projectId,
        "conversation-1",
        "graph-2",
        "2026-07-17T00:00:01.000Z",
      );
      const completedTurnSequence = database.conversations.readConversation(
        projectId,
        "conversation-1",
      )?.completedTurnSequence;

      expect(() => database.unitOfWork.commitProviderTurnTerminal({
        projectId,
        conversationId: "conversation-1",
        runId: "run-graph-a",
        mainAttemptId: "attempt-graph-a",
        expectedGraphScopeId: "graph-1",
        mainStatus: "completed",
        mainNativeSessionId: "thread-graph-a",
        childAttempts: [],
        expectedCompletedTurnSequence: completedTurnSequence ?? 0,
        advanceCompletedTurn: true,
        binding: {
          projectId,
          conversationId: "conversation-1",
          providerId: "codex",
          nativeSessionId: "thread-graph-a",
          preferredModel: null,
          lastUsedAt: now,
          bindingStatus: "ready",
        },
        updatedAt: "2026-07-17T00:00:02.000Z",
        timelineMessages: [{
          ...message("stale-terminal-row", "conversation-1"),
          type: "assistant.message",
          status: "completed",
        }],
      })).toThrow("Provider terminal callback no longer owns the current conversation graph");

      expect(database.timeline.readMessage(projectId, "conversation-1", "stale-terminal-row")).toBeNull();
      expect(database.providerAttempts.readProviderAttempt(projectId, "attempt-graph-a")?.status).toBe("running");
      expect(database.providerAttempts.readConversationProviderBinding(projectId, "conversation-1", "codex")).toBeNull();
      expect(database.conversations.readConversation(projectId, "conversation-1")).toMatchObject({
        currentGraphScopeId: "graph-2",
        completedTurnSequence,
      });
    } finally {
      database.close();
    }
  });

  it("rejects a Planning commit whose expected graph scope is stale", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      database.unitOfWork.startConversationGraphScope(
        projectId,
        "conversation-1",
        "graph-2",
        "2026-07-17T00:00:01.000Z",
      );

      expect(() => database.unitOfWork.acceptConversationChangeBinding(
        projectId,
        "conversation-1",
        "stale-change",
        "2026-07-17T00:00:02.000Z",
        "stale-acceptance",
        "proposal-hash",
        undefined,
        "graph-1",
      )).toThrow(/no longer matches the current conversation graph scope/);

      expect(database.conversations.readConversation(projectId, "conversation-1")).toMatchObject({
        boundChangeId: null,
        currentGraphScopeId: "graph-2",
      });
      expect(database.conversations.hasPlanningAcceptanceCommit("stale-acceptance")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rejects a Planning commit after its expected Main attempt becomes terminal", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths());
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId: "conversation-1",
        attemptId: "stale-main-attempt",
        graphScopeId: "graph-1",
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        operationProfile: "main",
        providerId: "codex",
        executionContract: testExecutionContract(),
        nativeSessionId: "thread-stale-main",
        model: null,
        capabilitySnapshot: { providerId: "codex", effectiveModel: null } as unknown as ProviderCapabilitySnapshot,
        handoffHash: "handoff-stale-main",
        deliveredThroughCompletedTurn: 0,
        worktreeId: null,
        status: "completed",
        createdAt: now,
        updatedAt: now,
      });

      expect(() => database.unitOfWork.acceptConversationChangeBinding(
        projectId,
        "conversation-1",
        "stale-change",
        "2026-07-17T00:00:02.000Z",
        "stale-attempt-acceptance",
        "proposal-hash",
        undefined,
        "graph-1",
        "stale-main-attempt",
      )).toThrow("Planning acceptance Main attempt no longer owns the current conversation graph");

      expect(database.conversations.readConversation(projectId, "conversation-1")?.boundChangeId).toBeNull();
      expect(database.conversations.hasPlanningAcceptanceCommit("stale-attempt-acceptance")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rejects unsupported populated schemas without invoking destructive reset guards", async () => {
    const paths = runtimePaths();
    const initial = await openProjectRuntimeWorkbenchDatabase(paths);
    initial.close();
    const old = new Database(paths.workbenchDbPath);
    old.pragma("user_version = 2");
    old.close();

    let guardCalled = false;
    await expect(WorkbenchDatabase.open(paths, {
      assertSafe: async (connection) => {
        guardCalled = true;
        expect(connection.inTransaction).toBe(false);
      },
    })).rejects.toMatchObject({ code: "unsupported-legacy" });
    expect(guardCalled).toBe(false);
    const preserved = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(preserved.pragma("user_version", { simple: true }))).toBe(2);
    preserved.close();
  });

  it("keeps connection creation and high-level dependencies out of repositories", async () => {
    const workbenchRoot = join(process.cwd(), "src", "workbench");
    const persistenceRoot = join(workbenchRoot, "persistence");
    const repositoryRoot = join(persistenceRoot, "repositories");
    const repositoryFiles = (await readdir(repositoryRoot)).filter((file) => file.endsWith(".ts"));
    const repositorySources = await Promise.all(repositoryFiles.map((file) => readFile(join(repositoryRoot, file), "utf8")));
    const forbidden = /new Database|chat\.js|canonical-timeline\.js|project-live-events|provider-live-events|projections\/|provider-runtime\/registry|workflow-runtime/;
    expect(repositorySources.every((source) => !forbidden.test(source))).toBe(true);

    const unitOfWorkSource = await readFile(join(persistenceRoot, "unit-of-work.ts"), "utf8");
    expect(unitOfWorkSource).not.toMatch(/\.prepare\(|JSON\.parse|providerUserInput|clarification/);

    const persistenceFiles = await collectTypeScriptFiles(workbenchRoot);
    const creators = [];
    for (const file of persistenceFiles) {
      if ((await readFile(file, "utf8")).includes("new Database(")) creators.push(file);
    }
    expect(creators.map((file) => file.replaceAll("\\", "/"))).toEqual([
      expect.stringMatching(/src\/workbench\/persistence\/database-upgrade\.ts$/),
      expect.stringMatching(/src\/workbench\/persistence\/schema-migrations\.ts$/),
    ]);
    const migrationSource = await readFile(join(persistenceRoot, "schema-migrations.ts"), "utf8");
    expect(migrationSource.match(/new Database\([^)]*\)/g)).toEqual(['new Database(":memory:")']);
  });

  it("fails closed when a stored Provider Attempt has a malformed execution identity", async () => {
    const paths = runtimePaths();
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.conversations.createConversation(conversation("conversation-1"));
      for (const attemptId of ["missing-hash", "short-hash", "blank-adapter", "long-adapter"]) {
        database.providerAttempts.createProviderAttempt(providerAttempt(attemptId, "codex"));
      }
    } finally {
      database.close();
    }

    const raw = new Database(paths.workbenchDbPath);
    try {
      raw.prepare("UPDATE provider_attempts SET execution_policy_hash = NULL WHERE attempt_id = ?").run("missing-hash");
      raw.prepare("UPDATE provider_attempts SET execution_policy_hash = 'x' WHERE attempt_id = ?").run("short-hash");
      raw.prepare("UPDATE provider_attempts SET provider_adapter_version = '   ' WHERE attempt_id = ?").run("blank-adapter");
      raw.prepare("UPDATE provider_attempts SET provider_adapter_version = ? WHERE attempt_id = ?")
        .run("x".repeat(129), "long-adapter");
    } finally {
      raw.close();
    }

    const reopened = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      for (const attemptId of ["missing-hash", "short-hash", "blank-adapter", "long-adapter"]) {
        expect(() => reopened.providerAttempts.readProviderAttempt(projectId, attemptId))
          .toThrow("Provider attempt has invalid execution contract");
      }
    } finally {
      reopened.close();
    }
  });
});

function runtimePaths() {
  return resolveProjectRuntimePaths(projectId, root);
}

function providerAttempt(attemptId: string, providerId: string) {
  return {
    projectId,
    conversationId: "conversation-1",
    attemptId,
    productMode: "harness",
    graphScopeId: "graph-1",
    changeId: null,
    agentTaskId: null,
    roleId: "main-agent",
    operationProfile: "main",
    providerId,
    executionContract: testExecutionContract(),
    nativeSessionId: null,
    model: null,
    capabilitySnapshot: { providerId, effectiveModel: null } as unknown as ProviderCapabilitySnapshot,
    effectiveSkillInputs: [],
    handoffHash: `handoff-${attemptId}`,
    deliveredThroughCompletedTurn: 0,
    worktreeId: null,
    status: "queued" as const,
    createdAt: now,
    updatedAt: now,
  };
}

function testExecutionContract(
  operationProfile: "main" | "planning" = "main",
  roleId = "main-agent",
) {
  return resolveStoredExecutionContract({
    productMode: "harness",
    operationProfile,
    operationKind: "conversation-turn",
    roleId,
    providerAdapterVersion: "test-adapter-v1",
  });
}

function conversation(conversationId: string) {
  return {
    projectId,
    conversationId,
    productMode: "harness" as const,
    clientCreateRequestId: null,
    clientCreateRequestHash: null,
    title: conversationId,
    state: "active" as const,
    boundChangeId: null,
    currentGraphScopeId: "graph-1",
    selectedProviderId: "codex",
    completedTurnSequence: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function message(id: string, conversationId: string): StoredTopicMessageWrite {
  return {
    id,
    projectId,
    conversationId,
    changeId: "",
    agentSurfaceId: "main-agent",
    type: "user.message",
    timestamp: now,
    text: id,
    actionRunId: null,
    actionType: null,
    status: null,
    runId: null,
    providerId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    artifact: null,
    error: null,
    rawJson: "{}",
  };
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScriptFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

async function createLegacyWorkbenchDatabase(revision: 16 | 17): Promise<void> {
  const paths = runtimePaths();
  await mkdir(paths.workbenchRoot, { recursive: true });
  const database = new Database(paths.workbenchDbPath);
  try {
    applyCurrentWorkbenchSchema(database);
    materializeWorkbenchSchemaContract(database, revision);
    database.prepare(`INSERT INTO conversations (
      project_id, conversation_id, product_mode, agent_turn_mode, title, state, surface_kind,
      bound_change_id, current_graph_scope_id, selected_provider_id, completed_turn_sequence,
      timeline_position, timeline_revision, created_at, updated_at, deleted_at
    ) VALUES (?, ?, 'harness', NULL, ?, 'active', 'user', NULL, ?, 'codex', 1, 1, 1, ?, ?, NULL)`)
      .run(projectId, "legacy-conversation", "Legacy conversation", "legacy-graph", now, now);
    database.prepare(`INSERT INTO canonical_timeline_items (
      id, project_id, conversation_id, change_id, position, revision, agent_surface_id,
      initial_thread_input, type, timestamp, text, raw_json
    ) VALUES (?, ?, ?, '', 1, 1, 'main-agent', 0, 'user.message', ?, ?, '{}')`)
      .run("legacy-message", projectId, "legacy-conversation", now, "Preserve this message.");
    database.prepare(`INSERT INTO conversation_provider_bindings (
      project_id, conversation_id, provider_id, native_session_id, last_delivered_completed_turn,
      preferred_model_json, last_used_at, binding_status
    ) VALUES (?, ?, 'codex', 'legacy-session', 1, NULL, ?, 'ready')`)
      .run(projectId, "legacy-conversation", now);
    database.prepare(`INSERT INTO provider_attempts (
      project_id, conversation_id, attempt_id, product_mode, agent_turn_mode, graph_scope_id,
      provider_id, role_id, operation_profile, native_session_id, capability_snapshot_json,
      effective_skill_inputs_json, handoff_hash, delivered_through_completed_turn, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'harness', NULL, ?, 'codex', 'main-agent', 'main', 'legacy-session', ?, '[]', '', 1, 'completed', ?, ?)`)
      .run(projectId, "legacy-conversation", "legacy-attempt", "legacy-graph", '{"providerId":"codex","productMode":"harness"}', now, now);
  } finally {
    database.close();
  }
}
