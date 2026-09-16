import { detectCodexCapabilities } from "../codex/capabilities.js";
import { readCodexProjectTrust, trustCodexProject } from "../codex/trust.js";
import { getCodexModelSettingsSnapshot } from "../codex/model-settings.js";
import type { ManagedProject } from "../types/index.js";
import type { ProviderDiagnosticsSnapshot, ProviderProjectAction } from "./types.js";
import { getCodexProviderCapabilitySnapshot } from "./codex.js";
import { codexModelSettings } from "./codex-models.js";

export const CODEX_PROVIDER_ADAPTER = Object.freeze({
  id: "codex-app-server",
  version: "1",
});

export async function getCodexDiagnostics(project: ManagedProject | null, projectPath?: string): Promise<ProviderDiagnosticsSnapshot> {
  const [runtime, capabilities, models, trust, rawModels] = await Promise.all([
    detectCodexCapabilities(),
    getCodexProviderCapabilitySnapshot(project, "harness", projectPath),
    codexModelSettings(projectPath),
    projectPath ? readCodexProjectTrust(projectPath) : Promise.resolve(null),
    getCodexModelSettingsSnapshot(projectPath),
  ]);
  return {
    providerId: "codex",
    displayName: "Codex",
    installation: { available: runtime.available, version: runtime.version, ...(runtime.executablePath ? { path: runtime.executablePath } : {}) },
    adapter: CODEX_PROVIDER_ADAPTER,
    capabilities,
    models,
    sessionHealth: !runtime.available ? "unavailable" : runtime.errors.length > 0 ? "degraded" : "ready",
    lastError: runtime.errors[0] ?? null,
    rawEvidenceRefs: [],
    projectActions: projectPath ? projectActionsFromTrust(trust) : [],
    details: {
      approvalFlagPlacement: runtime.approvalFlagPlacement,
      runtimeSource: runtime.runtimeSource,
      configModel: rawModels.configModel,
      configPath: rawModels.configPath,
      projectTrust: trust,
    },
  };
}

export async function listCodexProjectActions(_project: ManagedProject | null, projectPath?: string): Promise<ProviderProjectAction[]> {
  if (!projectPath) return [];
  return projectActionsFromTrust(await readCodexProjectTrust(projectPath));
}

export async function executeCodexProjectAction(actionId: string, project: ManagedProject, projectPath: string): Promise<ProviderDiagnosticsSnapshot> {
  if (actionId !== "project.trust") throw new Error(`Codex 不支持项目操作：${actionId}`);
  await trustCodexProject(projectPath);
  return getCodexDiagnostics(project, projectPath);
}

function projectActionsFromTrust(trust: Awaited<ReturnType<typeof readCodexProjectTrust>> | null): ProviderProjectAction[] {
  return [{
    id: "project.trust",
    label: trust?.trusted ? "Codex 项目已信任" : "信任 Codex 项目",
    status: trust?.trusted ? "completed" : "available",
    requiresConfirmation: true,
    reason: trust?.reason,
  }];
}
