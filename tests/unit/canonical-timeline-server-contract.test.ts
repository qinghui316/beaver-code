import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../../src/provider-runtime/project-harness-discovery.js";
import { resolveProjectRuntime } from "../../src/project-runtime/resolution.js";
import { agentThreadSurfaceId } from "../../src/provider-runtime/agent-surface-id.js";
import { WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";
import { decodeCanonicalTimelineCursor, encodeCanonicalTimelineCursor, getCanonicalTimelinePage } from "../../src/workbench/canonical-timeline-query.js";
import { projectCanonicalTimelineEnvelope } from "../../src/workbench/canonical-timeline-projector.js";
import { CanonicalTimelineDelivery } from "../../src/workbench/canonical-timeline-delivery.js";
import type {
  CanonicalTimelineEnvelope as ServerTimelineEnvelope,
  CanonicalTimelinePage as ServerTimelinePage,
} from "../../src/workbench/canonical-timeline-contract.js";
import type {
  CanonicalTimelineEnvelope as WebTimelineEnvelope,
  CanonicalTimelinePage as WebTimelinePage,
} from "../../src/web/src/types.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { createWorkbenchConversation } from "../../src/workbench/conversation-service.js";
import { getWorkbenchSnapshot } from "../../src/workbench/projections/read-model/implementation.js";
import type { WorkbenchDatabase } from "../../src/workbench/persistence/database.js";
import { type StoredTopicMessageWrite } from "../../src/workbench/persistence/contracts.js";
import { createReadyProjectHarnessFixture } from "../helpers/project-harness-fixture.js";

let root: string;
let originalAhoHome: string | undefined;
const projectId = "timeline-project";
const conversationId = "conversation-1";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _EnvelopeContractMatches = Assert<Equal<ServerTimelineEnvelope, WebTimelineEnvelope>>;
type _PageContractMatches = Assert<Equal<ServerTimelinePage, WebTimelinePage>>;
const contractTypeCheck: [_EnvelopeContractMatches, _PageContractMatches] = [true, true];
void contractTypeCheck;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-canonical-timeline-"));
  originalAhoHome = process.env.AHO_HOME;
  process.env.AHO_HOME = join(root, ".aho-home");
});

afterEach(async () => {
  if (originalAhoHome === undefined) delete process.env.AHO_HOME;
  else process.env.AHO_HOME = originalAhoHome;
  await rm(root, { recursive: true, force: true });
});

describe("canonical Timeline server contract", () => {
  it("reads Agent history from the sidecar before the project Harness is ready", async () => {
    const project = {
      id: projectId,
      name: "Timeline project",
      path: root,
      addedAt: "2026-07-17T00:00:00.000Z",
      lastSeenAt: "2026-07-17T00:00:00.000Z",
      defaultProviderId: "codex",
    };
    const created = await createWorkbenchConversation(project, {
      body: "Agent history before Harness onboarding.",
      productMode: "agent",
      clientRequestId: "agent-onboarding-timeline",
    }, undefined, { runMainAgent: false });
    const input = { project, path: root };

    await expect(getWorkbenchSnapshot(input, {
      topicId: created.conversationId,
      productMode: "agent",
    })).resolves.toMatchObject({
      productMode: "agent",
      center: { selectedTopic: { id: created.conversationId, productMode: "agent" } },
    });
    await expect(getCanonicalTimelinePage(
      input,
      created.conversationId,
      "main-agent",
      "agent",
    )).resolves.toMatchObject({
      productMode: "agent",
      conversationId: created.conversationId,
      entries: [expect.objectContaining({ clientRequestId: "agent-onboarding-timeline" })],
    });
    await expect(getWorkbenchSnapshot(input, {
      topicId: created.conversationId,
      productMode: "harness",
    })).rejects.toMatchObject({ name: "Conflict" });
    await expect(getCanonicalTimelinePage(
      input,
      created.conversationId,
      "main-agent",
      "harness",
    )).rejects.toMatchObject({ name: "Conflict" });
  });

  it("allocates immutable positions and mutation revisions transactionally", async () => {
    const memory = runtimePaths();
    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      seedConversation(store);
      const main = store.timeline.appendMessage(message("main", "main-agent"));
      const child = store.timeline.appendMessage(message("child", "planning-agent", "thread-child"));
      const updated = store.timeline.updateMessage({ ...message("main", "main-agent"), text: "updated" });

      expect(main).toMatchObject({ position: 1, revision: 1, agentSurfaceId: "main-agent" });
      expect(child).toMatchObject({
        position: 2,
        revision: 2,
        agentSurfaceId: agentThreadSurfaceId("codex", "thread-child"),
      });
      expect(updated).toMatchObject({ position: 1, revision: 3, agentSurfaceId: "main-agent", text: "updated" });
      expect(() => store.timeline.updateMessage({ ...message("main", "main-agent"), agentSurfaceId: "other-surface" }))
        .toThrow("agentSurfaceId is immutable");
      expect(() => store.timeline.updateMessage({ ...message("main", "main-agent"), initialThreadInput: true }))
        .toThrow("orderClass is immutable");
      expect(() => store.timeline.updateMessage({ ...message("main", "main-agent"), providerId: "claude" }))
        .toThrow("providerId is immutable");
      expect(() => store.timeline.updateMessage({ ...message("main", "main-agent"), threadId: "other-thread" }))
        .toThrow("threadId is immutable");
      expect(() => store.timeline.updateMessage({ ...message("main", "main-agent"), turnId: "other-turn" }))
        .toThrow("turnId is immutable");
      expect(() => store.timeline.updateMessage({ ...message("main", "main-agent"), itemId: "other-item" }))
        .toThrow("itemId is immutable");

      expect(() => store.timeline.appendMessage(message("main", "main-agent"))).toThrow();
      expect(store.conversations.readConversation(projectId, conversationId)).toMatchObject({ timelinePosition: 2, timelineRevision: 3 });
      expect(store.timeline.listConversationMessages(projectId, conversationId).map((row) => [row.id, row.position, row.revision])).toEqual([
        ["main", 1, 3],
        ["child", 2, 2],
      ]);
    } finally {
      store.close();
    }

    const db = new Database(memory.workbenchDbPath, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(WORKBENCH_SCHEMA_VERSION);
      expect(db.prepare("PRAGMA index_list(canonical_timeline_items)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "idx_timeline_conversation_position", unique: 1 }),
      ]));
    } finally {
      db.close();
    }
  });

  it("builds patches from persisted rows and rejects cross-scope cursors", async () => {
    const memory = runtimePaths();
    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    let persisted;
    try {
      seedConversation(store);
      persisted = store.timeline.appendMessage(message("child", "planning-agent", "thread-child"));
    } finally {
      store.close();
    }

    const envelope = projectCanonicalTimelineEnvelope(persisted, "harness");
    expect(envelope).toMatchObject({
      conversationId,
      agentSurfaceId: agentThreadSurfaceId("codex", "thread-child"),
      messageId: "child",
      position: 1,
      revision: 1,
      orderClass: "sequence",
    });

    const scope = { projectId, conversationId, agentSurfaceId: envelope.agentSurfaceId };
    const cursor = encodeCanonicalTimelineCursor({ ...scope, beforePosition: 1, watermarkRevision: 1 });
    expect(decodeCanonicalTimelineCursor(cursor, scope)).toMatchObject({ ...scope, beforePosition: 1, watermarkRevision: 1 });
    expect(() => decodeCanonicalTimelineCursor(cursor, { ...scope, agentSurfaceId: "main-agent" })).toThrow("Invalid canonical Timeline cursor");
    expect(() => decodeCanonicalTimelineCursor(cursor, { ...scope, conversationId: "conversation-2" })).toThrow("Invalid canonical Timeline cursor");
  });

  it("pins a child thread-start outside the latest sequence window", async () => {
    const project = {
      id: projectId,
      name: "Timeline project",
      path: root,
      addedAt: "2026-07-17T00:00:00.000Z",
      lastSeenAt: "2026-07-17T00:00:00.000Z",
    };
    await createReadyProjectHarnessFixture({
      projectRoot: root,
      ahoHome: process.env.AHO_HOME!,
      projectId,
      projectName: project.name,
    });
    const resolution = await resolveProjectRuntime(project, {
      ahoHome: process.env.AHO_HOME,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });
    const store = await openProjectRuntimeWorkbenchDatabase(resolution.paths);
    try {
      seedConversation(store);
      store.timeline.appendMessage(message("child-input", "planning-agent", "thread-child", true));
      for (let index = 1; index <= 10; index += 1) {
        store.timeline.appendMessage(message(`child-${index}`, "planning-agent", "thread-child"));
      }
    } finally {
      store.close();
    }

    const page = await getCanonicalTimelinePage(
      { project, path: root },
      conversationId,
      agentThreadSurfaceId("codex", "thread-child"),
      "harness",
      { limit: 2 },
    );
    expect(page.pinned).toEqual([
      expect.objectContaining({ messageId: "child-input", orderClass: "thread-start", position: 1 }),
    ]);
    expect(page.entries.map((entry) => entry.messageId)).toEqual(["child-9", "child-10"]);
    expect(page.paging).toMatchObject({ limit: 2, totalCount: 10, hasMoreBefore: true });
  });

  it("reads page rows, pinned input, and watermark from one store snapshot", async () => {
    const memory = runtimePaths();
    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      seedConversation(store);
      store.timeline.appendMessage(message("child-input", "planning-agent", "thread-child", true));
      store.timeline.appendMessage(message("child-output", "planning-agent", "thread-child"));
      store.timeline.updateMessage({ ...message("child-output", "planning-agent", "thread-child"), text: "updated output" });

      const surfaceId = agentThreadSurfaceId("codex", "thread-child");
      const snapshot = store.timeline.readTimelineSurfacePageSnapshot(projectId, conversationId, surfaceId, { limit: 10 });
      expect(snapshot?.conversation.timelineRevision).toBe(3);
      expect(snapshot?.pinnedRows.map((row) => [row.id, row.revision])).toEqual([["child-input", 1]]);
      expect(snapshot?.rows.map((row) => [row.id, row.revision, row.text])).toEqual([
        ["child-output", 3, "updated output"],
      ]);
      expect(snapshot?.rows.every((row) => row.revision <= (snapshot?.conversation.timelineRevision ?? 0))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("publishes only after persistence and keeps a committed row when publication fails", async () => {
    const memory = runtimePaths();
    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      seedConversation(store);
      const published: string[] = [];
      const delivery = new CanonicalTimelineDelivery(store, "harness", (envelope) => published.push(envelope.messageId));
      delivery.append(message("first", "main-agent"));
      expect(published).toEqual(["first"]);

      expect(() => delivery.append(message("first", "main-agent"))).toThrow();
      expect(published).toEqual(["first"]);

      const failingDelivery = new CanonicalTimelineDelivery(store, "harness", () => { throw new Error("transport unavailable"); });
      expect(() => failingDelivery.append(message("committed", "main-agent"))).not.toThrow();
      expect(store.timeline.readMessage(projectId, conversationId, "committed")).toMatchObject({ position: 2, revision: 2 });
    } finally {
      store.close();
    }
  });

  it("upserts one canonical message through repeated revisions without a local identity set", async () => {
    const memory = runtimePaths();
    const store = await openProjectRuntimeWorkbenchDatabase(memory);
    try {
      seedConversation(store);
      const revisions: number[] = [];
      const delivery = new CanonicalTimelineDelivery(store, "harness", (envelope) => revisions.push(envelope.revision));
      delivery.upsert(message("stable", "main-agent"));
      for (let index = 1; index <= 100; index += 1) {
        delivery.upsert({ ...message("stable", "main-agent"), text: `revision-${index}` });
      }
      expect(store.timeline.countMessages(projectId, conversationId)).toBe(1);
      expect(store.timeline.readMessage(projectId, conversationId, "stable")).toMatchObject({ position: 1, revision: 101, text: "revision-100" });
      expect(revisions).toHaveLength(101);
      expect(new Set(revisions).size).toBe(101);
    } finally {
      store.close();
    }
  });
});

function runtimePaths(): ProjectRuntimePaths {
  return resolveProjectRuntimePaths(projectId, root);
}

function seedConversation(store: WorkbenchDatabase): void {
  store.conversations.createConversation({
    projectId,
    conversationId,
    productMode: "harness",
    title: "Timeline conversation",
    state: "active",
    boundChangeId: null,
    currentGraphScopeId: "graph-1",
    selectedProviderId: "codex",
    completedTurnSequence: 0,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    deletedAt: null,
  });
}

function message(id: string, roleId: string, threadId?: string, initialThreadInput = false): StoredTopicMessageWrite {
  const entry = {
    id,
    type: "assistant.message",
    timestamp: "2026-07-17T00:00:00.000Z",
    conversationId,
    graphScopeId: "graph-1",
    changeId: "",
    text: id,
    providerId: "codex",
    threadId,
    agentRoleId: roleId,
    ...(initialThreadInput ? { initialThreadInput: true } : {}),
  };
  return {
    id,
    projectId,
    conversationId,
    changeId: "",
    type: entry.type,
    timestamp: entry.timestamp,
    text: entry.text,
    actionRunId: null,
    actionType: null,
    status: null,
    runId: null,
    agentSurfaceId: roleId === "main-agent" ? "main-agent" : agentThreadSurfaceId("codex", threadId!),
    providerId: entry.providerId,
    threadId: entry.threadId ?? null,
    turnId: null,
    itemId: null,
    initialThreadInput,
    artifact: null,
    error: null,
    rawJson: JSON.stringify(entry),
  };
}
