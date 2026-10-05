import console from "node:console";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { extractFile, listPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { load } from "js-yaml";
import { desktopBuildVariant } from "./desktop-build-variant.mjs";
import { readBuildReleaseNotes } from "./release-notes.mjs";
import { verifyDesktopSystemSkills } from "./desktop-system-skills.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const variant = desktopBuildVariant(root, packageJson.version);
const release = resolve(root, process.env.DESKTOP_RELEASE_DIR ?? variant.output);
const escapedVersion = String(variant.version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const files = existsSync(release) ? await walk(release) : [];
const installerPattern = new RegExp(`${variant.artifactPrefix}-${escapedVersion}-win-x64\\.exe$`, "i");
const installer = files.find((file) => installerPattern.test(file));
const asar = files.find((file) => /win-unpacked[\\/]resources[\\/]app\.asar$/i.test(file));
const unpacked = files.filter((file) => /app\.asar\.unpacked[\\/]node_modules[\\/](better-sqlite3|node-pty)/i.test(file));
const required = [
  /better-sqlite3.*\.node$/i,
  /node-pty.*\.node$/i,
];
const nativeBinaries = unpacked.filter((file) => /\.(?:node|dll|exe)$/i.test(file));
const failures = [];
if (!installer) failures.push("Windows x64 NSIS installer was not found.");
if (!asar) failures.push("Packaged app.asar was not found.");
for (const pattern of required) if (!unpacked.some((file) => pattern.test(file))) failures.push(`Missing unpacked native resource: ${pattern}`);
if (nativeBinaries.some((file) => /arm64|darwin|linux/i.test(file))) failures.push("Package contains an unexpected non-Windows or arm64 native binary.");
for (const binary of nativeBinaries) {
  const bytes = await readFile(binary);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a || pe < 0 || pe + 6 > bytes.length
    || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    failures.push("A packaged native resource is not a Windows x64 PE binary.");
    break;
  }
}
if (installer && (await stat(installer)).size < 1_000_000) failures.push("Installer is unexpectedly small.");
if (asar) {
  try {
    await verifyDesktopSystemSkills(join(dirname(asar), "system-skills"), resolve(root, "dist", "templates", "system-skills"));
  } catch (cause) {
    failures.push(`Physical system Skill verification failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const entries = listPackage(asar, { isPack: false });
  if (entries.some((entry) => entry.endsWith(".map"))) failures.push("Package contains source maps.");
  if (entries.some((entry) => /\.(?:pfx|p12)$/i.test(entry))) failures.push("Package contains signing certificate material.");
  if (entries.some((entry) => /^[A-Za-z]:[\\/]|^\\\\/.test(entry))) failures.push("Package contains a host absolute archive path.");
  try {
    const sourceLicense = await readFile(resolve(root, "LICENSE"));
    if (!extractFile(asar, "LICENSE").equals(sourceLicense)) failures.push("Packaged project license differs from the source.");
  } catch (cause) {
    failures.push(`Packaged project license is missing or invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    const buildInfo = JSON.parse(extractFile(asar, join("dist", "desktop", "build-info.json")).toString("utf8"));
    const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    if (buildInfo.version !== variant.version) failures.push("Packaged build version does not match build input.");
    if (buildInfo.commit !== expectedCommit) failures.push("Packaged build commit does not match the current Git commit.");
    if (buildInfo.dirty !== false) failures.push("Packaged build identity is dirty.");
    if (buildInfo.channel !== variant.channel) failures.push("Packaged build channel does not match build input.");
    if (JSON.stringify(buildInfo.updatePolicy) !== JSON.stringify(variant.updatePolicy)) failures.push("Packaged update policy does not match build input.");
    const { parseDesktopBuildInfo } = await import("../dist/desktop/build-info.js");
    parseDesktopBuildInfo(buildInfo);
    const packagedNotes = JSON.parse(extractFile(asar, join("dist", "desktop", "release-notes.json")).toString("utf8"));
    const sourceNotes = await readBuildReleaseNotes(root, packageJson.version, variant.version, variant.channel);
    if (JSON.stringify(packagedNotes) !== JSON.stringify(sourceNotes)) failures.push("Packaged release notes differ from the source.");
  } catch (cause) {
    failures.push(`Packaged build identity is missing or invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    const manifest = JSON.parse(extractFile(asar, "package.json").toString("utf8"));
    if (manifest.license !== "MIT") failures.push("Packaged project license metadata must be MIT.");
    if (manifest.author) failures.push("Packaged manifest contains an application author identity.");
    if (manifest.repository || manifest.bugs || manifest.homepage) failures.push("Packaged manifest contains repository identity metadata.");
  } catch (cause) {
    failures.push(`Packaged manifest is missing or invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  for (const entry of entries.filter(isPackagedApplicationText)) {
    const content = extractFile(asar, entry.slice(1)).toString("utf8");
    if (/[A-Za-z]:\\Users\\[^\\\r\n]+\\|\/(?:Users|home)\/[^/\r\n]+\//.test(content)) {
      failures.push(`Package contains a host user path in ${entry}.`);
      break;
    }
  }
}

if (variant.channel !== "internal" && installer && asar) {
  try {
    const publisher = variant.updatePolicy.mode === "test"
      ? variant.updatePolicy.publisherSubject : variant.updatePolicy.authenticodePublisher;
    if (publisher) {
      const { verifyDesktopUpdateSignature } = await import("../dist/desktop/update-signature.js");
      const product = { version: variant.version, productName: variant.config.productName };
      await verifyDesktopUpdateSignature(installer, publisher, product);
      const executable = join(asar, "..", "..", variant.channel === "test" ? "BeaverCodeUpdateTest.exe" : "BeaverCode.exe");
      await verifyDesktopUpdateSignature(executable, publisher, product);
    }
    const latest = load(await readFile(join(release, "latest.yml"), "utf8"));
    const name = installer.split(/[\\/]/).pop();
    const metadataFile = latest?.files?.find((file) => file.url === name);
    const digest = createHash("sha512").update(await readFile(installer)).digest("base64");
    if (latest?.version !== variant.version || metadataFile?.sha512 !== digest) failures.push("Signed installer and update metadata disagree.");
    if (!existsSync(installer + ".blockmap")) failures.push("Update blockmap is missing.");
    if (variant.channel === "stable") {
      execFileSync(process.execPath, ["scripts/verify-update-release.mjs"], {
        cwd: root, encoding: "utf8", windowsHide: true, env: process.env,
      });
    }
  } catch (cause) {
    failures.push(`Signed update package verification failed: ${
      cause instanceof Error ? cause.message : "unknown verification error"
    }`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Desktop package verified: ${installer}`);
}

async function walk(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(path));
    else results.push(path);
  }
  return results;
}

function isPackagedApplicationText(entry) {
  return /^\\dist\\.*\.(?:css|html|js|json)$/i.test(entry);
}
