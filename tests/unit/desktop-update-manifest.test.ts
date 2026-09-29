import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubBeaverUpdateManifestClient,
  parseBeaverWindowsUpdateManifest,
  verifyBeaverUpdateManifest,
  verifyBeaverReleaseNotes,
} from "../../src/desktop/update-manifest.js";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const trust = [{ keyId: "release-2026", publicKey }];
const blockmapBytes = Buffer.from("signed blockmap fixture", "utf8");
const manifest = {
  schemaVersion: 1,
  channel: "stable",
  version: "0.1.3",
  tag: "v0.1.3",
  commit: "a".repeat(40),
  platform: "win32",
  arch: "x64",
  publishedAt: "2026-09-13T00:00:00.000Z",
  installer: { name: "Beaver-Code-Setup-0.1.3-win-x64.exe", size: 2_000_000, sha512: Buffer.alloc(64, 1).toString("base64") },
  blockmap: {
    name: "Beaver-Code-Setup-0.1.3-win-x64.exe.blockmap",
    size: blockmapBytes.byteLength,
    sha512: createHash("sha512").update(blockmapBytes).digest("base64"),
  },
} as const;

function signed(value: unknown = manifest, keyId = "release-2026") {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const envelope = Buffer.from(JSON.stringify({
    schemaVersion: 1, algorithm: "ed25519", keyId,
    signature: sign(null, bytes, pair.privateKey).toString("base64"),
  }));
  return { bytes, envelope };
}

describe("Beaver Code signed update manifest", () => {
  it("verifies raw bytes before parsing and returns an exact release identity", () => {
    const value = signed();
    expect(verifyBeaverUpdateManifest(value.bytes, value.envelope, trust)).toMatchObject({
      manifest,
      releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.3",
    });
  });

  it("rejects tampering, unknown keys, extra fields and non-stable identities", () => {
    const value = signed();
    expect(() => verifyBeaverUpdateManifest(Buffer.concat([value.bytes, Buffer.from(" ")]), value.envelope, trust)).toThrow("signature");
    expect(() => verifyBeaverUpdateManifest(value.bytes, signed(manifest, "unknown").envelope, trust)).toThrow("not trusted");
    for (const candidate of [
      { ...manifest, hidden: true },
      { ...manifest, version: "0.1.3-beta", tag: "v0.1.3-beta" },
      { ...manifest, tag: "v0.1.4" },
      { ...manifest, installer: { ...manifest.installer, name: "other.exe" } },
      { ...manifest, commit: "A".repeat(40) },
    ]) expect(() => parseBeaverWindowsUpdateManifest(candidate)).toThrow();
  });

  it("rejects redirects outside the bounded GitHub asset allowlist", async () => {
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/update" } }));
    const client = new GitHubBeaverUpdateManifestClient(trust, request as typeof fetch);
    await expect(client.latest()).rejects.toThrow("not allowed");
  });

  it("requires an exact unchanged signed tag during install-time revalidation", async () => {
    const first = signed();
    const changed = signed({ ...manifest, commit: "b".repeat(40) });
    const responses = [first.bytes, first.envelope, blockmapBytes, changed.bytes, changed.envelope, blockmapBytes];
    const request = vi.fn(async () => new Response(responses.shift(), { status: 200 }));
    const client = new GitHubBeaverUpdateManifestClient(trust, request as typeof fetch);
    const offered = await client.latest();
    expect(String(request.mock.calls[0]?.[0])).toContain("/releases/latest/download/beaver-update-win-x64.json");
    await expect(client.exact(offered)).rejects.toThrow("changed after download");
  });

  it("reads optional release notes from the exact signed tag and rejects mismatched identity", async () => {
    const signedManifest = signed();
    const expected = verifyBeaverUpdateManifest(signedManifest.bytes, signedManifest.envelope, trust);
    const notes = { version: manifest.version,
      zhCN: { summary: "中文摘要", changes: ["中文改动"] },
      enUS: { summary: "English summary", changes: ["English change"] } };
    const sidecar = signed({ schemaVersion: 1, version: manifest.version, tag: manifest.tag,
      commit: manifest.commit, manifestSha256: expected.manifestSha256, notes });
    const responses = [sidecar.bytes, sidecar.envelope];
    const request = vi.fn(async () => new Response(responses.shift(), { status: 200 }));
    const client = new GitHubBeaverUpdateManifestClient(trust, request as typeof fetch);
    await expect(client.notes(expected)).resolves.toEqual(notes);
    expect(String(request.mock.calls[0]?.[0])).toContain("/releases/download/v0.1.3/beaver-release-notes.json");
    expect(String(request.mock.calls[1]?.[0])).toContain("/releases/download/v0.1.3/beaver-release-notes.json.sig");
    const mismatched = signed({ schemaVersion: 1, version: manifest.version, tag: "v0.1.4",
      commit: manifest.commit, manifestSha256: expected.manifestSha256, notes });
    expect(() => verifyBeaverReleaseNotes(mismatched.bytes, mismatched.envelope, trust, expected)).toThrow("identity");
  });

  it("accepts bounded GitHub asset redirects with signed CDN query parameters", async () => {
    const value = signed();
    const redirected = new Set<string>();
    const request = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("github.com/") && !redirected.has(url)) {
        redirected.add(url);
        return new Response(null, { status: 302, headers: {
          location: `https://release-assets.githubusercontent.com/github-production-release-asset/1/${url.endsWith(".sig") ? "signature" : url.endsWith(".blockmap") ? "blockmap" : "manifest"}?sp=r&sig=opaque`,
        } });
      }
      if (url.includes("signature")) return new Response(value.envelope, { status: 200 });
      if (url.includes("blockmap")) return new Response(blockmapBytes, { status: 200 });
      return new Response(value.bytes, { status: 200 });
    });
    await expect(new GitHubBeaverUpdateManifestClient(trust, request as typeof fetch).latest()).resolves.toMatchObject({ manifest });
  });

  it("rejects a blockmap that does not match the signed manifest", async () => {
    const value = signed();
    const responses = [value.bytes, value.envelope, Buffer.from("tampered")];
    const request = vi.fn(async () => new Response(responses.shift(), { status: 200 }));
    await expect(new GitHubBeaverUpdateManifestClient(trust, request as typeof fetch).latest()).rejects.toThrow("blockmap");
  });

  it("bounds a stalled response body and cancels the request", async () => {
    const request = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ start() { /* deliberately never closes */ } }), { status: 200 }));
    const client = new GitHubBeaverUpdateManifestClient(trust, request as typeof fetch, 20);
    await expect(client.latest()).rejects.toThrow("timed out");
    expect((request.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(true);
  });

  it("aborts a pending sibling request when another metadata request fails immediately", async () => {
    let siblingAborted = false;
    const request = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (request.mock.calls.length === 1) return new Response(null, { status: 404 });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => {
          siblingAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    await expect(new GitHubBeaverUpdateManifestClient(trust, request as typeof fetch).latest())
      .rejects.toThrow("unavailable");
    expect(siblingAborted).toBe(true);
  });
});
