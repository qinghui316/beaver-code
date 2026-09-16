import { describe, expect, it } from "vitest";
import {
  productModeControlLabel,
  productModeControlTitle,
  productModeExperience,
  WORKSPACE_TOOLS,
} from "../../src/web/src/presentation/core-workbench-experience.js";

describe("core Workbench experience projection", () => {
  it("uses stable task language for both product modes", () => {
    expect(productModeExperience("agent")).toMatchObject({
      title: "直接和 Agent 一起开发",
      description: "适合快速修改、调试和连续对话。",
    });
    expect(productModeExperience("harness")).toMatchObject({
      title: "让多个 Agent 按流程协作",
      description: "先规划，再开发、测试和审查；关键步骤由你确认。",
    });
  });

  it("keeps inactive activity bounded and mode specific", () => {
    expect(productModeControlLabel("agent", false, "running")).toBe("Agent，正在执行");
    expect(productModeControlLabel("harness", false, "attention")).toBe("AHO，需要你处理");
    expect(productModeControlTitle("harness", true, "failed")).toBe(
      "AHO · 让多个 Agent 按流程协作。先规划，再开发、测试和审查；关键步骤由你确认。",
    );
  });

  it("provides one shared vocabulary for workspace tools", () => {
    expect(WORKSPACE_TOOLS.office.label).toBe("Agent Office");
    expect(WORKSPACE_TOOLS.terminal.openLabel).toBe("打开 Terminal");
    expect(WORKSPACE_TOOLS.tools.closeLabel).toBe("关闭工具");
  });
});
