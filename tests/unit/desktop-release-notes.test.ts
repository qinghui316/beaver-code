import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstalledReleaseNotes } from "../../src/desktop/installed-release-notes.js";
import { parseBeaverReleaseNoteContent, verifyBeaverReleaseNotes, type VerifiedBeaverUpdateManifest } from "../../src/desktop/update-manifest.js";
import { parseReleaseNoteContent, readBuildReleaseNotes, readReleaseNoteSource, releaseBody } from "../../scripts/release-notes.mjs";

const notes = {
  version: "0.1.16",
  zhCN: { summary: "修复更新说明。", changes: ["现在显示中文说明。"] },
  enUS: { summary: "Release notes are available.", changes: ["English notes are displayed."] },
};
const manifest = {
  schemaVersion: 1, channel: "stable", version: notes.version, tag: "v0.1.16", commit: "a".repeat(40),
  platform: "win32", arch: "x64", publishedAt: "2026-09-29T00:00:00.000Z",
  installer: { name: "Beaver-Code-Setup-0.1.16-win-x64.exe", size: 2_000_000, sha512: Buffer.alloc(64).toString("base64") },
  blockmap: { name: "Beaver-Code-Setup-0.1.16-win-x64.exe.blockmap", size: 10, sha512: Buffer.alloc(64).toString("base64") },
} as const;
const expected = { manifest, manifestSha256: createHash("sha256").update("manifest").digest("hex"), releaseUrl: "https://github.com/qinghui316/beaver-code/releases/tag/v0.1.16" } as VerifiedBeaverUpdateManifest;
const key = generateKeyPairSync("ed25519");
const trust = [{ keyId: "test", publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString() }];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function signed(overrides: Record<string, unknown> = {}) {
  const sidecar = { schemaVersion: 1, version: notes.version, tag: "v0.1.16", commit: manifest.commit,
    manifestSha256: expected.manifestSha256, notes, ...overrides };
  const bytes = Buffer.from(`${JSON.stringify(sidecar)}\n`);
  const signature = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: "ed25519", keyId: "test",
    signature: sign(null, bytes, key.privateKey).toString("base64") }));
  return { bytes, signature };
}

describe("bilingual desktop release notes", () => {
  it("keeps stable source identity exact and gives isolated update fixtures their build version", async () => {
    const root = await mkdtemp(join(tmpdir(), "beaver-note-source-"));
    roots.push(root);
    await mkdir(join(root, "release-notes"));
    const source = join(root, "release-notes", `v${notes.version}.json`);
    await writeFile(source, JSON.stringify(notes), "utf8");
    expect(await readBuildReleaseNotes(root, notes.version, notes.version, "stable")).toEqual(notes);
    expect(await readBuildReleaseNotes(root, notes.version, "0.1.18", "test"))
      .toEqual({ ...notes, version: "0.1.18" });
    await expect(readBuildReleaseNotes(root, notes.version, "0.1.18", "stable")).rejects.toThrow("build version");
    await writeFile(source, " ".repeat(24_001), "utf8");
    await expect(readReleaseNoteSource(root, notes.version)).rejects.toThrow("too large");
  });

  it("validates both languages and emits a two-language Release body", () => {
    expect(parseReleaseNoteContent(notes, "0.1.16")).toEqual(notes);
    expect(() => parseReleaseNoteContent({ ...notes, enUS: { summary: "", changes: [] } }, "0.1.16")).toThrow();
    expect(() => parseReleaseNoteContent(notes, "0.1.17")).toThrow();
    const body = releaseBody(notes);
    expect(body).toContain("## 中文");
    expect(body).toContain("## English");
    expect(body).toContain(notes.zhCN.changes[0]);
    expect(body).toContain("English notes are displayed");
  });

  it("verifies the separate signature and exact unchanged installer-manifest identity", () => {
    const { bytes, signature } = signed();
    expect(verifyBeaverReleaseNotes(bytes, signature, trust, expected)).toEqual(notes);
    expect(() => verifyBeaverReleaseNotes(Buffer.concat([bytes, Buffer.from(" ")]), signature, trust, expected)).toThrow("signature");
    for (const change of [{ tag: "v0.1.17" }, { manifestSha256: "b".repeat(64) }, { commit: "b".repeat(40) }]) {
      const mismatched = signed(change);
      expect(() => verifyBeaverReleaseNotes(mismatched.bytes, mismatched.signature, trust, expected)).toThrow("identity");
    }
    expect(() => parseBeaverReleaseNoteContent({ ...notes, zhCN: { summary: "bad", changes: [] } }, notes.version)).toThrow();
  });

  it("keeps an automatic-update notice pending across restart until acknowledgment", async () => {
    const root = await mkdtemp(join(tmpdir(), "beaver-installed-notes-"));
    roots.push(root);
    const packaged = join(root, "release-notes.json");
    await writeFile(packaged, JSON.stringify(notes), "utf8");
    const state = new InstalledReleaseNotes(join(root, "user"), packaged, notes.version);
    expect(await state.load(false)).toBeNull();
    expect(await state.load(true)).toEqual(notes);
    const restarted = new InstalledReleaseNotes(join(root, "user"), packaged, notes.version);
    expect(await restarted.load(false)).toEqual(notes);
    await expect(restarted.acknowledge("0.1.15")).rejects.toThrow("version changed");
    expect(await restarted.load(false)).toEqual(notes);
    await restarted.acknowledge(notes.version);
    await expect(restarted.acknowledge(notes.version)).resolves.toBeUndefined();
    expect(await restarted.load(false)).toBeNull();
    expect(await readFile(packaged, "utf8")).toContain(notes.version);
    const nextVersion = new InstalledReleaseNotes(join(root, "user"), packaged, "0.1.17");
    await expect(nextVersion.load(false)).rejects.toThrow("invalid");
  });

  it("keeps a malformed pending marker for explicit repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "beaver-note-ack-failure-"));
    roots.push(root);
    const packaged = join(root, "release-notes.json");
    const userData = join(root, "user");
    await writeFile(packaged, JSON.stringify(notes), "utf8");
    const state = new InstalledReleaseNotes(userData, packaged, notes.version);
    await state.load(true);
    const markerPath = join(userData, "pending-release-notes.json");
    await writeFile(markerPath, "{invalid", "utf8");
    await expect(state.acknowledge(notes.version)).rejects.toThrow();
    expect(await readFile(markerPath, "utf8")).toBe("{invalid");
    await writeFile(markerPath, JSON.stringify({ version: notes.version }), "utf8");
    await expect(state.acknowledge(notes.version)).resolves.toBeUndefined();
    await expect(state.acknowledge("0.1.15")).rejects.toThrow("version changed");
  });

  it("replaces an unread older notice with the version actually installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "beaver-note-jump-"));
    roots.push(root);
    const oldPath = join(root, "old.json");
    const newPath = join(root, "new.json");
    const nextNotes = { ...notes, version: "0.1.18" };
    await writeFile(oldPath, JSON.stringify(notes), "utf8");
    await writeFile(newPath, JSON.stringify(nextNotes), "utf8");
    const userData = join(root, "user");
    expect(await new InstalledReleaseNotes(userData, oldPath, notes.version).load(true)).toEqual(notes);
    const installed = new InstalledReleaseNotes(userData, newPath, nextNotes.version);
    expect(await installed.load(false)).toBeNull();
    expect(await installed.load(true)).toEqual(nextNotes);
    expect(await installed.load(false)).toEqual(nextNotes);
  });
});
