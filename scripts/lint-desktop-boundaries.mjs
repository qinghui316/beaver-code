import console from "node:console";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const main = await readFile(resolve(root, "src/desktop/main.ts"), "utf8");
const utility = await readFile(resolve(root, "src/desktop/utility.ts"), "utf8");
const failures = [];
const sharedDesktopContracts = ["../types/desktop-shell.js"];

// Check every desktop module, not only the composition entrypoints: a helper
// must not become a transitive backdoor into business owners.
const desktopSources = await collectDesktopSources();
for (const name of desktopSources) {
  const content = await readFile(resolve(root, "src/desktop", name), "utf8");
  for (const match of content.matchAll(/(?:from\s+|(?:import|require)\s*\(\s*)["']([^"']+)["']/g)) {
    const source = match[1];
    if (!source.startsWith("../")) continue;
    const allowed = name === "utility.ts"
      ? ["../server/workbench-server.js", "../server/workbench/types.js", ...sharedDesktopContracts]
      : name === "main.ts" ? sharedDesktopContracts : ["../types/workbench-update.js", ...sharedDesktopContracts];
    if (!allowed.includes(source)) failures.push(`Desktop module ${name} imports business ownership: ${source}`);
  }
  if (/from\s+["']electron-updater["']|import\s*\(\s*["']electron-updater["']/.test(content)
    && name !== "nsis-update-adapter.ts") failures.push(`Updater SDK belongs to nsis-update-adapter.ts, not ${name}`);
}

async function collectDesktopSources(directory = "") {
  const entries = await readdir(resolve(root, "src/desktop", directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectDesktopSources(name));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(name);
  }
  return files;
}

for (const match of main.matchAll(/from\s+["']([^"']+)["']/g)) {
  const source = match[1];
  if (source.startsWith("../") && !sharedDesktopContracts.includes(source)) failures.push(`Electron Main imports non-desktop module: ${source}`);
}
for (const match of utility.matchAll(/from\s+["']([^"']+)["']/g)) {
  const source = match[1];
  if (source.startsWith("../") && !["../server/workbench-server.js", "../server/workbench/types.js", ...sharedDesktopContracts].includes(source)) {
    failures.push(`Utility imports unsupported business module: ${source}`);
  }
}
if (/ipcRenderer|contextBridge|nodeIntegration\s*:\s*true/.test(main + utility)) failures.push("Desktop host exposes a forbidden Renderer bridge or Node integration.");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Desktop Main/Utility boundaries are valid.");
}
