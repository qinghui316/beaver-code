import type Database from "better-sqlite3";
import { parseAgentAccessMode, type AgentAccessMode } from "../../../provider-runtime/agent-access-policy.js";
import type { AgentTurnMode, ProductMode, ProviderId } from "../../../provider-runtime/index.js";
import type { StoredConversation, StoredConversationGraphScope } from "../contracts.js";
import { mapConversationRow, nullableString, type SqliteRow } from "../sql-mappers.js";

export class ConversationRepository {
constructor(private readonly db: Database.Database) {}

  updateAgentAccess(input: {
    projectId: string;
    conversationId: string;
    providerId: ProviderId;
    expectedRevision: number;
    accessMode: AgentAccessMode;
    updatedAt: string;
  }): StoredConversation {
    const accessMode = parseAgentAccessMode(input.accessMode);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Invalid Agent access revision.");
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE conversations
        SET agent_access_mode = ?, agent_access_revision = agent_access_revision + 1, updated_at = ?
        WHERE project_id = ? AND conversation_id = ? AND product_mode = 'agent'
          AND selected_provider_id = ? AND agent_access_revision = ?
          AND state = 'active' AND surface_kind = 'user' AND deleted_at IS NULL
      `).run(accessMode, input.updatedAt, input.projectId, input.conversationId, input.providerId, input.expectedRevision);
      if (result.changes !== 1) {
        const error = new Error("Conversation access changed concurrently.");
        error.name = "Conflict";
        throw error;
      }
      return this.readConversation(input.projectId, input.conversationId)!;
    }).immediate();
  }

  updateConversationTitle(projectId: string, conversationId: string, title: string, updatedAt: string): StoredConversation {
    return this.db.transaction(() => {
      const current = this.readConversation(projectId, conversationId);
      if (!current) throw new Error(`Conversation not found: ${conversationId}`);
      const committedAt = nextMonotonicTimestamp(current.updatedAt, updatedAt);
      const result = this.db.prepare(`
        UPDATE conversations SET title = ?, updated_at = ?
        WHERE project_id = ? AND conversation_id = ? AND surface_kind = 'user' AND deleted_at IS NULL
      `).run(title, committedAt, projectId, conversationId);
      if (result.changes !== 1) throw new Error(`Conversation not found: ${conversationId}`);
      return this.readConversation(projectId, conversationId)!;
    }).immediate();
  }

  updateAgentTurnMode(
    projectId: string,
    conversationId: string,
    expectedMode: AgentTurnMode,
    nextMode: AgentTurnMode,
    updatedAt: string,
  ): void {
    const result = this.db.prepare(`
      UPDATE conversations SET agent_turn_mode = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND product_mode = 'agent'
        AND agent_turn_mode = ? AND surface_kind = 'user' AND deleted_at IS NULL
    `).run(nextMode, updatedAt, projectId, conversationId, expectedMode);
    if (result.changes !== 1) throw new Error(`Agent Conversation mode changed concurrently: ${conversationId}`);
  }

  updateAgentTurnPreferences(input: {
    projectId: string;
    conversationId: string;
    expectedAgentTurnMode: AgentTurnMode;
    expectedAgentModelId: string | null;
    expectedAgentReasoningEffort: string | null;
    agentTurnMode: AgentTurnMode;
    agentModelId: string | null;
    agentReasoningEffort: string | null;
    updatedAt: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE conversations
      SET agent_turn_mode = ?, agent_model_id = ?, agent_reasoning_effort = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND product_mode = 'agent'
        AND agent_turn_mode = ?
        AND agent_model_id IS ?
        AND agent_reasoning_effort IS ?
        AND surface_kind = 'user' AND deleted_at IS NULL
    `).run(
      input.agentTurnMode,
      input.agentModelId,
      input.agentReasoningEffort,
      input.updatedAt,
      input.projectId,
      input.conversationId,
      input.expectedAgentTurnMode,
      input.expectedAgentModelId,
      input.expectedAgentReasoningEffort,
    );
    if (result.changes !== 1) throw new Error(`Agent Conversation preferences changed concurrently: ${input.conversationId}`);
  }

  updateConversationModelSelection(input: {
    projectId: string;
    conversationId: string;
    expectedModelId: string | null;
    expectedReasoningEffort: string | null;
    modelId: string | null;
    reasoningEffort: string | null;
    updatedAt: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE conversations
      SET agent_model_id = ?, agent_reasoning_effort = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ?
        AND agent_model_id IS ? AND agent_reasoning_effort IS ?
        AND surface_kind = 'user' AND deleted_at IS NULL
    `).run(
      input.modelId,
      input.reasoningEffort,
      input.updatedAt,
      input.projectId,
      input.conversationId,
      input.expectedModelId,
      input.expectedReasoningEffort,
    );
    if (result.changes !== 1) throw new Error(`Conversation model selection changed concurrently: ${input.conversationId}`);
  }

  markConversationDeleted(projectId: string, conversationId: string, deletedAt: string): void {
    this.db.prepare(`
      UPDATE conversations SET deleted_at = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ?
    `).run(deletedAt, deletedAt, projectId, conversationId);
  }

  archiveAgentConversation(projectId: string, conversationId: string, expectedRevision: number, archivedAt: string): StoredConversation {
    const result = this.db.prepare(`
      UPDATE conversations
      SET state = 'archive', archive_origin = 'agent-user', archived_at = ?,
        lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND product_mode = 'agent'
        AND state = 'active' AND lifecycle_revision = ? AND deleted_at IS NULL
    `).run(archivedAt, archivedAt, projectId, conversationId, expectedRevision);
    if (result.changes !== 1) throw lifecycleConflict();
    return this.readConversation(projectId, conversationId)!;
  }

  restoreAgentConversation(projectId: string, conversationId: string, expectedRevision: number, restoredAt: string): StoredConversation {
    const result = this.db.prepare(`
      UPDATE conversations
      SET state = 'active', archive_origin = NULL, archived_at = NULL,
        lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND product_mode = 'agent'
        AND state = 'archive' AND archive_origin = 'agent-user'
        AND lifecycle_revision = ? AND deleted_at IS NULL
    `).run(restoredAt, projectId, conversationId, expectedRevision);
    if (result.changes !== 1) throw lifecycleConflict();
    return this.readConversation(projectId, conversationId)!;
  }

  deleteArchivedConversation(projectId: string, conversationId: string, expectedRevision: number, deletedAt: string): StoredConversation {
    const result = this.db.prepare(`
      UPDATE conversations
      SET title = 'Deleted conversation', deleted_at = ?,
        lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND state = 'archive'
        AND lifecycle_revision = ? AND deleted_at IS NULL
    `).run(deletedAt, deletedAt, projectId, conversationId, expectedRevision);
    if (result.changes !== 1) throw lifecycleConflict();
    return this.readConversation(projectId, conversationId, { includeDeleted: true })!;
  }

  deleteConversationGraphScopes(projectId: string, conversationId: string): void {
    this.db.prepare("DELETE FROM conversation_graph_scopes WHERE project_id = ? AND conversation_id = ?")
      .run(projectId, conversationId);
  }

  switchSelectedProvider(
    projectId: string,
    conversationId: string,
    expectedProviderId: ProviderId,
    targetProviderId: ProviderId,
    updatedAt: string,
  ): void {
    const selected = this.db.prepare(`
      UPDATE conversations SET agent_access_mode = CASE WHEN selected_provider_id = ? THEN agent_access_mode ELSE NULL END,
        agent_access_revision = agent_access_revision + CASE WHEN selected_provider_id = ? THEN 0 ELSE 1 END,
        selected_provider_id = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND selected_provider_id = ? AND deleted_at IS NULL
    `).run(targetProviderId, targetProviderId, targetProviderId, updatedAt, projectId, conversationId, expectedProviderId);
    if (selected.changes !== 1) {
      throw new Error(`Conversation provider changed concurrently: ${conversationId}`);
    }
  }

  activateGraphScope(projectId: string, conversationId: string, graphScopeId: string, updatedAt: string): void {
    const activated = this.db.prepare(`
      UPDATE conversations
      SET current_graph_scope_id = ?,
        bound_change_id = CASE WHEN current_graph_scope_id = ? THEN bound_change_id ELSE NULL END,
        updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND state = 'active' AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation_lifecycle_operations lifecycle
          WHERE lifecycle.project_id = conversations.project_id
            AND lifecycle.conversation_id = conversations.conversation_id
            AND lifecycle.status IN ('pending', 'submitting')
        )
    `).run(graphScopeId, graphScopeId, updatedAt, projectId, conversationId);
    if (activated.changes !== 1) {
      throw lifecycleConflict("Conversation is not active or has a lifecycle operation in progress.");
    }
    this.db.prepare(`
      INSERT INTO conversation_graph_scopes (project_id, conversation_id, graph_scope_id, status, updated_at)
      VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT(project_id, graph_scope_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        status = 'active',
        updated_at = excluded.updated_at
    `).run(projectId, conversationId, graphScopeId, updatedAt);
  }

  recordPlanningAcceptance(
    acceptanceId: string,
    projectId: string,
    conversationId: string,
    changeId: string,
    graphScopeId: string,
    proposalHash: string,
    committedAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO planning_acceptance_commits (
        id, project_id, conversation_id, change_id, graph_scope_id, proposal_hash, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(acceptanceId, projectId, conversationId, changeId, graphScopeId, proposalHash, committedAt);
  }

createConversation(
  conversation: Omit<StoredConversation, "timelinePosition" | "timelineRevision" | "clientCreateRequestId" | "clientCreateRequestHash" | "agentModelId" | "agentReasoningEffort" | "archiveOrigin" | "archivedAt" | "lifecycleRevision">
    & Partial<Pick<StoredConversation, "timelinePosition" | "timelineRevision" | "clientCreateRequestId" | "clientCreateRequestHash" | "agentModelId" | "agentReasoningEffort" | "archiveOrigin" | "archivedAt" | "lifecycleRevision">>,
): void {
    const agentTurnMode = conversation.productMode === "agent"
      ? conversation.agentTurnMode ?? "default"
      : null;
    this.db.prepare(`
      INSERT INTO conversations (
        project_id, conversation_id, product_mode, agent_turn_mode, agent_model_id, agent_reasoning_effort, client_create_request_id, client_create_request_hash,
        title, state, archive_origin, archived_at, lifecycle_revision, surface_kind, bound_change_id, current_graph_scope_id,
        selected_provider_id, completed_turn_sequence, timeline_position, timeline_revision, created_at, updated_at, deleted_at,
        agent_access_mode, agent_access_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversation.projectId,
      conversation.conversationId,
      conversation.productMode,
      agentTurnMode,
      conversation.agentModelId ?? null,
      conversation.agentReasoningEffort ?? null,
      conversation.clientCreateRequestId ?? null,
      conversation.clientCreateRequestHash ?? null,
      conversation.title,
      conversation.state,
      conversation.archiveOrigin ?? null,
      conversation.archivedAt ?? null,
      conversation.lifecycleRevision ?? 0,
      conversation.surfaceKind ?? "user",
      conversation.boundChangeId,
      conversation.currentGraphScopeId,
      conversation.selectedProviderId,
      conversation.completedTurnSequence,
      conversation.timelinePosition ?? 0,
      conversation.timelineRevision ?? 0,
      conversation.createdAt,
      conversation.updatedAt,
      conversation.deletedAt,
      conversation.productMode === "agent" ? parseAgentAccessMode(conversation.agentAccessMode) : null,
      conversation.agentAccessRevision ?? 0,
    );
  }

listConversations(projectId: string, productMode: ProductMode, options: { includeDeleted?: boolean } = {}): StoredConversation[] {
    const rows = options.includeDeleted
      ? this.db.prepare(`
        SELECT project_id AS projectId, conversation_id AS conversationId, product_mode AS productMode, agent_turn_mode AS agentTurnMode,
          agent_model_id AS agentModelId, agent_reasoning_effort AS agentReasoningEffort,
          agent_access_mode AS agentAccessMode, agent_access_revision AS agentAccessRevision,
          client_create_request_id AS clientCreateRequestId, client_create_request_hash AS clientCreateRequestHash,
          title, state, archive_origin AS archiveOrigin, archived_at AS archivedAt,
          lifecycle_revision AS lifecycleRevision, surface_kind AS surfaceKind,
          bound_change_id AS boundChangeId, current_graph_scope_id AS currentGraphScopeId,
          selected_provider_id AS selectedProviderId, completed_turn_sequence AS completedTurnSequence,
          timeline_position AS timelinePosition, timeline_revision AS timelineRevision,
          created_at AS createdAt, updated_at AS updatedAt,
          deleted_at AS deletedAt
        FROM conversations
        WHERE project_id = ? AND product_mode = ? AND surface_kind = 'user'
        ORDER BY updated_at DESC
      `).all(projectId, productMode) as SqliteRow[]
      : this.db.prepare(`
        SELECT project_id AS projectId, conversation_id AS conversationId, product_mode AS productMode, agent_turn_mode AS agentTurnMode,
          agent_model_id AS agentModelId, agent_reasoning_effort AS agentReasoningEffort,
          agent_access_mode AS agentAccessMode, agent_access_revision AS agentAccessRevision,
          client_create_request_id AS clientCreateRequestId, client_create_request_hash AS clientCreateRequestHash,
          title, state, archive_origin AS archiveOrigin, archived_at AS archivedAt,
          lifecycle_revision AS lifecycleRevision, surface_kind AS surfaceKind,
          bound_change_id AS boundChangeId, current_graph_scope_id AS currentGraphScopeId,
          selected_provider_id AS selectedProviderId, completed_turn_sequence AS completedTurnSequence,
          timeline_position AS timelinePosition, timeline_revision AS timelineRevision,
          created_at AS createdAt, updated_at AS updatedAt,
          deleted_at AS deletedAt
        FROM conversations
        WHERE project_id = ? AND product_mode = ? AND deleted_at IS NULL AND surface_kind = 'user'
        ORDER BY updated_at DESC
      `).all(projectId, productMode) as SqliteRow[];
    return rows.map(mapConversationRow);
  }

readConversation(projectId: string, conversationId: string, options: { includeDeleted?: boolean } = {}): StoredConversation | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, product_mode AS productMode, agent_turn_mode AS agentTurnMode,
        agent_model_id AS agentModelId, agent_reasoning_effort AS agentReasoningEffort,
          agent_access_mode AS agentAccessMode, agent_access_revision AS agentAccessRevision,
        client_create_request_id AS clientCreateRequestId, client_create_request_hash AS clientCreateRequestHash,
        title, state, archive_origin AS archiveOrigin, archived_at AS archivedAt,
        lifecycle_revision AS lifecycleRevision, surface_kind AS surfaceKind,
        bound_change_id AS boundChangeId, current_graph_scope_id AS currentGraphScopeId,
        selected_provider_id AS selectedProviderId, completed_turn_sequence AS completedTurnSequence,
        timeline_position AS timelinePosition, timeline_revision AS timelineRevision,
        created_at AS createdAt, updated_at AS updatedAt,
        deleted_at AS deletedAt
      FROM conversations
      WHERE project_id = ? AND conversation_id = ? ${options.includeDeleted ? "" : "AND deleted_at IS NULL"}
    `).get(projectId, conversationId) as SqliteRow | undefined;
    return row ? mapConversationRow(row) : null;
  }

  readConversationByClientCreateRequestId(projectId: string, clientRequestId: string): StoredConversation | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, product_mode AS productMode, agent_turn_mode AS agentTurnMode,
        agent_model_id AS agentModelId, agent_reasoning_effort AS agentReasoningEffort,
          agent_access_mode AS agentAccessMode, agent_access_revision AS agentAccessRevision,
        client_create_request_id AS clientCreateRequestId, client_create_request_hash AS clientCreateRequestHash,
        title, state, archive_origin AS archiveOrigin, archived_at AS archivedAt,
        lifecycle_revision AS lifecycleRevision, surface_kind AS surfaceKind, bound_change_id AS boundChangeId,
        current_graph_scope_id AS currentGraphScopeId, selected_provider_id AS selectedProviderId,
        completed_turn_sequence AS completedTurnSequence, timeline_position AS timelinePosition,
        timeline_revision AS timelineRevision, created_at AS createdAt, updated_at AS updatedAt,
        deleted_at AS deletedAt
      FROM conversations
      WHERE project_id = ? AND client_create_request_id = ?
      LIMIT 1
    `).get(projectId, clientRequestId) as SqliteRow | undefined;
    return row ? mapConversationRow(row) : null;
  }

readConversationByChangeId(projectId: string, changeId: string): StoredConversation | null {
    const row = this.db.prepare(`
      SELECT c.project_id AS projectId, c.conversation_id AS conversationId, c.product_mode AS productMode, c.agent_turn_mode AS agentTurnMode,
        c.agent_model_id AS agentModelId, c.agent_reasoning_effort AS agentReasoningEffort,
        c.client_create_request_id AS clientCreateRequestId, c.client_create_request_hash AS clientCreateRequestHash,
        c.title, c.state, c.archive_origin AS archiveOrigin, c.archived_at AS archivedAt,
        c.lifecycle_revision AS lifecycleRevision, c.surface_kind AS surfaceKind,
        c.bound_change_id AS boundChangeId, c.current_graph_scope_id AS currentGraphScopeId,
        c.selected_provider_id AS selectedProviderId, c.completed_turn_sequence AS completedTurnSequence,
        c.timeline_position AS timelinePosition, c.timeline_revision AS timelineRevision,
        c.created_at AS createdAt, c.updated_at AS updatedAt,
        c.deleted_at AS deletedAt
      FROM conversations c
      LEFT JOIN conversation_change_links l
        ON l.project_id = c.project_id AND l.conversation_id = c.conversation_id
      WHERE c.project_id = ? AND c.deleted_at IS NULL
        AND (l.change_id = ? OR c.bound_change_id = ?)
      ORDER BY CASE WHEN l.change_id = ? THEN 0 ELSE 1 END, c.updated_at DESC
      LIMIT 1
    `).get(projectId, changeId, changeId, changeId) as SqliteRow | undefined;
    return row ? mapConversationRow(row) : null;
  }

bindConversationToChange(projectId: string, conversationId: string, changeId: string, updatedAt: string): void {
    this.db.prepare(`
      UPDATE conversations
      SET bound_change_id = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND deleted_at IS NULL
    `).run(changeId, updatedAt, projectId, conversationId);
  }

  initializeConversationGraphScope(
    projectId: string,
    conversationId: string,
    graphScopeId: string,
    updatedAt: string,
  ): void {
    const conversation = this.readConversation(projectId, conversationId);
    if (!conversation
      || conversation.state !== "active"
      || conversation.currentGraphScopeId !== graphScopeId
      || conversation.updatedAt !== updatedAt) {
      throw new Error("Initial Conversation graph scope does not match its active Conversation identity.");
    }
    this.db.prepare(`
      INSERT INTO conversation_graph_scopes (project_id, conversation_id, graph_scope_id, status, updated_at)
      VALUES (?, ?, ?, 'active', ?)
    `).run(projectId, conversationId, graphScopeId, updatedAt);
  }

archiveBoundConversation(
    projectId: string,
    conversationId: string,
    changeId: string,
    graphScopeId: string,
    updatedAt: string,
  ): void {
    const result = this.db.prepare(`
      UPDATE conversations
      SET state = 'archive', archive_origin = 'harness-workflow', archived_at = ?,
        lifecycle_revision = lifecycle_revision + 1, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND state = 'active'
        AND bound_change_id = ? AND current_graph_scope_id = ? AND deleted_at IS NULL
    `).run(updatedAt, updatedAt, projectId, conversationId, changeId, graphScopeId);
    if (result.changes !== 1) {
      throw new Error("Conversation abandon lineage is stale or no longer active.");
    }
  }

restoreConversationAfterAbandonment(
    snapshot: StoredConversation,
    expectedUpdatedAt: string,
  ): void {
    const result = this.db.prepare(`
      UPDATE conversations
      SET title = ?, state = ?, archive_origin = ?, archived_at = ?, lifecycle_revision = ?,
        surface_kind = ?, bound_change_id = ?, current_graph_scope_id = ?,
        selected_provider_id = ?, completed_turn_sequence = ?, timeline_position = ?, timeline_revision = ?,
        created_at = ?, updated_at = ?, deleted_at = ?
      WHERE project_id = ? AND conversation_id = ? AND state = 'archive'
        AND bound_change_id = ? AND current_graph_scope_id = ? AND updated_at = ?
    `).run(
      snapshot.title,
      snapshot.state,
      snapshot.archiveOrigin,
      snapshot.archivedAt,
      snapshot.lifecycleRevision,
      snapshot.surfaceKind ?? "user",
      snapshot.boundChangeId,
      snapshot.currentGraphScopeId,
      snapshot.selectedProviderId,
      snapshot.completedTurnSequence,
      snapshot.timelinePosition,
      snapshot.timelineRevision,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.deletedAt,
      snapshot.projectId,
      snapshot.conversationId,
      snapshot.boundChangeId,
      snapshot.currentGraphScopeId,
      expectedUpdatedAt,
    );
    if (result.changes !== 1) {
      throw new Error("Conversation abandon rollback refused because sidecar lineage changed.");
    }
  }

selectConversationProvider(projectId: string, conversationId: string, providerId: ProviderId, updatedAt: string): void {
    const result = this.db.prepare(`
      UPDATE conversations SET agent_access_mode = CASE WHEN selected_provider_id = ? THEN agent_access_mode ELSE NULL END,
        agent_access_revision = agent_access_revision + CASE WHEN selected_provider_id = ? THEN 0 ELSE 1 END,
        selected_provider_id = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND deleted_at IS NULL
    `).run(providerId, providerId, providerId, updatedAt, projectId, conversationId);
    if (result.changes !== 1) throw new Error(`Conversation not found: ${conversationId}`);
  }

advanceCompletedTurnSequence(projectId: string, conversationId: string, expected: number, updatedAt: string): number {
    const result = this.db.prepare(`
      UPDATE conversations SET completed_turn_sequence = completed_turn_sequence + 1, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND completed_turn_sequence = ? AND deleted_at IS NULL
    `).run(updatedAt, projectId, conversationId, expected);
    if (result.changes !== 1) throw new Error(`Conversation completed-turn sequence changed concurrently: ${conversationId}`);
    return expected + 1;
  }

linkConversationChange(projectId: string, conversationId: string, changeId: string, linkedAt: string): void {
    const graphScopeId = this.readConversation(projectId, conversationId)?.currentGraphScopeId;
    if (!graphScopeId) throw new Error("Conversation Change binding requires the current graph scope.");
    this.db.prepare(`
      INSERT INTO conversation_change_links (project_id, conversation_id, change_id, graph_scope_id, linked_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, conversation_id, change_id) DO UPDATE SET
        graph_scope_id = excluded.graph_scope_id,
        linked_at = excluded.linked_at
    `).run(projectId, conversationId, changeId, graphScopeId, linkedAt);
    this.db.prepare(`
      UPDATE conversations SET bound_change_id = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND deleted_at IS NULL
    `).run(changeId, linkedAt, projectId, conversationId);
  }

  markConversationGraphScopeTerminal(projectId: string, conversationId: string, graphScopeId: string, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO conversation_graph_scopes (project_id, conversation_id, graph_scope_id, status, updated_at)
      VALUES (?, ?, ?, 'terminal', ?)
      ON CONFLICT(project_id, graph_scope_id) DO UPDATE SET
        status = 'terminal',
        updated_at = excluded.updated_at
    `).run(projectId, conversationId, graphScopeId, updatedAt);
  }

  readConversationGraphScope(projectId: string, graphScopeId: string): StoredConversationGraphScope | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId,
        graph_scope_id AS graphScopeId, status, updated_at AS updatedAt
      FROM conversation_graph_scopes
      WHERE project_id = ? AND graph_scope_id = ?
    `).get(projectId, graphScopeId) as SqliteRow | undefined;
    if (!row) return null;
    const status = String(row.status);
    if (status !== "active" && status !== "terminal") {
      throw new Error(`Conversation graph scope has an invalid status: ${status}.`);
    }
    return {
      projectId: String(row.projectId),
      conversationId: String(row.conversationId),
      graphScopeId: String(row.graphScopeId),
      status,
      updatedAt: String(row.updatedAt),
    };
  }

  terminalizeConversationGraphScopeForAbandonment(
    snapshot: StoredConversationGraphScope,
    updatedAt: string,
  ): void {
    const result = this.db.prepare(`
      UPDATE conversation_graph_scopes
      SET status = 'terminal', updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND graph_scope_id = ?
        AND status = ? AND updated_at = ?
    `).run(
      updatedAt,
      snapshot.projectId,
      snapshot.conversationId,
      snapshot.graphScopeId,
      snapshot.status,
      snapshot.updatedAt,
    );
    if (result.changes !== 1) {
      throw new Error("Conversation graph scope abandon lineage changed before sidecar commit.");
    }
  }

  restoreConversationGraphScopeStatus(
    projectId: string,
    conversationId: string,
    graphScopeId: string,
    status: "active" | "terminal",
    updatedAt: string,
  ): void {
    const result = this.db.prepare(`
      UPDATE conversation_graph_scopes
      SET status = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND graph_scope_id = ?
    `).run(status, updatedAt, projectId, conversationId, graphScopeId);
    if (result.changes !== 1) {
      throw new Error("Conversation graph scope abandon rollback refused because lineage changed.");
    }
  }

  restoreConversationGraphScopeAfterAbandonment(
    snapshot: StoredConversationGraphScope,
    expectedUpdatedAt: string,
  ): void {
    const result = this.db.prepare(`
      UPDATE conversation_graph_scopes
      SET status = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND graph_scope_id = ?
        AND status = 'terminal' AND updated_at = ?
    `).run(
      snapshot.status,
      snapshot.updatedAt,
      snapshot.projectId,
      snapshot.conversationId,
      snapshot.graphScopeId,
      expectedUpdatedAt,
    );
    if (result.changes !== 1) {
      throw new Error("Conversation graph scope abandon rollback refused because lineage changed.");
    }
  }

isConversationGraphScopeTerminal(projectId: string, graphScopeId: string): boolean {
    const row = this.db.prepare(`
      SELECT status FROM conversation_graph_scopes
      WHERE project_id = ? AND graph_scope_id = ?
    `).get(projectId, graphScopeId) as SqliteRow | undefined;
    return row?.status === "terminal";
  }

findGraphScopeForChange(projectId: string, changeId: string): string | null {
    const row = this.db.prepare(`
      SELECT graph_scope_id AS graphScopeId FROM conversation_change_links
      WHERE project_id = ? AND change_id = ? AND graph_scope_id IS NOT NULL
      ORDER BY linked_at DESC LIMIT 1
    `).get(projectId, changeId) as SqliteRow | undefined;
    return nullableString(row?.graphScopeId);
  }

findChangeForGraphScope(projectId: string, graphScopeId: string): string | null {
    const row = this.db.prepare(`
      SELECT change_id AS changeId FROM conversation_change_links
      WHERE project_id = ? AND graph_scope_id = ?
      ORDER BY linked_at DESC LIMIT 1
    `).get(projectId, graphScopeId) as SqliteRow | undefined;
    return nullableString(row?.changeId);
  }

hasPlanningAcceptanceCommit(acceptanceId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM planning_acceptance_commits WHERE id = ? LIMIT 1",
    ).get(acceptanceId));
  }

deletePlanningAcceptanceCommit(acceptanceId: string): void {
    this.db.prepare("DELETE FROM planning_acceptance_commits WHERE id = ?").run(acceptanceId);
  }

listConversationChangeIds(projectId: string, conversationId: string): string[] {
    return (this.db.prepare(`
      SELECT change_id AS changeId FROM conversation_change_links
      WHERE project_id = ? AND conversation_id = ? ORDER BY linked_at ASC
    `).all(projectId, conversationId) as SqliteRow[]).map((row) => String(row.changeId));
  }

findConversationForChange(projectId: string, changeId: string): StoredConversation | null {
    const row = this.db.prepare(`
      SELECT c.project_id AS projectId, c.conversation_id AS conversationId, c.product_mode AS productMode, c.agent_turn_mode AS agentTurnMode,
        c.agent_model_id AS agentModelId, c.agent_reasoning_effort AS agentReasoningEffort,
        c.client_create_request_id AS clientCreateRequestId, c.client_create_request_hash AS clientCreateRequestHash,
        c.title, c.state, c.archive_origin AS archiveOrigin, c.archived_at AS archivedAt,
        c.lifecycle_revision AS lifecycleRevision, c.surface_kind AS surfaceKind,
        c.bound_change_id AS boundChangeId, c.current_graph_scope_id AS currentGraphScopeId,
        c.selected_provider_id AS selectedProviderId, c.completed_turn_sequence AS completedTurnSequence,
        c.timeline_position AS timelinePosition, c.timeline_revision AS timelineRevision,
        c.created_at AS createdAt, c.updated_at AS updatedAt,
        c.deleted_at AS deletedAt
      FROM conversation_change_links l
      JOIN conversations c
        ON c.project_id = l.project_id AND c.conversation_id = l.conversation_id
      WHERE l.project_id = ? AND l.change_id = ? AND c.deleted_at IS NULL
      ORDER BY l.linked_at DESC
      LIMIT 1
    `).get(projectId, changeId) as SqliteRow | undefined;
    return row ? mapConversationRow(row) : null;
  }
}

function nextMonotonicTimestamp(current: string, candidate: string): string {
  const currentTime = Date.parse(current);
  const candidateTime = Date.parse(candidate);
  if (!Number.isFinite(currentTime) || !Number.isFinite(candidateTime)) {
    throw new Error("Conversation title timestamps must be valid ISO dates.");
  }
  return new Date(Math.max(candidateTime, currentTime + 1)).toISOString();
}

function lifecycleConflict(message = "Conversation lifecycle changed concurrently."): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}
