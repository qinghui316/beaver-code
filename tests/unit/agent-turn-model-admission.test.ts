import { describe, expect, it, vi } from "vitest";
import type { ProviderModelSettingsSnapshot } from "../../src/provider-runtime/index.js";
import type { ManagedProject } from "../../src/types/index.js";
import { ConversationModelAdmissionOwner } from "../../src/workbench/conversation-model-admission.js";

describe("Conversation model admission", () => {
  it("captures explicit model and effort from one immutable catalog read", async () => {
    const read = vi.fn(async () => modelSnapshot());
    const owner = admissionOwner(read);

    const admission = await owner.admit({
      project: project(),
      providerId: "codex",
      requested: { providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" },
      requireResolvedModel: true,
    });

    expect(admission).toMatchObject({
      requested: { modelId: "gpt-test", reasoningEffort: "high" },
      resolvedModelId: "gpt-test",
      resolvedReasoningEffort: "high",
      modelSource: "explicit",
      effortSource: "explicit",
    });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });

  it("allows a configured unknown model only with Provider-default effort", async () => {
    const configured = modelSnapshot({
      effectiveModel: { providerId: "codex", modelId: "config-model" },
      candidates: [{
        providerId: "codex",
        modelId: "config-model",
        label: "Config model",
        source: "config",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      }],
      available: false,
    });
    const owner = admissionOwner(vi.fn(async () => configured));

    await expect(owner.admit({
      project: project(),
      providerId: "codex",
      requested: { providerId: "codex", modelId: null, reasoningEffort: null },
      requireResolvedModel: true,
    })).resolves.toMatchObject({
      resolvedModelId: "config-model",
      resolvedReasoningEffort: null,
      effortSource: "provider-default",
    });
    await expect(owner.admit({
      project: project(),
      providerId: "codex",
      requested: { providerId: "codex", modelId: null, reasoningEffort: "high" },
      requireResolvedModel: false,
    })).rejects.toMatchObject({ name: "Conflict", message: expect.stringContaining("not supported") });
  });

  it("fails closed when the catalog cannot be read or Plan cannot resolve a model", async () => {
    const unavailable = admissionOwner(vi.fn(async () => { throw new Error("offline"); }));
    await expect(unavailable.admit({
      project: project(), providerId: "codex", requested: { providerId: "codex", modelId: null, reasoningEffort: null }, requireResolvedModel: false,
    })).rejects.toMatchObject({ name: "Conflict", message: expect.stringContaining("unavailable") });

    const empty = admissionOwner(vi.fn(async () => modelSnapshot({ effectiveModel: null, candidates: [] })));
    await expect(empty.admit({
      project: project(), providerId: "codex", requested: { providerId: "codex", modelId: null, reasoningEffort: null }, requireResolvedModel: true,
    })).rejects.toMatchObject({ name: "Conflict", message: expect.stringContaining("requires a model") });
  });
});

function admissionOwner(read: () => Promise<ProviderModelSettingsSnapshot>): ConversationModelAdmissionOwner {
  return new ConversationModelAdmissionOwner({
    get: () => ({ models: { read } }),
  } as never);
}

function modelSnapshot(overrides: Partial<ProviderModelSettingsSnapshot> = {}): ProviderModelSettingsSnapshot {
  return {
    providerId: "codex",
    selectedModel: null,
    effectiveModel: { providerId: "codex", modelId: "gpt-test" },
    effectiveModelSource: "provider-default",
    candidates: [{
      providerId: "codex",
      modelId: "gpt-test",
      label: "GPT Test",
      source: "runtime",
      supportedReasoningEfforts: [{ value: "high", label: "High" }],
      defaultReasoningEffort: "high",
    }],
    available: true,
    ...overrides,
  };
}

function project(): ManagedProject {
  return {
    id: "project",
    name: "Project",
    path: "C:\\project",
    addedAt: "2026-08-23T00:00:00.000Z",
    lastSeenAt: "2026-08-23T00:00:00.000Z",
    defaultProviderId: "codex",
  };
}
