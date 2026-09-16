import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateProjectIdentity,
  type MigrateProjectIdentityOptions,
  type ProjectIdentityMigrationStage,
} from "../../src/project-runtime/identity-migration.js";
import { WORKBENCH_PROJECT_IDENTITY_COLUMNS } from "../../src/project-runtime/identity-migration-sqlite.js";
import { initializeCurrentWorkbenchSchema, materializeWorkbenchSchemaContract, prepareStagedWorkbenchSchema } from "../../src/workbench/persistence/schema-migrations.js";
import { WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";

const SOURCE_ID = "aho-self";
const TARGET_ID = "agent-harness-orchestrator-a6ad344cbe4e";
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("staged canonical project identity migration", () => {
  it("keeps the identity allowlist exactly aligned with the current Workbench schema", () => {
    const database = new Database(":memory:");
    try {
      initializeCurrentWorkbenchSchema(database);
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string }>;
      const actual = tables.flatMap(({ name }) => (
        database.prepare(`PRAGMA table_info('${name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
      ).filter((column) => /project_?id/i.test(column.name)).map((column) => `${name}.${column.name}`)).sort();
      const expected = WORKBENCH_PROJECT_IDENTITY_COLUMNS
        .map(({ table, column }) => `${table}.${column}`)
        .sort();

      expect(actual).toEqual(expected);
      expect(expected).toHaveLength(21);
    } finally {
      database.close();
    }
  });

  it("migrates only allowlisted SQLite and structured JSON identities with count and content parity", async () => {
    const fixture = await createFixture("success");
    const sourceHash = await hashTree(fixture.sourceSidecarRoot);
    let sourceHashAtPrepared = "";
    const result = await migrateProjectIdentity({
      ...fixture.options,
      failureInjection: async (stage) => {
        if (stage === "prepared") sourceHashAtPrepared = await hashTree(fixture.sourceSidecarRoot);
      },
    });

    expect(result.stage).toBe("completed");
    expect(sourceHashAtPrepared).toBe(sourceHash);
    expect(existsSync(fixture.sourceSidecarRoot)).toBe(false);
    expect(existsSync(fixture.targetSidecarRoot)).toBe(true);
    expect(await sqliteProjectIds(join(fixture.targetSidecarRoot, "workbench", "workbench.sqlite"))).toEqual({
      canonical_timeline_items: [TARGET_ID],
      composer_drafts: [TARGET_ID],
      conversations: [TARGET_ID],
    });
    const migratedDatabase = new Database(join(fixture.targetSidecarRoot, "workbench", "workbench.sqlite"), { readonly: true });
    expect(migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('skills', 'bridge_sync')").all()).toEqual([]);
    migratedDatabase.close();
    expect(result.sqliteProofs).toHaveLength(1);
    for (const proof of result.sqliteProofs[0].tables) {
      expect(proof.countAfter, proof.table).toBe(proof.countBefore);
      expect(proof.identityNeutralHashAfter, proof.table).toBe(proof.identityNeutralHashBefore);
    }
    expect(result.sqliteProofs[0].userVersion).toBe(WORKBENCH_SCHEMA_VERSION);
    expect(result.sqliteProofs[0].updatedRows).toBe(3);

    const run = await readJson<{ projectId: string; payload: { keep: string } }>(
      join(fixture.targetSidecarRoot, "runs", "run-1.json"),
    );
    expect(run).toEqual({ projectId: TARGET_ID, payload: { keep: "same" } });
    const worktree = await readJson<{ project_id: string; worktreeId: string }>(
      join(fixture.targetSidecarRoot, "worktrees", "metadata", "wt-1.json"),
    );
    expect(worktree).toEqual({ project_id: TARGET_ID, worktreeId: "wt-1" });

    const registry = await readJson<{ projects: Array<{ id: string; name: string }> }>(fixture.registryPath);
    expect(registry.projects).toEqual([
      { id: TARGET_ID, name: SOURCE_ID },
      { id: "another-project", name: "another" },
    ]);
    expect(await readJson(fixture.bindingPath)).toMatchObject({ projectId: TARGET_ID, provider: "codex" });
    expect(await readJson(fixture.markerPath)).toMatchObject({ id: TARGET_ID, name: SOURCE_ID });
    expect((await readJson<{ project_id: string }>(fixture.manifestPath)).project_id).toBe(TARGET_ID);
    expect((await readJson<{ stage: string }>(result.journalPath)).stage).toBe("completed");
    expect(existsSync(`${fixture.registryPath}.success.previous`)).toBe(false);
  });

  it("rejects an unknown SQLite table or project identity column before commit", async () => {
    const fixture = await createFixture("unknown-sqlite");
    const database = new Database(join(fixture.sourceSidecarRoot, "workbench", "workbench.sqlite"));
    database.exec("CREATE TABLE unexpected_owner (project_id TEXT NOT NULL, value TEXT NOT NULL)");
    database.prepare("INSERT INTO unexpected_owner(project_id, value) VALUES (?, ?)").run(SOURCE_ID, "unchanged");
    database.close();
    const before = await hashTree(fixture.sourceSidecarRoot);

    await expect(migrateProjectIdentity(fixture.options)).rejects.toThrow(/Unknown SQLite project identity column/);
    expect(await hashTree(fixture.sourceSidecarRoot)).toBe(before);
    expect(existsSync(fixture.targetSidecarRoot)).toBe(false);
    expect((await readJson<{ projects: Array<{ id: string }> }>(fixture.registryPath)).projects[0].id).toBe(SOURCE_ID);
  });

  it("rejects an unknown structured sidecar identity record before commit", async () => {
    const fixture = await createFixture("unknown-json");
    await writeJson(join(fixture.sourceSidecarRoot, "runs", "unknown.json"), {
      nested: { projectId: SOURCE_ID },
    });
    const before = await hashTree(fixture.sourceSidecarRoot);

    await expect(migrateProjectIdentity(fixture.options)).rejects.toThrow(/retains source project identity/);
    expect(await hashTree(fixture.sourceSidecarRoot)).toBe(before);
    expect(existsSync(fixture.targetSidecarRoot)).toBe(false);
  });

  it("requires the project Harness manifest to already name the target canonical id", async () => {
    const fixture = await createFixture("bad-manifest");
    await writeJson(fixture.manifestPath, manifest(SOURCE_ID));
    await expect(migrateProjectIdentity(fixture.options)).rejects.toThrow(/manifest project_id must equal/);
    expect(existsSync(fixture.sourceSidecarRoot)).toBe(true);
    expect(existsSync(fixture.targetSidecarRoot)).toBe(false);
  });

  it("aborts before commit when the source sidecar changes after staging", async () => {
    const fixture = await createFixture("source-race");
    const concurrentPath = join(fixture.sourceSidecarRoot, "runs", "concurrent.txt");

    await expect(migrateProjectIdentity({
      ...fixture.options,
      async failureInjection(stage) {
        if (stage === "prepared") await writeFile(concurrentPath, "preserve concurrent write\n", "utf8");
      },
    })).rejects.toThrow(/source runtime sidecar changed/);

    expect(await readFile(concurrentPath, "utf8")).toBe("preserve concurrent write\n");
    expect(existsSync(fixture.targetSidecarRoot)).toBe(false);
    expect(existsSync(join(fixture.projectsRoot, `.${TARGET_ID}.source-race.staged`))).toBe(false);
  });

  it("preserves an external identity document changed before its backup step", async () => {
    const fixture = await createFixture("document-race");
    const concurrentRegistry = `${JSON.stringify({ version: "1.0", projects: [{ id: SOURCE_ID, concurrent: true }] }, null, 2)}\n`;

    await expect(migrateProjectIdentity({
      ...fixture.options,
      async failureInjection(stage) {
        if (stage === "source-sidecar-moved") await writeFile(fixture.registryPath, concurrentRegistry, "utf8");
      },
    })).rejects.toThrow(/external identity document changed before publication/);

    expect(await readFile(fixture.registryPath, "utf8")).toBe(concurrentRegistry);
    expect(existsSync(fixture.sourceSidecarRoot)).toBe(true);
    expect(existsSync(fixture.targetSidecarRoot)).toBe(false);
  });

  it("does not create a transaction directory when a target collision is already present", async () => {
    const fixture = await createFixture("target-collision");
    await mkdir(fixture.targetSidecarRoot, { recursive: true });
    const transactionDirectory = join(fixture.projectsRoot, ".identity-transactions", fixture.options.transactionId);

    await expect(migrateProjectIdentity(fixture.options)).rejects.toThrow(/target runtime sidecar already exists/);

    expect(existsSync(transactionDirectory)).toBe(false);
  });

  it.each([
    "prepared",
    "source-sidecar-moved",
    "target-sidecar-published",
    "structured-document-backed-up",
    "structured-document-published",
    "commit-ready",
  ] as const)("rolls back exact sidecar and structured state after injected %s failure", async (failureStage) => {
    const fixture = await createFixture(`fail-${failureStage}`);
    const sidecarBefore = await hashTree(fixture.sourceSidecarRoot);
    const registryBefore = await readFile(fixture.registryPath, "utf8");
    const bindingBefore = await readFile(fixture.bindingPath, "utf8");
    const markerBefore = await readFile(fixture.markerPath, "utf8");
    let injected = false;

    await expect(migrateProjectIdentity({
      ...fixture.options,
      failureInjection(stage) {
        if (!injected && stage === failureStage) {
          injected = true;
          throw new Error(`injected ${stage}`);
        }
      },
    })).rejects.toThrow(/was rolled back/);

    expect(injected).toBe(true);
    expect(await hashTree(fixture.sourceSidecarRoot)).toBe(sidecarBefore);
    expect(existsSync(fixture.targetSidecarRoot)).toBe(false);
    expect(await readFile(fixture.registryPath, "utf8")).toBe(registryBefore);
    expect(await readFile(fixture.bindingPath, "utf8")).toBe(bindingBefore);
    expect(await readFile(fixture.markerPath, "utf8")).toBe(markerBefore);
    const journalPath = join(
      fixture.projectsRoot,
      ".identity-transactions",
      fixture.options.transactionId,
      "journal.json",
    );
    expect((await readJson<{ stage: ProjectIdentityMigrationStage }>(journalPath)).stage).toBe("rolled-back");
  });
});

async function createFixture(transactionId: string): Promise<{
  root: string;
  projectsRoot: string;
  sourceSidecarRoot: string;
  targetSidecarRoot: string;
  manifestPath: string;
  registryPath: string;
  bindingPath: string;
  markerPath: string;
  options: MigrateProjectIdentityOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "aho-identity-migration-"));
  cleanup.push(root);
  const projectsRoot = join(root, "aho-home", "projects");
  const sourceSidecarRoot = join(projectsRoot, SOURCE_ID);
  const targetSidecarRoot = join(projectsRoot, TARGET_ID);
  const manifestPath = join(root, "project-skill", "state", "manifest.json");
  const registryPath = join(root, "aho-home", "registry.json");
  const bindingPath = join(root, "bindings", "project-binding.json");
  const markerPath = join(root, "project", ".agent-harness", "project.json");
  await mkdir(join(sourceSidecarRoot, "workbench"), { recursive: true });
  await mkdir(join(sourceSidecarRoot, "runs"), { recursive: true });
  await mkdir(join(sourceSidecarRoot, "worktrees", "metadata"), { recursive: true });
  await mkdir(join(manifestPath, ".."), { recursive: true });
  await mkdir(join(bindingPath, ".."), { recursive: true });
  await mkdir(join(markerPath, ".."), { recursive: true });
  await createDatabase(join(sourceSidecarRoot, "workbench", "workbench.sqlite"));
  await writeJson(join(sourceSidecarRoot, "runs", "run-1.json"), {
    projectId: SOURCE_ID,
    payload: { keep: "same" },
  });
  await writeJson(join(sourceSidecarRoot, "worktrees", "metadata", "wt-1.json"), {
    project_id: SOURCE_ID,
    worktreeId: "wt-1",
  });
  await writeJson(manifestPath, manifest(TARGET_ID));
  await writeJson(registryPath, {
    version: "1.0",
    projects: [
      { id: SOURCE_ID, name: SOURCE_ID },
      { id: "another-project", name: "another" },
    ],
  });
  await writeJson(bindingPath, { projectId: SOURCE_ID, provider: "codex", enabled: true });
  await writeJson(markerPath, { version: "1.0", id: SOURCE_ID, name: SOURCE_ID });
  return {
    root,
    projectsRoot,
    sourceSidecarRoot,
    targetSidecarRoot,
    manifestPath,
    registryPath,
    bindingPath,
    markerPath,
    options: {
      sourceProjectId: SOURCE_ID,
      targetProjectId: TARGET_ID,
      manifestPath,
      sourceSidecarRoot,
      targetSidecarRoot,
      transactionId,
      sqliteDatabases: [{
        relativePath: "workbench/workbench.sqlite",
        identityColumns: WORKBENCH_PROJECT_IDENTITY_COLUMNS,
        prepareStagedDatabase: prepareStagedWorkbenchSchema,
      }],
      jsonDocuments: [
        { kind: "runtime-state", scope: "sidecar", path: "runs/run-1.json", allowedIdentityPaths: ["/projectId"] },
        { kind: "runtime-state", scope: "sidecar", path: "worktrees/metadata/wt-1.json", allowedIdentityPaths: ["/project_id"] },
        { kind: "registry", scope: "external", path: registryPath, allowedIdentityPaths: ["/projects/*/id"] },
        { kind: "binding", scope: "external", path: bindingPath, allowedIdentityPaths: ["/projectId"] },
        { kind: "local-state", scope: "external", path: markerPath, allowedIdentityPaths: ["/id"] },
      ],
    },
  };
}

async function createDatabase(path: string): Promise<void> {
  const database = new Database(path);
  initializeCurrentWorkbenchSchema(database);
  database.exec(`
    CREATE TABLE skills (
      project_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY(project_id, skill_id)
    );
    CREATE TABLE bridge_sync (
      project_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      materialized_path TEXT NOT NULL,
      materialized_hash TEXT NOT NULL,
      bridge_version TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      PRIMARY KEY(project_id, skill_id)
    );
  `);
  database.prepare("INSERT INTO skills(project_id, skill_id, metadata_json) VALUES (?, ?, ?)")
    .run(SOURCE_ID, "skill-a", JSON.stringify({ name: "skill-a", enabled: true }));
  database.prepare("INSERT INTO skills(project_id, skill_id, metadata_json) VALUES (?, ?, ?)")
    .run(SOURCE_ID, "skill-b", JSON.stringify({ name: "skill-b", enabled: false }));
  database.prepare("INSERT INTO bridge_sync(project_id, skill_id, source_hash, materialized_path, materialized_hash, bridge_version, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(SOURCE_ID, "skill-a", "source", "legacy", "materialized", "1", new Date().toISOString());
  database.prepare("INSERT INTO conversations(project_id, conversation_id, product_mode, title, selected_provider_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(SOURCE_ID, "conversation-a", "harness", "Keep this title", "codex", new Date().toISOString(), new Date().toISOString());
  database.prepare("INSERT INTO canonical_timeline_items(id, project_id, conversation_id, change_id, position, revision, agent_surface_id, type, timestamp, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("timeline-a", SOURCE_ID, "conversation-a", "", 1, 1, "main-agent", "message", new Date().toISOString(), JSON.stringify({ type: "message", text: "unchanged" }));
  database.prepare("INSERT INTO composer_drafts(project_id, product_mode, agent_turn_mode, text, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(SOURCE_ID, "agent", "default", "Keep this draft", new Date().toISOString());
  materializeWorkbenchSchemaContract(database, 16);
  database.close();
}

async function sqliteProjectIds(path: string): Promise<Record<string, string[]>> {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(["canonical_timeline_items", "composer_drafts", "conversations"].map((table) => [
      table,
      (database.prepare(`SELECT DISTINCT project_id FROM ${table} ORDER BY project_id`).all() as Array<{ project_id: string }>)
        .map((row) => row.project_id),
    ]));
  } finally {
    database.close();
  }
}

function manifest(projectId: string): Record<string, unknown> {
  return {
    schema_version: "2.0",
    project_id: projectId,
    project_name: "sample",
    skill_name: `${TARGET_ID}-harness`,
    skill_revision: 27,
    analysis_status: "complete",
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T = Record<string, unknown>>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function hashTree(root: string): Promise<string> {
  const records: string[] = [];
  await visit(root);
  return createHash("sha256").update(records.sort().join("\n")).digest("hex");

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else records.push(`${relative(root, path).replace(/\\/g, "/")}\0${createHash("sha256").update(await readFile(path)).digest("hex")}`);
    }
  }
}
