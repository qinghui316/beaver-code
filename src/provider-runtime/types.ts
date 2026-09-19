export type ProviderId = string;
export type ProductMode = "agent" | "harness";
export type AgentTurnMode = "default" | "plan";
export type HarnessExecutionMode = "stepwise" | "scoped-auto";

export type ProviderCapabilityKey =
  | "turn.start"
  | "turn.resume"
  | "turn.interrupt"
  | "turn.steer"
  | "turn.user-input"
  | "turn.approval"
  | "turn.plan"
  | "turn.review"
  | "stream.text"
  | "stream.reasoning-summary"
  | "stream.tool-output"
  | "child.spawn"
  | "child.result"
  | "structured-output"
  | "workspace.read"
  | "workspace.write"
  | "workspace.full-access"
  | "workspace.multiroot"
  | "skill.native-load"
  | "tool.dynamic"
  | "tool.mcp"
  | "tool.web"
  | "image.input"
  | "file.reference"
  | "session.continuation"
  | "model.list"
  | "reasoning.effort"
  | "context.usage"
  | "context.compact"
  | "session.fork"
  | "session.archive";

export type ProviderOperationProfile =
  | "agent"
  | "main"
  | "planning"
  | "coder"
  | "auditor"
  | "evolution"
  | "evolution-scorer";

export type ProviderSpecCapabilityState = "supported" | "compat-input" | "unsupported" | "unknown";
export type ProviderRuntimeReadiness = "ready" | "degraded" | "unavailable";
export type ProviderSnapshotStatus = "ready" | "degraded" | "unavailable";

export interface ProviderCapabilityItem {
  key: ProviderCapabilityKey;
  label: string;
  spec: ProviderSpecCapabilityState;
  runtime: ProviderRuntimeReadiness;
  summary: string;
  reason?: string;
}

export interface ProviderModelRef {
  providerId: ProviderId;
  modelId: string;
}

export interface ProviderReasoningEffortOption {
  value: string;
  label: string;
  description?: string;
}

export interface ProviderModelCandidate {
  providerId: ProviderId;
  modelId: string;
  label: string;
  source: string;
  isDefault?: boolean;
  supportedReasoningEfforts: ProviderReasoningEffortOption[];
  defaultReasoningEffort: string | null;
}

export interface ProviderModelSettingsSnapshot {
  providerId: ProviderId;
  selectedModel: ProviderModelRef | null;
  effectiveModel: ProviderModelRef | null;
  effectiveModelSource: "selected" | "config" | "provider-default";
  candidates: ProviderModelCandidate[];
  available: boolean;
  degradedReason?: string;
}

export interface ProviderDiagnosticsSnapshot {
  providerId: ProviderId;
  displayName: string;
  installation: { available: boolean; version: string | null; path?: string };
  adapter: { id: string; version: string };
  capabilities: ProviderCapabilitySnapshot;
  models: ProviderModelSettingsSnapshot;
  sessionHealth: "ready" | "degraded" | "unavailable";
  lastError: string | null;
  rawEvidenceRefs: string[];
  projectActions: ProviderProjectAction[];
  details?: Record<string, unknown>;
}

export interface ProviderProjectAction {
  id: string;
  label: string;
  status: "available" | "completed" | "blocked";
  requiresConfirmation: boolean;
  reason?: string;
}

export interface ProviderCapabilitySnapshot {
  providerId: ProviderId;
  displayName: string;
  productMode: ProductMode;
  status: ProviderSnapshotStatus;
  runnable: boolean;
  checkedAt: string;
  snapshotHash: string;
  snapshotVersion: number;
  effectiveModel: string | null;
  effectiveModelSource: "selected" | "config" | "provider-default";
  degradedReasons: string[];
  capabilities: ProviderCapabilityItem[];
}

export interface ProviderRuntimeSummary {
  providerId: ProviderId;
  productMode: ProductMode;
  harnessExecutionModes: HarnessExecutionMode[];
  snapshot: ProviderCapabilitySnapshot;
}

export const PROVIDER_OPERATION_CAPABILITIES: Readonly<Record<ProviderOperationProfile, readonly ProviderCapabilityKey[]>> = {
  agent: ["turn.start", "turn.resume", "turn.interrupt", "turn.user-input", "stream.text", "stream.tool-output", "workspace.read", "workspace.write", "skill.native-load", "session.continuation"],
  main: ["turn.start", "turn.resume", "turn.interrupt", "turn.user-input", "stream.text", "stream.reasoning-summary", "child.spawn", "child.result", "workspace.read", "workspace.write", "workspace.multiroot", "skill.native-load", "tool.dynamic", "session.continuation"],
  planning: ["turn.start", "turn.interrupt", "turn.user-input", "stream.text", "child.result", "workspace.read", "workspace.write", "workspace.multiroot", "skill.native-load"],
  coder: ["turn.start", "turn.interrupt", "stream.text", "stream.tool-output", "workspace.read", "workspace.write", "workspace.multiroot"],
  auditor: ["turn.start", "turn.interrupt", "stream.text", "structured-output", "workspace.read", "workspace.multiroot"],
  evolution: ["turn.start", "turn.resume", "turn.interrupt", "stream.text", "child.spawn", "child.result", "workspace.read", "workspace.write", "workspace.multiroot", "skill.native-load", "session.continuation"],
  "evolution-scorer": ["turn.start", "turn.interrupt", "stream.text", "structured-output", "workspace.read", "workspace.multiroot"],
};

export function missingProviderCapabilities(
  snapshot: ProviderCapabilitySnapshot,
  profile: ProviderOperationProfile,
): ProviderCapabilityKey[] {
  const runtimeByKey = new Map(snapshot.capabilities.map((item) => [item.key, item.runtime]));
  return PROVIDER_OPERATION_CAPABILITIES[profile].filter((key) => runtimeByKey.get(key) !== "ready");
}
