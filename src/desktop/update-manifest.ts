import { createHash, createPublicKey, verify } from "node:crypto";

export const BEAVER_UPDATE_MANIFEST_ASSET = "beaver-update-win-x64.json";
export const BEAVER_UPDATE_SIGNATURE_ASSET = `${BEAVER_UPDATE_MANIFEST_ASSET}.sig`;
export const BEAVER_RELEASE_NOTES_ASSET = "beaver-release-notes.json";
export const BEAVER_RELEASE_NOTES_SIGNATURE_ASSET = `${BEAVER_RELEASE_NOTES_ASSET}.sig`;

export interface BeaverReleaseNoteText {
  readonly summary: string;
  readonly changes: readonly string[];
}

export interface BeaverReleaseNoteContent {
  readonly version: string;
  readonly zhCN: BeaverReleaseNoteText;
  readonly enUS: BeaverReleaseNoteText;
}

export interface BeaverSignedReleaseNotes {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  readonly manifestSha256: string;
  readonly notes: BeaverReleaseNoteContent;
}

export interface BeaverWindowsUpdateManifest {
  readonly schemaVersion: 1;
  readonly channel: "stable";
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  readonly platform: "win32";
  readonly arch: "x64";
  readonly publishedAt: string;
  readonly installer: Readonly<{ name: string; size: number; sha512: string }>;
  readonly blockmap: Readonly<{ name: string; size: number; sha512: string }>;
}

export interface BeaverUpdateSignature {
  readonly schemaVersion: 1;
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signature: string;
}

export interface BeaverUpdatePublicKey {
  readonly keyId: string;
  readonly publicKey: string;
}

export interface VerifiedBeaverUpdateManifest {
  readonly manifest: BeaverWindowsUpdateManifest;
  readonly manifestSha256: string;
  readonly releaseUrl: string;
}

export interface BeaverUpdateManifestPort {
  latest(signal?: AbortSignal): Promise<VerifiedBeaverUpdateManifest>;
  exact(expected: VerifiedBeaverUpdateManifest, signal?: AbortSignal): Promise<void>;
  notes?(expected: VerifiedBeaverUpdateManifest, signal?: AbortSignal): Promise<BeaverReleaseNoteContent>;
}

const STABLE_OWNER = "qinghui316";
const STABLE_REPO = "beaver-code";
const ALLOWED_REDIRECT_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export function parseBeaverUpdatePublicKeys(value: unknown): readonly BeaverUpdatePublicKey[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw new Error("Update trust roots are invalid.");
  const seen = new Set<string>();
  return Object.freeze(value.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ["keyId", "publicKey"]) || !boundedKeyId(entry.keyId)
      || typeof entry.publicKey !== "string" || entry.publicKey.length > 2048 || seen.has(entry.keyId)) {
      throw new Error("Update trust roots are invalid.");
    }
    const key = createPublicKey(entry.publicKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Update trust root is not Ed25519.");
    seen.add(entry.keyId);
    return Object.freeze({ keyId: entry.keyId, publicKey: entry.publicKey });
  }));
}

export function verifyBeaverUpdateManifest(
  manifestBytes: Uint8Array,
  signatureBytes: Uint8Array,
  trustedKeys: readonly BeaverUpdatePublicKey[],
): VerifiedBeaverUpdateManifest {
  if (manifestBytes.byteLength < 2 || manifestBytes.byteLength > 65_536 || signatureBytes.byteLength > 4_096) {
    throw new Error("Update metadata size is invalid.");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signatureBytes)); }
  catch { throw new Error("Update signature envelope is invalid."); }
  if (!isRecord(envelope) || !exactKeys(envelope, ["schemaVersion", "algorithm", "keyId", "signature"])
    || envelope.schemaVersion !== 1 || envelope.algorithm !== "ed25519" || !boundedKeyId(envelope.keyId)
    || typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
    throw new Error("Update signature envelope is invalid.");
  }
  const trust = trustedKeys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!trust) throw new Error("Update signature key is not trusted.");
  if (!verify(null, manifestBytes, createPublicKey(trust.publicKey), Buffer.from(envelope.signature, "base64"))) {
    throw new Error("Update manifest signature is invalid.");
  }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); }
  catch { throw new Error("Signed update manifest is invalid."); }
  const manifest = parseBeaverWindowsUpdateManifest(raw);
  return Object.freeze({
    manifest,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    releaseUrl: `https://github.com/${STABLE_OWNER}/${STABLE_REPO}/releases/tag/${manifest.tag}`,
  });
}

export function parseBeaverReleaseNoteContent(value: unknown, version: string): BeaverReleaseNoteContent {
  if (!isRecord(value) || !exactKeys(value, ["version", "zhCN", "enUS"]) || value.version !== version
    || !stableVersion(version)) throw new Error("Release notes are invalid.");
  const parseText = (item: unknown): BeaverReleaseNoteText => {
    if (!isRecord(item) || !exactKeys(item, ["summary", "changes"]) || !noteText(item.summary)
      || !Array.isArray(item.changes) || item.changes.length < 1 || item.changes.length > 20
      || !item.changes.every(noteText)) throw new Error("Release notes are invalid.");
    return Object.freeze({ summary: item.summary, changes: Object.freeze([...item.changes]) });
  };
  return Object.freeze({ version, zhCN: parseText(value.zhCN), enUS: parseText(value.enUS) });
}

export function verifyBeaverReleaseNotes(
  notesBytes: Uint8Array,
  signatureBytes: Uint8Array,
  keys: readonly BeaverUpdatePublicKey[],
  expected: VerifiedBeaverUpdateManifest,
): BeaverReleaseNoteContent {
  if (notesBytes.byteLength < 2 || notesBytes.byteLength > 32_768 || signatureBytes.byteLength > 4_096) {
    throw new Error("Release notes size is invalid.");
  }
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signatureBytes)); }
  catch { throw new Error("Release notes signature is invalid."); }
  if (!isRecord(envelope) || !exactKeys(envelope, ["schemaVersion", "algorithm", "keyId", "signature"])
    || envelope.schemaVersion !== 1 || envelope.algorithm !== "ed25519" || !boundedKeyId(envelope.keyId)
    || typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
    throw new Error("Release notes signature is invalid.");
  }
  const trust = keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!trust || !verify(null, notesBytes, createPublicKey(trust.publicKey), Buffer.from(envelope.signature, "base64"))) {
    throw new Error("Release notes signature is invalid.");
  }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(notesBytes)); }
  catch { throw new Error("Signed release notes are invalid."); }
  const manifest = expected.manifest;
  if (!isRecord(raw) || !exactKeys(raw, ["schemaVersion", "version", "tag", "commit", "manifestSha256", "notes"])
    || raw.schemaVersion !== 1 || raw.version !== manifest.version || raw.tag !== manifest.tag
    || raw.commit !== manifest.commit || raw.manifestSha256 !== expected.manifestSha256) {
    throw new Error("Release notes identity is invalid.");
  }
  return parseBeaverReleaseNoteContent(raw.notes, manifest.version);
}

export function parseBeaverWindowsUpdateManifest(value: unknown): BeaverWindowsUpdateManifest {
  const fields = ["schemaVersion", "channel", "version", "tag", "commit", "platform", "arch", "publishedAt", "installer", "blockmap"];
  if (!isRecord(value) || !exactKeys(value, fields) || value.schemaVersion !== 1 || value.channel !== "stable"
    || value.platform !== "win32" || value.arch !== "x64" || !stableVersion(value.version)
    || value.tag !== `v${value.version}` || typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit)
    || typeof value.publishedAt !== "string" || !isExactIsoTimestamp(value.publishedAt)) {
    throw new Error("Signed update manifest is invalid.");
  }
  const installerName = `Beaver-Code-Setup-${value.version}-win-x64.exe`;
  const installer = parseArtifact(value.installer, installerName, 1_000_000, 1_073_741_824);
  const blockmap = parseArtifact(value.blockmap, `${installerName}.blockmap`, 1, 134_217_728);
  return Object.freeze({
    schemaVersion: 1,
    channel: "stable",
    version: value.version,
    tag: value.tag,
    commit: value.commit,
    platform: "win32",
    arch: "x64",
    publishedAt: value.publishedAt,
    installer,
    blockmap,
  });
}

export class GitHubBeaverUpdateManifestClient implements BeaverUpdateManifestPort {
  private readonly keys: readonly BeaverUpdatePublicKey[];
  constructor(
    keys: readonly BeaverUpdatePublicKey[],
    private readonly request: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    this.keys = parseBeaverUpdatePublicKeys(keys);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("Update metadata timeout is invalid.");
    }
  }

  async latest(signal?: AbortSignal): Promise<VerifiedBeaverUpdateManifest> {
    return this.withDeadline(signal, (boundedSignal) => this.read("latest/download", boundedSignal));
  }

  async exact(expected: VerifiedBeaverUpdateManifest, signal?: AbortSignal): Promise<void> {
    const current = await this.withDeadline(signal,
      (boundedSignal) => this.read(`download/${expected.manifest.tag}`, boundedSignal));
    if (current.manifestSha256 !== expected.manifestSha256
      || JSON.stringify(current.manifest) !== JSON.stringify(expected.manifest)) {
      throw new Error("The published update changed after download.");
    }
  }

  async notes(expected: VerifiedBeaverUpdateManifest, signal?: AbortSignal): Promise<BeaverReleaseNoteContent> {
    return this.withDeadline(signal, async (boundedSignal) => {
      const root = `https://github.com/${STABLE_OWNER}/${STABLE_REPO}/releases/download/${expected.manifest.tag}`;
      const [notes, signature] = await Promise.all([
        fetchBounded(`${root}/${BEAVER_RELEASE_NOTES_ASSET}`, 32_768, this.request, boundedSignal),
        fetchBounded(`${root}/${BEAVER_RELEASE_NOTES_SIGNATURE_ASSET}`, 4_096, this.request, boundedSignal),
      ]);
      return verifyBeaverReleaseNotes(notes, signature, this.keys, expected);
    });
  }

  private async read(release: string, signal: AbortSignal): Promise<VerifiedBeaverUpdateManifest> {
    const root = `https://github.com/${STABLE_OWNER}/${STABLE_REPO}/releases/${release}`;
    const [manifest, signature] = await Promise.all([
      fetchBounded(`${root}/${BEAVER_UPDATE_MANIFEST_ASSET}`, 65_536, this.request, signal),
      fetchBounded(`${root}/${BEAVER_UPDATE_SIGNATURE_ASSET}`, 4_096, this.request, signal),
    ]);
    const verified = verifyBeaverUpdateManifest(manifest, signature, this.keys);
    const blockmap = await fetchBoundedHash(
      `${root}/${verified.manifest.blockmap.name}`, 134_217_728, this.request, signal);
    if (blockmap.size !== verified.manifest.blockmap.size || blockmap.sha512 !== verified.manifest.blockmap.sha512) {
      throw new Error("Signed update blockmap is invalid.");
    }
    return verified;
  }

  private async withDeadline<T>(external: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (external?.aborted) abort();
    else external?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(timedOut ? "Update metadata request timed out." : "Update metadata request was canceled.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
      // A sibling request can still be blocked after Promise.all has already
      // rejected. Always terminate the operation-owned signal before returning.
      controller.abort();
    }
  }
}

async function fetchBoundedHash(
  url: string, limit: number, request: typeof fetch, signal: AbortSignal,
): Promise<{ size: number; sha512: string }> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertAllowedUrl(current);
    const response = await request(current, { redirect: "manual", headers: { Accept: "application/octet-stream" }, signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 5) throw new Error("Update metadata redirect is invalid.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) throw new Error("Update metadata is unavailable.");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > limit) throw new Error("Update metadata is too large.");
    const hash = createHash("sha512");
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const result = await readWithSignal(reader, signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error("Update metadata is too large."); }
      hash.update(result.value);
    }
    return { size: total, sha512: hash.digest("base64") };
  }
  throw new Error("Update metadata redirect is invalid.");
}

async function fetchBounded(
  url: string, limit: number, request: typeof fetch, signal: AbortSignal,
): Promise<Uint8Array> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertAllowedUrl(current);
    const response = await request(current, { redirect: "manual", headers: { Accept: "application/octet-stream" }, signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 5) throw new Error("Update metadata redirect is invalid.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) throw new Error("Update metadata is unavailable.");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > limit) throw new Error("Update metadata is too large.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const result = await readWithSignal(reader, signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error("Update metadata is too large."); }
      chunks.push(result.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  }
  throw new Error("Update metadata redirect is invalid.");
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error("Update metadata request was canceled.");
  return new Promise((resolve, reject) => {
    const abort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new Error("Update metadata request was canceled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function assertAllowedUrl(url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || !ALLOWED_REDIRECT_HOSTS.has(url.hostname)) throw new Error("Update metadata URL is not allowed.");
  if (url.hostname === "github.com"
    && (url.search || !url.pathname.startsWith(`/${STABLE_OWNER}/${STABLE_REPO}/releases/`))) {
    throw new Error("Update metadata URL is not allowed.");
  }
}

function parseArtifact(value: unknown, expectedName: string, minSize: number, maxSize: number) {
  if (!isRecord(value) || !exactKeys(value, ["name", "size", "sha512"]) || value.name !== expectedName
    || !Number.isSafeInteger(value.size) || Number(value.size) < minSize || Number(value.size) > maxSize
    || typeof value.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value.sha512)) {
    throw new Error("Signed update artifact identity is invalid.");
  }
  return Object.freeze({ name: value.name, size: Number(value.size), sha512: value.sha512 });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && [...expected].sort().every((key, index) => key === keys[index]);
}

function stableVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(value);
}

function noteText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500
    && value.trim() === value && !Array.from(value).some((character) =>
      character.charCodeAt(0) < 32 || character === "<" || character === ">");
}

function boundedKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isExactIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
