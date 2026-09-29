import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const FIXED_RELEASE_ASSETS = new Set([
  "latest.yml",
  "beaver-update-win-x64.json",
  "beaver-update-win-x64.json.sig",
  "beaver-release-notes.json",
  "beaver-release-notes.json.sig",
  "release-receipt.json",
  "SHA256SUMS.txt",
]);

export async function removePriorChannelReleaseAssets(output, artifactPrefix) {
  await mkdir(output, { recursive: true });
  const escapedPrefix = artifactPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const generatedAsset = new RegExp(`^${escapedPrefix}-(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)-win-x64\\.exe(?:\\.blockmap)?$`);
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (entry.isFile() && (generatedAsset.test(entry.name) || FIXED_RELEASE_ASSETS.has(entry.name))) {
      await rm(resolve(output, entry.name));
    }
  }
}
