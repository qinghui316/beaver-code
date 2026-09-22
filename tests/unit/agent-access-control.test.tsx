// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAccessControl } from "../../src/web/src/shell/AgentAccessControl.js";
import type { ConversationAccessView } from "../../src/web/src/controllers/conversation-access-contract.js";

afterEach(cleanup);
const view: ConversationAccessView = { scopeKey: "conversation-a", visible: true, mode: "default", busy: false, failure: null, fullAccessAvailable: true };

describe("Agent access controls", () => {
  it("dismisses confirmation when its conversation identity changes", async () => {
    const select = vi.fn(async () => undefined);
    const rendered = render(<AgentAccessControl accessView={view} onSelectAccess={select} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "访问权限：默认权限" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "完全访问" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    rendered.rerender(<AgentAccessControl accessView={{ ...view, scopeKey: "conversation-b" }} onSelectAccess={select} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
  it("requires a separate confirmation before requesting full access", async () => {
    const select = vi.fn(async () => undefined);
    render(<AgentAccessControl accessView={view} onSelectAccess={select} />);
    const trigger = screen.getByRole("button", { name: "访问权限：默认权限" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "完全访问" })).toBeTruthy());
    fireEvent.click(screen.getByRole("menuitem", { name: "完全访问" }));
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "允许完全访问" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "允许完全访问" }));
    await waitFor(() => expect(select).toHaveBeenCalledWith("full-access", true));
  });

  it("shows the confirmed permission without depending on turn mode", () => {
    render(<AgentAccessControl accessView={{ ...view, mode: "full-access" }} />);
    expect(screen.getByRole("button", { name: "访问权限：完全访问" })).toBeTruthy();
    expect(screen.queryByText("计划中仅分析")).toBeNull();
  });

  it("does not render for AHO and exposes a local recovery action", () => {
    const retry = vi.fn(async () => undefined);
    const rendered = render(<AgentAccessControl accessView={{ ...view, visible: false }} />);
    expect(rendered.container.textContent).toBe("");
    rendered.rerender(<AgentAccessControl accessView={{ ...view, failure: "需要重新检测" }} onRefreshAccess={retry} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "访问权限：默认权限" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "重新检测" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
