// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsSettingsView } from "../../src/web/src/panels/SkillsSettingsView.js";
import { useSkillsSettingsController } from "../../src/web/src/controllers/useSkillsSettingsController.js";
import type { ProductMode } from "../../src/web/src/types.js";
import type { SkillListItem } from "../../src/web/src/types.js";

const fetchJson = vi.fn();
const postJson = vi.fn();

vi.mock("../../src/web/src/api.js", () => ({
  fetchJson: (...args: unknown[]) => fetchJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
}));

afterEach(() => {
  cleanup();
  fetchJson.mockReset();
  postJson.mockReset();
});

describe("SkillsSettingsView request identity", () => {
  it("renders a load failure with local recovery instead of an empty catalog", async () => {
    fetchJson
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce({ skills: [skill("recovered-skill")] });
    render(<TestSkillsSettings projectId="repo" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("暂时无法连接到本地服务。")).toBeTruthy();
    expect(screen.queryByText("还没有发现技能")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByText("recovered-skill")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores a late catalog response after the Provider changes", async () => {
    const initial = deferred<{ skills: SkillListItem[] }>();
    fetchJson
      .mockImplementationOnce(() => initial.promise)
      .mockResolvedValueOnce({ skills: [skill("current-skill")] });
    const view = render(<TestSkillsSettings
      projectId="repo"
      productMode="agent"
      conversationId="conversation-1"
      providerId="codex"
      onRefresh={vi.fn()}
    />);
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));

    view.rerender(<TestSkillsSettings
      projectId="repo"
      productMode="agent"
      conversationId="conversation-1"
      providerId="other-provider"
      onRefresh={vi.fn()}
    />);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "技能列表" })).getByText("current-skill")).toBeTruthy());
    initial.resolve({ skills: [skill("stale-skill")] });
    await Promise.resolve();

    expect(within(screen.getByRole("list", { name: "技能列表" })).getByText("current-skill")).toBeTruthy();
    expect(screen.queryByText("stale-skill")).toBeNull();
  });

  it("does not paint the previous identity catalog or open source paths after a scope change", async () => {
    const next = deferred<{ skills: SkillListItem[]; roots: Array<{ rootPath: string; sourceKind: "custom"; updatedAt: string }> }>();
    fetchJson
      .mockResolvedValueOnce({ skills: [skill("old-skill")], roots: [{ rootPath: "C:/private/old-skills", sourceKind: "custom", updatedAt: "2026-09-15T00:00:00.000Z" }] })
      .mockImplementationOnce(() => next.promise);
    const view = render(<TestSkillsSettings projectId="repo-a" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("old-skill")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "管理来源" }));
    expect(screen.getByText("C:/private/old-skills")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "技能目录" }), { target: { value: "C:/private/pending-source" } });

    view.rerender(<TestSkillsSettings projectId="repo-b" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);
    expect(screen.queryByText("old-skill")).toBeNull();
    expect(screen.queryByText("C:/private/old-skills")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "管理技能来源" })).toBeNull();
    expect(screen.getByText("正在加载技能…")).toBeTruthy();

    next.resolve({ skills: [skill("new-skill")], roots: [] });
    await waitFor(() => expect(screen.getByText("new-skill")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "管理来源" }));
    expect((screen.getByRole("textbox", { name: "技能目录" }) as HTMLInputElement).value).toBe("");
  });

  it("groups Skills, opens details on demand, and hides absolute paths outside source settings", async () => {
    fetchJson.mockResolvedValue({ skills: [{ ...skill("reviewer"), sourceKind: "provider-native" }], roots: [{ rootPath: "C:/skills", sourceKind: "custom", updatedAt: "2026-09-04T00:00:00.000Z" }] });
    render(<TestSkillsSettings projectId="repo" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /reviewer/ })).toBeTruthy());
    expect(screen.queryByText("C:/skills/reviewer/SKILL.md")).toBeNull();
    const skillTrigger = screen.getByRole("button", { name: /reviewer/ });
    expect(skillTrigger.getAttribute("aria-label")).toContain("当前 Agent 的本机技能");
    fireEvent.click(skillTrigger);
    expect(screen.getByRole("dialog", { name: "reviewer 详情" })).toBeTruthy();
    expect(screen.queryByText("C:/skills/reviewer/SKILL.md")).toBeNull();
    const closeDetail = screen.getByRole("button", { name: "关闭技能详情" });
    expect(document.activeElement).toBe(closeDetail);
    fireEvent.click(closeDetail);
    expect(screen.queryByRole("dialog", { name: "reviewer 详情" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(skillTrigger));
    const sourceTrigger = screen.getByRole("button", { name: "管理来源" });
    sourceTrigger.focus();
    fireEvent.click(sourceTrigger);
    expect(screen.getByRole("dialog", { name: "管理技能来源" })).toBeTruthy();
    expect(screen.getByText("C:/skills")).toBeTruthy();
    const sourceInput = screen.getByRole("textbox", { name: "技能目录" });
    const closeSource = screen.getByRole("button", { name: "关闭技能来源设置" });
    expect(document.activeElement).toBe(sourceInput);
    fireEvent.click(closeSource);
    await waitFor(() => expect(document.activeElement).toBe(sourceTrigger));
  });

  it("keeps a large catalog searchable by stable Skill identity", async () => {
    const skills = Array.from({ length: 120 }, (_, index) => skill(`skill-${String(index).padStart(3, "0")}`));
    fetchJson.mockResolvedValue({ skills });
    render(<TestSkillsSettings projectId="repo" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("skill-119")).toBeTruthy());
    expect(within(screen.getByRole("list", { name: "技能列表" })).getAllByRole("button")).toHaveLength(120);

    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "skill-087" } });
    const result = screen.getByRole("button", { name: /skill-087/ });
    expect(result.getAttribute("aria-label")).toContain("自定义来源");
    expect(result.getAttribute("aria-label")).toContain("已启用");
    fireEvent.click(result);
    expect(screen.getByRole("dialog", { name: "skill-087 详情" })).toBeTruthy();
  });

  it("closes a detail drawer when search filters out the selected Skill", async () => {
    fetchJson.mockResolvedValue({ skills: [skill("reviewer"), skill("planner")] });
    render(<TestSkillsSettings projectId="repo" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("reviewer")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /reviewer/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能" }), { target: { value: "planner" } });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "reviewer 详情" })).toBeNull());
    expect(screen.getByText("planner")).toBeTruthy();
  });

  it("redacts absolute paths from catalog diagnostics", async () => {
    fetchJson.mockResolvedValue({
      skills: [skill("reviewer")],
      errors: [
        {
          path: "C:/Users/example/.codex/skills/broken/SKILL.md",
          message: "ENOENT:/root/.codex/skills/broken",
        },
        {
          path: "/srv/skills/unreadable/SKILL.md",
          message: "Cannot read file:///srv/skills/unreadable",
        },
      ],
    });
    render(<TestSkillsSettings projectId="repo" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("部分技能暂时无法读取，其余技能仍可使用。")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "查看诊断" }));

    expect(screen.getByText("…/broken/SKILL.md")).toBeTruthy();
    expect(screen.getByText("ENOENT:[本机路径已隐藏]")).toBeTruthy();
    expect(screen.getByText("Cannot read [本机路径已隐藏]")).toBeTruthy();
    expect(screen.queryByText(/\/root\/\.codex/)).toBeNull();
    expect(screen.queryByText(/file:\/\/\/srv/)).toBeNull();
  });

  it("changes Provider enablement only from the detail dialog and reloads canonical results", async () => {
    const refresh = vi.fn(async () => undefined);
    fetchJson.mockResolvedValue({ skills: [skill("reviewer")] });
    postJson.mockResolvedValue({});
    render(<TestSkillsSettings projectId="repo" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={refresh} />);
    const skillTrigger = await screen.findByRole("button", { name: /reviewer/ });

    expect(postJson).not.toHaveBeenCalled();
    fireEvent.click(skillTrigger);
    fireEvent.click(screen.getByRole("checkbox", { name: /为当前 Agent 启用/ }));

    await waitFor(() => expect(postJson).toHaveBeenCalledWith(
      "/api/projects/repo/skills/reviewer/provider-enable",
      expect.objectContaining({ enabled: false, productMode: "agent", conversationId: "conversation-1", providerId: "codex" }),
    ));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("keeps source input and the dialog open when adding a source fails", async () => {
    fetchJson.mockResolvedValue({ skills: [skill("reviewer")], roots: [] });
    postJson.mockRejectedValueOnce(new TypeError("network unavailable"));
    render(<TestSkillsSettings projectId="repo" productMode="agent" conversationId="conversation-1" providerId="codex" onRefresh={vi.fn()} />);
    await screen.findByRole("button", { name: /reviewer/ });
    fireEvent.click(screen.getByRole("button", { name: "管理来源" }));
    const sourceInput = screen.getByRole("textbox", { name: "技能目录" });
    fireEvent.change(sourceInput, { target: { value: "C:/trusted/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "添加来源" }));

    await waitFor(() => expect(screen.getByText("暂时无法连接到本地服务。")).toBeTruthy());
    expect(screen.getByRole("dialog", { name: "管理技能来源" })).toBeTruthy();
    expect((sourceInput as HTMLInputElement).value).toBe("C:/trusted/skills");
  });

  it("does not refresh the current scope after an old Provider mutation completes", async () => {
    const mutation = deferred<void>();
    const refresh = vi.fn(async () => undefined);
    fetchJson.mockResolvedValue({ skills: [skill("reviewer")] });
    postJson.mockImplementationOnce(() => mutation.promise);
    const view = render(<TestSkillsSettings
      projectId="repo"
      productMode="agent"
      conversationId="conversation-1"
      providerId="codex"
      onRefresh={refresh}
    />);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "技能列表" })).getByText("reviewer")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /重新检测/ }));
    await waitFor(() => expect(postJson).toHaveBeenCalledTimes(1));

    view.rerender(<TestSkillsSettings
      projectId="repo"
      productMode="agent"
      conversationId="conversation-1"
      providerId="other-provider"
      onRefresh={refresh}
    />);
    await waitFor(() => expect(fetchJson.mock.calls.some((call) => String(call[0]).includes("providerId=other-provider"))).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: /重新检测/ }) as HTMLButtonElement).disabled).toBe(false));
    mutation.resolve();
    await Promise.resolve();

    expect(refresh).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /重新检测/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not publish an older same-identity load failure after a newer load succeeds", async () => {
    const stale = deferred<{ skills: SkillListItem[] }>();
    fetchJson
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ skills: [skill("current-skill")] });
    const view = render(<TestSkillsSettings
      projectId="repo"
      productMode="agent"
      conversationId="conversation-1"
      providerId="codex"
      onRefresh={vi.fn()}
    />);
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));

    view.rerender(<TestSkillsSettings
      projectId={null}
      productMode="agent"
      conversationId={null}
      providerId="codex"
      onRefresh={vi.fn()}
    />);
    view.rerender(<TestSkillsSettings
      projectId="repo"
      productMode="agent"
      conversationId="conversation-1"
      providerId="codex"
      onRefresh={vi.fn()}
    />);
    await waitFor(() => expect(
      within(screen.getByRole("list", { name: "技能列表" })).getByText("current-skill"),
    ).toBeTruthy());
    stale.reject(new Error("stale load failed"));
    await Promise.resolve();

    expect(screen.queryByText("stale load failed")).toBeNull();
    expect(within(screen.getByRole("list", { name: "技能列表" })).getByText("current-skill")).toBeTruthy();
  });
});

function TestSkillsSettings({ projectId, productMode, conversationId, providerId, onRefresh }: {
  projectId: string | null;
  productMode: ProductMode;
  conversationId: string | null;
  providerId: string | null;
  onRefresh: () => Promise<void>;
}) {
  const surface = useSkillsSettingsController({
    active: true,
    projectId,
    productMode,
    conversationId,
    providerId,
    onRefresh,
  });
  return <SkillsSettingsView surface={surface} onBack={vi.fn()} />;
}

function skill(skillId: string): SkillListItem {
  return {
    skillId,
    name: skillId,
    description: `${skillId} description`,
    sourcePath: `C:/skills/${skillId}/SKILL.md`,
    sourceKind: "custom",
    scope: "repo",
    contentHash: `hash-${skillId}`,
    compatibility: { requiredCapabilities: [] },
    providerBindings: [{
      providerId: "codex",
      bindingKind: "native",
      status: "ready",
      contentHash: `hash-${skillId}`,
      scope: "repo",
    }],
    providerEnabled: true,
    required: false,
    runtimeAssigned: false,
    enabledProject: false,
    enabledTopics: [],
    disabledTopics: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
