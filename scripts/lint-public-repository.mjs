import { execFileSync } from "node:child_process";
import console from "node:console";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

// Check the Git index, including staged additions, without reading local ignored data.
const LOCAL_ROOTS = new Set([
  ".agent-harness", ".agents", ".claude", ".codex", ".local-tools",
  ".playwright-mcp", ".playwright-cli", ".agent-validation", ".cache", ".tmp",
  "tmp", "temp", "logs", "node_modules", "dist", "release", "coverage",
  "playwright-report", "test-results", "acceptance-evidence", "reference-projects",
]);

export function lintPublicRepository(projectRoot = process.cwd()) {
  const paths = execFileSync("git", ["ls-files", "--cached", "--full-name", "-z"], {
    cwd: projectRoot, encoding: "utf8", windowsHide: true,
  }).split("\0").filter(Boolean);
  const violations = [];
  for (const path of paths) {
    const normalized = path.toLowerCase();
    const basename = normalized.split("/").at(-1);
    const fixture = normalized.startsWith("tests/fixtures/");
    if (LOCAL_ROOTS.has(normalized.split("/")[0])
      || normalized === "result.json" || normalized === ".gitmodules"
      || (normalized.startsWith("build/") && normalized !== "build/installer.nsh")
      || basename === "thumbs.db" || basename === "desktop.ini"
      || /\.(?:pfx|p12)$/.test(basename)
      || (!fixture && (/\.log$/.test(basename) || /^\.env(?:\.|$)/.test(basename) && basename !== ".env.example"))) {
      violations.push(`${path}: local working data or generated output must remain untracked.`);
    }
  }
  return { checked: paths.length, violations };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = lintPublicRepository();
    if (result.violations.length) {
      console.error(result.violations.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Public repository boundary passed: ${result.checked} tracked files.`);
    }
  } catch {
    console.error("Public repository boundary requires a readable Git index.");
    process.exitCode = 1;
  }
}
