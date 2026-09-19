// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationAccessController } from "../../src/web/src/controllers/useConversationAccessController.js";
import type { ConversationComposerScope } from "../../src/web/src/controllers/conversation-composer-contract.js";
import type { ConversationAccessApi, ConversationAccessSelection } from "../../src/web/src/controllers/conversation-access-contract.js";

afterEach(cleanup);
const scope = { projectId: "project", productMode: "agent", projectRegistered: true, running: false,
  selectedProviderId: "codex", providerCount: 1, conversation: { id: "conversation", state: "active", selectedProviderId: "codex" },
} as ConversationComposerScope;
const selected: ConversationAccessSelection = { accessMode: "default", revision: 0, providerId: "codex" };
function api(): ConversationAccessApi {
  return { read: vi.fn(async () => selected), save: vi.fn(async (_identity, current, accessMode) => ({ ...current, accessMode, revision: current.revision + 1 })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Conversation access selection", () => {
  it("restores persisted access and captures without rewriting the draft", async () => {
    const transport = api();
    transport.read = vi.fn(async () => ({ ...selected, accessMode: "full-access", revision: 4 }));
    const { result } = renderHook(() => useConversationAccessController(scope, transport));
    await waitFor(() => expect(result.current.view.busy).toBe(false));
    expect(result.current.view.mode).toBe("full-access");
    await expect(result.current.capture()).resolves.toEqual({ agentAccessMode: "full-access", expectedAccessRevision: 4 });
    expect(transport.save).not.toHaveBeenCalled();
  });

  it("requires confirmation and waits for a saved selection before capturing", async () => {
    const transport = api();
    const saving = deferred<ConversationAccessSelection>();
    transport.save = vi.fn(() => saving.promise);
    const { result } = renderHook(() => useConversationAccessController(scope, transport));
    await waitFor(() => expect(result.current.view.busy).toBe(false));
    await act(() => result.current.select("full-access"));
    expect(transport.save).not.toHaveBeenCalled();
    let operation!: Promise<void>;
    act(() => { operation = result.current.select("full-access", true); });
    expect(result.current.view.mode).toBe("default");
    const capture = result.current.capture();
    expect(capture).toBeInstanceOf(Promise);
    await act(async () => {
      transport.read = vi.fn(async () => ({ ...selected, accessMode: "full-access", revision: 1 }));
      saving.resolve({ ...selected, accessMode: "full-access", revision: 1 }); await operation;
    });
    await expect(capture).resolves.toEqual({ agentAccessMode: "full-access", expectedAccessRevision: 1 });
  });

  it("does not let a stale project response overwrite the current selection", async () => {
    const transport = api();
    const stale = deferred<ConversationAccessSelection>();
    transport.read = vi.fn((identity) => identity.projectId === "project" ? stale.promise : Promise.resolve(selected));
    const { result, rerender } = renderHook((input) => useConversationAccessController(input, transport), { initialProps: scope });
    rerender({ ...scope, projectId: "other" });
    await waitFor(() => expect(result.current.view.busy).toBe(false));
    await act(async () => stale.resolve({ ...selected, accessMode: "full-access", revision: 4 }));
    expect(result.current.view.mode).toBe("default");
  });

  it("detects another window's change before submitting and offers explicit recovery", async () => {
    const transport = api();
    const { result } = renderHook(() => useConversationAccessController(scope, transport));
    await waitFor(() => expect(result.current.view.busy).toBe(false));
    transport.read = vi.fn(async () => ({ ...selected, accessMode: "full-access", revision: 1 }));
    await act(async () => { await expect(result.current.capture()).rejects.toThrow(/已变化/); });
    expect(result.current.view.mode).toBe("full-access");
    expect(result.current.view.failure).toMatch(/其他窗口/);
    expect(() => result.current.capture()).toThrow();
    await act(() => result.current.refresh());
    await expect(result.current.capture()).resolves.toEqual({ agentAccessMode: "full-access", expectedAccessRevision: 1 });
    expect(transport.save).not.toHaveBeenCalled();
  });

  it("does not project a pre-submit check into a replacement conversation", async () => {
    const transport = api();
    const { result, rerender } = renderHook((input) => useConversationAccessController(input, transport), { initialProps: scope });
    await waitFor(() => expect(result.current.view.busy).toBe(false));
    const stale = deferred<ConversationAccessSelection>();
    transport.read = vi.fn(() => stale.promise);
    const capture = result.current.capture();
    const rejected = expect(capture).rejects.toThrow(/已变化/);
    transport.read = vi.fn(async () => selected);
    rerender({ ...scope, projectId: "replacement" });
    await act(async () => { stale.resolve({ ...selected, accessMode: "full-access", revision: 1 }); await rejected; });
    expect(result.current.view.mode).toBe("default");
    expect(result.current.view.failure).toBeNull();
  });

  it("keeps unsaved first-conversation selection only within its project and service", async () => {
    const transport = api();
    const initial = { ...scope, conversation: null };
    const { result, rerender } = renderHook((input: ConversationComposerScope) => useConversationAccessController(input, transport), { initialProps: initial });
    await act(() => result.current.select("full-access", true));
    expect(result.current.capture()).toEqual({ agentAccessMode: "full-access", expectedAccessRevision: undefined });
    expect(transport.save).not.toHaveBeenCalled();
    rerender({ ...initial, selectedProviderId: "other" });
    expect(result.current.view.mode).toBe("default");
  });

  it("isolates AHO and reloads after conflicts without claiming the requested value was saved", async () => {
    const transport = api();
    transport.save = vi.fn(async () => { throw new Error("conflict"); });
    const { result, rerender } = renderHook((input) => useConversationAccessController(input, transport), { initialProps: scope });
    await waitFor(() => expect(result.current.view.busy).toBe(false));
    await act(() => result.current.select("full-access", true));
    expect(result.current.view.mode).toBe("default");
    expect(result.current.view.failure).not.toBeNull();
    expect(() => result.current.capture()).toThrow();
    const calls = vi.mocked(transport.read).mock.calls.length;
    rerender({ ...scope, productMode: "harness" });
    expect(result.current.view.visible).toBe(false);
    expect(result.current.capture()).toEqual({});
    expect(transport.read).toHaveBeenCalledTimes(calls);
  });
});
