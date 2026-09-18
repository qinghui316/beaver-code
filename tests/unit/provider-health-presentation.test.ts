import { describe, expect, it } from "vitest";
import { providerHealthViewModel } from "../../src/web/src/presentation/provider-health.js";
import type { ProviderCapabilitySnapshot, ProviderDiagnostics } from "../../src/web/src/types.js";

describe("provider health presentation", () => {
  it("keeps a project-scoped skill check from degrading the Codex service", () => {
    const health = providerHealthViewModel({ snapshot: snapshot([capability("skills", "degraded")]), diagnostics: diagnostics(), hasSelectedProject: false });
    expect(health).toMatchObject({ serviceState: "connected", serviceSummary: "Codex 已连接。", projectIssue: null });
  });

  it("projects a skill problem onto the selected project", () => {
    const health = providerHealthViewModel({ snapshot: snapshot([capability("skills", "unavailable")]), diagnostics: diagnostics(), hasSelectedProject: true });
    expect(health.serviceState).toBe("connected");
    expect(health.projectIssue?.summary).toBe("这个项目的技能配置需要处理。");
  });

  it("keeps optional plan availability separate from service health", () => {
    const health = providerHealthViewModel({ snapshot: snapshot([capability("turn.plan", "unavailable")]), diagnostics: diagnostics(), hasSelectedProject: true });
    expect(health.serviceState).toBe("connected");
    expect(health.featureIssues).toEqual([expect.objectContaining({ summary: "计划模式暂不可用。" })]);
  });

  it("marks the service unavailable only when the runtime is unavailable", () => {
    const health = providerHealthViewModel({ snapshot: snapshot([]), diagnostics: diagnostics({ available: false, sessionHealth: "unavailable" }), hasSelectedProject: false });
    expect(health).toMatchObject({ serviceState: "unavailable", serviceSummary: "Codex 当前不可用。" });
  });
});

function capability(key: "skills" | "turn.plan", runtime: "ready" | "degraded" | "unavailable") {
  return { key, label: key === "skills" ? "技能" : "计划模式", spec: "supported" as const, runtime, summary: "检测结果", reason: "project scoped" };
}

function snapshot(capabilities: ProviderCapabilitySnapshot["capabilities"]): ProviderCapabilitySnapshot {
  return { providerId: "codex", displayName: "Codex", productMode: "agent", status: "degraded", runnable: false, checkedAt: "2026-09-18T00:00:00.000Z", snapshotHash: "hash", snapshotVersion: 1, effectiveModel: null, effectiveModelSource: "provider-default", degradedReasons: [], capabilities };
}

function diagnostics(override: { available?: boolean; sessionHealth?: ProviderDiagnostics["sessionHealth"] } = {}): ProviderDiagnostics {
  const available = override.available ?? true;
  return { providerId: "codex", displayName: "Codex", installation: { available, version: "0.155.0" }, adapter: { id: "codex-app-server", version: "1" }, capabilities: snapshot([]), models: { providerId: "codex", selectedModel: null, effectiveModel: null, effectiveModelSource: "provider-default", candidates: [], available: true }, sessionHealth: override.sessionHealth ?? "ready", lastError: null, rawEvidenceRefs: [], projectActions: [] };
}
