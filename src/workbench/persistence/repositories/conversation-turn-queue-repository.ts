import { parseAgentAccessMode } from "../../../provider-runtime/agent-access-policy.js";
import type Database from "better-sqlite3";
import { validateStoredExecutionContractRef, type ProductMode } from "../../../provider-runtime/index.js";
import type {
  StoredConversationQueuedTurn,
  StoredConversationQueuedTurnStatus,
  StoredConversationTurnQueueContractConfirmation,
  StoredConversationTurnQueue,
} from "../contracts.js";
import type { SqliteRow } from "../sql-mappers.js";

const ACTIVE_STATUSES: StoredConversationQueuedTurnStatus[] = ["queued", "dispatching", "blocked"];

export class ConversationTurnQueueRepository {
  constructor(private readonly db: Database.Database) {}

  readQueue(projectId: string, conversationId: string): StoredConversationTurnQueue | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId,
        product_mode AS productMode, revision, updated_at AS updatedAt
      FROM conversation_turn_queues WHERE project_id = ? AND conversation_id = ?
    `).get(projectId, conversationId) as SqliteRow | undefined;
    return row ? mapQueue(row) : null;
  }

  ensureQueue(input: {
    projectId: string;
    conversationId: string;
    productMode: ProductMode;
    updatedAt: string;
  }): StoredConversationTurnQueue {
    this.db.prepare(`
      INSERT INTO conversation_turn_queues (
        project_id, conversation_id, product_mode, revision, updated_at
      ) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(project_id, conversation_id) DO NOTHING
    `).run(input.projectId, input.conversationId, input.productMode, input.updatedAt);
    const queue = this.readQueue(input.projectId, input.conversationId);
    if (!queue || queue.productMode !== input.productMode) throw conflict("Conversation Turn queue mode does not match Conversation.");
    return queue;
  }

  listItems(projectId: string, conversationId: string, activeOnly = true): StoredConversationQueuedTurn[] {
    const statusSql = activeOnly ? `AND status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})` : "";
    const rows = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, product_mode AS productMode,
        queue_item_id AS queueItemId, client_request_id AS clientRequestId, request_hash AS requestHash,
        position, status, retry_count AS retryCount,
        predecessor_execution_revision AS predecessorExecutionRevision,
        dispatch_request_id AS dispatchRequestId,
        execution_contract_family AS executionContractFamily,
        execution_contract_epoch AS executionContractEpoch,
        item_kind AS itemKind, review_target_json AS reviewTargetJson,
        text, context_refs_json AS contextRefsJson,
        attachment_ids_json AS attachmentIdsJson, skill_overrides_json AS skillOverridesJson,
        provider_id AS providerId, agent_turn_mode AS agentTurnMode, agent_access_mode AS agentAccessMode,
        agent_model_id AS agentModelId, agent_reasoning_effort AS agentReasoningEffort,
        diagnostic, created_at AS createdAt, updated_at AS updatedAt, dispatched_at AS dispatchedAt
      FROM conversation_turn_queue_items
      WHERE project_id = ? AND conversation_id = ? ${statusSql}
      ORDER BY position ASC
    `).all(projectId, conversationId, ...(activeOnly ? ACTIVE_STATUSES : [])) as SqliteRow[];
    return rows.map(mapItem);
  }

  listDispatching(projectId: string): StoredConversationQueuedTurn[] {
    const rows = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, product_mode AS productMode,
        queue_item_id AS queueItemId, client_request_id AS clientRequestId, request_hash AS requestHash,
        position, status, retry_count AS retryCount,
        predecessor_execution_revision AS predecessorExecutionRevision,
        dispatch_request_id AS dispatchRequestId,
        execution_contract_family AS executionContractFamily,
        execution_contract_epoch AS executionContractEpoch,
        item_kind AS itemKind, review_target_json AS reviewTargetJson,
        text, context_refs_json AS contextRefsJson,
        attachment_ids_json AS attachmentIdsJson, skill_overrides_json AS skillOverridesJson,
        provider_id AS providerId, agent_turn_mode AS agentTurnMode, agent_access_mode AS agentAccessMode,
        agent_model_id AS agentModelId, agent_reasoning_effort AS agentReasoningEffort,
        diagnostic, created_at AS createdAt, updated_at AS updatedAt, dispatched_at AS dispatchedAt
      FROM conversation_turn_queue_items
      WHERE project_id = ? AND status = 'dispatching'
      ORDER BY conversation_id ASC, position ASC
    `).all(projectId) as SqliteRow[];
    return rows.map(mapItem);
  }

  listActiveProjectItems(projectId: string): StoredConversationQueuedTurn[] {
    const rows = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, product_mode AS productMode,
        queue_item_id AS queueItemId, client_request_id AS clientRequestId, request_hash AS requestHash,
        position, status, retry_count AS retryCount,
        predecessor_execution_revision AS predecessorExecutionRevision,
        dispatch_request_id AS dispatchRequestId,
        execution_contract_family AS executionContractFamily,
        execution_contract_epoch AS executionContractEpoch,
        item_kind AS itemKind, review_target_json AS reviewTargetJson,
        text, context_refs_json AS contextRefsJson,
        attachment_ids_json AS attachmentIdsJson, skill_overrides_json AS skillOverridesJson,
        provider_id AS providerId, agent_turn_mode AS agentTurnMode, agent_access_mode AS agentAccessMode,
        agent_model_id AS agentModelId, agent_reasoning_effort AS agentReasoningEffort,
        diagnostic, created_at AS createdAt, updated_at AS updatedAt, dispatched_at AS dispatchedAt
      FROM conversation_turn_queue_items
      WHERE project_id = ? AND status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})
      ORDER BY conversation_id ASC, position ASC
    `).all(projectId, ...ACTIVE_STATUSES) as SqliteRow[];
    return rows.map(mapItem);
  }

  readItem(projectId: string, conversationId: string, queueItemId: string): StoredConversationQueuedTurn | null {
    return this.listItems(projectId, conversationId, false).find((item) => item.queueItemId === queueItemId) ?? null;
  }

  readByClientRequestId(projectId: string, conversationId: string, clientRequestId: string): StoredConversationQueuedTurn | null {
    return this.listItems(projectId, conversationId, false).find((item) => item.clientRequestId === clientRequestId) ?? null;
  }

  nextPosition(projectId: string, conversationId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1 AS nextPosition
      FROM conversation_turn_queue_items WHERE project_id = ? AND conversation_id = ?
    `).get(projectId, conversationId) as SqliteRow;
    return Number(row.nextPosition);
  }

  insertItem(item: StoredConversationQueuedTurn): void {
    this.db.prepare(`
      INSERT INTO conversation_turn_queue_items (
        project_id, conversation_id, product_mode, queue_item_id, client_request_id, request_hash,
        position, status, retry_count, predecessor_execution_revision, dispatch_request_id,
        execution_contract_family, execution_contract_epoch,
        item_kind, review_target_json,
        text, context_refs_json, attachment_ids_json, skill_overrides_json, provider_id,
        agent_turn_mode, agent_model_id, agent_reasoning_effort, diagnostic,
        created_at, updated_at, dispatched_at, agent_access_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.projectId, item.conversationId, item.productMode, item.queueItemId, item.clientRequestId,
      item.requestHash, item.position, item.status, item.retryCount, item.predecessorExecutionRevision,
      item.dispatchRequestId, item.executionContractFamily ?? "legacy-v0", item.executionContractEpoch ?? 0,
      item.itemKind ?? "conversation-turn", item.reviewTargetJson ?? null, item.text, item.contextRefsJson, item.attachmentIdsJson,
      item.skillOverridesJson, item.providerId, item.agentTurnMode, item.agentModelId,
      item.agentReasoningEffort, item.diagnostic, item.createdAt, item.updatedAt, item.dispatchedAt,
      item.productMode === "agent" && item.itemKind !== "review" ? parseAgentAccessMode(item.agentAccessMode) : null,
    );
  }

  reclaimText(item: StoredConversationQueuedTurn): string {
    if (item.itemKind !== "review") return item.text;
    if (!item.reviewTargetJson) throw conflict("Queued Review target is missing.");
    const target = JSON.parse(item.reviewTargetJson) as {
      type: string;
      branch?: string;
      sha?: string;
      title?: string;
      instructions?: string;
    };
    if (target.type === "uncommitted-changes") return "/review";
    if (target.type === "base-branch") return `/review base ${target.branch ?? ""}`.trim();
    if (target.type === "commit") {
      return `/review commit ${target.sha ?? ""}${target.title ? ` ${target.title}` : ""}`.trim();
    }
    return `/review custom ${target.instructions ?? ""}`.trim();
  }

  transitionItem(input: {
    projectId: string;
    conversationId: string;
    queueItemId: string;
    expectedStatus: StoredConversationQueuedTurnStatus;
    status: StoredConversationQueuedTurnStatus;
    updatedAt: string;
    retryCount?: number;
    diagnostic?: string | null;
    dispatchedAt?: string | null;
  }): StoredConversationQueuedTurn {
    const result = this.db.prepare(`
      UPDATE conversation_turn_queue_items
      SET status = ?, retry_count = COALESCE(?, retry_count), diagnostic = ?, updated_at = ?,
        dispatched_at = COALESCE(?, dispatched_at)
      WHERE project_id = ? AND conversation_id = ? AND queue_item_id = ? AND status = ?
    `).run(
      input.status, input.retryCount ?? null, input.diagnostic ?? null, input.updatedAt,
      input.dispatchedAt ?? null, input.projectId, input.conversationId, input.queueItemId, input.expectedStatus,
    );
    if (result.changes !== 1) throw conflict("Conversation queued Turn changed before settlement.");
    return this.readItem(input.projectId, input.conversationId, input.queueItemId)!;
  }

  advanceRevision(projectId: string, conversationId: string, expectedRevision: number, updatedAt: string): StoredConversationTurnQueue {
    const result = this.db.prepare(`
      UPDATE conversation_turn_queues SET revision = revision + 1, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND revision = ?
    `).run(updatedAt, projectId, conversationId, expectedRevision);
    if (result.changes !== 1) throw conflict("Conversation Turn queue changed in another window.");
    return this.readQueue(projectId, conversationId)!;
  }

  readContractConfirmation(
    projectId: string,
    conversationId: string,
    queueItemId: string,
    targetFamily: string,
    targetEpoch: number,
  ): StoredConversationTurnQueueContractConfirmation | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, queue_item_id AS queueItemId,
        prior_family AS priorFamily, prior_epoch AS priorEpoch,
        target_family AS targetFamily, target_epoch AS targetEpoch,
        client_request_id AS clientRequestId, expected_revision AS expectedRevision,
        request_hash AS requestHash, confirmed_at AS confirmedAt
      FROM conversation_turn_queue_contract_confirmations
      WHERE project_id = ? AND conversation_id = ? AND queue_item_id = ?
        AND target_family = ? AND target_epoch = ?
    `).get(projectId, conversationId, queueItemId, targetFamily, targetEpoch) as SqliteRow | undefined;
    return row ? mapConfirmation(row) : null;
  }

  readContractConfirmationByRequestId(
    projectId: string,
    conversationId: string,
    clientRequestId: string,
  ): StoredConversationTurnQueueContractConfirmation | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, queue_item_id AS queueItemId,
        prior_family AS priorFamily, prior_epoch AS priorEpoch,
        target_family AS targetFamily, target_epoch AS targetEpoch,
        client_request_id AS clientRequestId, expected_revision AS expectedRevision,
        request_hash AS requestHash, confirmed_at AS confirmedAt
      FROM conversation_turn_queue_contract_confirmations
      WHERE project_id = ? AND conversation_id = ? AND client_request_id = ?
    `).get(projectId, conversationId, clientRequestId) as SqliteRow | undefined;
    return row ? mapConfirmation(row) : null;
  }

  insertContractConfirmation(confirmation: StoredConversationTurnQueueContractConfirmation): void {
    this.db.prepare(`
      INSERT INTO conversation_turn_queue_contract_confirmations (
        project_id, conversation_id, queue_item_id, prior_family, prior_epoch,
        target_family, target_epoch, client_request_id, expected_revision, request_hash, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      confirmation.projectId,
      confirmation.conversationId,
      confirmation.queueItemId,
      confirmation.priorFamily,
      confirmation.priorEpoch,
      confirmation.targetFamily,
      confirmation.targetEpoch,
      confirmation.clientRequestId,
      confirmation.expectedRevision,
      confirmation.requestHash,
      confirmation.confirmedAt,
    );
  }

  deleteConversationQueue(projectId: string, conversationId: string): void {
    this.db.prepare("DELETE FROM conversation_turn_queue_contract_confirmations WHERE project_id = ? AND conversation_id = ?")
      .run(projectId, conversationId);
    this.db.prepare("DELETE FROM conversation_turn_queue_items WHERE project_id = ? AND conversation_id = ?")
      .run(projectId, conversationId);
    this.db.prepare("DELETE FROM conversation_turn_queues WHERE project_id = ? AND conversation_id = ?")
      .run(projectId, conversationId);
  }
}

function mapQueue(row: SqliteRow): StoredConversationTurnQueue {
  return {
    projectId: String(row.projectId),
    conversationId: String(row.conversationId),
    productMode: String(row.productMode) as ProductMode,
    revision: Number(row.revision),
    updatedAt: String(row.updatedAt),
  };
}

function mapItem(row: SqliteRow): StoredConversationQueuedTurn {
  let executionContract;
  try {
    executionContract = validateStoredExecutionContractRef({
      family: row.executionContractFamily,
      epoch: Number(row.executionContractEpoch),
    });
  } catch {
    throw new Error(`Conversation queued Turn has invalid execution contract: ${String(row.queueItemId)}`);
  }
  return {
    projectId: String(row.projectId), conversationId: String(row.conversationId),
    productMode: String(row.productMode) as ProductMode, queueItemId: String(row.queueItemId),
    clientRequestId: String(row.clientRequestId), requestHash: String(row.requestHash),
    position: Number(row.position), status: String(row.status) as StoredConversationQueuedTurnStatus,
    retryCount: Number(row.retryCount), predecessorExecutionRevision: String(row.predecessorExecutionRevision),
    dispatchRequestId: String(row.dispatchRequestId),
    executionContractFamily: executionContract.family,
    executionContractEpoch: executionContract.epoch,
    itemKind: row.itemKind === "review" ? "review" : "conversation-turn",
    reviewTargetJson: row.reviewTargetJson === null ? null : String(row.reviewTargetJson), text: String(row.text),
    contextRefsJson: String(row.contextRefsJson), attachmentIdsJson: String(row.attachmentIdsJson),
    skillOverridesJson: String(row.skillOverridesJson), providerId: String(row.providerId),
    agentAccessMode: row.productMode === "agent" && row.itemKind !== "review" ? parseAgentAccessMode(row.agentAccessMode) : null,
    agentTurnMode: row.agentTurnMode === null ? null : String(row.agentTurnMode) as StoredConversationQueuedTurn["agentTurnMode"],
    agentModelId: row.agentModelId === null ? null : String(row.agentModelId),
    agentReasoningEffort: row.agentReasoningEffort === null ? null : String(row.agentReasoningEffort),
    diagnostic: row.diagnostic === null ? null : String(row.diagnostic), createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt), dispatchedAt: row.dispatchedAt === null ? null : String(row.dispatchedAt),
  };
}

function mapConfirmation(row: SqliteRow): StoredConversationTurnQueueContractConfirmation {
  return {
    projectId: String(row.projectId),
    conversationId: String(row.conversationId),
    queueItemId: String(row.queueItemId),
    priorFamily: String(row.priorFamily),
    priorEpoch: Number(row.priorEpoch),
    targetFamily: String(row.targetFamily),
    targetEpoch: Number(row.targetEpoch),
    clientRequestId: String(row.clientRequestId),
    expectedRevision: String(row.expectedRevision),
    requestHash: String(row.requestHash),
    confirmedAt: String(row.confirmedAt),
  };
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}
