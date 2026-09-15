import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Workbench shell layout contract", () => {
  it("passes the selected Conversation mode to child workspace resources", async () => {
    const [appSource, handoffSource] = await Promise.all([
      readFile("src/web/src/App.tsx", "utf8"),
      readFile("src/web/src/controllers/workspaceResourceModeHandoff.ts", "utf8"),
    ]);
    expect(appSource).toMatch(/useWorkspaceResourceController\(workspaceResourceModeHandoff\(\{ productMode: appMode\.productMode \}, \{/);
    expect(handoffSource).toMatch(/productMode: snapshot\.productMode/);
    expect(appSource).not.toMatch(/native-child-agent[\s\S]{0,160}productMode/);
    expect(appSource).not.toMatch(/Parameters<typeof useWorkspaceResourceController>/);
  });

  it("recalibrates Office from canonical projection on reconnect without using Timeline deltas", async () => {
    const source = await readFile("src/web/src/App.tsx", "utf8");
    expect(source).toMatch(/onConnected:[\s\S]*agentSurfaces\.invalidate\(\{ conversationId, reason: "snapshot" \}\)/);
    expect(source).toMatch(/timeline:\s*\{[\s\S]*patch:[\s\S]*timeline\.ingestEnvelope/);
    expect(source).not.toMatch(/timeline:\s*\{[\s\S]{0,240}patch:[\s\S]{0,240}agentSurfaces\.invalidate/);
  });
  it("uses two columns when closed and mounts the right rail only while open", async () => {
    const [app, shellCss, sidebarCss, workspaceCss] = await Promise.all([
      readFile("src/web/src/App.tsx", "utf8"),
      readFile("src/web/src/styles/surfaces/shell.css", "utf8"),
      readFile("src/web/src/styles/surfaces/sidebar.css", "utf8"),
      readFile("src/web/src/styles/surfaces/workspace.css", "utf8"),
    ]);
    expect(shellCss).toContain("grid-template-columns: var(--left-sidebar-width, 280px) minmax(0, 1fr);");
    expect(shellCss).toContain(".app-shell.right-rail-open");
    expect(shellCss).not.toContain("decision-pane-collapsed");
    expect(shellCss).not.toMatch(/minmax\(0, 1fr\) 48px/);
    expect(app).toContain('rightToolRailState.mode !== "closed" ? <RightToolRailShell');
    expect(app).not.toContain("BottomStatusBar");
    expect(sidebarCss).toContain("grid-template-rows: minmax(0, 1fr) auto;");
    const normalizedWorkspaceCss = workspaceCss.replace(/\r\n/g, "\n");
    expect(normalizedWorkspaceCss).toContain(".sidebar-resizer {\n  right: -9px;");
    expect(normalizedWorkspaceCss).toContain(".sidebar-resizer::after {\n  right: 8px;");
    expect(normalizedWorkspaceCss).toContain(".right-rail-resizer {\n  left: -9px;");
    expect(normalizedWorkspaceCss).toContain(".right-rail-resizer::after {\n  left: 8px;");
  });

  it("does not retain the retired collapsed rail or text sanitizer", async () => {
    const sources = await Promise.all([
      readFile("src/web/src/panels/workbench/DecisionPaneShell.tsx", "utf8"),
      readFile("src/web/src/formatters.ts", "utf8"),
    ]);
    expect(sources.join("\n")).not.toMatch(/approval-pane-collapsed|userFacingText/);
  });

  it("does not retain retired Workpad presentation selectors or empty Composer APIs", async () => {
    const sources = await Promise.all([
      readFile("src/web/src/App.tsx", "utf8"),
      readFile("src/web/src/shell/composer.tsx", "utf8"),
      readFile("src/web/src/styles/surfaces/workspace.css", "utf8"),
      readFile("src/web/src/styles/surfaces/conversation.css", "utf8"),
      readFile("src/web/src/styles/surfaces/composer.css", "utf8"),
      readFile("src/web/src/styles/surfaces/sidebar.css", "utf8"),
    ]);
    expect(sources.join("\n")).not.toMatch(/onNewWorkpad|workpad-route-switch|workpad-hero|workpad-section|task-queue-|coding-package-|workpad-scroll/);
  });

  it("anchors the mobile model popover to the Composer toolbar viewport", async () => {
    const composerCss = (await readFile("src/web/src/styles/surfaces/composer.css", "utf8")).replace(/\r\n/g, "\n");
    expect(composerCss).toMatch(/@media \(max-width: 680px\)[\s\S]*\.composer-model-control \{\n {4}position: static;\n {2}\}/);
    expect(composerCss).toMatch(/@media \(max-width: 680px\)[\s\S]*\.composer-model-popover \{\n {4}right: 0;\n {4}left: 0;\n {4}width: auto;\n {2}\}/);
  });

  it("keeps coarse-pointer controls touchable and supporting surfaces motion-safe", async () => {
    const [composerCss, settingsCss, sidebarCss, terminalCss, workspaceCss, decisionCss] = await Promise.all([
      readFile("src/web/src/styles/surfaces/composer.css", "utf8"),
      readFile("src/web/src/styles/surfaces/settings.css", "utf8"),
      readFile("src/web/src/styles/surfaces/sidebar.css", "utf8"),
      readFile("src/web/src/styles/surfaces/terminal.css", "utf8"),
      readFile("src/web/src/styles/surfaces/workspace.css", "utf8"),
      readFile("src/web/src/styles/surfaces/decision.css", "utf8"),
    ]);
    for (const css of [composerCss, settingsCss, sidebarCss, terminalCss, workspaceCss]) {
      expect(css).toContain("(pointer: coarse)");
      expect(css).toMatch(/min-(?:width|height): 44px/);
    }
    expect(settingsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(terminalCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(decisionCss).toContain("font-family: var(--font-sans)");
  });
});
