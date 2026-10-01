// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsSettingsView } from "../../src/web/src/panels/SkillsSettingsView.js";
import { useSkillsSettingsController } from "../../src/web/src/controllers/useSkillsSettingsController.js";
import { skillsSettingsHttpPort, type SkillsSettingsPort } from "../../src/web/src/controllers/skills-settings-http-adapter.js";
import type { ProjectStatus, SkillListItem } from "../../src/web/src/types.js";
import type { ManagedSkillCatalogItem } from "../../src/types/skill-catalog.js";

const postJson = vi.fn();
vi.mock("../../src/web/src/api.js", () => ({ fetchJson: vi.fn(), postJson: (...args: unknown[]) => postJson(...args) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); postJson.mockReset(); });

function port(): SkillsSettingsPort {
  return { load: vi.fn(async () => ({ skills: [skill("reviewer")] })), refresh: vi.fn(async () => undefined),
    setProviderEnabled: vi.fn(async () => undefined), addSource: vi.fn(async () => undefined) };
}
function projects(...ids: string[]): ProjectStatus[] { return ids.map((id) => ({ project: { id, name: id, path: `E:/${id}` } } as ProjectStatus)); }
function TestView({ providerId = "codex", registered = [] as ProjectStatus[], projectId = null as string | null,
  conversationId = null as string | null, api, onRefresh = async () => undefined }: {
  providerId?: string; registered?: ProjectStatus[]; projectId?: string | null; conversationId?: string | null;
  api: SkillsSettingsPort; onRefresh?: () => Promise<void>;
}) {
  return <SkillsSettingsView surface={useSkillsSettingsController({ active: true, productMode: "agent", providerId,
    projectId, conversationId, projects: registered, port: api, onRefresh })} />;
}

describe("Skill management directory", () => {
  it("loads global Skills with no selected or registered project", async () => {
    const api = port(); render(<TestView api={api} />);
    expect(await screen.findByRole("button", { name: /reviewer/ })).toBeTruthy();
    expect(api.load).toHaveBeenCalledWith(expect.objectContaining({ projectId: null, conversationId: null, providerId: "codex" }));
    expect(screen.queryByText("选择项目后管理技能")).toBeNull();
    expect(screen.queryByRole("button", { name: "返回工作区" })).toBeNull();
  });

  it("keeps healthy global and project groups when a project is unavailable", async () => {
    const api = port(); api.load = vi.fn(async (identity) => {
      if (identity.projectId === "unavailable") throw new TypeError("network unavailable");
      return { skills: [skill(identity.projectId ?? "global")] };
    });
    render(<TestView api={api} registered={projects("repo", "unavailable")} />);
    expect(await screen.findByRole("button", { name: /global，/ })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /repo，/ })).toBeTruthy();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "unavailable" })).queryByText("还没有发现技能")).toBeNull();
  });

  it("loads global first and limits project requests to three", async () => {
    const api = port(); const global = deferred<{ skills: SkillListItem[] }>(); const pending = deferred<{ skills: SkillListItem[] }>();
    api.load = vi.fn((identity) => identity.projectId ? pending.promise : global.promise);
    render(<TestView api={api} registered={projects("a", "b", "c", "d", "e")} />);
    expect(api.load).toHaveBeenCalledTimes(1);
    await act(async () => global.resolve({ skills: [skill("global")] }));
    expect(api.load).toHaveBeenCalledTimes(4);
    await act(async () => pending.resolve({ skills: [] }));
    expect(api.load).toHaveBeenCalledTimes(6);
  });

  it("ignores late Provider results and keeps conversation changes out of directory identity", async () => {
    const api = port(); const stale = deferred<{ skills: SkillListItem[] }>();
    api.load = vi.fn((identity) => identity.providerId === "codex" ? stale.promise : Promise.resolve({ skills: [skill("current")] }));
    const view = render(<TestView api={api} conversationId="one" />);
    view.rerender(<TestView api={api} providerId="other" conversationId="two" />);
    expect(await screen.findByRole("button", { name: /current/ })).toBeTruthy();
    const count = vi.mocked(api.load).mock.calls.length;
    view.rerender(<TestView api={api} providerId="other" conversationId="three" />);
    expect(api.load).toHaveBeenCalledTimes(count);
    await act(async () => stale.resolve({ skills: [skill("stale")] }));
    expect(screen.queryByText("stale")).toBeNull();
  });

  it("paginates fifty rows while search covers the full loaded directory", async () => {
    const api = port(); api.load = vi.fn(async () => ({ skills: Array.from({ length: 120 }, (_, i) => skill(`skill-${i}`)) }));
    render(<TestView api={api} />);
    const list = await screen.findByRole("list", { name: "通用技能列表" });
    expect(within(list).getAllByRole("button")).toHaveLength(50);
    expect(screen.queryByText("skill-119")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "skill-119" } });
    expect(screen.getByRole("button", { name: /skill-119/ })).toBeTruthy();
    expect(api.load).toHaveBeenCalledTimes(1);
  });

  it("submits the original Skill identity and retains a detail dialog during refresh", async () => {
    const api = port(); const reload = deferred<{ skills: SkillListItem[] }>(); const refreshed = vi.fn(async () => undefined);
    const managed = { ...skill("reviewer"), catalogId: "display-id", sourceIdentity: "physical-id", canChangeProviderEnabled: true } as ManagedSkillCatalogItem;
    api.load = vi.fn().mockResolvedValueOnce({ skills: [managed] }).mockImplementation(() => reload.promise);
    render(<TestView api={api} onRefresh={refreshed} />);
    fireEvent.click(await screen.findByRole("button", { name: /reviewer/ }));
    const toggle = screen.getByRole("checkbox", { name: /为此 AI 服务启用/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setProviderEnabled).toHaveBeenCalledTimes(1));
    expect(api.setProviderEnabled).toHaveBeenCalledWith(expect.objectContaining({ projectId: null, conversationId: null }), "reviewer", false, managed);
    expect(screen.getByRole("dialog", { name: "reviewer 详情" })).toBeTruthy();
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    await act(async () => reload.resolve({ skills: [{ ...managed, providerEnabled: false }] }));
    await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("checkbox", { name: /为此 AI 服务启用/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("reports saved configuration separately from a failed refresh", async () => {
    const api = port(); api.load = vi.fn().mockResolvedValueOnce({ skills: [skill("reviewer")] }).mockRejectedValue(new Error("unavailable"));
    render(<TestView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /reviewer/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /为此 AI 服务启用/ }));
    expect(await screen.findByText("配置已保存，目录刷新失败。")).toBeTruthy();
    expect(api.setProviderEnabled).toHaveBeenCalledTimes(1);
  });

  it("locks protected entries and keeps write rejection recoverable", async () => {
    const api = port(); api.load = vi.fn(async () => ({ skills: [{ ...skill("required"), required: true,
      canChangeProviderEnabled: false, lockReason: "项目必需技能" } as ManagedSkillCatalogItem] }));
    render(<TestView api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /required/ }));
    expect(screen.getByText("项目必需技能")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(api.setProviderEnabled).not.toHaveBeenCalled();
  });

  it("requires an explicit project for custom sources and keeps input on failure", async () => {
    const api = port(); api.load = vi.fn(async () => ({ skills: [], roots: [] })); api.addSource = vi.fn(async () => { throw new TypeError("network unavailable"); });
    render(<TestView api={api} registered={projects("repo")} />);
    await screen.findByRole("region", { name: "repo" });
    fireEvent.click(screen.getByRole("button", { name: "管理来源" }));
    const input = screen.getByRole("textbox", { name: "技能目录" });
    fireEvent.change(input, { target: { value: "E:/trusted/skills" } });
    expect((screen.getByRole("button", { name: "添加来源" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "来源所属项目" }), { target: { value: "repo" } });
    fireEvent.click(screen.getByRole("button", { name: "添加来源" }));
    expect(await screen.findByText("暂时无法连接到本地服务。")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("E:/trusted/skills");
    expect(api.addSource).toHaveBeenCalledWith(expect.objectContaining({ projectId: "repo", conversationId: null }), "E:/trusted/skills");
  });

  it("redacts diagnostics and returns focus after closing details", async () => {
    const api = port(); api.load = vi.fn(async () => ({ skills: [skill("reviewer")], errors: [{ path: "C:/private/broken/SKILL.md", message: "ENOENT C:/private/broken" }] }));
    render(<TestView api={api} />);
    const trigger = await screen.findByRole("button", { name: /reviewer/ });
    fireEvent.click(trigger); fireEvent.click(screen.getByRole("button", { name: "关闭技能详情" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(screen.getByRole("button", { name: "查看诊断" }));
    expect(screen.getByText("…/broken/SKILL.md")).toBeTruthy();
    expect(screen.queryByText(/C:\/private/)).toBeNull();
  });

  it("sends the config expectation fence through the management HTTP adapter", async () => {
    postJson.mockResolvedValue({ saved: true });
    const item = { ...skill("reviewer"), sourceIdentity: "source" } as ManagedSkillCatalogItem;
    await skillsSettingsHttpPort.setProviderEnabled({ projectId: "repo", productMode: "agent", conversationId: null, providerId: "codex" }, "reviewer", false, item);
    expect(postJson).toHaveBeenCalledWith("/api/projects/repo/skills/reviewer/provider-enable?catalog=management",
      expect.objectContaining({ enabled: false, expectedEnabled: true, sourceIdentity: "source", expectedContentHash: "hash-reviewer", providerId: "codex" }));
  });
});

function skill(skillId: string): SkillListItem {
  return { skillId, name: skillId, description: `${skillId} description`, sourcePath: `E:/skills/${skillId}/SKILL.md`, sourceKind: "custom",
    scope: "repo", contentHash: `hash-${skillId}`, compatibility: { requiredCapabilities: [] }, providerBindings: [],
    providerEnabled: true, required: false, runtimeAssigned: false, enabledProject: false, enabledTopics: [], disabledTopics: [] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((res) => { resolve = res; }); return { promise, resolve }; }
