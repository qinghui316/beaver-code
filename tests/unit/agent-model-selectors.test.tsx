// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentModelSelectors } from "../../src/web/src/shell/AgentModelSelectors.js";
import type { ProviderModelCatalogGroup } from "../../src/web/src/types.js";

afterEach(cleanup);

describe("Agent model selectors", () => {
  it("groups models by service and selects provider and model together", () => {
    const onSelect = vi.fn();
    render(<AgentModelSelectors
      catalogs={catalogs()}
      selectedProviderId="codex"
      modelId="gpt-test"
      reasoningEffort="high"
      onSelectProviderModel={onSelect}
      onSelectReasoningEffort={vi.fn()}
    />);

    fireEvent.keyDown(screen.getByRole("button", { name: "模型：GPT Test" }), { key: "Enter" });
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /GPT Test/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByText("Claude Sonnet"));
    expect(onSelect).toHaveBeenCalledWith("claude", "claude-sonnet");
  });

  it("shows only the selected model's supported reasoning efforts and restores focus on Escape", async () => {
    render(<AgentModelSelectors
      catalogs={catalogs()}
      selectedProviderId="codex"
      modelId="gpt-test"
      reasoningEffort={null}
      onSelectProviderModel={vi.fn()}
      onSelectReasoningEffort={vi.fn()}
    />);
    const trigger = screen.getByRole("button", { name: "思考强度：模型默认值" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getAllByText("模型默认值")).toHaveLength(2);
    expect(screen.getByText("高")).toBeTruthy();
    expect(screen.queryByText("标准")).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps one provider failure local and exposes refresh in the menu", () => {
    const refresh = vi.fn();
    const groups = catalogs();
    groups[1] = { ...groups[1]!, status: "error", snapshot: null, message: "Claude 模型目录不可用" };
    render(<AgentModelSelectors
      catalogs={groups}
      selectedProviderId="codex"
      modelId="gpt-test"
      reasoningEffort={null}
      onRefresh={refresh}
      onSelectProviderModel={vi.fn()}
      onSelectReasoningEffort={vi.fn()}
    />);
    fireEvent.keyDown(screen.getByRole("button", { name: "模型：GPT Test" }), { key: "Enter" });
    expect(screen.getByText("Claude 模型目录不可用")).toBeTruthy();
    fireEvent.click(screen.getByText("重新检测模型"));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

function catalogs(): ProviderModelCatalogGroup[] {
  return [
    {
      providerId: "codex", displayName: "Codex", status: "ready",
      snapshot: {
        providerId: "codex", selectedModel: null, effectiveModel: { providerId: "codex", modelId: "gpt-test" },
        effectiveModelSource: "provider-default", available: true,
        candidates: [{ providerId: "codex", modelId: "gpt-test", label: "GPT Test", source: "runtime",
          supportedReasoningEfforts: [{ value: "high", label: "高" }], defaultReasoningEffort: "high" }],
      },
    },
    {
      providerId: "claude", displayName: "Claude Code", status: "ready",
      snapshot: {
        providerId: "claude", selectedModel: null, effectiveModel: { providerId: "claude", modelId: "claude-sonnet" },
        effectiveModelSource: "provider-default", available: true,
        candidates: [{ providerId: "claude", modelId: "claude-sonnet", label: "Claude Sonnet", source: "runtime",
          supportedReasoningEfforts: [{ value: "standard", label: "标准" }], defaultReasoningEffort: "standard" }],
      },
    },
  ];
}
