import { readFile } from "node:fs/promises";
import process from "node:process";
import { readReleaseNoteSource, releaseBody } from "./release-notes.mjs";
const { version } = JSON.parse(await readFile("package.json", "utf8"));
process.stdout.write(releaseBody(await readReleaseNoteSource(process.cwd(), version)));
