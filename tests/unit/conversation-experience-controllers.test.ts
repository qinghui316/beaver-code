// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { WorkbenchRequestError } from "../../src/web/src/api.js";
import {
  ConversationDraftController,
  type ConversationDraftViewModel,
} from "../../src/web/src/controllers/ConversationDraftController.js";
import { ConversationTurnSubmissionController } from "../../src/web/src/controllers/ConversationTurnSubmissionController.js";
import {
  createDraftSubmissionSnapshot,
  type ConversationSubmissionPorts,
  type ConversationSubmissionSkillIdentity,
} from "../../src/web/src/controllers/conversation-submission-contract.js";
import type { ComposerDraftContent } from "../../src/web/src/controllers/ComposerDraftSyncOwner.js";
import type { TopicAttachment, TopicFileReference } from "../../src/web/src/types.js";

describe("Conversation experience application owners", () => {
  it("reads an immutable draft snapshot and removes only accepted resource identities", () => {
    const harness = draftHarness(draft({
      text: "first",
      contextRefs: [fileRef("src/first.ts")],
      attachments: [attachment("first")],
      skillOverrides: { reviewer: true },
    }));
    const owner = new ConversationDraftController(harness.port);
    const accepted = owner.read();

    accepted.contextRefs[0]!.relativePath = "mutated.ts";
    expect(harness.state.contextRefs[0]?.relativePath).toBe("src/first.ts");

    const realAccepted = owner.read();
    harness.state.text = "newer edit";
    harness.state.contextRefs.push(fileRef("src/newer.ts"));
    harness.state.attachments.push(attachment("newer"));
    harness.state.skillOverrides = { reviewer: true, formatter: true, changed: false };
    realAccepted.skillOverrides.changed = true;
    owner.clearAcceptedSnapshot(realAccepted);

    expect(harness.state).toMatchObject({
      text: "newer edit",
      contextRefs: [expect.objectContaining({ relativePath: "src/newer.ts" })],
      attachments: [expect.objectContaining({ id: "newer" })],
      skillOverrides: { formatter: true, changed: false },
    });
    expect(harness.dirtyCount).toBe(0);
  });

  it("preserves same-value edits and same-identity resources re-added after capture", () => {
    const harness = draftHarness(draft({
      text: "same text",
      contextRefs: [fileRef("src/same.ts")],
      attachments: [attachment("same")],
      skillOverrides: { reviewer: true },
    }));
    const owner = new ConversationDraftController(harness.port);
    const accepted = owner.read();

    owner.updateText("temporary text");
    owner.updateText("same text");
    owner.updateContextRefs(() => []);
    owner.updateContextRefs(() => [fileRef("src/same.ts")]);
    owner.updateAttachments(() => []);
    owner.updateAttachments(() => [attachment("same")]);
    owner.updateSkillOverrides(() => ({}));
    owner.updateSkillOverrides(() => ({ reviewer: true }));
    owner.clearAcceptedSnapshot(accepted);

    expect(harness.state).toMatchObject({
      text: "same text",
      contextRefs: [expect.objectContaining({ relativePath: "src/same.ts" })],
      attachments: [expect.objectContaining({ id: "same" })],
      skillOverrides: { reviewer: true },
    });
  });

  it("merges restored content and restores shared model configuration only into an empty draft", () => {
    const harness = draftHarness(draft({
      text: "current",
      contextRefs: [fileRef("src/current.ts")],
      attachments: [attachment("current")],
      skillOverrides: { current: true },
      agentTurnMode: "default",
      modelId: "current-model",
      reasoningEffort: "low",
    }));
    const owner = new ConversationDraftController(harness.port);
    owner.restore(submissionSnapshot({ productMode: "agent" }), [attachment("restored")], {
      restoreConfiguration: true,
      restoreSkillOverrides: true,
    });

    expect(harness.state.text).toBe("current\n\nrestored");
    expect(harness.state.contextRefs.map((item) => item.relativePath)).toEqual(["src/current.ts", "src/restored.ts"]);
    expect(harness.state.attachments.map((item) => item.id)).toEqual(["current", "restored"]);
    expect(harness.state.skillOverrides).toEqual({ restored: true, current: true });
    expect(harness.state).toMatchObject({ agentTurnMode: "default", modelId: "current-model", reasoningEffort: "low" });
    expect(harness.dirtyCount).toBe(1);

    const emptyHarness = draftHarness(draft());
    const emptyOwner = new ConversationDraftController(emptyHarness.port);
    emptyOwner.restore(submissionSnapshot({ productMode: "agent" }), [], { restoreConfiguration: true });
    expect(emptyHarness.state).toMatchObject({ agentTurnMode: "plan", modelId: "gpt-next", reasoningEffort: "high" });

    const ahoHarness = draftHarness(draft());
    new ConversationDraftController(ahoHarness.port).restore(
      submissionSnapshot({ productMode: "harness", agentTurnMode: "plan", modelId: "must-not-cross", reasoningEffort: "high" }),
      [],
      { restoreConfiguration: true },
    );
    expect(ahoHarness.state).toMatchObject({ agentTurnMode: "default", modelId: "must-not-cross", reasoningEffort: "high" });
  });

  it("shows the optimistic row before transport and sends one immutable follow-up snapshot", async () => {
    const order: string[] = [];
    const ports = submissionPorts(order);
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: "conversation-1" });

    await owner.submitMessage({
      snapshot,
      attachments: [attachment("existing")],
      acceptedDraft: acceptedDraft(snapshot),
      skillIdentity: skillIdentity(snapshot),
      isCurrent: () => true,
      acceptsEvent: () => true,
      onPending: () => { order.push("draft-pending"); },
      onAccepted: () => { order.push("draft-accepted"); },
    });

    expect(order.indexOf("optimistic")).toBeLessThan(order.indexOf("transport"));
    expect(ports.transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      clientRequestId: "request-original",
      conversationId: "conversation-1",
      modelId: "gpt-next",
      reasoningEffort: "high",
    }), expect.any(Function));
    expect(ports.skills.apply).toHaveBeenCalledWith(skillIdentity(snapshot), { restored: true });
    expect(ports.drafts.settleAccepted).toHaveBeenCalledOnce();
    expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "conversation-1", "main-agent");
    expect(owner.inspect(snapshot.clientRequestId)).toBeNull();
  });

  it("classifies explicit rejection as failed and retries with a new request identity", async () => {
    const ports = submissionPorts();
    ports.transport.sendMessage
      .mockRejectedValueOnce(new WorkbenchRequestError(400, "rejected"))
      .mockResolvedValueOnce(undefined);
    ports.ids.createClientRequestId.mockReturnValue("request-retry");
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: "conversation-1" });
    const input = messageInput(snapshot);

    await expect(owner.submitMessage(input)).rejects.toBeInstanceOf(WorkbenchRequestError);
    expect(owner.inspect(snapshot.clientRequestId)).toMatchObject({ state: "failed" });
    expect(ports.timeline.markPending).toHaveBeenCalledWith(
      expect.any(Object),
      snapshot.clientRequestId,
      "failed",
      expect.any(String),
    );

    await owner.retryPendingIntent(snapshot.clientRequestId, retryInput());
    expect(ports.transport.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientRequestId: "request-retry" }),
      expect.any(Function),
    );
    expect(owner.inspect(snapshot.clientRequestId)).toBeNull();
    expect(owner.inspect("request-retry")).toBeNull();
    expect(ports.timeline.consumePending).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation-1" }),
      snapshot.clientRequestId,
    );
    expect(ports.drafts.settleAccepted).toHaveBeenCalledOnce();
  });

  it("keeps an uncertain transport result non-retryable", async () => {
    const ports = submissionPorts();
    ports.transport.sendMessage.mockRejectedValue(new WorkbenchRequestError(503, "unknown outcome"));
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: "conversation-1" });

    await expect(owner.submitMessage(messageInput(snapshot))).rejects.toBeInstanceOf(WorkbenchRequestError);
    expect(owner.inspect(snapshot.clientRequestId)).toMatchObject({ state: "uncertain" });
    const before = ports.transport.sendMessage.mock.calls.length;
    await owner.retryPendingIntent(snapshot.clientRequestId, retryInput());
    expect(ports.transport.sendMessage).toHaveBeenCalledTimes(before);
  });

  it("keeps a late retry failure out of a scope that no longer owns the request", async () => {
    const ports = submissionPorts();
    ports.transport.sendMessage
      .mockRejectedValueOnce(new WorkbenchRequestError(400, "rejected"))
      .mockRejectedValueOnce(new WorkbenchRequestError(400, "late retry rejection"));
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: "conversation-1" });

    await expect(owner.submitMessage(messageInput(snapshot))).rejects.toBeInstanceOf(WorkbenchRequestError);
    ports.onError.mockClear();
    await owner.retryPendingIntent(snapshot.clientRequestId, {
      ...retryInput(),
      isCurrent: () => false,
    });

    expect(ports.onError).not.toHaveBeenCalledWith(
      expect.stringContaining("late retry rejection"),
    );
    expect(owner.inspect(snapshot.clientRequestId)).toBeNull();
    expect(owner.inspect("request-retry")).toMatchObject({ state: "failed" });
  });

  it("rekeys a first-send scope after registration and calibrates the created Conversation", async () => {
    const ports = submissionPorts();
    ports.session.ensureProjectRegistered.mockResolvedValue("registered-repo");
    ports.session.createConversation.mockResolvedValue({ projectId: "registered-repo", conversationId: "conversation-new" });
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: null });
    const accepted = vi.fn(async () => undefined);

    await owner.submitCreate({
      snapshot,
      attachments: [attachment("existing")],
      attachmentFiles: [],
      acceptedDraft: acceptedDraft(snapshot),
      isCurrent: () => true,
      onPending: () => undefined,
      onAccepted: accepted,
    });

    expect(ports.timeline.rekeyPending).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "repo", conversationId: "pending:request-original" }),
      expect.objectContaining({ projectId: "registered-repo", conversationId: "pending:request-original" }),
      "request-original",
    );
    expect(ports.session.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "registered-repo",
      clientRequestId: "request-original",
    }));
    expect(accepted).toHaveBeenCalledWith({ projectId: "registered-repo", conversationId: "conversation-new" });
    expect(ports.timeline.calibrate).toHaveBeenCalledWith("registered-repo", "conversation-new", "main-agent");
  });

  it("removes temporary first-send uploads after a rejected create and restores original attachment identity", async () => {
    const ports = submissionPorts();
    ports.attachments.upload.mockResolvedValue(attachment("temporary"));
    ports.session.createConversation.mockRejectedValue(new WorkbenchRequestError(400, "rejected"));
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: null });
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    await expect(owner.submitCreate({
      snapshot,
      attachments: [attachment("existing")],
      attachmentFiles: [file],
      acceptedDraft: acceptedDraft(snapshot),
      isCurrent: () => true,
      onPending: () => undefined,
      onAccepted: async () => undefined,
    })).rejects.toBeInstanceOf(WorkbenchRequestError);

    expect(ports.attachments.remove).toHaveBeenCalledWith("repo", "temporary");
    expect(owner.inspect(snapshot.clientRequestId)).toMatchObject({
      state: "failed",
      snapshot: { attachmentIds: ["existing"] },
      attachmentFiles: [file],
    });
  });

  it("consumes restore actions once and leaves the failed row non-actionable", async () => {
    const ports = submissionPorts();
    ports.transport.sendMessage.mockRejectedValue(new WorkbenchRequestError(400, "rejected"));
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: "conversation-1" });

    await expect(owner.submitMessage(messageInput(snapshot))).rejects.toBeInstanceOf(WorkbenchRequestError);
    expect(owner.restore(snapshot.clientRequestId)).toMatchObject({ state: "failed" });
    expect(owner.restore(snapshot.clientRequestId)).toBeNull();
    expect(ports.timeline.consumePending).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conversation-1" }),
      snapshot.clientRequestId,
    );
  });

  it("settles the accepted first-send draft after a successful retry", async () => {
    const ports = submissionPorts();
    ports.session.createConversation
      .mockRejectedValueOnce(new WorkbenchRequestError(400, "rejected"))
      .mockResolvedValueOnce({ projectId: "repo", conversationId: "conversation-new" });
    const owner = new ConversationTurnSubmissionController(ports);
    const snapshot = submissionSnapshot({ conversationId: null });

    await expect(owner.submitCreate({
      snapshot,
      attachments: [attachment("existing")],
      attachmentFiles: [],
      acceptedDraft: acceptedDraft(snapshot),
      isCurrent: () => true,
      onPending: () => undefined,
      onAccepted: async () => undefined,
    })).rejects.toBeInstanceOf(WorkbenchRequestError);
    await owner.retryPendingIntent(snapshot.clientRequestId, retryInput());

    expect(ports.drafts.settleAccepted).toHaveBeenCalledOnce();
    expect(ports.projection.refreshConversation).toHaveBeenCalledWith("repo", "conversation-new");
  });
});

function messageInput(snapshot: ReturnType<typeof submissionSnapshot>) {
  return {
    snapshot,
    attachments: [attachment("existing")],
    acceptedDraft: acceptedDraft(snapshot),
    skillIdentity: skillIdentity(snapshot),
    isCurrent: () => true,
    acceptsEvent: () => true,
    onPending: () => undefined,
    onAccepted: () => undefined,
  };
}

function retryInput() {
  return {
    matchesCurrent: () => true,
    selectedConversationProviderId: "codex",
    isCurrent: () => true,
    acceptsEvent: () => true,
    onAccepted: () => undefined,
  };
}

function skillIdentity(snapshot: ReturnType<typeof submissionSnapshot>): ConversationSubmissionSkillIdentity {
  return {
    projectId: snapshot.projectId,
    productMode: snapshot.productMode,
    conversationId: snapshot.conversationId,
    providerId: snapshot.providerId,
  };
}

function acceptedDraft(snapshot: ReturnType<typeof submissionSnapshot>): ComposerDraftContent {
  return {
    projectId: snapshot.projectId,
    productMode: snapshot.productMode,
    agentTurnMode: snapshot.agentTurnMode,
    agentModelId: snapshot.modelId,
    agentReasoningEffort: snapshot.reasoningEffort,
    text: snapshot.text,
    contextRefs: snapshot.contextRefs,
    attachmentIds: snapshot.attachmentIds,
    skillOverrides: snapshot.skillOverrides,
    selectedProviderId: snapshot.providerId,
  };
}

function submissionPorts(order: string[] = []): ConversationSubmissionPorts & {
  operation: { begin: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  ids: { createClientRequestId: ReturnType<typeof vi.fn> };
  session: {
    ensureProjectRegistered: ReturnType<typeof vi.fn>;
    createConversation: ReturnType<typeof vi.fn>;
    beginPendingConversation: ReturnType<typeof vi.fn>;
  };
  transport: { sendMessage: ReturnType<typeof vi.fn> };
  timeline: {
    showPending: ReturnType<typeof vi.fn>;
    markPending: ReturnType<typeof vi.fn>;
    consumePending: ReturnType<typeof vi.fn>;
    rekeyPending: ReturnType<typeof vi.fn>;
    calibrate: ReturnType<typeof vi.fn>;
  };
  projection: { refreshConversation: ReturnType<typeof vi.fn>; routeEvent: ReturnType<typeof vi.fn> };
  attachments: { upload: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  drafts: {
    checkpoint: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    settleAccepted: ReturnType<typeof vi.fn>;
  };
  skills: { apply: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> };
  onError: ReturnType<typeof vi.fn>;
} {
  return {
    operation: {
      begin: vi.fn((key: string) => ({ id: 1, key })),
      release: vi.fn(),
    },
    ids: { createClientRequestId: vi.fn(() => "request-retry") },
    session: {
      ensureProjectRegistered: vi.fn(async (projectId: string) => projectId),
      createConversation: vi.fn(async () => ({ projectId: "repo", conversationId: "conversation-new" })),
      beginPendingConversation: vi.fn(),
    },
    transport: {
      sendMessage: vi.fn(async () => { order.push("transport"); }),
    },
    timeline: {
      showPending: vi.fn(() => { order.push("optimistic"); }),
      markPending: vi.fn(),
      consumePending: vi.fn(),
      rekeyPending: vi.fn(),
      calibrate: vi.fn(async () => undefined),
    },
    projection: {
      refreshConversation: vi.fn(async () => undefined),
      routeEvent: vi.fn(),
    },
    attachments: {
      upload: vi.fn(async () => attachment("uploaded")),
      remove: vi.fn(async () => undefined),
    },
    drafts: {
      checkpoint: vi.fn((projectId: string, productMode: "agent" | "harness") => ({
        projectId,
        productMode,
        localRevision: 7,
      })),
      flush: vi.fn(async () => { order.push("flush"); return "draft-next"; }),
      settleAccepted: vi.fn(async () => { order.push("settle-draft"); }),
    },
    skills: {
      apply: vi.fn(async () => { order.push("skills"); }),
      reload: vi.fn(async () => undefined),
    },
    errors: {
      describe: vi.fn((cause: unknown) => cause instanceof Error ? cause.message : "发送失败"),
      classify: vi.fn((cause: unknown, transportStarted: boolean) => {
        if (!transportStarted) return "failed";
        if (cause instanceof WorkbenchRequestError) {
          return cause.status === 408 || cause.status >= 500 ? "uncertain" : "failed";
        }
        return "uncertain";
      }),
    },
    onError: vi.fn(),
  };
}

function draft(overrides: Partial<ConversationDraftViewModel> = {}): ConversationDraftViewModel {
  return {
    text: "",
    contextRefs: [],
    attachments: [],
    skillOverrides: {},
    agentTurnMode: "default",
    modelId: null,
    reasoningEffort: null,
    ...overrides,
  };
}

function submissionSnapshot(overrides: Partial<Parameters<typeof createDraftSubmissionSnapshot>[0]> = {}) {
  return createDraftSubmissionSnapshot({
    projectId: "repo",
    productMode: "agent",
    conversationId: null,
    clientRequestId: "request-original",
    draftRevision: "draft-1",
    text: "restored",
    contextRefs: [fileRef("src/restored.ts")],
    attachments: [attachment("existing")],
    skillOverrides: { restored: true },
    providerId: "codex",
    agentTurnMode: "plan",
    modelId: "gpt-next",
    reasoningEffort: "high",
    ...overrides,
  });
}

function draftHarness(initial: ConversationDraftViewModel) {
  const harness = {
    state: initial,
    dirtyCount: 0,
    port: undefined as never,
  };
  harness.port = {
    read: () => harness.state,
    setText: (update: (current: string) => string) => { harness.state.text = update(harness.state.text); },
    setContextRefs: (update: (current: TopicFileReference[]) => TopicFileReference[]) => {
      harness.state.contextRefs = update(harness.state.contextRefs);
    },
    setAttachments: (update: (current: TopicAttachment[]) => TopicAttachment[]) => {
      harness.state.attachments = update(harness.state.attachments);
    },
    setSkillOverrides: (update: (current: Record<string, boolean>) => Record<string, boolean>) => {
      harness.state.skillOverrides = update(harness.state.skillOverrides);
    },
    setAgentTurnMode: (value: ConversationDraftViewModel["agentTurnMode"]) => { harness.state.agentTurnMode = value; },
    setModelId: (value: string | null) => { harness.state.modelId = value; },
    setReasoningEffort: (value: string | null) => { harness.state.reasoningEffort = value; },
    markDirty: () => { harness.dirtyCount += 1; },
  };
  return harness;
}

function fileRef(relativePath: string): TopicFileReference {
  return { relativePath, name: relativePath.split("/").at(-1)!, kind: "file", source: "composer" };
}

function attachment(id: string): TopicAttachment {
  return {
    id,
    fileName: `${id}.txt`,
    mediaType: "text/plain",
    kind: "text",
    size: 5,
    hash: `hash-${id}`,
    source: "composer",
    createdAt: "2026-09-08T00:00:00.000Z",
    storagePath: `attachments/${id}/content.txt`,
    runtimeMode: "bounded-text-preview",
  };
}
