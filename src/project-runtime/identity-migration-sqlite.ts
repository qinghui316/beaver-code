import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { parseJsonText } from "../fs/json.js";

export interface SqliteProjectIdentityColumn {
  table: string;
  column: string;
}

export interface SqliteTableIdentityProof {
  table: string;
  countBefore: number;
  countAfter: number;
  identityNeutralHashBefore: string;
  identityNeutralHashAfter: string;
}

export interface SqliteProjectIdentityProof {
  relativePath: string;
  userVersion: number;
  updatedRows: number;
  tables: SqliteTableIdentityProof[];
}

export const WORKBENCH_PROJECT_IDENTITY_COLUMNS: readonly SqliteProjectIdentityColumn[] = [
  { table: "canonical_timeline_items", column: "project_id" },
  { table: "conversations", column: "project_id" },
  { table: "action_runs", column: "project_id" },
  { table: "provider_thread_links", column: "project_id" },
  { table: "conversation_provider_bindings", column: "project_id" },
  { table: "provider_attempts", column: "project_id" },
  { table: "provider_resume_points", column: "project_id" },
  { table: "conversation_change_links", column: "project_id" },
  { table: "conversation_graph_scopes", column: "project_id" },
  { table: "planning_acceptance_commits", column: "project_id" },
  { table: "skill_roots", column: "project_id" },
  { table: "skill_enablement", column: "project_id" },
  { table: "composer_drafts", column: "project_id" },
  { table: "conversation_turn_queues", column: "project_id" },
  { table: "conversation_turn_queue_items", column: "project_id" },
  { table: "conversation_turn_queue_contract_confirmations", column: "project_id" },
  { table: "conversation_input_deliveries", column: "project_id" },
  { table: "approval_cache", column: "project_id" },
  { table: "decision_records", column: "project_id" },
  { table: "conversation_fork_operations", column: "project_id" },
  { table: "conversation_lifecycle_operations", column: "project_id" },
  { table: "conversation_review_operations", column: "project_id" },
] as const;

interface SqliteColumnInfo {
  name: string;
  type: string;
  pk: number;
}

interface SqliteTableInfo {
  name: string;
  columns: SqliteColumnInfo[];
}

interface TableSnapshot {
  table: string;
  count: number;
  identityNeutralHash: string;
}

const IDENTITY_SENTINEL = "__AHO_CANONICAL_PROJECT_ID__";

export function migrateSqliteProjectIdentity(
  databasePath: string,
  relativePath: string,
  sourceProjectId: string,
  targetProjectId: string,
  identityColumns: readonly SqliteProjectIdentityColumn[],
): SqliteProjectIdentityProof {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    const userVersion = Number(database.pragma("user_version", { simple: true }));
    const tables = inspectTables(database);
    const allowlist = validateAllowlist(identityColumns);
    assertKnownIdentityColumns(tables, allowlist);
    assertIdentityValuesAreMigratable(database, tables, allowlist, sourceProjectId, targetProjectId);
    const before = snapshotTables(database, tables, allowlist, sourceProjectId, targetProjectId);
    let updatedRows = 0;
    database.transaction(() => {
      // The staged database is isolated. Restore the exact identity guard within
      // the same transaction after changing the allowlisted project identities.
      const deliveryGuard = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_delivery_identity_update'").get() as { sql: string } | undefined;
      if (deliveryGuard && allowlist.get("conversation_input_deliveries")?.has("project_id")) database.exec("DROP TRIGGER trg_delivery_identity_update");
      for (const table of tables) {
        const columns = allowlist.get(table.name) ?? new Set<string>();
        for (const column of columns) {
          if (!table.columns.some((candidate) => candidate.name === column)) continue;
          const result = database.prepare(
            `UPDATE ${quoteIdentifier(table.name)} SET ${quoteIdentifier(column)} = ? WHERE ${quoteIdentifier(column)} = ?`,
          ).run(targetProjectId, sourceProjectId);
          updatedRows += result.changes;
        }
      }
      if (deliveryGuard && allowlist.get("conversation_input_deliveries")?.has("project_id")) database.exec(deliveryGuard.sql);
    })();
    assertIdentityValuesAreCanonical(database, tables, allowlist, sourceProjectId, targetProjectId);
    const after = snapshotTables(database, tables, allowlist, sourceProjectId, targetProjectId);
    const proofs = before.map((entry, index) => {
      const next = after[index];
      if (!next || next.table !== entry.table || next.count !== entry.count
        || next.identityNeutralHash !== entry.identityNeutralHash) {
        throw new Error(`SQLite identity migration changed non-identity content in table ${entry.table}.`);
      }
      return {
        table: entry.table,
        countBefore: entry.count,
        countAfter: next.count,
        identityNeutralHashBefore: entry.identityNeutralHash,
        identityNeutralHashAfter: next.identityNeutralHash,
      };
    });
    database.pragma("wal_checkpoint(TRUNCATE)");
    return { relativePath, userVersion, updatedRows, tables: proofs };
  } finally {
    database.close();
  }
}

function inspectTables(database: Database.Database): SqliteTableInfo[] {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return rows.map(({ name }) => ({
    name,
    columns: (database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<Record<string, unknown>>)
      .map((column) => ({ name: String(column.name), type: String(column.type), pk: Number(column.pk) })),
  }));
}

function validateAllowlist(identityColumns: readonly SqliteProjectIdentityColumn[]): Map<string, Set<string>> {
  const allowlist = new Map<string, Set<string>>();
  for (const entry of identityColumns) {
    if (!isIdentifier(entry.table) || !isIdentifier(entry.column)) {
      throw new Error(`Invalid SQLite project identity allowlist entry: ${entry.table}.${entry.column}`);
    }
    const columns = allowlist.get(entry.table) ?? new Set<string>();
    if (columns.has(entry.column)) {
      throw new Error(`Duplicate SQLite project identity allowlist entry: ${entry.table}.${entry.column}`);
    }
    columns.add(entry.column);
    allowlist.set(entry.table, columns);
  }
  return allowlist;
}

function assertKnownIdentityColumns(tables: readonly SqliteTableInfo[], allowlist: ReadonlyMap<string, ReadonlySet<string>>): void {
  for (const table of tables) {
    for (const column of table.columns) {
      if (!/project_?id/i.test(column.name)) continue;
      if (!allowlist.get(table.name)?.has(column.name)) {
        throw new Error(`Unknown SQLite project identity column: ${table.name}.${column.name}`);
      }
    }
  }
}

function assertIdentityValuesAreMigratable(
  database: Database.Database,
  tables: readonly SqliteTableInfo[],
  allowlist: ReadonlyMap<string, ReadonlySet<string>>,
  sourceProjectId: string,
  targetProjectId: string,
): void {
  for (const table of tables) {
    const allowedColumns = allowlist.get(table.name) ?? new Set<string>();
    for (const column of table.columns) {
      if (allowedColumns.has(column.name)) {
        const values = database.prepare(
          `SELECT DISTINCT ${quoteIdentifier(column.name)} AS value FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(column.name)} IS NOT NULL`,
        ).all() as Array<{ value: unknown }>;
        for (const { value } of values) {
          if (value === targetProjectId) {
            throw new Error(`SQLite target project identity already exists in ${table.name}.${column.name}.`);
          }
          if (value !== sourceProjectId) {
            throw new Error(`SQLite sidecar contains another project identity in ${table.name}.${column.name}: ${String(value)}`);
          }
        }
        continue;
      }
      auditNonIdentityColumn(database, table, column, sourceProjectId, targetProjectId);
    }
  }
}

function assertIdentityValuesAreCanonical(
  database: Database.Database,
  tables: readonly SqliteTableInfo[],
  allowlist: ReadonlyMap<string, ReadonlySet<string>>,
  sourceProjectId: string,
  targetProjectId: string,
): void {
  for (const table of tables) {
    const allowedColumns = allowlist.get(table.name) ?? new Set<string>();
    for (const column of allowedColumns) {
      if (!table.columns.some((candidate) => candidate.name === column)) continue;
      const sourceCount = Number((database.prepare(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(column)} = ?`,
      ).get(sourceProjectId) as { count: number }).count);
      if (sourceCount !== 0) throw new Error(`SQLite source project identity remains in ${table.name}.${column}.`);
      const otherCount = Number((database.prepare(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(column)} IS NOT NULL AND ${quoteIdentifier(column)} <> ?`,
      ).get(targetProjectId) as { count: number }).count);
      if (otherCount !== 0) throw new Error(`SQLite non-canonical project identity remains in ${table.name}.${column}.`);
    }
  }
}

function auditNonIdentityColumn(
  database: Database.Database,
  table: SqliteTableInfo,
  column: SqliteColumnInfo,
  sourceProjectId: string,
  targetProjectId: string,
): void {
  if (!/json/i.test(column.name)) {
    const row = database.prepare(
      `SELECT 1 AS present FROM ${quoteIdentifier(table.name)} WHERE CAST(${quoteIdentifier(column.name)} AS TEXT) IN (?, ?) LIMIT 1`,
    ).get(sourceProjectId, targetProjectId) as { present?: number } | undefined;
    if (row?.present) {
      throw new Error(`Unknown SQLite project identity value in ${table.name}.${column.name}.`);
    }
    return;
  }
  const rows = database.prepare(
    `SELECT rowid AS rowid, ${quoteIdentifier(column.name)} AS value FROM ${quoteIdentifier(table.name)} WHERE ${quoteIdentifier(column.name)} IS NOT NULL`,
  ).all() as Array<{ rowid: number; value: unknown }>;
  for (const row of rows) {
    if (typeof row.value !== "string" || !row.value.trim()) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonText(row.value, `${table.name}.${column.name}[${row.rowid}]`);
    } catch (error) {
      throw new Error(`Cannot prove SQLite structured identity safety for ${table.name}.${column.name}[${row.rowid}].`, { cause: error });
    }
    if (containsStructuredIdentity(parsed, sourceProjectId) || containsStructuredIdentity(parsed, targetProjectId)) {
      throw new Error(`Unknown SQLite structured project identity in ${table.name}.${column.name}[${row.rowid}].`);
    }
  }
}

function containsStructuredIdentity(value: unknown, projectId: string, key: string | null = null): boolean {
  if (typeof value === "string") return key !== null && /^(?:id|project[_-]?id)$/i.test(key) && value === projectId;
  if (Array.isArray(value)) return value.some((item) => containsStructuredIdentity(item, projectId));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .some(([childKey, child]) => containsStructuredIdentity(child, projectId, childKey));
  }
  return false;
}

function snapshotTables(
  database: Database.Database,
  tables: readonly SqliteTableInfo[],
  allowlist: ReadonlyMap<string, ReadonlySet<string>>,
  sourceProjectId: string,
  targetProjectId: string,
): TableSnapshot[] {
  return tables.map((table) => {
    const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(table.name)}`).all() as Array<Record<string, unknown>>;
    const allowedColumns = allowlist.get(table.name) ?? new Set<string>();
    const normalizedRows = rows.map((row) => JSON.stringify(Object.fromEntries(
      table.columns.map(({ name }) => [name, normalizeSqliteValue(
        row[name],
        allowedColumns.has(name),
        sourceProjectId,
        targetProjectId,
      )]),
    ))).sort();
    return {
      table: table.name,
      count: rows.length,
      identityNeutralHash: createHash("sha256").update(JSON.stringify(normalizedRows)).digest("hex"),
    };
  });
}

function normalizeSqliteValue(
  value: unknown,
  identityColumn: boolean,
  sourceProjectId: string,
  targetProjectId: string,
): unknown {
  if (identityColumn && (value === sourceProjectId || value === targetProjectId)) return IDENTITY_SENTINEL;
  if (Buffer.isBuffer(value)) return { type: "blob", base64: value.toString("base64") };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
