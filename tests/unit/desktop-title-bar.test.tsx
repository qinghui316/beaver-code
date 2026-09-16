// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopTitleBar } from "../../src/web/src/shell/DesktopTitleBar.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/app/status") return new Response(JSON.stringify({
      mode: "app",
      directProjectId: null,
      desktopShell: { available: true, menus: ["file", "edit", "view", "help"] },
    }), { status: 200 });
    if (url === "/api/desktop/menu/open" && init?.method === "POST") {
      return new Response(JSON.stringify({ opened: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DesktopTitleBar", () => {
  it("renders the four desktop menus and sends only the selected bounded request", async () => {
    render(<DesktopTitleBar onError={vi.fn()} />);
    const file = await screen.findByRole("menuitem", { name: "文件" });
    fireEvent.click(file);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/desktop/menu/open",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"menuId":"file"') }),
    ));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["文件", "编辑", "视图", "帮助"]);
  });

  it("supports menu-bar arrows and Alt access keys", async () => {
    render(<DesktopTitleBar onError={vi.fn()} />);
    const file = await screen.findByRole("menuitem", { name: "文件" });
    const edit = screen.getByRole("menuitem", { name: "编辑" });
    file.focus();
    fireEvent.keyDown(file, { key: "ArrowRight" });
    expect(document.activeElement).toBe(edit);
    fireEvent.keyDown(window, { key: "v", altKey: true });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => String(init?.body).includes('"menuId":"view"'))).toBe(true));
  });

  it("renders nothing when the desktop capability is absent", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ mode: "app", directProjectId: null }), { status: 200 }));
    const { container } = render(<DesktopTitleBar onError={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
