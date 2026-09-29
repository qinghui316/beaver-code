import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBeaverReleaseNoteContent, type BeaverReleaseNoteContent } from "./update-manifest.js";

export class InstalledReleaseNotes {
  private readonly pendingPath: string;

  constructor(private readonly userData: string, private readonly packagedPath: string, private readonly version: string) {
    this.pendingPath = join(userData, "pending-release-notes.json");
  }

  async load(updated: boolean): Promise<BeaverReleaseNoteContent | null> {
    const packaged = parseBeaverReleaseNoteContent(
      JSON.parse(await readFile(this.packagedPath, "utf8")) as unknown, this.version);
    if (updated) {
      await mkdir(this.userData, { recursive: true });
      const temporary = `${this.pendingPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: this.version })}\n`, "utf8");
        await rename(temporary, this.pendingPath);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    try {
      const marker = JSON.parse(await readFile(this.pendingPath, "utf8")) as unknown;
      if (!marker || typeof marker !== "object" || (marker as { version?: unknown }).version !== this.version) return null;
      return packaged;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async acknowledge(version: string): Promise<void> {
    if (version !== this.version) throw new Error("Installed release notes version changed.");
    let marker: { version?: unknown };
    try {
      marker = JSON.parse(await readFile(this.pendingPath, "utf8")) as { version?: unknown };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (marker.version !== version) throw new Error("Installed release notes marker changed.");
    await rm(this.pendingPath);
  }
}

export function packagedReleaseNotesPath(importUrl: string): string {
  return join(dirname(fileURLToPath(importUrl)), "release-notes.json");
}
