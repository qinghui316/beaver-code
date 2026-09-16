// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
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
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProviderConfigurationController({
        projectId: "repo",
        productMode,
        projectDefaultProviderId: null,
        conversationProviderId: null,
        onError,
      }),
      { initialProps: { productMode: "agent" as ProductMode } },
    );

    rerender({ productMode: "harness" });
    await waitFor(() => expect(result.current.capabilities[0]?.providerId).toBe("harness-provider"));
    resolveAgent(json({ providers: [provider("stale-agent", "agent")] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.capabilities.map((item) => item.providerId)).toEqual(["harness-provider"]);
    expect(onError).not.toHaveBeenCalled();
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
    const onError = vi.fn();
    const { rerender } = renderHook(
      ({ productMode }: { productMode: ProductMode }) => useProviderConfigurationController({
        projectId: "repo",
        productMode,
        projectDefaultProviderId: null,
        conversationProviderId: null,
        onError,
      }),
      { initialProps: { productMode: "agent" as ProductMode } },
    );

    rerender({ productMode: "harness" });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/projects/repo/providers/capabilities?productMode=harness",
    ));
    rejectAgent(new Error("stale agent failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).not.toHaveBeenCalled();
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
        onError: vi.fn(),
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
      onError: vi.fn(),
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
