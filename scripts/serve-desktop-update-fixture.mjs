import { createServer } from "node:https";
import { constants, createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  || process.env.GITHUB_REPOSITORY !== "qinghui316/beaver-code"
  || !["refs/heads/master", "refs/heads/codex/aho-windows-github-independent-update-signing-v1", "refs/heads/codex/aho-windows-desktop-update-auto-relaunch-v1"].includes(process.env.GITHUB_REF)
  || process.env.GITHUB_SHA !== process.env.BEAVER_UPDATE_ACCEPTANCE_SHA
  || process.env.RUNNER_OS !== "Windows"
  || process.env.BEAVER_UPDATE_ACCEPTANCE !== "1") {
  throw new Error("The update fixture server is restricted to the disposable Windows acceptance runner.");
}

const root = resolve(required("BEAVER_UPDATE_FEED_ROOT"));
const readyPath = resolve(required("BEAVER_UPDATE_FEED_READY"));
const pfx = await readFile(resolve(required("BEAVER_UPDATE_TLS_PFX")));
const passphrase = required("BEAVER_UPDATE_TLS_PASSWORD");
const port = Number(process.env.BEAVER_UPDATE_FEED_PORT ?? "8443");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture feed port.");

const allowed = new Map();
for (const name of ["latest.yml", required("BEAVER_UPDATE_INSTALLER_NAME"), required("BEAVER_UPDATE_BLOCKMAP_NAME")]) {
  if (basename(name) !== name) throw new Error("Fixture file names must not contain directories.");
  const file = resolve(root, name);
  if (!file.startsWith(root + "\\")) throw new Error("Fixture file escaped the feed root.");
  await access(file, constants.R_OK);
  allowed.set("/" + encodeURIComponent(name).replaceAll("%2E", "."), file);
  allowed.set("/" + name, file);
}

const server = createServer({ pfx, passphrase, minVersion: "TLSv1.2" }, async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "https://localhost");
    const file = url.hash || !isAllowedQuery(url) ? null : allowed.get(url.pathname);
    if ((request.method !== "GET" && request.method !== "HEAD") || !file) {
      response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }
    const info = await stat(file);
    const type = extname(file).toLowerCase() === ".yml" ? "text/yaml; charset=utf-8" : "application/octet-stream";
    const requestedRange = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = requestedRange ? Number(requestedRange[1]) : 0;
    const requestedEnd = requestedRange?.[2] ? Number(requestedRange[2]) : info.size - 1;
    const end = Math.min(requestedEnd, info.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) {
      response.writeHead(416, { "Cache-Control": "no-store", "Content-Range": `bytes */${info.size}` });
      response.end();
      return;
    }
    const ranged = Boolean(requestedRange);
    response.writeHead(ranged ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(end - start + 1),
      "Content-Type": type,
      ...(ranged ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.once("error", () => response.destroy());
    stream.pipe(response);
  } catch {
    response.writeHead(500, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
    response.end("Fixture failure.");
  }
});

server.listen(port, "localhost", async () => {
  await writeFile(readyPath, `https://localhost:${port}/\n`, "utf8");
});

const close = () => server.close(() => process.exit(0));
process.once("SIGINT", close);
process.once("SIGTERM", close);

function required(name) {
  const value = process.env[name];
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value;
}

function isAllowedQuery(url) {
  if (!url.search) return true;
  const noCache = url.searchParams.get("noCache");
  return url.pathname === "/latest.yml" && url.searchParams.size === 1
    && typeof noCache === "string" && /^[0-9a-v]+$/.test(noCache);
}
