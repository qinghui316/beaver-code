// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComposerControls } from "../../src/web/src/shell/ComposerControls.js";

afterEach(cleanup);

describe("Composer controls", () => {
  it("renders a compact read-only provider and model identity", () => {
    render(<ComposerControls providerDisplayName="Claude Code" modelLabel="claude-sonnet" />);
    expect(screen.getByLabelText("当前运行配置：Claude Code · claude-sonnet")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
