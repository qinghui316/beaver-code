import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// Build-time gate shared by archive verification and the packaged Electron smoke.
// These packages must also be readable by external, non-Electron Provider processes.
export async function verifyDesktopSystemSkills(packagedRoot, sourceRoot) {
  const actual = await readPhysicalTree(resolve(packagedRoot));
  const expected = await readPhysicalTree(resolve(sourceRoot));
  const mandatoryEntry = "aho-main-orchestration/SKILL.md";
  if (!expected.has(mandatoryEntry) || !actual.has(mandatoryEntry)) {
    throw new Error("Mandatory AHO orchestration Skill is missing from physical resources.");
  }
  if (actual.size !== expected.size || [...expected.keys()].some((name) => !actual.has(name))) {
    throw new Error("Physical system Skill file set differs from the build input.");
  }
  for (const [name, bytes] of expected) {
    if (!bytes.equals(actual.get(name))) {
      throw new Error(`Physical system Skill content differs from the build input: ${name}`);
    }
  }
  return { fileCount: actual.size };
}

async function readPhysicalTree(root) {
  if (root.split(/[\\/]/).some((part) => part.toLowerCase().endsWith(".asar"))) {
    throw new Error("System Skills must be physical resources outside ASAR.");
  }
  if (!(await lstat(root)).isDirectory()) throw new Error("Physical system Skill directory is missing.");
  const files = new Map();
  async function visit(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Physical system Skill resources cannot contain links.");
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) files.set(name, await readFile(path));
      else throw new Error("Unexpected physical system Skill resource type.");
    }
  }
  await visit(root, "");
  return files;
}
