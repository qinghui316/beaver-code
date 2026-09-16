// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectAddForm, ProjectCreateForm } from "../../src/web/src/panels/ProjectPanels.js";
import { DialogSurface } from "../../src/web/src/presentation/DialogSurface.js";
import { ComposerAttachButton } from "../../src/web/src/shell/ComposerAttachments.js";
import { UnmanagedProjectView } from "../../src/web/src/shell/sidebar.js";
import type { ProjectStatus } from "../../src/web/src/types.js";

afterEach(cleanup);

describe("product language and recovery clarity", () => {
  it("recaptures focus when the currently focused dialog action becomes unavailable", async () => {
    function Harness() {
      const [busy, setBusy] = useState(false);
      return <DialogSurface open onClose={vi.fn()} ariaLabel="测试弹窗">
        <button type="button">关闭</button>
        <button type="button" disabled={busy} onClick={() => setBusy(true)}>执行</button>
      </DialogSurface>;
    }
    render(<Harness />);
    const action = screen.getByRole("button", { name: "执行" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" })));
    action.focus();
    fireEvent.click(action);
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(action, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
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

  it("keeps project recovery failures adjacent and handled", async () => {
    const retry = vi.fn(async () => { throw new TypeError("network unavailable"); });
    render(<UnmanagedProjectView project={unavailableProject()} onRetry={retry} onOpenDiagnostics={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("暂时无法连接到本地服务。"));
    expect((screen.getByRole("button", { name: "重新检测" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("settles synchronous project recovery failures through the same recovery state", async () => {
    const retry = vi.fn(() => { throw new TypeError("network unavailable"); });
    render(<UnmanagedProjectView project={unavailableProject()} onRetry={retry} onOpenDiagnostics={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("暂时无法连接到本地服务。"));
    expect((screen.getByRole("button", { name: "重新检测" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not settle an older project retry into the current project", async () => {
    const firstRetry = deferred<void>();
    const view = render(<UnmanagedProjectView project={unavailableProject("repo-a")} onRetry={() => firstRetry.promise} onOpenDiagnostics={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect((screen.getByRole("button", { name: "正在检测…" }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<UnmanagedProjectView project={unavailableProject("repo-b")} onRetry={vi.fn(async () => undefined)} onOpenDiagnostics={vi.fn()} />);
    expect((screen.getByRole("button", { name: "重新检测" }) as HTMLButtonElement).disabled).toBe(false);
    firstRetry.reject(new TypeError("stale network failure"));
    await Promise.resolve();

    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "重新检测" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

function unavailableProject(id = "repo"): ProjectStatus {
  return {
    project: { id, name: `Demo ${id}`, path: `C:/demo/${id}` },
    path: `C:/demo/${id}`,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
