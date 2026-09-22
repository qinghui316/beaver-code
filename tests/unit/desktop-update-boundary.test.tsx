// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdateBoundary } from "../../src/web/src/shell/DesktopUpdateBoundary.js";
import { DesktopUpdateDock } from "../../src/web/src/shell/DesktopUpdateDock.js";
import { rendererUpdateParticipants } from "../../src/web/src/controllers/RendererUpdateParticipants.js";

let unregister: (() => void) | undefined;
class FakeEvents extends EventTarget {
  static current: FakeEvents | null = null;
  onerror: (() => void) | null = null;
  constructor() { super(); FakeEvents.current = this; }
  close() {}
}
beforeEach(() => {
  FakeEvents.current = null;
  vi.stubGlobal("EventSource", FakeEvents);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url === "/api/app/status" ? { desktopUpdates: true } : { accepted: true },
  ), { status: 200 })));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
});
afterEach(() => { unregister?.(); cleanup(); vi.unstubAllGlobals(); });
async function send(action: "prepare" | "confirm" | "cancel") {
  await act(async () => {
    FakeEvents.current!.dispatchEvent(new MessageEvent("update", { data: JSON.stringify({
      requestId: "request-" + action, connectionId: "connection",
      action, identity: { updateId: "update" },
    }) }));
  });
}
describe("desktop update save boundary", () => {
  it("does not expose desktop update presentation in the pure Web runtime", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ desktopUpdates: false }), { status: 200 })));
    render(<DesktopUpdateBoundary><DesktopUpdateDock /></DesktopUpdateBoundary>);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/app/status"));
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("auto-opens each offer once without stealing focus and light-dismiss keeps the update available", async () => {
    const { container } = render(<DesktopUpdateBoundary><DesktopUpdateDock /><input aria-label="草稿" /></DesktopUpdateBoundary>);
    await waitFor(() => expect(FakeEvents.current).not.toBeNull());
    const draft = screen.getByLabelText("草稿");
    draft.focus();
    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
      offerId: "offer", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
    }) })));
    expect(container.firstElementChild?.hasAttribute("inert")).toBe(false);
    expect(screen.getByText("Beaver Code 0.1.3 已准备好")).toBeTruthy();
    expect(document.activeElement).toBe(draft);
    fireEvent.pointerDown(draft);
    await waitFor(() => expect(screen.queryByText("Beaver Code 0.1.3 已准备好")).toBeNull());
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/desktop/update/choice")).toBe(false);

    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
      offerId: "offer", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
    }) })));
    expect(screen.queryByText("Beaver Code 0.1.3 已准备好")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(screen.getByText("Beaver Code 0.1.3 已准备好")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Beaver Code 0.1.3 已准备好")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更新" }));

    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
      offerId: "offer-next", version: "0.1.4", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.4",
    }) })));
    expect(screen.getByText("Beaver Code 0.1.4 已准备好")).toBeTruthy();
  });

  it.each([["desktop", false], ["mobile after resize", true]] as const)(
    "keeps the visible %s dock's install click after pointerdown with both hosts mounted", async (_host, startNarrow) => {
      let narrow = false;
      const media = new EventTarget();
      Object.defineProperty(media, "matches", { get: () => narrow });
      vi.stubGlobal("matchMedia", () => media as MediaQueryList);
      render(<DesktopUpdateBoundary>
        <DesktopUpdateDock displayWhen="desktop" />
        <DesktopUpdateDock displayWhen="mobile" />
      </DesktopUpdateBoundary>);
      await waitFor(() => expect(FakeEvents.current).not.toBeNull());
      act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
        offerId: "offer", version: "0.1.16", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.16",
      }) })));
      if (startNarrow) {
        narrow = true;
        act(() => media.dispatchEvent(new Event("change")));
      }
      const install = screen.getByRole("button", { name: "重新启动并更新" });
      fireEvent.pointerDown(install);
      expect(screen.getByRole("button", { name: "重新启动并更新" })).toBe(install);
      fireEvent.click(install);
      await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/desktop/update/choice")).toHaveLength(1));
      expect(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/desktop/update/choice")?.[1]?.body))
        .toContain('"action":"install"');
    },
  );

  it("removes a withdrawn offer and all of its transient presentation state", async () => {
    render(<DesktopUpdateBoundary><DesktopUpdateDock /></DesktopUpdateBoundary>);
    await waitFor(() => expect(FakeEvents.current).not.toBeNull());
    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
      offerId: "offer", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
    }) })));
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: "null" })));
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
    expect(screen.queryByText("Beaver Code 0.1.3 已准备好")).toBeNull();
  });

  it.each([200, 503])("keeps a newer offer when an older delayed choice settles with %s", async (choiceStatus) => {
    let settleChoice: ((response: Response) => void) | undefined;
    const pendingChoice = new Promise<Response>((resolve) => { settleChoice = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/app/status") return new Response(JSON.stringify({ desktopUpdates: true }), { status: 200 });
      if (url === "/api/desktop/update/choice") return pendingChoice;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }));
    render(<DesktopUpdateBoundary><DesktopUpdateDock /></DesktopUpdateBoundary>);
    await waitFor(() => expect(FakeEvents.current).not.toBeNull());
    const original = {
      offerId: "offer", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
    };
    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify(original) })));
    fireEvent.click(screen.getByRole("button", { name: "重新启动并更新" }));
    expect((screen.getByRole("button", { name: "正在准备…" }) as HTMLButtonElement).disabled).toBe(true);

    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify(original) })));
    expect((screen.getByRole("button", { name: "正在准备…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/desktop/update/choice")).toHaveLength(1);

    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
      offerId: "offer-next", version: "0.1.4", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.4",
    }) })));
    expect(screen.getByText("Beaver Code 0.1.4 已准备好")).toBeTruthy();
    expect((screen.getByRole("button", { name: "重新启动并更新" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { settleChoice?.(new Response(JSON.stringify({ accepted: choiceStatus === 200 }), { status: choiceStatus })); });
    expect(screen.getByText("Beaver Code 0.1.4 已准备好")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("submits only an explicit install choice and keeps a failed choice recoverable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/app/status") return new Response(JSON.stringify({ desktopUpdates: true }), { status: 200 });
      if (url === "/api/desktop/update/choice") return new Response(JSON.stringify({ accepted: false }), { status: 503 });
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }));
    render(<DesktopUpdateBoundary><DesktopUpdateDock /></DesktopUpdateBoundary>);
    await waitFor(() => expect(FakeEvents.current).not.toBeNull());
    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
      offerId: "offer", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
    }) })));
    fireEvent.click(screen.getByRole("button", { name: "重新启动并更新" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("更新暂未开始"));
    expect((screen.getByRole("button", { name: "重新启动并更新" }) as HTMLButtonElement).disabled).toBe(false);
    const choices = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/desktop/update/choice");
    expect(choices).toHaveLength(1);
    expect(String(choices[0]?.[1]?.body)).toContain('"action":"install"');
    expect(String(choices[0]?.[1]?.body)).not.toContain('"action":"later"');
  });

  it("freezes the surface until save acknowledgement and restores it on cancel", async () => {
    unregister = rendererUpdateParticipants.register(async () => () => true);
    const { container } = render(<DesktopUpdateBoundary><DesktopUpdateDock /><input aria-label="草稿" defaultValue="待保存内容" /></DesktopUpdateBoundary>);
    await waitFor(() => expect(FakeEvents.current).not.toBeNull());
    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("offer", { data: JSON.stringify({
      offerId: "offer", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
    }) })));
    expect(screen.getByText("Beaver Code 0.1.3 已准备好")).toBeTruthy();
    act(() => FakeEvents.current!.dispatchEvent(new MessageEvent("connected", { data: JSON.stringify({ connectionId: "connection" }) })));
    await send("prepare");
    expect(container.firstElementChild?.hasAttribute("inert")).toBe(true);
    expect(screen.queryByText("Beaver Code 0.1.3 已准备好")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("正在保存并更新");
    await send("confirm");
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => String(init?.body).includes('"ok":true'))).toBe(true);
    await send("cancel");
    expect(container.firstElementChild?.hasAttribute("inert")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("草稿") as HTMLInputElement).value).toBe("待保存内容");
  });
});
