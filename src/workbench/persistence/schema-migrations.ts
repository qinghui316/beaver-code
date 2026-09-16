import Database from "better-sqlite3";
import { applyCurrentWorkbenchSchema, ensureColumn, hasAnyWorkbenchUserTables, hasWorkbenchRuntimeTables, WORKBENCH_SCHEMA_VERSION } from "./schema.js";
import type { SqliteRow } from "./sql-mappers.js";

export const MINIMUM_AUTOMATIC_WORKBENCH_SCHEMA_VERSION = 16;
export const WORKBENCH_MIGRATION_IMPLEMENTATION_VERSION = 3;

export type WorkbenchDatabaseCompatibilityCode =
  | "unsupported-legacy"
  | "newer-version"
  | "corrupt"
  | "recovery-required";

export class WorkbenchDatabaseCompatibilityError extends Error {
  readonly name = "WorkbenchDatabaseCompatibilityError";

  constructor(
    readonly code: WorkbenchDatabaseCompatibilityCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface WorkbenchSchemaMigration {
  readonly from: number;
  readonly to: number;
  migrate(db: Database.Database): void;
  validate(db: Database.Database): void;
}

const schema16To17: WorkbenchSchemaMigration = {
  from: 16,
  to: 17,
  migrate(db) {
    ensureColumn(db, "conversations", "archive_origin", "TEXT CHECK(archive_origin IN ('agent-user', 'harness-workflow') OR archive_origin IS NULL)");
    ensureColumn(db, "conversations", "archived_at", "TEXT");
    ensureColumn(db, "conversations", "lifecycle_revision", "INTEGER NOT NULL DEFAULT 0");
    db.exec(`
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
      UPDATE conversations SET archive_origin = CASE product_mode
        WHEN 'agent' THEN 'agent-user' ELSE 'harness-workflow' END,
        archived_at = COALESCE(archived_at, updated_at)
      WHERE state = 'archive' AND archive_origin IS NULL;
      UPDATE conversations SET archive_origin = NULL, archived_at = NULL WHERE state = 'active';
    `);
  },
  validate(db) {
    assertColumns(db, "conversations", ["archive_origin", "archived_at", "lifecycle_revision"]);
    assertTable(db, "conversation_lifecycle_operations");
  },
};

const schema17To18: WorkbenchSchemaMigration = {
  from: 17,
  to: 18,
  migrate(db) {
    ensureColumn(db, "provider_attempts", "operation_kind", "TEXT NOT NULL DEFAULT 'conversation-turn' CHECK(operation_kind IN ('conversation-turn', 'review'))");
    ensureColumn(db, "conversation_turn_queue_items", "item_kind", "TEXT NOT NULL DEFAULT 'conversation-turn' CHECK(item_kind IN ('conversation-turn', 'review'))");
    ensureColumn(db, "conversation_turn_queue_items", "review_target_json", "TEXT");
    db.exec(`
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
      UPDATE provider_attempts SET operation_kind = 'conversation-turn' WHERE operation_kind IS NULL;
      UPDATE provider_attempts SET agent_turn_mode = NULL WHERE operation_kind = 'review';
      UPDATE conversation_turn_queue_items SET item_kind = 'conversation-turn' WHERE item_kind IS NULL;
    `);
  },
  validate(db) {
    assertColumns(db, "provider_attempts", ["operation_kind"]);
    assertColumns(db, "conversation_turn_queue_items", ["item_kind", "review_target_json"]);
    assertTable(db, "conversation_review_operations");
  },
};

const schema18To19: WorkbenchSchemaMigration = {
  from: 18,
  to: 19,
  migrate(db) {
    ensureColumn(db, "provider_attempts", "execution_contract_family", "TEXT NOT NULL DEFAULT 'legacy-v0'");
    ensureColumn(db, "provider_attempts", "execution_contract_epoch", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "provider_attempts", "execution_policy_hash", "TEXT");
    ensureColumn(db, "provider_attempts", "provider_adapter_version", "TEXT");
    ensureColumn(db, "conversation_turn_queue_items", "execution_contract_family", "TEXT NOT NULL DEFAULT 'legacy-v0'");
    ensureColumn(db, "conversation_turn_queue_items", "execution_contract_epoch", "INTEGER NOT NULL DEFAULT 0");
    db.exec(`
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
      UPDATE provider_attempts
      SET execution_contract_family = 'legacy-v0', execution_contract_epoch = 0,
          execution_policy_hash = NULL, provider_adapter_version = NULL;
      UPDATE conversation_turn_queue_items
      SET execution_contract_family = 'legacy-v0', execution_contract_epoch = 0;
    `);
  },
  validate(db) {
    assertColumns(db, "provider_attempts", [
      "execution_contract_family",
      "execution_contract_epoch",
      "execution_policy_hash",
      "provider_adapter_version",
    ]);
    assertColumns(db, "conversation_turn_queue_items", [
      "execution_contract_family",
      "execution_contract_epoch",
    ]);
    assertColumns(db, "conversation_turn_queue_contract_confirmations", [
      "prior_family",
      "prior_epoch",
      "target_family",
      "target_epoch",
      "client_request_id",
      "expected_revision",
      "request_hash",
    ]);
  },
};

const schema19To20: WorkbenchSchemaMigration = {
  from: 19,
  to: 20,
  migrate(db) {
    applyCurrentWorkbenchSchema(db);
  },
  validate(db) {
    assertSchemaShape(db, 20, { historicalSource: true });
  },
};

export const WORKBENCH_SCHEMA_MIGRATIONS: readonly WorkbenchSchemaMigration[] = [
  schema16To17,
  schema17To18,
  schema18To19,
  schema19To20,
];

export function inspectWorkbenchSchema(db: Database.Database): {
  currentVersion: number;
  kind: "new" | "current" | "upgrade";
} {
  let currentVersion: number;
  try {
    currentVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  } catch (cause) {
    throw new WorkbenchDatabaseCompatibilityError("corrupt", "这个项目的数据无法读取。", { cause });
  }
  if (!Number.isInteger(currentVersion) || currentVersion < 0) {
    throw new WorkbenchDatabaseCompatibilityError("corrupt", "这个项目的数据版本无效。");
  }
  if (currentVersion === 0 && !hasAnyWorkbenchUserTables(db)) return { currentVersion, kind: "new" };
  if (currentVersion > WORKBENCH_SCHEMA_VERSION) {
    throw new WorkbenchDatabaseCompatibilityError("newer-version", "这个项目的数据由更新版本的 Beaver Code 创建。");
  }
  if (currentVersion < MINIMUM_AUTOMATIC_WORKBENCH_SCHEMA_VERSION || !hasWorkbenchRuntimeTables(db)) {
    throw new WorkbenchDatabaseCompatibilityError("unsupported-legacy", "这个项目的数据版本过旧，无法自动升级。");
  }
  if (currentVersion < WORKBENCH_SCHEMA_VERSION) validateMigrationSourceSchema(db, currentVersion);
  return {
    currentVersion,
    kind: currentVersion === WORKBENCH_SCHEMA_VERSION ? "current" : "upgrade",
  };
}

function validateMigrationSourceSchema(db: Database.Database, version: number): void {
  try {
    assertSchemaShape(db, version, { historicalSource: true });
  } catch (cause) {
    throw new WorkbenchDatabaseCompatibilityError("corrupt", "这个项目的数据结构不完整。", { cause });
  }
}

export function initializeCurrentWorkbenchSchema(db: Database.Database): void {
  applyCurrentWorkbenchSchema(db);
  db.pragma(`user_version = ${WORKBENCH_SCHEMA_VERSION}`);
  validateCurrentWorkbenchSchema(db);
}

export function prepareStagedWorkbenchSchema(db: Database.Database): void {
  const inspection = inspectWorkbenchSchema(db);
  if (inspection.kind === "new") {
    initializeCurrentWorkbenchSchema(db);
    return;
  }
  if (inspection.kind === "upgrade") migrateWorkbenchSchema(db, inspection.currentVersion);
}

export function migrateWorkbenchSchema(db: Database.Database, currentVersion: number): readonly number[] {
  let version = currentVersion;
  const applied: number[] = [];
  while (version < WORKBENCH_SCHEMA_VERSION) {
    const migration = WORKBENCH_SCHEMA_MIGRATIONS.find((candidate) => candidate.from === version);
    if (!migration) {
      throw new WorkbenchDatabaseCompatibilityError("unsupported-legacy", "这个项目的数据没有可用的升级路径。");
    }
    migration.migrate(db);
    migration.validate(db);
    db.pragma(`user_version = ${migration.to}`);
    version = migration.to;
    applied.push(version);
  }
  applyCurrentWorkbenchSchema(db);
  db.pragma(`user_version = ${WORKBENCH_SCHEMA_VERSION}`);
  validateCurrentWorkbenchSchema(db);
  return applied;
}

export function validateCurrentWorkbenchSchema(db: Database.Database): void {
  assertSchemaShape(db, WORKBENCH_SCHEMA_VERSION, { historicalSource: true });
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error("Workbench database integrity check failed.");
}

interface SchemaShape {
  readonly tables: ReadonlyMap<string, readonly ColumnShape[]>;
  readonly indexes: ReadonlyMap<string, readonly string[]>;
  readonly triggers: ReadonlyMap<string, string>;
}

interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly defaultValue: string | null;
  readonly pk: number;
}

const schemaShapeCache = new Map<number, SchemaShape>();

function assertSchemaShape(
  db: Database.Database,
  version: number,
  options: { historicalSource?: boolean } = {},
): void {
  const expected = expectedSchemaShape(version);
  const actual = readSchemaShape(db);
  for (const [table, expectedColumns] of expected.tables) {
    const actualColumns = actual.tables.get(table);
    if (!actualColumns) throw new Error(`Workbench schema is missing required table: ${table}`);
    if (!columnsMatch(table, actualColumns, expectedColumns, Boolean(options.historicalSource))) {
      throw new Error(`Workbench schema table ${table} has an unexpected column contract.`);
    }
    const actualIndexes = actual.indexes.get(table) ?? [];
    if (JSON.stringify(actualIndexes) !== JSON.stringify(expected.indexes.get(table) ?? [])) {
      throw new Error(`Workbench schema table ${table} has an unexpected index contract.`);
    }
  }
  if (JSON.stringify([...actual.triggers]) !== JSON.stringify([...expected.triggers])) {
    throw new Error("Workbench schema has an unexpected trigger contract.");
  }
  assertCheckConstraintFragments(db, version, Boolean(options.historicalSource));
}

function columnsMatch(
  table: string,
  actualColumns: readonly ColumnShape[],
  expectedColumns: readonly ColumnShape[],
  historicalSource: boolean,
): boolean {
  if (actualColumns.length !== expectedColumns.length) return false;
  const actualByName = new Map(actualColumns.map((column) => [column.name, column] as const));
  for (const expected of expectedColumns) {
    const actual = actualByName.get(expected.name);
    if (!actual
      || actual.type !== expected.type
      || actual.notnull !== expected.notnull
      || actual.pk !== expected.pk
      || !compatibleDefaultValue(table, expected.name, actual.defaultValue, expected.defaultValue, historicalSource)) {
      return false;
    }
  }
  return true;
}

function compatibleDefaultValue(
  table: string,
  column: string,
  actual: string | null,
  expected: string | null,
  historicalSource: boolean,
): boolean {
  if (actual === expected) return true;
  if (!historicalSource || column !== "product_mode" || !["conversations", "provider_attempts"].includes(table)) {
    return false;
  }
  return new Set([actual, expected]).size === 2
    && [actual, expected].every((value) => value === null || value === "'harness'");
}

function expectedSchemaShape(version: number): SchemaShape {
  const cached = schemaShapeCache.get(version);
  if (cached) return cached;
  if (version !== 16 && version !== 17 && version !== 18 && version !== 19 && version !== 20) throw new Error(`Unsupported Workbench schema contract version: ${version}`);
  const reference = new Database(":memory:");
  try {
    applyCurrentWorkbenchSchema(reference);
    materializeWorkbenchSchemaContract(reference, version);
    const shape = readSchemaShape(reference);
    schemaShapeCache.set(version, shape);
    return shape;
  } finally {
    reference.close();
  }
}

function readSchemaShape(db: Database.Database): SchemaShape {
  const tables = new Map<string, ColumnShape[]>();
  const columnRows = db.prepare(`
    SELECT schema_table.name AS table_name,
           table_column.name,
           table_column.type,
           table_column."notnull" AS "notnull",
           table_column.dflt_value,
           table_column.pk
      FROM sqlite_master AS schema_table,
           pragma_table_info(schema_table.name) AS table_column
     WHERE schema_table.type = 'table'
       AND schema_table.name NOT LIKE 'sqlite_%'
     ORDER BY schema_table.name, table_column.name
  `).all() as Array<{
    table_name: string;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  for (const column of columnRows) {
    const columns = tables.get(column.table_name) ?? [];
    columns.push({
      name: String(column.name),
      type: String(column.type).toUpperCase(),
      notnull: Number(column.notnull),
      defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      pk: Number(column.pk),
    });
    tables.set(column.table_name, columns);
  }

  const indexRows = db.prepare(`
    SELECT schema_table.name AS table_name,
           index_list.name AS index_name,
           index_list."unique" AS is_unique,
           index_list.origin,
           index_list.partial,
           index_column.seqno,
           index_column.name AS column_name
      FROM sqlite_master AS schema_table,
           pragma_index_list(schema_table.name) AS index_list
      LEFT JOIN pragma_index_info(index_list.name) AS index_column
     WHERE schema_table.type = 'table'
       AND schema_table.name NOT LIKE 'sqlite_%'
     ORDER BY schema_table.name, index_list.name, index_column.seqno
  `).all() as Array<{
    table_name: string;
    index_name: string;
    is_unique: number;
    origin: string;
    partial: number;
    seqno: number | null;
    column_name: string | null;
  }>;
  const indexParts = new Map<string, { table: string; prefix: string; columns: string[] }>();
  for (const row of indexRows) {
    const key = `${row.table_name}\0${row.index_name}`;
    const part = indexParts.get(key) ?? {
      table: row.table_name,
      prefix: `${Number(row.is_unique)}:${String(row.origin)}:${Number(row.partial)}:`,
      columns: [],
    };
    if (row.column_name !== null) part.columns.push(row.column_name);
    indexParts.set(key, part);
  }
  const indexes = new Map<string, string[]>();
  for (const part of indexParts.values()) {
    const signatures = indexes.get(part.table) ?? [];
    signatures.push(`${part.prefix}${part.columns.join(",")}`);
    indexes.set(part.table, signatures);
  }
  for (const signatures of indexes.values()) signatures.sort();
  const triggers = new Map((db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
  ).all() as Array<{ name: string; sql: string }>).map((row) => [row.name, normalizeSchemaSql(row.sql)] as const));
  return { tables, indexes, triggers };
}

export function materializeWorkbenchSchemaContract(db: Database.Database, version: 16 | 17 | 18 | 19 | 20): void {
  if (version < 20) {
    db.exec(LEGACY_MODEL_SELECTION_TRIGGER_SQL);
  }
  if (version < 19) {
    db.exec(`
      DROP TABLE conversation_turn_queue_contract_confirmations;
      ALTER TABLE provider_attempts DROP COLUMN provider_adapter_version;
      ALTER TABLE provider_attempts DROP COLUMN execution_policy_hash;
      ALTER TABLE provider_attempts DROP COLUMN execution_contract_epoch;
      ALTER TABLE provider_attempts DROP COLUMN execution_contract_family;
      ALTER TABLE conversation_turn_queue_items DROP COLUMN execution_contract_epoch;
      ALTER TABLE conversation_turn_queue_items DROP COLUMN execution_contract_family;
    `);
  }
  if (version < 18) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_provider_attempt_agent_turn_mode_insert;
      DROP TRIGGER IF EXISTS trg_provider_attempt_agent_turn_mode_update;
      DROP TRIGGER IF EXISTS trg_conversation_turn_queue_item_mode_insert;
      DROP TRIGGER IF EXISTS trg_conversation_turn_queue_item_mode_update;
      DROP TRIGGER IF EXISTS trg_conversation_review_identity_insert;
      DROP TABLE conversation_review_operations;
      ALTER TABLE provider_attempts DROP COLUMN operation_kind;
      ALTER TABLE conversation_turn_queue_items DROP COLUMN review_target_json;
      ALTER TABLE conversation_turn_queue_items DROP COLUMN item_kind;
      ${LEGACY_EXECUTION_TRIGGER_SQL}
    `);
  }
  if (version < 17) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_conversations_archive_origin_insert;
      DROP TRIGGER IF EXISTS trg_conversations_archive_origin_update;
      DROP TRIGGER IF EXISTS trg_conversation_lifecycle_operation_identity_insert;
      DROP TRIGGER IF EXISTS trg_conversation_turn_queue_block_archive;
      DROP TABLE conversation_lifecycle_operations;
      ALTER TABLE conversations DROP COLUMN lifecycle_revision;
      ALTER TABLE conversations DROP COLUMN archived_at;
      ALTER TABLE conversations DROP COLUMN archive_origin;
      ${SCHEMA_16_QUEUE_CANCEL_TRIGGER_SQL}
    `);
  }
  db.pragma(`user_version = ${version}`);
}

const LEGACY_EXECUTION_TRIGGER_SQL = `
  CREATE TRIGGER trg_provider_attempt_agent_turn_mode_insert
  BEFORE INSERT ON provider_attempts
  WHEN (NEW.product_mode = 'agent' AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
    OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'ProviderAttempt agent_turn_mode must match product_mode');
  END;
  CREATE TRIGGER trg_provider_attempt_agent_turn_mode_update
  BEFORE UPDATE OF agent_turn_mode ON provider_attempts
  WHEN (NEW.product_mode = 'agent' AND (NEW.agent_turn_mode IS NULL OR NEW.agent_turn_mode NOT IN ('default', 'plan')))
    OR (NEW.product_mode = 'harness' AND NEW.agent_turn_mode IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'ProviderAttempt agent_turn_mode must match product_mode');
  END;
  CREATE TRIGGER trg_conversation_turn_queue_item_mode_insert
  BEFORE INSERT ON conversation_turn_queue_items
  WHEN NOT EXISTS (
    SELECT 1 FROM conversation_turn_queues
    WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
      AND product_mode = NEW.product_mode
  ) OR (NEW.product_mode = 'agent' AND NEW.agent_turn_mode IS NULL)
    OR (NEW.product_mode = 'harness' AND (
      NEW.agent_turn_mode IS NOT NULL OR NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL
    ))
  BEGIN
    SELECT RAISE(ABORT, 'Conversation queued Turn fields must match product_mode');
  END;
  CREATE TRIGGER trg_conversation_turn_queue_item_mode_update
  BEFORE UPDATE OF project_id, conversation_id, product_mode, agent_turn_mode, agent_model_id, agent_reasoning_effort
    ON conversation_turn_queue_items
  WHEN NOT EXISTS (
    SELECT 1 FROM conversation_turn_queues
    WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
      AND product_mode = NEW.product_mode
  ) OR (NEW.product_mode = 'agent' AND NEW.agent_turn_mode IS NULL)
    OR (NEW.product_mode = 'harness' AND (
      NEW.agent_turn_mode IS NOT NULL OR NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL
    ))
  BEGIN
    SELECT RAISE(ABORT, 'Conversation queued Turn fields must match product_mode');
  END;
`;

const LEGACY_MODEL_SELECTION_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS trg_conversations_agent_model_insert;
  CREATE TRIGGER trg_conversations_agent_model_insert
  BEFORE INSERT ON conversations
  WHEN NEW.product_mode = 'harness' AND (NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'Harness Conversation cannot store Agent model selection');
  END;
  DROP TRIGGER IF EXISTS trg_conversations_agent_model_update;
  CREATE TRIGGER trg_conversations_agent_model_update
  BEFORE UPDATE OF agent_model_id, agent_reasoning_effort, product_mode ON conversations
  WHEN NEW.product_mode = 'harness' AND (NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'Harness Conversation cannot store Agent model selection');
  END;
  DROP TRIGGER IF EXISTS trg_composer_draft_agent_model_insert;
  CREATE TRIGGER trg_composer_draft_agent_model_insert
  BEFORE INSERT ON composer_drafts
  WHEN NEW.product_mode = 'harness' AND (NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'Harness ComposerDraft cannot store Agent model selection');
  END;
  DROP TRIGGER IF EXISTS trg_composer_draft_agent_model_update;
  CREATE TRIGGER trg_composer_draft_agent_model_update
  BEFORE UPDATE OF agent_model_id, agent_reasoning_effort, product_mode ON composer_drafts
  WHEN NEW.product_mode = 'harness' AND (NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'Harness ComposerDraft cannot store Agent model selection');
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
    OR (NEW.product_mode = 'harness' AND (
      NEW.agent_turn_mode IS NOT NULL OR NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL
    ))
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
    OR (NEW.product_mode = 'harness' AND (
      NEW.agent_turn_mode IS NOT NULL OR NEW.agent_model_id IS NOT NULL OR NEW.agent_reasoning_effort IS NOT NULL
    ))
  BEGIN
    SELECT RAISE(ABORT, 'Conversation queued Turn fields must match product_mode');
  END;
`;

const SCHEMA_16_QUEUE_CANCEL_TRIGGER_SQL = `
  CREATE TRIGGER trg_conversation_turn_queue_cancel_inactive
  AFTER UPDATE OF state, deleted_at ON conversations
  WHEN NEW.state <> 'active' OR NEW.deleted_at IS NOT NULL
  BEGIN
    UPDATE conversation_turn_queues
    SET revision = revision + 1, updated_at = NEW.updated_at
    WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
      AND EXISTS (
        SELECT 1 FROM conversation_turn_queue_items
        WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
          AND status IN ('queued', 'blocked')
      );
    UPDATE conversation_turn_queue_items
    SET status = 'cancelled', diagnostic = NULL, updated_at = NEW.updated_at
    WHERE project_id = NEW.project_id AND conversation_id = NEW.conversation_id
      AND status IN ('queued', 'blocked');
  END;
`;

function normalizeSchemaSql(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, "").replaceAll('"', "");
}

function assertCheckConstraintFragments(db: Database.Database, version: number, historicalSource = false): void {
  const fragments: Readonly<Record<string, readonly string[]>> = {
    conversations: ["check(product_modein('agent','harness'))", "check(agent_turn_modein('default','plan')oragent_turn_modeisnull)"],
    provider_attempts: ["check(product_modein('agent','harness'))", "check(conversation_idisnotnullorproduct_mode='harness')"],
    composer_drafts: ["check(product_modein('agent','harness'))", "check(agent_turn_modein('default','plan')oragent_turn_modeisnull)"],
    conversation_fork_operations: ["check(statusin('pending','submitting','completed','failed','interrupted'))"],
    conversation_turn_queues: ["check(product_modein('agent','harness'))"],
    conversation_turn_queue_items: ["check(product_modein('agent','harness'))", "check(statusin('queued','dispatching','blocked','dispatched','cancelled'))", "check(retry_countbetween0and1)"],
  };
  const versioned: Record<string, readonly string[]> = { ...fragments };
  if (historicalSource) {
    versioned.conversations = versioned.conversations!.filter((fragment) => !fragment.includes("agent_turn_mode"));
    versioned.provider_attempts = versioned.provider_attempts!.filter((fragment) => !fragment.includes("conversation_idisnotnull"));
  }
  if (version >= 17) {
    versioned.conversations = [...versioned.conversations!, "check(archive_originin('agent-user','harness-workflow')orarchive_originisnull)"];
    versioned.conversation_lifecycle_operations = [
      "check(product_modein('agent','harness'))",
      "check(actionin('archive','restore','delete'))",
      "check(statusin('pending','submitting','completed','failed','interrupted'))",
    ];
  }
  if (version >= 18) {
    versioned.provider_attempts = [...versioned.provider_attempts!, "check(operation_kindin('conversation-turn','review'))"];
    versioned.conversation_turn_queue_items = [...versioned.conversation_turn_queue_items!, "check(item_kindin('conversation-turn','review'))"];
    versioned.conversation_review_operations = [
      "check(statusin('pending','submitting','reviewing','completed','failed','interrupted'))",
      "check(sourcein('direct','queue'))",
    ];
  }
  for (const [table, requiredFragments] of Object.entries(versioned)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
    const normalized = String(row?.sql ?? "").toLowerCase().replaceAll(/\s+/g, "");
    for (const fragment of requiredFragments) {
      if (!normalized.includes(fragment)) throw new Error(`Workbench schema table ${table} is missing a required check constraint.`);
    }
  }
}

function assertTable(db: Database.Database, table: string): void {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as SqliteRow | undefined;
  if (!row?.present) throw new Error(`Workbench schema is missing required table: ${table}`);
}

function assertColumns(db: Database.Database, table: string, columns: readonly string[]): void {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[]).map((row) => String(row.name)));
  const missing = columns.filter((column) => !existing.has(column));
  if (missing.length > 0) throw new Error(`Workbench schema table ${table} is missing required columns: ${missing.join(", ")}`);
}
