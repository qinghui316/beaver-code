import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { readBuildReleaseNotes, releaseBody } from "./release-notes.mjs";
import { desktopBuildVariant } from "./desktop-build-variant.mjs";

const root = process.cwd();
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const variant = desktopBuildVariant(root, version);
const notes = await readBuildReleaseNotes(root, version, variant.version, variant.channel);
await mkdir(resolve(root, "dist/desktop"), { recursive: true });
await mkdir(resolve(root, "release/desktop"), { recursive: true });
await writeFile(resolve(root, "dist/desktop/release-notes.json"), `${JSON.stringify(notes)}\n`, "utf8");
await writeFile(resolve(root, "release/desktop/release-body.md"), releaseBody(notes), "utf8");
