/* eslint-disable @typescript-eslint/no-require-imports */
/* global clearTimeout, console, process, require, setTimeout */

const { join, resolve } = require("node:path");
const { createRequire } = require("node:module");
const packagedRoot = process.env.BEAVER_NATIVE_PACKAGE_ROOT;
const load = packagedRoot ? createRequire(join(resolve(packagedRoot), "resources", "app.asar", "package.json")) : require;
const Database = load("better-sqlite3");
const pty = load("node-pty");

async function main() {
  if (packagedRoot) {
    const { verifyDesktopSystemSkills } = await import("./desktop-system-skills.mjs");
    const skills = await verifyDesktopSystemSkills(
      join(resolve(packagedRoot), "resources", "system-skills"),
      resolve("dist", "templates", "system-skills"),
    );
    console.log(`Physical system Skills verified: ${skills.fileCount} files.`);
  }
  const database = new Database(":memory:");
  database.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
  database.prepare("INSERT INTO smoke (value) VALUES (?)").run("sqlite-ok");
  const value = database.prepare("SELECT value FROM smoke").pluck().get();
  database.close();
  if (value !== "sqlite-ok") throw new Error("Electron SQLite smoke failed.");

  const output = await new Promise((resolve, reject) => {
    const terminal = pty.spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "echo pty-ok"], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    let text = "";
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error("Electron PTY smoke timed out."));
    }, 10_000);
    terminal.onData((data) => { text += data; });
    terminal.onExit(() => {
      clearTimeout(timer);
      resolve(text);
    });
  });
  if (!output.includes("pty-ok")) throw new Error("Electron PTY smoke failed.");
  console.log("Electron native SQLite and PTY smoke passed.");
  process.exit(0);
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
