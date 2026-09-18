import type { ProviderCapabilityItem, ProviderCapabilitySnapshot, ProviderDiagnostics } from "../types.js";
import type { UserFacingFailure } from "./user-facing-language.js";

export interface ProviderHealthViewModel {
  readonly serviceState: "connected" | "attention" | "unavailable";
  readonly serviceSummary: string;
  readonly projectIssue: UserFacingFailure | null;
  readonly featureIssues: readonly UserFacingFailure[];
}

export function providerHealthViewModel({ snapshot, diagnostics, hasSelectedProject }: {
  snapshot: ProviderCapabilitySnapshot | null;
  diagnostics: ProviderDiagnostics | null;
  hasSelectedProject: boolean;
}): ProviderHealthViewModel {
  const capabilities = snapshot?.capabilities ?? diagnostics?.capabilities.capabilities ?? [];
  const skill = capabilities.find((item) => item.key === "skills");
  const projectIssue = hasSelectedProject && skill && skill.runtime !== "ready"
    ? { summary: "这个项目的技能配置需要处理。", recoveryAction: "重新检测，或在技能设置中检查项目技能。", technicalDetail: skill.reason }
    : null;
  const featureIssues = capabilities.filter((item) => item.key !== "skills" && item.runtime !== "ready").map(featureIssue);
  const serviceUnavailable = diagnostics?.installation.available === false || diagnostics?.sessionHealth === "unavailable";
  const serviceAttention = !serviceUnavailable && (diagnostics?.sessionHealth === "degraded" || diagnostics?.models.available === false);
  const displayName = diagnostics?.displayName ?? snapshot?.displayName ?? "当前 AI 服务";
  if (serviceUnavailable) return { serviceState: "unavailable", serviceSummary: `${displayName} 当前不可用。`, projectIssue, featureIssues };
  if (serviceAttention) return { serviceState: "attention", serviceSummary: `${displayName} 已连接，部分服务需要注意。`, projectIssue, featureIssues };
  return { serviceState: "connected", serviceSummary: `${displayName} 已连接。`, projectIssue, featureIssues };
}

function featureIssue(item: ProviderCapabilityItem): UserFacingFailure {
  return {
    summary: item.key === "turn.plan" ? "计划模式暂不可用。" : `${item.label}暂不可用。`,
    recoveryAction: "可重新检测，或查看诊断了解详情。",
    technicalDetail: item.reason,
  };
}
