import type Database from "better-sqlite3";
import type { SqliteRow } from "./sql-mappers.js";

export const WORKBENCH_SCHEMA_VERSION = 21;

export function applyCurrentWorkbenchSchema(db: Database.Database): void {
  applyWorkbenchSchema20(db);
  applyWorkbenchAccessSchema21(db);
}

/** Fixed additive contract used by the 20 -> 21 migration and new databases. */
export function applyWorkbenchAccessSchema21(db: Database.Database): void {
  ensureColumn(db, "conversations", "agent_access_mode", "TEXT CHECK(agent_access_mode IS NULL OR (product_mode = 'agent' AND agent_access_mode IN ('default', 'full-access')))");
  ensureColumn(db, "conversations", "agent_access_revision", "INTEGER NOT NULL DEFAULT 0 CHECK(agent_access_revision >= 0)");
  ensureColumn(db, "conversation_turn_queue_items", "agent_access_mode", "TEXT CHECK(agent_access_mode IS NULL OR (product_mode = 'agent' AND item_kind = 'conversation-turn' AND agent_access_mode IN ('default', 'full-access')))");
  ensureColumn(db, "provider_attempts", "access_policy_json", "TEXT");
}

/** Historical Schema 20 builder. Do not extend this with later schema fields. */
export function applyWorkbenchSchema20(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS bridge_sync; DROP TABLE IF EXISTS skills;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS canonical_timeline_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT '',
      change_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      agent_surface_id TEXT NOT NULL,
      initial_thread_input INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      text TEXT,
      action_run_id TEXT,
      action_type TEXT,
      status TEXT,
      run_id TEXT,
      provider_id TEXT,
      thread_id TEXT,
      turn_id TEXT,
      item_id TEXT,
      artifact TEXT,
      error TEXT,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_change ON canonical_timeline_items(project_id, change_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_conversation_position
      ON canonical_timeline_items(project_id, conversation_id, position);
    CREATE INDEX IF NOT EXISTS idx_timeline_surface_position
      ON canonical_timeline_items(project_id, conversation_id, agent_surface_id, position);

    CREATE TABLE IF NOT EXISTS conversations (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness')),
      agent_turn_mode TEXT CHECK(agent_turn_mode IN ('default', 'plan') OR agent_turn_mode IS NULL),
      agent_model_id TEXT,
      agent_reasoning_effort TEXT,
      client_create_request_id TEXT,
      client_create_request_hash TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      archive_origin TEXT CHECK(archive_origin IN ('agent-user', 'harness-workflow') OR archive_origin IS NULL),
      archived_at TEXT,
      lifecycle_revision INTEGER NOT NULL DEFAULT 0,
      surface_kind TEXT NOT NULL DEFAULT 'user',
      bound_change_id TEXT,
      current_graph_scope_id TEXT,
      selected_provider_id TEXT NOT NULL,
      completed_turn_sequence INTEGER NOT NULL DEFAULT 0,
      timeline_position INTEGER NOT NULL DEFAULT 0,
      timeline_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY(project_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_project_updated ON conversations(project_id, deleted_at, updated_at);

    CREATE TABLE IF NOT EXISTS conversation_lifecycle_operations (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness')),
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('archive', 'restore', 'delete')),
      expected_lifecycle_revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'submitting', 'completed', 'failed', 'interrupted')),
      provider_id TEXT,
      provider_binding_hash TEXT,
      provider_sync_status TEXT NOT NULL CHECK(provider_sync_status IN ('not-required', 'unsupported', 'submitting', 'completed', 'failed', 'uncertain')),
      diagnostic TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_lifecycle_operations_conversation
      ON conversation_lifecycle_operations(project_id, conversation_id, updated_at);

    CREATE TABLE IF NOT EXISTS action_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_runs_topic ON action_runs(project_id, change_id, started_at);

    CREATE TABLE IF NOT EXISTS provider_thread_links (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      parent_thread_id TEXT,
      parent_agent_surface_id TEXT,
      change_id TEXT,
      graph_scope_id TEXT,
      capability_profile TEXT,
      display_name TEXT,
      run_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, provider_id, provider_thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_threads_conversation_role
      ON provider_thread_links(project_id, conversation_id, provider_id, role_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_threads_attempt
      ON provider_thread_links(project_id, attempt_id)
      WHERE attempt_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS conversation_provider_bindings (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      native_session_id TEXT,
      last_delivered_completed_turn INTEGER NOT NULL DEFAULT 0,
      preferred_model_json TEXT,
      last_used_at TEXT,
      binding_status TEXT NOT NULL,
      PRIMARY KEY(project_id, conversation_id, provider_id)
    );

    CREATE TABLE IF NOT EXISTS provider_attempts (
      project_id TEXT NOT NULL,
      conversation_id TEXT,
      attempt_id TEXT NOT NULL,
      product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness')),
      agent_turn_mode TEXT CHECK(agent_turn_mode IN ('default', 'plan') OR agent_turn_mode IS NULL),
      graph_scope_id TEXT,
      provider_id TEXT NOT NULL,
      change_id TEXT,
      agent_task_id TEXT,
      role_id TEXT NOT NULL,
      parent_agent_surface_id TEXT,
      operation_profile TEXT NOT NULL,
      execution_contract_family TEXT NOT NULL DEFAULT 'legacy-v0',
      execution_contract_epoch INTEGER NOT NULL DEFAULT 0,
      execution_policy_hash TEXT,
      provider_adapter_version TEXT,
      native_session_id TEXT,
      model_json TEXT,
      reasoning_effort TEXT,
      capability_snapshot_json TEXT NOT NULL,
      effective_skill_inputs_json TEXT NOT NULL DEFAULT '[]',
      handoff_hash TEXT NOT NULL,
      delivered_through_completed_turn INTEGER NOT NULL,
      worktree_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(conversation_id IS NOT NULL OR product_mode = 'harness'),
      PRIMARY KEY(project_id, attempt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_attempts_conversation
      ON provider_attempts(project_id, conversation_id, graph_scope_id, updated_at);

    CREATE TABLE IF NOT EXISTS provider_resume_points (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      resume_point_id TEXT NOT NULL,
      graph_scope_id TEXT,
      change_id TEXT,
      previous_provider_id TEXT NOT NULL,
      target_provider_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(project_id, resume_point_id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_resume_points_conversation
      ON provider_resume_points(project_id, conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS conversation_change_links (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      graph_scope_id TEXT,
      linked_at TEXT NOT NULL,
      PRIMARY KEY(project_id, conversation_id, change_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_graph_scopes (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      graph_scope_id TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, graph_scope_id)
    );

    CREATE TABLE IF NOT EXISTS planning_acceptance_commits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      change_id TEXT NOT NULL,
      graph_scope_id TEXT,
      proposal_hash TEXT NOT NULL,
      committed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_roots (
      project_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, root_path)
    );

    CREATE TABLE IF NOT EXISTS skill_enablement (
      project_id TEXT NOT NULL,
      change_id TEXT NOT NULL DEFAULT '',
      skill_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, change_id, skill_id, scope)
    );

    CREATE TABLE IF NOT EXISTS composer_drafts (
      project_id TEXT NOT NULL,
      product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness')),
      agent_turn_mode TEXT CHECK(agent_turn_mode IN ('default', 'plan') OR agent_turn_mode IS NULL),
      agent_model_id TEXT,
      agent_reasoning_effort TEXT,
      text TEXT NOT NULL DEFAULT '',
      context_refs_json TEXT NOT NULL DEFAULT '[]',
      attachment_ids_json TEXT NOT NULL DEFAULT '[]',
      skill_overrides_json TEXT NOT NULL DEFAULT '[]',
      selected_provider_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, product_mode)
    );

    CREATE TABLE IF NOT EXISTS approval_cache (
      project_id TEXT NOT NULL,
      change_id TEXT,
      approval_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, approval_id)
    );

    CREATE TABLE IF NOT EXISTS decision_records (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      change_id TEXT NOT NULL DEFAULT '',
      decision_type TEXT NOT NULL,
      status TEXT NOT NULL,
      label TEXT NOT NULL,
      summary TEXT NOT NULL,
      target_id TEXT,
      run_id TEXT,
      artifact TEXT,
      action_id TEXT,
      feedback TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY(project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_records_topic ON decision_records(project_id, change_id, updated_at);

    CREATE TABLE IF NOT EXISTS conversation_fork_operations (
      project_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      target_conversation_id TEXT,
      provider_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      anchor_completed_turn_sequence INTEGER NOT NULL,
      expected_timeline_revision INTEGER NOT NULL,
      context_revision TEXT NOT NULL,
      source_graph_scope_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'submitting', 'completed', 'failed', 'interrupted')),
      diagnostic TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_fork_source
      ON conversation_fork_operations(project_id, source_conversation_id, updated_at);

    CREATE TABLE IF NOT EXISTS conversation_turn_queues (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness')),
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS conversation_turn_queue_items (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness')),
      queue_item_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'dispatching', 'blocked', 'dispatched', 'cancelled')),
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 1),
      predecessor_execution_revision TEXT NOT NULL,
      dispatch_request_id TEXT NOT NULL,
      execution_contract_family TEXT NOT NULL DEFAULT 'legacy-v0',
      execution_contract_epoch INTEGER NOT NULL DEFAULT 0,
      item_kind TEXT NOT NULL DEFAULT 'conversation-turn' CHECK(item_kind IN ('conversation-turn', 'review')),
      review_target_json TEXT,
      text TEXT NOT NULL,
      context_refs_json TEXT NOT NULL DEFAULT '[]',
      attachment_ids_json TEXT NOT NULL DEFAULT '[]',
      skill_overrides_json TEXT NOT NULL DEFAULT '{}',
      provider_id TEXT NOT NULL,
      agent_turn_mode TEXT CHECK(agent_turn_mode IN ('default', 'plan') OR agent_turn_mode IS NULL),
      agent_model_id TEXT,
      agent_reasoning_effort TEXT,
      diagnostic TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dispatched_at TEXT,
      PRIMARY KEY(project_id, queue_item_id),
      UNIQUE(project_id, conversation_id, client_request_id),
      UNIQUE(project_id, conversation_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_turn_queue_active
      ON conversation_turn_queue_items(project_id, conversation_id, status, position);

    CREATE TABLE IF NOT EXISTS conversation_turn_queue_contract_confirmations (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      queue_item_id TEXT NOT NULL,
      prior_family TEXT NOT NULL,
      prior_epoch INTEGER NOT NULL,
      target_family TEXT NOT NULL,
      target_epoch INTEGER NOT NULL,
      client_request_id TEXT NOT NULL,
      expected_revision TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      PRIMARY KEY(project_id, queue_item_id, target_family, target_epoch),
      UNIQUE(project_id, conversation_id, client_request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_queue_contract_confirmation_item
      ON conversation_turn_queue_contract_confirmations(project_id, conversation_id, queue_item_id);

    CREATE TABLE IF NOT EXISTS conversation_review_operations (
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      graph_scope_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      review_target_json TEXT NOT NULL,
      git_admission_json TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'submitting', 'reviewing', 'completed', 'failed', 'interrupted')),
      session_binding_hash TEXT,
      turn_identity_hash TEXT,
      source TEXT NOT NULL CHECK(source IN ('direct', 'queue')),
      diagnostic TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, client_request_id),
      UNIQUE(project_id, attempt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_review_active
      ON conversation_review_operations(project_id, conversation_id, status, updated_at);
  `);
  ensureColumn(db, "provider_attempts", "parent_agent_surface_id", "TEXT");
  ensureColumn(db, "conversations", "agent_turn_mode", "TEXT");
  ensureColumn(db, "provider_attempts", "agent_turn_mode", "TEXT");
  ensureColumn(db, "composer_drafts", "agent_turn_mode", "TEXT");
  ensureColumn(db, "conversations", "agent_model_id", "TEXT");
  ensureColumn(db, "conversations", "agent_reasoning_effort", "TEXT");
  ensureColumn(db, "provider_attempts", "reasoning_effort", "TEXT");
  ensureColumn(db, "provider_attempts", "operation_kind", "TEXT NOT NULL DEFAULT 'conversation-turn' CHECK(operation_kind IN ('conversation-turn', 'review'))");
  ensureColumn(db, "provider_attempts", "execution_contract_family", "TEXT NOT NULL DEFAULT 'legacy-v0'");
  ensureColumn(db, "provider_attempts", "execution_contract_epoch", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "provider_attempts", "execution_policy_hash", "TEXT");
  ensureColumn(db, "provider_attempts", "provider_adapter_version", "TEXT");
  ensureColumn(db, "conversation_turn_queue_items", "item_kind", "TEXT NOT NULL DEFAULT 'conversation-turn' CHECK(item_kind IN ('conversation-turn', 'review'))");
  ensureColumn(db, "conversation_turn_queue_items", "review_target_json", "TEXT");
  ensureColumn(db, "conversation_turn_queue_items", "execution_contract_family", "TEXT NOT NULL DEFAULT 'legacy-v0'");
  ensureColumn(db, "conversation_turn_queue_items", "execution_contract_epoch", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "composer_drafts", "agent_model_id", "TEXT");
  ensureColumn(db, "composer_drafts", "agent_reasoning_effort", "TEXT");
  ensureColumn(db, "conversations", "product_mode", "TEXT NOT NULL DEFAULT 'harness' CHECK(product_mode IN ('agent', 'harness'))");
  ensureColumn(db, "conversations", "client_create_request_id", "TEXT");
  ensureColumn(db, "conversations", "client_create_request_hash", "TEXT");
  ensureColumn(db, "conversations", "archive_origin", "TEXT CHECK(archive_origin IN ('agent-user', 'harness-workflow') OR archive_origin IS NULL)");
  ensureColumn(db, "conversations", "archived_at", "TEXT");
  ensureColumn(db, "conversations", "lifecycle_revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "provider_attempts", "product_mode", "TEXT NOT NULL DEFAULT 'harness' CHECK(product_mode IN ('agent', 'harness'))");
  ensureColumn(db, "provider_attempts", "effective_skill_inputs_json", "TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
    UPDATE conversations SET agent_turn_mode = 'default'
    WHERE product_mode = 'agent' AND agent_turn_mode IS NULL;
    UPDATE provider_attempts SET agent_turn_mode = 'default'
    WHERE product_mode = 'agent' AND operation_kind = 'conversation-turn' AND agent_turn_mode IS NULL;
    UPDATE provider_attempts SET agent_turn_mode = NULL
    WHERE operation_kind = 'review';
    UPDATE composer_drafts SET agent_turn_mode = 'default'
    WHERE product_mode = 'agent' AND agent_turn_mode IS NULL;
    UPDATE conversations SET agent_turn_mode = NULL WHERE product_mode = 'harness';
    UPDATE provider_attempts SET agent_turn_mode = NULL WHERE product_mode = 'harness';
    UPDATE provider_attempts SET operation_kind = 'conversation-turn' WHERE operation_kind IS NULL;
    UPDATE conversation_turn_queue_items SET item_kind = 'conversation-turn' WHERE item_kind IS NULL;
    UPDATE composer_drafts SET agent_turn_mode = NULL WHERE product_mode = 'harness';
    UPDATE conversations SET archive_origin = CASE product_mode
      WHEN 'agent' THEN 'agent-user' ELSE 'harness-workflow' END,
      archived_at = COALESCE(archived_at, updated_at)
    WHERE state = 'archive' AND archive_origin IS NULL;
    UPDATE conversations SET archive_origin = NULL, archived_at = NULL WHERE state = 'active';
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_change_graph_scope
      ON conversation_change_links(project_id, graph_scope_id)
      WHERE graph_scope_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_change_change_id
      ON conversation_change_links(project_id, change_id);
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_timeline_conversation ON canonical_timeline_items(project_id, conversation_id, position);");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_project_mode_updated
      ON conversations(project_id, product_mode, deleted_at, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_project_create_request
      ON conversations(project_id, client_create_request_id)
      WHERE client_create_request_id IS NOT NULL;
    DROP TRIGGER IF EXISTS trg_conversations_product_mode_immutable;
    CREATE TRIGGER trg_conversations_product_mode_immutable
    BEFORE UPDATE OF product_mode ON conversations
    WHEN NEW.product_mode <> OLD.product_mode
    BEGIN
      SELECT RAISE(ABORT, 'Conversation product_mode is immutable');
    END;
    DROP TRIGGER IF EXISTS trg_conversations_archive_origin_insert;
    CREATE TRIGGER trg_conversations_archive_origin_insert
    BEFORE INSERT ON conversations
    WHEN (NEW.state = 'active' AND (NEW.archive_origin IS NOT NULL OR NEW.archived_at IS NOT NULL))
      OR (NEW.state = 'archive' AND (
        NEW.archived_at IS NULL
        OR (NEW.product_mode = 'agent' AND NEW.archive_origin <> 'agent-user')
        OR (NEW.product_mode = 'harness' AND NEW.archive_origin <> 'harness-workflow')
      ))
    BEGIN
      SELECT RAISE(ABORT, 'Conversation archive metadata must match lifecycle state and product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_conversations_archive_origin_update;
    CREATE TRIGGER trg_conversations_archive_origin_update
    BEFORE UPDATE OF state, archive_origin, archived_at, product_mode ON conversations
    WHEN (NEW.state = 'active' AND (NEW.archive_origin IS NOT NULL OR NEW.archived_at IS NOT NULL))
      OR (NEW.state = 'archive' AND (
        NEW.archived_at IS NULL
        OR (NEW.product_mode = 'agent' AND NEW.archive_origin <> 'agent-user')
        OR (NEW.product_mode = 'harness' AND NEW.archive_origin <> 'harness-workflow')
      ))
    BEGIN
      SELECT RAISE(ABORT, 'Conversation archive metadata must match lifecycle state and product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_conversation_lifecycle_operation_identity_insert;
    CREATE TRIGGER trg_conversation_lifecycle_operation_identity_insert
    BEFORE INSERT ON conversation_lifecycle_operations
    WHEN NOT EXISTS (
      SELECT 1 FROM conversations
      WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
        AND product_mode = NEW.product_mode
    )
    BEGIN
      SELECT RAISE(ABORT, 'Conversation lifecycle operation identity must match Conversation');
    END;
    DROP TRIGGER IF EXISTS trg_provider_attempt_mode_insert;
    CREATE TRIGGER trg_provider_attempt_mode_insert
    BEFORE INSERT ON provider_attempts
    WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM conversations
      WHERE project_id = NEW.project_id
        AND conversation_id = NEW.conversation_id
        AND product_mode = NEW.product_mode
    )
    BEGIN
      SELECT RAISE(ABORT, 'ProviderAttempt product_mode must match Conversation');
    END;
    DROP TRIGGER IF EXISTS trg_provider_attempt_mode_update;
    CREATE TRIGGER trg_provider_attempt_mode_update
    BEFORE UPDATE OF conversation_id, product_mode ON provider_attempts
    WHEN NEW.conversation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM conversations
      WHERE project_id = NEW.project_id
        AND conversation_id = NEW.conversation_id
        AND product_mode = NEW.product_mode
    )
    BEGIN
      SELECT RAISE(ABORT, 'ProviderAttempt product_mode must match Conversation');
    END;
    DROP TRIGGER IF EXISTS trg_conversations_agent_turn_mode_insert;
    CREATE TRIGGER trg_conversations_agent_turn_mode_insert
    BEFORE INSERT ON conversations
    WHEN (NEW.product_mode = 'agent' AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
      OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Conversation agent_turn_mode must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_conversations_agent_turn_mode_update;
    CREATE TRIGGER trg_conversations_agent_turn_mode_update
    BEFORE UPDATE OF agent_turn_mode ON conversations
    WHEN (NEW.product_mode = 'agent' AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
      OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Conversation agent_turn_mode must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_provider_attempt_agent_turn_mode_insert;
    DROP TRIGGER IF EXISTS trg_conversations_agent_model_insert;
    DROP TRIGGER IF EXISTS trg_conversations_agent_model_update;
    CREATE TRIGGER trg_provider_attempt_agent_turn_mode_insert
    BEFORE INSERT ON provider_attempts
    WHEN (NEW.product_mode = 'agent' AND NEW.operation_kind = 'conversation-turn'
          AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
      OR (NEW.product_mode = 'agent' AND NEW.operation_kind = 'review' AND NEW.agent_turn_mode IS NOT NULL)
      OR (NEW.product_mode = 'harness' AND (NEW.agent_turn_mode IS NOT NULL OR NEW.operation_kind = 'review'))
    BEGIN
      SELECT RAISE(ABORT, 'ProviderAttempt agent_turn_mode must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_composer_draft_agent_turn_mode_insert;
    CREATE TRIGGER trg_composer_draft_agent_turn_mode_insert
    BEFORE INSERT ON composer_drafts
    WHEN (NEW.product_mode = 'agent' AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
      OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'ComposerDraft agent_turn_mode must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_provider_attempt_agent_turn_mode_update;
    CREATE TRIGGER trg_provider_attempt_agent_turn_mode_update
    BEFORE UPDATE OF agent_turn_mode, operation_kind, product_mode ON provider_attempts
    WHEN (NEW.product_mode = 'agent' AND NEW.operation_kind = 'conversation-turn'
          AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
      OR (NEW.product_mode = 'agent' AND NEW.operation_kind = 'review' AND NEW.agent_turn_mode IS NOT NULL)
      OR (NEW.product_mode = 'harness' AND (NEW.agent_turn_mode IS NOT NULL OR NEW.operation_kind = 'review'))
    BEGIN
      SELECT RAISE(ABORT, 'ProviderAttempt agent_turn_mode must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_composer_draft_agent_turn_mode_update;
    CREATE TRIGGER trg_composer_draft_agent_turn_mode_update
    BEFORE UPDATE OF agent_turn_mode, product_mode ON composer_drafts
    WHEN (NEW.product_mode = 'agent' AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
      OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'ComposerDraft agent_turn_mode must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_composer_draft_agent_model_insert;
    DROP TRIGGER IF EXISTS trg_composer_draft_agent_model_update;
    DROP TRIGGER IF EXISTS trg_conversation_turn_queue_mode_insert;
    CREATE TRIGGER trg_conversation_turn_queue_mode_insert
    BEFORE INSERT ON conversation_turn_queues
    WHEN NOT EXISTS (
      SELECT 1 FROM conversations
      WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
        AND product_mode = NEW.product_mode AND deleted_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'Conversation Turn queue mode must match active Conversation');
    END;
    DROP TRIGGER IF EXISTS trg_conversation_turn_queue_mode_update;
    CREATE TRIGGER trg_conversation_turn_queue_mode_update
    BEFORE UPDATE OF project_id, conversation_id, product_mode ON conversation_turn_queues
    WHEN NOT EXISTS (
      SELECT 1 FROM conversations
      WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
        AND product_mode = NEW.product_mode AND deleted_at IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'Conversation Turn queue mode must match active Conversation');
    END;
    DROP TRIGGER IF EXISTS trg_conversation_turn_queue_item_mode_insert;
    CREATE TRIGGER trg_conversation_turn_queue_item_mode_insert
    BEFORE INSERT ON conversation_turn_queue_items
    WHEN NOT EXISTS (
      SELECT 1 FROM conversation_turn_queues
      WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
        AND product_mode = NEW.product_mode
    ) OR (NEW.item_kind = 'conversation-turn' AND NEW.product_mode = 'agent' AND NEW.agent_turn_mode IS NULL)
      OR (NEW.item_kind = 'conversation-turn' AND NEW.review_target_json IS NOT NULL)
      OR (NEW.item_kind = 'review' AND (NEW.product_mode <> 'agent' OR NEW.review_target_json IS NULL
        OR NEW.text <> '' OR NEW.context_refs_json <> '[]' OR NEW.attachment_ids_json <> '[]'
        OR NEW.skill_overrides_json <> '{}' OR NEW.agent_turn_mode IS NOT NULL
        OR NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL))
      OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Conversation queued Turn fields must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_conversation_turn_queue_item_mode_update;
    CREATE TRIGGER trg_conversation_turn_queue_item_mode_update
    BEFORE UPDATE OF project_id, conversation_id, product_mode, item_kind, review_target_json, text,
      context_refs_json, attachment_ids_json, skill_overrides_json, agent_turn_mode, agent_model_id, agent_reasoning_effort
      ON conversation_turn_queue_items
    WHEN NOT EXISTS (
      SELECT 1 FROM conversation_turn_queues
      WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
        AND product_mode = NEW.product_mode
    ) OR (NEW.item_kind = 'conversation-turn' AND NEW.product_mode = 'agent' AND NEW.agent_turn_mode IS NULL)
      OR (NEW.item_kind = 'conversation-turn' AND NEW.review_target_json IS NOT NULL)
      OR (NEW.item_kind = 'review' AND (NEW.product_mode <> 'agent' OR NEW.review_target_json IS NULL
        OR NEW.text <> '' OR NEW.context_refs_json <> '[]' OR NEW.attachment_ids_json <> '[]'
        OR NEW.skill_overrides_json <> '{}' OR NEW.agent_turn_mode IS NOT NULL
        OR NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL))
      OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
    BEGIN
      SELECT RAISE(ABORT, 'Conversation queued Turn fields must match product_mode');
    END;
    DROP TRIGGER IF EXISTS trg_conversation_review_identity_insert;
    CREATE TRIGGER trg_conversation_review_identity_insert
    BEFORE INSERT ON conversation_review_operations
    WHEN NOT EXISTS (
      SELECT 1 FROM conversations
      WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
        AND product_mode = 'agent' AND current_graph_scope_id = NEW.graph_scope_id
        AND state = 'active' AND deleted_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM provider_attempts
      WHERE project_id = NEW.project_id AND attempt_id = NEW.attempt_id
        AND conversation_id = NEW.conversation_id AND graph_scope_id = NEW.graph_scope_id
        AND product_mode = 'agent' AND operation_kind = 'review'
    )
    BEGIN
      SELECT RAISE(ABORT, 'Conversation Review identity must match Agent Conversation and Review Attempt');
    END;
    DROP TRIGGER IF EXISTS trg_conversation_turn_queue_cancel_inactive;
    DROP TRIGGER IF EXISTS trg_conversation_turn_queue_block_archive;
    CREATE TRIGGER trg_conversation_turn_queue_block_archive
    BEFORE UPDATE OF state, deleted_at ON conversations
    WHEN (NEW.state <> 'active' OR NEW.deleted_at IS NOT NULL)
      AND EXISTS (
        SELECT 1 FROM conversation_turn_queue_items
        WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
          AND status IN ('queued', 'dispatching', 'blocked')
      )
    BEGIN
      SELECT RAISE(ABORT, 'Conversation with pending Turn queue items cannot be archived or deleted');
    END;
  `);
}

export function ensureColumn(db: Database.Database, table: string, column: string, declaration: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[];
  if (!columns.some((item) => String(item.name) === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

export function hasWorkbenchRuntimeTables(db: Database.Database): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name IN ('conversations', 'messages', 'canonical_timeline_items', 'provider_attempts') LIMIT 1").get() as SqliteRow | undefined;
  return Boolean(row?.present);
}

export function hasAnyWorkbenchUserTables(db: Database.Database): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get() as SqliteRow | undefined;
  return Boolean(row?.present);
}
