import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import type { ProviderCapabilitySnapshot } from "../../src/provider-runtime/index.js";
import { bindProviderAttemptThread, finishProviderAttempt, startProviderAttempt } from "../../src/workbench/provider-attempts.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";
import { subscribeProjectLiveEvents } from "../../src/workbench/project-live-events.js";

let root: string;
const projectId = "provider-thread-owner";
const capabilities = { providerId: "codex", effectiveModel: null } as unknown as ProviderCapabilitySnapshot;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-attempt-thread-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ProviderAttempt-owned thread binding", () => {
  it("uses the current schema and binds an independent worker to explicit Main lineage", async () => {
    const memory = runtimePaths();
    await seedConversation(memory);
    await startAttempt(memory, "attempt-1");
    const invalidations: unknown[] = [];
    const unsubscribe = subscribeProjectLiveEvents(projectId, (event) => invalidations.push(event));

    const first = await bindProviderAttemptThread(memory, {
      attemptId: "attempt-1",
      threadId: "thread-1",
      parentAgentSurfaceId: "main-agent",
      displayName: "Coder",
    });
    const second = await bindProviderAttemptThread(memory, {
      attemptId: "attempt-1",
      threadId: "thread-1",
    });
    unsubscribe();

    expect(first).toMatchObject({
      projectId,
      conversationId: "conversation-1",
      attemptId: "attempt-1",
      providerId: "codex",
      providerThreadId: "thread-1",
      roleId: "coder-agent",
      parentAgentSurfaceId: "main-agent",
      changeId: "change-1",
      graphScopeId: "graph-1",
      runId: "attempt-1",
    });
    expect(second.displayName).toBe("Coder");
    expect(invalidations).toEqual([
      expect.objectContaining({ event: "agent-surfaces.invalidated", data: expect.objectContaining({ reason: "thread-bound" }) }),
      expect.objectContaining({ event: "agent-surfaces.invalidated", data: expect.objectContaining({ reason: "thread-bound" }) }),
    ]);
    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-1")).toHaveLength(1);
      expect(store.providerAttempts.listProviderAttempts(projectId, "conversation-1")[0]?.nativeSessionId).toBe("thread-1");
    } finally {
      store.close();
    }
    const db = new Database(memory.workbenchDbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(WORKBENCH_SCHEMA_VERSION);
    expect(db.prepare("PRAGMA table_info(provider_thread_links)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "attempt_id", notnull: 1 }),
      expect.objectContaining({ name: "parent_agent_surface_id" }),
    ]));
    expect(db.prepare("PRAGMA table_info(provider_attempts)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "parent_agent_surface_id" }),
    ]));
    db.close();
  });

  it("fails closed when one attempt changes threads or thread lineage changes", async () => {
    const memory = runtimePaths();
    await seedConversation(memory);
    await seedMainThread(memory);
    await startAttempt(memory, "attempt-1");
    await bindProviderAttemptThread(memory, { attemptId: "attempt-1", threadId: "thread-1", parentThreadId: "main-thread" });

    await expect(bindProviderAttemptThread(memory, { attemptId: "attempt-1", threadId: "thread-2", parentThreadId: "main-thread" }))
      .rejects.toThrow("already bound to another thread");
    await startAttempt(memory, "attempt-2");
    await expect(bindProviderAttemptThread(memory, {
      attemptId: "attempt-2",
      threadId: "thread-1",
      parentThreadId: "main-thread",
      parentAgentSurfaceId: "agent:codex:thread:not-main",
    })).rejects.toThrow("conflicts with canonical Agent surface lineage");
  });

  it("resumes the same provider thread by transferring ownership to the new attempt", async () => {
    const memory = runtimePaths();
    await seedConversation(memory);
    await seedMainThread(memory);
    await startAttempt(memory, "attempt-1");
    await bindProviderAttemptThread(memory, { attemptId: "attempt-1", threadId: "thread-1", parentThreadId: "main-thread" });
    await finishProviderAttempt(memory, "attempt-1", "completed", "thread-1");
    await startAttempt(memory, "attempt-2");

    const resumed = await bindProviderAttemptThread(memory, {
      attemptId: "attempt-2",
      threadId: "thread-1",
      parentThreadId: "main-thread",
      displayName: "Resumed coder",
    });

    expect(resumed).toMatchObject({ attemptId: "attempt-2", providerThreadId: "thread-1", displayName: "Resumed coder", runId: "attempt-2" });
    await finishProviderAttempt(memory, "attempt-2", "completed", "thread-1");
    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      const childLinks = store.providerAttempts.listProviderThreads(projectId, "conversation-1").filter((link) => link.roleId !== "main-agent");
      expect(childLinks).toHaveLength(1);
      expect(childLinks[0]?.parentAgentSurfaceId).toBe("main-agent");
      expect(store.providerAttempts.listProviderAttempts(projectId, "conversation-1").find((attempt) => attempt.attemptId === "attempt-2")).toMatchObject({
        nativeSessionId: "thread-1",
        status: "completed",
      });
    } finally {
      store.close();
    }
  });

  it("lets the current graph take over a Main thread and rejects a late callback from the old graph", async () => {
    const memory = runtimePaths();
    await seedConversation(memory);
    await seedMainThread(memory);
    const db = new Database(memory.workbenchDbPath);
    db.prepare("UPDATE conversations SET current_graph_scope_id = ? WHERE project_id = ? AND conversation_id = ?")
      .run("graph-2", projectId, "conversation-1");
    db.close();
    await startProviderAttempt(memory, {
      attemptId: "attempt-main-2",
      providerId: "codex",
      capabilitySnapshot: capabilities,
      operationProfile: "main",
      roleId: "main-agent",
      handoffHash: "handoff-main-2",
      conversationId: "conversation-1",
      changeId: "change-2",
      graphScopeId: "graph-2",
    });

    await expect(bindProviderAttemptThread(memory, {
      attemptId: "attempt-main-2",
      threadId: "main-thread",
      parentThreadId: null,
      parentAgentSurfaceId: null,
    })).resolves.toMatchObject({ attemptId: "attempt-main-2", graphScopeId: "graph-2" });
    await expect(bindProviderAttemptThread(memory, {
      attemptId: "attempt-main",
      threadId: "main-thread",
      parentThreadId: null,
      parentAgentSurfaceId: null,
    })).rejects.toThrow(/no longer belongs to the current conversation graph/);

    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-1"))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ providerThreadId: "main-thread", attemptId: "attempt-main-2", graphScopeId: "graph-2" }),
        ]));
    } finally {
      store.close();
    }
  });

  it("moves accepted Main and Planning thread links with their owning Attempts", async () => {
    const memory = runtimePaths();
    await seedConversation(memory);
    await startProviderAttempt(memory, {
      attemptId: "attempt-main-historical",
      providerId: "codex",
      capabilitySnapshot: capabilities,
      operationProfile: "main",
      roleId: "main-agent",
      handoffHash: "handoff-main-historical",
      conversationId: "conversation-1",
      changeId: "change-historical",
      graphScopeId: "graph-1",
    });
    await bindProviderAttemptThread(memory, {
      attemptId: "attempt-main-historical",
      threadId: "main-thread-historical",
      parentThreadId: null,
      parentAgentSurfaceId: null,
    });
    await finishProviderAttempt(memory, "attempt-main-historical", "completed", "main-thread-historical");
    await seedMainThread(memory);
    await startProviderAttempt(memory, {
      attemptId: "attempt-plan",
      providerId: "codex",
      capabilitySnapshot: capabilities,
      operationProfile: "planning",
      roleId: "planning-agent",
      handoffHash: "handoff-plan",
      conversationId: "conversation-1",
      changeId: "change-1",
      graphScopeId: "graph-1",
    });
    await bindProviderAttemptThread(memory, {
      attemptId: "attempt-plan",
      threadId: "thread-plan",
      parentThreadId: "main-thread",
    });
    const otherStore = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      const now = new Date().toISOString();
      otherStore.conversations.createConversation({
        projectId,
        conversationId: "conversation-2",
        productMode: "harness",
        title: "Unrelated conversation",
        state: "active",
        boundChangeId: "change-other",
        currentGraphScopeId: "graph-1",
        selectedProviderId: "codex",
        completedTurnSequence: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    } finally {
      otherStore.close();
    }
    await startProviderAttempt(memory, {
      attemptId: "attempt-main-other",
      providerId: "codex",
      capabilitySnapshot: capabilities,
      operationProfile: "main",
      roleId: "main-agent",
      handoffHash: "handoff-main-other",
      conversationId: "conversation-2",
      changeId: "change-other",
      graphScopeId: "graph-1",
    });
    await bindProviderAttemptThread(memory, {
      attemptId: "attempt-main-other",
      threadId: "main-thread-other",
      parentThreadId: null,
      parentAgentSurfaceId: null,
    });

    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      store.unitOfWork.moveConversationRunToGraphScope(
        projectId,
        "conversation-1",
        "run-plan",
        {
          mainAttemptId: "attempt-main",
          plannerThreadId: "thread-plan",
          previousGraphScopeId: "graph-1",
          graphScopeId: "graph-2",
        },
        "2026-07-25T00:00:00.000Z",
      );
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-1")).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerThreadId: "main-thread", graphScopeId: "graph-2" }),
        expect.objectContaining({ providerThreadId: "thread-plan", graphScopeId: "graph-2" }),
      ]));
      expect(store.providerAttempts.readProviderAttempt(projectId, "attempt-main")?.graphScopeId).toBe("graph-2");
      expect(store.providerAttempts.readProviderAttempt(projectId, "attempt-plan")?.graphScopeId).toBe("graph-2");
      expect(store.providerAttempts.readProviderAttempt(projectId, "attempt-main-historical")?.graphScopeId).toBe("graph-1");
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-1")).toEqual(expect.arrayContaining([
        expect.objectContaining({ attemptId: "attempt-main-historical", graphScopeId: "graph-1" }),
      ]));
      expect(store.providerAttempts.readProviderAttempt(projectId, "attempt-main-other")?.graphScopeId).toBe("graph-1");
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-2")).toEqual([
        expect.objectContaining({ attemptId: "attempt-main-other", graphScopeId: "graph-1" }),
      ]);
    } finally {
      store.close();
    }
  });

  it("uses the terminal native session as a fallback binding", async () => {
    const memory = runtimePaths();
    await seedConversation(memory);
    await seedMainThread(memory);
    await startAttempt(memory, "attempt-terminal");

    await finishProviderAttempt(memory, "attempt-terminal", "completed", "thread-terminal", {
      parentThreadId: "main-thread",
      displayName: "Terminal coder",
    });

    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-1").filter((link) => link.roleId !== "main-agent")).toEqual([
        expect.objectContaining({ attemptId: "attempt-terminal", providerThreadId: "thread-terminal", parentAgentSurfaceId: "main-agent" }),
      ]);
      expect(store.providerAttempts.listProviderAttempts(projectId, "conversation-1").find((attempt) => attempt.attemptId === "attempt-terminal"))
        .toMatchObject({ status: "completed", nativeSessionId: "thread-terminal" });
    } finally {
      store.close();
    }
  });

  it("fails closed when a terminal non-Main thread has no exact parent lineage", async () => {
    const memory = runtimePaths();
    await seedConversation(memory);
    await seedMainThread(memory);
    await startAttempt(memory, "attempt-orphan-terminal");

    await expect(finishProviderAttempt(memory, "attempt-orphan-terminal", "completed", "thread-orphan"))
      .rejects.toThrow("Top-level model worker requires explicit main-agent parent lineage");

    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-1").some((link) => link.providerThreadId === "thread-orphan")).toBe(false);
      expect(store.providerAttempts.readProviderAttempt(projectId, "attempt-orphan-terminal")?.status).toBe("running");
    } finally {
      store.close();
    }
  });

  it("keeps non-conversation provider attempts out of Agent surfaces", async () => {
    const memory = runtimePaths();
    await startProviderAttempt(memory, {
      attemptId: "attempt-cli",
      providerId: "codex",
      capabilitySnapshot: capabilities,
      operationProfile: "auditor",
      roleId: "auditor-agent",
      handoffHash: "handoff-cli",
      changeId: "change-cli",
    });

    await expect(bindProviderAttemptThread(memory, {
      attemptId: "attempt-cli",
      threadId: "thread-cli",
    })).resolves.toBeNull();
    await finishProviderAttempt(memory, "attempt-cli", "completed", "thread-cli");

    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      expect(store.providerAttempts.readProviderAttempt(projectId, "attempt-cli")).toMatchObject({
        conversationId: null,
        graphScopeId: null,
        nativeSessionId: "thread-cli",
        status: "completed",
      });
      expect(store.providerAttempts.listProviderThreads(projectId, "conversation-cli")).toEqual([]);
    } finally {
      store.close();
    }
  });
});

async function seedConversation(memory: ProjectRuntimePaths): Promise<void> {
  const store = await openProjectRuntimeWorkbenchDatabase(memory);
  try {
    const now = new Date().toISOString();
    store.conversations.createConversation({
      projectId,
      conversationId: "conversation-1",
      productMode: "harness",
      title: "Provider thread owner",
      state: "active",
      boundChangeId: "change-1",
      currentGraphScopeId: "graph-1",
      selectedProviderId: "codex",
      completedTurnSequence: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  } finally {
    store.close();
  }
}

async function startAttempt(memory: ProjectRuntimePaths, attemptId: string): Promise<void> {
  await startProviderAttempt(memory, {
    attemptId,
    providerId: "codex",
    capabilitySnapshot: capabilities,
    operationProfile: "coder",
    roleId: "coder-agent",
    handoffHash: `handoff-${attemptId}`,
    conversationId: "conversation-1",
    changeId: "change-1",
    graphScopeId: "graph-1",
  });
}

async function seedMainThread(memory: ProjectRuntimePaths): Promise<void> {
  await startProviderAttempt(memory, {
    attemptId: "attempt-main",
    providerId: "codex",
    capabilitySnapshot: capabilities,
    operationProfile: "main",
    roleId: "main-agent",
    handoffHash: "handoff-main",
    conversationId: "conversation-1",
    changeId: "change-1",
    graphScopeId: "graph-1",
  });
  await bindProviderAttemptThread(memory, {
    attemptId: "attempt-main",
    threadId: "main-thread",
    parentThreadId: null,
    parentAgentSurfaceId: null,
  });
}

function runtimePaths(): ProjectRuntimePaths {
  return resolveProjectRuntimePaths(projectId, root);
}
