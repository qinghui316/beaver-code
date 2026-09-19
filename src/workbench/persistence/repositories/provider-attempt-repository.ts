import type Database from "better-sqlite3";
import { assertProductMode, legacyExecutionContract, type ProviderId } from "../../../provider-runtime/index.js";
import { agentThreadSurfaceId } from "../../../provider-runtime/agent-surface-id.js";
import type { StoredConversationProviderBinding, StoredProviderAttempt, StoredProviderResumePoint, StoredProviderThreadLink } from "../contracts.js";
import { mapConversationProviderBindingRow, mapProviderAttemptRow, mapProviderResumePointRow, mapProviderThreadRow, nullableString, type SqliteRow } from "../sql-mappers.js";
import { parseAgentAccessPolicy } from "../../../provider-runtime/agent-access-policy.js";

export class ProviderAttemptRepository {
constructor(private readonly db: Database.Database) {}

  attachChangeToGraphScope(
    projectId: string,
    conversationId: string,
    graphScopeId: string,
    changeId: string,
    updatedAt: string,
  ): void {
    this.db.prepare(`
      UPDATE provider_thread_links SET change_id = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND graph_scope_id = ?
    `).run(changeId, updatedAt, projectId, conversationId, graphScopeId);
  }

  moveConversationThreadsToGraphScope(
    projectId: string,
    conversationId: string,
    input: {
      mainAttemptId: string;
      plannerThreadId: string;
      previousGraphScopeId: string;
      graphScopeId: string;
    },
    updatedAt: string,
  ): void {
    if (input.previousGraphScopeId === input.graphScopeId) {
      throw new Error("Provider lineage graph transition requires distinct graph scopes.");
    }
    const mainLineage = this.db.prepare(`
      SELECT attempts.attempt_id AS attemptId
      FROM provider_attempts attempts
      JOIN provider_thread_links links
        ON links.project_id = attempts.project_id AND links.attempt_id = attempts.attempt_id
      WHERE attempts.project_id = ? AND attempts.conversation_id = ?
        AND attempts.attempt_id = ? AND attempts.role_id = 'main-agent'
        AND attempts.graph_scope_id = ?
        AND links.conversation_id = attempts.conversation_id
        AND links.role_id = 'main-agent' AND links.graph_scope_id = ?
    `).all(
      projectId,
      conversationId,
      input.mainAttemptId,
      input.previousGraphScopeId,
      input.previousGraphScopeId,
    ) as SqliteRow[];
    if (mainLineage.length !== 1) {
      throw new Error("Planning graph transition requires the exact accepting Main attempt lineage.");
    }
    const plannerLineage = this.db.prepare(`
      SELECT attempts.attempt_id AS attemptId
      FROM provider_thread_links links
      JOIN provider_attempts attempts
        ON attempts.project_id = links.project_id AND attempts.attempt_id = links.attempt_id
      WHERE links.project_id = ? AND links.conversation_id = ?
        AND links.provider_thread_id = ? AND links.role_id = 'planning-agent'
        AND links.graph_scope_id = ?
        AND attempts.conversation_id = links.conversation_id
        AND attempts.role_id = 'planning-agent' AND attempts.graph_scope_id = ?
    `).all(
      projectId,
      conversationId,
      input.plannerThreadId,
      input.previousGraphScopeId,
      input.previousGraphScopeId,
    ) as SqliteRow[];
    if (plannerLineage.length !== 1) {
      throw new Error("Planning graph transition requires the exact Planning thread lineage.");
    }
    const plannerAttemptId = String(plannerLineage[0]!.attemptId);
    const moveAttempt = this.db.prepare(`
      UPDATE provider_attempts SET graph_scope_id = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND attempt_id = ?
        AND graph_scope_id = ? AND role_id = ?
    `);
    const moveLink = this.db.prepare(`
      UPDATE provider_thread_links SET graph_scope_id = ?, updated_at = ?
      WHERE project_id = ? AND conversation_id = ? AND attempt_id = ?
        AND graph_scope_id = ? AND role_id = ?
    `);
    for (const lineage of [
      { attemptId: input.mainAttemptId, roleId: "main-agent" },
      { attemptId: plannerAttemptId, roleId: "planning-agent" },
    ]) {
      const attemptResult = moveAttempt.run(
        input.graphScopeId,
        updatedAt,
        projectId,
        conversationId,
        lineage.attemptId,
        input.previousGraphScopeId,
        lineage.roleId,
      );
      const linkResult = moveLink.run(
        input.graphScopeId,
        updatedAt,
        projectId,
        conversationId,
        lineage.attemptId,
        input.previousGraphScopeId,
        lineage.roleId,
      );
      if (attemptResult.changes !== 1 || linkResult.changes !== 1) {
        throw new Error(`Planning graph transition lost ${lineage.roleId} lineage ownership.`);
      }
    }
  }

readProviderThread(projectId: string, conversationId: string, providerId: ProviderId, roleId: string): StoredProviderThreadLink | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, attempt_id AS attemptId,
        provider_id AS providerId, provider_thread_id AS providerThreadId, role_id AS roleId,
        parent_thread_id AS parentThreadId, parent_agent_surface_id AS parentAgentSurfaceId,
        change_id AS changeId, graph_scope_id AS graphScopeId,
        capability_profile AS capabilityProfile, display_name AS displayName, run_id AS runId, updated_at AS updatedAt
      FROM provider_thread_links
      WHERE project_id = ? AND conversation_id = ? AND provider_id = ? AND role_id = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(projectId, conversationId, providerId, roleId) as SqliteRow | undefined;
    return row ? mapProviderThreadRow(row) : null;
  }

readConversationProviderBinding(projectId: string, conversationId: string, providerId: ProviderId): StoredConversationProviderBinding | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, provider_id AS providerId,
        native_session_id AS nativeSessionId, last_delivered_completed_turn AS lastDeliveredCompletedTurn,
        preferred_model_json AS preferredModelJson, last_used_at AS lastUsedAt,
        binding_status AS bindingStatus
      FROM conversation_provider_bindings
      WHERE project_id = ? AND conversation_id = ? AND provider_id = ?
    `).get(projectId, conversationId, providerId) as SqliteRow | undefined;
    return row ? mapConversationProviderBindingRow(row) : null;
  }

writeConversationProviderBinding(binding: StoredConversationProviderBinding): void {
    this.db.prepare(`
      INSERT INTO conversation_provider_bindings (
        project_id, conversation_id, provider_id, native_session_id,
        last_delivered_completed_turn, preferred_model_json, last_used_at, binding_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, conversation_id, provider_id) DO UPDATE SET
        native_session_id = excluded.native_session_id,
        last_delivered_completed_turn = excluded.last_delivered_completed_turn,
        preferred_model_json = excluded.preferred_model_json,
        last_used_at = excluded.last_used_at,
        binding_status = excluded.binding_status
    `).run(
      binding.projectId,
      binding.conversationId,
      binding.providerId,
      binding.nativeSessionId,
      binding.lastDeliveredCompletedTurn,
      binding.preferredModel ? JSON.stringify(binding.preferredModel) : null,
      binding.lastUsedAt,
      binding.bindingStatus,
    );
  }

createProviderAttempt(
  attempt: Omit<StoredProviderAttempt, "productMode" | "agentTurnMode" | "effectiveSkillInputs" | "reasoningEffort" | "operationKind">
    & Partial<Pick<StoredProviderAttempt, "productMode" | "agentTurnMode" | "effectiveSkillInputs" | "reasoningEffort" | "operationKind">>,
): void {
    const executionContract = attempt.executionContract ?? legacyExecutionContract();
    let productMode = attempt.productMode;
    if (attempt.conversationId) {
      const conversation = this.db.prepare(`
        SELECT product_mode AS productMode, agent_turn_mode AS agentTurnMode
        FROM conversations
        WHERE project_id = ? AND conversation_id = ? AND deleted_at IS NULL
      `).get(attempt.projectId, attempt.conversationId) as SqliteRow | undefined;
      if (!conversation) throw new Error(`Conversation not found for Provider attempt: ${attempt.conversationId}.`);
      const storedMode = assertProductMode(conversation.productMode, "Stored Conversation productMode");
      if (productMode && productMode !== storedMode) {
        throw new Error(`Provider attempt mode does not match Conversation: ${attempt.attemptId}.`);
      }
      productMode = storedMode;
    } else if (productMode !== "harness") {
      throw new Error("Provider attempts without a Conversation must explicitly use harness mode.");
    }
    const accessPolicy = parseAgentAccessPolicy(attempt.accessPolicy);
    if (accessPolicy && (productMode !== "agent" || attempt.operationKind === "review")) {
      throw new Error("Agent access evidence is not applicable to this execution.");
    }
    const columns = `(
      project_id, conversation_id, attempt_id, product_mode, agent_turn_mode, graph_scope_id, provider_id,
      change_id, agent_task_id, role_id, parent_agent_surface_id, operation_profile, operation_kind,
      execution_contract_family, execution_contract_epoch, execution_policy_hash, provider_adapter_version,
      native_session_id, model_json, reasoning_effort, capability_snapshot_json, effective_skill_inputs_json, handoff_hash,
      delivered_through_completed_turn, worktree_id, status, created_at, updated_at, access_policy_json
    )`;
    const values = [
      attempt.projectId,
      attempt.conversationId,
      attempt.attemptId,
      productMode,
      attempt.operationKind === "review" ? null : attempt.agentTurnMode ?? (productMode === "agent" ? "default" : null),
      attempt.graphScopeId,
      attempt.providerId,
      attempt.changeId,
      attempt.agentTaskId,
      attempt.roleId,
      attempt.parentAgentSurfaceId,
      attempt.operationProfile,
      attempt.operationKind ?? "conversation-turn",
      executionContract.family,
      executionContract.epoch,
      executionContract.policyHash,
      executionContract.providerAdapterVersion,
      attempt.nativeSessionId,
      attempt.model ? JSON.stringify(attempt.model) : null,
      attempt.reasoningEffort ?? null,
      JSON.stringify(attempt.capabilitySnapshot),
      JSON.stringify(attempt.effectiveSkillInputs ?? []),
      attempt.handoffHash,
      attempt.deliveredThroughCompletedTurn,
      attempt.worktreeId,
      attempt.status,
      attempt.createdAt,
      attempt.updatedAt,
      accessPolicy ? JSON.stringify(accessPolicy) : null,
    ] as const;
    if (!attempt.conversationId) {
      this.db.prepare(`INSERT INTO provider_attempts ${columns} VALUES (${values.map(() => "?").join(", ")})`).run(...values);
      return;
    }
    const inserted = this.db.prepare(`
      INSERT INTO provider_attempts ${columns}
      SELECT ${values.map(() => "?").join(", ")}
      FROM conversations conversation
      WHERE conversation.project_id = ? AND conversation.conversation_id = ?
        AND conversation.state = 'active' AND conversation.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation_lifecycle_operations lifecycle
          WHERE lifecycle.project_id = conversation.project_id
            AND lifecycle.conversation_id = conversation.conversation_id
            AND lifecycle.status IN ('pending', 'submitting')
        )
    `).run(...values, attempt.projectId, attempt.conversationId);
    if (inserted.changes !== 1) {
      const error = new Error("Conversation is not active or has a lifecycle operation in progress.");
      error.name = "Conflict";
      throw error;
    }
  }

deleteProviderAttempt(projectId: string, attemptId: string, expectedRoleId: string): boolean {
  return this.db.transaction(() => {
    const attempt = this.db.prepare("SELECT role_id AS roleId FROM provider_attempts WHERE project_id = ? AND attempt_id = ?")
      .get(projectId, attemptId) as SqliteRow | undefined;
    if (!attempt) return false;
    if (String(attempt.roleId) !== expectedRoleId) {
      throw new Error(`Provider attempt rollback role mismatch: ${attemptId}.`);
    }
    this.db.prepare("DELETE FROM provider_thread_links WHERE project_id = ? AND attempt_id = ?")
      .run(projectId, attemptId);
    return this.db.prepare("DELETE FROM provider_attempts WHERE project_id = ? AND attempt_id = ?")
      .run(projectId, attemptId).changes === 1;
  })();
}

deleteConversationRuntimeState(projectId: string, conversationId: string): void {
  this.db.prepare("DELETE FROM provider_thread_links WHERE project_id = ? AND conversation_id = ?")
    .run(projectId, conversationId);
  this.db.prepare("DELETE FROM conversation_provider_bindings WHERE project_id = ? AND conversation_id = ?")
    .run(projectId, conversationId);
  this.db.prepare("DELETE FROM provider_attempts WHERE project_id = ? AND conversation_id = ?")
    .run(projectId, conversationId);
  this.db.prepare("DELETE FROM provider_resume_points WHERE project_id = ? AND conversation_id = ?")
    .run(projectId, conversationId);
}

startQueuedProviderAttempt(
    projectId: string,
    attemptId: string,
    input: Omit<Pick<StoredProviderAttempt, "capabilitySnapshot" | "effectiveSkillInputs" | "handoffHash" | "deliveredThroughCompletedTurn" | "model" | "reasoningEffort" | "updatedAt">, "reasoningEffort">
      & Partial<Pick<StoredProviderAttempt, "reasoningEffort">>,
  ): void {
    const result = this.db.prepare(`
      UPDATE provider_attempts
      SET status = 'running', capability_snapshot_json = ?, handoff_hash = ?,
          delivered_through_completed_turn = ?, model_json = ?, reasoning_effort = ?,
          effective_skill_inputs_json = ?, updated_at = ?
      WHERE project_id = ? AND attempt_id = ? AND status = 'queued'
    `).run(
      JSON.stringify(input.capabilitySnapshot),
      input.handoffHash,
      input.deliveredThroughCompletedTurn,
      input.model ? JSON.stringify(input.model) : null,
      input.reasoningEffort ?? null,
      JSON.stringify(input.effectiveSkillInputs),
      input.updatedAt,
      projectId,
      attemptId,
    );
    if (result.changes !== 1) throw new Error(`Queued provider attempt is no longer claimable: ${attemptId}.`);
  }

completeProviderAttempt(projectId: string, attemptId: string, status: StoredProviderAttempt["status"], nativeSessionId: string | null, updatedAt: string): void {
    const result = this.db.prepare(`
      UPDATE provider_attempts
      SET status = CASE WHEN status = 'terminated' THEN 'terminated' ELSE ? END,
          native_session_id = COALESCE(?, native_session_id), updated_at = ?
      WHERE project_id = ? AND attempt_id = ?
    `).run(status, nativeSessionId, updatedAt, projectId, attemptId);
    if (result.changes !== 1) throw new Error(`Provider attempt not found: ${attemptId}`);
  }

  readProviderAttempt(projectId: string, attemptId: string): StoredProviderAttempt | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, attempt_id AS attemptId,
        product_mode AS productMode, agent_turn_mode AS agentTurnMode,
        graph_scope_id AS graphScopeId, provider_id AS providerId, native_session_id AS nativeSessionId,
        change_id AS changeId, agent_task_id AS agentTaskId, role_id AS roleId,
        parent_agent_surface_id AS parentAgentSurfaceId, operation_profile AS operationProfile,
        operation_kind AS operationKind,
        execution_contract_family AS executionContractFamily,
        execution_contract_epoch AS executionContractEpoch,
        execution_policy_hash AS executionPolicyHash,
        provider_adapter_version AS providerAdapterVersion,
        model_json AS modelJson, reasoning_effort AS reasoningEffort, capability_snapshot_json AS capabilitySnapshotJson,
        effective_skill_inputs_json AS effectiveSkillInputsJson, access_policy_json AS accessPolicyJson,
        handoff_hash AS handoffHash, delivered_through_completed_turn AS deliveredThroughCompletedTurn,
        worktree_id AS worktreeId, status, created_at AS createdAt, updated_at AS updatedAt
      FROM provider_attempts WHERE project_id = ? AND attempt_id = ?
    `).get(projectId, attemptId) as SqliteRow | undefined;
    return row ? mapProviderAttemptRow(row) : null;
  }

  assertCurrentRunningAttemptGraph(
    projectId: string,
    conversationId: string,
    attemptId: string,
    graphScopeId: string,
    failureMessage = "Provider terminal callback no longer owns the current conversation graph.",
  ): void {
    this.assertCurrentAttemptGraph(
      projectId,
      conversationId,
      attemptId,
      graphScopeId,
      { requireRunning: true, failureMessage },
    );
  }

  assertCurrentAttemptGraph(
    projectId: string,
    conversationId: string,
    attemptId: string,
    graphScopeId: string,
    options: { requireRunning?: boolean; allowTerminated?: boolean; failureMessage?: string } = {},
  ): void {
    const lineage = this.db.prepare(`
      SELECT conversations.current_graph_scope_id AS currentGraphScopeId,
        conversations.state AS conversationState,
        attempts.graph_scope_id AS attemptGraphScopeId, attempts.status AS attemptStatus
      FROM conversations
      JOIN provider_attempts attempts
        ON attempts.project_id = conversations.project_id
        AND attempts.conversation_id = conversations.conversation_id
        AND attempts.attempt_id = ?
      WHERE conversations.project_id = ? AND conversations.conversation_id = ?
        AND conversations.deleted_at IS NULL
    `).get(attemptId, projectId, conversationId) as SqliteRow | undefined;
    if (!lineage
      || String(lineage.conversationState) !== "active"
      || nullableString(lineage.currentGraphScopeId) !== graphScopeId
      || nullableString(lineage.attemptGraphScopeId) !== graphScopeId
      || (options.requireRunning
        ? String(lineage.attemptStatus) !== "running"
        : !options.allowTerminated && String(lineage.attemptStatus) === "terminated")) {
      throw new Error(options.failureMessage ?? "Provider callback no longer owns the current conversation graph.");
    }
  }

bindProviderAttemptThread(
    projectId: string,
    input: {
      attemptId: string;
      threadId: string;
      parentThreadId?: string | null;
      parentAgentSurfaceId?: string | null;
      displayName?: string | null;
      runId?: string | null;
    },
    updatedAt: string,
  ): StoredProviderThreadLink {
    return this.db.transaction(() => {
      const attemptRow = this.db.prepare(`
        SELECT project_id AS projectId, conversation_id AS conversationId, attempt_id AS attemptId,
          graph_scope_id AS graphScopeId, provider_id AS providerId, native_session_id AS nativeSessionId,
          change_id AS changeId, role_id AS roleId, parent_agent_surface_id AS parentAgentSurfaceId,
          operation_profile AS operationProfile, status
        FROM provider_attempts
        WHERE project_id = ? AND attempt_id = ?
      `).get(projectId, input.attemptId) as SqliteRow | undefined;
      if (!attemptRow) throw new Error(`Provider attempt not found: ${input.attemptId}`);

      const conversationId = nullableString(attemptRow.conversationId);
      if (!conversationId) throw new Error(`Provider attempt cannot bind a thread without a conversation: ${input.attemptId}`);
      const attemptStatus = String(attemptRow.status);
      if (attemptStatus !== "queued" && attemptStatus !== "running") {
        throw new Error(`Provider attempt cannot bind a thread after it is terminal: ${input.attemptId}`);
      }
      const nativeSessionId = nullableString(attemptRow.nativeSessionId);
      if (nativeSessionId && nativeSessionId !== input.threadId) {
        throw new Error(`Provider attempt is already bound to another thread: ${input.attemptId}`);
      }

      const attemptLink = this.db.prepare(`
        SELECT provider_thread_id AS providerThreadId
        FROM provider_thread_links
        WHERE project_id = ? AND attempt_id = ?
      `).get(projectId, input.attemptId) as SqliteRow | undefined;
      if (attemptLink && String(attemptLink.providerThreadId) !== input.threadId) {
        throw new Error(`Provider attempt is already bound to another thread: ${input.attemptId}`);
      }

      const providerId = String(attemptRow.providerId);
      const roleId = String(attemptRow.roleId);
      const graphScopeId = nullableString(attemptRow.graphScopeId);
      const conversation = this.db.prepare(`
        SELECT current_graph_scope_id AS currentGraphScopeId, deleted_at AS deletedAt
        FROM conversations WHERE project_id = ? AND conversation_id = ?
      `).get(projectId, conversationId) as SqliteRow | undefined;
      if (!conversation || nullableString(conversation.deletedAt)
        || !graphScopeId
        || nullableString(conversation.currentGraphScopeId) !== graphScopeId) {
        throw new Error(`Provider attempt no longer belongs to the current conversation graph: ${input.attemptId}`);
      }
      const existingThread = this.db.prepare(`
        SELECT links.conversation_id AS conversationId, links.attempt_id AS attemptId, links.provider_id AS providerId,
          links.role_id AS roleId, links.parent_thread_id AS parentThreadId,
          links.parent_agent_surface_id AS parentAgentSurfaceId, links.graph_scope_id AS graphScopeId,
          attempts.status AS attemptStatus
        FROM provider_thread_links links
        JOIN provider_attempts attempts
          ON attempts.project_id = links.project_id AND attempts.attempt_id = links.attempt_id
        WHERE links.project_id = ? AND links.provider_id = ? AND links.provider_thread_id = ?
      `).get(projectId, providerId, input.threadId) as SqliteRow | undefined;
      const parentThreadId = input.parentThreadId === undefined && existingThread
        ? nullableString(existingThread.parentThreadId)
        : input.parentThreadId ?? null;
      const persistedParentAgentSurfaceId = nullableString(attemptRow.parentAgentSurfaceId);
      if (persistedParentAgentSurfaceId
        && input.parentAgentSurfaceId !== undefined
        && input.parentAgentSurfaceId !== persistedParentAgentSurfaceId) {
        throw new Error(`Provider thread conflicts with attempt Agent surface lineage: ${input.attemptId}`);
      }
      const requestedParentAgentSurfaceId = persistedParentAgentSurfaceId
        ?? (input.parentAgentSurfaceId === undefined && existingThread
          ? nullableString(existingThread.parentAgentSurfaceId)
          : input.parentAgentSurfaceId);
      const parentAgentSurfaceId = resolveParentAgentSurfaceId({
        db: this.db,
        projectId,
        conversationId,
        providerId,
        roleId,
        graphScopeId,
        parentThreadId,
        requestedParentAgentSurfaceId,
      });
      if (existingThread && (
        String(existingThread.conversationId) !== conversationId
        || String(existingThread.providerId) !== providerId
        || String(existingThread.roleId) !== roleId
        || nullableString(existingThread.parentThreadId) !== parentThreadId
        || nullableString(existingThread.parentAgentSurfaceId) !== parentAgentSurfaceId
        || (roleId !== "main-agent" && nullableString(existingThread.graphScopeId) !== graphScopeId)
      )) {
        throw new Error(`Provider thread cannot resume with different lineage: ${input.threadId}`);
      }
      if (existingThread
        && String(existingThread.attemptId) !== input.attemptId
        && nullableString(existingThread.graphScopeId) === graphScopeId
        && ["queued", "running"].includes(String(existingThread.attemptStatus))) {
        throw new Error(`Provider thread is owned by another active attempt in the current graph: ${input.threadId}`);
      }

      this.db.prepare(`
        INSERT INTO provider_thread_links (
          project_id, conversation_id, attempt_id, provider_id, provider_thread_id, role_id,
          parent_thread_id, parent_agent_surface_id, change_id, graph_scope_id,
          capability_profile, display_name, run_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, provider_id, provider_thread_id) DO UPDATE SET
          attempt_id = excluded.attempt_id,
          change_id = excluded.change_id,
          graph_scope_id = excluded.graph_scope_id,
          capability_profile = excluded.capability_profile,
          display_name = COALESCE(excluded.display_name, provider_thread_links.display_name),
          run_id = excluded.run_id,
          updated_at = excluded.updated_at
      `).run(
        projectId,
        conversationId,
        input.attemptId,
        providerId,
        input.threadId,
        roleId,
        parentThreadId,
        parentAgentSurfaceId,
        nullableString(attemptRow.changeId),
        graphScopeId,
        String(attemptRow.operationProfile),
        input.displayName ?? null,
        input.runId ?? input.attemptId,
        updatedAt,
      );
      this.db.prepare(`
        UPDATE provider_attempts SET native_session_id = ?, updated_at = ?
        WHERE project_id = ? AND attempt_id = ?
      `).run(input.threadId, updatedAt, projectId, input.attemptId);

      const bound = this.db.prepare(`
        SELECT project_id AS projectId, conversation_id AS conversationId, attempt_id AS attemptId,
          provider_id AS providerId, provider_thread_id AS providerThreadId, role_id AS roleId,
          parent_thread_id AS parentThreadId, parent_agent_surface_id AS parentAgentSurfaceId,
          change_id AS changeId, graph_scope_id AS graphScopeId,
          capability_profile AS capabilityProfile, display_name AS displayName, run_id AS runId, updated_at AS updatedAt
        FROM provider_thread_links
        WHERE project_id = ? AND provider_id = ? AND provider_thread_id = ?
      `).get(projectId, providerId, input.threadId) as SqliteRow;
      return mapProviderThreadRow(bound);
    })();
  }

listProviderAttempts(projectId: string, conversationId: string): StoredProviderAttempt[] {
    const rows = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, attempt_id AS attemptId,
        product_mode AS productMode, agent_turn_mode AS agentTurnMode,
        graph_scope_id AS graphScopeId, provider_id AS providerId, native_session_id AS nativeSessionId,
        change_id AS changeId, agent_task_id AS agentTaskId, role_id AS roleId,
        parent_agent_surface_id AS parentAgentSurfaceId, operation_profile AS operationProfile,
        operation_kind AS operationKind,
        execution_contract_family AS executionContractFamily,
        execution_contract_epoch AS executionContractEpoch,
        execution_policy_hash AS executionPolicyHash,
        provider_adapter_version AS providerAdapterVersion,
        model_json AS modelJson, reasoning_effort AS reasoningEffort, capability_snapshot_json AS capabilitySnapshotJson,
        effective_skill_inputs_json AS effectiveSkillInputsJson, access_policy_json AS accessPolicyJson,
        handoff_hash AS handoffHash, delivered_through_completed_turn AS deliveredThroughCompletedTurn,
        worktree_id AS worktreeId, status, created_at AS createdAt, updated_at AS updatedAt
      FROM provider_attempts
      WHERE project_id = ? AND conversation_id = ?
      ORDER BY created_at ASC
    `).all(projectId, conversationId) as SqliteRow[];
    return rows.map(mapProviderAttemptRow);
  }

writeProviderResumePoint(point: StoredProviderResumePoint): void {
    this.db.prepare(`
      INSERT INTO provider_resume_points (
        project_id, conversation_id, resume_point_id, graph_scope_id, change_id,
        previous_provider_id, target_provider_id, snapshot_json, snapshot_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      point.projectId,
      point.conversationId,
      point.resumePointId,
      point.graphScopeId,
      point.changeId,
      point.previousProviderId,
      point.targetProviderId,
      point.snapshotJson,
      point.snapshotHash,
      point.createdAt,
    );
  }

readLatestProviderResumePoint(projectId: string, conversationId: string): StoredProviderResumePoint | null {
    const row = this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, resume_point_id AS resumePointId,
        graph_scope_id AS graphScopeId, change_id AS changeId, previous_provider_id AS previousProviderId,
        target_provider_id AS targetProviderId, snapshot_json AS snapshotJson, snapshot_hash AS snapshotHash,
        created_at AS createdAt
      FROM provider_resume_points
      WHERE project_id = ? AND conversation_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(projectId, conversationId) as SqliteRow | undefined;
    return row ? mapProviderResumePointRow(row) : null;
  }

listProviderThreads(projectId: string, conversationId: string): StoredProviderThreadLink[] {
    return (this.db.prepare(`
      SELECT project_id AS projectId, conversation_id AS conversationId, attempt_id AS attemptId,
        provider_id AS providerId, provider_thread_id AS providerThreadId, role_id AS roleId,
        parent_thread_id AS parentThreadId, parent_agent_surface_id AS parentAgentSurfaceId,
        change_id AS changeId, graph_scope_id AS graphScopeId,
        capability_profile AS capabilityProfile, display_name AS displayName, run_id AS runId, updated_at AS updatedAt
      FROM provider_thread_links
      WHERE project_id = ? AND conversation_id = ?
      ORDER BY updated_at ASC
    `).all(projectId, conversationId) as SqliteRow[]).map(mapProviderThreadRow);
  }
}

function resolveParentAgentSurfaceId(input: {
  db: Database.Database;
  projectId: string;
  conversationId: string;
  providerId: string;
  roleId: string;
  graphScopeId: string | null;
  parentThreadId: string | null;
  requestedParentAgentSurfaceId: string | null | undefined;
}): string | null {
  if (input.roleId === "main-agent") {
    if (input.parentThreadId || input.requestedParentAgentSurfaceId) {
      throw new Error("Main Agent thread cannot have parent lineage.");
    }
    return null;
  }
  if (!input.graphScopeId) throw new Error("Non-Main Agent thread requires a graph scope.");
  if (!input.parentThreadId) {
    if (input.requestedParentAgentSurfaceId !== "main-agent") {
      throw new Error("Top-level model worker requires explicit main-agent parent lineage.");
    }
    return "main-agent";
  }
  const parent = input.db.prepare(`
    SELECT conversation_id AS conversationId, role_id AS roleId,
      provider_thread_id AS providerThreadId, graph_scope_id AS graphScopeId
    FROM provider_thread_links
    WHERE project_id = ? AND provider_id = ? AND provider_thread_id = ?
  `).get(input.projectId, input.providerId, input.parentThreadId) as SqliteRow | undefined;
  if (!parent
    || String(parent.conversationId) !== input.conversationId
    || nullableString(parent.graphScopeId) !== input.graphScopeId) {
    throw new Error(`Provider parent thread has no exact Agent surface in the current graph scope: ${input.parentThreadId}`);
  }
  const resolved = String(parent.roleId) === "main-agent"
    ? "main-agent"
    : agentThreadSurfaceId(input.providerId, String(parent.providerThreadId));
  if (input.requestedParentAgentSurfaceId !== undefined
    && input.requestedParentAgentSurfaceId !== resolved) {
    throw new Error(`Provider parent thread conflicts with canonical Agent surface lineage: ${input.parentThreadId}`);
  }
  return resolved;
}
