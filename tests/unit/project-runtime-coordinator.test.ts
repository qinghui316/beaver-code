import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRuntimeCoordinator } from "../../src/project-runtime/coordinator.js";
import { buildProjectIdentityRecoveryDocuments } from "../../src/project-runtime/identity-migration-descriptors.js";
import type { ProjectIdentityMigrationJournal } from "../../src/project-runtime/identity-migration.js";
import {
  claimProjectHarnessWriterLock,
  releaseProjectHarnessWriterLock,
} from "../../src/project-harness/writer-lock.js";
import { ProjectRegistryStore } from "../../src/registry/store.js";
import { git } from "../../src/project/git.js";
import { getWorktreeStatus } from "../../src/worktree/manager.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../../src/provider-runtime/project-harness-discovery.js";
import { initializeCurrentWorkbenchSchema, materializeWorkbenchSchemaContract } from "../../src/workbench/persistence/schema-migrations.js";
import { WORKBENCH_SCHEMA_VERSION } from "../../src/workbench/persistence/schema.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project runtime coordinator", () => {
  it("atomically reconciles a registered id to the Harness manifest project_id", async () => {
    const fixture = await createLegacyFixture();
    const result = await fixture.coordinator.reconcileStartup();

    expect(result.migrations).toHaveLength(1);
    expect(result.recoveries).toEqual([]);
    expect(result.states).toEqual([
      expect.objectContaining({ state: "repair-required", project: expect.objectContaining({ id: "canonical-a1" }) }),
    ]);
    expect(await fixture.store.resolveProject("legacy-a1")).toBeNull();
    expect(await fixture.store.resolveProject("canonical-a1")).toMatchObject({ path: fixture.projectRoot });
    expect(existsSync(fixture.sourceSidecar)).toBe(false);
    expect(existsSync(fixture.targetSidecar)).toBe(true);
    const database = new Database(join(fixture.targetSidecar, "workbench", "workbench.sqlite"), { readonly: true });
    try {
      expect(database.pragma("user_version", { simple: true })).toBe(WORKBENCH_SCHEMA_VERSION);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skills'").get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("classifies a project without a Harness as onboarding without creating legacy state", async () => {
    const root = await mkdtemp(join(tmpdir(), "aho-runtime-onboarding-"));
    cleanup.push(root);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = new ProjectRegistryStore(join(root, "aho-home"));
    const { project } = await store.registerProject({ path: projectRoot, name: "New Project" });
    const coordinator = new ProjectRuntimeCoordinator({
      store,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });

    const state = await coordinator.resolve(project);

    expect(state).toMatchObject({ state: "onboarding", reservedProjectId: project.id, projectRoot });
    expect(existsSync(join(projectRoot, ".agent-harness", "project.json"))).toBe(false);
    expect(state.state === "onboarding" && existsSync(state.paths.sidecarRoot)).toBe(false);
  });

  it("reconciles startup when an optional Host binding is absent", async () => {
    const fixture = await createLegacyFixture();
    await expect(fixture.coordinator.reconcileStartup()).resolves.toMatchObject({ migrations: [expect.any(Object)] });
    expect(await fixture.store.resolveProject("legacy-a1")).toBeNull();
    expect(existsSync(fixture.targetSidecar)).toBe(true);
  });

  it("isolates an unclassified project identity without changing Registry or sidecar state", async () => {
    const fixture = await createLegacyFixture();
    const runRoot = join(fixture.sourceSidecar, "runs", "run-1");
    await mkdir(runRoot, { recursive: true });
    await writeFile(
      join(runRoot, "agent-events.jsonl"),
      `${JSON.stringify({ projectId: "legacy-a1", event: "started" })}\n`,
      "utf8",
    );

    const startup = await fixture.coordinator.reconcileStartup();

    expect(startup.states).toEqual([
      expect.objectContaining({
        state: "unavailable",
        issue: expect.objectContaining({ code: "harness-invalid" }),
      }),
    ]);
    await expect(fixture.coordinator.requireReady(fixture.project)).rejects.toThrow("这个项目需要处理后才能继续使用");
    expect(await fixture.store.resolveProject("legacy-a1")).not.toBeNull();
    expect(await fixture.store.resolveProject("canonical-a1")).toBeNull();
    expect(existsSync(fixture.sourceSidecar)).toBe(true);
    expect(existsSync(fixture.targetSidecar)).toBe(false);
  });

  it("isolates a registered project whose Harness manifest remains but SKILL.md is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "aho-runtime-partial-harness-"));
    cleanup.push(root);
    const projectRoot = join(root, "project");
    const skillRoot = join(projectRoot, ".agents", "skills", "partial-harness");
    await mkdir(join(skillRoot, "state"), { recursive: true });
    await writeFile(join(skillRoot, "state", "manifest.json"), `${JSON.stringify({
      schema_version: "2.0",
      project_id: "partial-project",
      project_name: "Partial",
      skill_name: "partial-harness",
      skill_revision: 1,
      analysis_status: "complete",
    })}\n`, "utf8");
    const store = new ProjectRegistryStore(join(root, "aho-home"));
    const project = (await store.registerProject({ path: projectRoot, name: "Partial", projectId: "partial-project" })).project;
    const coordinator = new ProjectRuntimeCoordinator({
      store,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });

    const startup = await coordinator.reconcileStartup();

    expect(startup.states).toEqual([
      expect.objectContaining({
        state: "unavailable",
        project: expect.objectContaining({ id: project.id }),
        issue: expect.objectContaining({ code: "harness-missing" }),
      }),
    ]);
    await expect(coordinator.requireReady(project)).rejects.toThrow("这个项目需要处理后才能继续使用");
  });

  it("keeps other registered projects available when one project directory is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "aho-runtime-isolation-"));
    cleanup.push(root);
    const existingRoot = join(root, "existing");
    const missingRoot = join(root, "missing");
    await mkdir(existingRoot);
    const store = new ProjectRegistryStore(join(root, "aho-home"));
    const existing = (await store.registerProject({ path: existingRoot, name: "Existing" })).project;
    const missing = (await store.registerProject({ path: missingRoot, name: "Missing" })).project;
    const coordinator = new ProjectRuntimeCoordinator({
      store,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });

    const startup = await coordinator.reconcileStartup();

    expect(startup.states).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "onboarding", project: expect.objectContaining({ id: existing.id }) }),
      expect.objectContaining({ state: "unavailable", project: expect.objectContaining({ id: missing.id }) }),
    ]));
    await expect(coordinator.resolve(existing)).resolves.toMatchObject({ state: "onboarding" });
    await expect(coordinator.resolve(missing)).rejects.toThrow("这个项目需要处理后才能继续使用");
  });

  it("preserves a registered legacy-id Git worktree across canonical identity migration", async () => {
    const fixture = await createLegacyFixture();
    await git(fixture.projectRoot, ["init"]);
    await git(fixture.projectRoot, ["config", "user.email", "aho-tests@example.invalid"]);
    await git(fixture.projectRoot, ["config", "user.name", "AHO Tests"]);
    await writeFile(join(fixture.projectRoot, "README.md"), "project\n", "utf8");
    await git(fixture.projectRoot, ["add", "README.md"]);
    await git(fixture.projectRoot, ["commit", "-m", "initial"]);
    const checkoutPath = join(fixture.ahoHome, "worktrees", "legacy-a1", "checkouts", "worktree-1");
    await mkdir(join(checkoutPath, ".."), { recursive: true });
    await git(fixture.projectRoot, ["worktree", "add", "-b", "aho/existing-worktree", checkoutPath, "HEAD"]);
    const metadataRoot = join(fixture.sourceSidecar, "worktrees", "metadata");
    await mkdir(metadataRoot, { recursive: true });
    await writeFile(join(metadataRoot, "worktree-1.json"), `${JSON.stringify({
      version: "1.0",
      worktreeId: "worktree-1",
      projectId: "legacy-a1",
      changeId: "existing-change",
      branchName: "aho/existing-worktree",
      baseRef: "HEAD",
      baseCommit: await git(fixture.projectRoot, ["rev-parse", "HEAD"]),
      createdFromDirtyProject: false,
      createdAt: "2026-08-03T00:00:00.000Z",
      status: "active",
      checkoutPath,
    }, null, 2)}\n`, "utf8");

    const previousAhoHome = process.env.AHO_HOME;
    process.env.AHO_HOME = fixture.ahoHome;
    try {
      await fixture.coordinator.reconcileStartup();
      const migratedProject = await fixture.store.resolveProject("canonical-a1");
      expect(migratedProject).not.toBeNull();
      await expect(getWorktreeStatus({
        projectId: migratedProject!.id,
        projectRoot: migratedProject!.path,
        worktreeMetadataRoot: join(fixture.targetSidecar, "worktrees", "metadata"),
      }, "worktree-1")).resolves.toMatchObject({
        projectId: "canonical-a1",
        checkoutPath,
        exists: true,
      });
    } finally {
      if (previousAhoHome === undefined) delete process.env.AHO_HOME;
      else process.env.AHO_HOME = previousAhoHome;
    }
  });

  it("serializes startup reconciliation through the shared writer lock", async () => {
    const fixture = await createLegacyFixture();
    const projectsRoot = join(fixture.ahoHome, "projects");
    const lock = await claimProjectHarnessWriterLock(projectsRoot, {
      projectId: "project-runtime-identities",
      ownerId: "other-startup",
      operation: "migrate",
    });
    try {
      await expect(fixture.coordinator.reconcileStartup()).rejects.toThrow(/writer lock is already held/);
    } finally {
      await releaseProjectHarnessWriterLock(projectsRoot, lock.token);
    }
  });

  it("rejects recovery documents outside the caller-owned Registry and sidecar schemas", async () => {
    const fixture = await createLegacyFixture();
    const journal = recoveryJournal(fixture);
    journal.documents.push({
      ...journal.documents[0]!,
      kind: "binding",
      sourcePath: join(fixture.root, "unrelated.json"),
    });

    await expect(buildProjectIdentityRecoveryDocuments(journal, fixture.store, DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY))
      .rejects.toThrow(/supported Registry and sidecar descriptor set/);
  });

  it("rejects a recovery sidecar document that escapes the journal source sidecar", async () => {
    const fixture = await createLegacyFixture();
    const journal = recoveryJournal(fixture);
    const sourcePath = join(fixture.sourceSidecar, "..", "other-project", "worktrees", "metadata", "worktree.json");
    journal.documents.push({
      ...journal.documents[0]!,
      kind: "runtime-state",
      scope: "sidecar",
      sourcePath,
      stagedPath: join(fixture.ahoHome, "projects", ".canonical-a1.identity-recovery-test.staged", "worktrees", "metadata", "worktree.json"),
      backupPath: null,
      allowedIdentityPaths: ["/projectId"],
    });

    await expect(buildProjectIdentityRecoveryDocuments(journal, fixture.store, DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY))
      .rejects.toThrow(/outside the source sidecar/);
  });

  it("derives the recovery manifest path from the caller-owned Registry project", async () => {
    const fixture = await createLegacyFixture();
    const manifestJournal = recoveryJournal(fixture);
    manifestJournal.manifestPath = join(
      fixture.projectRoot,
      ".agents",
      "skills",
      "unrelated-harness",
      "state",
      "manifest.json",
    );
    await expect(buildProjectIdentityRecoveryDocuments(manifestJournal, fixture.store, DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY))
      .rejects.toThrow(/manifest is not owned by the discovered project Harness/);
  });
});

async function createLegacyFixture() {
  const root = await mkdtemp(join(tmpdir(), "aho-runtime-coordinator-"));
  cleanup.push(root);
  const projectRoot = join(root, "project");
  const ahoHome = join(root, "aho-home");
  const sourceSidecar = join(ahoHome, "projects", "legacy-a1");
  const targetSidecar = join(ahoHome, "projects", "canonical-a1");
  await mkdir(join(sourceSidecar, "workbench"), { recursive: true });
  const database = new Database(join(sourceSidecar, "workbench", "workbench.sqlite"));
  initializeCurrentWorkbenchSchema(database);
  database.exec("CREATE TABLE skills (project_id TEXT NOT NULL, skill_id TEXT NOT NULL, PRIMARY KEY(project_id, skill_id))");
  database.prepare("INSERT INTO skills(project_id, skill_id) VALUES (?, ?)").run("legacy-a1", "skill-1");
  materializeWorkbenchSchemaContract(database, 16);
  database.close();
  await createHarness(projectRoot);
  const store = new ProjectRegistryStore(ahoHome);
  const { project } = await store.registerProject({
    path: projectRoot,
    name: "Legacy",
    projectId: "legacy-a1",
  });
  expect(project.id).toBe("legacy-a1");
  const coordinator = new ProjectRuntimeCoordinator({
    store,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    ahoHome,
    createTransactionId: () => "identity-test-1",
  });
  return { root, projectRoot, ahoHome, sourceSidecar, targetSidecar, store, coordinator, project };
}

function recoveryJournal(fixture: Awaited<ReturnType<typeof createLegacyFixture>>): ProjectIdentityMigrationJournal {
  const transactionId = "identity-recovery-test";
  const transactionRoot = join(fixture.ahoHome, "projects", ".identity-transactions", transactionId);
  const document = (path: string, pointers: string[]) => ({
    kind: "registry" as const,
    scope: "external" as const,
    sourcePath: path,
    stagedPath: `${path}.${transactionId}.next`,
    backupPath: `${path}.${transactionId}.previous`,
    allowedIdentityPaths: pointers,
    required: true,
    matchCount: 1,
    beforeContentHash: "a".repeat(64),
    afterContentHash: "b".repeat(64),
    beforeIdentityNeutralHash: "c".repeat(64),
    afterIdentityNeutralHash: "c".repeat(64),
    state: "prepared" as const,
  });
  return {
    schemaVersion: "1.0",
    transactionId,
    sourceProjectId: "legacy-a1",
    targetProjectId: "canonical-a1",
    manifestPath: join(fixture.projectRoot, ".agents", "skills", "canonical-a1-harness", "state", "manifest.json"),
    sourceSidecarRoot: fixture.sourceSidecar,
    targetSidecarRoot: fixture.targetSidecar,
    stagedSidecarRoot: join(fixture.ahoHome, "projects", `.canonical-a1.${transactionId}.staged`),
    previousSidecarRoot: join(fixture.ahoHome, "projects", `.legacy-a1.${transactionId}.previous`),
    journalPath: join(transactionRoot, "journal.json"),
    manifestContentHash: "a".repeat(64),
    sourceSidecarFingerprint: "a".repeat(64),
    stagedSidecarFingerprint: "b".repeat(64),
    stage: "prepared",
    sqliteProofs: [],
    documents: [
      document(fixture.store.registryPath, ["/projects/0/id"]),
    ],
    error: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
}

async function createHarness(projectRoot: string): Promise<void> {
  const skillName = "canonical-a1-harness";
  const skillRoot = join(projectRoot, ".agents", "skills", skillName);
  await mkdir(join(skillRoot, "state"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${skillName}\n---\n`, "utf8");
  await writeFile(join(skillRoot, "state", "manifest.json"), `${JSON.stringify({
    schema_version: "2.0",
    project_id: "canonical-a1",
    project_name: "canonical",
    skill_name: skillName,
    skill_revision: 27,
    analysis_status: "complete",
  }, null, 2)}\n`, "utf8");
}
