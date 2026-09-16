import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import { extractInlineFileMentions } from "../shell/file-mentions.js";
import { extractInlineSkillMentions } from "../shell/skill-mentions.js";
import type {
  AgentTurnMode,
  ConversationTurnQueueSnapshot,
  ProductMode,
  ProviderCapabilitySnapshot,
  ProviderModelCatalogGroup,
  ProviderModelSettingsSnapshot,
  SkillListItem,
  TopicAttachment,
  TopicFileReference,
  WorkbenchLiveEvent,
} from "../types.js";
import type { ComposerDraftApi, ComposerDraftContent } from "./ComposerDraftSyncOwner.js";
import type {
  ComposerAttachmentUpload,
  ComposerCreateConversationRequest,
  ComposerCreatedConversation,
  ComposerMessageRequest,
  ComposerSkillOverride,
} from "./conversation-submission-contract.js";
import type { ConversationTurnQueueEnqueueInput } from "./conversation-turn-queue-contract.js";

export interface WorkbenchOperationToken {
  id: number;
  key: string;
}

export type ConversationSteerOutcome =
  | { status: "accepted" }
  | { status: "already-terminal" };

export type ComposerTransition = "project-changed" | "conversation-changed" | "new-conversation";

export interface ConversationComposerScope {
  projectId: string | null;
  productMode?: ProductMode;
  conversation: {
    id: string;
    state: string;
    productMode?: ProductMode;
    agentTurnMode?: AgentTurnMode | null;
    agentModelId?: string | null;
    agentReasoningEffort?: string | null;
    selectedProviderId?: string;
  } | null;
  projectRegistered: boolean;
  running: boolean;
  runControlState?: {
    state?: "idle" | "running" | "stopping";
    canStop: boolean;
    canSteer?: boolean;
    steerState?: "idle" | "submitting";
    providerId?: string;
    attemptId?: string;
  };
  selectedProviderId: string | null;
  providerCount: number;
  providerCapabilities?: ProviderCapabilitySnapshot[];
  providerCapabilitiesLoading?: boolean;
  providerCapabilitiesError?: string | null;
  providerModelSettings?: ProviderModelSettingsSnapshot | null;
  providerModelCatalogs?: ProviderModelCatalogGroup[];
}

export interface PreparedComposerInput {
  text: string;
  contextRefs: TopicFileReference[];
  skillOverrides: Record<string, boolean>;
}

export interface SkillRequestIdentity {
  projectId: string;
  productMode: ProductMode;
  conversationId: string | null;
  providerId: string | null;
}

export interface ComposerActionRequest {
  projectId: string;
  conversationId: string;
  productMode: ProductMode;
  providerId?: string;
  expectedAttemptId?: string;
  clientRequestId?: string;
  prompt?: string;
}

export interface ConversationComposerPorts {
  operation: {
    begin(key: string): WorkbenchOperationToken;
    release(token: WorkbenchOperationToken): void;
  };
  session: {
    ensureProjectRegistered(projectId: string): Promise<string | null>;
    createConversation(request: ComposerCreateConversationRequest): Promise<ComposerCreatedConversation>;
    beginPendingConversation?(input: {
      id: string;
      projectId: string;
      productMode: ProductMode;
      clientRequestId: string;
      title: string;
      body: string;
      selectedProviderId?: string;
    }): void;
    restoreDraftProvider?(providerId: string | null): void;
    selectProvider?(providerId: string): void | Promise<void>;
  };
  actions: {
    sendMessage?(request: ComposerMessageRequest): Promise<void>;
    steer(request: ComposerActionRequest): Promise<ConversationSteerOutcome>;
    stop(request: ComposerActionRequest): Promise<void>;
  };
  projection: {
    refreshConversation(projectId: string, conversationId: string): Promise<void>;
    routeEvent?(projectId: string, event: WorkbenchLiveEvent): void;
  };
  timeline: {
    calibrate(projectId: string, conversationId: string, agentSurfaceId: "main-agent"): Promise<void>;
    showPending?(scope: { projectId: string; productMode: ProductMode; conversationId: string }, clientRequestId: string, text: string): void;
    markPending?(scope: { projectId: string; productMode: ProductMode; conversationId: string }, clientRequestId: string, state: "sending" | "uncertain" | "failed", failure?: string): void;
    consumePending?(scope: { projectId: string; productMode: ProductMode; conversationId: string }, clientRequestId: string): void;
    rekeyPending?(from: { projectId: string; productMode: ProductMode; conversationId: string }, to: { projectId: string; productMode: ProductMode; conversationId: string }, clientRequestId: string): void;
  };
  skills?: {
    load(identity: SkillRequestIdentity): Promise<SkillListItem[]>;
    setEnabled(identity: SkillRequestIdentity, skillId: string, enabled: boolean): Promise<void>;
  };
  attachments?: {
    upload(projectId: string, upload: ComposerAttachmentUpload): Promise<TopicAttachment>;
    remove(projectId: string, attachmentId: string): Promise<void>;
  };
  drafts?: ComposerDraftApi;
  queue?: {
    snapshot: ConversationTurnQueueSnapshot | null;
    loading: boolean;
    enqueue(input: ConversationTurnQueueEnqueueInput): Promise<ConversationTurnQueueSnapshot | null>;
    reclaim(queueItemId: string, expectedDraftUpdatedAt: string | null): Promise<ConversationTurnQueueSnapshot | null>;
  };
  ids?: { createClientRequestId(): string };
  onError(message: string | null): void;
}

export interface CreateConversationComposerInput {
  body?: string;
  fileRefs?: TopicFileReference[];
  attachmentIds?: string[];
  attachmentFiles?: File[];
}

export interface CurrentValueRef<T> {
  readonly current: T;
}

export interface ConversationDraftLifecyclePorts {
  readonly drafts?: Readonly<ComposerDraftApi>;
  readonly session: Readonly<{
    restoreDraftProvider?(providerId: string | null): void;
    selectProvider?(providerId: string): void | Promise<void>;
  }>;
  readonly onError: ConversationComposerPorts["onError"];
}

export interface ConversationComposerResourcePorts {
  readonly skills?: Readonly<{
    load(identity: SkillRequestIdentity): Promise<SkillListItem[]>;
    setEnabled(identity: SkillRequestIdentity, skillId: string, enabled: boolean): Promise<void>;
  }>;
  readonly attachments?: Readonly<{
    upload(projectId: string, upload: ComposerAttachmentUpload): Promise<TopicAttachment>;
    remove(projectId: string, attachmentId: string): Promise<void>;
  }>;
  readonly onError: ConversationComposerPorts["onError"];
}

export interface ConversationSubmissionCoordinatorPorts {
  readonly operation: Readonly<ConversationComposerPorts["operation"]>;
  readonly ids?: Readonly<NonNullable<ConversationComposerPorts["ids"]>>;
  readonly session: Readonly<{
    ensureProjectRegistered(projectId: string): Promise<string | null>;
    createConversation(request: ComposerCreateConversationRequest): Promise<ComposerCreatedConversation>;
    beginPendingConversation?: NonNullable<ConversationComposerPorts["session"]["beginPendingConversation"]>;
  }>;
  readonly actions: Readonly<{
    sendMessage?: NonNullable<ConversationComposerPorts["actions"]["sendMessage"]>;
  }>;
  readonly timeline: Readonly<ConversationComposerPorts["timeline"]>;
  readonly projection: Readonly<ConversationComposerPorts["projection"]>;
  readonly attachments?: Readonly<NonNullable<ConversationComposerPorts["attachments"]>>;
  readonly onError: ConversationComposerPorts["onError"];
}

export interface ConversationExecutionActionPorts {
  readonly operation: Readonly<ConversationComposerPorts["operation"]>;
  readonly ids?: Readonly<NonNullable<ConversationComposerPorts["ids"]>>;
  readonly actions: Readonly<{
    steer(request: ComposerActionRequest): Promise<ConversationSteerOutcome>;
    stop(request: ComposerActionRequest): Promise<void>;
  }>;
  readonly timeline: Readonly<{
    calibrate(projectId: string, conversationId: string, agentSurfaceId: "main-agent"): Promise<void>;
  }>;
  readonly queue?: Readonly<{
    snapshot: DeepReadonly<ConversationTurnQueueSnapshot> | null;
    loading: boolean;
    enqueue(input: ConversationTurnQueueEnqueueInput): Promise<DeepReadonly<ConversationTurnQueueSnapshot> | null>;
    reclaim(queueItemId: string, expectedDraftUpdatedAt: string | null): Promise<DeepReadonly<ConversationTurnQueueSnapshot> | null>;
  }>;
  readonly onError: ConversationComposerPorts["onError"];
}

export type DeepReadonly<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: TArgs) => TResult
  : T extends readonly (infer TItem)[]
    ? readonly DeepReadonly<TItem>[]
    : T extends object
      ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
      : T;

export function prepareComposerInput(input: {
  body: string;
  selectedRefs: TopicFileReference[];
  skills: SkillListItem[];
  conversationId: string | null;
  draftSkillOverrides: Record<string, boolean>;
}): PreparedComposerInput {
  const fileExtraction = extractInlineFileMentions(input.body, input.selectedRefs);
  const skillExtraction = extractInlineSkillMentions(fileExtraction.cleanedText, input.skills);
  const skillOverrides = input.conversationId ? {} : { ...input.draftSkillOverrides };
  for (const skillId of skillExtraction.skillIds) skillOverrides[skillId] = true;
  return {
    text: skillExtraction.cleanedText.trim(),
    contextRefs: normalizeComposerRefs(fileExtraction.refs),
    skillOverrides,
  };
}

export function activeComposerSkillIds(
  skills: SkillListItem[],
  conversationId: string | null,
  draftOverrides: Record<string, boolean>,
): string[] {
  return skills
    .filter((skill) => {
      if (!skill.providerEnabled || skill.required || skill.runtimeAssigned) return false;
      if (conversationId) {
        if (skill.disabledTopics.includes(conversationId)) return false;
        return skill.enabledProject || skill.enabledTopics.includes(conversationId);
      }
      return draftOverrides[skill.skillId] ?? skill.enabledProject;
    })
    .map((skill) => skill.skillId);
}

export function normalizeComposerRefs(refs: TopicFileReference[]): TopicFileReference[] {
  const seen = new Set<string>();
  const result: TopicFileReference[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...ref, source: "composer" });
  }
  return result;
}

export function normalizeSkillOverrideRecord(overrides: Record<string, boolean>): ComposerSkillOverride[] {
  return Object.entries(overrides)
    .map(([skillId, enabled]) => ({ skillId: skillId.trim(), enabled }))
    .filter((override) => override.skillId.length > 0)
    .sort((left, right) => left.skillId.localeCompare(right.skillId));
}

export function defaultAttachmentPrompt(count: number): string {
  return count === 1
    ? "请先查看我附上的文件，然后根据附件内容继续。"
    : "请先查看我附上的文件，然后根据这些附件内容继续。";
}

export function skillRequestIdentity(scope: ConversationComposerScope): SkillRequestIdentity {
  return {
    projectId: scope.projectId ?? "",
    productMode: composerProductMode(scope),
    conversationId: scope.conversation?.id ?? null,
    providerId: scope.conversation?.selectedProviderId ?? scope.selectedProviderId,
  };
}

export function skillRequestIdentityKey(identity: SkillRequestIdentity): string {
  return [identity.projectId, identity.productMode, identity.conversationId ?? "", identity.providerId ?? ""].join("\0");
}

export function skillRequestSearchParams(identity: SkillRequestIdentity): URLSearchParams {
  const params = new URLSearchParams({ productMode: identity.productMode });
  if (identity.conversationId) params.set("conversationId", identity.conversationId);
  if (identity.providerId) params.set("providerId", identity.providerId);
  return params;
}

export function composerProductMode(scope: ConversationComposerScope): ProductMode {
  return scope.productMode ?? scope.conversation?.productMode ?? "harness";
}

export function composerScopeIdentity(scope: ConversationComposerScope): string {
  return skillRequestIdentityKey(skillRequestIdentity(scope));
}

export function composerStopIdentity(scope: ConversationComposerScope): string {
  return [
    composerScopeIdentity(scope),
    scope.runControlState?.providerId ?? "",
    scope.runControlState?.attemptId ?? "",
  ].join("\0");
}

export function draftScopeIdentity(projectId: string | null, productMode: ProductMode): string {
  return `${projectId ?? ""}\0${productMode}`;
}

export function parseDraftScopeIdentity(identity: string): [string, ProductMode] {
  const [projectId = "", productMode = "harness"] = identity.split("\0");
  return [projectId, productMode === "agent" ? "agent" : "harness"];
}

export function initialAgentTurnMode(scope: ConversationComposerScope): AgentTurnMode {
  return composerProductMode(scope) === "agent"
    ? scope.conversation?.agentTurnMode ?? "default"
    : "default";
}

export function initialAgentModelId(scope: ConversationComposerScope): string | null {
  return composerProductMode(scope) === "agent" ? scope.conversation?.agentModelId ?? null : null;
}

export function initialAgentReasoningEffort(scope: ConversationComposerScope): string | null {
  return composerProductMode(scope) === "agent" ? scope.conversation?.agentReasoningEffort ?? null : null;
}

export function resolveAgentTurnModeDisabledReason(
  scope: ConversationComposerScope,
  agentTurnMode: AgentTurnMode,
): string | null {
  if (composerProductMode(scope) !== "agent" || agentTurnMode === "default" || scope.running) return null;
  if (scope.providerCapabilitiesLoading) return "正在检查当前 Agent 是否支持计划模式。";
  if (scope.providerCapabilitiesError) return "暂时无法确认计划模式是否可用，请刷新后重试。";
  const providerId = effectiveComposerProviderId(scope);
  if (!providerId) return "请先选择支持计划模式的 Agent。";
  const snapshot = scope.providerCapabilities?.find((candidate) => candidate.providerId === providerId);
  const plan = snapshot?.capabilities.find((capability) => capability.key === "turn.plan");
  if (!snapshot || plan?.runtime !== "ready") return plan?.reason ?? "当前 Agent 不支持计划模式。";
  return null;
}

export function resolveAgentTurnModelDisabledReason(
  scope: ConversationComposerScope,
  agentTurnMode: AgentTurnMode,
  modelId: string | null,
  reasoningEffort: string | null,
): string | null {
  if (composerProductMode(scope) !== "agent" || scope.running) return null;
  const providerId = effectiveComposerProviderId(scope);
  if (!providerId) return agentTurnMode === "plan" || modelId || reasoningEffort
    ? "请先选择本次 Turn 使用的 Agent。"
    : null;
  const snapshot = scope.providerModelSettings;
  if (!snapshot || snapshot.providerId !== providerId) return "正在读取当前 Agent 的模型目录。";
  const candidate = resolveSelectedModelCandidate(snapshot, modelId);
  if (modelId && !candidate) return "已选择的模型当前不可用，请重新选择后再发送。";
  const resolvedModelId = modelId ?? snapshot.effectiveModel?.modelId ?? null;
  if (agentTurnMode === "plan" && !resolvedModelId) return "计划模式需要先选择可用模型。";
  if (reasoningEffort) {
    if (!candidate) return "显式推理强度需要先解析出可验证的模型。";
    if (candidate.supportedReasoningEfforts.length === 0) return "当前模型没有可验证的推理强度选项，请使用模型默认值。";
    if (!candidate.supportedReasoningEfforts.some((option) => option.value === reasoningEffort)) {
      return "已选择的推理强度不再受当前模型支持，请重新选择。";
    }
  }
  return null;
}

export function resolveSelectedModelCandidate(
  snapshot: ProviderModelSettingsSnapshot | null | undefined,
  modelId: string | null,
): ProviderModelSettingsSnapshot["candidates"][number] | null {
  if (!snapshot) return null;
  const resolved = modelId ?? snapshot.effectiveModel?.modelId ?? null;
  if (!resolved) return null;
  return snapshot.candidates.find((candidate) => candidate.modelId.toLowerCase() === resolved.toLowerCase()) ?? null;
}

export function normalizeNullableSelection(value: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveDraftProviderDisabledReason(scope: ConversationComposerScope): string | null {
  const providerId = effectiveComposerProviderId(scope);
  if (!providerId || scope.providerCapabilitiesLoading || scope.running) return null;
  if (scope.providerCapabilitiesError) return `无法确认已选择的 Agent：${scope.providerCapabilitiesError}`;
  if (!scope.providerCapabilities) return null;
  if (!scope.providerCapabilities.some((candidate) => candidate.providerId === providerId)) {
    return "已保存的 Agent 当前不可用，请重新选择后再发送。";
  }
  return null;
}

export function resolveAttachmentCapabilityDisabledReason(
  scope: ConversationComposerScope,
  attachments: readonly Pick<TopicAttachment, "kind">[],
): string | null {
  if (composerProductMode(scope) !== "agent" || attachments.length === 0 || scope.running) return null;
  if (scope.providerCapabilitiesLoading) return "正在检查当前 Agent 是否支持附件输入。";
  if (scope.providerCapabilitiesError) return "暂时无法确认附件是否可用，请刷新后重试。";
  const providerId = effectiveComposerProviderId(scope);
  if (!providerId) return "请先选择支持附件输入的 Agent。";
  const snapshot = scope.providerCapabilities?.find((candidate) => candidate.providerId === providerId);
  if (!snapshot) return "无法确认当前 Agent 的附件能力。";
  const readiness = new Map(snapshot.capabilities.map((capability) => [capability.key, capability]));
  if (attachments.some((attachment) => attachment.kind === "image") && readiness.get("image.input")?.runtime !== "ready") {
    return readiness.get("image.input")?.reason ?? "当前 Agent 不支持图片输入。";
  }
  if (attachments.some((attachment) => attachment.kind === "text") && readiness.get("file.reference")?.runtime !== "ready") {
    return readiness.get("file.reference")?.reason ?? "当前 Agent 不支持文件引用。";
  }
  return null;
}

export function topicAttachmentCapabilityProbe(file: File): Pick<TopicAttachment, "kind"> {
  return { kind: file.type.startsWith("image/") ? "image" : "text" };
}

export function effectiveComposerProviderId(scope: ConversationComposerScope): string | null {
  return scope.selectedProviderId
    ?? scope.conversation?.selectedProviderId
    ?? (scope.providerCount === 1 ? scope.providerCapabilities?.[0]?.providerId ?? null : null);
}

export function workbenchEventMatchesConversation(
  event: WorkbenchLiveEvent,
  expected: Pick<ComposerMessageRequest, "projectId" | "productMode" | "conversationId">,
): boolean {
  const data = event.data as Record<string, unknown>;
  const nestedConversation = data.conversation && typeof data.conversation === "object"
    ? data.conversation as Record<string, unknown>
    : null;
  const center = data.center && typeof data.center === "object" ? data.center as Record<string, unknown> : null;
  const selectedTopic = center?.selectedTopic && typeof center.selectedTopic === "object"
    ? center.selectedTopic as Record<string, unknown>
    : null;
  const projectId = typeof data.projectId === "string" ? data.projectId : expected.projectId;
  const productMode = data.productMode === "agent" || data.productMode === "harness" ? data.productMode : undefined;
  const effectiveProductMode = productMode
    ?? (nestedConversation?.productMode === "agent" || nestedConversation?.productMode === "harness"
      ? nestedConversation.productMode
      : selectedTopic?.productMode === "agent" || selectedTopic?.productMode === "harness"
        ? selectedTopic.productMode
        : undefined);
  const conversationId = typeof data.conversationId === "string"
    ? data.conversationId
    : typeof nestedConversation?.id === "string"
      ? nestedConversation.id
      : typeof selectedTopic?.id === "string"
        ? selectedTopic.id
        : undefined;
  return projectId === expected.projectId
    && effectiveProductMode === expected.productMode
    && conversationId === expected.conversationId;
}

export function composerRequestOwnsCurrentScope(
  generation: number,
  projectIds: readonly string[],
  productMode: ProductMode,
  providerId: string | null,
  generationRef: { current: number },
  currentScopeRef: { current: ConversationComposerScope },
  committedConversationId?: string,
): boolean {
  const currentScope = currentScopeRef.current;
  const committedSingleProviderDefault = providerId === null
    && Boolean(committedConversationId)
    && currentScope.conversation?.id === committedConversationId
    && currentScope.providerCount === 1;
  return (generation === generationRef.current
      || Boolean(committedConversationId && currentScope.conversation?.id === committedConversationId))
    && currentScope.projectId !== null
    && projectIds.includes(currentScope.projectId)
    && composerProductMode(currentScope) === productMode
    && (effectiveComposerProviderId(currentScope) === providerId || committedSingleProviderDefault);
}

export function composerActionOwnsCurrentScope(
  generation: number,
  actionScope: ConversationComposerScope,
  generationRef: { current: number },
  currentScopeRef: { current: ConversationComposerScope },
): boolean {
  return generation === generationRef.current
    && composerScopeIdentity(actionScope) === composerScopeIdentity(currentScopeRef.current);
}

export const defaultComposerIds = {
  createClientRequestId(): string {
    return globalThis.crypto?.randomUUID?.()
      ?? `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  },
};

export function mergeTopicAttachments(current: TopicAttachment[], next: TopicAttachment[]): TopicAttachment[] {
  const seen = new Set(current.map((attachment) => attachment.id));
  return [...current, ...next.filter((attachment) => {
    if (seen.has(attachment.id)) return false;
    seen.add(attachment.id);
    return true;
  })];
}

export function composerErrorMessage(cause: unknown): string {
  return userFacingErrorMessage(cause, "send");
}

export function composerDraftContent(input: {
  projectId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  text: string;
  contextRefs: TopicFileReference[];
  attachments: TopicAttachment[];
  skillOverrides: Record<string, boolean>;
  selectedProviderId: string | null;
}): ComposerDraftContent {
  return {
    projectId: input.projectId,
    productMode: input.productMode,
    agentTurnMode: input.productMode === "agent" ? input.agentTurnMode : null,
    agentModelId: input.productMode === "agent" ? input.agentModelId : null,
    agentReasoningEffort: input.productMode === "agent" ? input.agentReasoningEffort : null,
    text: input.text,
    contextRefs: normalizeComposerRefs(input.contextRefs),
    attachmentIds: [...new Set(input.attachments.map((attachment) => attachment.id))],
    skillOverrides: Object.fromEntries(
      Object.entries(input.skillOverrides).sort(([left], [right]) => left.localeCompare(right)),
    ),
    selectedProviderId: input.selectedProviderId,
  };
}
