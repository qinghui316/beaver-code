import type { ProviderSkillInput } from "../../project-harness/contracts.js";
import { parseAgentAccessMode, parseAgentAccessPolicy } from "../../provider-runtime/agent-access-policy.js";
import {
  assertAgentTurnMode,
  assertProductMode,
  EXECUTION_CONTRACT_FAMILIES,
  legacyExecutionContract,
  storedExecutionContract,
  validateExecutionContractIdentity,
  type ExecutionContractFamily,
  type ProviderCapabilitySnapshot,
  type ProviderModelRef,
  type StoredExecutionContractIdentity,
} from "../../provider-runtime/index.js";
import type { StoredConversation, StoredConversationProviderBinding, StoredDecisionRecord, StoredDecisionStatus, StoredProviderAttempt, StoredProviderResumePoint, StoredProviderThreadLink, StoredSkillEnablement, StoredSkillRoot, StoredTopicMessage } from "./contracts.js";

export interface SqliteRow { [key: string]: unknown; }

export function mapMessageRow(row: SqliteRow): StoredTopicMessage {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    conversationId: String(row.conversationId),
    changeId: String(row.changeId),
    position: Number(row.position),
    revision: Number(row.revision),
    agentSurfaceId: String(row.agentSurfaceId),
    initialThreadInput: Number(row.initialThreadInput) === 1,
    type: String(row.type),
    timestamp: String(row.timestamp),
    text: nullableString(row.text),
    actionRunId: nullableString(row.actionRunId),
    actionType: nullableString(row.actionType),
    status: nullableString(row.status),
    runId: nullableString(row.runId),
    providerId: nullableString(row.providerId),
    threadId: nullableString(row.threadId),
    turnId: nullableString(row.turnId),
    itemId: nullableString(row.itemId),
    artifact: nullableString(row.artifact),
    error: nullableString(row.error),
    rawJson: String(row.rawJson),
  };
}

export function mapConversationRow(row: SqliteRow): StoredConversation {
  return {
    agentAccessMode: row.productMode === "agent" ? parseAgentAccessMode(row.agentAccessMode) : null,
    agentAccessRevision: Number(row.agentAccessRevision ?? 0),
    projectId: String(row.projectId),
    conversationId: String(row.conversationId),
    productMode: assertProductMode(row.productMode, "Stored Conversation productMode"),
    agentTurnMode: row.agentTurnMode === null || row.agentTurnMode === undefined
      ? null
      : assertAgentTurnMode(row.agentTurnMode, "Stored Conversation agentTurnMode"),
    agentModelId: nullableString(row.agentModelId),
    agentReasoningEffort: nullableString(row.agentReasoningEffort),
    clientCreateRequestId: nullableString(row.clientCreateRequestId),
    clientCreateRequestHash: nullableString(row.clientCreateRequestHash),
    title: String(row.title),
    state: row.state === "archive" ? "archive" : "active",
    archiveOrigin: row.archiveOrigin === "agent-user" || row.archiveOrigin === "harness-workflow"
      ? row.archiveOrigin
      : null,
    archivedAt: nullableString(row.archivedAt),
    lifecycleRevision: Number(row.lifecycleRevision ?? 0),
    surfaceKind: row.surfaceKind === "runtime" ? "runtime" : "user",
    boundChangeId: nullableString(row.boundChangeId),
    currentGraphScopeId: nullableString(row.currentGraphScopeId),
    selectedProviderId: String(row.selectedProviderId),
    completedTurnSequence: Number(row.completedTurnSequence),
    timelinePosition: Number(row.timelinePosition),
    timelineRevision: Number(row.timelineRevision),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    deletedAt: nullableString(row.deletedAt),
  };
}

export function timelineMessageSelect(): string {
  return `SELECT id, project_id AS projectId, conversation_id AS conversationId, change_id AS changeId,
    position, revision, agent_surface_id AS agentSurfaceId, initial_thread_input AS initialThreadInput, type, timestamp, text,
    action_run_id AS actionRunId, action_type AS actionType, status, run_id AS runId,
    provider_id AS providerId, thread_id AS threadId, turn_id AS turnId, item_id AS itemId,
    artifact, error, raw_json AS rawJson
    FROM canonical_timeline_items`;
}

export function timelineThreadStartPredicate(): string {
  return "initial_thread_input = 1";
}

export function timelineSequencePredicate(): string {
  return `NOT (${timelineThreadStartPredicate()})`;
}

export function mapProviderThreadRow(row: SqliteRow): StoredProviderThreadLink {
  return {
    projectId: String(row.projectId),
    conversationId: String(row.conversationId),
    attemptId: String(row.attemptId),
    providerId: String(row.providerId),
    providerThreadId: String(row.providerThreadId),
    roleId: String(row.roleId),
    parentThreadId: nullableString(row.parentThreadId),
    parentAgentSurfaceId: nullableString(row.parentAgentSurfaceId),
    changeId: nullableString(row.changeId),
    graphScopeId: nullableString(row.graphScopeId),
    capabilityProfile: nullableString(row.capabilityProfile),
    displayName: nullableString(row.displayName),
    runId: nullableString(row.runId),
    updatedAt: String(row.updatedAt),
  };
}

export function mapConversationProviderBindingRow(row: SqliteRow): StoredConversationProviderBinding {
  return {
    projectId: String(row.projectId),
    conversationId: String(row.conversationId),
    providerId: String(row.providerId),
    nativeSessionId: nullableString(row.nativeSessionId),
    lastDeliveredCompletedTurn: Number(row.lastDeliveredCompletedTurn),
    preferredModel: parseJsonObject<ProviderModelRef>(row.preferredModelJson),
    lastUsedAt: nullableString(row.lastUsedAt),
    bindingStatus: row.bindingStatus === "unavailable" ? "unavailable" : row.bindingStatus === "stale" ? "stale" : "ready",
  };
}

export function mapProviderAttemptRow(row: SqliteRow): StoredProviderAttempt {
  const capabilitySnapshot = parseJsonObject<ProviderCapabilitySnapshot>(row.capabilitySnapshotJson);
  if (!capabilitySnapshot) throw new Error(`Provider attempt has invalid capability snapshot: ${String(row.attemptId)}`);
  const effectiveSkillInputs = parseJsonArray<ProviderSkillInput>(row.effectiveSkillInputsJson);
  if (!effectiveSkillInputs) throw new Error(`Provider attempt has invalid effective Skill inputs: ${String(row.attemptId)}`);
  const status = String(row.status);
  const executionContract = mapStoredExecutionContract(row);
  return {
    projectId: String(row.projectId),
    conversationId: nullableString(row.conversationId),
    attemptId: String(row.attemptId),
    productMode: assertProductMode(row.productMode, "Stored ProviderAttempt productMode"),
    agentTurnMode: row.agentTurnMode === null || row.agentTurnMode === undefined
      ? null
      : assertAgentTurnMode(row.agentTurnMode, "Stored ProviderAttempt agentTurnMode"),
    graphScopeId: nullableString(row.graphScopeId),
    changeId: nullableString(row.changeId),
    agentTaskId: nullableString(row.agentTaskId),
    roleId: String(row.roleId),
    parentAgentSurfaceId: nullableString(row.parentAgentSurfaceId),
    operationProfile: String(row.operationProfile),
    operationKind: row.operationKind === "review" ? "review" : "conversation-turn",
    executionContract,
    accessPolicy: parseAgentAccessPolicy(row.accessPolicyJson == null ? null : JSON.parse(String(row.accessPolicyJson))),
    providerId: String(row.providerId),
    nativeSessionId: nullableString(row.nativeSessionId),
    model: parseJsonObject<ProviderModelRef>(row.modelJson),
    reasoningEffort: nullableString(row.reasoningEffort),
    capabilitySnapshot,
    effectiveSkillInputs,
    handoffHash: String(row.handoffHash),
    deliveredThroughCompletedTurn: Number(row.deliveredThroughCompletedTurn),
    worktreeId: nullableString(row.worktreeId),
    status: status === "queued" || status === "running" || status === "completed" || status === "interrupted" || status === "blocked" || status === "terminated" ? status : "failed",
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function parseJsonArray<T>(value: unknown): T[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : null;
  } catch {
    return null;
  }
}

export function mapProviderResumePointRow(row: SqliteRow): StoredProviderResumePoint {
  return {
    projectId: String(row.projectId),
    conversationId: String(row.conversationId),
    resumePointId: String(row.resumePointId),
    graphScopeId: nullableString(row.graphScopeId),
    changeId: nullableString(row.changeId),
    previousProviderId: String(row.previousProviderId),
    targetProviderId: String(row.targetProviderId),
    snapshotJson: String(row.snapshotJson),
    snapshotHash: String(row.snapshotHash),
    createdAt: String(row.createdAt),
  };
}

export function parseJsonObject<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as T : null;
  } catch {
    return null;
  }
}

export function mapSkillRootRow(row: SqliteRow): StoredSkillRoot {
  return {
    projectId: String(row.projectId),
    rootPath: String(row.rootPath),
    sourceKind: String(row.sourceKind),
    updatedAt: String(row.updatedAt),
  };
}

export function mapEnablementRow(row: SqliteRow): StoredSkillEnablement {
  return {
    projectId: String(row.projectId),
      changeId: decodeScopeChangeId(row.changeId),
    skillId: String(row.skillId),
    scope: row.scope === "topic" ? "topic" : "project",
    enabled: Number(row.enabled) === 1,
    updatedAt: String(row.updatedAt),
  };
}

export function mapDecisionRow(row: SqliteRow): StoredDecisionRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    changeId: decodeScopeChangeId(row.changeId),
    decisionType: String(row.decisionType),
    status: normalizeDecisionStatus(row.status),
    label: String(row.label),
    summary: String(row.summary),
    targetId: nullableString(row.targetId),
    runId: nullableString(row.runId),
    artifact: nullableString(row.artifact),
    actionId: nullableString(row.actionId),
    feedback: nullableString(row.feedback),
    payloadJson: String(row.payloadJson),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    completedAt: nullableString(row.completedAt),
  };
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapStoredExecutionContract(row: SqliteRow): StoredExecutionContractIdentity {
  const family = nullableString(row.executionContractFamily);
  const epoch = Number(row.executionContractEpoch ?? 0);
  const policyHash = nullableString(row.executionPolicyHash);
  const providerAdapterVersion = nullableString(row.providerAdapterVersion);
  if (family === "legacy-v0" && epoch === 0 && policyHash === null && providerAdapterVersion === null) {
    return legacyExecutionContract();
  }
  if (family && EXECUTION_CONTRACT_FAMILIES.includes(family as ExecutionContractFamily)) {
    try {
      return storedExecutionContract(validateExecutionContractIdentity({
        family,
        epoch,
        policyHash,
        providerAdapterVersion,
      }));
    } catch {
      // The persisted identity is one atomic contract. Any malformed field fails closed below.
    }
  }
  throw new Error(`Provider attempt has invalid execution contract: ${String(row.attemptId)}`);
}

export function encodeScopeChangeId(value: string | null): string {
  return value ?? "";
}

export function decodeScopeChangeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeDecisionStatus(value: unknown): StoredDecisionStatus {
  if (value === "accepted" || value === "requested-changes" || value === "dismissed" || value === "completed" || value === "failed") return value;
  return "pending";
}
