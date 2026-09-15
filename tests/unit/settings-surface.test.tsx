// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSurface } from "../../src/web/src/panels/SettingsSurface.js";
import type { ProviderCapabilitySnapshot } from "../../src/web/src/types.js";

afterEach(cleanup);

describe("SettingsSurface clarity", () => {
  it("normalizes legacy sections into the two user-facing destinations", () => {
    render(<SettingsSurface section="basic" onSectionChange={vi.fn()} project={null} productMode="agent" conversationId={null} selectedProviderId="codex" diagnostics={null} modelSettings={null} providerCapabilities={[]} onClose={vi.fn()} onRefresh={vi.fn()} />);
    const navigation = screen.getByRole("navigation");
    expect(navigation.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "模型与服务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "技能" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "基础" })).toBeNull();
    expect(screen.queryByRole("button", { name: "项目" })).toBeNull();
    expect(screen.getAllByText("设置")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "模型与服务" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("工作台设置")).toBeNull();
    expect(screen.queryByRole("button", { name: "选择默认模型" })).toBeNull();
  });

  it("keeps capability keys inside diagnostics and contains keyboard focus", async () => {
    const view = render(<SettingsSurface section="provider" onSectionChange={vi.fn()} project={null} productMode="agent" conversationId={null} selectedProviderId="codex" diagnostics={null} modelSettings={null} providerCapabilities={[snapshot("ready")]} onClose={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "查看诊断" })).toBeNull();
    expect(screen.queryByText("turn.review")).toBeNull();

    view.rerender(<SettingsSurface section="provider" onSectionChange={vi.fn()} project={null} productMode="agent" conversationId={null} selectedProviderId="codex" diagnostics={null} modelSettings={null} providerCapabilities={[snapshot("degraded")]} onClose={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查看诊断" }));
    const dialog = screen.getByRole("dialog", { name: "服务诊断" });
    const close = screen.getByRole("button", { name: "关闭服务诊断" });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(close));
    const technicalDetails = screen.getByText("查看技术信息").closest("details");
    expect(technicalDetails?.hasAttribute("open")).toBe(false);
    fireEvent.click(screen.getByText("查看技术信息"));
    expect(technicalDetails?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("turn.review")).toBeTruthy();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });
});

function snapshot(status: ProviderCapabilitySnapshot["status"]): ProviderCapabilitySnapshot {
  return {
    providerId: "codex",
    displayName: "Codex",
    productMode: "agent",
    status,
    runnable: true,
    checkedAt: "2026-09-04T00:00:00.000Z",
    snapshotHash: `snapshot-${status}`,
    snapshotVersion: 1,
    effectiveModel: "gpt-test",
    effectiveModelSource: "provider-default",
    degradedReasons: status === "degraded" ? ["Review unavailable"] : [],
    capabilities: [{ key: "turn.review", label: "Code Review", spec: "supported", runtime: status === "ready" ? "ready" : "degraded", summary: "Review support" }],
  };
}
