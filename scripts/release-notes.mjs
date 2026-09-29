import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;

export function parseReleaseNoteContent(value, version) {
  if (!record(value) || !keys(value, ["version", "zhCN", "enUS"])
    || value.version !== version || !versionPattern.test(version)) throw new Error("Release notes version is invalid.");
  for (const language of ["zhCN", "enUS"]) {
    const note = value[language];
    if (!record(note) || !keys(note, ["summary", "changes"]) || !text(note.summary, 500)
      || !Array.isArray(note.changes) || note.changes.length < 1 || note.changes.length > 20
      || !note.changes.every((entry) => text(entry, 500))) throw new Error(`Release notes ${language} are invalid.`);
  }
  return value;
}

export async function readReleaseNoteSource(root, version) {
  const bytes = await readFile(resolve(root, "release-notes", `v${version}.json`));
  if (bytes.byteLength > 24_000) throw new Error("Release notes are too large.");
  return parseReleaseNoteContent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), version);
}

export async function readBuildReleaseNotes(root, packageVersion, buildVersion, channel) {
  const source = await readReleaseNoteSource(root, packageVersion);
  if (channel !== "test" && buildVersion !== packageVersion) throw new Error("Release notes build version is invalid.");
  return buildVersion === packageVersion ? source : { ...source, version: buildVersion };
}

export function releaseBody(notes) {
  const lines = [`# Beaver Code v${notes.version}`, "", "## 中文", "", markdown(notes.zhCN.summary), ""];
  for (const entry of notes.zhCN.changes) lines.push(`- ${markdown(entry)}`);
  lines.push("", "## English", "", markdown(notes.enUS.summary), "");
  for (const entry of notes.enUS.changes) lines.push(`- ${markdown(entry)}`);
  return `${lines.join("\n")}\n`;
}

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, expected) { return Object.keys(value).sort().join(",") === [...expected].sort().join(","); }
function text(value, max) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max
    && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character === "<" || character === ">");
}
function markdown(value) {
  return Array.from(value).map((character) => "\\`*_{}[]()#+|>".includes(character) ? `\\${character}` : character).join("");
}
