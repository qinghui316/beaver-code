import { createHash } from "node:crypto";
import console from "node:console";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { load } from "js-yaml";
import { desktopBuildVariant } from "./desktop-build-variant.mjs";
import { verifyBeaverReleaseNotes, verifyBeaverUpdateManifest } from "../dist/desktop/update-manifest.js";
import { readReleaseNoteSource } from "./release-notes.mjs";

const root = process.cwd();
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const variant = desktopBuildVariant(root, pkg.version);
if (variant.updatePolicy.mode !== "stable") throw new Error("Stable release verification requires a stable build.");
const release = resolve(root, process.env.DESKTOP_RELEASE_DIR ?? variant.output);
const manifestBytes = await readFile(join(release, "beaver-update-win-x64.json"));
const signatureBytes = await readFile(join(release, "beaver-update-win-x64.json.sig"));
const verified = verifyBeaverUpdateManifest(manifestBytes, signatureBytes, variant.updatePolicy.trustedKeys);
const manifest = verified.manifest;
if (manifest.version !== variant.version) throw new Error("Signed release version is invalid.");
const notes = verifyBeaverReleaseNotes(
  await readFile(join(release, "beaver-release-notes.json")),
  await readFile(join(release, "beaver-release-notes.json.sig")),
  variant.updatePolicy.trustedKeys, verified,
);
if (JSON.stringify(notes) !== JSON.stringify(await readReleaseNoteSource(root, variant.version))) {
  throw new Error("Signed release notes differ from the authored source.");
}
for (const artifact of [manifest.installer, manifest.blockmap]) {
  const path = join(release, artifact.name);
  if ((await stat(path)).size !== artifact.size || await hashFile(path, "sha512", "base64") !== artifact.sha512) {
    throw new Error(`Signed release artifact is invalid: ${artifact.name}`);
  }
}
const latest = load(await readFile(join(release, "latest.yml"), "utf8"));
const installerMetadata = latest?.files?.find((entry) => entry.url === manifest.installer.name);
if (latest?.version !== manifest.version || latest?.files?.length !== 1
  || installerMetadata?.sha512 !== manifest.installer.sha512
  || installerMetadata?.size !== manifest.installer.size) throw new Error("latest.yml is not bound to the signed release.");
const receipt = JSON.parse(await readFile(join(release, "release-receipt.json"), "utf8"));
if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
  || Object.keys(receipt).sort().join(",") !== "commit,keyId,manifestSha256,schemaVersion,tag,version"
  || receipt.schemaVersion !== 1 || receipt.version !== manifest.version || receipt.tag !== manifest.tag
  || receipt.commit !== manifest.commit || !variant.updatePolicy.trustedKeys.some((key) => key.keyId === receipt.keyId)
  || receipt.manifestSha256 !== verified.manifestSha256) throw new Error("Release receipt is invalid.");
const expectedSums = new Map((await readFile(join(release, "SHA256SUMS.txt"), "utf8")).trim().split(/\r?\n/).map((line) => {
  const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
  if (!match) throw new Error("Release checksum manifest is invalid.");
  return [match[2], match[1]];
}));
const checkedNames = [manifest.installer.name, manifest.blockmap.name, "latest.yml", "beaver-update-win-x64.json",
  "beaver-update-win-x64.json.sig", "beaver-release-notes.json", "beaver-release-notes.json.sig", "release-receipt.json"];
if (expectedSums.size !== checkedNames.length) throw new Error("Release checksum manifest is invalid.");
for (const name of checkedNames) {
  if (expectedSums.get(name) !== await hashFile(join(release, name), "sha256", "hex")) throw new Error(`Release checksum failed: ${name}`);
}
console.log(`Signed update release verified: ${manifest.tag} ${manifest.commit}`);

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}
