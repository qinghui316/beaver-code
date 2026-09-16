import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const excludedPackageDirectories = new Set([
  ".git",
  ".cache",
  ".turbo",
  ".vite",
  "node_modules",
  "state",
  "dist",
  "build",
  "coverage",
]);
const maxSkillPackageFiles = 500;
const maxSkillPackageFileBytes = 1024 * 1024;

export async function hashNativeSkillPackageContent(path: string): Promise<string> {
  const root = resolve(path);
  const files: string[] = [];
  await collectPackageFiles(root, root, files);
  if (!files.some((file) => relative(root, file).replace(/\\/g, "/") === "SKILL.md")) {
    throw new Error(`Skill package must contain SKILL.md: ${root}`);
  }
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const relativePath = relative(root, file).replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectPackageFiles(packageRoot: string, current: string, files: string[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    if (entry.isDirectory() && excludedPackageDirectories.has(entry.name)) continue;
    const path = resolve(current, entry.name);
    assertInside(packageRoot, path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await collectPackageFiles(packageRoot, path, files);
      continue;
    }
    if (!info.isFile() || info.size > maxSkillPackageFileBytes) continue;
    if (files.length >= maxSkillPackageFiles) {
      throw new Error(`Skill package has too many files: ${packageRoot}`);
    }
    files.push(path);
  }
}

function assertInside(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Skill package path escapes root: ${path}`);
  }
}
