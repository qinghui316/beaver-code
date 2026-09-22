import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProductMode,
  ProviderContextCompactRequest,
  ProviderContextEvent,
  ProviderContextUsage,
} from "../../src/provider-runtime/index.js";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import type { ManagedProject } from "../../src/types/index.js";
import {
  ConversationContextLifecycleOwner,
  type ConversationContextObservation,
} from "../../src/workbench/conversation-context-lifecycle.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { ConversationContextRepository } from "../../src/workbench/persistence/repositories/conversation-context-repository.js";

const projectId = "conversation-context-project";
const sessionId = "thread-private-session";
const graphScopeId = "graph-current";
const providerEventPersistenceTimeoutMs = 15_000;
let root: string;
let originalAhoHome: string | undefined;
let paths: ProjectRuntimePaths;
let project: ManagedProject;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-conversation-context-"));
  originalAhoHome = process.env.AHO_HOME;
  process.env.AHO_HOME = join(root, ".aho-home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  paths = resolveProjectRuntimePaths(projectId, process.env.AHO_HOME);
  project = {
    id: projectId,
    name: "Conversation Context",
    path: projectRoot,
    addedAt: "2026-08-24T00:00:00.000Z",
    lastSeenAt: "2026-08-24T00:00:00.000Z",
  };
});

afterEach(async () => {
  if (originalAhoHome === undefined) delete process.env.AHO_HOME;
  else process.env.AHO_HOME = originalAhoHome;
  await rm(root, { recursive: true, force: true });
});

describe("ConversationContextLifecycleOwner", () => {
  it.each(["agent", "harness"] as const)("projects current usage and automatic compaction in %s mode", async (productMode) => {
    const conversationId = `conversation-${productMode}`;
    await seedConversation(conversationId, productMode);
    const compactContext = vi.fn(async () => ({ status: "accepted" as const }));
    const owner = createOwner(compactContext);
    const listener = owner.listener(observation(conversationId, productMode));

    listener(usageEvent(usage({
      total: breakdown(190_000, 170_000, 10_000),
      last: breakdown(20_000, 15_000, 5_000),
      contextUsedTokens: 20_000,
      modelContextWindow: 200_000,
    })));
    await waitForProviderEventPersistence(async () => expect(await owner.read(project, productMode, conversationId)).toMatchObject({
      usage: {
        total: { totalTokens: 190_000 },
        last: { inputTokens: 15_000, cachedInputTokens: 5_000 },
        contextUsedTokens: 20_000,
      },
      usedPercent: 10,
      remainingPercent: 90,
      lifecycle: "idle",
      canCompact: true,
    }));

    listener(compactionEvent("automatic-1", "completed"));
    listener(compactionEvent("automatic-1", "started"));
    await waitForProviderEventPersistence(async () => expect(await owner.read(project, productMode, conversationId)).toMatchObject({
      lifecycle: "completed",
      source: "automatic",
      lastCompactedAt: "2026-08-24T00:02:00.000Z",
    }));

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const rows = database.timeline.listConversationMessages(projectId, conversationId);
      expect(rows.map((row) => row.type)).toEqual(expect.arrayContaining(["provider.context-usage", "provider.context-compaction"]));
      expect(JSON.stringify(rows)).not.toContain(sessionId);
      expect(database.conversations.listConversations(projectId, productMode)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("keeps ACK distinct from started/completed and deduplicates exact manual requests", async () => {
    const conversationId = "conversation-manual";
    await seedConversation(conversationId, "agent");
    let callback: ((event: ProviderContextEvent) => void) | undefined;
    const compactContext = vi.fn(async (request: ProviderContextCompactRequest) => {
      callback = request.onContextEvent;
      return { status: "accepted" as const };
    });
    const owner = createOwner(compactContext);
    const initial = await owner.read(project, "agent", conversationId);
    const request = {
      projectId,
      productMode: "agent" as const,
      conversationId,
      providerId: "codex",
      contextRevision: initial.contextRevision,
      clientRequestId: "compact-request-1",
    };

    await expect(Promise.all([owner.compact(project, request), owner.compact(project, request)]))
      .resolves.toEqual([{ status: "accepted" }, { status: "accepted" }]);
    expect(compactContext).toHaveBeenCalledOnce();
    expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "submitting", source: "manual", canCompact: false });
    await expect(owner.compact(project, { ...request, clientRequestId: "compact-request-2" }))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(compactContext).toHaveBeenCalledOnce();

    callback?.(compactionEvent("manual-item", "started"));
    await waitForProviderEventPersistence(async () => expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "compacting", source: "manual" }));
    callback?.(compactionEvent("manual-item", "completed"));
    await waitForProviderEventPersistence(async () => expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "completed", source: "manual" }));

    await expect(owner.compact(project, { ...request, contextRevision: "stale-revision" }))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(compactContext).toHaveBeenCalledOnce();
  });

  it("automatically retries accepted terminal evidence without another Provider call", async () => {
    const conversationId = "conversation-persistence-retry";
    await seedConversation(conversationId, "agent");
    let callback: ((event: ProviderContextEvent) => void) | undefined;
    const compactContext = vi.fn(async (request: ProviderContextCompactRequest) => {
      callback = request.onContextEvent;
      return { status: "accepted" as const };
    });
    const owner = createOwner(compactContext);
    const initial = await owner.read(project, "agent", conversationId);
    const request = compactRequest(conversationId, initial.contextRevision, "persist-retry");
    await owner.compact(project, request);
    callback?.(compactionEvent("persist-item", "started"));
    await waitForProviderEventPersistence(async () => expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "compacting" }));

    const failure = vi.spyOn(ConversationContextRepository.prototype, "upsertCompaction")
      .mockImplementationOnce(() => { throw new Error("simulated timeline write failure"); });
    callback?.(compactionEvent("persist-item", "completed"));
    await waitForProviderEventPersistence(() => expect(failure).toHaveBeenCalled());
    failure.mockRestore();
    expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "compacting" });

    await waitForProviderEventPersistence(async () => expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "completed", canCompact: true }));
    expect(compactContext).toHaveBeenCalledOnce();
  });

  it("fails closed for stale graph events and malformed usage", async () => {
    const conversationId = "conversation-stale";
    await seedConversation(conversationId, "agent");
    const owner = createOwner(vi.fn(async () => ({ status: "accepted" as const })));
    owner.listener({ ...observation(conversationId, "agent"), graphScopeId: "graph-old" })(usageEvent(usage()));
    owner.listener(observation(conversationId, "agent"))(usageEvent(usage({
      last: { ...breakdown(10, 7, 2), inputTokens: -1 },
    })));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await owner.read(project, "agent", conversationId)).toMatchObject({ usage: null, usedPercent: null });
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.timeline.listConversationMessages(projectId, conversationId)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("keeps the Snapshot readable when optional capability discovery fails", async () => {
    const conversationId = "conversation-capability-failure";
    await seedConversation(conversationId, "agent");
    const owner = createOwner(
      vi.fn(async () => ({ status: "accepted" as const })),
      async () => { throw new Error("private provider failure"); },
    );

    await expect(owner.read(project, "agent", conversationId)).resolves.toMatchObject({
      providerId: "codex",
      canCompact: false,
      disabledReason: "暂时无法验证 Provider 的上下文压缩能力。",
    });
  });

  it("blocks active attempts and pending interactions before Provider I/O", async () => {
    const conversationId = "conversation-blocked";
    await seedConversation(conversationId, "agent");
    const compactContext = vi.fn(async () => ({ status: "accepted" as const }));
    const owner = createOwner(compactContext);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId,
        attemptId: "attempt-child",
        productMode: "agent",
        agentTurnMode: "default",
        graphScopeId,
        changeId: null,
        agentTaskId: null,
        roleId: "native-child-agent",
        parentAgentSurfaceId: "main-agent",
        operationProfile: "agent",
        providerId: "codex",
        nativeSessionId: sessionId,
        model: null,
        reasoningEffort: null,
        capabilitySnapshot: capabilitySnapshot(),
        effectiveSkillInputs: [],
        handoffHash: "handoff-child",
        deliveredThroughCompletedTurn: 0,
        worktreeId: null,
        status: "running",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      });
    } finally {
      database.close();
    }
    let snapshot = await owner.read(project, "agent", conversationId);
    expect(snapshot).toMatchObject({ canCompact: false, disabledReason: "当前回合运行中，结束后才能压缩上下文。" });
    await expect(owner.compact(project, compactRequest(conversationId, snapshot.contextRevision, "active-attempt"))).rejects.toMatchObject({ name: "Conflict" });

    const terminal = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      terminal.providerAttempts.completeProviderAttempt(projectId, "attempt-child", "completed", sessionId, "2026-08-24T00:01:00.000Z");
      terminal.timeline.appendMessage({
        id: "pending-provider-input",
        projectId,
        conversationId,
        changeId: conversationId,
        agentSurfaceId: "main-agent",
        type: "provider.user-input",
        timestamp: "2026-08-24T00:01:00.000Z",
        text: null,
        actionRunId: null,
        actionType: null,
        status: "pending",
        runId: null,
        providerId: "codex",
        threadId: null,
        turnId: null,
        itemId: null,
        artifact: null,
        error: null,
        rawJson: JSON.stringify({ providerUserInput: { status: "pending" } }),
      });
    } finally {
      terminal.close();
    }
    snapshot = await owner.read(project, "agent", conversationId);
    expect(snapshot).toMatchObject({ canCompact: false, disabledReason: "请先处理当前 Provider 问题或审批。" });
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("keeps explicit rejection retryable with a new id and interrupts uncertain work on restart", async () => {
    const conversationId = "conversation-recovery";
    await seedConversation(conversationId, "agent");
    const rejection = new Error("compact unavailable");
    rejection.name = "ProviderContextCompactRejected";
    const compactContext = vi.fn()
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(new Error("connection lost"));
    const owner = createOwner(compactContext);
    const initial = await owner.read(project, "agent", conversationId);

    await expect(owner.compact(project, compactRequest(conversationId, initial.contextRevision, "explicit-reject")))
      .rejects.toMatchObject({ name: "ProviderContextCompactRejected", message: "Provider rejected context compaction." });
    expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "failed", canCompact: true });
    const restartedProvider = vi.fn(async () => ({ status: "accepted" as const }));
    const restartedAfterFailure = createOwner(restartedProvider);
    await expect(restartedAfterFailure.compact(project, compactRequest(conversationId, initial.contextRevision, "explicit-reject")))
      .rejects.toMatchObject({ name: "ProviderContextCompactRejected", message: "Provider rejected context compaction." });
    expect(restartedProvider).not.toHaveBeenCalled();
    await expect(owner.compact(project, compactRequest(conversationId, initial.contextRevision, "uncertain"))).rejects.toThrow("connection lost");
    expect(await owner.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "submitting", canCompact: false });

    const recovered = createOwner(vi.fn(async () => ({ status: "accepted" as const })));
    await expect(recovered.reconcileProject(paths)).resolves.toBe(1);
    expect(await recovered.read(project, "agent", conversationId)).toMatchObject({ lifecycle: "interrupted", canCompact: true });
  });

  it("never persists Provider-private rejection details", async () => {
    const conversationId = "conversation-private-rejection";
    await seedConversation(conversationId, "agent");
    const rejection = new Error(`thread ${sessionId} rejected: secret-provider-detail`);
    rejection.name = "ProviderContextCompactRejected";
    const owner = createOwner(vi.fn(async () => { throw rejection; }));
    const initial = await owner.read(project, "agent", conversationId);

    await expect(owner.compact(project, compactRequest(conversationId, initial.contextRevision, "private-reject")))
      .rejects.toMatchObject({ name: "ProviderContextCompactRejected", message: "Provider rejected context compaction." });
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const serialized = JSON.stringify(database.timeline.listConversationMessages(projectId, conversationId));
      expect(serialized).toContain("Provider rejected context compaction.");
      expect(serialized).not.toContain(sessionId);
      expect(serialized).not.toContain("secret-provider-detail");
    } finally {
      database.close();
    }
  });
});

function waitForProviderEventPersistence(assertion: () => void | Promise<void>): Promise<void> {
  // Provider callbacks enqueue SQLite writes without awaiting them; loaded CI runners can delay delivery.
  return vi.waitFor(assertion, { timeout: providerEventPersistenceTimeoutMs });
}

function createOwner(
  compactContext: (request: ProviderContextCompactRequest) => Promise<{ status: "accepted" }>,
  capabilitySnapshotReader: () => Promise<ReturnType<typeof capabilitySnapshot>> = async () => capabilitySnapshot(),
): ConversationContextLifecycleOwner {
  return new ConversationContextLifecycleOwner({
    providerRegistry: {
      get: () => ({
        capabilitySnapshot: capabilitySnapshotReader,
        conversation: { compactContext },
      }) as never,
    },
    projectRuntimeCoordinator: {
      resolve: async () => ({ state: "onboarding", paths }),
    } as never,
  });
}

async function seedConversation(conversationId: string, productMode: ProductMode): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const now = "2026-08-24T00:00:00.000Z";
    database.conversations.createConversation({
      projectId,
      conversationId,
      productMode,
      agentTurnMode: productMode === "agent" ? "default" : null,
      title: conversationId,
      state: "active",
      boundChangeId: null,
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
      nativeSessionId: sessionId,
      lastDeliveredCompletedTurn: 0,
      preferredModel: null,
      lastUsedAt: now,
      bindingStatus: "ready",
    });
  } finally {
    database.close();
  }
}

function observation(conversationId: string, productMode: ProductMode): ConversationContextObservation {
  return { paths, productMode, conversationId, graphScopeId, providerId: "codex" };
}

function usageEvent(value: ProviderContextUsage): ProviderContextEvent {
  return { type: "usage", session: { providerId: "codex", sessionId }, usage: value };
}

function compactionEvent(itemId: string, phase: "started" | "completed" | "failed"): ProviderContextEvent {
  return {
    type: "compaction",
    session: { providerId: "codex", sessionId },
    itemId,
    phase,
    occurredAt: phase === "started" ? "2026-08-24T00:01:00.000Z" : "2026-08-24T00:02:00.000Z",
  };
}

function usage(overrides: Partial<ProviderContextUsage> = {}): ProviderContextUsage {
  return {
    total: breakdown(30, 20, 5),
    last: breakdown(10, 7, 2),
    contextUsedTokens: 9,
    modelContextWindow: 100,
    updatedAt: "2026-08-24T00:00:30.000Z",
    ...overrides,
  };
}

function breakdown(totalTokens: number, inputTokens: number, cachedInputTokens: number) {
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens: 3, reasoningOutputTokens: 1 };
}

function compactRequest(conversationId: string, contextRevision: string, clientRequestId: string) {
  return { projectId, productMode: "agent" as const, conversationId, providerId: "codex", contextRevision, clientRequestId };
}

function capabilitySnapshot() {
  return {
    providerId: "codex",
    displayName: "Codex",
    productMode: "agent" as const,
    status: "ready" as const,
    runnable: true,
    checkedAt: "2026-08-24T00:00:00.000Z",
    snapshotHash: "context-capability",
    snapshotVersion: 1,
    effectiveModel: "gpt-test",
    effectiveModelSource: "provider-default" as const,
    degradedReasons: [],
    capabilities: [
      { key: "context.usage" as const, label: "Context usage", spec: "supported" as const, runtime: "ready" as const, summary: "ready" },
      { key: "context.compact" as const, label: "Context compact", spec: "supported" as const, runtime: "ready" as const, summary: "ready" },
    ],
  };
}
