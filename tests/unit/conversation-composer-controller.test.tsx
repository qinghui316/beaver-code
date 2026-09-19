// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchRequestError } from "../../src/web/src/api.js";
import { ComposerDraftApiConflict } from "../../src/web/src/controllers/ComposerDraftSyncOwner.js";
import { createConversationComposerPortViews } from "../../src/web/src/controllers/conversation-composer-port-views.js";
import {
  activeComposerSkillIds,
  prepareComposerInput,
  useConversationComposerController,
  workbenchEventMatchesConversation,
  type ConversationComposerPorts,
  type ConversationComposerScope,
} from "../../src/web/src/controllers/useConversationComposerController.js";
import type { ComposerDraftSnapshot, ConversationTurnQueueSnapshot, ProviderCapabilitySnapshot, ProviderModelSettingsSnapshot, SkillListItem, TopicAttachment, TopicFileReference } from "../../src/web/src/types.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Conversation composer controller", () => {
  it.each(["send", "enqueue"] as const)("reserves one %s intent while access verification is pending", async (action) => {
    const ports = composerPorts();
    const selected = { accessMode: "default" as const, revision: 0, providerId: "codex" };
    let finish!: (selection: typeof selected) => void;
    const pending = new Promise<typeof selected>((resolve) => { finish = resolve; });
    const read = vi.fn().mockResolvedValueOnce(selected).mockImplementation(() => pending);
    ports.access = { read, save: vi.fn() };
    ports.queue = { snapshot: queueSnapshot("queue:0"), loading: false,
      enqueue: vi.fn(async () => queueSnapshot("queue:1")), reclaim: vi.fn(async () => queueSnapshot("queue:1")) };
    const { result } = renderHook(() => useConversationComposerController(conversationScope({ productMode: "agent" }), ports));
    await waitFor(() => expect(result.current.accessView.busy).toBe(false));
    act(() => result.current.setComposerText("one intentional submission"));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current[action](); second = result.current[action](); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { finish(selected); await Promise.all([first, second]); });
    expect(action === "send" ? ports.actions.sendMessage : ports.queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and reports failed access reads without an unhandled submission", async () => {
    const ports = composerPorts();
    ports.access = { read: async () => { throw new Error("unavailable"); }, save: async () => { throw new Error("unavailable"); } };
    ports.queue = { snapshot: queueSnapshot("queue:0"), loading: false,
      enqueue: vi.fn(async () => queueSnapshot("queue:1")), reclaim: vi.fn(async () => queueSnapshot("queue:1")) };
    const { result } = renderHook(() => useConversationComposerController(conversationScope({ productMode: "agent" }), ports));
    await waitFor(() => expect(result.current.accessView.failure).not.toBeNull());
    act(() => result.current.setComposerText("keep permission failure draft"));
    await act(async () => { await result.current.send(); await result.current.enqueue(); });
    expect(ports.actions.sendMessage).not.toHaveBeenCalled();
    expect(ports.queue.enqueue).not.toHaveBeenCalled();
    expect(result.current.composerText).toBe("keep permission failure draft");
    expect(ports.onError).toHaveBeenCalledWith("权限设置尚未就绪，请重新检测后发送。");
  });

  it("passes each owner a frozen runtime view containing only its declared capabilities", async () => {
    const ports = composerPorts();
    ports.queue = {
      snapshot: queueSnapshot("queue:0"),
      loading: false,
      enqueue: vi.fn(async () => queueSnapshot("queue:1")),
      reclaim: vi.fn(async () => queueSnapshot("queue:1")),
    };

    const views = createConversationComposerPortViews(ports);

    expect(Object.keys(views.draft).sort()).toEqual(["drafts", "onError", "session"]);
    expect(Object.keys(views.resources).sort()).toEqual(["attachments", "onError", "skills"]);
    expect(Object.keys(views.submission).sort()).toEqual([
      "actions", "attachments", "ids", "onError", "operation", "projection", "session", "timeline",
    ]);
    expect(Object.keys(views.execution).sort()).toEqual([
      "actions", "ids", "onError", "operation", "queue", "timeline",
    ]);
    expect((views.draft as unknown as Record<string, unknown>).actions).toBeUndefined();
    expect((views.resources as unknown as Record<string, unknown>).session).toBeUndefined();
    expect((views.submission as unknown as Record<string, unknown>).queue).toBeUndefined();
    expect((views.execution as unknown as Record<string, unknown>).attachments).toBeUndefined();
    expect(Object.isFrozen(views)).toBe(true);
    expect(Object.isFrozen(views.draft)).toBe(true);
    expect(Object.isFrozen(views.execution.queue?.snapshot)).toBe(true);
    expect(Object.isFrozen(views.execution.queue?.snapshot?.items)).toBe(true);

    const returned = await views.execution.queue!.enqueue({
      text: "queue me",
      contextRefs: [],
      attachmentIds: [],
      skillOverrides: {},
      providerId: "codex",
      agentTurnMode: "default",
      modelId: null,
      reasoningEffort: null,
      expectedDraftUpdatedAt: null,
    });
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned?.items)).toBe(true);
  });

  it("accepts realtime callbacks only for the captured project, mode, and Conversation", () => {
    const event = {
      event: "done",
      data: { projectId: "repo", productMode: "agent", conversationId: "conversation-1", status: "completed" },
    } as const;
    expect(workbenchEventMatchesConversation(event, {
      projectId: "repo",
      productMode: "agent",
      conversationId: "conversation-1",
    })).toBe(true);
    expect(workbenchEventMatchesConversation(event, {
      projectId: "repo",
      productMode: "harness",
      conversationId: "conversation-1",
    })).toBe(false);
    expect(workbenchEventMatchesConversation({
      event: "snapshot",
      data: {
        productMode: "agent",
        center: { selectedTopic: { id: "conversation-1", productMode: "agent" } },
      },
    }, {
      projectId: "repo",
      productMode: "agent",
      conversationId: "conversation-1",
    })).toBe(true);
  });

  it("prepares provider-neutral text, Skill overrides, and canonical file references", () => {
    const ref = fileRef("src/app.ts");
    expect(prepareComposerInput({
      body: "/reviewer inspect @src/app.ts",
      selectedRefs: [ref, ref],
      skills: [skill("reviewer")],
      conversationId: null,
      draftSkillOverrides: { formatter: false },
    })).toEqual({
      text: "inspect",
      contextRefs: [ref],
      skillOverrides: { formatter: false, reviewer: true },
    });

    expect(activeComposerSkillIds([
      skill("project", { enabledProject: true }),
      skill("topic", { enabledTopics: ["conversation-1"] }),
      skill("disabled", { enabledProject: true, disabledTopics: ["conversation-1"] }),
    ], "conversation-1", {})).toEqual(["project", "topic"]);
  });

  it("owns draft state and applies the explicit transition cleanup matrix", async () => {
    const ports = composerPorts();
    ports.skills.load.mockResolvedValue([skill("reviewer")]);
    const { result } = renderHook(() => useConversationComposerController(homeScope(), ports));
    await waitFor(() => expect(result.current.skillItems).toHaveLength(1));

    act(() => {
      result.current.setComposerText("keep this draft");
      result.current.setFileRefs([fileRef("src/app.ts")]);
      result.current.setAttachments([attachment("attachment-1")]);
    });
    await act(async () => result.current.toggleSkill("reviewer"));
    expect(result.current.activeSkillIds).toEqual(["reviewer"]);

    act(() => result.current.cleanupTransition("conversation-changed"));
    expect(result.current.composerText).toBe("keep this draft");
    expect(result.current.fileRefs).toEqual([]);
    expect(result.current.attachments).toEqual([]);
    expect(result.current.draftSkillOverrides).toEqual({});

    act(() => result.current.cleanupTransition("new-conversation"));
    expect(result.current.composerText).toBe("");
  });

  it("creates a Conversation through session ports and clears only after canonical success", async () => {
    const ports = composerPorts();
    ports.skills.load.mockResolvedValue([skill("reviewer")]);
    ports.session.createConversation.mockResolvedValue({ projectId: "repo", conversationId: "conversation-new" });
    const { result } = renderHook(() => useConversationComposerController(homeScope(), ports));
    await waitFor(() => expect(result.current.skillItems).toHaveLength(1));
    act(() => {
      result.current.setComposerText("/reviewer build feature");
      result.current.setFileRefs([fileRef("src/app.ts")]);
      result.current.setAttachments([attachment("existing")]);
    });

    await act(async () => {
      await result.current.createConversation();
    });

    expect(ports.session.createConversation).toHaveBeenCalledWith({
      projectId: "repo",
      productMode: "harness",
      clientRequestId: "request-1",
      body: "build feature",
      contextRefs: [fileRef("src/app.ts")],
      attachmentIds: ["existing"],
      providerId: "codex",
      agentTurnMode: undefined,
      modelId: null,
      reasoningEffort: null,
      skillOverrides: [{ skillId: "reviewer", enabled: true }],
      showPendingBeforeCreate: true,
    });
    expect(ports.skills.setEnabled).not.toHaveBeenCalled();
    expect(ports.projection.refreshConversation).toHaveBeenCalledWith("repo", "conversation-new");
    expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "conversation-new", "main-agent");
    expect(result.current.composerText).toBe("");
    expect(result.current.fileRefs).toEqual([]);
    expect(result.current.attachments).toEqual([]);
    expect(ports.operation.release).toHaveBeenCalledWith(expect.objectContaining({ key: "topic.create" }));
  });

  it("does not let a completed first send clear newer same-scope draft input", async () => {
    const ports = composerPorts();
    const creation = deferred<{ projectId: string; conversationId: string }>();
    ports.skills.load.mockResolvedValue([skill("reviewer")]);
    ports.session.createConversation.mockImplementation(() => creation.promise);
    const { result } = renderHook(() => useConversationComposerController(homeScope(), ports));
    await waitFor(() => expect(result.current.skillItems).toHaveLength(1));
    act(() => {
      result.current.setComposerText("first request");
      result.current.setFileRefs([fileRef("src/first.ts")]);
    });

    let request!: Promise<unknown>;
    act(() => { request = result.current.createConversation(); });
    await waitFor(() => expect(ports.session.createConversation).toHaveBeenCalledTimes(1));
    act(() => {
      result.current.setComposerText("next request");
      result.current.setFileRefs([fileRef("src/next.ts")]);
    });
    await act(async () => result.current.toggleSkill("reviewer"));
    await act(async () => {
      creation.resolve({ projectId: "repo", conversationId: "conversation-new" });
      await request;
    });

    expect(result.current.composerText).toBe("next request");
    expect(result.current.fileRefs).toEqual([fileRef("src/next.ts")]);
    expect(result.current.draftSkillOverrides).toEqual({ reviewer: true });
  });

  it("settles a first send without deleting a model selected for the next Turn", async () => {
    const ports = composerPorts();
    const creation = deferred<{ projectId: string; conversationId: string }>();
    let revision = 0;
    ports.session.createConversation.mockImplementation(() => creation.promise);
    ports.drafts.save.mockImplementation(async (input) => draftSnapshot({
      projectId: input.projectId,
      productMode: input.productMode,
      agentTurnMode: input.agentTurnMode,
      agentModelId: input.agentModelId,
      agentReasoningEffort: input.agentReasoningEffort,
      text: input.text,
      contextRefs: input.contextRefs,
      attachments: input.attachmentIds.map(attachment),
      skillOverrides: input.skillOverrides,
      selectedProviderId: input.selectedProviderId,
      updatedAt: `draft-${++revision}`,
    }));
    const scope = homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
      providerModelSettings: {
        ...providerModelSettings("codex"),
        candidates: [
          {
            providerId: "codex",
            modelId: "model-old",
            label: "Old",
            source: "runtime",
            supportedReasoningEfforts: [{ value: "medium", label: "中" }],
            defaultReasoningEffort: "medium",
          },
          {
            providerId: "codex",
            modelId: "model-next",
            label: "Next",
            source: "runtime",
            supportedReasoningEfforts: [{ value: "high", label: "高" }],
            defaultReasoningEffort: "high",
          },
        ],
      },
    });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalled());
    act(() => {
      result.current.selectAgentModel("model-old");
      result.current.setComposerText("first request");
    });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.createConversation(); });
    await waitFor(() => expect(ports.session.createConversation).toHaveBeenCalledOnce());
    act(() => result.current.selectAgentModel("model-next"));
    await act(async () => {
      creation.resolve({ projectId: "repo", conversationId: "conversation-new" });
      await pending;
    });

    expect(ports.drafts.delete).not.toHaveBeenCalled();
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "",
      agentModelId: "model-next",
      expectedUpdatedAt: "draft-1",
    }));
    expect(result.current.agentModelId).toBe("model-next");
  });

  it("persists a follow-up drafted during the active request and restores it after remount", async () => {
    const ports = composerPorts();
    const sending = deferred<void>();
    let stored: ComposerDraftSnapshot | null = null;
    let revision = 0;
    ports.actions.sendMessage.mockImplementation(() => sending.promise);
    ports.drafts.load.mockImplementation(async () => stored);
    ports.drafts.save.mockImplementation(async (input) => {
      stored = draftSnapshot({
        projectId: input.projectId,
        productMode: input.productMode,
        agentTurnMode: input.agentTurnMode,
        agentModelId: input.agentModelId,
        agentReasoningEffort: input.agentReasoningEffort,
        text: input.text,
        contextRefs: input.contextRefs,
        attachments: input.attachmentIds.map(attachment),
        skillOverrides: input.skillOverrides,
        selectedProviderId: input.selectedProviderId,
        updatedAt: `draft-${++revision}`,
      });
      return stored;
    });
    const scope = conversationScope();
    const first = renderHook(() => useConversationComposerController(scope, ports));
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalledOnce());
    act(() => first.result.current.setComposerText("submitted request"));

    let pending!: Promise<void>;
    act(() => { pending = first.result.current.send(); });
    await waitFor(() => expect(ports.actions.sendMessage).toHaveBeenCalledOnce());
    act(() => first.result.current.setComposerText("next request"));
    await act(async () => {
      sending.resolve();
      await pending;
    });

    expect(stored?.text).toBe("next request");
    expect(ports.drafts.delete).not.toHaveBeenCalled();
    first.unmount();

    const restored = renderHook(() => useConversationComposerController(scope, ports));
    await waitFor(() => expect(restored.result.current.composerText).toBe("next request"));
    restored.unmount();
  });

  it("settles an accepted Review command through the shared draft owner after navigation", async () => {
    const command = "/review custom inspect the boundary";
    const ports = composerPorts();
    ports.drafts.load.mockResolvedValue(draftSnapshot({ text: command }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: homeScope({ productMode: "agent" }) } },
    );
    await waitFor(() => expect(result.current.composerText).toBe(command));

    rerender({ scope: conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      conversation: {
        id: "review-conversation",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      },
    }) });
    ports.drafts.save.mockResolvedValueOnce(draftSnapshot({
      text: "",
      updatedAt: "2026-09-01T01:00:01.000Z",
    }));

    await act(async () => {
      await result.current.clearAcceptedReviewCommand(command, "2026-08-20T00:00:00.000Z");
    });

    expect(ports.drafts.save).toHaveBeenCalledTimes(1);
    expect(ports.drafts.save).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo",
      productMode: "agent",
      text: "",
      expectedUpdatedAt: "2026-08-20T00:00:00.000Z",
    }));
    expect(result.current.composerText).toBe("");
  });

  it("does not let late Review draft settlement erase input entered after command acceptance", async () => {
    const command = "/review custom inspect the boundary";
    const ports = composerPorts();
    const settlement = deferred<ComposerDraftSnapshot>();
    ports.drafts.load.mockResolvedValue(draftSnapshot({ text: command }));
    ports.drafts.save.mockImplementationOnce(() => settlement.promise);
    const { result } = renderHook(() => useConversationComposerController(
      homeScope({ productMode: "agent" }),
      ports,
    ));
    await waitFor(() => expect(result.current.composerText).toBe(command));

    let pending!: Promise<void>;
    act(() => { pending = result.current.clearAcceptedReviewCommand(command, "2026-08-20T00:00:00.000Z"); });
    await waitFor(() => expect(result.current.composerText).toBe(""));
    act(() => result.current.setComposerText("next user request"));
    await act(async () => {
      settlement.resolve(draftSnapshot({ text: "", updatedAt: "2026-09-01T01:00:00.000Z" }));
      await pending;
    });

    expect(result.current.composerText).toBe("next user request");
  });

  it("preserves a Review command re-entered with the same value after its mutation token was captured", async () => {
    const command = "/review custom inspect the boundary";
    const ports = composerPorts();
    ports.drafts.load.mockResolvedValue(draftSnapshot({ text: command }));
    const { result } = renderHook(() => useConversationComposerController(
      homeScope({ productMode: "agent" }),
      ports,
    ));
    await waitFor(() => expect(result.current.composerText).toBe(command));
    const mutationToken = result.current.captureDraftMutationToken();
    act(() => {
      result.current.setComposerText("changed while Review is pending");
      result.current.setComposerText(command);
    });

    await act(async () => {
      await result.current.clearAcceptedReviewCommand(
        command,
        "2026-08-20T00:00:00.000Z",
        mutationToken,
      );
    });

    expect(result.current.composerText).toBe(command);
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({ text: command }));
  });

  it("calibrates a committed single-Provider Conversation when capability discovery was still loading", async () => {
    const ports = composerPorts();
    const creation = deferred<{ projectId: string; conversationId: string }>();
    ports.session.createConversation.mockImplementation(() => creation.promise);
    const initial = homeScope({
      productMode: "agent",
      selectedProviderId: null,
      providerCapabilities: undefined,
      providerCapabilitiesLoading: true,
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: initial } },
    );
    act(() => result.current.setComposerText("plan this safely"));

    let request!: Promise<unknown>;
    act(() => { request = result.current.createConversation(); });
    rerender({ scope: conversationScope({
      productMode: "agent",
      selectedProviderId: null,
      providerCount: 1,
      providerCapabilities: [providerCapability("codex", true)],
      conversation: {
        id: "conversation-single-provider",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      },
    }) });
    await act(async () => {
      creation.resolve({ projectId: "repo", conversationId: "conversation-single-provider" });
      await request;
    });

    expect(ports.session.createConversation).toHaveBeenCalledWith(expect.objectContaining({ providerId: undefined }));
    expect(ports.projection.refreshConversation).toHaveBeenCalledWith("repo", "conversation-single-provider");
    expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "conversation-single-provider", "main-agent");
  });

  it("cleans transient uploads and keeps the failed first send recoverable from its optimistic row", async () => {
    const ports = composerPorts();
    ports.session.createConversation.mockRejectedValue(new Error("create failed"));
    ports.attachments.upload.mockResolvedValue(attachment("uploaded"));
    const { result } = renderHook(() => useConversationComposerController(homeScope(), ports));
    act(() => result.current.setComposerText("keep me"));

    await act(async () => {
      await expect(result.current.createConversation({
        attachmentFiles: [new File(["hello"], "note.txt", { type: "text/plain" })],
      })).rejects.toThrow("create failed");
    });

    expect(ports.attachments.remove).toHaveBeenCalledWith("repo", "uploaded");
    expect(result.current.composerText).toBe("");
    expect(ports.timeline.markPending).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "pending:request-1" }),
      "request-1",
      "uncertain",
      expect.any(String),
    );
    expect(ports.onError).toHaveBeenLastCalledWith("消息暂时无法发送。请重试。");
  });

  it("settles first-send resources when retry navigation advances to the canonical Conversation", async () => {
    const ports = composerPorts();
    const retriedCreation = deferred<{ projectId: string; conversationId: string }>();
    ports.ids.createClientRequestId
      .mockReturnValueOnce("request-first")
      .mockReturnValueOnce("request-retry");
    ports.skills.load.mockResolvedValue([skill("reviewer")]);
    ports.session.createConversation
      .mockRejectedValueOnce(new WorkbenchRequestError(400, "create rejected"))
      .mockImplementationOnce(() => retriedCreation.promise);
    const initial = homeScope({ productMode: "agent", providerCapabilities: [providerCapability("codex", true)] });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: initial } },
    );
    await waitFor(() => expect(result.current.skillItems).toHaveLength(1));
    act(() => {
      result.current.setComposerText("retry this first send");
      result.current.setFileRefs([fileRef("src/retry.ts")]);
      result.current.setAttachments([attachment("attachment-retry")]);
    });
    await act(async () => result.current.toggleSkill("reviewer"));

    await act(async () => {
      await expect(result.current.createConversation()).rejects.toBeInstanceOf(WorkbenchRequestError);
    });
    expect(result.current.composerText).toBe("");
    expect(result.current.fileRefs).toHaveLength(1);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.draftSkillOverrides).toEqual({ reviewer: true });

    let retry!: Promise<void>;
    act(() => { retry = result.current.retryPendingIntent("request-first"); });
    await waitFor(() => expect(ports.session.createConversation).toHaveBeenCalledTimes(2));
    await act(async () => {
      retriedCreation.resolve({ projectId: "repo", conversationId: "conversation-retried" });
      rerender({ scope: conversationScope({
        productMode: "agent",
        selectedProviderId: "codex",
        providerCapabilities: [providerCapability("codex", true)],
        conversation: {
          id: "conversation-retried",
          productMode: "agent",
          state: "active",
          selectedProviderId: "codex",
        },
      }) });
      await retry;
    });

    expect(result.current.fileRefs).toEqual([]);
    expect(result.current.attachments).toEqual([]);
    expect(result.current.draftSkillOverrides).toEqual({});
    expect(ports.projection.refreshConversation).toHaveBeenCalledWith("repo", "conversation-retried");
    expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "conversation-retried", "main-agent");
  });

  it("keeps resources deliberately removed and re-added before a first-send retry settles", async () => {
    const ports = composerPorts();
    ports.ids.createClientRequestId
      .mockReturnValueOnce("request-first")
      .mockReturnValueOnce("request-retry");
    ports.skills.load.mockResolvedValue([skill("reviewer")]);
    ports.session.createConversation
      .mockRejectedValueOnce(new WorkbenchRequestError(400, "create rejected"))
      .mockResolvedValueOnce({ projectId: "repo", conversationId: "conversation-retried" });
    const { result } = renderHook(() => useConversationComposerController(homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
    }), ports));
    await waitFor(() => expect(result.current.skillItems).toHaveLength(1));
    act(() => {
      result.current.setComposerText("retry preserved resources");
      result.current.setFileRefs([fileRef("src/retry.ts")]);
      result.current.setAttachments([attachment("attachment-retry")]);
    });
    await act(async () => result.current.toggleSkill("reviewer"));
    await act(async () => {
      await expect(result.current.createConversation()).rejects.toBeInstanceOf(WorkbenchRequestError);
    });

    act(() => {
      result.current.setFileRefs([]);
      result.current.setAttachments([]);
    });
    await act(async () => result.current.toggleSkill("reviewer"));
    act(() => {
      result.current.setFileRefs([fileRef("src/retry.ts")]);
      result.current.setAttachments([attachment("attachment-retry")]);
    });
    await act(async () => result.current.toggleSkill("reviewer"));
    await act(async () => result.current.retryPendingIntent("request-first"));

    expect(result.current.fileRefs).toEqual([expect.objectContaining({ relativePath: "src/retry.ts" })]);
    expect(result.current.attachments).toEqual([expect.objectContaining({ id: "attachment-retry" })]);
    expect(result.current.draftSkillOverrides).toEqual({ reviewer: true });
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({
      contextRefs: [expect.objectContaining({ relativePath: "src/retry.ts" })],
      attachmentIds: ["attachment-retry"],
      skillOverrides: { reviewer: true },
    }));
  });

  it("sends ordinary messages through the action port and restores failed text without overwriting newer edits", async () => {
    let rejectSend!: (cause: Error) => void;
    const ports = composerPorts();
    ports.actions.sendMessage.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const scope = conversationScope();
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    act(() => {
      result.current.setComposerText("first message");
      result.current.setFileRefs([fileRef("src/app.ts")]);
      result.current.setAttachments([attachment("attachment-1")]);
    });

    let sendPromise!: Promise<void>;
    act(() => { sendPromise = result.current.send(); });
    await waitFor(() => expect(result.current.composerText).toBe(""));
    act(() => result.current.setComposerText("newer edit"));
    await act(async () => {
      rejectSend(new Error("network failed"));
      await expect(sendPromise).rejects.toThrow("network failed");
    });

    expect(result.current.composerText).toBe("newer edit");
    expect(result.current.fileRefs).toEqual([fileRef("src/app.ts")]);
    expect(result.current.attachments).toEqual([attachment("attachment-1")]);
    expect(ports.actions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo",
      conversationId: "conversation-1",
      message: "first message",
      attachmentIds: ["attachment-1"],
      providerId: "claude",
      providerSwitchIntent: "resume-workflow",
    }));
    expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "conversation-1", "main-agent");
  });

  it("keeps the active Turn routed while next-Turn mode, model, and effort change", async () => {
    const sending = deferred<void>();
    const ports = composerPorts();
    ports.actions.sendMessage.mockImplementation(() => sending.promise);
    const scope = conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      providerCapabilities: [providerCapability("codex", true)],
      providerModelSettings: {
        ...providerModelSettings("codex"),
        candidates: [
          {
            providerId: "codex",
            modelId: "model-current",
            label: "Current",
            source: "runtime",
            supportedReasoningEfforts: [{ value: "low", label: "低" }],
            defaultReasoningEffort: "low",
          },
          {
            providerId: "codex",
            modelId: "model-next",
            label: "Next",
            source: "runtime",
            supportedReasoningEfforts: [{ value: "high", label: "高" }],
            defaultReasoningEffort: "high",
          },
        ],
      },
      conversation: {
        id: "conversation-1",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
        agentTurnMode: "default",
        agentModelId: "model-current",
        agentReasoningEffort: "low",
      },
    });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    act(() => result.current.setComposerText("use the captured current configuration"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.actions.sendMessage).toHaveBeenCalledOnce());
    await act(async () => {
      await result.current.selectAgentTurnMode("plan");
      result.current.selectAgentModel("model-next");
      result.current.selectAgentReasoningEffort("high");
    });
    await act(async () => {
      sending.resolve();
      await pending;
    });

    expect(ports.actions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentTurnMode: "default",
      modelId: "model-current",
      reasoningEffort: "low",
    }));
    expect(result.current.agentTurnMode).toBe("plan");
    expect(result.current.agentModelId).toBe("model-next");
    expect(result.current.agentReasoningEffort).toBe("high");
    expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "conversation-1", "main-agent");
  });

  it("publishes the optimistic user row before draft persistence and network dispatch", async () => {
    const persisted = deferred<ComposerDraftSnapshot>();
    const ports = composerPorts();
    ports.drafts.save.mockImplementationOnce(() => persisted.promise);
    const { result } = renderHook(() => useConversationComposerController(conversationScope(), ports));
    act(() => result.current.setComposerText("visible immediately"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });

    expect(ports.timeline.showPending).toHaveBeenCalledWith(
      { projectId: "repo", productMode: "harness", conversationId: "conversation-1" },
      "request-1",
      "visible immediately",
    );
    expect(result.current.composerText).toBe("");
    expect(ports.actions.sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      persisted.resolve(draftSnapshot({ productMode: "harness", agentTurnMode: null, text: "visible immediately" }));
      await pending;
    });
    expect(ports.actions.sendMessage).toHaveBeenCalledOnce();
  });

  it("loads the draft for a registered Agent project independently of Harness management", async () => {
    const ports = composerPorts();
    ports.drafts.load.mockResolvedValue(draftSnapshot({
      productMode: "agent",
      text: "registered project draft",
      updatedAt: "registered-token",
    }));

    const { result } = renderHook(() => useConversationComposerController(homeScope({
      productMode: "agent",
      projectRegistered: true,
      providerCapabilities: [providerCapability("codex", true)],
    }), ports));

    await waitFor(() => expect(result.current.composerText).toBe("registered project draft"));
    expect(ports.drafts.load).toHaveBeenCalledWith("repo", "agent");
  });

  it("keeps a canonical send successful when accepted-draft settlement conflicts", async () => {
    const ports = composerPorts();
    let savedRevision = 2;
    ports.ids.createClientRequestId
      .mockReturnValueOnce("request-1")
      .mockReturnValueOnce("request-2");
    ports.drafts.load
      .mockResolvedValueOnce(draftSnapshot({ updatedAt: "draft-0" }))
      .mockResolvedValueOnce(draftSnapshot({ text: "other window", updatedAt: "draft-2" }));
    ports.drafts.save
      .mockResolvedValueOnce(draftSnapshot({ text: "first request", updatedAt: "draft-1" }))
      .mockRejectedValueOnce(new ComposerDraftApiConflict(draftSnapshot({
        text: "other window",
        updatedAt: "draft-2",
      })))
      .mockImplementation(async (input) => draftSnapshot({
        productMode: input.productMode,
        agentTurnMode: input.agentTurnMode,
        agentModelId: input.agentModelId,
        agentReasoningEffort: input.agentReasoningEffort,
        text: input.text,
        contextRefs: input.contextRefs,
        attachments: input.attachmentIds.map(attachment),
        skillOverrides: input.skillOverrides,
        selectedProviderId: input.selectedProviderId,
        updatedAt: `draft-${++savedRevision}`,
      }));
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      providerCapabilities: [providerCapability("codex", true)],
      conversation: {
        id: "conversation-1",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      },
    }), ports));
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalledOnce());

    act(() => result.current.setComposerText("first request"));
    await act(async () => { await result.current.send(); });

    expect(ports.actions.sendMessage).toHaveBeenCalledTimes(1);
    expect(ports.timeline.markPending).not.toHaveBeenCalled();
    expect(ports.onError).toHaveBeenLastCalledWith("消息已发送，草稿已重新同步。");

    act(() => result.current.setComposerText("second request"));
    await act(async () => { await result.current.send(); });

    expect(ports.actions.sendMessage).toHaveBeenCalledTimes(2);
    expect(ports.actions.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      clientRequestId: "request-2",
      message: "second request",
    }));
    expect(ports.timeline.markPending).not.toHaveBeenCalled();
  });

  it.each([
    { status: 400, expected: "failed" },
    { status: 408, expected: "uncertain" },
    { status: 503, expected: "uncertain" },
  ] as const)("classifies an HTTP $status submission failure as $expected", async ({ status, expected }) => {
    const ports = composerPorts();
    ports.actions.sendMessage.mockRejectedValue(new WorkbenchRequestError(status, "bounded failure"));
    const { result } = renderHook(() => useConversationComposerController(conversationScope(), ports));
    act(() => result.current.setComposerText(`request ${status}`));

    await act(async () => {
      await expect(result.current.send()).rejects.toBeInstanceOf(WorkbenchRequestError);
    });

    expect(ports.timeline.markPending).toHaveBeenCalledWith(
      { projectId: "repo", productMode: "harness", conversationId: "conversation-1" },
      "request-1",
      expected,
      expect.any(String),
    );
  });

  it("keeps a captured first send running after a mode switch without overwriting the new draft", async () => {
    let resolveRegistration!: (projectId: string) => void;
    const ports = composerPorts();
    ports.session.ensureProjectRegistered.mockImplementation(() => new Promise<string>((resolve) => {
      resolveRegistration = resolve;
    }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: homeScope({ productMode: "agent" }) } },
    );
    act(() => result.current.setComposerText("agent request"));

    let creation!: Promise<{ projectId: string; conversationId: string } | null>;
    act(() => { creation = result.current.createConversation(); });
    await waitFor(() => expect(ports.session.ensureProjectRegistered).toHaveBeenCalledWith("repo"));
    rerender({ scope: homeScope({ productMode: "harness" }) });
    act(() => result.current.setComposerText("harness draft"));
    await act(async () => { resolveRegistration("repo"); await creation; });

    expect(ports.session.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo",
      productMode: "agent",
      clientRequestId: "request-1",
      body: "agent request",
    }));
    expect(result.current.composerText).toBe("harness draft");
    expect(ports.projection.refreshConversation).not.toHaveBeenCalled();
    expect(ports.timeline.calibrate).not.toHaveBeenCalled();
  });

  it("captures mode for an existing send before an immediate mode switch", async () => {
    let resolveSend!: () => void;
    const ports = composerPorts();
    ports.actions.sendMessage.mockImplementation(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: conversationScope({
        productMode: "agent",
        providerCapabilities: [providerCapability("codex", true), providerCapability("claude", true)],
        conversation: {
        id: "agent-conversation",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      } }) } },
    );
    act(() => result.current.setComposerText("captured turn"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.actions.sendMessage).toHaveBeenCalledOnce());
    rerender({ scope: homeScope({ productMode: "harness", conversation: null }) });
    await act(async () => { resolveSend(); await pending; });

    expect(ports.actions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo",
      productMode: "agent",
      conversationId: "agent-conversation",
      message: "captured turn",
    }));
  });

  it("restores an empty Agent draft mode and captures it in the atomic first send", async () => {
    const ports = composerPorts();
    ports.drafts.load.mockResolvedValue(draftSnapshot({ agentTurnMode: "plan" }));
    const scope = homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
    });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    await waitFor(() => expect(result.current.agentTurnMode).toBe("plan"));
    act(() => result.current.setComposerText("plan this change"));

    await act(async () => { await result.current.createConversation(); });

    expect(ports.session.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      productMode: "agent",
      agentTurnMode: "plan",
      body: "plan this change",
    }));
  });

  it("restores the full mode-isolated draft and keeps an unavailable Provider selected", async () => {
    const ports = composerPorts();
    ports.skills.load.mockResolvedValue([skill("reviewer")]);
    ports.drafts.load.mockResolvedValue(draftSnapshot({
      agentTurnMode: "plan",
      text: "restored text",
      contextRefs: [fileRef("src/app.ts")],
      attachments: [attachment("restored-attachment")],
      skillOverrides: { reviewer: true },
      selectedProviderId: "missing-provider",
      diagnostics: [{ code: "unavailable-provider", message: "已保存的 Agent 当前不可用，请重新选择后再发送。" }],
    }));
    const scope = homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
    });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));

    await waitFor(() => expect(result.current.composerText).toBe("restored text"));
    expect(result.current.agentTurnMode).toBe("plan");
    expect(result.current.fileRefs).toEqual([fileRef("src/app.ts")]);
    expect(result.current.attachments).toEqual([attachment("restored-attachment")]);
    expect(result.current.activeSkillIds).toEqual(["reviewer"]);
    expect(result.current.draftDiagnostics).toEqual([
      expect.objectContaining({ code: "unavailable-provider" }),
    ]);
    expect(ports.session.restoreDraftProvider).toHaveBeenCalledWith("missing-provider");
  });

  it("prefers each stored Conversation mode while reserving the project draft mode for the empty Composer", async () => {
    const ports = composerPorts();
    ports.drafts.load.mockResolvedValue(draftSnapshot({ agentTurnMode: "plan" }));
    const first = conversationScope({
      productMode: "agent",
      conversation: {
        id: "default-conversation",
        productMode: "agent",
        agentTurnMode: "default",
        state: "active",
        selectedProviderId: "codex",
      },
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: first } },
    );
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalled());
    expect(result.current.agentTurnMode).toBe("default");
    rerender({ scope: homeScope({ productMode: "agent", providerCapabilities: [providerCapability("codex", true)] }) });
    await waitFor(() => expect(result.current.agentTurnMode).toBe("plan"));
  });

  it("retains Plan across a Provider switch and blocks unsupported dispatch without side effects", async () => {
    const ports = composerPorts();
    const initial = conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      conversation: {
        id: "agent-conversation",
        productMode: "agent",
        agentTurnMode: "plan",
        state: "active",
        selectedProviderId: "codex",
      },
      providerCapabilities: [providerCapability("codex", true)],
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: initial } },
    );
    expect(result.current.agentTurnMode).toBe("plan");

    rerender({ scope: {
      ...initial,
      selectedProviderId: "other-provider",
      providerCapabilities: [providerCapability("codex", true), providerCapability("other-provider", false)],
    } });
    act(() => result.current.setComposerText("must stay local"));
    await act(async () => { await result.current.send(); });

    expect(result.current.agentTurnMode).toBe("plan");
    expect(result.current.agentTurnModeDisabledReason).toBe("当前 Agent 不支持计划模式。");
    expect(ports.actions.sendMessage).not.toHaveBeenCalled();
    expect(ports.skills.setEnabled).not.toHaveBeenCalled();
    expect(result.current.composerText).toBe("must stay local");
  });

  it("keeps a selected Plan on capability query failure and blocks dispatch until recovery", async () => {
    const ports = composerPorts();
    const scope = conversationScope({
      productMode: "agent",
      conversation: {
        id: "agent-conversation",
        productMode: "agent",
        agentTurnMode: "plan",
        state: "active",
        selectedProviderId: "codex",
      },
      providerCapabilities: [],
      providerCapabilitiesError: "Provider capability request failed",
    });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    act(() => result.current.setComposerText("preserve this plan request"));

    await act(async () => { await result.current.send(); });

    expect(result.current.agentTurnMode).toBe("plan");
    expect(result.current.agentTurnModeDisabledReason).toContain("Provider capability request failed");
    expect(ports.actions.sendMessage).not.toHaveBeenCalled();
    expect(result.current.composerText).toBe("preserve this plan request");
  });

  it("retains attachments after switching to a Provider without file reference support", async () => {
    const ports = composerPorts();
    const initial = conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      conversation: {
        id: "agent-conversation",
        productMode: "agent",
        agentTurnMode: "default",
        state: "active",
        selectedProviderId: "codex",
      },
      providerCapabilities: [providerCapability("codex", true)],
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: initial } },
    );
    act(() => {
      result.current.setComposerText("read the retained file");
      result.current.setAttachments([attachment("retained-attachment")]);
    });

    rerender({ scope: {
      ...initial,
      selectedProviderId: "other-provider",
      providerCapabilities: [providerCapability("codex", true), providerCapability("other-provider", true, false)],
      providerModelSettings: providerModelSettings("other-provider"),
    } });
    await act(async () => { await result.current.send(); });

    expect(result.current.attachments).toEqual([expect.objectContaining({ id: "retained-attachment" })]);
    expect(result.current.composerText).toBe("read the retained file");
    expect(ports.actions.sendMessage).not.toHaveBeenCalled();
    expect(ports.onError).toHaveBeenLastCalledWith("当前 Agent 不支持文件引用。");
  });

  it("persists an empty Agent mode selection without writing a Harness draft", async () => {
    const ports = composerPorts();
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: homeScope({ productMode: "agent", providerCapabilities: [providerCapability("codex", true)] }) } },
    );
    await act(async () => { await result.current.selectAgentTurnMode("plan"); });
    await waitFor(() => expect(ports.drafts.save).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo",
      productMode: "agent",
      agentTurnMode: "plan",
      selectedProviderId: "codex",
      expectedUpdatedAt: null,
    })));

    rerender({ scope: homeScope({ productMode: "harness" }) });
    await act(async () => { await result.current.selectAgentTurnMode("plan"); });
    expect(ports.drafts.save).toHaveBeenCalledTimes(1);
    expect(result.current.agentTurnMode).toBe("default");
  });

  it("persists text edits after the project-mode draft has loaded", async () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(
      homeScope({ productMode: "agent", providerCapabilities: [providerCapability("codex", true)] }),
      ports,
    ));
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalledWith("repo", "agent"));

    act(() => result.current.setComposerText("durable text draft"));

    await waitFor(() => expect(ports.drafts.save).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo",
      productMode: "agent",
      text: "durable text draft",
      expectedUpdatedAt: null,
    })));
  });

  it("loads and persists a draft when a selected project becomes registered", async () => {
    const ports = composerPorts();
    const unregisteredScope = homeScope({
      projectRegistered: false,
      productMode: "harness",
      providerCapabilities: [],
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: unregisteredScope } },
    );

    expect(ports.drafts.load).not.toHaveBeenCalled();
    rerender({ scope: { ...unregisteredScope, projectRegistered: true } });
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalledWith("repo", "harness"));

    act(() => result.current.setComposerText("managed transition draft"));

    await waitFor(() => expect(ports.drafts.save).toHaveBeenCalledWith(expect.objectContaining({
      productMode: "harness",
      agentTurnMode: null,
      text: "managed transition draft",
    })));
  });

  it("preserves and persists an edit made while registered-project draft recovery is pending", async () => {
    const ports = composerPorts();
    const pendingDraft = deferred<ComposerDraftSnapshot | null>();
    ports.drafts.load.mockImplementationOnce(() => pendingDraft.promise);
    const unregisteredScope = homeScope({
      projectRegistered: false,
      productMode: "harness",
      providerCapabilities: [],
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: unregisteredScope } },
    );

    rerender({ scope: { ...unregisteredScope, projectRegistered: true } });
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalledWith("repo", "harness"));
    act(() => result.current.setComposerText("typed during recovery"));
    await act(async () => { pendingDraft.resolve(draftSnapshot({ productMode: "harness", agentTurnMode: null })); });

    expect(result.current.composerText).toBe("typed during recovery");
    await waitFor(() => expect(ports.drafts.save).toHaveBeenCalledWith(expect.objectContaining({
      text: "typed during recovery",
    })));
  });

  it("persists edits made after restoring an existing full draft", async () => {
    const ports = composerPorts();
    ports.drafts.load.mockResolvedValue(draftSnapshot({ text: "restored text" }));
    const { result } = renderHook(() => useConversationComposerController(
      homeScope({ productMode: "agent", providerCapabilities: [providerCapability("codex", true)] }),
      ports,
    ));
    await waitFor(() => expect(result.current.composerText).toBe("restored text"));

    act(() => result.current.setComposerText("edited restored text"));

    await waitFor(() => expect(ports.drafts.save).toHaveBeenCalledWith(expect.objectContaining({
      text: "edited restored text",
      expectedUpdatedAt: "2026-08-20T00:00:00.000Z",
    })));
  });

  it("restores the persisted empty Agent draft after an Agent to Harness to Agent transition", async () => {
    const ports = composerPorts();
    const restoredDraft = deferred<ComposerDraftSnapshot | null>();
    ports.drafts.load
      .mockResolvedValueOnce(draftSnapshot({ agentTurnMode: "plan", text: "agent-only draft" }))
      .mockImplementationOnce(() => restoredDraft.promise);
    const agentScope = homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: agentScope } },
    );

    await waitFor(() => expect(result.current.composerText).toBe("agent-only draft"));
    rerender({ scope: homeScope({ productMode: "harness", providerCapabilities: [] }) });
    await waitFor(() => expect(result.current.agentTurnMode).toBe("default"));
    expect(result.current.composerText).toBe("");
    rerender({ scope: {
      ...agentScope,
      providerCapabilities: undefined,
      providerCapabilitiesLoading: true,
    } });
    rerender({ scope: agentScope });

    expect(result.current.agentTurnMode).toBe("plan");
    await act(async () => { restoredDraft.resolve(draftSnapshot({ agentTurnMode: "plan" })); });
    await waitFor(() => expect(result.current.agentTurnMode).toBe("plan"));
    expect(ports.drafts.load).toHaveBeenCalledTimes(3);
    expect(ports.drafts.load).toHaveBeenNthCalledWith(2, "repo", "harness");
  });

  it("uses one captured Skill identity while follow-up overrides are pending", async () => {
    const firstOverride = deferred<void>();
    const ports = composerPorts();
    ports.skills.load.mockResolvedValue([
      skill("reviewer", { enabledProject: true }),
      skill("formatter", { enabledProject: true }),
    ]);
    ports.skills.setEnabled
      .mockImplementationOnce(() => firstOverride.promise)
      .mockResolvedValueOnce(undefined);
    const initialScope = conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      conversation: {
        id: "agent-conversation",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      },
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: initialScope } },
    );
    await waitFor(() => expect(result.current.skillItems).toHaveLength(2));
    act(() => result.current.setComposerText("/reviewer /formatter inspect"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.skills.setEnabled).toHaveBeenCalledTimes(1));
    rerender({ scope: conversationScope({
      productMode: "harness",
      selectedProviderId: "other-provider",
      conversation: {
        id: "harness-conversation",
        productMode: "harness",
        state: "active",
        selectedProviderId: "other-provider",
      },
    }) });
    act(() => result.current.setComposerText("new scope draft"));
    await act(async () => { firstOverride.resolve(); await pending; });

    expect(ports.skills.setEnabled).toHaveBeenCalledTimes(2);
    for (const [identity] of ports.skills.setEnabled.mock.calls) {
      expect(identity).toEqual({
        projectId: "repo",
        productMode: "agent",
        conversationId: "agent-conversation",
        providerId: "codex",
      });
    }
    expect(ports.actions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "repo",
      productMode: "agent",
      conversationId: "agent-conversation",
      providerId: "codex",
    }));
    expect(result.current.composerText).toBe("new scope draft");
    expect(ports.onError).not.toHaveBeenCalledWith(expect.any(String));
  });

  it("uses the stored Conversation Provider for Skill overrides before a Provider switch", async () => {
    const ports = composerPorts();
    ports.skills.load.mockResolvedValue([skill("reviewer", { enabledProject: true })]);
    const scope = conversationScope({
      productMode: "harness",
      selectedProviderId: "other-provider",
      conversation: {
        id: "conversation-switch",
        productMode: "harness",
        state: "active",
        selectedProviderId: "codex",
      },
    });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    await waitFor(() => expect(result.current.skillItems).toHaveLength(1));
    act(() => result.current.setComposerText("/reviewer switch and continue"));

    await act(async () => { await result.current.send(); });

    expect(ports.skills.setEnabled).toHaveBeenCalledWith({
      projectId: "repo",
      productMode: "harness",
      conversationId: "conversation-switch",
      providerId: "codex",
    }, "reviewer", true);
    expect(ports.actions.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-switch",
      providerId: "other-provider",
      providerSwitchIntent: "resume-workflow",
    }));
  });

  it("does not clear the new mode refs or attachments when an old send completes", async () => {
    let resolveSend!: () => void;
    const ports = composerPorts();
    ports.actions.sendMessage.mockImplementation(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: conversationScope({
        productMode: "agent",
        providerCapabilities: [providerCapability("codex", true), providerCapability("claude", true)],
        conversation: {
        id: "agent-conversation",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      } }) } },
    );
    act(() => {
      result.current.setComposerText("agent turn");
      result.current.setFileRefs([fileRef("src/agent.ts")]);
      result.current.setAttachments([attachment("agent-attachment")]);
    });
    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.actions.sendMessage).toHaveBeenCalledOnce());

    rerender({ scope: conversationScope({ productMode: "harness", conversation: {
      id: "harness-conversation",
      productMode: "harness",
      state: "active",
      selectedProviderId: "codex",
    } }) });
    act(() => {
      result.current.setComposerText("harness draft");
      result.current.setFileRefs([fileRef("src/harness.ts")]);
      result.current.setAttachments([attachment("harness-attachment")]);
    });
    await act(async () => { resolveSend(); await pending; });

    expect(result.current.composerText).toBe("harness draft");
    expect(result.current.fileRefs).toEqual([fileRef("src/harness.ts")]);
    expect(result.current.attachments).toEqual([attachment("harness-attachment")]);
  });

  it("does not surface or calibrate a failed Turn after its mode becomes inactive", async () => {
    let rejectSend!: (cause: Error) => void;
    const ports = composerPorts();
    ports.actions.sendMessage.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: conversationScope({ productMode: "agent", conversation: {
        id: "agent-conversation",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      } }) } },
    );
    act(() => result.current.setComposerText("agent turn"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.actions.sendMessage).toHaveBeenCalledOnce());
    rerender({ scope: homeScope({ productMode: "harness", conversation: null }) });
    act(() => result.current.setComposerText("harness draft"));
    await act(async () => {
      rejectSend(new Error("inactive turn failed"));
      await expect(pending).rejects.toThrow("inactive turn failed");
    });

    expect(result.current.composerText).toBe("harness draft");
    expect(ports.onError).not.toHaveBeenCalledWith("inactive turn failed");
    expect(ports.timeline.calibrate).not.toHaveBeenCalled();
  });

  it("does not surface or calibrate a failed Turn after another Conversation becomes active", async () => {
    let rejectSend!: (cause: Error) => void;
    const ports = composerPorts();
    ports.actions.sendMessage.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectSend = reject; }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: conversationScope({ conversation: {
        id: "conversation-a",
        productMode: "harness",
        state: "active",
        selectedProviderId: "codex",
      } }) } },
    );
    act(() => result.current.setComposerText("conversation A turn"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.actions.sendMessage).toHaveBeenCalledOnce());
    rerender({ scope: conversationScope({ conversation: {
      id: "conversation-b",
      productMode: "harness",
      state: "active",
      selectedProviderId: "codex",
    } }) });
    act(() => result.current.setComposerText("conversation B draft"));
    await act(async () => {
      rejectSend(new Error("conversation A failed"));
      await expect(pending).rejects.toThrow("conversation A failed");
    });

    expect(result.current.composerText).toBe("conversation B draft");
    expect(ports.onError).not.toHaveBeenCalledWith("conversation A failed");
    expect(ports.timeline.calibrate).not.toHaveBeenCalled();
  });

  it("does not publish a calibration error after its Conversation scope changes", async () => {
    let rejectCalibration!: (cause: Error) => void;
    const ports = composerPorts();
    ports.timeline.calibrate.mockImplementation(() => new Promise<void>((_resolve, reject) => {
      rejectCalibration = reject;
    }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: conversationScope({ conversation: {
        id: "conversation-a",
        productMode: "harness",
        state: "active",
        selectedProviderId: "codex",
      } }) } },
    );
    act(() => result.current.setComposerText("complete before calibration"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "conversation-a", "main-agent"));
    rerender({ scope: conversationScope({ conversation: {
      id: "conversation-b",
      productMode: "harness",
      state: "active",
      selectedProviderId: "codex",
    } }) });
    await act(async () => {
      rejectCalibration(new Error("stale calibration failed"));
      await pending;
    });

    expect(ports.onError).not.toHaveBeenCalledWith("stale calibration failed");
  });

  it("rejects a stale Conversation before Skill writes or message dispatch", async () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      conversation: {
        id: "harness-conversation",
        productMode: "harness",
        state: "active",
        selectedProviderId: "codex",
      },
    }), ports));
    act(() => result.current.setComposerText("must not send"));

    await act(async () => { await result.current.send(); });

    expect(ports.skills.setEnabled).not.toHaveBeenCalled();
    expect(ports.actions.sendMessage).not.toHaveBeenCalled();
    expect(ports.onError).toHaveBeenLastCalledWith(
      "Conversation productMode does not match the selected application mode.",
    );
    expect(result.current.composerText).toBe("must not send");
  });

  it("keeps a failed optimistic message outside the Composer and clears message context only after success", async () => {
    const failedPorts = composerPorts();
    failedPorts.actions.sendMessage.mockRejectedValue(new Error("offline"));
    const failed = renderHook(() => useConversationComposerController(conversationScope(), failedPorts));
    act(() => failed.result.current.setComposerText("retry this"));
    await act(async () => {
      await expect(failed.result.current.send()).rejects.toThrow("offline");
    });
    expect(failed.result.current.composerText).toBe("");
    failed.unmount();

    const successPorts = composerPorts();
    let resolveSend!: () => void;
    successPorts.actions.sendMessage.mockImplementation(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const success = renderHook(() => useConversationComposerController(conversationScope(), successPorts));
    act(() => {
      success.result.current.setComposerText("ship this");
      success.result.current.setFileRefs([fileRef("src/app.ts")]);
      success.result.current.setAttachments([attachment("attachment-1")]);
    });
    let successPromise!: Promise<void>;
    act(() => { successPromise = success.result.current.send(); });
    await waitFor(() => expect(successPorts.actions.sendMessage).toHaveBeenCalledTimes(1));
    await act(async () => success.result.current.reloadSkills());
    await act(async () => {
      resolveSend();
      await successPromise;
    });
    expect(success.result.current.composerText).toBe("");
    expect(success.result.current.fileRefs).toEqual([]);
    expect(success.result.current.attachments).toEqual([]);
  });

  it("settles accepted resources by identity while preserving edits made during a first send", async () => {
    const creation = deferred<{ projectId: string; conversationId: string }>();
    const ports = composerPorts();
    ports.skills.load.mockResolvedValue([
      skill("accepted-skill"),
      skill("next-skill"),
    ]);
    ports.session.createConversation.mockImplementation(() => creation.promise);
    const { result } = renderHook(() => useConversationComposerController(homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
    }), ports));
    await waitFor(() => expect(result.current.skillItems).toHaveLength(2));

    act(() => {
      result.current.setComposerText("send resource A");
      result.current.setFileRefs([fileRef("src/a.ts")]);
      result.current.setAttachments([attachment("attachment-a")]);
    });
    await act(async () => result.current.toggleSkill("accepted-skill"));

    let pending!: Promise<{ projectId: string; conversationId: string } | null>;
    act(() => { pending = result.current.createConversation(); });
    await waitFor(() => expect(ports.session.createConversation).toHaveBeenCalledOnce());

    act(() => {
      result.current.setComposerText("next message");
      result.current.setFileRefs([fileRef("src/a.ts"), fileRef("src/b.ts")]);
      result.current.setAttachments((current) => [...current, attachment("attachment-b")]);
    });
    await act(async () => result.current.toggleSkill("next-skill"));
    await act(async () => {
      creation.resolve({ projectId: "repo", conversationId: "conversation-new" });
      await pending;
    });

    expect(result.current.composerText).toBe("next message");
    expect(result.current.fileRefs).toEqual([expect.objectContaining({ relativePath: "src/b.ts" })]);
    expect(result.current.attachments).toEqual([expect.objectContaining({ id: "attachment-b" })]);
    expect(result.current.draftSkillOverrides).toEqual({ "next-skill": true });
  });

  it("preserves same-value text and same-identity resources re-added during an ordinary send", async () => {
    const send = deferred<void>();
    const ports = composerPorts();
    ports.actions.sendMessage.mockImplementation(() => send.promise);
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      providerCount: 1,
      providerCapabilities: [providerCapability("codex", true)],
      conversation: {
        id: "conversation-1",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
      },
    }), ports));
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalled());
    act(() => {
      result.current.setComposerText("same message");
      result.current.setFileRefs([fileRef("src/same.ts")]);
      result.current.setAttachments([attachment("attachment-same")]);
    });

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.actions.sendMessage).toHaveBeenCalledOnce());
    act(() => {
      result.current.setComposerText("temporary message");
      result.current.setComposerText("same message");
      result.current.setFileRefs([]);
      result.current.setAttachments([]);
    });
    act(() => {
      result.current.setFileRefs([fileRef("src/same.ts")]);
      result.current.setAttachments([attachment("attachment-same")]);
    });
    await act(async () => {
      send.resolve();
      await pending;
    });

    expect(result.current.composerText).toBe("same message");
    expect(result.current.fileRefs).toEqual([expect.objectContaining({ relativePath: "src/same.ts" })]);
    expect(result.current.attachments).toEqual([expect.objectContaining({ id: "attachment-same" })]);
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "same message",
      contextRefs: [expect.objectContaining({ relativePath: "src/same.ts" })],
      attachmentIds: ["attachment-same"],
    }));
  });

  it("keeps a captured first send running after a Provider switch without overwriting the new draft", async () => {
    let resolveCreation!: (created: { projectId: string; conversationId: string }) => void;
    const ports = composerPorts();
    ports.session.createConversation.mockImplementation(() => new Promise((resolve) => { resolveCreation = resolve; }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: homeScope({ productMode: "agent", selectedProviderId: "codex", providerCount: 2 }) } },
    );
    act(() => result.current.setComposerText("codex request"));

    let creation!: Promise<{ projectId: string; conversationId: string } | null>;
    act(() => { creation = result.current.createConversation(); });
    await waitFor(() => expect(ports.session.createConversation).toHaveBeenCalledWith(expect.objectContaining({ providerId: "codex" })));
    rerender({ scope: homeScope({ productMode: "agent", selectedProviderId: "other-provider", providerCount: 2 }) });
    act(() => result.current.setComposerText("other provider draft"));
    await act(async () => {
      resolveCreation({ projectId: "repo", conversationId: "codex-conversation" });
      await creation;
    });

    expect(result.current.composerText).toBe("other provider draft");
    expect(ports.projection.refreshConversation).not.toHaveBeenCalled();
    expect(ports.timeline.calibrate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Conversation",
      initial: conversationScope({ conversation: { id: "conversation-a", productMode: "harness", state: "active", selectedProviderId: "codex" } }),
      next: conversationScope({ conversation: { id: "conversation-b", productMode: "harness", state: "active", selectedProviderId: "codex" } }),
    },
    {
      label: "Provider",
      initial: homeScope({ productMode: "agent", selectedProviderId: "codex" }),
      next: homeScope({ productMode: "agent", selectedProviderId: "other-provider" }),
    },
  ])("ignores a late Skill response after a $label switch", async ({ initial, next }) => {
    let resolveInitial!: (skills: SkillListItem[]) => void;
    const ports = composerPorts();
    ports.skills.load
      .mockImplementationOnce(() => new Promise<SkillListItem[]>((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValueOnce([skill("current-skill")]);
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: initial } },
    );
    await waitFor(() => expect(ports.skills.load).toHaveBeenCalledTimes(1));

    rerender({ scope: next });
    await waitFor(() => expect(ports.skills.load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.skillItems.map((item) => item.skillId)).toEqual(["current-skill"]));
    await act(async () => { resolveInitial([skill("stale-skill")]); });

    expect(result.current.skillItems.map((item) => item.skillId)).toEqual(["current-skill"]);
    expect(ports.onError).not.toHaveBeenCalled();
  });

  it("does not publish a stale Skill mutation failure after the request identity changes", async () => {
    const mutation = deferred<void>();
    const ports = composerPorts();
    ports.skills.load.mockResolvedValue([skill("reviewer", { enabledProject: true })]);
    ports.skills.setEnabled.mockImplementation(() => mutation.promise);
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: conversationScope({ conversation: {
        id: "conversation-a",
        productMode: "harness",
        state: "active",
        selectedProviderId: "codex",
      } }) } },
    );
    await waitFor(() => expect(result.current.skillItems).toHaveLength(1));

    let pending!: Promise<void>;
    act(() => { pending = result.current.toggleSkill("reviewer"); });
    await waitFor(() => expect(ports.skills.setEnabled).toHaveBeenCalledOnce());
    rerender({ scope: conversationScope({ conversation: {
      id: "conversation-b",
      productMode: "harness",
      state: "active",
      selectedProviderId: "other-provider",
    } }) });

    await act(async () => {
      mutation.reject(new Error("stale Skill mutation failed"));
      await expect(pending).rejects.toThrow("stale Skill mutation failed");
    });

    expect(ports.onError).not.toHaveBeenCalledWith("stale Skill mutation failed");
  });

  it("steers only running text while retaining attachments and keeping Stop separate", async () => {
    const ports = composerPorts();
    const runningScope = conversationScope({
      running: true,
      selectedProviderId: "codex",
      runControlState: { state: "running", canStop: true, canSteer: true },
    });
    const { result } = renderHook(() => useConversationComposerController(runningScope, ports));
    act(() => {
      result.current.setComposerText("follow up");
      result.current.setAttachments([attachment("attachment-1")]);
    });
    await act(async () => result.current.send());
    expect(ports.actions.steer).toHaveBeenCalledWith({
      projectId: "repo",
      conversationId: "conversation-1",
      productMode: "harness",
      providerId: undefined,
      expectedAttemptId: undefined,
      clientRequestId: "request-1",
      prompt: "follow up",
    });
    expect(result.current.composerText).toBe("");
    expect(result.current.attachments).toEqual([attachment("attachment-1")]);

    act(() => result.current.setComposerText("stop context"));
    await act(async () => result.current.stop());
    expect(ports.actions.stop).toHaveBeenCalledWith({
      projectId: "repo",
      conversationId: "conversation-1",
      productMode: "harness",
      prompt: "stop context",
    });
    expect(result.current.composerText).toBe("");
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({ text: "" }));
    expect(ports.projection.refreshConversation).not.toHaveBeenCalled();
  });

  it("preserves text re-entered with the same value while an accepted steer is pending", async () => {
    const steer = deferred<{ status: "accepted" }>();
    const ports = composerPorts();
    ports.actions.steer.mockImplementation(() => steer.promise);
    const runningScope = conversationScope({
      running: true,
      selectedProviderId: "codex",
      runControlState: { state: "running", canStop: true, canSteer: true },
    });
    const { result } = renderHook(() => useConversationComposerController(runningScope, ports));
    act(() => result.current.setComposerText("steer text"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.actions.steer).toHaveBeenCalledOnce());
    act(() => {
      result.current.setComposerText("changed while steering");
      result.current.setComposerText("steer text");
    });
    await act(async () => {
      steer.resolve({ status: "accepted" });
      await pending;
    });

    expect(result.current.composerText).toBe("steer text");
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({ text: "steer text" }));
  });

  it("preserves text re-entered with the same value while Harness Stop is pending", async () => {
    const stop = deferred<void>();
    const ports = composerPorts();
    ports.actions.stop.mockImplementation(() => stop.promise);
    const runningScope = conversationScope({
      productMode: "harness",
      running: true,
      runControlState: { state: "running", canStop: true, canSteer: true },
    });
    const { result } = renderHook(() => useConversationComposerController(runningScope, ports));
    act(() => result.current.setComposerText("stop text"));

    let pending!: Promise<void>;
    act(() => { pending = result.current.stop(); });
    await waitFor(() => expect(ports.actions.stop).toHaveBeenCalledOnce());
    act(() => {
      result.current.setComposerText("changed while stopping");
      result.current.setComposerText("stop text");
    });
    await act(async () => {
      stop.resolve();
      await pending;
    });

    expect(result.current.composerText).toBe("stop text");
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({ text: "stop text" }));
  });

  it("queues the complete next Turn when a running Conversation cannot steer", async () => {
    const ports = composerPorts();
    const enqueue = vi.fn(async () => queueSnapshot("queue:1"));
    ports.queue = {
      snapshot: queueSnapshot("queue:0"),
      loading: false,
      enqueue,
      reclaim: vi.fn(async () => queueSnapshot("queue:1")),
    };
    const scope = conversationScope({
      productMode: "agent",
      running: true,
      selectedProviderId: "codex",
      runControlState: { state: "running", canStop: true, canSteer: false, providerId: "codex", attemptId: "attempt-1" },
      conversation: { id: "conversation-1", productMode: "agent", state: "active", selectedProviderId: "codex" },
    });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    act(() => {
      result.current.setComposerText("next full turn");
      result.current.setFileRefs([fileRef("src/app.ts")]);
      result.current.setAttachments([attachment("attachment-1")]);
    });

    await act(async () => result.current.send());

    expect(ports.actions.steer).not.toHaveBeenCalled();
    expect(ports.actions.sendMessage).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      text: "next full turn",
      contextRefs: [fileRef("src/app.ts")],
      attachmentIds: ["attachment-1"],
      providerId: "codex",
      agentTurnMode: "default",
      modelId: null,
      reasoningEffort: null,
    }));
    expect(result.current.composerText).toBe("");
    expect(result.current.fileRefs).toEqual([]);
    expect(result.current.attachments).toEqual([]);
  });

  it("persists edits made while a queued Turn is being accepted", async () => {
    const queued = deferred<ConversationTurnQueueSnapshot>();
    const ports = composerPorts();
    let persisted = draftSnapshot({ updatedAt: "initial-token" });
    let saveSequence = 0;
    ports.drafts.load.mockImplementation(async () => persisted);
    ports.drafts.save.mockImplementation(async (input) => {
      persisted = draftSnapshot({
        projectId: input.projectId,
        productMode: input.productMode,
        agentTurnMode: input.agentTurnMode,
        agentModelId: input.agentModelId,
        agentReasoningEffort: input.agentReasoningEffort,
        text: input.text,
        contextRefs: input.contextRefs,
        attachments: input.attachmentIds.map(attachment),
        skillOverrides: input.skillOverrides,
        selectedProviderId: input.selectedProviderId,
        updatedAt: `saved-token-${++saveSequence}`,
      });
      return persisted;
    });
    ports.queue = {
      snapshot: queueSnapshot("queue:0"),
      loading: false,
      enqueue: vi.fn(() => queued.promise),
      reclaim: vi.fn(async () => queueSnapshot("queue:1")),
    };
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      running: true,
      selectedProviderId: "codex",
      runControlState: { state: "running", canStop: true, canSteer: false, providerId: "codex", attemptId: "attempt-1" },
      conversation: { id: "conversation-1", productMode: "agent", state: "active", selectedProviderId: "codex" },
    }), ports));
    await waitFor(() => expect(ports.drafts.load).toHaveBeenCalledOnce());
    act(() => {
      result.current.setComposerText("queued message");
      result.current.setFileRefs([fileRef("src/a.ts")]);
      result.current.setAttachments([attachment("attachment-a")]);
    });

    let pending!: Promise<void>;
    act(() => { pending = result.current.send(); });
    await waitFor(() => expect(ports.queue!.enqueue).toHaveBeenCalledOnce());
    act(() => {
      result.current.setComposerText("next message");
      result.current.setFileRefs([fileRef("src/a.ts"), fileRef("src/b.ts")]);
      result.current.setAttachments([attachment("attachment-a"), attachment("attachment-b")]);
    });
    await act(async () => { await Promise.resolve(); });
    persisted = draftSnapshot({ text: "", updatedAt: "external-token" });
    await act(async () => {
      queued.resolve(queueSnapshot("queue:1"));
      await pending;
    });

    expect(result.current.composerText).toBe("next message");
    expect(result.current.fileRefs).toEqual([expect.objectContaining({ relativePath: "src/b.ts" })]);
    expect(result.current.attachments).toEqual([expect.objectContaining({ id: "attachment-b" })]);
    expect(ports.drafts.save).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "next message",
      contextRefs: [expect.objectContaining({ relativePath: "src/b.ts" })],
      attachmentIds: ["attachment-b"],
      expectedUpdatedAt: "external-token",
    }));
  });

  it("does not bypass an unavailable queue snapshot with a direct Turn", async () => {
    const ports = composerPorts();
    ports.queue = {
      snapshot: null,
      loading: false,
      enqueue: vi.fn(async () => null),
      reclaim: vi.fn(async () => null),
    };
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      conversation: { id: "conversation-1", productMode: "agent", state: "active", selectedProviderId: "codex" },
    }), ports));
    act(() => result.current.setComposerText("must preserve FIFO"));

    await act(async () => result.current.send());

    expect(ports.actions.sendMessage).not.toHaveBeenCalled();
    expect(ports.onError).toHaveBeenCalledWith(expect.stringContaining("队列状态不可用"));
    expect(result.current.composerText).toBe("must preserve FIFO");
  });

  it("preserves the complete draft when queue calibration rejects enqueue before any effect", async () => {
    const ports = composerPorts();
    ports.queue = {
      snapshot: queueSnapshot("queue:0"),
      loading: false,
      enqueue: vi.fn(async () => null),
      reclaim: vi.fn(async () => null),
    };
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      running: true,
      selectedProviderId: "codex",
      runControlState: { state: "running", canStop: true, canSteer: false, providerId: "codex", attemptId: "attempt-1" },
      conversation: { id: "conversation-1", productMode: "agent", state: "active", selectedProviderId: "codex" },
    }), ports));
    act(() => {
      result.current.setComposerText("preserve after stale queue");
      result.current.setFileRefs([fileRef("src/app.ts")]);
      result.current.setAttachments([attachment("attachment-1")]);
    });

    await act(async () => result.current.send());

    expect(ports.queue.enqueue).toHaveBeenCalledOnce();
    expect(result.current.composerText).toBe("preserve after stale queue");
    expect(result.current.fileRefs).toEqual([fileRef("src/app.ts")]);
    expect(result.current.attachments).toEqual([attachment("attachment-1")]);
    expect(ports.onError).toHaveBeenCalledWith("当前会话队列已变化，请等待校准后重试。");
  });

  it("reuses the same steering request id when a failed submission is retried unchanged", async () => {
    const ports = composerPorts();
    ports.ids.createClientRequestId
      .mockReturnValueOnce("steer-retry-id")
      .mockReturnValueOnce("unexpected-new-id");
    ports.actions.steer
      .mockRejectedValueOnce(new Error("evidence write failed"))
      .mockResolvedValueOnce({ status: "accepted" });
    const { result } = renderHook(() => useConversationComposerController(
      conversationScope({ running: true, runControlState: { state: "running", canStop: true, canSteer: true } }),
      ports,
    ));
    act(() => result.current.setComposerText("same steer"));

    await act(async () => {
      await expect(result.current.send()).rejects.toThrow("evidence write failed");
    });
    expect(result.current.composerText).toBe("same steer");
    await act(async () => result.current.send());

    expect(ports.ids.createClientRequestId).toHaveBeenCalledOnce();
    expect(ports.actions.steer).toHaveBeenNthCalledWith(1, expect.objectContaining({ clientRequestId: "steer-retry-id" }));
    expect(ports.actions.steer).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientRequestId: "steer-retry-id" }));
    expect(result.current.composerText).toBe("");
  });

  it.each(["agent", "harness"] as const)("preserves %s text when the Turn becomes terminal before steering settles", async (productMode) => {
    const ports = composerPorts();
    ports.actions.steer.mockResolvedValue({ status: "already-terminal" });
    const scope = productMode === "agent"
      ? conversationScope({
          productMode,
          running: true,
          runControlState: { state: "running", canStop: true, canSteer: true, providerId: "codex", attemptId: "attempt-1" },
          conversation: { id: "conversation-1", productMode, state: "active", selectedProviderId: "codex" },
        })
      : conversationScope({ productMode, running: true, runControlState: { state: "running", canStop: true, canSteer: true } });
    const { result } = renderHook(() => useConversationComposerController(scope, ports));
    act(() => result.current.setComposerText("send this next"));

    await act(async () => result.current.send());

    expect(result.current.composerText).toBe("send this next");
    expect(ports.onError).toHaveBeenLastCalledWith("当前执行已结束，这条文本已保留，可作为下一回合发送。");
  });

  it.each(["steer", "stop"] as const)("does not leak a late %s failure into a new mode scope", async (action) => {
    let rejectAction!: (cause: Error) => void;
    const ports = composerPorts();
    ports.actions[action].mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectAction = reject; }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: action === "steer"
        ? conversationScope({ productMode: "harness", running: true, runControlState: { state: "running", canStop: true, canSteer: true } })
        : conversationScope({
          productMode: "agent",
          running: true,
          runControlState: { state: "running", canStop: true, providerId: "codex", attemptId: "attempt-1" },
          conversation: { id: "agent-conversation", productMode: "agent", state: "active", selectedProviderId: "codex" },
        }) } },
    );
    act(() => result.current.setComposerText("old action"));
    let pending!: Promise<void>;
    act(() => { pending = action === "steer" ? result.current.send() : result.current.stop(); });
    await waitFor(() => expect(ports.actions[action]).toHaveBeenCalledOnce());

    rerender({ scope: homeScope({ productMode: "harness", conversation: null }) });
    act(() => result.current.setComposerText("new mode draft"));
    await act(async () => {
      rejectAction(new Error(`late ${action} failure`));
      await expect(pending).rejects.toThrow(`late ${action} failure`);
    });

    expect(result.current.composerText).toBe("new mode draft");
    expect(ports.onError).not.toHaveBeenCalledWith(`late ${action} failure`);
    expect(ports.timeline.calibrate).not.toHaveBeenCalled();
  });

  it("does not leak a late Stop response into a newer Attempt in the same Conversation", async () => {
    let rejectStop!: (cause: Error) => void;
    const ports = composerPorts();
    ports.actions.stop.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectStop = reject; }));
    const scopeA = conversationScope({
      productMode: "agent",
      running: true,
      runControlState: { state: "running", canStop: true, providerId: "codex", attemptId: "attempt-a" },
      conversation: { id: "agent-conversation", productMode: "agent", state: "active", selectedProviderId: "codex" },
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: scopeA } },
    );
    act(() => result.current.setComposerText("next attempt draft"));
    let pending!: Promise<void>;
    act(() => { pending = result.current.stop(); });
    await waitFor(() => expect(ports.actions.stop).toHaveBeenCalledOnce());

    rerender({ scope: {
      ...scopeA,
      runControlState: { state: "running", canStop: true, providerId: "codex", attemptId: "attempt-b" },
    } });
    await act(async () => {
      rejectStop(new Error("late attempt-a stop failure"));
      await expect(pending).rejects.toThrow("late attempt-a stop failure");
    });

    expect(result.current.composerText).toBe("next attempt draft");
    expect(ports.onError).not.toHaveBeenCalledWith("late attempt-a stop failure");
    expect(ports.timeline.calibrate).not.toHaveBeenCalled();
  });

  it("keeps a Stop response current when the same Attempt moves from running to stopping", async () => {
    let resolveStop!: () => void;
    const ports = composerPorts();
    ports.actions.stop.mockImplementation(() => new Promise<void>((resolve) => { resolveStop = resolve; }));
    const scope = conversationScope({
      productMode: "agent",
      running: true,
      runControlState: { state: "running", canStop: true, providerId: "codex", attemptId: "attempt-same" },
      conversation: { id: "agent-conversation", productMode: "agent", state: "active", selectedProviderId: "codex" },
    });
    const { result, rerender } = renderHook(
      ({ current }: { current: ConversationComposerScope }) => useConversationComposerController(current, ports),
      { initialProps: { current: scope } },
    );
    let pending!: Promise<void>;
    act(() => { pending = result.current.stop(); });
    await waitFor(() => expect(ports.actions.stop).toHaveBeenCalledOnce());

    rerender({ current: {
      ...scope,
      runControlState: { state: "stopping", canStop: true, providerId: "codex", attemptId: "attempt-same" },
    } });
    await act(async () => { resolveStop(); await pending; });

    expect(ports.timeline.calibrate).toHaveBeenCalledWith("repo", "agent-conversation", "main-agent");
  });

  it("does not leak a Stop response when the same Attempt changes run-control Provider", async () => {
    let rejectStop!: (cause: Error) => void;
    const ports = composerPorts();
    ports.actions.stop.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectStop = reject; }));
    const scope = conversationScope({
      productMode: "agent",
      running: true,
      runControlState: { state: "running", canStop: true, providerId: "codex", attemptId: "attempt-same" },
      conversation: { id: "agent-conversation", productMode: "agent", state: "active", selectedProviderId: "codex" },
    });
    const { result, rerender } = renderHook(
      ({ current }: { current: ConversationComposerScope }) => useConversationComposerController(current, ports),
      { initialProps: { current: scope } },
    );
    let pending!: Promise<void>;
    act(() => { pending = result.current.stop(); });
    await waitFor(() => expect(ports.actions.stop).toHaveBeenCalledOnce());

    rerender({ current: {
      ...scope,
      runControlState: { state: "running", canStop: true, providerId: "claude-code", attemptId: "attempt-same" },
    } });
    await act(async () => {
      rejectStop(new Error("late codex stop failure"));
      await expect(pending).rejects.toThrow("late codex stop failure");
    });

    expect(ports.onError).not.toHaveBeenCalledWith("late codex stop failure");
    expect(ports.timeline.calibrate).not.toHaveBeenCalled();
  });

  it("disables Agent steer and preserves all draft state while stopping the exact Attempt", async () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      running: true,
      runControlState: { state: "running", canStop: true, providerId: "codex", attemptId: "attempt-1" },
      conversation: { id: "agent-conversation", productMode: "agent", state: "active", selectedProviderId: "codex" },
    }), ports));
    act(() => {
      result.current.setComposerText("next turn draft");
      result.current.setAttachments([attachment("attachment-1")]);
    });

    await act(async () => result.current.send());
    expect(ports.actions.steer).not.toHaveBeenCalled();
    expect(result.current.composerText).toBe("next turn draft");
    expect(result.current.attachments).toHaveLength(1);

    await act(async () => result.current.stop());
    expect(ports.actions.stop).toHaveBeenCalledWith({
      projectId: "repo",
      conversationId: "agent-conversation",
      productMode: "agent",
      providerId: "codex",
      expectedAttemptId: "attempt-1",
    });
    expect(result.current.composerText).toBe("next turn draft");
    expect(result.current.attachments).toHaveLength(1);
  });

  it("captures explicit model and reasoning effort in an Agent first send", async () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
    }), ports));
    act(() => {
      result.current.selectAgentModel("gpt-test");
      result.current.selectAgentReasoningEffort("high");
      result.current.setComposerText("use the captured selection");
    });

    await act(async () => { await result.current.createConversation(); });

    expect(ports.session.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      productMode: "agent",
      modelId: "gpt-test",
      reasoningEffort: "high",
    }));
  });

  it("captures a model and effort selected immediately before the first send", async () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(homeScope({
      productMode: "agent",
      providerCapabilities: [providerCapability("codex", true)],
    }), ports));
    act(() => result.current.setComposerText("capture without waiting for a configuration rerender"));

    let pending!: Promise<unknown>;
    act(() => {
      result.current.selectAgentModel("gpt-test");
      result.current.selectAgentReasoningEffort("high");
      pending = result.current.createConversation();
    });
    await act(async () => { await pending; });

    expect(ports.session.createConversation).toHaveBeenCalledWith(expect.objectContaining({
      productMode: "agent",
      modelId: "gpt-test",
      reasoningEffort: "high",
    }));
  });

  it("restores Agent model selection from a draft and keeps the draft as Composer truth", async () => {
    const ports = composerPorts();
    ports.drafts.load.mockResolvedValue(draftSnapshot({
      agentModelId: "gpt-test",
      agentReasoningEffort: "high",
    }));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: homeScope({ productMode: "agent", providerCapabilities: [providerCapability("codex", true)] }) } },
    );
    await waitFor(() => expect(result.current.agentReasoningEffort).toBe("high"));
    expect(result.current.agentModelId).toBe("gpt-test");

    rerender({ scope: conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      providerCapabilities: [providerCapability("codex", true)],
      conversation: {
        id: "conversation-model",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
        agentModelId: null,
        agentReasoningEffort: null,
      },
    }) });
    await waitFor(() => expect(result.current.agentModelId).toBe("gpt-test"));
    expect(result.current.agentReasoningEffort).toBe("high");
  });

  it("does not let a canonical Conversation refresh overwrite the next-Turn model selection", async () => {
    const ports = composerPorts();
    const modelSettings: ProviderModelSettingsSnapshot = {
      ...providerModelSettings("codex"),
      candidates: [
        {
          providerId: "codex",
          modelId: "model-current",
          label: "Current",
          source: "runtime",
          supportedReasoningEfforts: [{ value: "low", label: "低" }],
          defaultReasoningEffort: "low",
        },
        {
          providerId: "codex",
          modelId: "model-next",
          label: "Next",
          source: "runtime",
          supportedReasoningEfforts: [{ value: "high", label: "高" }],
          defaultReasoningEffort: "high",
        },
        {
          providerId: "codex",
          modelId: "model-observed",
          label: "Observed",
          source: "runtime",
          supportedReasoningEfforts: [{ value: "low", label: "低" }],
          defaultReasoningEffort: "low",
        },
      ],
    };
    const initialScope = conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      providerCapabilities: [providerCapability("codex", true)],
      providerModelSettings: modelSettings,
      conversation: {
        id: "conversation-model",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
        agentModelId: "model-current",
        agentReasoningEffort: "low",
      },
    });
    const { result, rerender } = renderHook(
      ({ scope }: { scope: ConversationComposerScope }) => useConversationComposerController(scope, ports),
      { initialProps: { scope: initialScope } },
    );
    await waitFor(() => expect(result.current.agentModelId).toBe("model-current"));

    act(() => {
      result.current.selectAgentModel("model-next");
      result.current.selectAgentReasoningEffort("high");
    });
    expect(result.current.agentModelId).toBe("model-next");
    expect(result.current.agentReasoningEffort).toBe("high");

    rerender({ scope: {
      ...initialScope,
      conversation: {
        ...initialScope.conversation!,
        agentModelId: "model-observed",
        agentReasoningEffort: "low",
      },
    } });

    await waitFor(() => expect(result.current.agentModelId).toBe("model-next"));
    expect(result.current.agentReasoningEffort).toBe("high");
  });

  it("resets model and effort atomically on an explicit Provider switch", async () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(homeScope({
      productMode: "agent",
      providerCount: 2,
      providerCapabilities: [providerCapability("codex", true), providerCapability("other", true)],
    }), ports));
    act(() => {
      result.current.selectAgentModel("gpt-test");
      result.current.selectAgentReasoningEffort("high");
    });

    await act(async () => { await result.current.selectProvider("other"); });

    expect(result.current.agentModelId).toBeNull();
    expect(result.current.agentReasoningEffort).toBeNull();
    expect(ports.session.selectProvider).toHaveBeenCalledWith("other");
  });

  it("switches Provider and model as one draft selection while preserving a supported effort", async () => {
    const ports = composerPorts();
    const otherModels: ProviderModelSettingsSnapshot = {
      ...providerModelSettings("other"),
      effectiveModel: { providerId: "other", modelId: "other-default" },
      candidates: [{
        providerId: "other", modelId: "other-fast", label: "Other Fast", source: "runtime",
        supportedReasoningEfforts: [{ value: "high", label: "高" }], defaultReasoningEffort: "high",
      }],
    };
    const { result } = renderHook(() => useConversationComposerController(homeScope({
      productMode: "agent",
      providerCount: 2,
      providerCapabilities: [providerCapability("codex", true), providerCapability("other", true)],
      providerModelCatalogs: [
        { providerId: "codex", displayName: "Codex", status: "ready", snapshot: providerModelSettings("codex") },
        { providerId: "other", displayName: "Other", status: "ready", snapshot: otherModels },
      ],
    }), ports));
    act(() => result.current.selectAgentReasoningEffort("high"));

    await act(async () => { await result.current.selectAgentProviderModel("other", "other-fast"); });

    expect(result.current.agentModelId).toBe("other-fast");
    expect(result.current.agentReasoningEffort).toBe("high");
    expect(ports.session.selectProvider).toHaveBeenCalledWith("other");
  });

  it("restores the effective Agent model when a saved explicit model is no longer available", () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      providerCapabilities: [providerCapability("codex", true)],
      providerModelSettings: providerModelSettings("codex"),
      conversation: {
        id: "conversation-model",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
        agentModelId: "removed-model",
        agentReasoningEffort: null,
      },
    }), ports));
    expect(result.current.agentModelId).toBeNull();
    expect(result.current.modelLabel).toBe("GPT Test");
    expect(ports.onError).toHaveBeenCalledWith("之前选择的模型已不可用，已恢复为该服务的默认模型。");
  });

  it("clears an unavailable explicit model before sending with the service default", async () => {
    const ports = composerPorts();
    const { result } = renderHook(() => useConversationComposerController(conversationScope({
      productMode: "agent",
      selectedProviderId: "codex",
      providerCapabilities: [providerCapability("codex", true)],
      providerModelSettings: { ...providerModelSettings("codex"), candidates: [] },
      conversation: {
        id: "conversation-model",
        productMode: "agent",
        state: "active",
        selectedProviderId: "codex",
        agentModelId: "removed-model",
        agentReasoningEffort: null,
      },
    }), ports));
    act(() => result.current.setComposerText("do not silently fall back"));

    await act(async () => { await result.current.send(); });

    expect(result.current.agentModelId).toBeNull();
    expect(result.current.agentReasoningEffort).toBeNull();
    expect(ports.onError).toHaveBeenCalledWith("之前选择的模型已不可用，已恢复为该服务的默认模型。");
    expect(ports.actions.sendMessage).toHaveBeenCalledOnce();
  });
});

function composerPorts(): ConversationComposerPorts & {
  session: { ensureProjectRegistered: ReturnType<typeof vi.fn>; createConversation: ReturnType<typeof vi.fn>; restoreDraftProvider: ReturnType<typeof vi.fn>; selectProvider: ReturnType<typeof vi.fn> };
  actions: { sendMessage: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  projection: { refreshConversation: ReturnType<typeof vi.fn> };
  timeline: { calibrate: ReturnType<typeof vi.fn>; showPending: ReturnType<typeof vi.fn>; markPending: ReturnType<typeof vi.fn>; consumePending: ReturnType<typeof vi.fn>; rekeyPending: ReturnType<typeof vi.fn> };
  skills: { load: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> };
  attachments: { upload: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  drafts: { load: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  operation: { begin: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  ids: { createClientRequestId: ReturnType<typeof vi.fn> };
  onError: ReturnType<typeof vi.fn>;
} {
  let operationId = 0;
  return {
    access: {
      read: async (identity) => ({ accessMode: "default", revision: 0, providerId: identity.providerId }),
      save: async (identity, current, accessMode) => ({ accessMode, revision: current.revision + 1, providerId: identity.providerId }),
    },
    operation: {
      begin: vi.fn((key: string) => ({ id: ++operationId, key })),
      release: vi.fn(),
    },
    session: {
      ensureProjectRegistered: vi.fn(async (projectId: string) => projectId),
      createConversation: vi.fn(async () => ({ projectId: "repo", conversationId: "conversation-new" })),
      restoreDraftProvider: vi.fn(),
      selectProvider: vi.fn(async () => undefined),
    },
    actions: {
      sendMessage: vi.fn(async () => undefined),
      steer: vi.fn(async () => ({ status: "accepted" as const })),
      stop: vi.fn(async () => undefined),
    },
    projection: { refreshConversation: vi.fn(async () => undefined) },
    timeline: {
      calibrate: vi.fn(async () => undefined),
      showPending: vi.fn(),
      markPending: vi.fn(),
      consumePending: vi.fn(),
      rekeyPending: vi.fn(),
    },
    skills: {
      load: vi.fn(async () => []),
      setEnabled: vi.fn(async () => undefined),
    },
    attachments: {
      upload: vi.fn(async () => attachment("uploaded")),
      remove: vi.fn(async () => undefined),
    },
    drafts: {
      load: vi.fn(async () => null),
      save: vi.fn(async (input) => draftSnapshot({
        projectId: input.projectId,
        productMode: input.productMode,
        agentTurnMode: input.agentTurnMode,
        agentModelId: input.agentModelId,
        agentReasoningEffort: input.agentReasoningEffort,
        text: input.text,
        contextRefs: input.contextRefs,
        attachments: input.attachmentIds.map(attachment),
        skillOverrides: input.skillOverrides,
        selectedProviderId: input.selectedProviderId,
        updatedAt: "2026-08-21T00:00:00.000Z",
      })),
      delete: vi.fn(async () => true),
    },
    ids: { createClientRequestId: vi.fn(() => "request-1") },
    onError: vi.fn(),
  };
}

function draftSnapshot(overrides: Partial<ComposerDraftSnapshot> = {}): ComposerDraftSnapshot {
  return {
    projectId: "repo",
    productMode: "agent",
    agentTurnMode: "default",
    agentModelId: null,
    agentReasoningEffort: null,
    text: "",
    contextRefs: [],
    attachments: [],
    skillOverrides: {},
    selectedProviderId: "codex",
    updatedAt: "2026-08-20T00:00:00.000Z",
    diagnostics: [],
    ...overrides,
  };
}

function queueSnapshot(revision: string): ConversationTurnQueueSnapshot {
  return {
    projectId: "repo",
    productMode: "agent",
    conversationId: "conversation-1",
    revision,
    executionRevision: "execution:1",
    items: [],
    canEnqueue: true,
    canDispatch: false,
  };
}

function homeScope(overrides: Partial<ConversationComposerScope> = {}): ConversationComposerScope {
  const scope: ConversationComposerScope = {
    projectId: "repo",
    conversation: null,
    projectRegistered: true,
    running: false,
    selectedProviderId: "codex",
    providerCount: 1,
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "providerModelSettings")) {
    const providerId = scope.selectedProviderId ?? scope.conversation?.selectedProviderId ?? "codex";
    scope.providerModelSettings = providerModelSettings(providerId);
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, "providerModelCatalogs")) {
    const snapshot = scope.providerModelSettings ?? null;
    const providerId = scope.selectedProviderId ?? scope.conversation?.selectedProviderId ?? snapshot?.providerId ?? "codex";
    scope.providerModelCatalogs = [{ providerId, displayName: providerId, status: "ready", snapshot }];
  }
  return scope;
}

function conversationScope(overrides: Partial<ConversationComposerScope> = {}): ConversationComposerScope {
  return homeScope({
    conversation: { id: "conversation-1", state: "active", selectedProviderId: "codex" },
    selectedProviderId: "claude",
    providerCount: 2,
    ...overrides,
  });
}

function skill(skillId: string, overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    skillId,
    name: skillId,
    description: `${skillId} description`,
    sourcePath: `skills/${skillId}`,
    sourceKind: "custom",
    scope: "user",
    contentHash: `hash-${skillId}`,
    compatibility: { requiredCapabilities: [] },
    providerBindings: [],
    providerEnabled: true,
    required: false,
    runtimeAssigned: false,
    enabledProject: false,
    enabledTopics: [],
    disabledTopics: [],
    ...overrides,
  };
}

function fileRef(relativePath: string): TopicFileReference {
  return {
    relativePath,
    name: relativePath.split("/").at(-1)!,
    kind: "file",
    source: "composer",
  };
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
    createdAt: "2026-07-17T00:00:00.000Z",
    storagePath: `attachments/${id}/content.txt`,
    runtimeMode: "bounded-text-preview",
  };
}

function providerCapability(providerId: string, planReady: boolean, fileReferenceReady = true): ProviderCapabilitySnapshot {
  return {
    providerId,
    displayName: providerId,
    productMode: "agent",
    status: "ready",
    runnable: true,
    checkedAt: "2026-08-15T00:00:00.000Z",
    snapshotHash: `snapshot-${providerId}`,
    snapshotVersion: 1,
    effectiveModel: "gpt-test",
    effectiveModelSource: "provider-default",
    degradedReasons: [],
    capabilities: [{
      key: "turn.plan",
      label: "Plan",
      spec: planReady ? "supported" : "unsupported",
      runtime: planReady ? "ready" : "unavailable",
      summary: planReady ? "Ready" : "Unavailable",
    }, {
      key: "image.input",
      label: "Image",
      spec: "supported",
      runtime: "ready",
      summary: "Ready",
    }, {
      key: "file.reference",
      label: "File",
      spec: fileReferenceReady ? "supported" : "unsupported",
      runtime: fileReferenceReady ? "ready" : "unavailable",
      summary: fileReferenceReady ? "Ready" : "Unavailable",
    }],
  };
}

function providerModelSettings(providerId: string): ProviderModelSettingsSnapshot {
  return {
    providerId,
    selectedModel: null,
    effectiveModel: { providerId, modelId: "gpt-test" },
    effectiveModelSource: "provider-default",
    candidates: [{
      providerId,
      modelId: "gpt-test",
      label: "GPT Test",
      source: "runtime",
      supportedReasoningEfforts: [
        { value: "low", label: "低" },
        { value: "high", label: "高" },
      ],
      defaultReasoningEffort: "low",
    }],
    available: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
