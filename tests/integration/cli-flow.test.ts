import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../../src/provider-runtime/project-harness-discovery.js";
import { defaultProviderRegistry } from "../../src/provider-runtime/default-registry.js";
import { resolveProjectRuntimeState } from "../../src/project-runtime/coordinator.js";
import { projectExecutionRuntimePort } from "../../src/project-runtime/execution-ports.js";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { getWorkbenchSnapshot } from "../../src/workbench/projections/read-model/implementation.js";
import { createFakeCodexRuntime } from "../helpers/fake-codex-runtime.js";
import { resetCodexRuntimeForTests } from "../../src/codex/executable.js";
import { createConversationChangeFixture } from "../helpers/conversation-change-fixture.js";
import { createWorkbenchConversation } from "../../src/workbench/conversation-service.js";
import {
  createReadyProjectHarnessFixture,
  type ReadyProjectHarnessFixture,
} from "../helpers/project-harness-fixture.js";
import {
  writeSkillNativeAcceptedSpecAndTasks,
  type SkillNativeWorkbenchFixture,
} from "../helpers/skill-native-workbench-fixture.js";

const execFileAsync = promisify(execFile);

let tempDir: string;
let homeDir: string;
let repoDir: string;
let originalExitCode: string | number | undefined;
let originalCodexHome: string | undefined;
let originalCodexBin: string | undefined;

async function runCli(args: string[]): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function initializeGitRepository(root = repoDir): Promise<void> {
  await execFileAsync("git", ["init", root]);
  await git(root, ["config", "user.email", "cli-fixture@example.com"]);
  await git(root, ["config", "user.name", "CLI Fixture"]);
  await writeFile(join(root, "README.md"), "# CLI fixture\n", "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "fixture baseline"]);
}

async function createReadyProject(projectRoot = repoDir, projectId = "repo"): Promise<ReadyProjectHarnessFixture> {
  const fixture = await createReadyProjectHarnessFixture({
    projectRoot,
    ahoHome: homeDir,
    projectId,
    projectName: "Repo",
  });
  await runCli(["project", "add", projectRoot, "--name", "Repo"]);
  return fixture;
}

async function createChange(title = "CLI Skill Native Flow"): Promise<string> {
  await runCli(["change", "new", "repo", "--title", title, "--body", "Exercise the current CLI contract."]);
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function acceptChange(fixture: ReadyProjectHarnessFixture, changeId: string): Promise<void> {
  const state = await resolveProjectRuntimeState(fixture.project, {
    ahoHome: homeDir,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  });
  if (state.state !== "ready") throw new Error(`CLI fixture Runtime is not ready: ${state.state}.`);
  const workbenchFixture: SkillNativeWorkbenchFixture = {
    project: fixture.project,
    ahoHome: homeDir,
    skillRoot: fixture.skillRoot,
    resolution: state.resolution,
    runtime: projectExecutionRuntimePort(fixture.project, state.resolution),
    restoreEnvironment() {},
  };
  await writeSkillNativeAcceptedSpecAndTasks(workbenchFixture, changeId);
}

async function createAcceptedConversationChange(
  fixture: ReadyProjectHarnessFixture,
  title: string,
): Promise<string> {
  const topic = await createConversationChangeFixture(fixture.project, {
    title,
    body: "Exercise the current CLI execution contract.",
  });
  await acceptChange(fixture, topic.changeId);
  return topic.changeId;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "aho-cli-skill-native-"));
  homeDir = join(tempDir, "home");
  repoDir = join(tempDir, "repo");
  originalExitCode = process.exitCode;
  originalCodexHome = process.env.CODEX_HOME;
  originalCodexBin = process.env.AHO_CODEX_BIN;
  process.exitCode = undefined;
  process.env.AHO_HOME = homeDir;
  process.env.CODEX_HOME = join(tempDir, "codex-home");
  resetCodexRuntimeForTests();
  await initializeGitRepository();
});

afterEach(async () => {
  await defaultProviderRegistry.shutdownAll("CLI integration fixture cleanup.");
  delete process.env.AHO_HOME;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalCodexBin === undefined) delete process.env.AHO_CODEX_BIN;
  else process.env.AHO_CODEX_BIN = originalCodexBin;
  resetCodexRuntimeForTests();
  process.exitCode = originalExitCode;
  await rm(tempDir, { recursive: true, force: true });
});

describe("Skill-native CLI flow", () => {
  it("registers a repository without creating a legacy marker and reports onboarding", async () => {
    await runCli(["project", "add", repoDir, "--name", "Repo"]);
    await runCli(["project", "status", "repo", "--json"]);
    await runCli(["harness", "doctor", "repo", "--json"]);

    const registry = JSON.parse(await readFile(join(homeDir, "registry.json"), "utf8"));
    expect(registry.projects).toEqual([
      expect.objectContaining({ id: "repo", path: await realpath(repoDir) }),
    ]);
    await expect(stat(join(repoDir, ".agent-harness", "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(join(repoDir, "harness"))).toBe(false);
  });

  it("does not expose retired Harness initialization or memory commands", async () => {
    await runCli(["project", "add", repoDir, "--name", "Repo"]);

    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name());
    const harness = program.commands.find((command) => command.name() === "harness");
    expect(commandNames).not.toContain("memory");
    expect(harness?.commands.map((command) => command.name()).sort()).toEqual(["audit", "doctor"]);
    expect(existsSync(join(repoDir, ".agent-harness"))).toBe(false);
    expect(existsSync(join(repoDir, "harness"))).toBe(false);
  });

  it("discovers a schema-2 physical Skill and runs current diagnostics", async () => {
    const fixture = await createReadyProject();

    await runCli(["project", "status", "repo", "--json"]);
    await runCli(["harness", "doctor", "repo", "--json"]);
    await runCli(["harness", "audit", "repo", "--json"]);

    const manifest = JSON.parse(await readFile(join(fixture.skillRoot, "state", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ schema_version: "2.0", project_id: "repo", skill_name: "repo-harness" });
    expect(existsSync(resolveProjectRuntimePaths("repo", homeDir).sidecarRoot)).toBe(true);
    expect(existsSync(join(repoDir, ".agent-harness"))).toBe(false);
  });

  it("creates Change, Registry, and Lane evidence only in the physical project Skill", async () => {
    const fixture = await createReadyProject();
    const changeId = await createChange("Add Current CLI Coverage");

    await runCli(["change", "status", "repo", "--json"]);

    const changeRoot = join(fixture.skillRoot, "state", "changes", "active", changeId);
    expect(existsSync(join(changeRoot, "spec.md"))).toBe(true);
    expect(existsSync(join(fixture.skillRoot, "state", "registry", "changes", `${changeId}.json`))).toBe(true);
    const laneFiles = await readdir(join(fixture.skillRoot, "state", "registry", "lanes"));
    expect(laneFiles).toHaveLength(1);
    const lane = JSON.parse(await readFile(join(fixture.skillRoot, "state", "registry", "lanes", laneFiles[0]!), "utf8"));
    expect(lane.active_change_id).toBe(changeId);
    expect(existsSync(join(repoDir, "harness"))).toBe(false);
  });

  it("records local Run and Workbench projections in the runtime sidecar", async () => {
    const fixture = await createReadyProject();
    const changeId = await createAcceptedConversationChange(fixture, "Sidecar Run Evidence");

    await runCli(["run", "start", "repo", "--", process.execPath, "-e", "console.log('sidecar run')"]);
    await runCli(["run", "list", "repo", "--json"]);
    await runCli(["workbench", "snapshot", "repo", "--topic", changeId, "--json"]);
    await runCli(["workbench", "topics", "repo", "--json"]);
    await runCli(["workbench", "topic", "repo", changeId, "--json"]);

    const paths = resolveProjectRuntimePaths("repo", homeDir);
    const runIds = await readdir(paths.runsRoot);
    expect(runIds).toHaveLength(1);
    const run = JSON.parse(await readFile(join(paths.runsRoot, runIds[0]!, "run.json"), "utf8"));
    expect(run).toMatchObject({ changeId, status: "completed", artifacts: { owner: "runtime-sidecar" } });
    const snapshot = await getWorkbenchSnapshot({ project: fixture.project, path: repoDir }, { topicId: changeId });
    expect(snapshot.harness).toMatchObject({ projectId: "repo", skillName: "repo-harness" });
    expect(snapshot.center.selectedTopic).toMatchObject({
      id: `conv-${changeId}`,
      boundChangeId: changeId,
    });
    expect(existsSync(join(repoDir, "runs"))).toBe(false);
  });

  it("keeps ordinary Skill selection Host-native without copying packages", async () => {
    await createReadyProject();
    process.env.AHO_CODEX_BIN = await createFakeCodexRuntime(tempDir);
    resetCodexRuntimeForTests();
    const skillRoot = join(tempDir, "ordinary-skills");
    const skillDir = join(skillRoot, "pricing-helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: pricing-helper\ndescription: Pricing rules.\n---\n\n# Pricing Helper\n", "utf8");

    await runCli(["skill", "root-add", "repo", "--path", skillRoot]);
    await runCli(["skill", "enable", "repo", "pricing-helper"]);
    await runCli(["skill", "list", "repo", "--json"]);

    const database = await openProjectRuntimeWorkbenchDatabase(resolveProjectRuntimePaths("repo", homeDir));
    expect(database.skills.listSkillRoots("repo")).toEqual([
      expect.objectContaining({ rootPath: await realpath(skillRoot), sourceKind: "custom" }),
    ]);
    expect(database.skills.listSkillEnablement("repo")).toEqual([
      expect.objectContaining({ skillId: "pricing-helper", scope: "project", enabled: true }),
    ]);
    database.close();
    expect(existsSync(join(homeDir, "projects", "repo", "skills"))).toBe(false);
    expect(existsSync(join(process.env.CODEX_HOME ?? "", "plugins", "aho-managed"))).toBe(false);
  });

  it("uses the stored Conversation Provider for explicit Skill overrides and rejects the retired Topic option", async () => {
    const fixture = await createReadyProject();
    process.env.AHO_CODEX_BIN = await createFakeCodexRuntime(tempDir);
    resetCodexRuntimeForTests();
    const skillRoot = join(tempDir, "conversation-skills");
    const skillDir = join(skillRoot, "conversation-helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: conversation-helper\ndescription: Conversation rules.\n---\n\n# Conversation Helper\n", "utf8");
    await runCli(["skill", "root-add", "repo", "--path", skillRoot]);
    const conversation = await createWorkbenchConversation(fixture.project, {
      body: "Create a Conversation-scoped Skill selection.",
      productMode: "agent",
      clientRequestId: "cli-conversation-skill",
      providerId: "codex",
    }, undefined, { runMainAgent: false });

    const databaseForProvider = await openProjectRuntimeWorkbenchDatabase(resolveProjectRuntimePaths("repo", homeDir));
    try {
      databaseForProvider.conversations.selectConversationProvider(
        "repo",
        conversation.conversationId,
        "conversation-provider",
        new Date().toISOString(),
      );
    } finally {
      databaseForProvider.close();
    }
    const codexProvider = defaultProviderRegistry.get("codex");
    const providerLookup = vi.spyOn(defaultProviderRegistry, "get").mockImplementation(() => codexProvider);
    try {
      await runCli(["skill", "enable", "repo", "conversation-helper", "--conversation-id", conversation.conversationId]);
      await runCli(["skill", "enable", "repo", "repo-harness", "--conversation-id", conversation.conversationId]);
      expect(providerLookup).toHaveBeenCalledWith("conversation-provider");
    } finally {
      providerLookup.mockRestore();
    }
    await expect(runCli(["skill", "disable", "repo", "conversation-helper", "--topic", "change-id"]))
      .rejects.toThrow();

    const database = await openProjectRuntimeWorkbenchDatabase(resolveProjectRuntimePaths("repo", homeDir));
    try {
      expect(database.skills.listSkillEnablement("repo")).toEqual(expect.arrayContaining([
        expect.objectContaining({
          skillId: "conversation-helper",
          scope: "topic",
          changeId: conversation.conversationId,
          enabled: true,
        }),
        expect.objectContaining({
          skillId: "repo-harness",
          scope: "topic",
          changeId: conversation.conversationId,
          enabled: true,
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("creates and removes AHO-owned worktrees through sidecar metadata", async () => {
    const fixture = await createReadyProject();
    await createAcceptedConversationChange(fixture, "Worktree Lifecycle");

    await runCli(["worktree", "create", "repo", "--json"]);
    const paths = resolveProjectRuntimePaths("repo", homeDir);
    const metadataFiles = (await readdir(paths.worktreeMetadataRoot)).filter((name) => name.endsWith(".json"));
    expect(metadataFiles).toHaveLength(1);
    const metadata = JSON.parse(await readFile(join(paths.worktreeMetadataRoot, metadataFiles[0]!), "utf8"));
    await runCli(["worktree", "list", "repo", "--json"]);
    await runCli(["worktree", "show", "repo", metadata.worktreeId, "--json"]);
    await runCli(["worktree", "remove", "repo", metadata.worktreeId, "--json"]);

    expect(existsSync(metadata.checkoutPath)).toBe(false);
    expect(await readFile(join(repoDir, "README.md"), "utf8")).toBe("# CLI fixture\n");
    expect(existsSync(join(repoDir, ".agents", "skills", "repo-harness"))).toBe(true);
  });

  it("fails code execution closed without Workflow Runtime authorization", async () => {
    const fixture = await createReadyProject();
    await createAcceptedConversationChange(fixture, "Authorization Required");

    await expect(runCli(["code", "run", "repo", "--json"])).rejects.toThrow(/execution authorization|workflow runtime/i);
    const paths = resolveProjectRuntimePaths("repo", homeDir);
    const runEntries = existsSync(paths.runsRoot) ? await readdir(paths.runsRoot) : [];
    expect(runEntries).toEqual([]);
  });

  it("fails closed without a canonical commit and rejects worktree creation from detached HEAD", async () => {
    const emptyRepo = join(tempDir, "empty-repo");
    await execFileAsync("git", ["init", emptyRepo]);
    await git(emptyRepo, ["config", "user.email", "cli-fixture@example.com"]);
    await git(emptyRepo, ["config", "user.name", "CLI Fixture"]);
    const emptyFixture = await createReadyProject(emptyRepo, "empty-repo");
    await expect(createAcceptedConversationChange(emptyFixture, "No Commit"))
      .rejects.toThrow(/preflight requires replanning.*unavailable/i);
    const emptyPaths = resolveProjectRuntimePaths("empty-repo", homeDir);
    expect(existsSync(emptyPaths.worktreeMetadataRoot)
      ? await readdir(emptyPaths.worktreeMetadataRoot)
      : []).toEqual([]);

    const detachedFixture = await createReadyProject();
    await createAcceptedConversationChange(detachedFixture, "Detached Head");
    await git(repoDir, ["checkout", "--detach"]);
    await expect(runCli(["worktree", "create", "repo"]))
      .rejects.toThrow(/detached HEAD|graph-scoped Lane lineage is stale/i);
    const detachedPaths = resolveProjectRuntimePaths("repo", homeDir);
    expect(existsSync(detachedPaths.worktreeMetadataRoot)
      ? await readdir(detachedPaths.worktreeMetadataRoot)
      : []).toEqual([]);
  });
});
