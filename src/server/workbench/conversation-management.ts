import { createHash } from "node:crypto";
import type { ProjectRegistryStore } from "../../registry/store.js";
import type { ManagedProject } from "../../types/index.js";
import type { WorkbenchProjectInput } from "../../workbench/read-model-types.js";
import type { ProductMode } from "../../provider-runtime/index.js";
import type { ProjectRuntimeCoordinatorPort } from "../../project-runtime/coordinator.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../workbench/persistence/open-workbench-database.js";

export type ManagementState = "active" | "archive" | "all";
export type ManagementMode = ProductMode | "all";
export interface ConversationManagementItem {
  projectId: string;
  projectName: string;
  conversationId: string;
  productMode: ProductMode;
  title: string;
  state: "active" | "archive";
  archiveOrigin: "agent-user" | "harness-workflow" | null;
  lifecycleRevision: string;
  updatedAt: string;
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
  providerSyncStatus: string;
  diagnostic: string | null;
}
export interface ConversationManagementPage {
  conversations: ConversationManagementItem[];
  nextCursor: string | null;
  unreadableProjects: Array<{ projectId: string; projectName: string; reason: string }>;
  partial: boolean;
}

type Position = { updatedAt: string; projectId: string; conversationId: string };
const PAGE_SIZE = 50;

export async function listConversationManagement(input: {
  store: ProjectRegistryStore;
  directInput: WorkbenchProjectInput | null;
  coordinator: Pick<ProjectRuntimeCoordinatorPort, "runtimePaths">;
  scope: "project" | "all";
  projectId: string | null;
  productMode: ManagementMode;
  state: ManagementState;
  search: string;
  cursor: string | null;
  activeTurn?: (projectId: string, conversationId: string) => boolean;
}): Promise<ConversationManagementPage> {
  const registered = await input.store.listProjects();
  const direct = input.directInput?.project;
  const projects = direct && !registered.some((item) => item.id === direct.id) ? [...registered, direct] : registered;
  const selected = input.scope === "all" ? projects : projects.filter((item) => item.id === input.projectId);
  if (input.scope === "project" && selected.length !== 1) throw badRequest("Select a registered project.");
  const fingerprint = createHash("sha256").update(JSON.stringify({
    scope: input.scope, projectId: input.projectId, productMode: input.productMode,
    state: input.state, search: input.search, projects: selected.map((item) => item.id).sort(),
  })).digest("hex");
  const before = decodeCursor(input.cursor, fingerprint);
  const pages: Array<{ items: ConversationManagementItem[]; failure?: { projectId: string; projectName: string; reason: string } }> =
    new Array(selected.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (nextIndex < selected.length) {
      const index = nextIndex++;
      pages[index] = await projectPage(selected[index]!, input, before);
    }
  }));
  const unreadableProjects = pages.flatMap((page) => page.failure ? [page.failure] : []);
  const sorted = pages.flatMap((page) => page.items).sort(compareItems);
  const conversations = sorted.slice(0, PAGE_SIZE);
  const last = conversations.at(-1);
  return {
    conversations,
    nextCursor: sorted.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({
      fingerprint, updatedAt: last.updatedAt, projectId: last.projectId, conversationId: last.conversationId,
    })).toString("base64url") : null,
    unreadableProjects,
    partial: unreadableProjects.length > 0,
  };
}

async function projectPage(
  project: ManagedProject,
  input: Parameters<typeof listConversationManagement>[0],
  before: Position | null,
): Promise<{ items: ConversationManagementItem[]; failure?: { projectId: string; projectName: string; reason: string } }> {
  try {
    const paths = input.coordinator.runtimePaths(project.id);
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const rows = database.conversations.listManagementPage({
        projectId: project.id, productMode: input.productMode, state: input.state,
        search: input.search, before: before ?? undefined, limit: PAGE_SIZE + 1,
      });
      return { items: rows.map(({ conversation, providerSyncStatus, diagnostic, blocked }) => ({
        projectId: project.id, projectName: project.name, conversationId: conversation.conversationId,
        productMode: conversation.productMode, title: conversation.title, state: conversation.state,
        archiveOrigin: conversation.archiveOrigin,
        lifecycleRevision: `conversation-lifecycle:${conversation.lifecycleRevision}`,
        updatedAt: conversation.updatedAt,
        canArchive: conversation.productMode === "agent" && conversation.state === "active" && !blocked
          && !input.activeTurn?.(project.id, conversation.conversationId),
        canRestore: conversation.productMode === "agent" && conversation.state === "archive"
          && conversation.archiveOrigin === "agent-user" && !blocked
          && !input.activeTurn?.(project.id, conversation.conversationId),
        canDelete: conversation.state === "archive" && !blocked
          && !input.activeTurn?.(project.id, conversation.conversationId),
        providerSyncStatus, diagnostic,
      })) };
    } finally { database.close(); }
  } catch {
    return { items: [], failure: { projectId: project.id, projectName: project.name, reason: "项目会话暂时无法读取。" } };
  }
}

function compareItems(a: ConversationManagementItem, b: ConversationManagementItem): number {
  return b.updatedAt.localeCompare(a.updatedAt)
    || b.projectId.localeCompare(a.projectId)
    || b.conversationId.localeCompare(a.conversationId);
}

function decodeCursor(value: string | null, fingerprint: string): Position | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor.");
    const cursor = parsed as Record<string, unknown>;
    if (cursor.fingerprint !== fingerprint || typeof cursor.updatedAt !== "string"
      || typeof cursor.projectId !== "string" || typeof cursor.conversationId !== "string") throw new Error("Invalid cursor.");
    return { updatedAt: cursor.updatedAt, projectId: cursor.projectId, conversationId: cursor.conversationId };
  } catch { throw badRequest("Conversation management filters changed; start at the first page."); }
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}
