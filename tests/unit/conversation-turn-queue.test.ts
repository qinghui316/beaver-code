import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import type { ManagedProject } from "../../src/types/index.js";
import { createTopicAttachment } from "../../src/workbench/attachments.js";
import { ConversationInputDeliveryService, ConversationInputRejected } from "../../src/workbench/conversation-input-delivery.js";
import type { ConversationQueuedReviewDispatchPort } from "../../src/workbench/conversation-queued-review-dispatch.js";
import type { postConversationMessage as PostConversationMessage } from "../../src/workbench/conversation-service.js";
import { ConversationTurnQueueOwner } from "../../src/workbench/conversation-turn-queue.js";
import {
  defaultProviderRegistry,
  defaultExecutionContractRegistry,
  EXECUTION_CONTRACT_FAMILIES,
  ExecutionContractRegistry,
  resolveStoredExecutionContract,
  type ExecutionContractFamily,
} from "../../src/provider-runtime/index.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { WorkbenchUpdateRequestGate } from "../../src/server/workbench/update-request-gate.js";
import { ConversationTurnControlOwner } from "../../src/workbench/conversation-turn-control.js";
import { ProviderRegistry } from "../../src/provider-runtime/registry.js";
import type { ConversationQueueGuideRequest } from "../../src/workbench/conversation-turn-queue-contract.js";

const projectId = "conversation-turn-queue-project";
const conversationId = "conversation-agent";
const now = "2026-08-28T00:00:00.000Z";
let root: string;
let previousAhoHome: string | undefined;
let paths: ProjectRuntimePaths;
let project: ManagedProject;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-conversation-turn-queue-"));
  previousAhoHome = process.env.AHO_HOME;
  process.env.AHO_HOME = join(root, ".aho-home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  paths = resolveProjectRuntimePaths(projectId, process.env.AHO_HOME);
  project = {
    id: projectId,
    name: "Conversation Turn Queue",
    path: projectRoot,
    addedAt: now,
    lastSeenAt: now,
  };
  await seedConversation("agent");
});

afterEach(async () => {
  if (previousAhoHome === undefined) delete process.env.AHO_HOME;
  else process.env.AHO_HOME = previousAhoHome;
  await rm(root, { recursive: true, force: true });
});

describe("ConversationTurnQueueOwner", () => {
  it.each(["agent", "harness"] as const)("dispatches %s input through real admission and atomic message acceptance", async (productMode) => {
    const targetId = productMode === "agent" ? conversationId : "harness-real-delivery";
    if (productMode === "harness") await seedConversation(productMode, targetId);
    const runtime = productMode === "agent" ? { state: "onboarding", paths } as const
      : { state: "ready", resolution: { paths, projectRoot: project.path, harness: { projectId, skillRoot: root } } } as const;
    const admit = vi.fn(async (input) => ({ ...input, runtimeState: runtime }));
    const route = vi.fn(async (input) => ({ user: { id: input.committedMessage.id, text: input.committedMessage.text }, assistant: {} }));
    const turnRouter = { resolveProviderId: () => "codex", resolveRuntimeState: async () => runtime, assertRequestedMode: () => undefined,
      switchProviderAtSafePoint: async () => ({ selectedProviderId: "codex" }),
      resolveAttachments: async () => [], admit, route } as never;
    const coordinator = { resolve: async () => runtime } as never;
    const owner = new ConversationTurnQueueOwner({ projectRuntimeCoordinator: coordinator,
      providerRegistry: defaultProviderRegistry, executionContractRegistry: defaultExecutionContractRegistry,
      delivery: new ConversationInputDeliveryService({ projectRuntimeCoordinator: coordinator, turnRouter,
        turnControl: {} as never, reviewDispatch: {} as never }) });
    const draftDb = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const draft = draftDb.drafts.readDraft(projectId, productMode)!;
      draftDb.drafts.upsertDraft({ ...draft, contextRefsJson: "[]", attachmentIdsJson: "[]", skillOverridesJson: "{}" }, draft.updatedAt);
    } finally { draftDb.close(); }
    const initial = await owner.read(project, productMode, targetId);
    const queued = await owner.enqueue(project, { ...queueRequest(initial.revision, initial.executionRevision!),
      productMode, conversationId: targetId, clientRequestId: `${productMode}-real-queue`,
      contextRefs: [], attachmentIds: [], skillOverrides: {},
      agentTurnMode: productMode === "agent" ? "plan" : null });
    const result = await owner.dispatchNext(project, productMode, targetId, queued.revision);
    expect(result.items).toEqual([]);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ productMode, conversationId: targetId }));
    expect(route).toHaveBeenCalledOnce();
    const db = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(db.timeline.listConversationMessages(projectId, targetId).filter((row) => row.type === "user.message")).toHaveLength(1);
      expect(db.conversationTurnQueues.listDeliveries(projectId, targetId)[0]?.phase).toBe("completed");
    } finally { db.close(); }
  });
  it("claims a selected non-head input once, retains FIFO order and commits accepted steering", async () => {
    await insertRunningAttempt("guide-attempt", true);
    let accept!: () => void;
    const held = new Promise<void>((resolve) => { accept = resolve; });
    const steer = vi.fn(async (_project, _request, onAccepted) => {
      await held;
      onAccepted({ status: "steer-accepted", attemptId: "guide-attempt", runId: "guide-run" });
      return { status: "steer-accepted", attemptId: "guide-attempt", runId: "guide-run" } as const;
    });
    const owner = createGuideOwner({ steer } as never);
    const queued = await enqueueGuideInputs(owner, false);
    expect(queued.items.map((item) => item.guideMode)).toEqual(["steer", "steer"]);
    const request = guideRequest(queued);
    const pending = owner.guide(project, request);
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    await owner.guide(project, request);
    await expect(owner.remove(project, "agent", conversationId, request.queueItemId, queued.revision)).rejects.toThrow();
    const waiting = await owner.read(project, "agent", conversationId);
    expect(waiting.canDispatch).toBe(false);
    expect(waiting.items[0]?.status).toBe("queued");
    expect(waiting.items[1]).toMatchObject({ status: "dispatching", guideMode: "unavailable" });
    accept();
    const result = await pending;
    expect(result.items.map((item) => item.text)).toEqual(["first"]);
    const db = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(db.timeline.listConversationMessages(projectId, conversationId).filter((row) => row.type === "user.message")).toEqual([expect.objectContaining({ text: "second" })]);
      expect(db.conversationTurnQueues.readDelivery(projectId, conversationId, request.clientRequestId)?.phase).toBe("completed");
    } finally { db.close(); }
    await owner.guide(project, request);
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown steering held through recovery and never falls back to another turn", async () => {
    await insertRunningAttempt("guide-attempt", true);
    const steer = vi.fn(async () => { throw new Error("connection closed after invocation"); });
    const interrupt = vi.fn();
    const owner = createGuideOwner({ steer, interrupt } as never);
    const queued = await enqueueGuideInputs(owner, false);
    const request = guideRequest(queued);
    await expect(owner.guide(project, request)).rejects.toThrow();
    const snapshot = await owner.read(project, "agent", conversationId);
    expect(snapshot.items[1]).toMatchObject({ status: "dispatching", deliveryUncertain: true });
    await owner.reconcileProject(paths);
    await owner.guide(project, request);
    expect((await owner.read(project, "agent", conversationId)).canDispatch).toBe(false);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("proves a guide revision rejection did not claim or invoke any delivery", async () => {
    await insertRunningAttempt("guide-attempt", true);
    const steer = vi.fn();
    const owner = createGuideOwner({ steer } as never);
    const queued = await enqueueGuideInputs(owner, false);
    const request = { ...guideRequest(queued), expectedRevision: "queue:0" };
    await expect(owner.guide(project, request)).rejects.toMatchObject({ name: "Conflict", queueAdmissionRejected: true });
    const db = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(db.conversationTurnQueues.readDelivery(projectId, conversationId, request.clientRequestId)).toBeNull();
      expect(db.conversationTurnQueues.listItems(projectId, conversationId).every((item) => item.status === "queued")).toBe(true);
    } finally { db.close(); }
    expect(steer).not.toHaveBeenCalled();
  });

  it("waits for durable termination before cutover and releases UI waiting on user-message acceptance", async () => {
    await insertRunningAttempt("guide-attempt", true);
    let terminal!: () => void;
    let finish!: () => void;
    const terminated = new Promise<void>((resolve) => { terminal = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const interrupt = vi.fn(async () => ({ status: "interrupt-requested", attemptId: "guide-attempt", runId: "guide-run" }));
    const post = vi.fn(async (_project, _conversation, input) => {
      const db = await openProjectRuntimeWorkbenchDatabase(paths);
      try {
        db.unitOfWork.assertConversationQueueAdmission(projectId, conversationId, input.queuedTurnDispatch, false);
        const message = db.timeline.appendMessage({ ...canonicalQueueMessage(input.clientRequestId, input.queuedTurnDispatch.requestHash), text: input.message });
        db.unitOfWork.acceptQueuedInput(projectId, conversationId, input.queuedTurnDispatch, message.id);
      } finally { db.close(); }
      await finished;
      return {} as never;
    });
    const owner = createGuideOwner({ interrupt, waitForTerminal: async () => { await terminated; } } as never, post as never);
    const queued = await enqueueGuideInputs(owner, true);
    expect(queued.items[1]?.guideMode).toBe("cutover");
    const pending = owner.guide(project, guideRequest(queued));
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
    expect(post).not.toHaveBeenCalled();
    const db = await openProjectRuntimeWorkbenchDatabase(paths);
    try { db.providerAttempts.completeProviderAttempt(projectId, "guide-attempt", "completed", null, now); }
    finally { db.close(); }
    terminal();
    const accepted = await pending;
    expect(post).toHaveBeenCalledTimes(1);
    expect(accepted.items.map((item) => item.text)).toEqual(["first"]);
    expect(accepted.canDispatch).toBe(false);
    const args = post.mock.calls[0]![2];
    expect(args).toMatchObject({ message: "second", contextRefs: [{ relativePath: "src/app.ts", name: "app.ts", kind: "file", source: "composer" }], agentTurnMode: "plan", modelId: "gpt-test", reasoningEffort: "high" });
    finish();
    await vi.waitFor(async () => expect((await owner.read(project, "agent", conversationId)).canDispatch).toBe(true));
  });

  it("restores a definitively rejected cutover at its original position", async () => {
    await insertRunningAttempt("guide-attempt", true);
    const owner = createGuideOwner({ interrupt: async () => { throw new Error("stop explicitly rejected"); } } as never);
    const queued = await enqueueGuideInputs(owner, true);
    const result = await owner.guide(project, guideRequest(queued));
    expect(result.items.map((item) => [item.text, item.position, item.status])).toEqual([["first", 1, "queued"], ["second", 2, "blocked"]]);
    expect(result.items[1]?.deliveryUncertain).toBe(false);
  });

  it("captures access independently of subsequent Composer selection and preserves enqueue identity", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.conversations.updateAgentAccess({ projectId, conversationId, providerId: "codex",
        expectedRevision: 0, accessMode: "full-access", updatedAt: now });
    } finally { database.close(); }
    const request = { ...queueRequest(initial.revision, initial.executionRevision!),
      agentAccessMode: "full-access" as const, expectedAccessRevision: 1 };
    const queued = await owner.enqueue(project, request);
    expect(queued.items[0]?.agentAccessMode).toBe("full-access");
    const after = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      after.conversations.updateAgentAccess({ projectId, conversationId, providerId: "codex",
        expectedRevision: 1, accessMode: "default", updatedAt: now });
      expect(after.conversationTurnQueues.listItems(projectId, conversationId)[0]?.agentAccessMode).toBe("full-access");
    } finally { after.close(); }
    expect((await owner.enqueue(project, request)).items[0]?.agentAccessMode).toBe("full-access");
    await expect(owner.enqueue(project, { ...request, agentAccessMode: "default" })).rejects.toThrow();
  });

  it("rejects stale access selection atomically without clearing the draft", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    await expect(owner.enqueue(project, { ...queueRequest(initial.revision, initial.executionRevision!),
      agentAccessMode: "full-access", expectedAccessRevision: 0 })).rejects.toThrow(/access changed/);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversationTurnQueues.listItems(projectId, conversationId)).toEqual([]);
      expect(database.drafts.readDraft(projectId, "agent")?.text).not.toBe("");
    } finally { database.close(); }
  });

  it("exposes managed execution admission before a queued long Turn completes", async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const requestGate = new WorkbenchUpdateRequestGate();
    const turnControl = new ConversationTurnControlOwner({
      providerRegistry: new ProviderRegistry(),
      projectRuntimeCoordinator: { resolve: async () => ({ state: "onboarding", paths }) } as never,
    });
    const releaseObserver = turnControl.subscribeAdmission(() => requestGate.managedExecutionRegistered());
    const lease = requestGate.begin("mutation");
    let admitted = false;
    const registration = {
      projectId, productMode: "agent" as const, conversationId, graphScopeId: "graph-current",
      expectedAttemptId: "queued-attempt", runId: "queued-run", providerId: "codex",
      roleId: "main-agent" as const, canSteer: false,
    };
    const owner = createOwner(async () => {
      turnControl.registerAttempt(registration);
      admitted = true;
      await held;
      turnControl.release(registration);
      return {} as never;
    });
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const dispatch = requestGate.runTracked(lease, () => owner.dispatchNext(project, "agent", conversationId, queued.revision));
    await vi.waitFor(() => expect(admitted).toBe(true));
    const release = requestGate.pause("update");
    await requestGate.drain(new AbortController().signal);
    finish();
    await dispatch;
    lease.complete("settled");
    release();
    releaseObserver();
  });
  it("atomically captures a full Agent draft, clears sendable fields, and replays the exact enqueue", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const request = queueRequest(initial.revision, initial.executionRevision!);

    const queued = await owner.enqueue(project, request);
    expect(queued.items).toEqual([
      expect.objectContaining({
        position: 1,
        status: "queued",
        text: "queued follow-up",
        contextRefs: [{ relativePath: "src/app.ts", name: "app.ts", kind: "file", source: "composer" }],
        attachmentIds: ["attachment-1"],
        skillOverrides: { reviewer: true },
        providerId: "codex",
        agentTurnMode: "plan",
        modelId: "gpt-test",
        reasoningEffort: "high",
      }),
    ]);
    expect(queued.revision).toBe("queue:1");

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.drafts.readDraft(projectId, "agent")).toMatchObject({
        text: "",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        agentTurnMode: "plan",
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
        selectedProviderId: "codex",
      });
      expect(database.timeline.listConversationMessages(projectId, conversationId)).toEqual([]);
      expect(database.providerAttempts.listProviderAttempts(projectId, conversationId)).toEqual([]);
    } finally {
      database.close();
    }

    await expect(owner.enqueue(project, request)).resolves.toMatchObject({ revision: "queue:1" });
    await expect(owner.enqueue(project, { ...request, text: "different content" }))
      .rejects.toMatchObject({ name: "Conflict" });
    await expect(owner.enqueue(project, { ...request, projectId: "other-project" }))
      .rejects.toMatchObject({ name: "Conflict" });
    await expect(owner.enqueue(project, { ...request, expectedExecutionRevision: "execution:forged" }))
      .rejects.toMatchObject({ name: "Conflict" });
  });

  it("persists an AHO Main model selection without treating it as an Agent turn mode", async () => {
    const harnessConversationId = "conversation-harness";
    await seedConversation("harness", harnessConversationId);
    const owner = createOwner();
    const initial = await owner.read(project, "harness", harnessConversationId);

    const queued = await owner.enqueue(project, {
      projectId,
      productMode: "harness",
      conversationId: harnessConversationId,
      clientRequestId: "queue-request-harness",
      expectedRevision: initial.revision,
      expectedExecutionRevision: initial.executionRevision!,
      expectedDraftUpdatedAt: now,
      text: "queued AHO follow-up",
      contextRefs: [],
      attachmentIds: [],
      skillOverrides: {},
      providerId: "codex",
      agentTurnMode: null,
      modelId: "gpt-test",
      reasoningEffort: "high",
    });

    expect(queued.items).toEqual([expect.objectContaining({
      agentTurnMode: null,
      modelId: "gpt-test",
      reasoningEffort: "high",
    })]);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.drafts.readDraft(projectId, "harness")).toMatchObject({
        agentTurnMode: null,
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
      });
    } finally {
      database.close();
    }
  });

  it("queues Review without clearing the draft and reclaims only its canonical slash command", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, {
      projectId,
      productMode: "agent",
      conversationId,
      clientRequestId: "queue-review-1",
      expectedRevision: initial.revision,
      expectedExecutionRevision: initial.executionRevision!,
      expectedDraftUpdatedAt: now,
      itemKind: "review",
      reviewTarget: { type: "base-branch", branch: "main" },
      text: "",
      contextRefs: [],
      attachmentIds: [],
      skillOverrides: {},
      providerId: "codex",
      agentTurnMode: null,
      modelId: null,
      reasoningEffort: null,
    });
    expect(queued.items).toEqual([expect.objectContaining({
      itemKind: "review",
      reviewTarget: { type: "base-branch", branch: "main" },
      text: "",
    })]);

    let database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.drafts.readDraft(projectId, "agent")).toMatchObject({
        text: "queued follow-up",
        contextRefsJson: expect.stringContaining("src/app.ts"),
        attachmentIdsJson: JSON.stringify(["attachment-1"]),
        skillOverridesJson: JSON.stringify({ reviewer: true }),
      });
    } finally {
      database.close();
    }
    await expect(owner.reclaim(project, "agent", conversationId, queued.items[0]!.queueItemId, queued.revision, now))
      .rejects.toMatchObject({ name: "Conflict" });

    database = await openProjectRuntimeWorkbenchDatabase(paths);
    let emptyDraftRevision: string;
    try {
      const draft = database.drafts.readDraft(projectId, "agent")!;
      emptyDraftRevision = "2026-08-28T00:00:01.000Z";
      database.drafts.upsertDraft({
        ...draft,
        text: "",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        agentTurnMode: "plan",
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
        selectedProviderId: "codex",
        updatedAt: emptyDraftRevision,
      }, draft.updatedAt);
    } finally {
      database.close();
    }
    const reclaimed = await owner.reclaim(
      project, "agent", conversationId, queued.items[0]!.queueItemId, queued.revision, emptyDraftRevision!,
    );
    expect(reclaimed.items).toEqual([]);
    database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.drafts.readDraft(projectId, "agent")).toMatchObject({
        text: "/review base main",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        agentTurnMode: "plan",
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
        selectedProviderId: "codex",
      });
    } finally {
      database.close();
    }
  });

  it("rejects oversized queued Review targets before persistence", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);

    await expect(owner.enqueue(project, {
      ...queueRequest(initial.revision, initial.executionRevision!),
      clientRequestId: "queue-review-oversized",
      itemKind: "review",
      reviewTarget: { type: "custom", instructions: "x".repeat(100_001) },
      text: "",
      contextRefs: [],
      attachmentIds: [],
      skillOverrides: {},
      agentTurnMode: null,
      modelId: null,
      reasoningEffort: null,
    })).rejects.toMatchObject({ name: "BadRequest" });

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversationTurnQueues.listItems(projectId, conversationId)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("dispatches mixed Review and conversation Turn items in strict FIFO order", async () => {
    const order: string[] = [];
    const reviewStart = vi.fn(async () => {
      order.push("review");
      return { conversationId, clientRequestId: "queue-dispatch", status: "completed" as const };
    });
    const post = vi.fn(async () => { order.push("turn"); });
    const owner = createOwner(post, { dispatchQueuedReview: reviewStart });
    const initial = await owner.read(project, "agent", conversationId);
    const withReview = await owner.enqueue(project, {
      projectId,
      productMode: "agent",
      conversationId,
      clientRequestId: "mixed-review",
      expectedRevision: initial.revision,
      expectedExecutionRevision: initial.executionRevision!,
      expectedDraftUpdatedAt: now,
      itemKind: "review",
      reviewTarget: { type: "uncommitted-changes" },
      text: "",
      contextRefs: [],
      attachmentIds: [],
      skillOverrides: {},
      providerId: "codex",
      agentTurnMode: null,
      modelId: null,
      reasoningEffort: null,
    });
    const withTurn = await owner.enqueue(project, {
      ...queueRequest(withReview.revision, withReview.executionRevision!),
      clientRequestId: "mixed-turn",
    });

    const afterReview = await owner.dispatchNext(project, "agent", conversationId, withTurn.revision);
    expect(order).toEqual(["review"]);
    expect(reviewStart).toHaveBeenCalledWith(project, expect.objectContaining({
      conversationId,
      target: { type: "uncommitted-changes" },
      clientRequestId: expect.stringMatching(/^queue-dispatch-/),
    }));
    expect(afterReview.items).toEqual([expect.objectContaining({ itemKind: "conversation-turn", status: "queued" })]);

    const afterTurn = await owner.dispatchNext(project, "agent", conversationId, afterReview.revision);
    expect(order).toEqual(["review", "turn"]);
    expect(afterTurn.items).toEqual([]);
  });

  it("retries a queued Review once only when admission proves zero side effects", async () => {
    const reviewStart = vi.fn()
      .mockRejectedValueOnce(new ConversationInputRejected(namedError("Conflict", "first Review admission rejection")))
      .mockRejectedValueOnce(new ConversationInputRejected(namedError("BadRequest", "second Review admission rejection")));
    const owner = createOwner(undefined, { dispatchQueuedReview: reviewStart });
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, {
      ...queueRequest(initial.revision, initial.executionRevision!),
      clientRequestId: "queued-review-safe-retry",
      itemKind: "review",
      reviewTarget: { type: "uncommitted-changes" },
      text: "",
      contextRefs: [],
      attachmentIds: [],
      skillOverrides: {},
      agentTurnMode: null,
      modelId: null,
      reasoningEffort: null,
    });

    const settled = await owner.dispatchNext(project, "agent", conversationId, queued.revision);

    expect(reviewStart).toHaveBeenCalledTimes(2);
    expect(settled.items[0]).toMatchObject({ itemKind: "review", status: "blocked", retryCount: 1 });
  });

  it("enforces queue mode isolation on persisted updates as well as inserts", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const connection = new Database(paths.workbenchDbPath);
    try {
      expect(() => connection.prepare(`
        UPDATE conversation_turn_queue_items SET agent_turn_mode = NULL
        WHERE project_id = ? AND queue_item_id = ?
      `).run(projectId, queued.items[0]!.queueItemId)).toThrow(/must match product_mode/);
      expect(() => connection.prepare(`
        UPDATE conversation_turn_queues SET product_mode = 'harness'
        WHERE project_id = ? AND conversation_id = ?
      `).run(projectId, conversationId)).toThrow(/must match active Conversation/);
    } finally {
      connection.close();
    }
  });

  it("rechecks execution identity inside the enqueue transaction", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const read = owner.read.bind(owner);
    vi.spyOn(owner, "read").mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args);
      await insertRunningAttempt("attempt-raced-enqueue");
      return snapshot;
    });

    await expect(owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!)))
      .rejects.toMatchObject({ name: "Conflict", queueAdmissionRejected: true });

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.conversationTurnQueues.listItems(projectId, conversationId)).toEqual([]);
      expect(database.drafts.readDraft(projectId, "agent")?.text).toBe("queued follow-up");
    } finally {
      database.close();
    }
  });

  it("blocks an incompatible queued Turn until the exact current execution contract is confirmed", async () => {
    const original = createOwner();
    const initial = await original.read(project, "agent", conversationId);
    const queued = await original.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const postConversationMessage = vi.fn(async () => ({}) as never);
    const upgraded = createOwner(postConversationMessage, undefined, executionRegistry({ "agent.turn": 2 }));

    const blocked = await upgraded.read(project, "agent", conversationId);
    expect(blocked.canDispatch).toBe(false);
    expect(blocked.items[0]?.executionCompatibility).toMatchObject({
      state: "confirmation-required",
      created: { family: "agent.turn", epoch: 1 },
      target: { family: "agent.turn", epoch: 2 },
    });
    await upgraded.dispatchNext(project, "agent", conversationId, blocked.revision);
    expect(postConversationMessage).not.toHaveBeenCalled();

    const blockedAfterDispatch = await upgraded.read(project, "agent", conversationId);
    expect(blockedAfterDispatch.items[0]?.status).toBe("queued");

    const compatibility = blockedAfterDispatch.items[0]!.executionCompatibility;
    if (compatibility.state === "compatible") throw new Error("Expected confirmation-required compatibility.");
    const confirmed = await upgraded.confirmExecutionContract(project, {
      productMode: "agent",
      conversationId,
      queueItemId: queued.items[0]!.queueItemId,
      expectedRevision: blockedAfterDispatch.revision,
      clientRequestId: "confirm-agent-turn-epoch-2",
      expectedCreatedContract: compatibility.created,
      expectedTargetContract: compatibility.target,
    });
    expect(confirmed.items[0]?.executionCompatibility).toEqual({ state: "compatible" });

    await upgraded.dispatchNext(project, "agent", conversationId, confirmed.revision);
    expect(postConversationMessage).toHaveBeenCalledTimes(1);
  });

  it("does not let the generic retry API bypass execution confirmation", async () => {
    const original = createOwner();
    const initial = await original.read(project, "agent", conversationId);
    const queued = await original.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const storedQueue = database.conversationTurnQueues.readQueue(projectId, conversationId)!;
      const item = database.conversationTurnQueues.readItem(projectId, conversationId, queued.items[0]!.queueItemId)!;
      const updatedAt = new Date().toISOString();
      database.conversationTurnQueues.transitionItem({
        projectId,
        conversationId,
        queueItemId: item.queueItemId,
        expectedStatus: "queued",
        status: "blocked",
        diagnostic: "Previous dispatch needs attention.",
        updatedAt,
      });
      database.conversationTurnQueues.advanceRevision(projectId, conversationId, storedQueue.revision, updatedAt);
    } finally {
      database.close();
    }

    const upgraded = createOwner(undefined, undefined, executionRegistry({ "agent.turn": 2 }));
    const blocked = await upgraded.read(project, "agent", conversationId);
    await expect(upgraded.retry(
      project,
      "agent",
      conversationId,
      blocked.items[0]!.queueItemId,
      blocked.revision,
    )).rejects.toMatchObject({ name: "Conflict" });
    expect((await upgraded.read(project, "agent", conversationId)).items[0]).toMatchObject({
      status: "blocked",
      executionCompatibility: { state: "confirmation-required" },
    });
  });

  it("requires a new confirmation after the same execution family advances again", async () => {
    const original = createOwner();
    const initial = await original.read(project, "agent", conversationId);
    await original.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const epoch2 = createOwner(undefined, undefined, executionRegistry({ "agent.turn": 2 }));
    const blocked = await epoch2.read(project, "agent", conversationId);
    const compatibility = blocked.items[0]!.executionCompatibility;
    if (compatibility.state === "compatible") throw new Error("Expected confirmation-required compatibility.");
    await epoch2.confirmExecutionContract(project, {
      productMode: "agent",
      conversationId,
      queueItemId: blocked.items[0]!.queueItemId,
      expectedRevision: blocked.revision,
      clientRequestId: "confirm-agent-turn-epoch-2",
      expectedCreatedContract: compatibility.created,
      expectedTargetContract: compatibility.target,
    });

    const epoch3 = createOwner(undefined, undefined, executionRegistry({ "agent.turn": 3 }));
    expect((await epoch3.read(project, "agent", conversationId)).items[0]?.executionCompatibility).toMatchObject({
      state: "confirmation-required",
      target: { family: "agent.turn", epoch: 3 },
    });
  });

  it("fails closed when a persisted confirmation no longer matches its source contract or request hash", async () => {
    const original = createOwner();
    const initial = await original.read(project, "agent", conversationId);
    await original.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const upgraded = createOwner(undefined, undefined, executionRegistry({ "agent.turn": 2 }));
    const blocked = await upgraded.read(project, "agent", conversationId);
    const compatibility = blocked.items[0]!.executionCompatibility;
    if (compatibility.state === "compatible") throw new Error("Expected confirmation-required compatibility.");
    await upgraded.confirmExecutionContract(project, {
      productMode: "agent",
      conversationId,
      queueItemId: blocked.items[0]!.queueItemId,
      expectedRevision: blocked.revision,
      clientRequestId: "confirm-corruption-test",
      expectedCreatedContract: compatibility.created,
      expectedTargetContract: compatibility.target,
    });

    const raw = new Database(paths.workbenchDbPath);
    try {
      raw.prepare("UPDATE conversation_turn_queue_contract_confirmations SET prior_epoch = 99")
        .run();
    } finally {
      raw.close();
    }
    expect((await upgraded.read(project, "agent", conversationId)).items[0]?.executionCompatibility.state)
      .toBe("confirmation-required");

    const repairedPrior = new Database(paths.workbenchDbPath);
    try {
      repairedPrior.prepare(`
        UPDATE conversation_turn_queue_contract_confirmations
        SET prior_epoch = 1, request_hash = ?
      `).run("0".repeat(64));
    } finally {
      repairedPrior.close();
    }
    expect((await upgraded.read(project, "agent", conversationId)).items[0]?.executionCompatibility.state)
      .toBe("confirmation-required");
  });

  it.each([
    ["unknown family", "unknown-family", 1],
    ["negative epoch", "agent.turn", -1],
    ["fractional epoch", "agent.turn", 1.5],
    ["partial legacy pair", "legacy-v0", 1],
  ])("fails closed without side effects for a Queue item with %s", async (_label, family, epoch) => {
    const original = createOwner();
    const initial = await original.read(project, "agent", conversationId);
    const queued = await original.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const item = queued.items[0]!;
    const raw = new Database(paths.workbenchDbPath);
    try {
      raw.prepare(`
        UPDATE conversation_turn_queue_items
        SET execution_contract_family = ?, execution_contract_epoch = ?
        WHERE queue_item_id = ?
      `).run(family, epoch, item.queueItemId);
    } finally {
      raw.close();
    }

    const postConversationMessage = vi.fn(async () => ({}) as never);
    const upgraded = createOwner(postConversationMessage, undefined, executionRegistry({ "agent.turn": 2 }));
    await expect(upgraded.read(project, "agent", conversationId))
      .rejects.toThrow("Conversation queued Turn has invalid execution contract");
    await expect(upgraded.confirmExecutionContract(project, {
      productMode: "agent",
      conversationId,
      queueItemId: item.queueItemId,
      expectedRevision: queued.revision,
      clientRequestId: `confirm-${String(_label).replaceAll(" ", "-")}`,
      expectedCreatedContract: { family, epoch },
      expectedTargetContract: { family: "agent.turn", epoch: 2 },
    })).rejects.toThrow("Conversation queued Turn has invalid execution contract");
    await expect(upgraded.dispatchNext(project, "agent", conversationId, queued.revision))
      .rejects.toThrow("Conversation queued Turn has invalid execution contract");
    expect(postConversationMessage).not.toHaveBeenCalled();

    const evidence = new Database(paths.workbenchDbPath, { readonly: true });
    try {
      expect(evidence.prepare("SELECT COUNT(*) AS count FROM conversation_turn_queue_contract_confirmations").get())
        .toMatchObject({ count: 0 });
      expect(evidence.prepare("SELECT status FROM conversation_turn_queue_items WHERE queue_item_id = ?").get(item.queueItemId))
        .toMatchObject({ status: "queued" });
    } finally {
      evidence.close();
    }
  });

  it("reclaims only into an unchanged empty draft and restores the complete queued input", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    const draftToken = database.drafts.readDraft(projectId, "agent")!.updatedAt;
    database.close();

    const reclaimed = await owner.reclaim(
      project,
      "agent",
      conversationId,
      queued.items[0]!.queueItemId,
      queued.revision,
      draftToken,
    );
    expect(reclaimed.items).toEqual([]);

    const restored = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(restored.drafts.readDraft(projectId, "agent")).toMatchObject({
        text: "queued follow-up",
        contextRefsJson: JSON.stringify([{ relativePath: "src/app.ts", name: "app.ts", kind: "file", source: "composer" }]),
        attachmentIdsJson: JSON.stringify(["attachment-1"]),
        skillOverridesJson: JSON.stringify({ reviewer: true }),
        agentTurnMode: "plan",
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
      });
    } finally {
      restored.close();
    }
  });

  it("rejects Agent settings in a Harness queue before persistence", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.conversations.createConversation({
        projectId,
        conversationId: "conversation-harness",
        productMode: "harness",
        agentTurnMode: null,
        agentModelId: null,
        agentReasoningEffort: null,
        title: "Harness",
        state: "active",
        boundChangeId: null,
        currentGraphScopeId: "graph-harness",
        selectedProviderId: "codex",
        completedTurnSequence: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    } finally {
      database.close();
    }
    const owner = createOwner();
    const snapshot = await owner.read(project, "harness", "conversation-harness");
    await expect(owner.enqueue(project, {
      ...queueRequest(snapshot.revision, snapshot.executionRevision!),
      conversationId: "conversation-harness",
      productMode: "harness",
    })).rejects.toMatchObject({ name: "Conflict" });
  });

  it("retries one explicit zero-side-effect dispatch failure and blocks the FIFO head after the second", async () => {
    const prepare = vi.fn()
      .mockRejectedValueOnce(namedError("Conflict", "first admission rejection"))
      .mockRejectedValueOnce(namedError("BadRequest", "second admission rejection"));
    const post = vi.fn();
    const owner = createOwner(post, undefined, undefined, prepare);
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));

    const settled = await owner.dispatchNext(project, "agent", conversationId, queued.revision);

    expect(prepare).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
    expect(settled.items[0]).toMatchObject({ status: "blocked", retryCount: 1 });
    expect(settled.canDispatch).toBe(false);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(database.skills.listSkillEnablement(projectId)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("deletes only attachments that no Draft, active queue item, or Canonical message references", async () => {
    const [draftAttachment, queuedAttachment, canonicalAttachment, orphanAttachment] = await Promise.all(
      ["draft", "queue", "canonical", "orphan"].map((name) => createTopicAttachment(project, {
        fileName: `${name}.txt`,
        mediaType: "text/plain",
        data: `data:text/plain;base64,${Buffer.from(name, "utf8").toString("base64")}`,
      }, { workbenchRoot: paths.workbenchRoot })),
    );
    const allIds = [draftAttachment.id, queuedAttachment.id, canonicalAttachment.id, orphanAttachment.id];
    const initial = await createOwner().read(project, "agent", conversationId);
    const draftToken = await replaceDraftAttachments(allIds);
    const owner = createOwner();
    const queued = await owner.enqueue(project, {
      ...queueRequest(initial.revision, initial.executionRevision!),
      expectedDraftUpdatedAt: draftToken,
      attachmentIds: allIds,
    });

    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const clearedDraft = database.drafts.readDraft(projectId, "agent")!;
      database.drafts.upsertDraft({
        ...clearedDraft,
        attachmentIdsJson: JSON.stringify([draftAttachment.id]),
        updatedAt: "2026-08-28T00:00:01.000Z",
      }, clearedDraft.updatedAt);
      const queue = database.conversationTurnQueues.readQueue(projectId, conversationId)!;
      const first = database.conversationTurnQueues.readItem(projectId, conversationId, queued.items[0]!.queueItemId)!;
      database.transaction(() => {
        database.conversationTurnQueues.insertItem({
          ...first,
          queueItemId: "queued-turn-attachment-reference",
          clientRequestId: "queue-attachment-reference",
          requestHash: "queue-attachment-reference-hash",
          dispatchRequestId: "queue-attachment-reference-dispatch",
          position: 2,
          attachmentIdsJson: JSON.stringify([queuedAttachment.id]),
        });
        database.conversationTurnQueues.advanceRevision(projectId, conversationId, queue.revision, now);
        database.timeline.appendMessage({
          ...canonicalQueueMessage("canonical-attachment", "canonical-attachment"),
          id: "canonical-attachment-reference",
          rawJson: JSON.stringify({ attachments: [{ id: canonicalAttachment.id }] }),
        });
      });
    } finally {
      database.close();
    }

    const current = await owner.read(project, "agent", conversationId);
    await owner.remove(project, "agent", conversationId, current.items[0]!.queueItemId, current.revision);

    for (const attachment of [draftAttachment, queuedAttachment, canonicalAttachment]) {
      expect(existsSync(join(paths.workbenchRoot, "attachments", attachment.id, "attachment.json"))).toBe(true);
    }
    expect(existsSync(join(paths.workbenchRoot, "attachments", orphanAttachment.id))).toBe(false);
  });

  it("keeps an uncertain dispatch claimed and never retries it", async () => {
    const post = vi.fn().mockRejectedValue(new Error("transport disconnected after write"));
    const owner = createOwner(post);
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));

    await expect(owner.dispatchNext(project, "agent", conversationId, queued.revision))
      .rejects.toMatchObject({ name: "ConversationTurnQueueDispatchUncertain" });

    expect(post).toHaveBeenCalledTimes(1);
    await expect(owner.read(project, "agent", conversationId)).resolves.toMatchObject({
      items: [expect.objectContaining({ status: "dispatching", retryCount: 0 })],
      canDispatch: false,
    });
  });

  it("rechecks pending interactions inside the dispatch claim transaction", async () => {
    const post = vi.fn();
    const owner = createOwner(post);
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const read = owner.read.bind(owner);
    vi.spyOn(owner, "read").mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args);
      const database = await openProjectRuntimeWorkbenchDatabase(paths);
      try {
        database.timeline.appendMessage({
          ...canonicalQueueMessage("not-a-dispatch", "not-a-dispatch"),
          id: "approval-raced-dispatch",
          type: "provider.approval",
          rawJson: JSON.stringify({ providerApproval: { status: "pending" } }),
        });
      } finally {
        database.close();
      }
      return snapshot;
    });

    await expect(owner.dispatchNext(project, "agent", conversationId, queued.revision))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(post).not.toHaveBeenCalled();
    await expect(read(project, "agent", conversationId)).resolves.toMatchObject({
      items: [expect.objectContaining({ status: "queued" })],
      canDispatch: false,
    });
  });

  it("settles a restart-time dispatch only when exact canonical evidence exists", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const queueItemId = queued.items[0]!.queueItemId;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const queue = database.conversationTurnQueues.readQueue(projectId, conversationId)!;
      const item = database.conversationTurnQueues.readItem(projectId, conversationId, queueItemId)!;
      database.transaction(() => {
        database.conversationTurnQueues.transitionItem({
          projectId, conversationId, queueItemId,
          expectedStatus: "queued", status: "dispatching", updatedAt: now,
        });
        database.conversationTurnQueues.advanceRevision(projectId, conversationId, queue.revision, now);
        database.timeline.appendMessage(canonicalQueueMessage(item.dispatchRequestId, item.requestHash));
      });
    } finally {
      database.close();
    }

    await expect(owner.reconcileProject(paths)).resolves.toBe(1);
    const verified = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(verified.conversationTurnQueues.readItem(projectId, conversationId, queueItemId))
        .toMatchObject({ status: "dispatched" });
    } finally {
      verified.close();
    }
  });

  it("holds legacy restart-time dispatch for confirmation when invocation cannot be disproved", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const queueItemId = queued.items[0]!.queueItemId;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const queue = database.conversationTurnQueues.readQueue(projectId, conversationId)!;
      database.transaction(() => {
        database.conversationTurnQueues.transitionItem({
          projectId, conversationId, queueItemId,
          expectedStatus: "queued", status: "dispatching", updatedAt: now,
        });
        database.conversationTurnQueues.advanceRevision(projectId, conversationId, queue.revision, now);
      });
    } finally {
      database.close();
    }

    await expect(owner.reconcileProject(paths)).resolves.toBe(1);
    const verified = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(verified.conversationTurnQueues.readItem(projectId, conversationId, queueItemId))
        .toMatchObject({ status: "dispatching", retryCount: 0 });
    } finally {
      verified.close();
    }
  });

  it("allows only the exact dispatching FIFO head to commit a top-level message", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const item = database.conversationTurnQueues.readItem(projectId, conversationId, queued.items[0]!.queueItemId)!;
      const ordinaryMessage = { ...canonicalQueueMessage("ordinary", "ordinary"), id: "ordinary-bypass", rawJson: "{}" };
      expect(() => database.unitOfWork.commitAgentConversationMessage({
        projectId,
        conversationId,
        graphScopeId: "graph-current",
        expectedAgentTurnMode: "plan",
        expectedAgentModelId: "gpt-test",
        expectedAgentReasoningEffort: "high",
        agentTurnMode: "plan",
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
        skillOverrides: [],
        updatedAt: now,
        message: ordinaryMessage,
      })).toThrow(/exact FIFO head/);

      const queue = database.conversationTurnQueues.readQueue(projectId, conversationId)!;
      database.transaction(() => {
        database.conversationTurnQueues.transitionItem({
          projectId, conversationId, queueItemId: item.queueItemId,
          expectedStatus: "queued", status: "dispatching", updatedAt: now,
        });
        database.conversationTurnQueues.advanceRevision(projectId, conversationId, queue.revision, now);
      });
      database.conversationTurnQueues.insertDelivery({ projectId, conversationId, productMode: "agent", clientRequestId: item.dispatchRequestId,
        queueItemId: item.queueItemId, requestHash: item.requestHash, mode: "next-turn", providerId: "codex", attemptId: null,
        executionRevision: queued.executionRevision!, phase: "invoking", messageId: null, diagnostic: null, createdAt: now, updatedAt: now });
      expect(() => database.unitOfWork.commitAgentConversationMessage({
        projectId,
        conversationId,
        graphScopeId: "graph-current",
        expectedAgentTurnMode: "plan",
        expectedAgentModelId: "gpt-test",
        expectedAgentReasoningEffort: "high",
        agentTurnMode: "plan",
        agentModelId: "gpt-test",
        agentReasoningEffort: "high",
        skillOverrides: [],
        queuedTurnDispatch: {
          queueItemId: item.queueItemId,
          dispatchRequestId: item.dispatchRequestId,
          requestHash: item.requestHash,
        },
        updatedAt: now,
        message: { ...ordinaryMessage, id: "exact-queued-dispatch" },
      })).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("blocks archive while queued input remains and preserves the queue", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    const queued = await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      expect(() => database.conversations.archiveAgentConversation(projectId, conversationId, 0, now)).toThrow(
        "Conversation with pending Turn queue items cannot be archived or deleted",
      );
      expect(database.conversationTurnQueues.readItem(projectId, conversationId, queued.items[0]!.queueItemId))
        .toMatchObject({ status: "queued" });
      expect(database.conversationTurnQueues.readQueue(projectId, conversationId)?.revision).toBe(1);
    } finally {
      database.close();
    }
  });

  it("keeps the FIFO head waiting while a Conversation interaction needs the user", async () => {
    const owner = createOwner();
    const initial = await owner.read(project, "agent", conversationId);
    await owner.enqueue(project, queueRequest(initial.revision, initial.executionRevision!));
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.timeline.appendMessage({
        ...canonicalQueueMessage("not-a-dispatch", "not-a-dispatch"),
        id: "clarification-pending",
        type: "clarification.request",
        rawJson: JSON.stringify({ clarification: { id: "clarification-1", status: "pending" } }),
      });
    } finally {
      database.close();
    }

    await expect(owner.read(project, "agent", conversationId)).resolves.toMatchObject({
      canDispatch: false,
      items: [expect.objectContaining({ status: "queued" })],
    });
  });

  it("keeps the Harness FIFO head waiting for pending governance decisions", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      database.conversations.createConversation({
        projectId,
        conversationId: "conversation-harness-governance",
        productMode: "harness",
        agentTurnMode: null,
        agentModelId: null,
        agentReasoningEffort: null,
        title: "Harness governance",
        state: "active",
        boundChangeId: "change-governance",
        currentGraphScopeId: "graph-harness-governance",
        selectedProviderId: "codex",
        completedTurnSequence: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      database.drafts.upsertDraft({
        projectId,
        productMode: "harness",
        agentTurnMode: null,
        agentModelId: null,
        agentReasoningEffort: null,
        text: "queued harness feedback",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        selectedProviderId: "codex",
        updatedAt: now,
      }, null);
      database.decisions.upsertDecision({
        id: "decision-governance",
        projectId,
        changeId: "change-governance",
        decisionType: "workpad.confirmation",
        status: "pending",
        label: "Confirm",
        summary: "Awaiting user decision.",
        targetId: "change-governance",
        runId: null,
        artifact: null,
        actionId: null,
        feedback: null,
        payloadJson: "{}",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      });
    } finally {
      database.close();
    }
    const owner = createOwner();
    const initial = await owner.read(project, "harness", "conversation-harness-governance");
    await owner.enqueue(project, {
      ...queueRequest(initial.revision, initial.executionRevision!),
      productMode: "harness",
      conversationId: "conversation-harness-governance",
      clientRequestId: "queue-harness-governance",
      expectedDraftUpdatedAt: now,
      text: "queued harness feedback",
      contextRefs: [],
      attachmentIds: [],
      skillOverrides: {},
      agentTurnMode: null,
      modelId: null,
      reasoningEffort: null,
    });

    await expect(owner.read(project, "harness", "conversation-harness-governance")).resolves.toMatchObject({
      canDispatch: false,
      items: [expect.objectContaining({ status: "queued" })],
    });
  });

  it("fails closed when the selected project resolves to another runtime identity", async () => {
    const owner = new ConversationTurnQueueOwner({
      projectRuntimeCoordinator: {
        resolve: async () => ({ state: "onboarding", paths: { ...paths, projectId: "other-project" } }),
      } as never,
      delivery: {} as never, providerRegistry: defaultProviderRegistry, executionContractRegistry: defaultExecutionContractRegistry,
    });

    await expect(owner.read(project, "agent", conversationId)).rejects.toMatchObject({ name: "Conflict" });
  });
});

type QueueOwnerOptions = ConstructorParameters<typeof ConversationTurnQueueOwner>[0];

function createGuideOwner(
  control: ConstructorParameters<typeof ConversationInputDeliveryService>[0]["turnControl"],
  post?: typeof PostConversationMessage,
): ConversationTurnQueueOwner {
  const projectRuntimeCoordinator = { resolve: async () => ({ state: "onboarding", paths }) } as never;
  return new ConversationTurnQueueOwner({
    projectRuntimeCoordinator, providerRegistry: defaultProviderRegistry, executionContractRegistry: defaultExecutionContractRegistry,
    turnControl: { state: () => ({ state: "running", attemptId: "guide-attempt", providerId: "codex", canSteer: true, canInterrupt: true, steerState: "idle" }) } as never,
    delivery: new ConversationInputDeliveryService({ projectRuntimeCoordinator, turnRouter: {} as never, turnControl: control,
      reviewDispatch: {} as never, prepare: async () => ({}) as never, ...(post ? { post } : {}) }),
  });
}

async function enqueueGuideInputs(owner: ConversationTurnQueueOwner, secondHasReference: boolean) {
  let snapshot = await owner.read(project, "agent", conversationId);
  for (const [index, text] of ["first", "second"].entries()) {
    const db = await openProjectRuntimeWorkbenchDatabase(paths);
    const updatedAt = `2026-08-28T00:00:0${index + 1}.000Z`;
    const contextRefs = index === 1 && secondHasReference ? queueRequest("", "").contextRefs : [];
    try {
      const draft = db.drafts.readDraft(projectId, "agent")!;
      db.drafts.upsertDraft({ ...draft, text, contextRefsJson: JSON.stringify(contextRefs), attachmentIdsJson: "[]", skillOverridesJson: "{}", updatedAt }, draft.updatedAt);
    } finally { db.close(); }
    snapshot = await owner.enqueue(project, { ...queueRequest(snapshot.revision, snapshot.executionRevision!), clientRequestId: `queued-${index}`, text,
      contextRefs, attachmentIds: [], skillOverrides: {}, expectedDraftUpdatedAt: updatedAt });
  }
  return snapshot;
}

function guideRequest(snapshot: Awaited<ReturnType<ConversationTurnQueueOwner["read"]>>): ConversationQueueGuideRequest {
  return { projectId, productMode: "agent", conversationId, queueItemId: snapshot.items[1]!.queueItemId,
    providerId: "codex", expectedAttemptId: "guide-attempt", clientRequestId: "selected-guide", expectedRevision: snapshot.revision,
    expectedExecutionRevision: snapshot.executionRevision! };
}

function createOwner(
  postConversationMessage?: typeof PostConversationMessage,
  reviewDispatch?: ConversationQueuedReviewDispatchPort,
  executionContractRegistry?: QueueOwnerOptions["executionContractRegistry"],
  prepare?: ConstructorParameters<typeof ConversationInputDeliveryService>[0]["prepare"],
): ConversationTurnQueueOwner {
  const projectRuntimeCoordinator = { resolve: async () => ({ state: "onboarding", paths }) } as never;
  return new ConversationTurnQueueOwner({
    projectRuntimeCoordinator,
    providerRegistry: defaultProviderRegistry,
    executionContractRegistry: executionContractRegistry ?? defaultExecutionContractRegistry,
    delivery: new ConversationInputDeliveryService({
      projectRuntimeCoordinator, turnRouter: {} as never, turnControl: {} as never,
      reviewDispatch: reviewDispatch ?? {} as never,
      prepare: prepare ?? (async () => ({}) as never),
      ...(postConversationMessage ? { post: postConversationMessage } : {}),
    }),
  });
}

function executionRegistry(overrides: Partial<Record<ExecutionContractFamily, number>>): ExecutionContractRegistry {
  return new ExecutionContractRegistry(EXECUTION_CONTRACT_FAMILIES.map((family) => ({
    family,
    epoch: overrides[family] ?? 1,
    policyVersion: `${family}-test-v${overrides[family] ?? 1}`,
    summary: `${family} test contract`,
  })));
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function canonicalQueueMessage(dispatchRequestId: string, requestHash: string) {
  return {
    id: "queued-dispatch-evidence",
    projectId,
    conversationId,
    changeId: "",
    agentSurfaceId: "main-agent",
    type: "user.message",
    timestamp: now,
    text: "queued follow-up",
    actionRunId: null,
    actionType: null,
    status: null,
    runId: null,
    providerId: "codex",
    threadId: null,
    turnId: null,
    itemId: null,
    artifact: null,
    error: null,
    rawJson: JSON.stringify({ queuedTurnDispatch: { dispatchRequestId, requestHash } }),
  };
}

function queueRequest(expectedRevision: string, expectedExecutionRevision: string) {
  return {
    projectId,
    productMode: "agent" as const,
    conversationId,
    clientRequestId: "queue-request-1",
    expectedRevision,
    expectedExecutionRevision,
    expectedDraftUpdatedAt: now,
    text: " queued follow-up ",
    contextRefs: [{ relativePath: "src/app.ts", name: "app.ts", kind: "file" as const, source: "composer" as const }],
    attachmentIds: ["attachment-1"],
    skillOverrides: { reviewer: true },
    providerId: "codex",
    agentTurnMode: "plan" as const,
    modelId: "gpt-test",
    reasoningEffort: "high",
  };
}

async function insertRunningAttempt(attemptId: string, guideCompatible = false): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    database.providerAttempts.createProviderAttempt({
      projectId,
      conversationId,
      attemptId,
      productMode: "agent",
      graphScopeId: "graph-current",
      changeId: null,
      agentTaskId: null,
      roleId: "main-agent",
      operationProfile: "agent",
      providerId: "codex",
      executionContract: resolveStoredExecutionContract({
        productMode: "agent",
        operationProfile: "agent",
        operationKind: "conversation-turn",
        roleId: "main-agent",
        providerAdapterVersion: "test-adapter-v1",
      }),
      nativeSessionId: null,
      agentTurnMode: guideCompatible ? "plan" : null,
      reasoningEffort: guideCompatible ? "high" : null,
      model: guideCompatible ? { providerId: "codex", modelId: "gpt-test" } : null,
      capabilitySnapshot: { providerId: "codex", effectiveModel: null } as never,
      effectiveSkillInputs: [],
      handoffHash: `handoff-${attemptId}`,
      deliveredThroughCompletedTurn: 0,
      worktreeId: null,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    database.close();
  }
}

async function seedConversation(productMode: "agent" | "harness", selectedConversationId = conversationId): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    database.conversations.createConversation({
      projectId,
      conversationId: selectedConversationId,
      productMode,
      agentTurnMode: productMode === "agent" ? "plan" : null,
      agentModelId: "gpt-test",
      agentReasoningEffort: "high",
      title: "Agent",
      state: "active",
      boundChangeId: null,
      currentGraphScopeId: "graph-current",
      selectedProviderId: "codex",
      completedTurnSequence: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    database.drafts.upsertDraft({
      projectId,
      productMode,
      agentTurnMode: productMode === "agent" ? "plan" : null,
      agentModelId: "gpt-test",
      agentReasoningEffort: "high",
      text: "queued follow-up",
      contextRefsJson: JSON.stringify([{ relativePath: "src/app.ts", name: "app.ts", kind: "file", source: "composer" }]),
      attachmentIdsJson: JSON.stringify(["attachment-1"]),
      skillOverridesJson: JSON.stringify({ reviewer: true }),
      selectedProviderId: "codex",
      updatedAt: now,
    }, null);
  } finally {
    database.close();
  }
}

async function replaceDraftAttachments(attachmentIds: string[]): Promise<string> {
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const draft = database.drafts.readDraft(projectId, "agent")!;
    const updatedAt = "2026-08-28T00:00:00.500Z";
    database.drafts.upsertDraft({
      ...draft,
      attachmentIdsJson: JSON.stringify(attachmentIds),
      updatedAt,
    }, draft.updatedAt);
    return updatedAt;
  } finally {
    database.close();
  }
}
