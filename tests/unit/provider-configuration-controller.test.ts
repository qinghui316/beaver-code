// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  providerCapabilitiesPath,
  selectEffectiveProviderId,
  useProviderConfigurationController,
} from "../../src/web/src/controllers/useProviderConfigurationController.js";
import type { ProductMode, ProviderCapabilitySnapshot } from "../../src/web/src/types.js";

const provider = (providerId: string, productMode: ProductMode = "harness"): ProviderCapabilitySnapshot => ({
  providerId,
  displayName: providerId,
  productMode,
  status: "ready",
  runnable: true,
  capabilities: [],
  snapshotHash: `hash-${providerId}`,
  snapshotVersion: 1,
  capturedAt: "2026-07-17T00:00:00.000Z",
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider configuration controller", () => {
  it.each(["agent", "harness"] as const)("preserves %s provider selection throughout a deferred reconnect read", async (productMode) => {
    let deferCapabilities = false;
    let resolveReconnect!: (response: Response) => void;
    const reconnectResponse = new Promise<Response>((resolve) => { resolveReconnect = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (deferCapabilities && url.includes("capabilities")) return reconnectResponse;
      return readyConfiguration(url);
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo", productMode, projectDefaultProviderId: "codex", conversationProviderId: null,
    }));
    await waitFor(() => expect(result.current.capabilitiesLoading).toBe(false));
    await act(async () => { await result.current.selectProvider("claude"); });
    deferCapabilities = true;
    let reconnect!: Promise<void>;
    act(() => { reconnect = result.current.reload(); });
    expect(result.current.capabilitiesLoading).toBe(true);
    expect(result.current.selectedProviderId).toBe("claude");
    await act(async () => {
      resolveReconnect(json({ providers: [provider("codex", productMode), provider("claude", productMode)] }));
      await reconnect;
    });
    expect(result.current.selectedProviderId).toBe("claude");
    expect(result.current.modelSettings?.providerId).toBe("claude");
  });

  it("retains the scoped choice through a failed reread and recovery without clearing admission errors early", async () => {
    let failCapabilities = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (failCapabilities && url.includes("capabilities")) throw new TypeError("Failed to fetch");
      return readyConfiguration(url);
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo", productMode: "agent", projectDefaultProviderId: "codex", conversationProviderId: null,
    }));
    await waitFor(() => expect(result.current.capabilitiesLoading).toBe(false));
    await act(async () => { await result.current.selectProvider("claude"); });
    failCapabilities = true;
    await act(async () => { await expect(result.current.reload()).rejects.toThrow("Failed to fetch"); });
    expect(result.current.selectedProviderId).toBe("claude");
    expect(result.current.capabilities).toEqual([]);
    expect(result.current.capabilitiesError).toBeTruthy();
    failCapabilities = false;
    await act(async () => { await result.current.reload(); });
    expect(result.current.selectedProviderId).toBe("claude");
    expect(result.current.capabilitiesError).toBeNull();
  });

  it.each(["project", "mode"] as const)("does not expose the previous choice during a different %s read", async (changedScope) => {
    let deferCapabilities = false;
    let resolveTarget!: (response: Response) => void;
    const targetResponse = new Promise<Response>((resolve) => { resolveTarget = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (deferCapabilities && url.includes("capabilities")) return targetResponse;
      return readyConfiguration(url);
    }));
    const { result, rerender } = renderHook(({ projectId, productMode }) => useProviderConfigurationController({
      projectId, productMode, projectDefaultProviderId: "codex", conversationProviderId: null,
    }), { initialProps: { projectId: "repo", productMode: "agent" as ProductMode } });
    await waitFor(() => expect(result.current.capabilitiesLoading).toBe(false));
    await act(async () => { await result.current.selectProvider("claude"); });
    deferCapabilities = true;
    const productMode = changedScope === "mode" ? "harness" : "agent";
    rerender({ projectId: changedScope === "project" ? "target" : "repo", productMode });
    expect(result.current.capabilitiesLoading).toBe(true);
    expect(result.current.selectedProviderId).toBeNull();
    await act(async () => {
      resolveTarget(json({ providers: [provider("codex", productMode), provider("claude", productMode)] }));
    });
    expect(result.current.selectedProviderId).toBe("codex");
  });

  it("keeps a dismissed failure as admission evidence and shows a new failure again", async () => {
    let unavailable = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities")) {
        if (unavailable) throw new TypeError("Failed to fetch");
        return json({ providers: [provider("codex", "agent")] });
      }
      if (url.endsWith("/diagnostics")) return json(diagnostics("codex"));
      if (url.endsWith("/models")) return json(models("codex"));
      return json({});
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo", productMode: "agent", projectDefaultProviderId: null, conversationProviderId: null,
    }));
    await waitFor(() => expect(result.current.failureNotice?.message).toContain("暂时无法连接到本地服务"));
    const firstFailure = result.current.failureNotice;
    act(() => result.current.dismissFailureNotice());
    expect(result.current.failureNotice).toBeNull();
    expect(result.current.capabilitiesError).toBe(firstFailure?.message);
    await act(async () => { await expect(result.current.reload()).rejects.toThrow("Failed to fetch"); });
    expect(result.current.failureNotice?.generation).not.toBe(firstFailure?.generation);
    unavailable = false;
    await act(async () => { await result.current.reload(); });
    expect(result.current.failureNotice).toBeNull();
    expect(result.current.capabilitiesError).toBeNull();
    expect(result.current.selectedProviderId).toBe("codex");
  });

  it("keeps the existing notice until a pending reread has successful evidence", async () => {
    let resolveRetry!: (response: Response) => void;
    const retryResponse = new Promise<Response>((resolve) => { resolveRetry = resolve; });
    let capabilityRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("capabilities")) {
        if (++capabilityRequests === 1) throw new TypeError("Failed to fetch");
        return retryResponse;
      }
      return json({});
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo", productMode: "agent", projectDefaultProviderId: null, conversationProviderId: null,
    }));
    await waitFor(() => expect(result.current.failureNotice).not.toBeNull());
    const initialFailure = result.current.failureNotice;
    let reload!: Promise<void>;
    act(() => { reload = result.current.reload(); });
    expect(result.current.capabilitiesLoading).toBe(true);
    expect(result.current.failureNotice).toEqual(initialFailure);
    await act(async () => { resolveRetry(json({ providers: [] })); await reload; });
    expect(result.current.capabilitiesLoading).toBe(false);
    expect(result.current.failureNotice).toBeNull();
  });

  it("does not show a failed project's notice while another scope is loading", async () => {
    let resolveTarget!: (response: Response) => void;
    const targetResponse = new Promise<Response>((resolve) => { resolveTarget = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/repo/")) throw new TypeError("Failed to fetch");
      return targetResponse;
    }));
    const { result, rerender } = renderHook(({ projectId }) => useProviderConfigurationController({
      projectId, productMode: "agent", projectDefaultProviderId: null, conversationProviderId: null,
    }), { initialProps: { projectId: "repo" } });
    await waitFor(() => expect(result.current.failureNotice).not.toBeNull());
    rerender({ projectId: "target" });
    expect(result.current.failureNotice).toBeNull();
    expect(result.current.capabilitiesError).toBeNull();
    await act(async () => { resolveTarget(json({ providers: [] })); });
    expect(result.current.capabilitiesLoading).toBe(false);
  });

  it("ignores an older failure after a newer reload succeeds in the same scope", async () => {
    let rejectInitial!: (cause: Error) => void;
    const initialResponse = new Promise<Response>((_resolve, reject) => { rejectInitial = reject; });
    let capabilityRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities")) return ++capabilityRequests === 1
        ? initialResponse : json({ providers: [provider("codex", "agent")] });
      if (url.endsWith("/diagnostics")) return json(diagnostics("codex"));
      if (url.endsWith("/models")) return json(models("codex"));
      return json({});
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo", productMode: "agent", projectDefaultProviderId: null,
      conversationProviderId: null,
    }));
    await act(async () => { await result.current.reload(); });
    await act(async () => { rejectInitial(new TypeError("Failed to fetch")); });
    expect(result.current.capabilities.map((item) => item.providerId)).toEqual(["codex"]);
    expect(result.current.capabilitiesError).toBeNull();
    expect(result.current.failureNotice).toBeNull();
  });

  it("does not forward a superseded retry rejection into the caller's error surface", async () => {
    let rejectRetry!: (cause: Error) => void;
    const retryResponse = new Promise<Response>((_resolve, reject) => { rejectRetry = reject; });
    let capabilityRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities")) return ++capabilityRequests === 2
        ? retryResponse : json({ providers: [provider("codex", "agent")] });
      if (url.endsWith("/diagnostics")) return json(diagnostics("codex"));
      if (url.endsWith("/models")) return json(models("codex"));
      return json({});
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo", productMode: "agent", projectDefaultProviderId: null, conversationProviderId: null,
    }));
    await waitFor(() => expect(result.current.capabilitiesLoading).toBe(false));
    let supersededRetry!: Promise<void>;
    act(() => { supersededRetry = result.current.reload(); });
    await act(async () => { await result.current.reload(); });
    await act(async () => {
      rejectRetry(new TypeError("Failed to fetch"));
      await expect(supersededRetry).resolves.toBeUndefined();
    });
    expect(result.current.capabilitiesError).toBeNull();
    expect(result.current.failureNotice).toBeNull();
    expect(result.current.selectedProviderId).toBe("codex");
  });

  it.each([null, "codex"])("restores draft provider %s while capabilities are loading without losing the catalog", async (savedProvider) => {
    let resolveInitial!: (response: Response) => void;
    const initialResponse = new Promise<Response>((resolve) => { resolveInitial = resolve; });
    let capabilityRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities")) return ++capabilityRequests === 1
        ? initialResponse : json({ providers: [provider("codex", "agent")] });
      if (url.endsWith("/diagnostics")) return json(diagnostics("codex"));
      if (url.endsWith("/models")) return json(models("codex"));
      return json({});
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo", productMode: "agent", projectDefaultProviderId: null,
      conversationProviderId: null,
    }));
    act(() => result.current.restoreDraftProvider(savedProvider));
    await waitFor(() => expect(result.current.capabilities.map((item) => item.providerId)).toEqual(["codex"]));
    expect(result.current.selectedProviderId).toBe("codex");
    expect(result.current.modelSettings?.providerId).toBe("codex");
    expect(result.current.modelCatalogs[0]?.status).toBe("ready");
    await act(async () => { resolveInitial(json({ providers: [provider("stale", "agent")] })); });
    expect(result.current.capabilities.map((item) => item.providerId)).toEqual(["codex"]);
  });

  it("keeps the conversation provider ahead of local and project defaults", () => {
    expect(selectEffectiveProviderId({
      conversationProviderId: "claude",
      selectedProviderId: "codex",
      projectDefaultProviderId: "codex",
      capabilities: [provider("codex"), provider("claude")],
    })).toBe("claude");
  });

  it("does not invent a selection when multiple providers have no explicit owner", () => {
    expect(selectEffectiveProviderId({
      conversationProviderId: null,
      selectedProviderId: null,
      projectDefaultProviderId: null,
      capabilities: [provider("codex"), provider("claude")],
    })).toBeNull();
  });

  it("builds explicit global and project mode capability paths", () => {
    expect(providerCapabilitiesPath(null, "agent")).toBe("/api/providers/capabilities?productMode=agent");
    expect(providerCapabilitiesPath("repo", "harness")).toBe("/api/projects/repo/providers/capabilities?productMode=harness");
  });

  it("does not apply a late capability response from the previous mode", async () => {
    let resolveAgent!: (response: Response) => void;
    const agentResponse = new Promise<Response>((resolve) => { resolveAgent = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities?productMode=agent")) return agentResponse;
      if (url.includes("capabilities?productMode=harness")) return json({ providers: [provider("harness-provider", "harness")] });
      if (url.endsWith("/diagnostics")) return json({
        providerId: "harness-provider",
        displayName: "Harness provider",
        installation: {},
        models: {},
      });
      if (url.endsWith("/models")) return json({
        providerId: "harness-provider",
        effectiveModel: null,
        effectiveModelSource: "provider-default",
        candidates: [],
        available: true,
      });
      return json({});
    }));
    const { result, rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProviderConfigurationController({
        projectId: "repo",
        productMode,
        projectDefaultProviderId: null,
        conversationProviderId: null,
      }),
      { initialProps: { productMode: "agent" as ProductMode } },
    );

    rerender({ productMode: "harness" });
    await waitFor(() => expect(result.current.capabilities[0]?.providerId).toBe("harness-provider"));
    resolveAgent(json({ providers: [provider("stale-agent", "agent")] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.capabilities.map((item) => item.providerId)).toEqual(["harness-provider"]);
    expect(result.current.capabilitiesError).toBeNull();
    expect(result.current.failureNotice).toBeNull();
  });

  it("does not surface a late capability failure from the previous mode", async () => {
    let rejectAgent!: (cause: Error) => void;
    const agentResponse = new Promise<Response>((_resolve, reject) => { rejectAgent = reject; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities?productMode=agent")) return agentResponse;
      if (url.includes("capabilities?productMode=harness")) return json({ providers: [] });
      return json({});
    }));
    const { result, rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProviderConfigurationController({
        projectId: "repo",
        productMode,
        projectDefaultProviderId: null,
        conversationProviderId: null,
      }),
      { initialProps: { productMode: "agent" as ProductMode } },
    );

    rerender({ productMode: "harness" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/projects/repo/providers/capabilities?productMode=harness",
    ));
    rejectAgent(new Error("stale agent failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.capabilitiesError).toBeNull();
    expect(result.current.failureNotice).toBeNull();
  });

  it("hides the previous scope configuration while the target scope is unresolved", async () => {
    let resolveHarness!: (response: Response) => void;
    const harnessResponse = new Promise<Response>((resolve) => { resolveHarness = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities?productMode=agent")) return json({ providers: [provider("agent-provider", "agent")] });
      if (url.includes("capabilities?productMode=harness")) return harnessResponse;
      if (url.includes("agent-provider/diagnostics")) return json(diagnostics("agent-provider"));
      if (url.includes("agent-provider/models")) return json(models("agent-provider"));
      if (url.includes("harness-provider/diagnostics")) return json(diagnostics("harness-provider"));
      if (url.includes("harness-provider/models")) return json(models("harness-provider"));
      return json({});
    }));
    const { result, rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProviderConfigurationController({
        projectId: "repo",
        productMode,
        projectDefaultProviderId: null,
        conversationProviderId: null,
      }),
      { initialProps: { productMode: "agent" as ProductMode } },
    );
    await waitFor(() => expect(result.current.selectedProviderId).toBe("agent-provider"));
    expect(result.current.diagnostics?.providerId).toBe("agent-provider");
    expect(result.current.modelSettings?.providerId).toBe("agent-provider");

    rerender({ productMode: "harness" });

    expect(result.current.capabilities).toEqual([]);
    expect(result.current.selectedProviderId).toBeNull();
    expect(result.current.diagnostics).toBeNull();
    expect(result.current.modelSettings).toBeNull();

    resolveHarness(json({ providers: [provider("harness-provider", "harness")] }));
    await waitFor(() => expect(result.current.selectedProviderId).toBe("harness-provider"));
    expect(result.current.diagnostics?.providerId).toBe("harness-provider");
    expect(result.current.modelSettings?.providerId).toBe("harness-provider");
  });

  it("loads every provider model catalog and keeps a partial failure inside its group", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("capabilities")) return json({ providers: [provider("codex", "agent"), provider("claude", "agent")] });
      if (url.includes("codex/models")) return json(models("codex"));
      if (url.includes("claude/models")) return new Response("unavailable", { status: 503 });
      return json({});
    }));
    const { result } = renderHook(() => useProviderConfigurationController({
      projectId: "repo",
      productMode: "agent",
      projectDefaultProviderId: null,
      conversationProviderId: null,
    }));

    await waitFor(() => expect(result.current.modelCatalogs).toHaveLength(2));
    expect(result.current.selectedProviderId).toBeNull();
    expect(result.current.modelCatalogs.map((group) => [group.providerId, group.status])).toEqual([
      ["codex", "ready"],
      ["claude", "error"],
    ]);
    expect(result.current.modelCatalogs[0]?.snapshot?.providerId).toBe("codex");
    expect(result.current.modelCatalogs[1]?.message).toBeTruthy();
  });
});

function diagnostics(providerId: string) {
  return { providerId, displayName: providerId, installation: {}, models: {} };
}

function models(providerId: string) {
  return {
    providerId,
    effectiveModel: null,
    effectiveModelSource: "provider-default",
    candidates: [],
    available: true,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function readyConfiguration(url: string): Response {
  const productMode = url.endsWith("productMode=harness") ? "harness" : "agent";
  if (url.includes("capabilities")) return json({ providers: [provider("codex", productMode), provider("claude", productMode)] });
  const providerId = url.includes("/claude/") ? "claude" : "codex";
  if (url.endsWith("/diagnostics")) return json(diagnostics(providerId));
  if (url.endsWith("/models")) return json(models(providerId));
  return json({});
}
