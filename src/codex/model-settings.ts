import { join } from "node:path";
import { z } from "zod";
import { getAhoHome } from "../fs/path.js";
import { readJsonFile, writeJsonFile } from "../fs/json.js";
import { defaultCodexAppServerHostRegistry } from "./app-server-host.js";
import { readCodexConfigModelStatus } from "./trust.js";

export type CodexModelCandidateSource = "runtime" | "config";
export type CodexEffectiveModelSource = "selected" | "config" | "codex-default";

export interface CodexModelCandidate {
  id: string;
  model: string;
  label: string;
  source: CodexModelCandidateSource;
  isDefault?: boolean;
  supportedReasoningEfforts: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  defaultReasoningEffort: string | null;
}

export interface CodexModelListStatus {
  available: boolean;
  degraded: boolean;
  degradedReason?: string;
  candidates: CodexModelCandidate[];
}

export interface CodexModelSettingsSnapshot {
  selectedModel: string | null;
  customModels: CodexModelCandidate[];
  configModel: string | null;
  configPath: string;
  configExists: boolean;
  configReason?: string;
  modelList: CodexModelListStatus;
  candidates: CodexModelCandidate[];
  effectiveModel: string | null;
  effectiveModelSource: CodexEffectiveModelSource;
}

const successfulRuntimeModels = new Map<string, CodexModelCandidate[]>();

const CustomModelSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  updatedAt: z.string(),
});

const RuntimeSettingsSchema = z.object({
  version: z.literal("1.0").default("1.0"),
  codex: z.object({
    selectedModel: z.string().nullable().optional(),
    customModels: z.array(CustomModelSchema).default([]),
  }).default({ selectedModel: null, customModels: [] }),
}).passthrough();

type RuntimeSettings = {
  version: "1.0";
  codex: {
    selectedModel?: string | null;
    customModels: Array<z.infer<typeof CustomModelSchema>>;
  };
};

export function normalizeCodexModelId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function readCodexModelSettings(): Promise<RuntimeSettings> {
  const settings = await readJsonFile(settingsPath(), RuntimeSettingsSchema as z.ZodType<RuntimeSettings>, { version: "1.0", codex: { selectedModel: null, customModels: [] } });
  const legacyCustomIds = new Set(settings.codex.customModels.map((item) => normalizeCodexModelId(item.id)).filter((item): item is string => Boolean(item)));
  const selectedModel = normalizeCodexModelId(settings.codex.selectedModel);
  const sanitized: RuntimeSettings = {
    ...settings,
    version: "1.0",
    codex: {
      selectedModel: selectedModel && !legacyCustomIds.has(selectedModel) ? selectedModel : null,
      customModels: [],
    },
  };
  return sanitized;
}

export async function setSelectedCodexModel(model: string | null): Promise<RuntimeSettings> {
  const settings = await readCodexModelSettings();
  const selectedModel = normalizeCodexModelId(model);
  const next = {
    ...settings,
    version: "1.0" as const,
    codex: {
      ...settings.codex,
      selectedModel,
    },
  };
  await writeJsonFile(settingsPath(), next);
  return next;
}

export async function resolveCodexEffectiveModel(explicitModel?: string | null): Promise<{ model: string | null; source: CodexEffectiveModelSource }> {
  const explicit = normalizeCodexModelId(explicitModel);
  if (explicit) return { model: explicit, source: "selected" };
  const settings = await readCodexModelSettings();
  const selected = normalizeCodexModelId(settings.codex.selectedModel);
  if (selected) return { model: selected, source: "selected" };
  const config = await readCodexConfigModelStatus();
  if (config.model) return { model: config.model, source: "config" };
  return { model: null, source: "codex-default" };
}

export async function getCodexModelSettingsSnapshot(projectPath?: string): Promise<CodexModelSettingsSnapshot> {
  const [settings, configModel, runtimeModels] = await Promise.all([
    readCodexModelSettings(),
    readCodexConfigModelStatus(),
    listCodexRuntimeModels(projectPath),
  ]);
  const selectedModel = normalizeCodexModelId(settings.codex.selectedModel);
  const selectableCandidates = mergeCandidates([
    ...runtimeModels.candidates,
    ...(configModel.model ? [{
      id: configModel.model,
      model: configModel.model,
      label: `${configModel.model} (config)`,
      source: "config" as const,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    }] : []),
  ]);
  const selectedCandidate = selectedModel ? findCandidate(selectableCandidates, selectedModel) : null;
  const effective = selectedCandidate
    ? { model: selectedCandidate.model, source: "selected" as const }
    : configModel.model
      ? { model: configModel.model, source: "config" as const }
      : { model: null, source: "codex-default" as const };
  return {
    selectedModel,
    customModels: [],
    configModel: configModel.model,
    configPath: configModel.configPath,
    configExists: configModel.configExists,
    configReason: configModel.reason,
    modelList: runtimeModels,
    candidates: selectableCandidates,
    effectiveModel: effective.model,
    effectiveModelSource: effective.source,
  };
}

export async function listCodexRuntimeModels(projectPath = process.cwd()): Promise<CodexModelListStatus> {
  const cacheKey = projectPath.toLowerCase();
  try {
    const response = await withTimeout(
      defaultCodexAppServerHostRegistry.hostFor(projectPath).requestMetadata("model/list", {}),
      3000,
      "Codex model_list timed out.",
    );
    const candidates = candidatesFromModelListResponse(response);
    successfulRuntimeModels.set(cacheKey, candidates);
    return { available: true, degraded: false, candidates };
  } catch (error) {
    const cached = successfulRuntimeModels.get(cacheKey) ?? [];
    return { available: cached.length > 0, degraded: true, degradedReason: sanitizeModelListFailure(error), candidates: cached };
  }
}

export function resetCodexModelListCacheForTests(): void {
  successfulRuntimeModels.clear();
}

function findCandidate(candidates: CodexModelCandidate[], model: string): CodexModelCandidate | null {
  const normalized = model.toLowerCase();
  return candidates.find((candidate) => candidate.model.toLowerCase() === normalized || candidate.id.toLowerCase() === normalized) ?? null;
}

function sanitizeModelListFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes("timed out")) return "Codex runtime model list timed out; using config/default model.";
  if (lower.includes("trust") || lower.includes("trusted") || lower.includes("configuration") || lower.includes("config")) {
    return "Codex runtime model list is unavailable for this project; using config/default model.";
  }
  if (lower.includes("spawn") || lower.includes("enoent") || lower.includes("not recognized")) {
    return "Codex CLI is unavailable; using config/default model.";
  }
  if (lower.includes("closed") || lower.includes("finished") || lower.includes("stdin")) {
    return "Codex runtime model list is unavailable; using config/default model.";
  }
  return "Codex runtime model list is unavailable; using config/default model.";
}

export function candidatesFromModelListResponse(response: unknown): CodexModelCandidate[] {
  const record = isRecord(response) ? response : {};
  const result = isRecord(record.result) ? record.result : record;
  const entries = Array.isArray(result.data) ? result.data : Array.isArray(record.data) ? record.data : [];
  return mergeCandidates(entries.map((entry): CodexModelCandidate | null => {
    if (!isRecord(entry)) return null;
    const model = normalizeCodexModelId(entry.model) ?? normalizeCodexModelId(entry.id);
    if (!model) return null;
    const label = normalizeCodexModelId(entry.displayName) ?? normalizeCodexModelId(entry.display_name) ?? model;
    const rawEfforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts
      : Array.isArray(entry.supported_reasoning_efforts)
        ? entry.supported_reasoning_efforts
        : [];
    const supportedReasoningEfforts = rawEfforts
      .map((option) => {
        if (!isRecord(option)) return null;
        const value = normalizeCodexModelId(option.reasoningEffort)
          ?? normalizeCodexModelId(option.reasoning_effort)
          ?? normalizeCodexModelId(option.value);
        if (!value) return null;
        const description = normalizeCodexModelId(option.description);
        return {
          value,
          label: reasoningEffortLabel(value),
          ...(description ? { description } : {}),
        };
      })
      .filter((option): option is NonNullable<typeof option> => option !== null);
    return {
      id: normalizeCodexModelId(entry.id) ?? model,
      model,
      label,
      source: "runtime",
      isDefault: entry.isDefault === true || entry.is_default === true,
      supportedReasoningEfforts,
      defaultReasoningEffort: normalizeCodexModelId(entry.defaultReasoningEffort)
        ?? normalizeCodexModelId(entry.default_reasoning_effort),
    };
  }).filter((candidate): candidate is CodexModelCandidate => candidate !== null));
}

function mergeCandidates(candidates: CodexModelCandidate[]): CodexModelCandidate[] {
  const byModel = new Map<string, CodexModelCandidate>();
  for (const candidate of candidates) {
    const key = candidate.model.toLowerCase();
    const existing = byModel.get(key);
    if (!existing) byModel.set(key, candidate);
  }
  return [...byModel.values()];
}

function settingsPath(): string {
  return join(getAhoHome(), "settings.json");
}

function reasoningEffortLabel(value: string): string {
  return ({
    none: "无",
    minimal: "极低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
  } as Record<string, string>)[value.toLowerCase()] ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
