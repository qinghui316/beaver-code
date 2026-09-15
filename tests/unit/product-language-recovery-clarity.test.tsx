// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderModelPicker } from "../../src/web/src/panels/ProjectHome.js";
import { ProjectAddForm, ProjectCreateForm } from "../../src/web/src/panels/ProjectPanels.js";
import { ComposerAttachButton } from "../../src/web/src/shell/ComposerAttachments.js";
import { UnmanagedProjectView } from "../../src/web/src/shell/sidebar.js";
import type { ProjectStatus, ProviderModelSettingsSnapshot } from "../../src/web/src/types.js";

afterEach(cleanup);

describe("product language and recovery clarity", () => {
  it("contains model-dialog focus, closes with Escape, and restores the trigger", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开模型</button>
        <ProviderModelPicker
          open={open}
          snapshot={modelSnapshot()}
          onClose={() => setOpen(false)}
          onRefresh={vi.fn()}
          onSelect={vi.fn()}
        />
      </>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开模型" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "选择 Agent 模型" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const close = screen.getByRole("button", { name: "关闭模型选择" });
    await waitFor(() => expect(document.activeElement).toBe(close));

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "选择" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "选择 Agent 模型" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(trigger);
    const overlay = screen.getByRole("dialog", { name: "选择 Agent 模型" }).parentElement!;
    fireEvent.mouseDown(overlay);
    expect(screen.queryByRole("dialog", { name: "选择 Agent 模型" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("shows model loading failures without also showing the empty state", () => {
    render(<ProviderModelPicker open snapshot={null} message="模型配置暂时无法读取。" onClose={vi.fn()} onRefresh={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("模型列表暂时无法加载。")).toBeTruthy();
    expect(screen.queryByText("没有读取到模型列表")).toBeNull();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeTruthy();
  });

  it("provides persistent labels and one focusable attachment picker", () => {
    const view = render(<><ProjectAddForm onDone={vi.fn()} /><ProjectCreateForm onDone={vi.fn()} /><ComposerAttachButton /></>);
    expect(screen.getByRole("textbox", { name: "项目名称（可选）" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "保存位置" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "项目名称" })).toBeTruthy();
    const nativePicker = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(nativePicker?.tabIndex).toBe(-1);
    expect(nativePicker?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "添加附件" })).toBeTruthy();
  });

  it("puts project recovery actions next to the project failure", async () => {
    const retry = vi.fn(async () => undefined);
    const diagnostics = vi.fn();
    render(<UnmanagedProjectView project={unavailableProject()} onRetry={retry} onOpenDiagnostics={diagnostics} />);
    expect(screen.getByText("这个项目的协作配置无法读取。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开其他项目" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看诊断" }));
    expect(diagnostics).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(retry).toHaveBeenCalledOnce());
  });
});

function modelSnapshot(): ProviderModelSettingsSnapshot {
  return {
    providerId: "codex",
    selectedModel: null,
    effectiveModel: { providerId: "codex", modelId: "gpt-test" },
    effectiveModelSource: "provider-default",
    candidates: [{
      providerId: "codex",
      modelId: "gpt-test",
      label: "GPT Test",
      source: "runtime",
      isDefault: true,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
    }],
    available: true,
  };
}

function unavailableProject(): ProjectStatus {
  return {
    project: { id: "repo", name: "Demo", path: "C:/demo" },
    path: "C:/demo",
    pathExists: true,
    isGitRepo: true,
    managed: true,
    harness: {
      projectPath: "C:/demo",
      managed: true,
      readiness: "unavailable",
      activeChanges: [],
      pendingEvolution: false,
      components: [],
    },
    runtimeAvailability: {
      state: "unavailable",
      summary: "这个项目的协作配置无法读取。",
      recovery: "修复后重新检测。",
    },
  };
}
