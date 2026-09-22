import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedProject } from "../../src/types/index.js";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { listConversationManagement } from "../../src/server/workbench/conversation-management.js";

let root: string;
let projects: ManagedProject[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-conversation-management-"));
  projects = await Promise.all(["a", "b", "c"].map(async (id) => {
    const path = join(root, id);
    await mkdir(path, { recursive: true });
    return { id, name: `Project ${id}`, path, addedAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" };
  }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

describe("conversation management query", () => {
  it("merges 50 item pages across projects without repeating a same-timestamp row", async () => {
    for (const project of projects) {
      const database = await openProjectRuntimeWorkbenchDatabase(resolveProjectRuntimePaths(project.id, join(root, "home")));
      try {
        for (let index = 0; index < 25; index++) {
          database.conversations.createConversation({
            projectId: project.id, conversationId: `conversation-${String(index).padStart(2, "0")}`,
            productMode: "agent", agentTurnMode: "default", title: `Archive ${index}`,
            state: "active", boundChangeId: null, currentGraphScopeId: null,
            selectedProviderId: "codex", completedTurnSequence: 0,
            createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", deletedAt: null,
          });
          database.conversations.archiveAgentConversation(project.id, `conversation-${String(index).padStart(2, "0")}`, 0,
            "2026-01-03T00:00:00.000Z");
        }
      } finally { database.close(); }
    }
    const input = {
      store: { listProjects: async () => projects } as never,
      directInput: null,
      coordinator: { runtimePaths: (projectId: string) => resolveProjectRuntimePaths(projectId, join(root, "home")) },
      scope: "all" as const, projectId: null, productMode: "agent" as const,
      state: "archive" as const, search: "Archive", cursor: null,
    };
    const first = await listConversationManagement(input);
    expect(first.conversations).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    expect(first.partial).toBe(false);
    const second = await listConversationManagement({ ...input, cursor: first.nextCursor });
    expect(second.conversations).toHaveLength(25);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.conversations, ...second.conversations].map((item) => `${item.projectId}:${item.conversationId}`)).size).toBe(75);
    await expect(listConversationManagement({ ...input, search: "other", cursor: first.nextCursor })).rejects.toMatchObject({ name: "BadRequest" });
  });

  it("returns other projects when one project cannot be read", async () => {
    const database = await openProjectRuntimeWorkbenchDatabase(resolveProjectRuntimePaths("a", join(root, "home")));
    try {
      database.conversations.createConversation({ projectId: "a", conversationId: "one", productMode: "agent",
        agentTurnMode: "default", title: "One", state: "active", boundChangeId: null,
        currentGraphScopeId: null, selectedProviderId: "codex", completedTurnSequence: 0,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null });
    } finally { database.close(); }
    const page = await listConversationManagement({
      store: { listProjects: async () => projects.slice(0, 2) } as never, directInput: null,
      coordinator: { runtimePaths: (id: string) => {
        if (id === "b") throw new Error("private path");
        return resolveProjectRuntimePaths(id, join(root, "home"));
      } }, scope: "all", projectId: null, productMode: "all", state: "active", search: "", cursor: null,
    });
    expect(page.conversations).toMatchObject([{ projectId: "a", conversationId: "one" }]);
    expect(page.partial).toBe(true);
    expect(page.unreadableProjects).toEqual([{ projectId: "b", projectName: "Project b", reason: "项目会话暂时无法读取。" }]);
  });
});
