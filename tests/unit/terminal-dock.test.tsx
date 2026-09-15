// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalDock } from "../../src/web/src/panels/workbench/TerminalDock.js";

const postJson = vi.fn();

vi.mock("../../src/web/src/api.js", () => ({
  postJson: (...args: unknown[]) => postJson(...args),
}));

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

class FakeEventSource {
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => {
  cleanup();
  postJson.mockReset();
  vi.unstubAllGlobals();
});

describe("TerminalDock supporting experience", () => {
  it("keeps tab selection and close as sibling controls", async () => {
    postJson.mockResolvedValue({ session: { projectId: "repo", terminalId: "terminal-1", cwd: ".", shell: "pwsh" } });
    vi.stubGlobal("EventSource", FakeEventSource);
    renderDock();

    const tab = screen.getByRole("tab", { name: "Terminal 1" });
    const item = tab.closest(".terminal-tab-item");
    expect(item).toBeTruthy();
    expect(tab.querySelector("button")).toBeNull();
    expect(within(item as HTMLElement).getByRole("button", { name: "关闭 Terminal 1" })).toBeTruthy();
    await waitFor(() => expect(postJson).toHaveBeenCalled());
  });

  it("retries a failed terminal connection in the same tab", async () => {
    let openAttempts = 0;
    postJson.mockImplementation((url: string) => {
      if (!url.endsWith("/terminal/sessions")) return Promise.resolve({});
      openAttempts += 1;
      return openAttempts === 1
        ? Promise.reject(new TypeError("network unavailable"))
        : Promise.resolve({ session: { projectId: "repo", terminalId: "terminal-1", cwd: ".", shell: "pwsh" } });
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    renderDock();

    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(openAttempts).toBe(2));
    expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-selected")).toBe("true");
  });
});

function renderDock(): void {
  render(<TerminalDock
    projectId="repo"
    open
    height={320}
    tabs={[{ id: "terminal-1", title: "Terminal 1" }]}
    activeTabId="terminal-1"
    onOpen={vi.fn()}
    onCollapse={vi.fn()}
    onHeightChange={vi.fn()}
    onNewTab={vi.fn()}
    onSelectTab={vi.fn()}
    onCloseTab={vi.fn()}
  />);
}
