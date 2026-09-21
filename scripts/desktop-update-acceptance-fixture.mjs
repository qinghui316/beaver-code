import { execFileSync } from "node:child_process";
import console from "node:console";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  || process.env.GITHUB_REPOSITORY !== "qinghui316/beaver-code"
  || !["refs/heads/master", "refs/heads/codex/aho-windows-github-independent-update-signing-v1", "refs/heads/codex/aho-windows-desktop-update-auto-relaunch-v1"].includes(process.env.GITHUB_REF)
  || process.env.GITHUB_SHA !== process.env.BEAVER_UPDATE_ACCEPTANCE_SHA
  || process.env.RUNNER_OS !== "Windows"
  || process.env.BEAVER_UPDATE_ACCEPTANCE !== "1") {
  throw new Error("The update data fixture is restricted to the disposable Windows acceptance runner.");
}

const [mode, homeInput, projectInput, runtimeInput] = process.argv.slice(2);
if (!mode || !homeInput || !projectInput) throw new Error("Usage: <seed|verify> <aho-home> <project-root>.");
const runnerTemp = resolve(required("RUNNER_TEMP"));
const ahoHome = assertEphemeralHome(homeInput, runnerTemp);
const projectRoot = assertRunnerPath(projectInput, runnerTemp);
const projectId = "desktop-update-acceptance";
const conversationId = "update-acceptance-conversation";
const draftText = "更新验收草稿：必须在自动重启后保留";
const queueText = "更新验收待发送内容：必须在自动重启后保留";
const markerPath = join(ahoHome, "update-acceptance-marker.json");
const runtimeRoot = runtimeInput ? assertRunnerPath(runtimeInput, runnerTemp) : resolve(import.meta.dirname, "..", "dist");
const [{ ProjectRegistryStore }, { initializeProjectRuntimeSidecar }, { resolveProjectRuntimePaths },
  { getProjectHarnessSkillScaffoldRoot }, { openProjectRuntimeWorkbenchDatabase },
  { defaultExecutionContractRegistry }] = await Promise.all([
  loadRuntime("registry/store.js"),
  loadRuntime("project-runtime/lifecycle.js"),
  loadRuntime("project-runtime/paths.js"),
  loadRuntime("template-source/paths.js"),
  loadRuntime("workbench/persistence/open-workbench-database.js"),
  loadRuntime("provider-runtime/execution-contract.js"),
]);

if (mode === "seed") await seed();
else if (mode === "verify") await verify();
else throw new Error("Unknown fixture mode.");

async function seed() {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "orders.ts"), "export const orders = [];\n", "utf8");
  runGit(["init", "--initial-branch=master"]);
  runGit(["config", "user.name", "Beaver Update Acceptance"]);
  runGit(["config", "user.email", "acceptance@example.invalid"]);
  runGit(["add", "orders.ts"]);
  runGit(["commit", "-m", "acceptance fixture"]);
  const canonicalCommit = runGit(["rev-parse", "HEAD"]);
  const skillName = `${projectId}-harness`;
  const skillRoot = join(projectRoot, ".agents", "skills", skillName);
  await mkdir(join(projectRoot, ".agents", "skills"), { recursive: true });
  await cp(getProjectHarnessSkillScaffoldRoot(), skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${skillName}\n---\n\n# Desktop Update Acceptance Harness\n`, "utf8");
  await Promise.all([
    mkdir(join(skillRoot, "references", "project_wiki"), { recursive: true }),
    mkdir(join(skillRoot, "state", "changes", "active"), { recursive: true }),
    mkdir(join(skillRoot, "state", "changes", "parking"), { recursive: true }),
    mkdir(join(skillRoot, "state", "changes", "archive"), { recursive: true }),
    mkdir(join(skillRoot, "state", "registry", "changes"), { recursive: true }),
    mkdir(join(skillRoot, "state", "registry", "contracts"), { recursive: true }),
    mkdir(join(skillRoot, "state", "registry", "lanes"), { recursive: true }),
    mkdir(join(skillRoot, "state", "registry", "integrations"), { recursive: true }),
    mkdir(join(skillRoot, "state", "registry", "baseline-events"), { recursive: true }),
    mkdir(join(skillRoot, "state", "evolution"), { recursive: true }),
  ]);
  await Promise.all([
    writeJson(join(skillRoot, "state", "manifest.json"), {
      schema_version: "2.0", project_id: projectId, project_name: "Desktop Update Acceptance",
      skill_name: skillName, skill_revision: 1, analysis_status: "complete",
    }),
    writeJson(join(skillRoot, "state", "changes", "INDEX.json"), {
      schema_version: "1.0", changes: [], generated_at: "1970-01-01T00:00:00.000Z",
    }),
    writeJson(join(skillRoot, "state", "registry", "baseline.json"), {
      schema_version: "1.0", canonical_branch: "master", canonical_commit: canonicalCommit,
      updated_at: "2026-09-12T00:00:00.000Z",
    }),
    writeJson(join(skillRoot, "references", "project_wiki", ".ecl-baselines.json"), {
      schema_version: "1.0", project_id: projectId, documents: {},
    }),
    writeFile(join(skillRoot, "references", "project_wiki", "catalog.md"), "# Catalog\n", "utf8"),
  ]);

  const paths = resolveProjectRuntimePaths(projectId, ahoHome);
  await initializeProjectRuntimeSidecar(paths);
  const now = "2026-09-12T00:00:00.000Z";
  await new ProjectRegistryStore(ahoHome).save({ version: "1.0", projects: [{
    id: projectId, name: "Desktop Update Acceptance", path: projectRoot,
    addedAt: now, lastSeenAt: now, defaultProviderId: "codex",
  }] });
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const queueExecutionContract = defaultExecutionContractRegistry.read("agent.turn");
    database.conversations.createConversation({
      projectId, conversationId, productMode: "agent", agentTurnMode: "default",
      agentModelId: null, agentReasoningEffort: null, title: "更新验收会话", state: "active",
      boundChangeId: null, currentGraphScopeId: "graph-update-acceptance", selectedProviderId: "codex",
      completedTurnSequence: 0, createdAt: now, updatedAt: now, deletedAt: null,
    });
    database.drafts.upsertDraft({
      projectId, productMode: "agent", agentTurnMode: "default", agentModelId: null,
      agentReasoningEffort: null, text: draftText, contextRefsJson: "[]", attachmentIdsJson: "[]",
      skillOverridesJson: "{}", selectedProviderId: "codex", updatedAt: now,
    }, null);
    database.conversationTurnQueues.ensureQueue({ projectId, conversationId, productMode: "agent", updatedAt: now });
    database.conversationTurnQueues.insertItem({
      projectId, conversationId, productMode: "agent", queueItemId: "queue-update-acceptance",
      clientRequestId: "client-update-acceptance", requestHash: "hash-update-acceptance", position: 1,
      status: "blocked", retryCount: 0, predecessorExecutionRevision: "revision-update-acceptance",
      dispatchRequestId: "dispatch-update-acceptance", executionContractFamily: queueExecutionContract.family,
      executionContractEpoch: queueExecutionContract.epoch, itemKind: "conversation-turn", reviewTargetJson: null, text: queueText,
      contextRefsJson: "[]", attachmentIdsJson: "[]", skillOverridesJson: "{}", providerId: "codex",
      agentTurnMode: "default", agentModelId: null, agentReasoningEffort: null,
      diagnostic: "等待验收恢复", createdAt: now, updatedAt: now, dispatchedAt: null,
    });
  } finally {
    database.close();
  }
  await writeJson(markerPath, { schema: 1, projectId, conversationId, draftText, queueText });
  console.log(`Seeded isolated update data: ${digest(await readFile(markerPath))}`);
}

async function verify() {
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker.projectId !== projectId || marker.conversationId !== conversationId
    || marker.draftText !== draftText || marker.queueText !== queueText) throw new Error("Acceptance marker changed.");
  const registry = await new ProjectRegistryStore(ahoHome).load();
  if (!registry.projects.some((project) => project.id === projectId && resolve(project.path) === projectRoot)) {
    throw new Error("Project registration was not preserved.");
  }
  const database = await openProjectRuntimeWorkbenchDatabase(resolveProjectRuntimePaths(projectId, ahoHome));
  try {
    if (!database.conversations.readConversation(projectId, conversationId)) throw new Error("Conversation was not preserved.");
    const draft = database.drafts.readDraft(projectId, "agent");
    if (draft?.text !== draftText) throw new Error("Composer draft was not preserved.");
    const queued = database.conversationTurnQueues.readItem(projectId, conversationId, "queue-update-acceptance");
    if (queued?.text !== queueText || queued.status !== "blocked") throw new Error("Queued Turn was not preserved.");
  } finally {
    database.close();
  }
  console.log(`Verified isolated update data: ${digest(await readFile(markerPath))}`);
}

function runGit(args) {
  return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true }).trim();
}

function assertEphemeralHome(value, runnerRoot) {
  const target = resolve(value);
  const userProfile = resolve(required("USERPROFILE"));
  const expectedTestHome = resolve(userProfile, ".beaver-code-update-test", "data");
  if (target.toLowerCase() === expectedTestHome.toLowerCase()) return target;
  return assertRunnerPath(target, runnerRoot);
}

function assertRunnerPath(value, runnerRoot) {
  const target = resolve(value);
  const prefix = runnerRoot.endsWith("\\") ? runnerRoot : runnerRoot + "\\";
  if (!target.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error("Fixture path is outside the ephemeral runner roots.");
  }
  return target;
}

function required(name) {
  const value = process.env[name];
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function loadRuntime(relativePath) {
  return import(pathToFileURL(join(runtimeRoot, relativePath)).href);
}
