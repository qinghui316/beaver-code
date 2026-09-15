import { describe, expect, it } from "vitest";
import { gitFileStatusPresentation } from "../../src/web/src/panels/workbench/ProjectGitPanel.js";
import type { ProjectGitFileStatus } from "../../src/web/src/types.js";

describe("Git file status presentation", () => {
  it.each([
    ["?", "?", "未跟踪"],
    ["A", "A", "已添加"],
    ["D", "D", "已删除"],
    ["R", "R", "已重命名"],
    ["T", "T", "类型已更改"],
    ["M", "U", "已修改"],
  ])("maps Git state %s to symbol %s and the %s label", (gitState, symbol, label) => {
    const file: ProjectGitFileStatus = {
      relativePath: "src/example.ts",
      name: "example.ts",
      group: gitState === "?" ? "untracked" : "unstaged",
      indexStatus: " ",
      worktreeStatus: gitState,
      statusLabel: gitState,
    };
    expect(gitFileStatusPresentation(file)).toMatchObject({ symbol, label });
  });
});
