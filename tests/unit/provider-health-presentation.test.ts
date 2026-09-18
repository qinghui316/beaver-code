import { describe, expect, it } from "vitest";
import { providerHealthViewModel } from "../../src/web/src/presentation/provider-health.js";
import type { ProviderCapabilitySnapshot, ProviderDiagnostics } from "../../src/web/src/types.js";

describe("provider health presentation", () => {
  it("keeps a project-scoped skill check from degrading the Codex service", () => {
    const health = healthView({ snapshot: snapshot([capability("skill.native-load", "degraded")]), diagnostics: diagnostics(), hasSelectedProject: false });
    expect(health).toMatchObject({ serviceState: "connected", serviceSummary: "Codex 已连接。", projectIssue: null });
  });

  it("projects a skill problem onto the selected project", () => {
    const health = healthView({ snapshot: snapshot([capability("skill.native-load", "unavailable")]), diagnostics: diagnostics(), hasSelectedProject: true });
    expect(health.serviceState).toBe("connected");
    expect(health.projectIssue?.summary).toBe("这个项目的技能配置需要处理。");
  });

  it("keeps optional plan availability separate from service health", () => {
    const health = healthView({ snapshot: snapshot([capability("turn.plan", "unavailable")]), diagnostics: diagnostics(), hasSelectedProject: true });
    expect(health.serviceState).toBe("connected");
    expect(health.featureIssues).toEqual([expect.objectContaining({ summary: "计划模式暂不可用。" })]);
  });

  it("keeps an optional model catalog failure separate from service health", () => {
    const health = healthView({
      snapshot: snapshot([capability("model.list", "degraded")], { runnable: true, status: "degraded" }),
      diagnostics: diagnostics({ modelAvailable: false }),
      hasSelectedProject: true,
    });
    expect(health.serviceState).toBe("connected");
    expect(health.featureIssues).toEqual([expect.objectContaining({ summary: "模型列表暂不可用。" })]);
  });

  it("marks the service unavailable only when the runtime is unavailable", () => {
    const health = healthView({ snapshot: snapshot([]), diagnostics: diagnostics({ available: false, sessionHealth: "unavailable" }), hasSelectedProject: false });
    expect(health).toMatchObject({ serviceState: "unavailable", serviceSummary: "Codex 当前不可用。" });
  });

  it("marks an unavailable app-server core capability as a service failure", () => {
    const health = healthView({ snapshot: snapshot([capability("turn.start", "unavailable")]), diagnostics: diagnostics(), hasSelectedProject: true });
    expect(health).toMatchObject({ serviceState: "unavailable", serviceSummary: "Codex 当前不可用。" });
  });

  it("does not claim a healthy connection when diagnostics could not be loaded", () => {
    const health = healthView({ snapshot: snapshot([capability("turn.start", "ready")], { runnable: true, status: "ready" }), diagnostics: null, hasSelectedProject: true });
    expect(health).toMatchObject({ serviceState: "attention", serviceSummary: "Codex 的连接状态需要重新检测。" });
  });

  it("uses the canonical runtime skill key", () => {
    const health = healthView({ snapshot: snapshot([capability("skill.native-load", "unavailable")]), diagnostics: diagnostics(), hasSelectedProject: true });
    expect(health.projectIssue?.summary).toBe("这个项目的技能配置需要处理。");
    expect(health.featureIssues).toEqual([]);
  });

  it("does not treat an Agent-only app-server capability as an AHO service outage", () => {
    const health = providerHealthViewModel({
      snapshot: snapshot([capability("turn.start", "unavailable")], { runnable: true, status: "degraded", productMode: "harness" }),
      diagnostics: diagnostics({ sessionHealth: "unavailable" }),
      hasSelectedProject: true,
      productMode: "harness",
    });
    expect(health.serviceState).toBe("connected");
  });
});

function healthView(input: Omit<Parameters<typeof providerHealthViewModel>[0], "productMode">) {
  return providerHealthViewModel({ ...input, productMode: "agent" });
}

function capability(key: "skill.native-load" | "turn.plan" | "turn.start" | "model.list", runtime: "ready" | "degraded" | "unavailable") {
  const label = key === "skill.native-load"
    ? "技能"
    : key === "turn.plan"
      ? "计划模式"
      : key === "model.list"
        ? "模型列表"
        : "启动回合";
  return { key, label, spec: "supported" as const, runtime, summary: "检测结果", reason: "project scoped" };
}

function snapshot(capabilities: ProviderCapabilitySnapshot["capabilities"], override: Partial<Pick<ProviderCapabilitySnapshot, "runnable" | "status" | "productMode">> = {}): ProviderCapabilitySnapshot {
  return { providerId: "codex", displayName: "Codex", productMode: override.productMode ?? "agent", status: override.status ?? "degraded", runnable: override.runnable ?? false, checkedAt: "2026-09-18T00:00:00.000Z", snapshotHash: "hash", snapshotVersion: 1, effectiveModel: null, effectiveModelSource: "provider-default", degradedReasons: [], capabilities };
}

function diagnostics(override: { available?: boolean; sessionHealth?: ProviderDiagnostics["sessionHealth"]; modelAvailable?: boolean } = {}): ProviderDiagnostics {
  const available = override.available ?? true;
  return { providerId: "codex", displayName: "Codex", installation: { available, version: "0.155.0" }, adapter: { id: "codex-app-server", version: "1" }, capabilities: snapshot([]), models: { providerId: "codex", selectedModel: null, effectiveModel: null, effectiveModelSource: "provider-default", candidates: [], available: override.modelAvailable ?? true }, sessionHealth: override.sessionHealth ?? "ready", lastError: null, rawEvidenceRefs: [], projectActions: [] };
}
