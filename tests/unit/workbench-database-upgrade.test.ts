import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { WorkbenchDatabase } from "../../src/workbench/persistence/database.js";
import {
  digestWorkbenchDatabaseContent,
  inspectWorkbenchDatabaseUpgradeState,
} from "../../src/workbench/persistence/database-upgrade.js";
import { applyCurrentWorkbenchSchema, WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";
import { materializeWorkbenchSchemaContract } from "../../src/workbench/persistence/schema-migrations.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-database-upgrade-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Workbench database upgrade safety", () => {
  it("preflights new, upgradeable, current, legacy, and future databases without mutating them", async () => {
    const emptyPaths = resolveProjectRuntimePaths("empty", root);
    await expect(inspectWorkbenchDatabaseUpgradeState(emptyPaths)).resolves.toEqual({ state: "ready", schemaVersion: WORKBENCH_SCHEMA_VERSION });

    for (const revision of [16, 17] as const) {
      const paths = resolveProjectRuntimePaths(`preflight-${revision}`, root);
      await createLegacyDatabase(paths.workbenchDbPath, revision);
      const before = await digest(paths.workbenchDbPath);
      await expect(inspectWorkbenchDatabaseUpgradeState(paths)).resolves.toEqual({ state: "upgrade-required", schemaVersion: revision });
      expect(await digest(paths.workbenchDbPath)).toBe(before);
    }

    const currentPaths = resolveProjectRuntimePaths("preflight-current", root);
    const current = await WorkbenchDatabase.open(currentPaths, noActiveWorkGuard());
    current.close();
    await expect(inspectWorkbenchDatabaseUpgradeState(currentPaths)).resolves.toEqual({ state: "ready", schemaVersion: WORKBENCH_SCHEMA_VERSION });

    for (const revision of [7, 99]) {
      const paths = resolveProjectRuntimePaths(`preflight-unsupported-${revision}`, root);
      await createLegacyDatabase(paths.workbenchDbPath, 16);
      const raw = new Database(paths.workbenchDbPath);
      raw.pragma(`user_version = ${revision}`);
      raw.close();
      await expect(inspectWorkbenchDatabaseUpgradeState(paths)).resolves.toEqual({
        state: revision > WORKBENCH_SCHEMA_VERSION ? "newer-version" : "unsupported-legacy",
        schemaVersion: revision,
      });
    }
  });

  it.each([16, 17] as const)("backs up and explicitly migrates Schema %i to the current version", async (revision) => {
    const paths = resolveProjectRuntimePaths(`schema-${revision}`, root);
    await createLegacyDatabase(paths.workbenchDbPath, revision);

    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();

    const inspected = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(inspected.pragma("user_version", { simple: true }))).toBe(WORKBENCH_SCHEMA_VERSION);
    expect(inspected.prepare("SELECT text FROM canonical_timeline_items WHERE id = 'sentinel'").get()).toEqual({ text: "keep me" });
    expect(inspected.prepare("SELECT source_kind FROM skill_roots WHERE project_id = 'project' AND root_path = 'provider-root'").get())
      .toEqual({ source_kind: "provider" });
    inspected.close();

    const previousDir = join(dirname(paths.workbenchDbPath), "schema-upgrades", "previous");
    const receipt = JSON.parse(await readFile(join(previousDir, "receipt.json"), "utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({ fromSchema: revision, toSchema: WORKBENCH_SCHEMA_VERSION, result: "completed" });
    expect(receipt.appliedVersions).toEqual(revision === 16 ? [17, 18, 19, 20, 21] : [18, 19, 20, 21]);
    expect(receipt.preservedRecordCounts).toMatchObject({ canonical_timeline_items: 1 });
    expect(receipt.preservedIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(stat(join(previousDir, "workbench.sqlite"))).resolves.toBeTruthy();
  });

  it("does not create a backup for a current database", async () => {
    const paths = resolveProjectRuntimePaths("current", root);
    const first = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    first.close();
    const second = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    second.close();
    await expect(stat(join(dirname(paths.workbenchDbPath), "schema-upgrades"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates a real additive-layout Schema 18 database without classifying it as corrupt", async () => {
    const paths = resolveProjectRuntimePaths("additive-schema-18", root);
    await createAdditiveLayoutSchema18Database(paths.workbenchDbPath);
    await expect(inspectWorkbenchDatabaseUpgradeState(paths)).resolves.toEqual({
      state: "upgrade-required",
      schemaVersion: 18,
    });

    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();

    const verified = new Database(paths.workbenchDbPath, { readonly: true });
    expect(verified.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(verified.pragma("user_version", { simple: true })).toBe(WORKBENCH_SCHEMA_VERSION);
    expect(verified.prepare("SELECT title FROM conversations WHERE conversation_id = 'additive-conversation'").get())
      .toEqual({ title: "Preserved conversation" });
    verified.close();
  });

  it.each([7, 99])("fails closed and byte-preserves unsupported Schema %i", async (revision) => {
    const paths = resolveProjectRuntimePaths(`unsupported-${revision}`, root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const raw = new Database(paths.workbenchDbPath);
    raw.pragma(`user_version = ${revision}`);
    raw.close();
    const before = await digest(paths.workbenchDbPath);

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({
      code: revision > WORKBENCH_SCHEMA_VERSION ? "newer-version" : "unsupported-legacy",
    });
    expect(await digest(paths.workbenchDbPath)).toBe(before);
  });

  it("restores the original database and suppresses an identical failed retry", async () => {
    const paths = resolveProjectRuntimePaths("failed", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    let migrationAttempts = 0;
    const beforeGuard = noActiveWorkGuard();
    await expect(WorkbenchDatabase.open(paths, beforeGuard, undefined, {
      createTransactionId: () => "forced-failure",
      now: () => "2026-09-11T00:00:00.000Z",
      beforeMigration: () => {
        migrationAttempts += 1;
        throw new Error("injected migration failure");
      },
    })).rejects.toMatchObject({ code: "recovery-required" });
    expect(migrationAttempts).toBe(1);

    const restored = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(restored.pragma("user_version", { simple: true }))).toBe(16);
    expect(restored.prepare("SELECT text FROM canonical_timeline_items WHERE id = 'sentinel'").get()).toEqual({ text: "keep me" });
    restored.close();
    const recoveryDir = join(dirname(paths.workbenchDbPath), "schema-upgrades", "recovery");
    const receipt = JSON.parse(await readFile(join(recoveryDir, "receipt.json"), "utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({ fromSchema: 16, toSchema: WORKBENCH_SCHEMA_VERSION, result: "restored" });

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      beforeMigration: () => {
        migrationAttempts += 1;
      },
    })).rejects.toMatchObject({ code: "recovery-required" });
    expect(migrationAttempts).toBe(1);
    expect((await readdir(join(dirname(paths.workbenchDbPath), "schema-upgrades"))).filter((name) => name.startsWith("staging-"))).toEqual([]);
  });

  it("fails closed when a recovery marker exists but cannot be trusted", async () => {
    const paths = resolveProjectRuntimePaths("invalid-marker", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const markerPath = join(dirname(paths.workbenchDbPath), "schema-upgrades", "recovery-required.json");
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "{not-json", "utf8");

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({
      code: "recovery-required",
    });
  });

  it("rejects a current-version database whose required structure is damaged", async () => {
    const paths = resolveProjectRuntimePaths("damaged-current", root);
    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    const raw = new Database(paths.workbenchDbPath);
    raw.exec("DROP TABLE conversation_review_operations");
    raw.close();

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "corrupt" });
  });

  it.each([
    "conversation_change_links",
    "conversation_graph_scopes",
    "planning_acceptance_commits",
    "skill_roots",
    "skill_enablement",
  ])("rejects the current Schema when durable table %s is missing", async (table) => {
    const paths = resolveProjectRuntimePaths(`damaged-current-${table.replaceAll("_", "-")}`, root);
    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    const raw = new Database(paths.workbenchDbPath);
    raw.exec(`DROP TABLE "${table}"`);
    raw.close();
    const before = await digest(paths.workbenchDbPath);

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "corrupt" });
    expect(await digest(paths.workbenchDbPath)).toBe(before);
  });

  it("rejects a current database whose durable index contract is incomplete", async () => {
    const paths = resolveProjectRuntimePaths("damaged-current-index", root);
    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    const raw = new Database(paths.workbenchDbPath);
    raw.exec("DROP INDEX idx_conversations_project_updated");
    raw.close();
    const before = await digest(paths.workbenchDbPath);

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "corrupt" });
    expect(await digest(paths.workbenchDbPath)).toBe(before);
  });

  it.each(["missing", "malformed"])("rejects a current database with a %s durable trigger", async (kind) => {
    const paths = resolveProjectRuntimePaths(`damaged-current-trigger-${kind}`, root);
    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    const raw = new Database(paths.workbenchDbPath);
    raw.exec("DROP TRIGGER trg_conversations_product_mode_immutable");
    if (kind === "malformed") {
      raw.exec(`CREATE TRIGGER trg_conversations_product_mode_immutable
        BEFORE UPDATE OF product_mode ON conversations BEGIN SELECT 1; END`);
    }
    raw.close();
    const before = await digest(paths.workbenchDbPath);

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "corrupt" });
    expect(await digest(paths.workbenchDbPath)).toBe(before);
  });

  it("rejects an incomplete supported migration source without filling in missing durable data", async () => {
    const paths = resolveProjectRuntimePaths("damaged-supported", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const raw = new Database(paths.workbenchDbPath);
    raw.exec("DROP TABLE provider_resume_points");
    raw.close();
    const before = await digest(paths.workbenchDbPath);

    await expect(inspectWorkbenchDatabaseUpgradeState(paths)).resolves.toEqual({
      state: "recovery-required",
      schemaVersion: null,
    });
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "corrupt" });
    expect(await digest(paths.workbenchDbPath)).toBe(before);
  });

  it("restores a verified snapshot after an interrupted staged migration", async () => {
    const paths = resolveProjectRuntimePaths("interrupted-staged", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const stagingDir = join(dirname(paths.workbenchDbPath), "schema-upgrades", "staging-interrupted");
    const snapshotPath = join(stagingDir, "workbench.sqlite");
    await mkdir(stagingDir, { recursive: true });
    await copyFile(paths.workbenchDbPath, snapshotPath);
    await writeFile(join(stagingDir, "receipt.json"), `${JSON.stringify({
      schemaVersion: "1.0",
      transactionId: "interrupted",
      fromSchema: 16,
      toSchema: 18,
      migrationImplementationVersion: 1,
      sourceFileDigest: await digest(paths.workbenchDbPath),
      sourceDigest: digestWorkbenchDatabaseContent(snapshotPath),
      snapshotDigest: await digest(snapshotPath),
      targetDigest: null,
      preservedRecordCounts: {},
      preservedIdentityDigest: "test",
      appliedVersions: [],
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: null,
      result: "staged",
    }, null, 2)}\n`, "utf8");

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "recovery-required" });
    const restored = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(restored.pragma("user_version", { simple: true }))).toBe(16);
    restored.close();
    await expect(stat(join(dirname(paths.workbenchDbPath), "schema-upgrades", "recovery", "receipt.json"))).resolves.toBeTruthy();
  });

  it("does not overwrite a replacement database when staged recovery evidence is stale", async () => {
    const paths = resolveProjectRuntimePaths("stale-staged-replacement", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const stagingDir = join(dirname(paths.workbenchDbPath), "schema-upgrades", "staging-stale");
    const snapshotPath = join(stagingDir, "workbench.sqlite");
    await mkdir(stagingDir, { recursive: true });
    await copyFile(paths.workbenchDbPath, snapshotPath);
    const sourceFileDigest = await digest(paths.workbenchDbPath);
    await writeFile(join(stagingDir, "receipt.json"), `${JSON.stringify({
      schemaVersion: "1.0",
      transactionId: "stale",
      fromSchema: 16,
      toSchema: 18,
      migrationImplementationVersion: 1,
      sourceFileDigest,
      sourceDigest: digestWorkbenchDatabaseContent(snapshotPath),
      snapshotDigest: await digest(snapshotPath),
      targetDigest: null,
      preservedRecordCounts: {},
      preservedIdentityDigest: "test",
      appliedVersions: [],
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: null,
      result: "staged",
    }, null, 2)}\n`, "utf8");
    const replacement = new Database(paths.workbenchDbPath);
    replacement.pragma("user_version = 99");
    replacement.close();
    const replacementDigest = await digest(paths.workbenchDbPath);

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "recovery-required" });
    expect(await digest(paths.workbenchDbPath)).toBe(replacementDigest);
    const preserved = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(preserved.pragma("user_version", { simple: true }))).toBe(99);
    preserved.close();
  });

  it("resumes a restore that stopped after displacing the live database", async () => {
    const paths = resolveProjectRuntimePaths("interrupted-restore-swap", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const upgradeRoot = join(dirname(paths.workbenchDbPath), "schema-upgrades");
    const stagingDir = join(upgradeRoot, "staging-resume-restore");
    const snapshotPath = join(stagingDir, "workbench.sqlite");
    await mkdir(stagingDir, { recursive: true });
    await copyFile(paths.workbenchDbPath, snapshotPath);
    const sourceFileDigest = await digest(paths.workbenchDbPath);
    await writeFile(join(stagingDir, "receipt.json"), `${JSON.stringify({
      schemaVersion: "1.0",
      transactionId: "resume-restore",
      fromSchema: 16,
      toSchema: 18,
      migrationImplementationVersion: 1,
      sourceFileDigest,
      sourceDigest: digestWorkbenchDatabaseContent(snapshotPath),
      snapshotDigest: await digest(snapshotPath),
      targetDigest: null,
      preservedRecordCounts: {},
      preservedIdentityDigest: "test",
      appliedVersions: [],
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: null,
      result: "staged",
    }, null, 2)}\n`, "utf8");
    await copyFile(snapshotPath, `${paths.workbenchDbPath}.resume-restore.restore`);
    await writeFile(join(upgradeRoot, "restore-transaction.json"), `${JSON.stringify({
      schemaVersion: "1.0",
      transactionId: "resume-restore",
      expectedLiveDigest: sourceFileDigest,
      snapshotDigest: await digest(snapshotPath),
      phase: "prepared",
    }, null, 2)}\n`, "utf8");
    await rename(paths.workbenchDbPath, `${paths.workbenchDbPath}.resume-restore.failed`);

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "recovery-required" });
    const restored = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(restored.pragma("user_version", { simple: true }))).toBe(16);
    restored.close();
    await expect(stat(join(upgradeRoot, "restore-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recreates a missing recovery marker from verified recovery evidence", async () => {
    const paths = resolveProjectRuntimePaths("missing-recovery-marker", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "marker-recovery",
      beforeMigration: () => { throw new Error("injected migration failure"); },
    })).rejects.toMatchObject({ code: "recovery-required" });
    const markerPath = join(dirname(paths.workbenchDbPath), "schema-upgrades", "recovery-required.json");
    await rm(markerPath, { force: true });

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "recovery-required" });
    await expect(stat(markerPath)).resolves.toBeTruthy();
  });

  it("retries a failed source after the migration implementation identity changes", async () => {
    const paths = resolveProjectRuntimePaths("implementation-retry", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "implementation-retry",
      beforeMigration: () => { throw new Error("old implementation failure"); },
    })).rejects.toMatchObject({ code: "recovery-required" });
    const upgradeRoot = join(dirname(paths.workbenchDbPath), "schema-upgrades");
    for (const evidencePath of [
      join(upgradeRoot, "recovery", "receipt.json"),
      join(upgradeRoot, "recovery-required.json"),
    ]) {
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { migrationImplementationVersion: number };
      evidence.migrationImplementationVersion += 1;
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }

    await expect(inspectWorkbenchDatabaseUpgradeState(paths)).resolves.toEqual({ state: "upgrade-required", schemaVersion: 16 });
    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    const verified = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(verified.pragma("user_version", { simple: true }))).toBe(WORKBENCH_SCHEMA_VERSION);
    verified.close();
  });

  it("retains earlier recovery evidence until a replacement migration reaches durable evidence", async () => {
    const paths = resolveProjectRuntimePaths("implementation-retry-interrupted", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "implementation-retry-interrupted-old",
      beforeMigration: () => { throw new Error("old implementation failure"); },
    })).rejects.toMatchObject({ code: "recovery-required" });
    const upgradeRoot = join(dirname(paths.workbenchDbPath), "schema-upgrades");
    const receiptPath = join(upgradeRoot, "recovery", "receipt.json");
    const markerPath = join(upgradeRoot, "recovery-required.json");
    for (const evidencePath of [receiptPath, markerPath]) {
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { migrationImplementationVersion: number };
      evidence.migrationImplementationVersion += 1;
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    const receiptBefore = await digest(receiptPath);
    const markerBefore = await digest(markerPath);

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "implementation-retry-interrupted-new",
      beforeCheckpoint: () => { throw new Error("interrupted before replacement evidence"); },
    })).rejects.toThrow("interrupted before replacement evidence");

    expect(await digest(receiptPath)).toBe(receiptBefore);
    expect(await digest(markerPath)).toBe(markerBefore);
    await expect(stat(join(upgradeRoot, "recovery", "workbench.sqlite"))).resolves.toBeTruthy();
  });

  it("reconciles a newly promoted recovery receipt over an older marker after a crash", async () => {
    const paths = resolveProjectRuntimePaths("recovery-marker-swap", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "recovery-marker-swap-old",
      beforeMigration: () => { throw new Error("old implementation failure"); },
    })).rejects.toMatchObject({ code: "recovery-required" });
    const upgradeRoot = join(dirname(paths.workbenchDbPath), "schema-upgrades");
    const receiptPath = join(upgradeRoot, "recovery", "receipt.json");
    const markerPath = join(upgradeRoot, "recovery-required.json");
    for (const evidencePath of [receiptPath, markerPath]) {
      const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { migrationImplementationVersion: number };
      evidence.migrationImplementationVersion += 1;
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }

    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "recovery-marker-swap-new",
      beforeMigration: () => { throw new Error("new implementation failure"); },
      afterRecoveryEvidencePromoted: () => { throw new Error("simulated crash before marker replacement"); },
    })).rejects.toMatchObject({ code: "recovery-required" });
    const promotedReceipt = JSON.parse(await readFile(receiptPath, "utf8")) as { migrationImplementationVersion: number };
    const staleMarker = JSON.parse(await readFile(markerPath, "utf8")) as { migrationImplementationVersion: number };
    expect(promotedReceipt.migrationImplementationVersion).toBe(3);
    expect(staleMarker.migrationImplementationVersion).toBe(4);

    let migrationRetried = false;
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      beforeMigration: () => { migrationRetried = true; },
    })).rejects.toMatchObject({ code: "recovery-required" });
    expect(migrationRetried).toBe(false);
    const reconciledMarker = JSON.parse(await readFile(markerPath, "utf8")) as { migrationImplementationVersion: number };
    expect(reconciledMarker.migrationImplementationVersion).toBe(3);
  });

  it("retries after a recovered Schema 16 source receives a later durable write", async () => {
    const paths = resolveProjectRuntimePaths("changed-source-retry", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "changed-source-retry",
      beforeMigration: () => { throw new Error("initial migration failure"); },
    })).rejects.toMatchObject({ code: "recovery-required" });
    const changed = new Database(paths.workbenchDbPath);
    changed.prepare(`
      INSERT INTO skill_roots(project_id, root_path, source_kind, updated_at)
      VALUES ('changed-source-retry', 'stable-root', 'custom', '2026-09-11T00:00:00.000Z')
    `).run();
    changed.close();

    await expect(inspectWorkbenchDatabaseUpgradeState(paths)).resolves.toEqual({ state: "upgrade-required", schemaVersion: 16 });
    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    const verified = new Database(paths.workbenchDbPath, { readonly: true });
    expect(verified.prepare("SELECT root_path FROM skill_roots WHERE project_id = ?").get("changed-source-retry"))
      .toEqual({ root_path: "stable-root" });
    verified.close();
  });

  it("clears stale recovery evidence when a separately restored current database is valid", async () => {
    const paths = resolveProjectRuntimePaths("stale-recovery-marker", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "stale-marker",
      beforeMigration: () => { throw new Error("injected migration failure"); },
    })).rejects.toMatchObject({ code: "recovery-required" });
    await rm(paths.workbenchDbPath, { force: true });
    const replacement = new Database(paths.workbenchDbPath);
    applyCurrentWorkbenchSchema(replacement);
    replacement.pragma(`user_version = ${WORKBENCH_SCHEMA_VERSION}`);
    replacement.close();

    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    await expect(stat(join(dirname(paths.workbenchDbPath), "schema-upgrades", "recovery-required.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dirname(paths.workbenchDbPath), "schema-upgrades", "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defers migration when a WAL checkpoint cannot include every committed frame", async () => {
    const paths = resolveProjectRuntimePaths("busy-checkpoint", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const reader = new Database(paths.workbenchDbPath);
    reader.pragma("journal_mode = WAL");
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS count FROM canonical_timeline_items").get();
    const writer = new Database(paths.workbenchDbPath);
    writer.prepare("UPDATE canonical_timeline_items SET text = ? WHERE id = 'sentinel'").run("committed in WAL");
    writer.close();
    try {
      await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ name: "WorkbenchMigrationBusyError" });
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
    const preserved = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(preserved.pragma("user_version", { simple: true }))).toBe(16);
    expect(preserved.prepare("SELECT text FROM canonical_timeline_items WHERE id = 'sentinel'").get()).toEqual({ text: "committed in WAL" });
    preserved.close();
    await expect(stat(join(dirname(paths.workbenchDbPath), "schema-upgrades", "recovery-required.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds the SQLite writer fence from the snapshot through migration commit", async () => {
    const paths = resolveProjectRuntimePaths("writer-fence", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    let writerBlocked = false;
    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      beforeMigration: () => {
        const competing = new Database(paths.workbenchDbPath);
        competing.pragma("busy_timeout = 50");
        try {
          competing.prepare("UPDATE canonical_timeline_items SET text = 'raced' WHERE id = 'sentinel'").run();
        } catch {
          writerBlocked = true;
        } finally {
          competing.close();
        }
      },
    });
    opened.close();
    expect(writerBlocked).toBe(true);
    const current = new Database(paths.workbenchDbPath, { readonly: true });
    expect(current.prepare("SELECT text FROM canonical_timeline_items WHERE id = 'sentinel'").get()).toEqual({ text: "keep me" });
    current.close();
  });

  it("finalizes a commit-pending receipt after a crash immediately following SQLite commit", async () => {
    const paths = resolveProjectRuntimePaths("commit-pending", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard(), undefined, {
      createTransactionId: () => "commit-pending",
      afterCommit: () => { throw new Error("simulated process exit after commit"); },
    })).rejects.toMatchObject({ code: "recovery-required" });

    const reopened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    reopened.close();
    const current = new Database(paths.workbenchDbPath, { readonly: true });
    expect(Number(current.pragma("user_version", { simple: true }))).toBe(WORKBENCH_SCHEMA_VERSION);
    expect(current.prepare("SELECT text FROM canonical_timeline_items WHERE id = 'sentinel'").get()).toEqual({ text: "keep me" });
    current.close();
    const receipt = JSON.parse(await readFile(join(dirname(paths.workbenchDbPath), "schema-upgrades", "previous", "receipt.json"), "utf8")) as { result: string };
    expect(receipt.result).toBe("completed");
  });

  it("rejects a stale staged receipt without deleting a later WAL-only commit", async () => {
    const paths = resolveProjectRuntimePaths("stale-wal", root);
    await createLegacyDatabase(paths.workbenchDbPath, 16);
    const stagingDir = join(dirname(paths.workbenchDbPath), "schema-upgrades", "staging-stale-wal");
    const snapshotPath = join(stagingDir, "workbench.sqlite");
    await mkdir(stagingDir, { recursive: true });
    await copyFile(paths.workbenchDbPath, snapshotPath);
    await writeFile(join(stagingDir, "receipt.json"), `${JSON.stringify({
      schemaVersion: "1.0",
      transactionId: "stale-wal",
      fromSchema: 16,
      toSchema: 18,
      migrationImplementationVersion: 1,
      sourceFileDigest: await digest(paths.workbenchDbPath),
      sourceDigest: digestWorkbenchDatabaseContent(snapshotPath),
      snapshotDigest: await digest(snapshotPath),
      targetDigest: null,
      preservedRecordCounts: {},
      preservedIdentityDigest: "test",
      appliedVersions: [],
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: null,
      result: "staged",
    }, null, 2)}\n`, "utf8");
    const reader = new Database(paths.workbenchDbPath);
    reader.pragma("journal_mode = WAL");
    reader.exec("BEGIN");
    reader.prepare("SELECT text FROM canonical_timeline_items WHERE id = 'sentinel'").get();
    const writer = new Database(paths.workbenchDbPath);
    writer.prepare("UPDATE canonical_timeline_items SET text = 'later commit' WHERE id = 'sentinel'").run();
    writer.close();
    try {
      await expect(WorkbenchDatabase.open(paths, noActiveWorkGuard())).rejects.toMatchObject({ code: "recovery-required" });
      expect(await stat(`${paths.workbenchDbPath}-wal`)).toBeTruthy();
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
    const preserved = new Database(paths.workbenchDbPath, { readonly: true });
    expect(preserved.prepare("SELECT text FROM canonical_timeline_items WHERE id = 'sentinel'").get()).toEqual({ text: "later commit" });
    preserved.close();
  });

  it("finalizes a committed migration whose snapshot promotion was interrupted", async () => {
    const paths = resolveProjectRuntimePaths("interrupted-completed", root);
    await createLegacyDatabase(paths.workbenchDbPath, 17);
    const stagingDir = join(dirname(paths.workbenchDbPath), "schema-upgrades", "staging-completed");
    const snapshotPath = join(stagingDir, "workbench.sqlite");
    await mkdir(stagingDir, { recursive: true });
    await copyFile(paths.workbenchDbPath, snapshotPath);
    const raw = new Database(paths.workbenchDbPath);
    applyCurrentWorkbenchSchema(raw);
    raw.pragma(`user_version = ${WORKBENCH_SCHEMA_VERSION}`);
    raw.close();
    const targetDigest = await digest(paths.workbenchDbPath);
    await writeFile(join(stagingDir, "receipt.json"), `${JSON.stringify({
      schemaVersion: "1.0",
      transactionId: "completed",
      fromSchema: 17,
      toSchema: WORKBENCH_SCHEMA_VERSION,
      migrationImplementationVersion: 3,
      sourceFileDigest: await digest(snapshotPath),
      sourceDigest: digestWorkbenchDatabaseContent(snapshotPath),
      snapshotDigest: await digest(snapshotPath),
      targetDigest,
      preservedRecordCounts: {},
      preservedIdentityDigest: "test",
      appliedVersions: [18, 19, 20],
      startedAt: "2026-09-11T00:00:00.000Z",
      completedAt: "2026-09-11T00:00:01.000Z",
      result: "completed",
    }, null, 2)}\n`, "utf8");

    const opened = await WorkbenchDatabase.open(paths, noActiveWorkGuard());
    opened.close();
    await expect(stat(join(dirname(paths.workbenchDbPath), "schema-upgrades", "previous", "workbench.sqlite"))).resolves.toBeTruthy();
    await expect(stat(stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function noActiveWorkGuard() {
  return { assertSafe: async () => undefined };
}

async function createLegacyDatabase(path: string, revision: 16 | 17): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const database = new Database(path);
  applyCurrentWorkbenchSchema(database);
  database.prepare(`INSERT INTO canonical_timeline_items (
    id, project_id, conversation_id, change_id, position, revision, agent_surface_id,
    initial_thread_input, type, timestamp, text, raw_json
  ) VALUES ('sentinel', 'project', '', '', 1, 1, 'main-agent', 0, 'user.message', '2026-09-11T00:00:00.000Z', 'keep me', '{}')`).run();
  database.prepare("INSERT INTO skill_roots(project_id, root_path, source_kind, updated_at) VALUES ('project', 'provider-root', 'provider', '2026-09-11T00:00:00.000Z')").run();
  materializeWorkbenchSchemaContract(database, revision);
  database.close();
}

async function createAdditiveLayoutSchema18Database(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const reference = new Database(":memory:");
  applyCurrentWorkbenchSchema(reference);
  materializeWorkbenchSchemaContract(reference, 18);
  const schemaRows = reference.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name
  `).all() as Array<{ type: "table" | "index" | "trigger"; name: string; sql: string }>;
  reference.close();

  const historicalSql = schemaRows.map((row) => {
    if (row.type !== "table") return row.sql;
    if (row.name === "conversations") {
      return row.sql
        .replace("agent_turn_mode TEXT CHECK(agent_turn_mode IN ('default', 'plan') OR agent_turn_mode IS NULL)", "agent_turn_mode TEXT")
        .replace("product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness'))", "product_mode TEXT NOT NULL DEFAULT 'harness' CHECK(product_mode IN ('agent', 'harness'))");
    }
    if (row.name === "provider_attempts") {
      return row.sql
        .replace("product_mode TEXT NOT NULL CHECK(product_mode IN ('agent', 'harness'))", "product_mode TEXT NOT NULL DEFAULT 'harness' CHECK(product_mode IN ('agent', 'harness'))")
        .replace(/,\s*CHECK\(conversation_id IS NOT NULL OR product_mode = 'harness'\)/, "");
    }
    return row.sql;
  });

  const database = new Database(path);
  try {
    database.exec(historicalSql.join(";\n"));
    database.prepare(`INSERT INTO conversations (
      project_id, conversation_id, product_mode, agent_turn_mode, title, state, surface_kind,
      selected_provider_id, completed_turn_sequence, timeline_position, timeline_revision, created_at, updated_at
    ) VALUES ('project', 'additive-conversation', 'harness', NULL, 'Preserved conversation', 'active', 'user',
      'codex', 0, 0, 0, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z')`).run();
    database.pragma("user_version = 18");
  } finally {
    database.close();
  }
}

async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
