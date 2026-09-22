// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSurface } from "../../src/web/src/panels/SettingsSurface.js";
import type { ProjectStatus } from "../../src/web/src/types.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const project = { project: { id: "p", name: "Project", path: "C:/p" }, path: "C:/p", pathExists: true,
  isGitRepo: true, managed: true, harness: { readiness: "ready" } } as ProjectStatus;
const item = { projectId: "p", projectName: "Project", conversationId: "old", productMode: "agent",
  title: "Archived conversation", state: "archive", archiveOrigin: "agent-user",
  lifecycleRevision: "conversation-lifecycle:1", updatedAt: "2026-09-01T00:00:00.000Z",
  canArchive: false, canRestore: true, canDelete: true, providerSyncStatus: "completed", diagnostic: null };

describe("conversation management settings", () => {
  it("does not reopen an archived preview after a newer lifecycle refresh", async () => {
    let resolveTimeline!: (value: Response) => void;
    const pendingTimeline = new Promise<Response>((resolve) => { resolveTimeline = resolve; });
    let archived = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("conversation-management")) return response({ conversations: archived ? [item] : [],
        nextCursor: null, unreadableProjects: [], partial: false });
      if (url.includes("/timeline")) return pendingTimeline;
      if (url.includes("/lifecycle")) return response({ projectId: "p", productMode: "agent", conversationId: "old",
        state: archived ? "archived" : "active", archiveOrigin: archived ? "agent-user" : null,
        lifecycleRevision: archived ? "conversation-lifecycle:1" : "conversation-lifecycle:2",
        updatedAt: item.updatedAt, canArchive: false, canRestore: true, canDelete: true, activity: null });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { section: "conversations" as const, onSectionChange: vi.fn(), project,
      projects: [project], productMode: "agent" as const, conversationId: null, selectedProviderId: null,
      diagnostics: null, modelSettings: null, onClose: vi.fn(), onRefresh: vi.fn() };
    const view = render(<SettingsSurface {...props} managementRefreshVersions={{}} />);
    await screen.findByText("Archived conversation");
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/timeline"))).toBe(true));
    archived = false;
    view.rerender(<SettingsSurface {...props} managementRefreshVersions={{ ["p\0agent"]: 1 }} />);
    await waitFor(() => expect(screen.queryByText("Archived conversation")).toBeNull());
    await act(async () => {
      resolveTimeline(response({ projectId: "p", productMode: "agent", conversationId: "old",
        agentSurfaceId: "main-agent", watermark: 0, pinned: [], entries: [],
        paging: { limit: 100, totalCount: 0, hasMoreBefore: false } }));
      await pendingTimeline;
    });
    expect(screen.queryByRole("region", { name: "归档会话预览" })).toBeNull();
  });

  it("refreshes a project filter only for lifecycle events in that project and mode", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("conversation-management")) return response({ conversations: [item], nextCursor: null, unreadableProjects: [], partial: false });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const props = { section: "conversations" as const, onSectionChange: vi.fn(), project,
      projects: [project], productMode: "agent" as const, conversationId: null, selectedProviderId: null,
      diagnostics: null, modelSettings: null, onClose: vi.fn(), onRefresh: vi.fn() };
    const view = render(<SettingsSurface {...props} managementRefreshVersions={{}} />);
    await screen.findByText("Archived conversation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.rerender(<SettingsSurface {...props} managementRefreshVersions={{ ["other\0agent"]: 1 }} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.rerender(<SettingsSurface {...props} managementRefreshVersions={{ ["other\0agent"]: 1, ["p\0agent"]: 1 }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("discards a delete confirmation prepared for an obsolete filter", async () => {
    let resolveConfirmation!: (value: Response) => void;
    const pendingConfirmation = new Promise<Response>((resolve) => { resolveConfirmation = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes("conversation-management")) return response({ conversations: [item], nextCursor: null, unreadableProjects: [], partial: false });
      if (url.includes("delete-confirmation") && options?.method === "POST") return pendingConfirmation;
      throw new Error(`Unexpected URL ${url}`);
    }));
    render(<SettingsSurface section="conversations" onSectionChange={vi.fn()} project={project}
      projects={[project]} productMode="agent" conversationId={null} selectedProviderId={null}
      diagnostics={null} modelSettings={null} onClose={vi.fn()} onRefresh={vi.fn()} />);
    await screen.findByText("Archived conversation");
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    fireEvent.change(screen.getByRole("combobox", { name: "会话范围" }), { target: { value: "all" } });
    await act(async () => {
      resolveConfirmation(response({ token: "old-token", expiresAt: "2026-09-01T00:05:00.000Z",
        conversationId: "old", lifecycleRevision: "conversation-lifecycle:1", effect: "delete" }));
      await pendingConfirmation;
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("loads only after opening the category, previews without a composer, and uses the row mode on restore", async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
      requests.push({ url, body });
      if (url.includes("conversation-management")) return response({ conversations: [item], nextCursor: null, unreadableProjects: [], partial: false });
      if (url.includes("/lifecycle") && options?.method === "POST") return response({ status: "completed" });
      if (url.includes("/lifecycle")) return response({ projectId: "p", productMode: "agent", conversationId: "old",
        state: "archived", archiveOrigin: "agent-user", lifecycleRevision: "conversation-lifecycle:1",
        updatedAt: item.updatedAt, canArchive: false, canRestore: true, canDelete: true, activity: null });
      if (url.includes("/timeline")) return response({ projectId: "p", productMode: "agent", conversationId: "old",
        agentSurfaceId: "main-agent", watermark: 1, pinned: [], entries: [{ projectId: "p", productMode: "agent",
          conversationId: "old", agentSurfaceId: "main-agent", messageId: "m1", position: 1, revision: 1,
          orderClass: "sequence", cells: [{ id: "c1", kind: "user-message", source: "user", text: "Historic message" }] }],
        paging: { limit: 100, totalCount: 1, hasMoreBefore: false } });
      throw new Error(`Unexpected URL ${url}`);
    }));
    const view = render(<SettingsSurface section="provider" onSectionChange={vi.fn()} project={project}
      projects={[project]} productMode="harness" conversationId={null} selectedProviderId={null}
      diagnostics={null} modelSettings={null} onClose={vi.fn()} onRefresh={vi.fn()} />);
    expect(requests).toHaveLength(0);
    view.rerender(<SettingsSurface section="conversations" onSectionChange={vi.fn()} project={project}
      projects={[project]} productMode="harness" conversationId={null} selectedProviderId={null}
      diagnostics={null} modelSettings={null} onClose={vi.fn()} onRefresh={vi.fn()} />);
    await screen.findByText("Archived conversation");
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    await screen.findByText("Historic message");
    expect(screen.queryByRole("textbox", { name: "发送消息" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(requests.find((request) => request.body?.action === "restore")?.body?.productMode).toBe("agent"));
  });
});

function response(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}
