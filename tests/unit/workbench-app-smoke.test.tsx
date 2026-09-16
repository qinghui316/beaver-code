// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/src/App.js";
import { emptyWorkbenchSnapshot } from "../../src/web/src/controllers/useProjectConversationSession.js";
import type {
  CanonicalTimelinePage,
  ConversationInteraction,
  Snapshot,
} from "../../src/web/src/types.js";

const officeCalibration = JSON.parse(readFileSync("src/web/public/agent-office/config/office-calibration.json", "utf8"));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose: () => void } { return { dispose: () => undefined }; }
    write(): void {}
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit(): void {} },
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly url: string;

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  close(): void {}
}

describe("Workbench App owner composition", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?project=repo&topic=conv-1");
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, String(value)); },
        removeItem: (key: string) => { storage.delete(key); },
        clear: () => { storage.clear(); },
      },
    });
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    installMatchMedia(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the canonical Main Timeline and Composer through the shell", async () => {
    installApiFixture(createSnapshot());
    render(<App />);

    expect(await screen.findByText("Canonical Main reply")).toBeTruthy();
    expect(screen.getByPlaceholderText("输入问题或下一步需求")).toBeTruthy();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe("/api/projects/repo/workbench/events/live");
  });

  it("shows one accessible status icon only on the inactive product mode", async () => {
    installApiFixture(createSnapshot());
    const view = render(<App />);

    expect(await screen.findByRole("button", { name: "Agent，正在执行" })).toBeTruthy();
    const agentButton = screen.getByRole("button", { name: "Agent，正在执行" });
    const harnessButton = screen.getByRole("button", { name: "AHO" });
    expect(agentButton.textContent).toBe("");
    expect(harnessButton.textContent).toBe("");
    expect(harnessButton.getAttribute("title")).toContain("让多个 Agent 按流程协作");
    expect(screen.queryByText("让多个 Agent 按流程协作")).toBeNull();
    expect(harnessButton.querySelector(".product-mode-activity-icon svg")).toBeNull();
    expect(view.container.querySelectorAll(".product-mode-activity-icon")).toHaveLength(2);
  });

  it("keeps the office as a pure center view and opens a canonical child surface", async () => {
    installApiFixture(createSnapshot());
    render(<App />);
    await screen.findByText("Canonical Main reply");

    fireEvent.click(screen.getByTestId("orchestration-overlay-toggle"));
    expect(await screen.findByTestId("agent-office-center-view")).toBeTruthy();
    expect(screen.queryByPlaceholderText("输入问题或下一步需求")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /Agent 列表，共 1 个/ }));
    fireEvent.click(screen.getByRole("menuitem"));
    expect(await screen.findByTestId("agent-workspace-panel")).toBeTruthy();
    expect(await screen.findByText("Canonical child reply")).toBeTruthy();
    expect(screen.getByTestId("agent-office-center-view")).toBeTruthy();
  });

  it("closes the mobile office after exact Agent navigation so the workspace is visible", async () => {
    installMatchMedia(true);
    installApiFixture(createSnapshot());
    render(<App />);
    await screen.findByText("Canonical Main reply");

    fireEvent.click(screen.getByTestId("orchestration-overlay-toggle"));
    fireEvent.click(await screen.findByRole("button", { name: /Agent 列表，共 1 个/ }));
    fireEvent.click(screen.getByRole("menuitem"));

    expect(await screen.findByTestId("agent-workspace-panel")).toBeTruthy();
    expect(await screen.findByText("Canonical child reply")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("agent-office-center-view")).toBeNull());
  });

  it("opens the shared conversation sidebar on mobile and closes it after navigation", async () => {
    installMatchMedia(true);
    installApiFixture(createSnapshot());
    const view = render(<App />);
    await screen.findByText("Canonical Main reply");

    const toggle = screen.getByRole("button", { name: "打开会话栏" });
    fireEvent.click(toggle);
    expect(view.container.querySelector(".app-shell")?.classList.contains("mobile-sidebar-open")).toBe(true);
    expect(view.container.querySelector('[aria-controls="project-conversation-sidebar"]')?.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(view.container.querySelector(".conversation-row")!);
    await waitFor(() => expect(view.container.querySelector(".app-shell")?.classList.contains("mobile-sidebar-open")).toBe(false));
    expect(view.container.querySelector('[aria-controls="project-conversation-sidebar"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps mobile sidebar focus and workspace isolation inside the modal drawer", async () => {
    installMatchMedia(true);
    installApiFixture(createSnapshot());
    const view = render(<App />);
    await screen.findByText("Canonical Main reply");

    const toggle = screen.getByRole("button", { name: "打开会话栏" });
    fireEvent.click(toggle);
    const drawer = screen.getByRole("dialog", { name: "左侧项目栏" });
    expect(document.activeElement).toBe(drawer);
    expect(view.container.querySelector("main.workspace")?.hasAttribute("inert")).toBe(true);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索项目和对话" }));
    const settingsButton = screen.getByRole("button", { name: "设置" });
    settingsButton.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索项目和对话" }));
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(settingsButton);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "左侧项目栏" })).toBeNull());
    expect(document.activeElement).toBe(toggle);
    expect(view.container.querySelector("main.workspace")?.hasAttribute("inert")).toBe(false);
  });

  it("closes the mobile drawer before entering Settings and does not restore stale drawer state", async () => {
    installMatchMedia(true);
    installApiFixture(createSnapshot());
    const view = render(<App />);
    await screen.findByText("Canonical Main reply");

    fireEvent.click(screen.getByRole("button", { name: "打开会话栏" }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("button", { name: "返回工作区" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回工作区" }));

    expect(await screen.findByRole("button", { name: "打开会话栏" })).toBeTruthy();
    expect(view.container.querySelector(".app-shell")?.classList.contains("mobile-sidebar-open")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "左侧项目栏" })).toBeNull();
  });

  it("consumes mobile drawer Escape before an active Agent Turn can stop", async () => {
    window.localStorage.setItem("aho.workbench.productMode.v1", "agent");
    installMatchMedia(true);
    installApiFixture(createRunningAgentSnapshot());
    const view = render(<App />);
    await screen.findByText("Canonical Main reply");

    fireEvent.click(screen.getByRole("button", { name: "打开会话栏" }));
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(view.container.querySelector(".app-shell")?.classList.contains("mobile-sidebar-open")).toBe(false));
    expect(requestUrls("/turn/interrupt")).toHaveLength(0);
  });

  it("closes the mobile modal when the viewport leaves the sidebar breakpoint", async () => {
    const media = installMatchMedia(true);
    installApiFixture(createSnapshot());
    const view = render(<App />);
    await screen.findByText("Canonical Main reply");

    fireEvent.click(screen.getByRole("button", { name: "打开会话栏" }));
    expect(screen.getByRole("dialog", { name: "左侧项目栏" })).toBeTruthy();
    media.setMatches(false);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "左侧项目栏" })).toBeNull());
    expect(view.container.querySelector(".app-shell")?.classList.contains("mobile-sidebar-open")).toBe(false);
    expect(view.container.querySelector("main.workspace")?.hasAttribute("inert")).toBe(false);
    expect(view.container.querySelector("#project-conversation-sidebar")?.hasAttribute("aria-modal")).toBe(false);
  });

  it("uses token-bound destructive project removal while preserving source owners in the warning", async () => {
    installApiFixture(createSnapshot());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await screen.findByText("Canonical Main reply");

    fireEvent.click(await screen.findByRole("button", { name: "更多项目操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /移出项目/ }));

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    const warning = String(confirm.mock.calls[0]?.[0] ?? "");
    expect(warning).toContain("永久删除 AHO 中的会话、执行记录和日志");
    expect(warning).toContain("项目源码、项目协作配置、Git 独立工作区和 Git 历史会保留");
    await waitFor(() => {
      const removalCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/api/projects/repo/remove"));
      expect(removalCall).toBeDefined();
      expect(JSON.parse(String(removalCall?.[1]?.body))).toEqual({
        confirm: true,
        confirmationToken: "remove-token-repo",
      });
    });
    const confirmationCall = vi.mocked(fetch).mock.calls.find(([input]) => (
      String(input).endsWith("/api/projects/repo/removal-confirmation")
    ));
    expect(confirmationCall).toBeDefined();
  });

  it("mounts the active Interaction Dock in the Composer slot only", async () => {
    const interaction = createInteraction();
    installApiFixture(createSnapshot(interaction));
    render(<App />);

    expect(await screen.findByText("Choose execution mode")).toBeTruthy();
    expect(screen.getAllByText("Safe mode")).toHaveLength(1);
    expect(screen.queryByPlaceholderText("输入问题或下一步需求")).toBeNull();
  });

  it("owns the complete rail toggle cycle and keyboard column resizing", async () => {
    installApiFixture(createSnapshot());
    const view = render(<App />);
    await screen.findByText("Canonical Main reply");
    const shell = view.container.querySelector(".app-shell") as HTMLElement;
    const leftSeparator = screen.getByRole("separator", { name: "调整左侧项目栏宽度" });
    expect(leftSeparator.getAttribute("tabindex")).toBe("0");
    expect(leftSeparator.getAttribute("aria-valuenow")).toBe("280");
    fireEvent.keyDown(leftSeparator, { key: "ArrowRight" });
    expect(shell.style.getPropertyValue("--left-sidebar-width")).toBe("296px");
    fireEvent.keyDown(leftSeparator, { key: "Home" });
    expect(shell.style.getPropertyValue("--left-sidebar-width")).toBe("220px");

    fireEvent.click(screen.getByRole("button", { name: "打开工具" }));
    expect(screen.getByTestId("right-tool-launcher")).toBeTruthy();
    const rightSeparator = screen.getByRole("separator", { name: "调整右侧工具栏宽度" });
    expect(rightSeparator.getAttribute("aria-valuemin")).toBe("280");
    expect(rightSeparator.getAttribute("aria-valuemax")).toBe("560");
    fireEvent.keyDown(rightSeparator, { key: "ArrowLeft" });
    expect(shell.style.getPropertyValue("--right-rail-width")).toBe("336px");
    fireEvent.click(screen.getByTestId("right-tool-launcher-diagnostics"));
    expect(screen.queryByTestId("right-tool-launcher")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭工具" }));
    expect(screen.queryByTestId("decision-pane-shell")).toBeNull();
  });

  it("keeps shared rail tools and removes Harness governance in Agent mode", async () => {
    window.localStorage.setItem("aho.workbench.productMode.v1", "agent");
    installApiFixture(createSnapshot(undefined, "agent"));
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector(".thread-header strong")?.textContent).toBe("Owner convergence"));
    expect(screen.getByRole("button", { name: "Agent" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "打开工具" }));
    expect(await screen.findByTestId("right-tool-launcher-agent")).toBeTruthy();
    expect(screen.queryByTestId("right-tool-launcher-confirm")).toBeNull();
    expect(screen.getByTestId("right-tool-launcher-files")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-git")).toBeTruthy();
    expect(screen.getByTestId("right-tool-launcher-diagnostics")).toBeTruthy();
  });

  it("threads Agent mode through provider readiness, existing messages, and timeline calibration", async () => {
    window.localStorage.setItem("aho.workbench.productMode.v1", "agent");
    installApiFixture(createSnapshot(undefined, "agent"));
    render(<App />);

    const composer = await screen.findByPlaceholderText("输入问题或下一步需求");
    await waitFor(() => expect(requestUrls("/providers/capabilities?")).toContain(
      "/api/projects/repo/providers/capabilities?productMode=agent",
    ));
    fireEvent.change(composer, { target: { value: "Agent follow-up" } });
    fireEvent.click(screen.getByTitle("发送"));

    await waitFor(() => {
      const call = requestCall("/workbench/topics/conv-1/messages/live");
      expect(call).toBeDefined();
      expect(requestBody(call)).toEqual(expect.objectContaining({
        message: "Agent follow-up",
        productMode: "agent",
      }));
    });
    expect(requestUrls("/timeline?").every((url) => url.includes("productMode=agent"))).toBe(true);
  });

  it("withholds the previous Conversation identity while a product-mode Snapshot is calibrating", async () => {
    window.localStorage.setItem("aho.workbench.productMode.v1", "agent");
    let resolveHarnessSnapshot!: (value: Snapshot) => void;
    const harnessSnapshot = new Promise<Snapshot>((resolve) => { resolveHarnessSnapshot = resolve; });
    installApiFixture(createSnapshot(undefined, "agent"), {
      loadSnapshot: (_projectId, productMode) => productMode === "harness"
        ? harnessSnapshot
        : createSnapshot(undefined, "agent"),
    });
    render(<App />);
    await screen.findByText("Canonical Main reply");

    const requestStart = vi.mocked(fetch).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^AHO/ }));
    await waitFor(() => expect(requestUrls("/providers/capabilities?")).toContain(
      "/api/projects/repo/providers/capabilities?productMode=harness",
    ));

    const duringCalibration = vi.mocked(fetch).mock.calls.slice(requestStart).map(([input]) => String(input));
    expect(duringCalibration.some((url) => url.includes("/workbench/conversations/conv-1/") && url.includes("productMode=harness"))).toBe(false);
    expect(duringCalibration.some((url) => url.includes("/agent-surfaces/conv-1") && url.includes("productMode=harness"))).toBe(false);
    expect(screen.queryByText("Owner convergence")).toBeNull();

    resolveHarnessSnapshot(snapshotWithConversationId(createSnapshot(undefined, "harness"), "harness-conversation"));
    await waitFor(() => expect(screen.getAllByText("harness-conversation").length).toBeGreaterThan(0));
    await waitFor(() => expect(requestUrls("/workbench/conversations/harness-conversation/turn-queue").some((url) => (
      url.includes("productMode=harness")
    ))).toBe(true));
  });

  it("loads the Agent Composer draft for a registered project without a ready Harness", async () => {
    window.localStorage.setItem("aho.workbench.productMode.v1", "agent");
    installApiFixture(createSnapshot(undefined, "agent"), { projectManaged: false });

    render(<App />);

    await screen.findByText("Canonical Main reply");
    await waitFor(() => expect(requestUrls("/workbench/composer-draft")).toContain(
      "/api/projects/repo/workbench/composer-draft?productMode=agent",
    ));
  });

  it("creates an Agent conversation from the empty shell with the captured mode", async () => {
    window.history.replaceState({}, "", "/?project=repo");
    window.localStorage.setItem("aho.workbench.productMode.v1", "agent");
    installApiFixture(createEmptySnapshot("agent"));
    render(<App />);

    const initialProjectPicker = await screen.findByRole("button", { name: "选择项目" });
    expect(initialProjectPicker.getAttribute("title")).toBe("选择项目");
    await screen.findByRole("button", { name: "Repo" });
    const projectPicker = screen.getByRole("button", { name: "选择项目" });
    expect(projectPicker.getAttribute("title")).toBe("Repo");
    fireEvent.click(projectPicker);
    expect(screen.getByText("repo")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("E:/repo");
    fireEvent.click(projectPicker);

    const composer = await screen.findByLabelText("新建需求输入框");
    fireEvent.change(composer, { target: { value: "Start an Agent conversation" } });
    await waitFor(() => {
      const draftCall = vi.mocked(fetch).mock.calls.find((call) => (
        String(call[0]).includes("/workbench/composer-draft")
        && call[1]?.method === "PUT"
        && requestBody(call)?.text === "Start an Agent conversation"
      ));
      expect(requestBody(draftCall)).toEqual(expect.objectContaining({
        productMode: "agent",
        text: "Start an Agent conversation",
      }));
    });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => {
      const call = requestCall("/workbench/topics/live");
      expect(call).toBeDefined();
      expect(requestBody(call)).toEqual(expect.objectContaining({
        body: "Start an Agent conversation",
        productMode: "agent",
      }));
    });
  });
});

function createSnapshot(interaction?: ConversationInteraction, productMode: "agent" | "harness" = "harness"): Snapshot {
  const project = { id: "repo", name: "Repo", path: "E:/repo" };
  const topic = {
    id: "conv-1",
    productMode,
    title: "Owner convergence",
    state: "active",
    kind: "conversation" as const,
    boundChangeId: null,
    selectedProviderId: "codex",
  };
  return {
    ...emptyWorkbenchSnapshot,
    productMode,
    project,
    memory: { harnessReady: true },
    left: { topics: [topic], workpads: [] },
    center: {
      ...emptyWorkbenchSnapshot.center,
      selectedTopic: topic,
      workpad: {
        ...emptyWorkbenchSnapshot.center.workpad,
        title: topic.title,
        subtitle: project.name,
        state: "active",
        conversationLifecycle: "active",
      },
      conversationInteractions: { productMode, conversationId: topic.id, items: interaction ? [interaction] : [] },
    },
    right: { ...emptyWorkbenchSnapshot.right },
  };
}

function createEmptySnapshot(productMode: "agent" | "harness"): Snapshot {
  const snapshot = createSnapshot(undefined, productMode);
  return {
    ...snapshot,
    left: { topics: [], workpads: [] },
    center: {
      ...emptyWorkbenchSnapshot.center,
      conversationInteractions: { productMode, conversationId: null, items: [] },
    },
  };
}

function snapshotWithConversationId(snapshot: Snapshot, conversationId: string): Snapshot {
  const topic = snapshot.center.selectedTopic
    ? { ...snapshot.center.selectedTopic, id: conversationId, title: conversationId }
    : null;
  return {
    ...snapshot,
    left: {
      ...snapshot.left,
      topics: topic ? [topic] : [],
    },
    center: {
      ...snapshot.center,
      selectedTopic: topic,
      workpad: snapshot.center.workpad ? { ...snapshot.center.workpad, title: conversationId } : snapshot.center.workpad,
      conversationInteractions: {
        ...snapshot.center.conversationInteractions,
        conversationId,
      },
    },
  };
}

function createRunningAgentSnapshot(): Snapshot {
  const snapshot = createSnapshot(undefined, "agent");
  return {
    ...snapshot,
    center: {
      ...snapshot.center,
      workpad: {
        ...snapshot.center.workpad,
        runControlState: {
          state: "running",
          canStop: true,
          canSteer: true,
          providerId: "codex",
          attemptId: "attempt-running-1",
          pendingFeedbackCount: 0,
          explanation: "Provider Turn is running.",
        },
      },
    },
  };
}

function createInteraction(): ConversationInteraction {
  return {
    interactionId: "interaction-1",
    conversationId: "conv-1",
    graphScopeId: "scope-1",
    canonicalSequence: 1,
    kind: "provider-input",
    status: "pending",
    canSkip: true,
    questions: [{
      questionId: "mode",
      title: "Choose execution mode",
      inputMode: "single",
      allowCustom: true,
      options: [{ value: "safe", label: "Safe mode", description: "Use bounded execution" }],
    }],
  } as ConversationInteraction;
}

function timelinePage(agentSurfaceId: string, productMode: "agent" | "harness" = "harness", conversationId = "conv-1"): CanonicalTimelinePage {
  const text = agentSurfaceId === "main-agent" ? "Canonical Main reply" : "Canonical child reply";
  return {
    projectId: "repo",
    productMode,
    conversationId,
    agentSurfaceId,
    watermark: 1,
    pinned: [],
    entries: [{
      projectId: "repo",
      productMode,
      conversationId,
      agentSurfaceId,
      messageId: `message:${agentSurfaceId}`,
      position: 1,
      revision: 1,
      orderClass: "sequence",
      cells: [{
        id: `cell:${agentSurfaceId}`,
        kind: "assistant-message",
        source: "provider-runtime",
        timestamp: "2026-07-17T00:00:00.000Z",
        text,
      }],
    }],
    paging: { limit: 100, totalCount: 1, hasMoreBefore: false },
  };
}

function installApiFixture(snapshot: Snapshot, options: {
  loadSnapshot?: (projectId: string, productMode: "agent" | "harness", conversationId: string | null) => Snapshot | Promise<Snapshot>;
  projectManaged?: boolean;
} = {}): void {
  const productMode = snapshot.center.selectedTopic?.productMode ?? "harness";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const requestedProductMode = parsed.searchParams.get("productMode") === "agent" ? "agent" : parsed.searchParams.get("productMode") === "harness" ? "harness" : productMode;
    if (url === "/agent-office/config/office-calibration.json") return json(officeCalibration);
    if (url === "/api/app/status") return json({ mode: "project", directProjectId: "repo" });
    if (url === "/api/projects") {
      const projectManaged = options.projectManaged ?? true;
      return json({ projects: [{
        project: snapshot.project,
        path: snapshot.project?.path,
        pathExists: true,
        isGitRepo: true,
        managed: projectManaged,
        harness: {
          projectPath: snapshot.project?.path ?? "E:/repo",
          managed: projectManaged,
          readiness: projectManaged ? "ready" : "missing",
          activeChanges: [],
          pendingEvolution: false,
          components: [],
        },
      }] });
    }
    if (url.includes("/workbench/snapshot")) {
      const next = options.loadSnapshot
        ? await options.loadSnapshot("repo", requestedProductMode, parsed.searchParams.get("topic"))
        : snapshot;
      return json(next);
    }
    if (url.includes("/workbench/mode-activity")) return json({
      projectId: "repo",
      generatedAt: "2026-08-23T00:00:00.000Z",
      agent: { productMode: "agent", state: "running", updatedAt: "2026-08-23T00:00:00.000Z" },
      harness: { productMode: "harness", state: "attention", updatedAt: "2026-08-23T00:00:00.000Z" },
    });
    if (url.includes("/workbench/composer-draft")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({
          draft: {
            ...body,
            attachments: [],
            updatedAt: "2026-08-21T00:00:00.000Z",
            diagnostics: [],
          },
        });
      }
      if (init?.method === "DELETE") return json({ deleted: true });
      return json({ draft: null });
    }
    if (url.includes("/workbench/projections/agent-surfaces/")) return json({
      projectId: "repo",
      productMode: requestedProductMode,
      conversationId: decodeURIComponent(url.match(/agent-surfaces\/([^?]+)/)?.[1] ?? "conv-1"),
      graphScopeId: "scope-1",
      scopeStatus: "active",
      projectionHash: "surface-hash-1",
      diagnostics: [],
      surfaces: [
        {
          agentSurfaceId: "main-agent",
          kind: "main-agent",
          roleId: "main-agent",
          roleDisplayName: "Main Agent",
          label: "Main Agent",
          description: "Coordinates the current conversation.",
          skills: [],
          parentAgentSurfaceId: null,
          graphScopeId: "scope-1",
          scopeRange: "current",
          status: "running",
          readOnly: false,
          createdAt: "2026-07-17T00:00:00.000Z",
        },
        {
          agentSurfaceId: "agent:codex:thread:child-1",
          kind: "agent",
          roleId: "planning-agent",
          roleDisplayName: "Planning Agent",
          label: "Plan Agent",
          description: "Produces the implementation plan.",
          skills: ["planning"],
          parentAgentSurfaceId: "main-agent",
          graphScopeId: "scope-1",
          scopeRange: "current",
          status: "running",
          readOnly: false,
          createdAt: "2026-07-17T00:00:01.000Z",
        },
      ],
    });
    if (url.includes("/workbench/conversations/") && url.includes("/timeline?")) {
      const conversationId = decodeURIComponent(url.match(/conversations\/([^/]+)\/timeline/)?.[1] ?? "conv-1");
      return json(timelinePage(parsed.searchParams.get("agentSurfaceId") ?? "main-agent", requestedProductMode, conversationId));
    }
    if (url.includes("/providers/capabilities?")) {
      return json({ providers: [{
        providerId: "codex",
        displayName: "Codex",
        productMode: requestedProductMode,
        status: "ready",
        runnable: true,
        checkedAt: "2026-08-13T00:00:00.000Z",
        snapshotHash: `codex-${requestedProductMode}`,
        snapshotVersion: 1,
        effectiveModel: null,
        effectiveModelSource: "provider-default",
        degradedReasons: [],
        capabilities: [],
      }] });
    }
    if (url.endsWith("/providers/codex/diagnostics")) return json({ providerId: "codex", displayName: "Codex", models: {} });
    if (url.endsWith("/providers/codex/models")) return json({
      providerId: "codex",
      selectedModel: null,
      effectiveModel: { providerId: "codex", modelId: "gpt-test" },
      effectiveModelSource: "provider-default",
      candidates: [{
        providerId: "codex",
        modelId: "gpt-test",
        label: "GPT Test",
        source: "runtime",
        supportedReasoningEfforts: [{ value: "medium", label: "中" }],
        defaultReasoningEffort: "medium",
      }],
      available: true,
    });
    if (url.endsWith("/providers/codex/model-settings")) return json({ providerId: "codex" });
    if (url.endsWith("/skills")) return json({ skills: [] });
    if (url.endsWith("/removal-confirmation")) return json({
      token: "remove-token-repo",
      projectId: "repo",
      projectName: "Repo",
      expiresAt: "2026-08-03T12:00:00.000Z",
    });
    if (url.endsWith("/remove")) return json({ removal: { projectId: "repo" } });
    if (url.includes("/workbench/topics/conv-1/messages/live")) return sse();
    if (url.endsWith("/workbench/topics/live")) return sse({
      event: "topic.created",
      data: {
        projectId: "repo",
        productMode,
        conversationId: "conv-agent-new",
        clientRequestId: requestBody(vi.mocked(fetch).mock.calls.at(-1))?.clientRequestId,
        replayed: false,
        topic: {
          id: "conv-agent-new",
          conversationId: "conv-agent-new",
          productMode,
          title: "Start an Agent conversation",
          state: "active",
          kind: "conversation",
          selectedProviderId: "codex",
        },
      },
    });
    return json({});
  }));
}

function requestUrls(fragment: string): string[] {
  return vi.mocked(fetch).mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes(fragment));
}

function requestCall(fragment: string, method?: string): [RequestInfo | URL, RequestInit?] | undefined {
  return vi.mocked(fetch).mock.calls.find(([input, init]) => (
    String(input).includes(fragment) && (!method || init?.method === method)
  ));
}

function requestBody(call: [RequestInfo | URL, RequestInit?] | undefined): Record<string, unknown> | undefined {
  const body = call?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : undefined;
}

function sse(event?: unknown): Response {
  const payload = event ? `event: ${(event as { event: string }).event}\ndata: ${JSON.stringify((event as { data: unknown }).data)}\n\n` : "";
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function installMatchMedia(matches: boolean): { setMatches: (next: boolean) => void } {
  let currentMatches = matches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    get matches() { return currentMatches; },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: vi.fn(() => true),
  })));
  return {
    setMatches(next: boolean): void {
      currentMatches = next;
      const event = { matches: next, media: MOBILE_SIDEBAR_TEST_MEDIA_QUERY } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

const MOBILE_SIDEBAR_TEST_MEDIA_QUERY = "(max-width: 720px)";
