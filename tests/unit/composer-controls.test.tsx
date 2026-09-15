// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerControls } from "../../src/web/src/shell/ComposerControls.js";

afterEach(cleanup);

describe("Composer controls", () => {
  it("renders the provider descriptor without a built-in provider label", () => {
    render(<ComposerControls providerDisplayName="Claude Code" modelLabel="claude-sonnet" />);
    expect(screen.getByRole("button", { name: "模型与推理设置，当前模型：claude-sonnet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "模型与推理设置，当前模型：claude-sonnet" }));
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("keeps multi-provider selection empty until the user chooses", () => {
    render(<ComposerControls
      modelLabel="默认模型"
      providerOptions={[{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }]}
    />);
    fireEvent.click(screen.getByRole("button", { name: "模型与推理设置，当前模型：默认模型" }));
    const select = screen.getByLabelText("选择 AI 服务") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "选择 AI 服务" })).toBeTruthy();
  });

  it("does not render optional controls without their capabilities", () => {
    render(<ComposerControls providerDisplayName="Codex" modelLabel="default" />);
    fireEvent.click(screen.getByRole("button", { name: "模型与推理设置，当前模型：default" }));
    expect(screen.queryByLabelText("选择 AI 服务")).toBeNull();
    expect(screen.queryByRole("button", { name: "模型与服务设置" })).toBeNull();
  });

  it("uses a mode-appropriate description without implying an AHO turn override", () => {
    const onOpenModelSettings = () => undefined;
    render(<ComposerControls
      providerDisplayName="Codex"
      modelLabel="gpt-5.6-sol"
      requestDescription="查看当前 AHO 服务配置"
      readOnly
      onOpenModelSettings={onOpenModelSettings}
      providerOptions={[{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude Code" }]}
    />);
    fireEvent.click(screen.getByRole("button", { name: "当前 AHO 模型配置：gpt-5.6-sol" }));
    expect(screen.getByRole("dialog", { name: "当前 AHO 配置" })).toBeTruthy();
    expect(screen.getByText("当前 AHO 配置")).toBeTruthy();
    expect(screen.getByText("查看当前 AHO 服务配置")).toBeTruthy();
    expect(screen.queryByText("设置下一次 Agent 请求")).toBeNull();
    expect(screen.queryByLabelText("选择 AI 服务")).toBeNull();
    expect(screen.queryByRole("button", { name: "模型与服务设置" })).toBeNull();
  });
});
