import { createHash } from "node:crypto";
import type { ProviderModelCandidate, ProviderModelSettingsSnapshot, ProviderRegistry } from "../provider-runtime/index.js";
import type { ManagedProject } from "../types/index.js";
import type { ConversationModelAdmission, ConversationModelSelection } from "./conversation-turn-contract.js";

export class ConversationModelAdmissionOwner {
  constructor(private readonly providerRegistry: ProviderRegistry) {}

  async admit(input: {
    project: ManagedProject;
    providerId: string;
    requested: ConversationModelSelection;
    requireResolvedModel: boolean;
  }): Promise<ConversationModelAdmission> {
    if (input.requested.providerId !== input.providerId) {
      throw conflict("Conversation model selection does not match the Turn Provider.");
    }
    let snapshot: ProviderModelSettingsSnapshot;
    try {
      snapshot = await this.providerRegistry.get(input.providerId).models.read(input.project.path);
    } catch (cause) {
      throw conflict(`Provider model catalog is unavailable: ${safeMessage(cause)}`);
    }
    if (snapshot.providerId !== input.providerId) throw conflict("Provider model catalog identity does not match the Turn Provider.");

    const requestedModelId = normalizeSelection(input.requested.modelId);
    const requestedEffort = normalizeSelection(input.requested.reasoningEffort);
    const candidate = requestedModelId
      ? findCandidate(snapshot, requestedModelId)
      : snapshot.effectiveModel
        ? findCandidate(snapshot, snapshot.effectiveModel.modelId)
        : null;
    if (requestedModelId && !candidate) throw conflict("Selected model is no longer available for this Provider.");

    const resolvedModelId = requestedModelId
      ? candidate?.modelId ?? null
      : snapshot.effectiveModel?.modelId ?? null;
    if (input.requireResolvedModel && !resolvedModelId) {
      throw conflict("Agent Plan requires a model resolved from the current Provider configuration.");
    }

    if (requestedEffort) {
      if (!resolvedModelId || !candidate) throw conflict("A reasoning effort requires a resolved model.");
      const supported = candidate.supportedReasoningEfforts ?? [];
      if (supported.length === 0 || !supported.some((option) => option.value === requestedEffort)) {
        throw conflict("Selected reasoning effort is not supported by the current model.");
      }
    }

    return Object.freeze({
      providerId: input.providerId,
      requested: Object.freeze({ providerId: input.providerId, modelId: requestedModelId, reasoningEffort: requestedEffort }),
      resolvedModelId,
      resolvedReasoningEffort: requestedEffort ?? candidate?.defaultReasoningEffort ?? null,
      modelSource: requestedModelId ? "explicit" : "provider-configuration",
      effortSource: requestedEffort ? "explicit" : candidate?.defaultReasoningEffort ? "model-default" : "provider-default",
      catalogGeneration: catalogGeneration(snapshot),
    });
  }
}

function findCandidate(snapshot: ProviderModelSettingsSnapshot, modelId: string): ProviderModelCandidate | null {
  const normalized = modelId.toLowerCase();
  return snapshot.candidates.find((candidate) => candidate.modelId.toLowerCase() === normalized) ?? null;
}

function catalogGeneration(snapshot: ProviderModelSettingsSnapshot): string {
  return createHash("sha256").update(JSON.stringify({
    providerId: snapshot.providerId,
    selectedModel: snapshot.selectedModel?.modelId ?? null,
    effectiveModel: snapshot.effectiveModel?.modelId ?? null,
    effectiveModelSource: snapshot.effectiveModelSource,
    available: snapshot.available,
    candidates: snapshot.candidates.map((candidate) => ({
      modelId: candidate.modelId,
      source: candidate.source,
      supportedReasoningEfforts: (candidate.supportedReasoningEfforts ?? []).map((option) => option.value),
      defaultReasoningEffort: candidate.defaultReasoningEffort ?? null,
    })),
  })).digest("hex");
}

function normalizeSelection(value: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}
