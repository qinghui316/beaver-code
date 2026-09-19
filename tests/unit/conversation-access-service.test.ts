import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureConversationAccess } from "../../src/workbench/conversation-service.js";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import type { ProjectRuntimeState } from "../../src/project-runtime/coordinator.js";
import type { ManagedProject } from "../../src/types/index.js";
import type { ProviderRegistry } from "../../src/provider-runtime/index.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";

let root: string;
let paths: ProjectRuntimePaths;
let project: ManagedProject;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "beaver-access-service-"));
  paths = resolveProjectRuntimePaths("access-project", join(root, "data"));
  project = { id: "access-project", name: "Access", path: root, addedAt: "t0", lastSeenAt: "t0", defaultProviderId: "codex" };
  (await openProjectRuntimeWorkbenchDatabase(paths)).close();
  const db = new Database(paths.workbenchDbPath);
  try { db.exec(`INSERT INTO conversations(project_id,conversation_id,product_mode,agent_turn_mode,title,selected_provider_id,created_at,updated_at)
    VALUES ('access-project','c','agent','default','kept','codex','t0','t0')`); } finally { db.close(); }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function options(supported = true) {
  const requireProfiles = vi.fn(async () => ({ snapshot: { capabilities: [{ key: "workspace.full-access", runtime: supported ? "ready" : "unavailable" }] } }));
  return { requireProfiles, value: {
    runtimeStateResolver: async (): Promise<ProjectRuntimeState> => ({ state: "onboarding", project, projectRoot: root, reservedProjectId: project.id, paths }),
    providerRegistry: { requireProfiles } as unknown as ProviderRegistry,
  } };
}
const identity = { productMode: "agent", providerId: "codex" };

describe("Conversation access application owner", () => {
  it("reads without mutation and saves confirmed access with CAS", async () => {
    const owner = options();
    expect(await configureConversationAccess(project, "c", identity, owner.value)).toEqual({ accessMode: "default", revision: 0, providerId: "codex" });
    const full = { ...identity, accessMode: "full-access", expectedRevision: 0, confirmFullAccess: true };
    expect(await configureConversationAccess(project, "c", full, owner.value)).toMatchObject({ accessMode: "full-access", revision: 1 });
    await expect(configureConversationAccess(project, "c", full, owner.value)).rejects.toThrow();
    expect(await configureConversationAccess(project, "c", identity, owner.value)).toMatchObject({ accessMode: "full-access", revision: 1 });
    expect(await configureConversationAccess(project, "c", { ...identity, accessMode: "default", expectedRevision: 1 }, owner.value)).toMatchObject({ accessMode: "default", revision: 2 });
  });

  it("rejects unconfirmed or unsupported escalation without persisting it", async () => {
    const owner = options(false);
    const full = { ...identity, accessMode: "full-access", expectedRevision: 0 };
    await expect(configureConversationAccess(project, "c", full, owner.value)).rejects.toThrow(/confirmation/);
    expect(owner.requireProfiles).not.toHaveBeenCalled();
    await expect(configureConversationAccess(project, "c", { ...full, confirmFullAccess: true }, owner.value)).rejects.toThrow(/support/);
    expect(await configureConversationAccess(project, "c", identity, owner.value)).toMatchObject({ accessMode: "default", revision: 0 });
  });

  it.each([
    { ...identity, productMode: "harness" }, { ...identity, providerId: "other" },
    { ...identity, accessMode: "default", expectedRevision: -1 },
    { ...identity, accessMode: "default", expectedRevision: 0.5 },
  ])("rejects incorrect identity or revision %j", async (input) => {
    await expect(configureConversationAccess(project, "c", input, options().value)).rejects.toThrow();
  });
});
