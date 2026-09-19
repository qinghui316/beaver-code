import { detectCodexCapabilities } from "../codex/capabilities.js";
import { detectCodexAppServerCapability } from "../codex/app-server.js";
import { getCodexModelSettingsSnapshot } from "../codex/model-settings.js";
import { listCodexNativeSkills } from "../codex/native-skills.js";
import { getSystemSkillsRoot } from "../template-source/paths.js";
import { codexPlanModeAvailable } from "../codex/collaboration-modes.js";
import type { ManagedProject } from "../types/index.js";
import {
  PROVIDER_OPERATION_CAPABILITIES,
  type ProductMode,
  type ProviderCapabilityItem,
  type ProviderCapabilityKey,
  type ProviderCapabilitySnapshot,
  type ProviderRuntimeReadiness,
  type ProviderRuntimeSummary,
  type ProviderSnapshotStatus,
  type ProviderSpecCapabilityState,
} from "./types.js";
import { HARNESS_EXECUTION_MODES, PROVIDER_CAPABILITY_SNAPSHOT_VERSION, stableCapabilitySnapshotHash } from "./capabilities.js";

type CapabilityInput = {
  key: ProviderCapabilityKey;
  label: string;
  spec: ProviderSpecCapabilityState;
  runtime: ProviderRuntimeReadiness;
  summary: string;
  reason?: string;
};

export async function getCodexProviderRuntimeSummary(project: ManagedProject | null, productMode: ProductMode, projectPath?: string): Promise<ProviderRuntimeSummary> {
  const snapshot = await getCodexProviderCapabilitySnapshot(project, productMode, projectPath);
  return {
    providerId: "codex",
    productMode,
    harnessExecutionModes: HARNESS_EXECUTION_MODES,
    snapshot,
  };
}

export async function getCodexProviderCapabilitySnapshot(project: ManagedProject | null, productMode: ProductMode, projectPath?: string): Promise<ProviderCapabilitySnapshot> {
  const [cli, appServer, models, skills, planMode] = await Promise.all([
    detectCodexCapabilities(),
    detectCodexAppServerCapability(),
    getCodexModelSettingsSnapshot(projectPath),
    project ? listCodexNativeSkills({
      projectPath: project.path,
      extraRoots: [getSystemSkillsRoot()],
      forceReload: false,
    }).catch((error: unknown) => ({ error })) : Promise.resolve(null),
    projectPath ? codexPlanModeAvailable(projectPath).then(
      (available) => ({ available, error: null as string | null }),
      (error: unknown) => ({ available: false, error: messageFrom(error) }),
    ) : Promise.resolve({ available: false, error: "No selected project for collaboration mode discovery." }),
  ]);

  const cliReady = cli.available && cli.errors.length === 0;
  const appServerReady = appServer.supportsStdio && appServer.errors.length === 0;
  const safeExecReady = cliReady && cli.supportsJson && cli.supportsSandbox && cli.supportsCd;
  const modelListReady = models.modelList.available && !models.modelList.degraded;
  const skillCount = skills && "skills" in skills ? skills.skills.length : 0;
  const skillError = skills && "error" in skills ? messageFrom(skills.error) : null;

  const items: CapabilityInput[] = [
    {
      key: "stream.text",
      label: "文本输出",
      spec: "supported",
      runtime: safeExecReady ? "ready" : cli.available ? "degraded" : "unavailable",
      summary: safeExecReady ? "Codex exec 可用于文本运行。" : "Codex 文本运行能力需要检查。",
      reason: firstReason(cli.errors),
    },
    {
      key: "stream.reasoning-summary",
      label: "推理输出",
      spec: "supported",
      runtime: safeExecReady ? "ready" : cli.available ? "degraded" : "unavailable",
      summary: "AHO 只显示 Codex 可见输出或摘要，不读取私有推理。",
      reason: safeExecReady ? undefined : firstReason(cli.errors),
    },
    {
      key: "stream.tool-output",
      label: "工具输出",
      spec: "supported",
      runtime: safeExecReady ? "ready" : cli.available ? "degraded" : "unavailable",
      summary: safeExecReady ? "Codex JSON 事件可归档为运行证据。" : "Codex JSON 事件能力需要检查。",
      reason: cli.supportsJson ? undefined : "Codex exec does not expose required JSON output.",
    },
    {
      key: "workspace.write",
      label: "工具调用",
      spec: "supported",
      runtime: safeExecReady ? "ready" : cli.available ? "degraded" : "unavailable",
      summary: "工具权限仍由 AHO ToolPolicy 和 Harness gates 约束。",
      reason: safeExecReady ? undefined : firstReason(cli.errors),
    },
    {
      key: "tool.mcp",
      label: "MCP / 插件",
      spec: "supported",
      runtime: skillError ? "degraded" : "ready",
      summary: skillError ? "Skill/MCP 状态读取降级。" : "Codex 原生 Skill 和 MCP 能力可供 Runtime 使用。",
      reason: skillError ?? undefined,
    },
    {
      key: "reasoning.effort",
      label: "推理强度",
      spec: "supported",
      runtime: modelListReady ? "ready" : "degraded",
      summary: modelListReady ? "当前模型目录提供可验证的推理强度选项。" : "模型目录不可用时只能沿用 Provider 默认推理强度。",
      reason: models.modelList.degradedReason,
    },
    {
      key: "tool.dynamic",
      label: "执行策略",
      spec: "compat-input",
      runtime: "ready",
      summary: "Harness 执行策略由 AHO 的逐步确认 / 自动推进控制，不是底层 provider 权限。",
    },
    {
      key: "session.continuation",
      label: "会话续接",
      spec: "supported",
      runtime: appServerReady ? "ready" : appServer.supportsStdio ? "degraded" : "unavailable",
      summary: appServerReady ? "Codex app-server 可续接原生会话。" : "Codex app-server 会话续接能力需要检查。",
      reason: appServerReady ? undefined : firstReason(appServer.errors),
    },
    {
      key: "image.input",
      label: "图片输入",
      spec: "supported",
      runtime: appServerReady ? "ready" : "unavailable",
      summary: appServerReady ? "图片附件可通过 Codex app-server LocalImage 输入传入。" : "图片输入需要 Codex app-server。",
      reason: appServerReady ? undefined : firstReason(appServer.errors),
    },
    {
      key: "file.reference",
      label: "文件引用",
      spec: "supported",
      runtime: appServerReady ? "ready" : "unavailable",
      summary: appServerReady ? "托管文本和代码文件可通过 Codex app-server Mention 输入传入。" : "文件引用需要 Codex app-server。",
      reason: appServerReady ? undefined : firstReason(appServer.errors),
    },
    {
      key: "model.list",
      label: "模型列表",
      spec: "supported",
      runtime: modelListReady ? "ready" : "degraded",
      summary: modelListReady ? "已读取 Codex runtime 模型候选。" : "模型列表不可用时继续使用 config/default model。",
      reason: models.modelList.degradedReason,
    },
    {
      key: "skill.native-load",
      label: "Skills",
      spec: "supported",
      runtime: skillError ? "degraded" : project ? "ready" : "degraded",
      summary: project ? `${skillCount} 个 Skill 对当前项目可见。` : "选择项目后读取 native/custom/system Skills。",
      reason: skillError ?? (project ? undefined : "No selected project for project-scoped Skill status."),
    },
  ];
  items.push(
    { key: "turn.start", label: "启动回合", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可启动原生回合。" },
    { key: "turn.resume", label: "续接回合", spec: "supported", runtime: appServerReady ? "ready" : "degraded", summary: "Codex app-server 可续接原生会话。" },
    { key: "turn.interrupt", label: "中断回合", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 支持中断当前回合。" },
    { key: "turn.steer", label: "实时引导", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 支持向当前回合发送文本补充。" },
    { key: "turn.user-input", label: "用户问答", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可路由用户回答。" },
    { key: "turn.approval", label: "Provider 审批", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可路由命令、文件修改和权限审批。" },
    { key: "turn.review", label: "代码审查", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可在当前会话内执行原生只读代码审查。" },
    { key: "context.usage", label: "上下文用量", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可发布当前会话上下文用量。" },
    { key: "context.compact", label: "上下文压缩", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可压缩空闲会话上下文。" },
    { key: "session.fork", label: "会话分叉", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可从已完成回合创建独立会话分支。" },
    { key: "session.archive", label: "会话归档", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 可归档和恢复原生会话。" },
    {
      key: "turn.plan",
      label: "Plan 回合",
      spec: "supported",
      runtime: appServerReady && planMode.available ? "ready" : "unavailable",
      summary: planMode.available ? "Codex app-server 提供原生 Plan collaboration mode。" : "Codex app-server 未提供原生 Plan collaboration mode。",
      reason: planMode.error ?? undefined,
    },
    { key: "child.spawn", label: "子 Agent", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex native collaboration 可创建子 Agent。" },
    { key: "child.result", label: "子 Agent 结果", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex 可返回子 Agent 结果。" },
    { key: "structured-output", label: "结构化输出", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "Codex app-server 支持 output schema。" },
    { key: "workspace.read", label: "工作区读取", spec: "supported", runtime: safeExecReady ? "ready" : "unavailable", summary: "Codex 可读取分配工作区。" },
    { key: "workspace.multiroot", label: "多根工作区", spec: "supported", runtime: safeExecReady ? "ready" : "unavailable", summary: "Codex 可接收项目和外部记忆根。" },
    { key: "workspace.full-access", label: "完全访问", spec: "supported", runtime: appServerReady ? "ready" : "unavailable", summary: "可在用户明确选择后使用完全访问。" },
    { key: "tool.web", label: "网络工具", spec: "supported", runtime: cliReady ? "ready" : "unavailable", summary: "网络工具由Codex运行能力和AHO策略共同约束。" },
  );

  const capabilities = items.map(toCapabilityItem);
  const readiness = resolveCodexModeReadiness(capabilities, productMode, cli.available, safeExecReady);
  const degradedReasons = readiness.relevantCapabilities
    .filter((item) => item.runtime !== "ready")
    .map((item) => item.reason ?? item.summary);
  degradedReasons.push(...readiness.missingCapabilityKeys.map((key) => `Provider capability is missing: ${key}.`));
  const effectiveModelSource: ProviderCapabilitySnapshot["effectiveModelSource"] = models.effectiveModelSource === "codex-default"
    ? "provider-default"
    : models.effectiveModelSource;
  const base: Omit<ProviderCapabilitySnapshot, "snapshotHash"> = {
    providerId: "codex" as const,
    displayName: "Codex",
    productMode,
    status: readiness.status,
    runnable: readiness.runnable,
    checkedAt: new Date().toISOString(),
    snapshotVersion: PROVIDER_CAPABILITY_SNAPSHOT_VERSION,
    effectiveModel: models.effectiveModel,
    effectiveModelSource,
    degradedReasons,
    capabilities,
  };
  return {
    ...base,
    snapshotHash: stableCapabilitySnapshotHash(base),
  };
}

export function resolveCodexModeReadiness(
  capabilities: readonly ProviderCapabilityItem[],
  productMode: ProductMode,
  cliAvailable: boolean,
  harnessSafeExecReady: boolean,
): {
  status: ProviderSnapshotStatus;
  runnable: boolean;
  relevantCapabilities: ProviderCapabilityItem[];
  missingCapabilityKeys: ProviderCapabilityKey[];
} {
  if (productMode === "harness") {
    return {
      status: snapshotStatus(capabilities, cliAvailable),
      runnable: cliAvailable && harnessSafeExecReady,
      relevantCapabilities: [...capabilities],
      missingCapabilityKeys: [],
    };
  }

  const requiredKeys = PROVIDER_OPERATION_CAPABILITIES.agent;
  const capabilityByKey = new Map(capabilities.map((item) => [item.key, item]));
  const relevantCapabilities = requiredKeys.flatMap((key) => {
    const capability = capabilityByKey.get(key);
    return capability ? [capability] : [];
  });
  const missingCapabilityKeys = requiredKeys.filter((key) => !capabilityByKey.has(key));
  const runnable = missingCapabilityKeys.length === 0
    && relevantCapabilities.every((item) => item.runtime === "ready");
  return {
    status: !cliAvailable
      ? "unavailable"
      : runnable
        ? "ready"
        : "degraded",
    runnable,
    relevantCapabilities,
    missingCapabilityKeys,
  };
}

function toCapabilityItem(input: CapabilityInput): ProviderCapabilityItem {
  return {
    key: input.key,
    label: input.label,
    spec: input.spec,
    runtime: input.runtime,
    summary: input.summary,
    reason: input.reason,
  };
}

function snapshotStatus(capabilities: readonly ProviderCapabilityItem[], cliAvailable: boolean): ProviderSnapshotStatus {
  if (!cliAvailable) return "unavailable";
  if (capabilities.some((item) => item.runtime === "unavailable" || item.runtime === "degraded")) return "degraded";
  return "ready";
}

function firstReason(errors: string[]): string | undefined {
  return errors[0];
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
