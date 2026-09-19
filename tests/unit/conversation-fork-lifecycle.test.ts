import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedProject } from "../../src/types/index.js";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { ConversationForkLifecycleOwner, type ConversationForkRequest } from "../../src/workbench/conversation-fork-lifecycle.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { listWorkbenchTopics } from "../../src/workbench/projections/read-model/implementation.js";
import { projectCanonicalTimelineEnvelope } from "../../src/workbench/canonical-timeline-projector.js";

const projectId = "fork-project";
const conversationId = "conversation-source";
const graphScopeId = "graph-source";
const sourceSessionId = "private-source-thread";
let root: string;
let paths: ProjectRuntimePaths;
let project: ManagedProject;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-conversation-fork-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  paths = resolveProjectRuntimePaths(projectId, join(root, "aho-home"));
  project = {
    id: projectId,
    name: "Fork Project",
    path: projectRoot,
    addedAt: "2026-08-27T00:00:00.000Z",
    lastSeenAt: "2026-08-27T00:00:00.000Z",
    defaultProviderId: "codex",
  };
  await seedCompletedConversation();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("ConversationForkLifecycleOwner", () => {
  it("forks through an older completed Main Turn and replays without another Provider call", async () => {
    const sourceDatabase = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      sourceDatabase.conversations.updateAgentAccess({ projectId, conversationId, providerId: "codex",
        expectedRevision: 0, accessMode: "full-access", updatedAt: "2026-08-27T00:00:01.000Z" });
    } finally { sourceDatabase.close(); }
    const forkSession = vi.fn(async () => ({
      session: { providerId: "codex", sessionId: "private-child-thread" },
      inheritedThroughTurn: { providerId: "codex", sessionId: "private-child-thread", turnId: "turn-1" },
    }));
    const owner = createOwner(forkSession);
    const request = await forkRequest("assistant-1", 1, "fork-request-1");

    const receipt = await owner.fork(project, request);
    expect(receipt).toMatchObject({ status: "forked", sourceConversationId: conversationId });
    expect(forkSession).toHaveBeenCalledOnce();

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const source = database.conversations.readConversation(projectId, conversationId)!;
      const target = database.conversations.readConversation(projectId, receipt.targetConversationId)!;
      expect(source).toMatchObject({ completedTurnSequence: 2, timelinePosition: 4 });
      expect(target).toMatchObject({
        productMode: "agent",
        agentAccessMode: "default",
        agentAccessRevision: 0,
        agentTurnMode: "plan",
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
        selectedProviderId: "codex",
        completedTurnSequence: 1,
      });
      expect(database.providerAttempts.readConversationProviderBinding(projectId, target.conversationId, "codex")).toMatchObject({
        nativeSessionId: "private-child-thread",
        bindingStatus: "ready",
        lastDeliveredCompletedTurn: 1,
      });
      const targetRows = database.timeline.listConversationMessages(projectId, target.conversationId);
      expect(targetRows.map((row) => row.text)).toEqual([
        "first question",
        "first answer",
        "此会话从源会话的已完成回合创建。源会话保持不变，项目文件没有被恢复或修改。",
      ]);
      const serialized = JSON.stringify(targetRows);
      expect(serialized).not.toContain(sourceSessionId);
      expect(serialized).not.toContain("attempt-1");
      expect(serialized).not.toContain("turn-1");
      expect(serialized).not.toContain("private-parent-thread");
      expect(serialized).not.toContain("private-native-session");
      expect(serialized).not.toContain("private-provider-error");
      const copiedAssistant = targetRows.find((row) => row.text === "first answer")!;
      expect(projectCanonicalTimelineEnvelope(copiedAssistant, "agent").cells).toEqual([
        expect.objectContaining({
          kind: "assistant-message",
          source: "provider-runtime",
          text: "first answer",
          status: "completed",
        }),
      ]);
      expect(JSON.stringify(projectCanonicalTimelineEnvelope(copiedAssistant, "agent"))).not.toContain("attempt-1");
      expect(JSON.stringify(projectCanonicalTimelineEnvelope(copiedAssistant, "agent"))).not.toContain("turn-1");
      expect(database.skills.listSkillEnablement(projectId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ changeId: target.conversationId, skillId: "skill-a", scope: "topic", enabled: true }),
      ]));
      expect(database.conversationForks.readByTargetConversation(projectId, target.conversationId)).toMatchObject({
        status: "completed",
        sourceConversationId: conversationId,
        sourceMessageId: "assistant-1",
      });
    } finally {
      database.close();
    }
    await expect(listWorkbenchTopics({
      project,
      path: project.path,
      runtimeStateResolver: async () => ({ state: "onboarding", paths }),
    }, "agent")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: receipt.targetConversationId,
        forkBoundary: {
          sourceConversationId: conversationId,
          sourceMessageId: "assistant-1",
          completedTurnSequence: 1,
          sourceDeleted: false,
        },
      }),
    ]));

    await expect(owner.fork(project, request)).resolves.toMatchObject({
      status: "replayed",
      targetConversationId: receipt.targetConversationId,
    });
    expect(forkSession).toHaveBeenCalledOnce();
  });

  it("fails Harness, stale revisions, active Turn, and pending interaction before Provider I/O", async () => {
    const forkSession = vi.fn();
    const base = await forkRequest("assistant-2", 2, "fork-request-blocked");
    await expect(createOwner(forkSession).fork(project, { ...base, productMode: "harness" }))
      .rejects.toMatchObject({ name: "Conflict" });
    await expect(createOwner(forkSession).fork(project, { ...base, expectedTimelineRevision: base.expectedTimelineRevision - 1 }))
      .rejects.toMatchObject({ name: "Conflict" });
    await expect(createOwner(forkSession, { turnState: "running" }).fork(project, base))
      .rejects.toMatchObject({ name: "Conflict" });

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.timeline.appendMessage(message("interaction-pending", "provider.user-input", "", null, null, {
        graphScopeId,
        providerUserInput: { status: "pending" },
      }));
    } finally { database.close(); }
    const pendingRequest = await forkRequest("assistant-2", 2, "fork-request-pending");
    await expect(createOwner(forkSession).fork(project, pendingRequest)).rejects.toMatchObject({ name: "Conflict" });
    expect(forkSession).not.toHaveBeenCalled();
  });

  it("keeps uncertain transport submitting and interrupts it on restart without replay", async () => {
    const forkSession = vi.fn(async () => { throw new Error("connection lost after write"); });
    const owner = createOwner(forkSession);
    const request = await forkRequest("assistant-2", 2, "fork-request-uncertain");
    await expect(owner.fork(project, request)).rejects.toMatchObject({ name: "ProviderSessionForkUncertain" });
    await expect(owner.fork(project, request)).rejects.toMatchObject({ name: "ProviderSessionForkUncertain" });
    expect(forkSession).toHaveBeenCalledOnce();

    const restarted = createOwner(vi.fn());
    await expect(restarted.reconcileProject(paths)).resolves.toBe(1);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversationForks.read(projectId, request.clientRequestId)).toMatchObject({ status: "interrupted" });
      expect(database.conversations.listConversations(projectId, "agent")).toHaveLength(1);
    } finally { database.close(); }
  });

  it("persists a bounded provider-neutral stage for an uncertain transport timeout", async () => {
    const transport = Object.assign(new Error("private thread id must not escape"), {
      name: "ProviderSessionForkTransportUncertain",
      stage: "child-create",
      timeoutMs: 30_000,
    });
    const forkSession = vi.fn(async () => { throw transport; });
    const request = await forkRequest("assistant-2", 2, "fork-request-stage-timeout");

    await expect(createOwner(forkSession).fork(project, request)).rejects.toMatchObject({
      name: "ProviderSessionForkUncertain",
      message: expect.stringContaining("child-create after 30000ms"),
    });
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const operation = database.conversationForks.read(projectId, request.clientRequestId)!;
      expect(operation).toMatchObject({
        status: "submitting",
        diagnostic: "Conversation fork transport outcome is uncertain during child-create after 30000ms.",
      });
      expect(JSON.stringify(operation)).not.toContain(sourceSessionId);
      expect(JSON.stringify(operation)).not.toContain("private thread id");
    } finally { database.close(); }
  });

  it("materializes accepted Provider evidence without re-admitting a changed source", async () => {
    const forkSession = vi.fn(async () => {
      const database = new Database(paths.workbenchDbPath);
      try {
        database.exec(`
          CREATE TRIGGER fail_fork_materialization
          BEFORE INSERT ON conversations
          WHEN NEW.conversation_id <> '${conversationId}'
          BEGIN
            SELECT RAISE(ABORT, 'forced local materialization failure');
          END;
        `);
      } finally { database.close(); }
      return {
        session: { providerId: "codex", sessionId: "private-accepted-thread" },
        inheritedThroughTurn: { providerId: "codex", sessionId: "private-accepted-thread", turnId: "turn-2" },
      };
    });
    const owner = createOwner(forkSession);
    const request = await forkRequest("assistant-2", 2, "fork-request-accepted-repair");

    await expect(owner.fork(project, request)).rejects.toThrow("这个项目的数据完整性检查未通过。");

    const triggerDatabase = new Database(paths.workbenchDbPath);
    try { triggerDatabase.exec("DROP TRIGGER fail_fork_materialization;"); }
    finally { triggerDatabase.close(); }
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.timeline.appendMessage(message("later-source-fact", "system.event", "later", null, null, { graphScopeId }));
    } finally { database.close(); }

    await expect(owner.fork(project, request)).resolves.toMatchObject({ status: "replayed" });
    expect(forkSession).toHaveBeenCalledOnce();
  });

  it("recovers an explicitly stale Agent session through the exact last successful Turn", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const now = "2026-08-27T00:01:00.000Z";
      database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId,
        attemptId: "attempt-stale-3",
        productMode: "agent",
        agentTurnMode: "plan",
        graphScopeId,
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        operationProfile: "agent",
        providerId: "codex",
        nativeSessionId: sourceSessionId,
        model: { providerId: "codex", modelId: "gpt-test" },
        reasoningEffort: "high",
        capabilitySnapshot: capabilitySnapshot(),
        effectiveSkillInputs: [],
        handoffHash: "handoff-stale-3",
        deliveredThroughCompletedTurn: 2,
        worktreeId: null,
        status: "failed",
        createdAt: now,
        updatedAt: now,
      });
      database.timeline.appendMessage({
        ...message("assistant-stale-3", "assistant.message", "session stale", sourceSessionId, null, {
          graphScopeId,
          attemptId: "attempt-stale-3",
          sessionRecovery: { sourceMessageId: "assistant-2", providerId: "codex", completedTurnSequence: 2 },
        }),
        status: "failed",
      });
      database.providerAttempts.writeConversationProviderBinding({
        projectId,
        conversationId,
        providerId: "codex",
        nativeSessionId: sourceSessionId,
        lastDeliveredCompletedTurn: 2,
        preferredModel: { providerId: "codex", modelId: "gpt-test" },
        lastUsedAt: now,
        bindingStatus: "stale",
      });
    } finally { database.close(); }

    const forkSession = vi.fn(async () => ({
      session: { providerId: "codex", sessionId: "private-recovery-thread" },
      inheritedThroughTurn: { providerId: "codex", sessionId: "private-recovery-thread", turnId: "turn-2" },
    }));
    const request = await forkRequest("assistant-2", 2, "fork-recovery-1");
    await expect(createOwner(forkSession).fork(project, request)).resolves.toMatchObject({ status: "forked" });
    expect(forkSession).toHaveBeenCalledOnce();
  });

  it("recovers a stale native Review through the existing fork owner", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const now = "2026-09-01T00:01:00.000Z";
      database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId,
        attemptId: "attempt-review-stale",
        productMode: "agent",
        agentTurnMode: null,
        operationKind: "review",
        graphScopeId,
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        operationProfile: "agent",
        providerId: "codex",
        nativeSessionId: sourceSessionId,
        model: null,
        reasoningEffort: null,
        capabilitySnapshot: capabilitySnapshot(),
        effectiveSkillInputs: [],
        handoffHash: "handoff-review-stale",
        deliveredThroughCompletedTurn: 2,
        worktreeId: null,
        status: "failed",
        createdAt: now,
        updatedAt: now,
      });
      database.timeline.appendMessage({
        ...message("review-stale", "provider.review", "session stale", sourceSessionId, null, {
          graphScopeId,
          attemptId: "attempt-review-stale",
          sessionRecovery: { sourceMessageId: "assistant-2", providerId: "codex", completedTurnSequence: 2 },
        }),
        status: "failed",
        providerId: "codex",
      });
      database.providerAttempts.writeConversationProviderBinding({
        projectId,
        conversationId,
        providerId: "codex",
        nativeSessionId: sourceSessionId,
        lastDeliveredCompletedTurn: 2,
        preferredModel: { providerId: "codex", modelId: "gpt-test" },
        lastUsedAt: now,
        bindingStatus: "stale",
      });
    } finally { database.close(); }

    const forkSession = vi.fn(async () => ({
      session: { providerId: "codex", sessionId: "private-review-recovery-thread" },
      inheritedThroughTurn: { providerId: "codex", sessionId: "private-review-recovery-thread", turnId: "turn-2" },
    }));
    const request = await forkRequest("assistant-2", 2, "fork-review-recovery-1");
    await expect(createOwner(forkSession).fork(project, request)).resolves.toMatchObject({ status: "forked" });
    expect(forkSession).toHaveBeenCalledOnce();
  });

  it("records bounded rejection evidence and requires a new client request", async () => {
    const rejection = new Error(`thread ${sourceSessionId} rejected secret-provider-detail`);
    rejection.name = "ProviderSessionForkRejected";
    const forkSession = vi.fn(async () => { throw rejection; });
    const owner = createOwner(forkSession);
    const request = await forkRequest("assistant-2", 2, "fork-request-rejected");
    await expect(owner.fork(project, request)).rejects.toMatchObject({ name: "Conflict" });
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const operation = database.conversationForks.read(projectId, request.clientRequestId)!;
      expect(operation).toMatchObject({ status: "failed" });
      expect(JSON.stringify(operation)).not.toContain(sourceSessionId);
      expect(JSON.stringify(operation)).not.toContain("secret-provider-detail");
    } finally { database.close(); }
    await expect(owner.fork(project, request)).rejects.toMatchObject({ name: "Conflict" });
    expect(forkSession).toHaveBeenCalledOnce();
  });
});

function createOwner(
  forkSession: (...args: never[]) => Promise<unknown>,
  options: { turnState?: "idle" | "running" | "stopping"; contextLifecycle?: "idle" | "submitting" | "compacting" } = {},
): ConversationForkLifecycleOwner {
  return new ConversationForkLifecycleOwner({
    providerRegistry: {
      get: () => ({
        capabilitySnapshot: async () => capabilitySnapshot(),
        conversation: { forkSession },
      }),
      findActiveTurn: () => null,
    } as never,
    projectRuntimeCoordinator: { resolve: async () => ({ state: "onboarding", paths }) } as never,
    turnControl: {
      state: () => ({ state: options.turnState ?? "idle", canInterrupt: false, canSteer: false, steerState: "idle" }),
    } as never,
    conversationContext: {
      read: async () => ({
        providerId: "codex",
        contextRevision: "context-revision",
        usage: null,
        usedPercent: null,
        remainingPercent: null,
        lifecycle: options.contextLifecycle ?? "idle",
        source: null,
        lastCompactedAt: null,
        canCompact: true,
      }),
    } as never,
  });
}

async function seedCompletedConversation(): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const now = "2026-08-27T00:00:00.000Z";
    database.conversations.createConversation({
      projectId,
      conversationId,
      productMode: "agent",
      agentTurnMode: "plan",
      agentModelId: "gpt-test",
      agentReasoningEffort: "high",
      title: "Source Conversation",
      state: "active",
      boundChangeId: null,
      currentGraphScopeId: graphScopeId,
      selectedProviderId: "codex",
      completedTurnSequence: 2,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    database.conversations.initializeConversationGraphScope(projectId, conversationId, graphScopeId, now);
    for (const sequence of [1, 2]) {
      database.providerAttempts.createProviderAttempt({
        projectId,
        conversationId,
        attemptId: `attempt-${sequence}`,
        productMode: "agent",
        agentTurnMode: "plan",
        graphScopeId,
        changeId: null,
        agentTaskId: null,
        roleId: "main-agent",
        operationProfile: "agent",
        providerId: "codex",
        nativeSessionId: sourceSessionId,
        model: { providerId: "codex", modelId: "gpt-test" },
        reasoningEffort: "high",
        capabilitySnapshot: capabilitySnapshot(),
        effectiveSkillInputs: [],
        handoffHash: `handoff-${sequence}`,
        deliveredThroughCompletedTurn: sequence - 1,
        worktreeId: null,
        status: "completed",
        createdAt: now,
        updatedAt: now,
      });
      database.timeline.appendMessage(message(`user-${sequence}`, "user.message", sequence === 1 ? "first question" : "second question", null, null, {
        graphScopeId,
        completedTurnSequence: sequence,
      }));
      database.timeline.appendMessage({ ...message(`assistant-${sequence}`, "assistant.message", sequence === 1 ? "first answer" : "second answer", sourceSessionId, `turn-${sequence}`, {
        graphScopeId,
        attemptId: `attempt-${sequence}`,
        completedTurnSequence: sequence,
        parentThreadId: "private-parent-thread",
        nativeSessionId: "private-native-session",
        blocks: [{ id: `private-item-${sequence}`, attemptId: `attempt-${sequence}`, threadId: sourceSessionId, turnId: `turn-${sequence}`, itemId: `item-${sequence}`, kind: "prose", source: "provider", sequence: 1, timestamp: now, text: "answer" }],
      }), ...(sequence === 1 ? { error: "private-provider-error" } : {}) });
    }
    database.providerAttempts.writeConversationProviderBinding({
      projectId,
      conversationId,
      providerId: "codex",
      nativeSessionId: sourceSessionId,
      lastDeliveredCompletedTurn: 2,
      preferredModel: { providerId: "codex", modelId: "gpt-test" },
      lastUsedAt: now,
      bindingStatus: "ready",
    });
    database.skills.setSkillEnablement({ projectId, changeId: conversationId, skillId: "skill-a", scope: "topic", enabled: true, updatedAt: now });
  } finally { database.close(); }
}

function message(id: string, type: string, text: string, threadId: string | null, turnId: string | null, raw: Record<string, unknown>) {
  return {
    id,
    projectId,
    conversationId,
    changeId: "",
    agentSurfaceId: "main-agent",
    type,
    timestamp: "2026-08-27T00:00:00.000Z",
    text,
    actionRunId: null,
    actionType: null,
    status: type === "assistant.message" ? "completed" : null,
    runId: null,
    providerId: type === "assistant.message" ? "codex" : null,
    threadId,
    turnId,
    itemId: null,
    artifact: null,
    error: null,
    rawJson: JSON.stringify(raw),
  };
}

async function forkRequest(sourceMessageId: string, sequence: number, clientRequestId: string): Promise<ConversationForkRequest> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const conversation = database.conversations.readConversation(projectId, conversationId)!;
    return {
      projectId,
      productMode: "agent",
      conversationId,
      providerId: "codex",
      sourceMessageId,
      expectedCompletedTurnSequence: sequence,
      expectedTimelineRevision: conversation.timelineRevision,
      contextRevision: "context-revision",
      clientRequestId,
    };
  } finally { database.close(); }
}

function capabilitySnapshot() {
  return {
    providerId: "codex",
    displayName: "Codex",
    productMode: "agent" as const,
    status: "ready" as const,
    runnable: true,
    checkedAt: "2026-08-27T00:00:00.000Z",
    snapshotHash: "fork-capability",
    snapshotVersion: 1,
    effectiveModel: "gpt-test",
    effectiveModelSource: "provider-default" as const,
    degradedReasons: [],
    capabilities: [{ key: "session.fork" as const, label: "Fork", spec: "supported" as const, runtime: "ready" as const, summary: "ready" }],
  };
}
