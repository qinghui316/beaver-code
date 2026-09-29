import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect as connectSocket, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectRegistryStore } from "../../src/registry/store.js";
import { ProviderRegistry } from "../../src/provider-runtime/registry.js";
import type { ProviderDescriptor } from "../../src/provider-runtime/contracts.js";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/workbench-server.js";

let root: string | undefined;
let server: WorkbenchServerHandle | undefined;
let streamAbort: AbortController | undefined;
let keepAliveSocket: Socket | undefined;
const identity = { updateId: "test-update", generation: "test-generation", targetVersion: "0.1.3", artifactSha512: Buffer.alloc(64, 1).toString("base64") };
const cookie = "beaver_code_session=test-token";

afterEach(async () => {
  streamAbort?.abort();
  keepAliveSocket?.destroy();
  if (server?.server.listening) await server.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
  server = undefined;
  keepAliveSocket = undefined;
});

async function start() {
  root = await mkdtemp(join(tmpdir(), "aho-update-http-"));
  server = await startWorkbenchServer(null, {
    port: 0, store: new ProjectRegistryStore(root), providerRegistry: new ProviderRegistry(),
    desktopHost: { sessionToken: "test-token", updateGeneration: identity.generation },
  });
  return server;
}

async function connect(handle: WorkbenchServerHandle, ok = true) {
  streamAbort = new AbortController();
  const response = await fetch(handle.url + "/api/desktop/update/events", {
    headers: { Cookie: cookie }, signal: streamAbort.signal,
  });
  expect(response.status).toBe(200);
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => { connected = resolve; });
  const actions: string[] = [];
  const reader = response.body!.getReader();
  void (async () => {
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += new TextDecoder().decode(chunk.value);
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const value = JSON.parse(data.slice(6));
        if (block.startsWith("event: connected")) connected();
        else if (block.startsWith("event: update")) {
          actions.push(value.action);
          await fetch(handle.url + "/api/desktop/update/ack", {
            method: "POST", headers: { Cookie: cookie, Origin: handle.url, "content-type": "application/json" },
            body: JSON.stringify({ requestId: value.requestId, connectionId: value.connectionId, ok: value.action === "cancel" || ok }),
          });
        }
      }
    }
  })().catch(() => undefined);
  await ready;
  return actions;
}

describe("real update HTTP/SSE composition", () => {
  it("replays installed notes and acknowledges only the current version", async () => {
    root = await mkdtemp(join(tmpdir(), "aho-installed-notes-http-"));
    const acknowledged: string[] = [];
    server = await startWorkbenchServer(null, {
      port: 0, store: new ProjectRegistryStore(root), providerRegistry: new ProviderRegistry(),
      desktopHost: { sessionToken: "test-token", updateGeneration: identity.generation,
        acknowledgeInstalledNotes: (version) => { acknowledged.push(version); } },
    });
    const notes = { version: "0.1.16",
      zhCN: { summary: "中文摘要", changes: ["中文改动"] },
      enUS: { summary: "English summary", changes: ["English change"] } };
    server.updates!.publishInstalledNotes(notes);
    const rejected = await fetch(server.url + "/api/desktop/update/notes-ack", {
      method: "POST", headers: { Cookie: cookie, Origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({ version: "0.1.15" }),
    });
    expect(rejected.status).toBe(409);
    expect(acknowledged).toEqual([]);
    streamAbort = new AbortController();
    const response = await fetch(server.url + "/api/desktop/update/events", {
      headers: { Cookie: cookie }, signal: streamAbort.signal,
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("installed-notes");
    const accepted = await fetch(server.url + "/api/desktop/update/notes-ack", {
      method: "POST", headers: { Cookie: cookie, Origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({ version: notes.version }),
    });
    expect(accepted.status).toBe(200);
    expect(acknowledged).toEqual([notes.version]);
    await reader.cancel();
  });

  it("does not poison later update preparation after a definite bad request", async () => {
    const handle = await start();
    const rejected = await fetch(handle.url + "/api/projects", {
      method: "POST", headers: { Cookie: cookie, Origin: handle.url, "content-type": "application/json" },
      body: "{invalid",
    });
    expect(rejected.status).toBe(400);
    await connect(handle);
    await expect(handle.updates!.prepare(identity)).resolves.toMatchObject({ status: "prepared" });
    await handle.updates!.cancel(identity);
  });
  it("requires authentication and hides update installation actions from HTTP", async () => {
    const handle = await start();
    expect((await fetch(handle.url + "/api/desktop/update/events")).status).toBe(403);
    expect((await fetch(handle.url + "/api/desktop/update/install", { headers: { Cookie: cookie } })).status).toBe(404);
    const status = await fetch(handle.url + "/api/app/status", { headers: { Cookie: cookie } });
    expect(await status.json()).toMatchObject({ desktopUpdates: true });
  });

  it("delivers only the current bounded offer choice back to the desktop host", async () => {
    root = await mkdtemp(join(tmpdir(), "aho-update-choice-"));
    const choices: unknown[] = [];
    server = await startWorkbenchServer(null, {
      port: 0, store: new ProjectRegistryStore(root), providerRegistry: new ProviderRegistry(),
      desktopHost: { sessionToken: "test-token", updateGeneration: identity.generation,
        chooseUpdate: (offerId, action) => choices.push({ offerId, action }) },
    });
    await connect(server);
    const offer = { offerId: "offer-1", version: "0.1.3", releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3" };
    server.updates!.publishOffer(offer);
    const accepted = await fetch(server.url + "/api/desktop/update/choice", {
      method: "POST", headers: { Cookie: cookie, Origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({ offerId: offer.offerId, action: "later" }),
    });
    expect(accepted.status).toBe(200);
    expect(choices).toEqual([{ offerId: "offer-1", action: "later" }]);
    const replay = await fetch(server.url + "/api/desktop/update/choice", {
      method: "POST", headers: { Cookie: cookie, Origin: server.url, "content-type": "application/json" },
      body: JSON.stringify({ offerId: offer.offerId, action: "install" }),
    });
    expect(replay.status).toBe(409);
  });

  it("prepares over SSE, fences mutations, and cancels without stopping the server", async () => {
    const handle = await start();
    const actions = await connect(handle);
    expect(await handle.updates!.prepare(identity)).toMatchObject({ status: "prepared" });
    expect((await fetch(handle.url + "/api/dialog/open-folder", {
      method: "POST", headers: { Cookie: cookie, Origin: handle.url },
    })).status).toBe(409);
    await handle.updates!.cancel(identity);
    expect(actions).toEqual(["prepare", "cancel"]);
    expect(handle.server.listening).toBe(true);
    expect(handle.updates!.snapshot().phase).toBe("canceled");
  });

  it("failed renderer saves cancel installation preparation", async () => {
    const handle = await start();
    await connect(handle, false);
    await expect(handle.updates!.prepare(identity)).rejects.toThrow();
    expect(handle.updates!.snapshot().phase).toBe("canceled");
    await expect(handle.updates!.stop(identity)).rejects.toThrow();
    expect(handle.server.listening).toBe(true);
  });

  it("requires a second current renderer confirmation before actual shutdown", async () => {
    const handle = await start();
    const actions = await connect(handle);
    await handle.updates!.prepare(identity);
    expect(await handle.updates!.stop(identity)).toMatchObject({ status: "stopped" });
    expect(actions).toEqual(["prepare", "confirm"]);
    expect(handle.server.listening).toBe(false);
  });

  it("refuses the stopped receipt while a Provider process has not confirmed exit", async () => {
    root = await mkdtemp(join(tmpdir(), "aho-update-provider-exit-"));
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register({
      id: "held-provider",
      displayName: "Held Provider",
      runtime: {
        liveness: () => ({ providerId: "held-provider", liveHostCount: 1 }),
        shutdown: async () => undefined,
        shutdownProject: async () => undefined,
      },
      conversation: { getActiveTurn: () => null, listActiveTurns: () => [] },
    } as unknown as ProviderDescriptor);
    server = await startWorkbenchServer(null, {
      port: 0,
      store: new ProjectRegistryStore(root),
      providerRegistry,
      desktopHost: { sessionToken: "test-token", updateGeneration: identity.generation },
    });
    const actions = await connect(server);
    await server.updates!.prepare(identity);

    await expect(server.updates!.stop(identity)).rejects.toThrow("Workbench shutdown failed");
    expect(actions).toEqual(["prepare", "confirm"]);
    expect(server.updates!.snapshot().phase).toBe("recovery-required");
  });

  it("does not let a renderer keep-alive connection consume the update shutdown deadline", async () => {
    const handle = await start();
    const actions = await connect(handle);
    const origin = new URL(handle.url);
    keepAliveSocket = connectSocket(Number(origin.port), origin.hostname);
    await new Promise<void>((resolve, reject) => {
      keepAliveSocket!.once("connect", resolve);
      keepAliveSocket!.once("error", reject);
    });
    keepAliveSocket.write([
      "GET /api/app/status HTTP/1.1",
      `Host: ${origin.host}`,
      `Cookie: ${cookie}`,
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"));
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        if (!chunk.toString("utf8").includes("200 OK")) return;
        keepAliveSocket!.off("error", reject);
        resolve();
      };
      keepAliveSocket!.on("data", onData);
      keepAliveSocket!.once("error", reject);
    });
    await handle.updates!.prepare(identity);
    await expect(handle.updates!.stop(identity)).resolves.toMatchObject({ status: "stopped" });
    expect(actions).toEqual(["prepare", "confirm"]);
    expect(handle.server.listening).toBe(false);
  });
});
