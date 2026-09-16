import { randomUUID } from "node:crypto";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../server/workbench-server.js";
import type { FolderDialogResult } from "../server/workbench/types.js";
import type { DesktopMenuOpenRequest, DesktopMenuOpenResult } from "../types/desktop-shell.js";
import { DesktopHostOperationGate } from "./lifecycle.js";
import {
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_SESSION_COOKIE,
  isDesktopHostMessage,
  safeDiagnostic,
  type DesktopHostMessage,
} from "./protocol.js";

const hostPort = process.parentPort;
if (!hostPort) throw new Error("Beaver Code desktop host channel is unavailable.");

let generation: string | null = null;
let server: WorkbenchServerHandle | null = null;
let idleLeaseId: string | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const operationGate = new DesktopHostOperationGate();
const folderRequests = new Map<string, (result: FolderDialogResult) => void>();
const menuRequests = new Map<string, (result: DesktopMenuOpenResult) => void>();
const leaseAcks = new Map<string, () => void>();

hostPort.on("message", (event) => {
  const message = event.data;
  if (!isDesktopHostMessage(message)) return;
  void receive(message);
});

async function receive(message: DesktopHostMessage): Promise<void> {
  if (message.type === "bootstrap") {
    if (generation !== null || server !== null) return;
    generation = message.generation;
    try {
      server = await startWorkbenchServer(null, {
        host: "127.0.0.1",
        port: 0,
        desktopHost: {
          sessionToken: message.sessionToken,
          cookieName: DESKTOP_SESSION_COOKIE,
          beginOperation: beginHostOperation,
          openFolder: requestFolder,
          openMenu: requestMenu,
          updateGeneration: generation,
          chooseUpdate: (offerId, action) => post({ type: "update-choice", generation: generation!, offerId, action }),
        },
      });
      post({
        type: "ready",
        protocolVersion: DESKTOP_PROTOCOL_VERSION,
        generation,
        origin: server.url,
      });
      void refreshIdleLease();
      idleTimer = setInterval(() => void refreshIdleLease(), 2_000);
      idleTimer.unref();
    } catch (cause) {
      post({
        type: "startup-failed",
        generation,
        diagnostic: safeDiagnostic("startup", cause, "请重新启动工作台。"),
      });
    }
    return;
  }
  if (message.generation !== generation) return;
  if (message.type === "update-offer") {
    server?.updates?.publishOffer(message.offer);
    return;
  }
  if (message.type === "update-request") {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    try {
      await revokeIdleLease();
      const updates = server?.updates;
      if (!updates) throw new Error("Update lifecycle is unavailable.");
      if (message.action === "cancel") {
        await updates.cancel(message.identity);
        post({ type: "update-result", requestId: message.requestId, generation,
          identity: message.identity, result: "canceled" });
        idleTimer = setInterval(() => void refreshIdleLease(), 2_000);
        idleTimer.unref();
      } else {
        const receipt = message.action === "prepare"
          ? await updates.prepare(message.identity) : await updates.stop(message.identity);
        post({ type: "update-result", requestId: message.requestId, generation,
          identity: receipt.identity, result: receipt.status });
        if (receipt.status === "stopped") {
          server = null;
          setTimeout(() => process.exit(0), 50);
        }
      }
    } catch (cause) {
      post({ type: "update-result", requestId: message.requestId, generation,
        identity: message.identity, result: "failed",
        diagnostic: safeDiagnostic("shutdown", cause, "请重新启动工作台后重试更新。") });
    }
    return;
  }
  if (message.type === "open-folder-result") {
    const resolve = folderRequests.get(message.requestId);
    if (!resolve) return;
    folderRequests.delete(message.requestId);
    resolve({
      path: message.path,
      canceled: message.canceled,
      supported: true,
      ...(message.error ? { error: message.error } : {}),
    });
    return;
  }
  if (message.type === "open-menu-result") {
    const resolve = menuRequests.get(message.requestId);
    if (!resolve) return;
    menuRequests.delete(message.requestId);
    resolve({ opened: message.opened, ...(message.error ? { error: message.error } : {}) });
    return;
  }
  if (message.type === "idle-lease-revoke-ack") {
    const resolve = leaseAcks.get(message.requestId);
    if (!resolve || message.leaseId !== idleLeaseId) return;
    leaseAcks.delete(message.requestId);
    idleLeaseId = null;
    resolve();
    return;
  }
  if (message.type === "read-quit-snapshot") {
    const snapshot = server ? await server.snapshot() : {
      state: "unknown" as const,
      activeTurnCount: 0,
      activeTerminalCount: 0,
      pendingInteractionCount: 0,
    };
    post({ type: "quit-snapshot", requestId: message.requestId, generation, ...snapshot });
    return;
  }
  if (message.type === "shutdown") await shutdown(message);
}

async function refreshIdleLease(): Promise<void> {
  if (!server || !generation) return;
  const updatePhase = server.updates?.snapshot().phase;
  if (updatePhase && updatePhase !== "idle" && updatePhase !== "canceled") return;
  const observedEpoch = operationGate.captureEpoch();
  if (!operationGate.canGrantIdleLease(observedEpoch)) return;
  if ((await server.snapshot()).state !== "idle"
    || !operationGate.canGrantIdleLease(observedEpoch)) return;
  idleLeaseId ??= randomUUID();
  post({ type: "idle-lease-granted", generation, leaseId: idleLeaseId });
}

async function beginHostOperation(): Promise<() => void> {
  return operationGate.begin(revokeIdleLease, () => void refreshIdleLease());
}

async function revokeIdleLease(): Promise<void> {
  if (!generation || !idleLeaseId) return;
  const requestId = randomUUID();
  const leaseId = idleLeaseId;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      leaseAcks.delete(requestId);
      reject(new Error("Desktop idle lease acknowledgement timed out."));
    }, 2_000);
    leaseAcks.set(requestId, () => {
      clearTimeout(timer);
      resolve();
    });
    post({ type: "idle-lease-revoked", generation: generation!, leaseId, requestId });
  });
}

async function requestFolder(): Promise<FolderDialogResult> {
  if (!generation) return { path: null, canceled: false, supported: false, error: "桌面宿主尚未准备好。" };
  const requestId = randomUUID();
  return new Promise<FolderDialogResult>((resolve) => {
    const timer = setTimeout(() => {
      folderRequests.delete(requestId);
      resolve({ path: null, canceled: false, supported: true, error: "文件夹选择超时，请重试。" });
    }, 120_000);
    folderRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    post({ type: "open-folder-request", generation: generation!, requestId, title: "选择项目文件夹" });
  });
}

async function requestMenu(request: DesktopMenuOpenRequest): Promise<DesktopMenuOpenResult> {
  if (!generation) return { opened: false, error: "桌面宿主尚未准备好。" };
  const requestId = randomUUID();
  return new Promise<DesktopMenuOpenResult>((resolve) => {
    const timer = setTimeout(() => {
      menuRequests.delete(requestId);
      resolve({ opened: false, error: "菜单响应超时，请重试。" });
    }, 120_000);
    menuRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    post({
      type: "open-menu-request",
      generation: generation!,
      requestId,
      menuId: request.menuId,
      anchor: request.anchor,
    });
  });
}

async function shutdown(message: Extract<DesktopHostMessage, { type: "shutdown" }>): Promise<void> {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  try {
    await server?.close(message.deadlineMs);
    server = null;
    post({ type: "shutdown-complete", requestId: message.requestId, generation: message.generation });
  } catch (cause) {
    post({
      type: "shutdown-complete",
      requestId: message.requestId,
      generation: message.generation,
      diagnostic: safeDiagnostic("shutdown", cause, "工作台已强制结束；下次启动会检查未完成任务。"),
    });
  }
}

function post(message: DesktopHostMessage): void {
  hostPort.postMessage(message);
}
