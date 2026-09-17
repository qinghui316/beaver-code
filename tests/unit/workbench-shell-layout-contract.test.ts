import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Workbench shell layout contract", () => {
  it("uses the native Windows title-bar overlay and a single direct product-mode toggle", async () => {
    const [desktopMain, app, titleBar, modeToggle, shellCss] = await Promise.all([
      readFile("src/desktop/main.ts", "utf8"),
      readFile("src/web/src/App.tsx", "utf8"),
      readFile("src/web/src/shell/DesktopTitleBar.tsx", "utf8"),
      readFile("src/web/src/shell/ProductModeToggle.tsx", "utf8"),
      readFile("src/web/src/styles/surfaces/shell.css", "utf8"),
    ]);
    expect(desktopMain).toContain('titleBarStyle: "hidden"');
    expect(desktopMain).toContain("titleBarOverlay:");
    expect(desktopMain).toContain("Menu.setApplicationMenu(buildMenu())");
    expect(desktopMain).toContain("menu.popup({");
    expect(desktopMain).not.toMatch(/ipcRenderer|contextBridge|nodeIntegration\s*:\s*true/);
    expect(app).toContain("<DesktopTitleBar onError={setError} />");
    expect(app).toContain("<WorkspaceNavigationHeader");
    expect(app).toContain("appMode.selectMode(modeToggle.targetMode)");
    expect(modeToggle).toContain('className="product-mode-toggle"');
    expect(modeToggle).toContain('view.currentMode === "agent" ? MessageSquareCode : Workflow');
    expect(app).not.toContain("ModeExperienceGuide");
    expect(titleBar).toContain("文件");
    expect(titleBar).toContain("/api/desktop/menu/open");
    expect(shellCss).toContain("padding-top: env(titlebar-area-height, 0px)");
    expect(shellCss).toContain(".desktop-title-bar");
    expect(shellCss).toContain("-webkit-app-region: drag");
    expect(shellCss).toContain("-webkit-app-region: no-drag");
    expect(shellCss).not.toContain("inset 0 -2px 0 var(--text-strong)");
    expect(shellCss).toMatch(/\.workspace-navigation-header-spacer\s*\{[\s\S]*?z-index: auto;/);
  });

  it("passes the selected Conversation mode to child workspace resources", async () => {
    const [appSource, handoffSource] = await Promise.all([
      readFile("src/web/src/App.tsx", "utf8"),
      readFile(
        "src/web/src/controllers/workspaceResourceModeHandoff.ts",
        "utf8",
      ),
    ]);
    expect(appSource).toMatch(
      /useWorkspaceResourceController\(workspaceResourceModeHandoff\(\{ productMode: appMode\.productMode \}, \{/,
    );
    expect(handoffSource).toMatch(/productMode: snapshot\.productMode/);
    expect(appSource).not.toMatch(/native-child-agent[\s\S]{0,160}productMode/);
    expect(appSource).not.toMatch(
      /Parameters<typeof useWorkspaceResourceController>/,
    );
  });

  it("recalibrates Office from canonical projection on reconnect without using Timeline deltas", async () => {
    const source = await readFile("src/web/src/App.tsx", "utf8");
    expect(source).toMatch(
      /onConnected:[\s\S]*agentSurfaces\.invalidate\(\{ conversationId, reason: "snapshot" \}\)/,
    );
    expect(source).toMatch(
      /timeline:\s*\{[\s\S]*patch:[\s\S]*timeline\.ingestEnvelope/,
    );
    expect(source).not.toMatch(
      /timeline:\s*\{[\s\S]{0,240}patch:[\s\S]{0,240}agentSurfaces\.invalidate/,
    );
  });
  it("uses two columns when closed and mounts the right rail only while open", async () => {
    const [app, shellCss, sidebarCss, workspaceCss] = await Promise.all([
      readFile("src/web/src/App.tsx", "utf8"),
      readFile("src/web/src/styles/surfaces/shell.css", "utf8"),
      readFile("src/web/src/styles/surfaces/sidebar.css", "utf8"),
      readFile("src/web/src/styles/surfaces/workspace.css", "utf8"),
    ]);
    expect(shellCss).toContain(
      "grid-template-columns: var(--left-sidebar-width, 280px) minmax(0, 1fr);",
    );
    expect(shellCss).toContain(".app-shell.right-rail-open");
    expect(shellCss).not.toContain("decision-pane-collapsed");
    expect(shellCss).not.toMatch(/minmax\(0, 1fr\) 48px/);
    expect(app).toContain(
      'rightToolRailState.mode !== "closed" ? <RightToolRailShell',
    );
    expect(app).not.toContain("BottomStatusBar");
    expect(sidebarCss).toContain("grid-template-rows: minmax(0, 1fr) auto;");
    const normalizedWorkspaceCss = workspaceCss.replace(/\r\n/g, "\n");
    expect(normalizedWorkspaceCss).toContain(
      ".sidebar-resizer {\n  right: -9px;",
    );
    expect(normalizedWorkspaceCss).toContain(
      ".sidebar-resizer::after {\n  right: 8px;",
    );
    expect(normalizedWorkspaceCss).toContain(
      ".right-rail-resizer {\n  left: -9px;",
    );
    expect(normalizedWorkspaceCss).toContain(
      ".right-rail-resizer::after {\n  left: 8px;",
    );
  });

  it("does not retain the retired collapsed rail or text sanitizer", async () => {
    const sources = await Promise.all([
      readFile("src/web/src/panels/workbench/DecisionPaneShell.tsx", "utf8"),
      readFile("src/web/src/formatters.ts", "utf8"),
    ]);
    expect(sources.join("\n")).not.toMatch(
      /approval-pane-collapsed|userFacingText/,
    );
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
    expect(sources.join("\n")).not.toMatch(
      /onNewWorkpad|workpad-route-switch|workpad-hero|workpad-section|task-queue-|coding-package-|workpad-scroll/,
    );
  });

  it("keeps the Agent model menus inside the application viewport", async () => {
    const [selectorSource, composerCss] = await Promise.all([
      readFile("src/web/src/shell/ConversationModelSelectors.tsx", "utf8"),
      readFile("src/web/src/styles/surfaces/composer.css", "utf8"),
    ]);
    expect(selectorSource).toContain('side="top"');
    expect(selectorSource).toContain("collisionPadding={12}");
    expect(composerCss).toContain("width: min(360px, calc(100vw - 24px))");
    expect(composerCss).toContain("max-height: min(440px, calc(100vh - 32px))");
  });

  it("keeps coarse-pointer controls touchable and supporting surfaces motion-safe", async () => {
    const [
      composerCss,
      settingsCss,
      sidebarCss,
      terminalCss,
      workspaceCss,
      decisionCss,
    ] = await Promise.all([
      readFile("src/web/src/styles/surfaces/composer.css", "utf8"),
      readFile("src/web/src/styles/surfaces/settings.css", "utf8"),
      readFile("src/web/src/styles/surfaces/sidebar.css", "utf8"),
      readFile("src/web/src/styles/surfaces/terminal.css", "utf8"),
      readFile("src/web/src/styles/surfaces/workspace.css", "utf8"),
      readFile("src/web/src/styles/surfaces/decision.css", "utf8"),
    ]);
    for (const css of [
      composerCss,
      settingsCss,
      sidebarCss,
      terminalCss,
      workspaceCss,
    ]) {
      expect(css).toContain("(pointer: coarse)");
      expect(css).toMatch(/min-(?:width|height): 44px/);
    }
    expect(settingsCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(settingsCss).toMatch(
      /@media \(max-width: 720px\), \(pointer: coarse\)[\s\S]*\.settings-inline-actions > button/,
    );
    expect(terminalCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(composerCss).toMatch(
      /@media \(pointer: coarse\) and \(min-width: 681px\)[\s\S]*grid-template-columns: 126px 44px/,
    );
    expect(decisionCss).toContain("font-family: var(--font-sans)");
  });
});
