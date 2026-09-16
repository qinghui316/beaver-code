import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  screen,
  session,
  shell,
  utilityProcess,
  type MenuItemConstructorOptions,
  type UtilityProcess,
} from "electron";
import { DesktopRecoveryController } from "./lifecycle.js";
import {
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_SESSION_COOKIE,
  isDesktopHostMessage,
  safeDiagnostic,
  type DesktopHostMessage,
  type DesktopSafeDiagnostic,
} from "./protocol.js";
import { normalizeWindowState, type DesktopWindowState } from "./window-state.js";
import { parseOfficeRendererConsoleDiagnostic } from "./renderer-diagnostic.js";
import { readDesktopBuildInfo } from "./build-info.js";
import { DesktopUpdateCoordinator, type DesktopUpdateState } from "./update-coordinator.js";
import { DesktopUpdateHostBridge } from "./update-host-bridge.js";
import { createNsisUpdateAdapter } from "./nsis-update-adapter.js";
import type { DesktopMenuId, DesktopMenuOpenResult } from "../types/desktop-shell.js";

const buildInfo = readDesktopBuildInfo();
const productName = buildInfo.channel === "test" ? "Beaver Code 更新测试" : "Beaver Code";
if (buildInfo.channel === "test") {
  process.env.AHO_HOME = join(homedir(), ".beaver-code-update-test", "data");
  app.setPath("userData", join(app.getPath("appData"), "BeaverCodeUpdateTest"));
}
const desktopDir = join(homedir(), buildInfo.channel === "test" ? ".beaver-code-update-test" : ".agent-harness", "desktop");
const statePath = join(desktopDir, "window-state.json");
const logPath = join(desktopDir, "desktop.log");
const utilityEntry = fileURLToPath(new URL("./utility.js", import.meta.url));
const startupPage = fileURLToPath(new URL("./startup.html", import.meta.url));
const startupUrl = pathToFileURL(startupPage).href;
const recovery = new DesktopRecoveryController();
let updateCoordinator: DesktopUpdateCoordinator | null = null;
let updateRuntimeActive = false;
let updateState: DesktopUpdateState = "idle";
let updateTimer: ReturnType<typeof setInterval> | null = null;
let ordinaryExitRequested = false;
let systemSessionEnding = false;
let updatesPausedForRecovery = false;
let activeUpdateOfferId: string | null = null;

let window: BrowserWindow | null = null;
let utility: UtilityProcess | null = null;
let generation: string | null = null;
let sessionToken: string | null = null;
let workbenchOrigin: string | null = null;
let ready = false;
let quitting = false;
let shutdownPromise: Promise<void> | null = null;
let startupTimer: NodeJS.Timeout | null = null;
const pendingSnapshot = new Map<string, (state: "idle" | "active" | "attention" | "unknown") => void>();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    focusWindow();
    const directory = findDirectoryArgument(argv);
    if (directory && !updateRuntimeActive) void registerDirectory(directory);
  });
  app.whenReady().then(startApplication).catch((cause) => {
    void log("startup-failed", cause);
    app.exit(1);
  });
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void requestShutdown("app-quit");
});
app.on("window-all-closed", () => {
  if (!quitting && process.platform !== "darwin") void requestShutdown("window-close");
});
app.on("activate", () => {
  if (window) focusWindow();
  else void createWindow();
});

async function startApplication(): Promise<void> {
  await mkdir(desktopDir, { recursive: true });
  app.setName(productName);
  app.setAppUserModelId(buildInfo.channel === "test" ? "com.agentharness.desktop.update-test" : "com.agentharness.desktop");
  const policy = buildInfo.updatePolicy;
  if (app.isPackaged && process.platform === "win32" && process.arch === "x64" && policy && policy.mode !== "disabled") {
    const adapter = await createNsisUpdateAdapter(policy);
    const bridge = new DesktopUpdateHostBridge(() => ({ child: utility, generation }), () => { quitting = true; app.quit(); });
    updateCoordinator = new DesktopUpdateCoordinator(buildInfo.version, adapter, bridge, onUpdateState);
  }
  await log("build", `version=${buildInfo.version} commit=${buildInfo.commit} channel=${buildInfo.channel} platform=${process.platform} arch=${process.arch}`);
  installApplicationMenu();
  await createWindow();
  spawnWorkbench();
}

async function createWindow(): Promise<void> {
  const state = await readWindowState();
  const partition = `beaver-code-${randomUUID()}`;
  const browserSession = session.fromPartition(partition, { cache: false });
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({
    ...state.bounds,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#ecf4f6",
    title: productName,
    ...(process.platform === "win32" ? {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: {
        height: 48,
        color: "#ecf4f6",
        symbolColor: "#182126",
      },
    } : {}),
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  if (state.maximized) window.maximize();
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("console-message", (details) => {
    const diagnostic = parseOfficeRendererConsoleDiagnostic(details.message);
    if (diagnostic) void log("agent-office-renderer", diagnostic);
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedWorkbenchNavigation(url)) return;
    event.preventDefault();
    void openExternalUrl(url);
  });
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window?.setTitle(productName);
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestShutdown("window-close");
  });
  window.on("closed", () => { window = null; });
  window.on("query-session-end", () => { systemSessionEnding = true; updateCoordinator?.endSession(); });
  window.on("session-end", () => { systemSessionEnding = true; updateCoordinator?.endSession(); });
  window.on("resize", saveWindowStateSoon);
  window.on("move", saveWindowStateSoon);
  await window.loadFile(startupPage);
  window.once("ready-to-show", () => window?.show());
}

function spawnWorkbench(): void {
  const nextGeneration = randomUUID();
  const nextSessionToken = randomBytes(32).toString("base64url");
  generation = nextGeneration;
  sessionToken = nextSessionToken;
  ready = false;
  workbenchOrigin = null;
  recovery.begin(nextGeneration);
  const child = utilityProcess.fork(utilityEntry, [], { serviceName: "Beaver Code Workbench", stdio: "pipe" });
  utility = child;
  child.on("message", (message) => void receiveUtilityMessage(child, message));
  child.on("exit", (code) => void handleUtilityExit(child, code));
  child.on("spawn", () => child.postMessage({
    type: "bootstrap",
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    sessionToken: nextSessionToken,
    generation: nextGeneration,
  } satisfies DesktopHostMessage));
  child.stderr?.on("data", (chunk) => void log("utility-stderr", String(chunk).slice(0, 800)));
  startupTimer = setTimeout(() => showRecovery({
    stage: "startup",
    summary: "工作台启动超时。",
    recovery: "可以重新启动工作台或退出 Beaver Code。",
  }), 20_000);
}

async function receiveUtilityMessage(source: UtilityProcess, message: unknown): Promise<void> {
  if (source !== utility || !isDesktopHostMessage(message) || message.generation !== generation) return;
  if (message.type === "ready") {
    const origin = validateOrigin(message.origin);
    if (!origin || !window || !sessionToken) return;
    clearStartupTimer();
    ready = true;
    workbenchOrigin = origin;
    await window.webContents.session.cookies.set({
      url: origin,
      name: DESKTOP_SESSION_COOKIE,
      value: sessionToken,
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
    });
    await window.loadURL(origin);
    await log("workbench-ready", `version=${buildInfo.version} commit=${buildInfo.commit}`);
    if (updateCoordinator && !updateTimer) {
      const initialCheckDelayMs = buildInfo.channel === "test" ? 2_000 : 60_000;
      setTimeout(() => { if (ready && !quitting) void updateCoordinator?.check(); }, initialCheckDelayMs).unref();
      updateTimer = setInterval(() => { if (ready && !quitting) void updateCoordinator?.check(); }, 6 * 60 * 60 * 1000);
      updateTimer.unref();
    }
    const smokeExitMs = Number(process.env.BEAVER_CODE_SMOKE_EXIT_MS ?? "");
    if (Number.isInteger(smokeExitMs) && smokeExitMs >= 250 && smokeExitMs <= 30_000) {
      setTimeout(() => void requestShutdown("app-quit"), smokeExitMs).unref();
    }
    return;
  }
  if (message.type === "startup-failed") {
    clearStartupTimer();
    await showRecovery(message.diagnostic);
    return;
  }
  if (message.type === "idle-lease-granted") {
    recovery.grantIdleLease(message.generation, message.leaseId);
    return;
  }
  if (message.type === "idle-lease-revoked") {
    recovery.revokeIdleLease(message.generation, message.leaseId);
    source.postMessage({
      type: "idle-lease-revoke-ack",
      generation: message.generation,
      leaseId: message.leaseId,
      requestId: message.requestId,
    } satisfies DesktopHostMessage);
    return;
  }
  if (message.type === "open-folder-request") {
    const options = {
      title: message.title || "选择项目文件夹",
      properties: ["openDirectory" as const],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    source.postMessage({
      type: "open-folder-result",
      generation: message.generation,
      requestId: message.requestId,
      path: result.canceled ? null : result.filePaths[0] ?? null,
      canceled: result.canceled,
    } satisfies DesktopHostMessage);
    return;
  }
  if (message.type === "open-menu-request") {
    const result = await openDesktopMenu(message.menuId, message.anchor);
    source.postMessage({
      type: "open-menu-result",
      generation: message.generation,
      requestId: message.requestId,
      menuId: message.menuId,
      ...result,
    } satisfies DesktopHostMessage);
    return;
  }
  if (message.type === "update-choice" && message.offerId === activeUpdateOfferId) {
    if (message.action === "install") void updateCoordinator?.installReady();
    else void updateCoordinator?.dismissReady();
    return;
  }
  if (message.type === "quit-snapshot") {
    pendingSnapshot.get(message.requestId)?.(message.state);
    pendingSnapshot.delete(message.requestId);
  }
}

async function handleUtilityExit(source: UtilityProcess, code: number): Promise<void> {
  if (source !== utility) return;
  clearStartupTimer();
  utility = null;
  if (updateRuntimeActive) return;
  if (quitting) return;
  const decision = recovery.unexpectedExit(generation ?? "", !ready);
  await log("utility-exit", `code=${code} decision=${decision}`);
  if (decision === "restart") {
    spawnWorkbench();
    return;
  }
  await showRecovery({
    stage: "runtime",
    summary: "工作台意外停止，为避免重复执行任务，Beaver Code 没有自动重启。",
    recovery: "请确认当前任务状态后手动重新启动工作台。",
  });
}

async function requestShutdown(reason: Extract<DesktopHostMessage, { type: "shutdown" }>["reason"]): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  ordinaryExitRequested = true;
  quitting = true;
  updateCoordinator?.endSession();
  if (updateTimer) clearInterval(updateTimer);
  shutdownPromise = (async () => {
    await saveWindowState();
    const child = utility;
    if (child && generation) {
      const requestId = randomUUID();
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          child.kill();
          resolvePromise();
        }, 8_500);
        const listener = (message: unknown) => {
          if (!isDesktopHostMessage(message) || message.type !== "shutdown-complete" || message.requestId !== requestId || message.generation !== generation) return;
          child.off("message", listener);
          clearTimeout(timer);
          if (message.diagnostic) void log("shutdown-diagnostic", message.diagnostic.summary);
          child.kill();
          resolvePromise();
        };
        child.on("message", listener);
        child.postMessage({ type: "shutdown", requestId, generation: generation!, reason, deadlineMs: 8_000 } satisfies DesktopHostMessage);
      });
    }
    window?.destroy();
    app.exit(0);
  })();
  return shutdownPromise;
}

async function showRecovery(diagnostic: DesktopSafeDiagnostic): Promise<void> {
  await log("recovery", diagnostic.summary);
  if (!window) return;
  const detail = [diagnostic.summary, diagnostic.recovery].filter(Boolean).join("\n\n");
  const choice = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Beaver Code 需要处理",
    message: "工作台暂时无法使用",
    detail,
    buttons: ["重新启动工作台", "打开诊断目录", "退出 Beaver Code"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (choice.response === 0) {
    updateRuntimeActive = false;
    updateCoordinator?.endSession();
    updatesPausedForRecovery = Boolean(updateCoordinator);
    installApplicationMenu();
    utility?.kill();
    spawnWorkbench();
  } else if (choice.response === 1) {
    await shell.openPath(desktopDir);
    await showRecovery(diagnostic);
  } else {
    await requestShutdown("host-failure");
  }
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      id: "desktop-menu-file",
      label: "文件",
      submenu: [
        { label: "打开项目…", accelerator: "CmdOrCtrl+O", enabled: !updateRuntimeActive, click: () => void requestOpenFolder() },
        { type: "separator" },
        { label: "关闭窗口", role: "close" },
        { label: "退出 Beaver Code", click: () => void requestShutdown("app-quit") },
      ],
    },
    { id: "desktop-menu-edit", label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { id: "desktop-menu-view", label: "视图", submenu: [{ role: "reload", enabled: !updateRuntimeActive }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : [])] },
    { id: "desktop-menu-help", label: "帮助", submenu: [
      { label: `${productName} ${buildInfo.version} · ${buildInfo.commit.slice(0, 8)}`, enabled: false },
      { label: updateMenuLabel(), enabled: Boolean(updateCoordinator && !updatesPausedForRecovery && ["idle", "failed", "ready-to-install"].includes(updateState)),
        click: () => { if (!ready) return; if (updateState === "ready-to-install") void updateCoordinator?.installReady(); else void updateCoordinator?.check(true); } },
      { label: "打开诊断目录", click: () => void shell.openPath(desktopDir) },
    ] },
  ];
  return Menu.buildFromTemplate(template);
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(buildMenu());
}

async function openDesktopMenu(menuId: DesktopMenuId, anchor: { x: number; y: number }): Promise<DesktopMenuOpenResult> {
  const currentWindow = window;
  const menu = Menu.getApplicationMenu()?.getMenuItemById(`desktop-menu-${menuId}`)?.submenu;
  if (!currentWindow || currentWindow.isDestroyed() || !menu) return { opened: false, error: "菜单当前不可用。" };
  const bounds = currentWindow.getContentBounds();
  if (anchor.x > bounds.width || anchor.y > bounds.height) return { opened: false, error: "菜单位置无效。" };
  return new Promise<DesktopMenuOpenResult>((resolvePromise) => {
    let settled = false;
    const settle = (result: DesktopMenuOpenResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    try {
      menu.popup({
        window: currentWindow,
        x: anchor.x,
        y: anchor.y,
        callback: () => settle({ opened: true }),
      });
    } catch {
      settle({ opened: false, error: "菜单未能打开。" });
    }
  });
}

function updateMenuLabel(): string {
  if (updatesPausedForRecovery) return "重启应用后检查更新";
  if (!updateCoordinator) return "当前版本暂不支持自动更新";
  const labels: Record<DesktopUpdateState, string> = {
    idle: "检查更新", checking: "正在检查更新…", downloading: "正在下载更新…",
    "ready-to-install": "重新启动并更新", preparing: "正在保存…", stopping: "正在准备重启…", installing: "正在安装更新…", failed: "重试检查更新",
  };
  return labels[updateState];
}

async function onUpdateState(state: DesktopUpdateState): Promise<void> {
  updateState = state;
  if (state === "ready-to-install") {
    const offer = updateCoordinator?.offer();
    if (offer?.releaseUrl) {
      activeUpdateOfferId = randomUUID();
      utility?.postMessage({ type: "update-offer", generation: generation!, offer: {
        offerId: activeUpdateOfferId, version: offer.version, releaseUrl: offer.releaseUrl,
      } } satisfies DesktopHostMessage);
    }
  } else if (activeUpdateOfferId) {
    activeUpdateOfferId = null;
    utility?.postMessage({ type: "update-offer", generation: generation!, offer: null } satisfies DesktopHostMessage);
  }
  if (state === "preparing") updateRuntimeActive = true;
  if (state === "stopping") ready = false;
  await log("update", state);
  if (state === "ready-to-install" && buildInfo.channel === "test"
    && process.env.BEAVER_UPDATE_ACCEPTANCE === "1"
    && process.env.BEAVER_TEST_AUTO_ACCEPT_UPDATE === "1") {
    // The disposable Windows acceptance runner exercises the exact same explicit
    // install entry point after component tests have proven the visible prompt.
    setTimeout(() => void updateCoordinator?.installReady(), 0).unref();
  }
  if (state === "failed") {
    if (ordinaryExitRequested || systemSessionEnding) return;
    quitting = false;
    await log("update-failed", JSON.stringify(updateCoordinator?.diagnostic()));
    if (!ready || !utility || updateCoordinator?.diagnostic().recoveryRequired) {
      void showRecovery({ stage: "runtime", summary: "更新暂未完成。", recovery: "请查看诊断信息后重新启动工作台。" });
    } else {
      updateRuntimeActive = false;
    }
  }
  installApplicationMenu();
}

async function requestOpenFolder(): Promise<void> {
  const options = { title: "选择项目文件夹", properties: ["openDirectory" as const] };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (!result.canceled && result.filePaths[0]) await registerDirectory(result.filePaths[0]);
}

async function registerDirectory(path: string): Promise<void> {
  if (!workbenchOrigin || !sessionToken || !existsSync(path) || !statSync(path).isDirectory()) {
    const options = { type: "info" as const, message: "无法打开这个文件夹。", detail: "请选择一个现有项目文件夹。" };
    if (window) await dialog.showMessageBox(window, options); else await dialog.showMessageBox(options);
    return;
  }
  const response = await fetch(`${workbenchOrigin}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${DESKTOP_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`, Origin: workbenchOrigin },
    body: JSON.stringify({ path, confirm: true }),
  });
  if (!response.ok) {
    const options = { type: "warning" as const, message: "项目未能打开。", detail: "请在 Beaver Code 中检查项目设置后重试。" };
    if (window) await dialog.showMessageBox(window, options); else await dialog.showMessageBox(options);
    return;
  }
  const payload = await response.json() as { project?: { id?: string } };
  if (payload.project?.id) await window?.loadURL(`${workbenchOrigin}/?project=${encodeURIComponent(payload.project.id)}`);
}

function isAllowedWorkbenchNavigation(value: string): boolean {
  if (!workbenchOrigin) return value === startupUrl;
  try { return new URL(value).origin === workbenchOrigin; } catch { return false; }
}

async function openExternalUrl(value: string): Promise<void> {
  try {
    const url = new URL(value);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) await shell.openExternal(url.toString());
  } catch { /* ignored */ }
}

function validateOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port) ? url.origin : null;
  } catch { return null; }
}

function focusWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function findDirectoryArgument(argv: readonly string[]): string | null {
  for (const value of argv.slice(1)) {
    if (!value || value.startsWith("-") || value.includes(".asar")) continue;
    const candidate = resolve(value);
    try { if (statSync(candidate).isDirectory()) return candidate; } catch { /* ignored */ }
  }
  return null;
}

let saveTimer: NodeJS.Timeout | null = null;
function saveWindowStateSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveWindowState(), 300);
}

async function readWindowState(): Promise<DesktopWindowState> {
  let value: unknown = null;
  try { value = JSON.parse(await readFile(statePath, "utf8")); } catch { /* defaults */ }
  return normalizeWindowState(value, screen.getAllDisplays().map((display) => display.workArea));
}

async function saveWindowState(): Promise<void> {
  if (!window || window.isDestroyed()) return;
  const state: DesktopWindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clearStartupTimer(): void {
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = null;
}

async function log(event: string, detail: unknown): Promise<void> {
  await mkdir(desktopDir, { recursive: true });
  try {
    const info = await stat(logPath);
    if (info.size > 1_000_000) await rename(logPath, `${logPath}.previous`).catch(() => undefined);
  } catch { /* new log */ }
  const text = safeDiagnostic("runtime", detail).summary;
  await appendFile(logPath, `${new Date().toISOString()} ${event} ${text}\n`, "utf8");
}
