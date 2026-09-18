import type { ProductMode, ProviderCapabilityItem, ProviderCapabilitySnapshot, ProviderDiagnostics } from "../types.js";
import type { UserFacingFailure } from "./user-facing-language.js";

const PROJECT_CAPABILITY_KEYS = new Set<ProviderCapabilityItem["key"]>(["skill.native-load"]);
const OPTIONAL_CAPABILITY_KEYS = new Set<ProviderCapabilityItem["key"]>(["turn.plan", "model.list"]);
const SERVICE_CORE_CAPABILITY_KEYS = new Set<ProviderCapabilityItem["key"]>(["turn.start", "stream.text"]);

export interface ProviderHealthViewModel {
  readonly serviceState: "connected" | "attention" | "unavailable";
  readonly serviceSummary: string;
  readonly projectIssue: UserFacingFailure | null;
  readonly featureIssues: readonly UserFacingFailure[];
}

export function providerHealthViewModel({ snapshot, diagnostics, hasSelectedProject, productMode }: {
  snapshot: ProviderCapabilitySnapshot | null;
  diagnostics: ProviderDiagnostics | null;
  hasSelectedProject: boolean;
  productMode: ProductMode;
}): ProviderHealthViewModel {
  const capabilities = snapshot?.capabilities ?? diagnostics?.capabilities.capabilities ?? [];
  const skill = capabilities.find((item) => item.key === "skill.native-load");
  const projectIssue = hasSelectedProject && skill && skill.runtime !== "ready"
    ? { summary: "这个项目的技能配置需要处理。", recoveryAction: "重新检测，或在技能设置中检查项目技能。", technicalDetail: skill.reason }
    : null;
  const featureIssues = capabilities
    .filter((item) => item.runtime !== "ready" && !PROJECT_CAPABILITY_KEYS.has(item.key) && !SERVICE_CORE_CAPABILITY_KEYS.has(item.key))
    .map(featureIssue);
  const coreCapabilities = capabilities.filter((item) => SERVICE_CORE_CAPABILITY_KEYS.has(item.key));
  const directAgent = productMode === "agent";
  const serviceUnavailable = diagnostics?.installation.available === false
    || (directAgent && diagnostics?.sessionHealth === "unavailable")
    || snapshot?.status === "unavailable"
    || (directAgent && coreCapabilities.some((item) => item.runtime === "unavailable"));
  const nonProjectBlockingIssue = capabilities.some((item) =>
    item.runtime !== "ready"
    && !PROJECT_CAPABILITY_KEYS.has(item.key)
    && !OPTIONAL_CAPABILITY_KEYS.has(item.key),
  );
  const serviceAttention = !serviceUnavailable && (
    diagnostics === null
    || (directAgent && diagnostics.sessionHealth === "degraded")
    || diagnostics.models.available === false
    || (directAgent && coreCapabilities.some((item) => item.runtime === "degraded"))
    || (snapshot?.runnable === false && nonProjectBlockingIssue)
  );
  const displayName = diagnostics?.displayName ?? snapshot?.displayName ?? "当前 AI 服务";
  if (serviceUnavailable) return { serviceState: "unavailable", serviceSummary: `${displayName} 当前不可用。`, projectIssue, featureIssues };
  if (diagnostics === null) return { serviceState: "attention", serviceSummary: `${displayName} 的连接状态需要重新检测。`, projectIssue, featureIssues };
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
