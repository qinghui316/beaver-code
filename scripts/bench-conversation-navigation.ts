import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ProjectRegistryStore } from "../src/registry/store.js";
import { resolveProjectRuntimePaths } from "../src/project-runtime/paths.js";
import { startWorkbenchServer } from "../src/server/workbench-server.js";
import { openProjectRuntimeWorkbenchDatabase } from "../src/workbench/persistence/open-workbench-database.js";

const root = await mkdtemp(join(tmpdir(), "beaver-nav-bench-"));
const ahoHome = join(root, "home");
const staticRoot = join(root, "web");
const previousHome = process.env.AHO_HOME;
let server: Awaited<ReturnType<typeof startWorkbenchServer>> | null = null;

try {
  process.env.AHO_HOME = ahoHome;
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, "index.html"), "benchmark", "utf8");
  const store = new ProjectRegistryStore(ahoHome);
  const now = new Date().toISOString();
  const projects = await Promise.all([1, 2, 3].map(async (number) => {
    const path = join(root, `project ${number}`);
    await mkdir(path);
    return { id: `benchmark-${number}`, name: `Benchmark ${number}`, path, addedAt: now, lastSeenAt: now,
      defaultProviderId: "codex" };
  }));
  await store.save({ version: "1.0", projects });
  for (const project of projects) {
    const paths = resolveProjectRuntimePaths(project.id, ahoHome);
    (await openProjectRuntimeWorkbenchDatabase(paths)).close();
    const database = new Database(paths.workbenchDbPath);
    try {
      const insertConversation = database.prepare(`INSERT INTO conversations
        (project_id,conversation_id,product_mode,agent_turn_mode,title,selected_provider_id,created_at,updated_at)
        VALUES (?,?, 'agent','default',?, 'codex',?,?)`);
      const insertMessage = database.prepare(`INSERT INTO canonical_timeline_items
        (id,project_id,conversation_id,change_id,position,revision,agent_surface_id,type,timestamp,text,raw_json)
        VALUES (?,?,?,'',?,?,'main-agent','user.message',?,?,'{}')`);
      database.transaction(() => {
        for (let index = 0; index < 40; index += 1) {
          const id = `conversation-${index}`;
          insertConversation.run(project.id, id, `${project.name} ${index}`, now,
            index === 0 ? "2099-01-01T00:00:00.000Z" : now);
        }
        if (project.id === "benchmark-1") {
          for (let index = 0; index < 2_000; index += 1) {
            insertMessage.run(`message-${index}`, project.id, "conversation-0", index + 1, index + 1, now,
              `Long conversation message ${index}: ${"content ".repeat(20)}`);
          }
          database.prepare("UPDATE conversations SET timeline_position = 2000, timeline_revision = 2000 WHERE project_id = ? AND conversation_id = 'conversation-0'")
            .run(project.id);
        }
      })();
    } finally { database.close(); }
  }
  server = await startWorkbenchServer(null, { port: 0, staticRoot, store });
  const base = server.url;
  const measure = async (name: string, paths: string[]) => {
    const started = performance.now();
    const replies = await Promise.all(paths.map(async (path) => {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${body.slice(0, 200)}`);
      return body.length;
    }));
    return { name, requests: paths.length, elapsedMs: Math.round(performance.now() - started), responseChars: replies.reduce((sum, count) => sum + count, 0) };
  };
  const measureSerial = async (name: string, paths: string[]) => {
    const started = performance.now();
    let responseChars = 0;
    for (const path of paths) {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${body.slice(0, 200)}`);
      responseChars += body.length;
    }
    return { name, requests: paths.length, elapsedMs: Math.round(performance.now() - started), responseChars };
  };
  const projectIds = projects.map((project) => project.id);
  await measure("warm-snapshot", [`/api/projects/benchmark-1/workbench/snapshot?productMode=agent&topic=conversation-0`]);
  await measure("warm-navigation", [`/api/projects/benchmark-1/workbench/navigation?productMode=agent`]);
  const oldSidebar = await measure("old-sidebar-full-snapshot", projectIds.map((id) =>
    `/api/projects/${id}/workbench/snapshot?productMode=agent`));
  const newSidebar = await measure("new-sidebar-navigation", projectIds.map((id) =>
    `/api/projects/${id}/workbench/navigation?productMode=agent`));
  const oldSwitch = await measureSerial("old-switch-projects-then-snapshot", [
    "/api/projects", "/api/projects/benchmark-1/workbench/snapshot?productMode=agent&topic=conversation-0",
  ]);
  const newSwitch = await measure("new-switch-compact-snapshot", [
    "/api/projects/benchmark-1/workbench/snapshot?productMode=agent&topic=conversation-0&compactThread=1",
  ]);
  const shortSwitch = await measure("new-switch-short-conversation", [
    "/api/projects/benchmark-2/workbench/snapshot?productMode=agent&topic=conversation-0&compactThread=1",
  ]);
  process.stdout.write(`${JSON.stringify({ platform: process.platform, projects: 3, conversationsPerProject: 40,
    longConversationMessages: 2_000, results: [oldSidebar, newSidebar, oldSwitch, newSwitch, shortSwitch] }, null, 2)}\n`);
} finally {
  if (server) await new Promise<void>((done) => server!.server.close(() => done()));
  if (previousHome === undefined) delete process.env.AHO_HOME;
  else process.env.AHO_HOME = previousHome;
  const safeRoot = resolve(root);
  if (safeRoot.startsWith(`${resolve(tmpdir())}${sep}`) && basename(safeRoot).startsWith("beaver-nav-bench-")) {
    await rm(safeRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Skipped cleanup for unexpected benchmark directory: ${safeRoot}\n`);
  }
}
