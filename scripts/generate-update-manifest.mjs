import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { load } from "js-yaml";
import { desktopBuildVariant } from "./desktop-build-variant.mjs";
import { readReleaseNoteSource } from "./release-notes.mjs";

const root = process.cwd();
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const variant = desktopBuildVariant(root, pkg.version);
if (variant.channel !== "stable" || variant.updatePolicy.mode !== "stable") {
  throw new Error("Independent update manifests are generated only for stable packages.");
}
const privatePem = required("BEAVER_UPDATE_SIGNING_PRIVATE_KEY", 16_384);
const password = required("BEAVER_UPDATE_SIGNING_KEY_PASSWORD", 4_096);
const keyId = required("BEAVER_UPDATE_SIGNING_KEY_ID", 64);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new Error("Update signing key id is invalid.");
const privateKey = createPrivateKey({ key: privatePem, format: "pem", passphrase: password });
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Update signing key is not Ed25519.");
const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().replace(/\r\n/g, "\n");
const trusted = variant.updatePolicy.trustedKeys.find((entry) => entry.keyId === keyId);
if (!trusted || trusted.publicKey.replace(/\r\n/g, "\n") !== publicPem) throw new Error("Signing key does not match the packaged trust root.");

const release = variant.output;
const installerName = `${variant.artifactPrefix}-${variant.version}-win-x64.exe`;
const installerPath = join(release, installerName);
const blockmapName = `${installerName}.blockmap`;
const blockmapPath = join(release, blockmapName);
const metadataPath = join(release, "latest.yml");
const buildInfo = JSON.parse(await readFile(resolve(root, "dist/desktop/build-info.json"), "utf8"));
const latest = load(await readFile(metadataPath, "utf8"));
const latestFile = latest?.files?.find((entry) => entry.url === installerName);
const installer = await artifact(installerPath);
const blockmap = await artifact(blockmapPath);
if (latest?.version !== variant.version || latest?.files?.length !== 1
  || latestFile?.sha512 !== installer.sha512 || latestFile?.size !== installer.size) {
  throw new Error("Updater metadata does not match the stable installer.");
}
const manifest = Object.freeze({
  schemaVersion: 1,
  channel: "stable",
  version: variant.version,
  tag: `v${variant.version}`,
  commit: buildInfo.commit,
  platform: "win32",
  arch: "x64",
  publishedAt: buildInfo.builtAt,
  installer: { name: installerName, ...installer },
  blockmap: { name: blockmapName, ...blockmap },
});
const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
const signature = sign(null, manifestBytes, privateKey).toString("base64");
const envelope = { schemaVersion: 1, algorithm: "ed25519", keyId, signature };
const manifestPath = join(release, "beaver-update-win-x64.json");
const signaturePath = `${manifestPath}.sig`;
await writeFile(manifestPath, manifestBytes);
await writeFile(signaturePath, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o644 });
const notes = await readReleaseNoteSource(root, variant.version);
const packagedNotes = JSON.parse(await readFile(resolve(root, "dist/desktop/release-notes.json"), "utf8"));
if (JSON.stringify(notes) !== JSON.stringify(packagedNotes)) throw new Error("Packaged release notes differ from the source.");
const sidecar = {
  schemaVersion: 1, version: manifest.version, tag: manifest.tag, commit: manifest.commit,
  manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), notes,
};
const notesPath = join(release, "beaver-release-notes.json");
const notesSignaturePath = `${notesPath}.sig`;
const notesBytes = Buffer.from(`${JSON.stringify(sidecar)}\n`, "utf8");
if (notesBytes.byteLength > 32_768) throw new Error("Signed release notes are too large.");
await writeFile(notesPath, notesBytes);
await writeFile(notesSignaturePath, `${JSON.stringify({
  schemaVersion: 1, algorithm: "ed25519", keyId, signature: sign(null, notesBytes, privateKey).toString("base64"),
})}\n`, "utf8");
const receipt = {
  schemaVersion: 1,
  version: variant.version,
  tag: manifest.tag,
  commit: manifest.commit,
  keyId,
  manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
};
await writeFile(join(release, "release-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
const checksumFiles = [installerPath, blockmapPath, metadataPath, manifestPath, signaturePath,
  notesPath, notesSignaturePath, join(release, "release-receipt.json")];
const sums = [];
for (const file of checksumFiles) sums.push(`${await hashFile(file, "sha256", "hex")}  ${basename(file)}`);
await writeFile(join(release, "SHA256SUMS.txt"), `${sums.join("\n")}\n`, "utf8");

async function artifact(path) {
  const info = await stat(path);
  return { size: info.size, sha512: await hashFile(path, "sha512", "base64") };
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

function required(name, max) {
  const value = process.env[name];
  if (!value || value.length > max || /\0/.test(value)) throw new Error(`${name} is required.`);
  return value;
}
