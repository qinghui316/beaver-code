import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { readRequiredJsonFile, writeJsonFile } from "../fs/json.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../provider-runtime/project-harness-discovery.js";
import { resolveProjectRuntimeState } from "../project-runtime/coordinator.js";
import type { ManagedProject } from "../types/index.js";
import type { ProjectRuntimePaths } from "../project-runtime/paths.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";

export type TopicAttachmentKind = "image" | "text" | "unsupported";
export type TopicAttachmentRuntimeMode = "provider-image-input" | "provider-file-reference" | "bounded-text-preview" | "metadata-only";

export interface TopicAttachmentEvidence {
  id: string;
  fileName: string;
  mediaType: string;
  kind: TopicAttachmentKind;
  size: number;
  hash: string;
  source: "composer";
  createdAt: string;
  runtimeMode: TopicAttachmentRuntimeMode;
}

export interface TopicAttachment extends TopicAttachmentEvidence {
  storagePath: string;
  message?: string;
}

export function toTopicAttachmentEvidence(attachment: TopicAttachmentEvidence): TopicAttachmentEvidence {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    kind: attachment.kind,
    size: attachment.size,
    hash: attachment.hash,
    source: attachment.source,
    createdAt: attachment.createdAt,
    runtimeMode: attachment.runtimeMode,
  };
}

export interface CreateTopicAttachmentInput {
  fileName?: string;
  mediaType?: string;
  data?: string;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 48 * 1024;
const ATTACHMENT_DIR = "attachments";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"]);
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".py",
  ".ps1",
  ".sh",
  ".sql",
  ".toml",
  ".ini",
  ".env",
]);

const AttachmentMetadataSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mediaType: z.string(),
  kind: z.enum(["image", "text", "unsupported"]),
  size: z.number(),
  hash: z.string(),
  source: z.literal("composer"),
  createdAt: z.string(),
  storagePath: z.string(),
  runtimeMode: z.enum(["provider-image-input", "provider-file-reference", "bounded-text-preview", "metadata-only"]),
  message: z.string().optional(),
});

export interface TopicAttachmentStorageOptions {
  workbenchRoot?: string;
}

export async function createTopicAttachment(project: ManagedProject, input: CreateTopicAttachmentInput, options: TopicAttachmentStorageOptions = {}): Promise<TopicAttachment> {
  const parsed = parseAttachmentInput(input);
  const kind = classifyAttachment(parsed.fileName, parsed.mediaType);
  const limit = kind === "image" ? MAX_IMAGE_BYTES : kind === "text" ? MAX_TEXT_BYTES : 0;
  if (kind === "unsupported") {
    throw badRequest(`Unsupported attachment type: ${parsed.fileName}`);
  }
  if (parsed.buffer.byteLength > limit) {
    throw badRequest(`Attachment is too large. Limit is ${Math.floor(limit / 1024 / 1024)}MB.`);
  }
  if (kind === "text" && looksBinary(parsed.buffer)) {
    throw badRequest("Binary files cannot be attached as text context.");
  }

  const workbenchRoot = options.workbenchRoot ?? await resolveAttachmentWorkbenchRoot(project, "Project must be prepared before attaching files.");
  const hash = createHash("sha256").update(parsed.buffer).digest("hex");
  const now = new Date().toISOString();
  const id = `att-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${hash.slice(0, 12)}`;
  const safeName = sanitizeFileName(parsed.fileName);
  const extension = extname(safeName);
  const directory = join(workbenchRoot, ATTACHMENT_DIR, id);
  await mkdir(directory, { recursive: true });
  const dataFile = `content${extension || ".bin"}`;
  const absoluteDataPath = join(directory, dataFile);
  await writeFile(absoluteDataPath, parsed.buffer);

  const attachment: TopicAttachment = {
    id,
    fileName: safeName,
    mediaType: parsed.mediaType,
    kind,
    size: parsed.buffer.byteLength,
    hash,
    source: "composer",
    createdAt: now,
    storagePath: `${ATTACHMENT_DIR}/${id}/${dataFile}`,
    runtimeMode: kind === "image" ? "provider-image-input" : "provider-file-reference",
  };
  await writeJsonFile(join(directory, "attachment.json"), attachment);
  return attachment;
}

export async function deleteTopicAttachment(project: ManagedProject, attachmentId: string, options: TopicAttachmentStorageOptions = {}): Promise<{ deleted: true }> {
  const workbenchRoot = options.workbenchRoot ?? await resolveAttachmentWorkbenchRoot(project, "Project app data is not writable.");
  const id = normalizeAttachmentId(attachmentId);
  await rm(join(workbenchRoot, ATTACHMENT_DIR, id), { recursive: true, force: true });
  return { deleted: true };
}

export async function deleteUnreferencedTopicAttachments(
  project: ManagedProject,
  attachmentIds: readonly string[],
  paths: ProjectRuntimePaths,
): Promise<string[]> {
  if (attachmentIds.length === 0) return [];
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  let unreferenced: string[] = [];
  try {
    const referenced = new Set<string>();
    for (const mode of ["agent", "harness"] as const) {
      const draft = database.drafts.readDraft(paths.projectId, mode);
      for (const id of parseAttachmentIdArray(draft?.attachmentIdsJson ?? "[]")) referenced.add(id);
    }
    for (const item of database.conversationTurnQueues.listActiveProjectItems(paths.projectId)) {
      for (const id of parseAttachmentIdArray(item.attachmentIdsJson)) referenced.add(id);
    }
    for (const row of database.timeline.listAllMessages(paths.projectId)) {
      let raw: { attachments?: Array<{ id?: string }> };
      try {
        raw = JSON.parse(row.rawJson) as typeof raw;
      } catch {
        return [];
      }
      for (const attachment of raw.attachments ?? []) {
        if (typeof attachment.id === "string") referenced.add(attachment.id);
      }
    }
    unreferenced = normalizeTopicAttachmentIds(attachmentIds).filter((id) => !referenced.has(id));
  } finally {
    database.close();
  }
  for (const attachmentId of unreferenced) {
    await deleteTopicAttachment(project, attachmentId, { workbenchRoot: paths.workbenchRoot });
  }
  return unreferenced;
}

export async function resolveTopicAttachments(project: ManagedProject, attachmentIds: readonly string[] = [], options: TopicAttachmentStorageOptions = {}): Promise<TopicAttachment[]> {
  if (attachmentIds.length === 0) return [];
  const workbenchRoot = options.workbenchRoot ?? await resolveAttachmentWorkbenchRoot(project, "Project app data is not writable.");
  const result: TopicAttachment[] = [];
  for (const id of normalizeTopicAttachmentIds(attachmentIds)) {
    const metadataPath = join(workbenchRoot, ATTACHMENT_DIR, id, "attachment.json");
    if (!existsSync(metadataPath)) throw badRequest(`Attachment was not found: ${id}`);
    const attachment = await readRequiredJsonFile(metadataPath, AttachmentMetadataSchema);
    if (attachment.id !== id) throw badRequest(`Attachment metadata identity mismatch: ${id}`);
    const dataPath = resolveAttachmentAbsolutePath(workbenchRoot, attachment);
    if (!existsSync(dataPath)) throw badRequest(`Attachment content was not found: ${id}`);
    result.push(attachment);
  }
  return result;
}

export function normalizeTopicAttachmentIds(attachmentIds: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawId of attachmentIds) {
    const id = normalizeAttachmentId(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export async function renderTopicAttachmentsForPrompt(project: ManagedProject, attachments: readonly TopicAttachmentEvidence[] | undefined): Promise<string[]> {
  if (!attachments || attachments.length === 0) return [];
  const workbenchRoot = await resolveAttachmentWorkbenchRoot(project, "Project app data is not writable.");
  const managedAttachments = await resolveTopicAttachments(project, attachments.map((attachment) => attachment.id), { workbenchRoot });
  const lines = [
    "## User Message Attachments",
    "",
    "These attachments are message-scoped runtime context only. They do not authorize source mutation or Harness transitions.",
  ];
  for (const attachment of managedAttachments) {
    lines.push(`- ${attachment.kind}: ${attachment.fileName} (${attachment.mediaType}, ${attachment.size} bytes, sha256:${attachment.hash.slice(0, 16)})`);
    if (attachment.kind === "text") {
      const preview = await readAttachmentTextPreview(workbenchRoot, attachment).catch((error: unknown) => `Unable to read text preview: ${error instanceof Error ? error.message : String(error)}`);
      lines.push("  preview:");
      for (const line of preview.split(/\r?\n/).slice(0, 80)) lines.push(`    ${line}`);
    } else if (attachment.kind === "image") {
      lines.push("  image: passed to image-capable Agent providers when available; otherwise use this metadata and ask for clarification if needed.");
    }
  }
  return lines;
}

export async function providerImageInputsForAttachments(project: ManagedProject, attachments: TopicAttachment[] | undefined): Promise<Array<{ path: string; mediaType: string; fileName: string }>> {
  if (!attachments?.length) return [];
  const workbenchRoot = await resolveAttachmentWorkbenchRoot(project, "Project app data is not writable.");
  return attachments
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => ({
      path: resolveAttachmentAbsolutePath(workbenchRoot, attachment),
      mediaType: attachment.mediaType,
      fileName: attachment.fileName,
    }));
}

function parseAttachmentInput(input: CreateTopicAttachmentInput): { fileName: string; mediaType: string; buffer: Buffer } {
  const fileName = sanitizeFileName(input.fileName ?? "attachment");
  const data = typeof input.data === "string" ? input.data : "";
  if (!data) throw badRequest("Attachment data is required.");
  const parsed = parseDataUrl(data);
  const mediaType = normalizeMediaType(input.mediaType ?? parsed.mediaType ?? mediaTypeFromName(fileName));
  return { fileName, mediaType, buffer: parsed.buffer };
}

function parseAttachmentIdArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseDataUrl(value: string): { mediaType?: string; buffer: Buffer } {
  const match = value.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
  if (!match) return { buffer: Buffer.from(value, "base64") };
  const mediaType = match[1]?.trim();
  const body = match[2] ?? "";
  return { mediaType, buffer: Buffer.from(body, "base64") };
}

function classifyAttachment(fileName: string, mediaType: string): TopicAttachmentKind {
  const ext = extname(fileName).toLowerCase();
  if (mediaType.startsWith("image/") && IMAGE_EXTENSIONS.has(ext)) return "image";
  if ((mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("javascript") || mediaType.includes("typescript") || mediaType.includes("yaml")) && TEXT_EXTENSIONS.has(ext)) return "text";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

function mediaTypeFromName(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json";
  if (ext === ".js" || ext === ".jsx") return "text/javascript";
  if (ext === ".ts" || ext === ".tsx") return "text/typescript";
  return "text/plain";
}

function normalizeMediaType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function sanitizeFileName(value: string): string {
  const name = basename(value.replace(/\\/g, "/")).replace(/[^\w.\- ()[\]]+/g, "_").trim();
  return name || "attachment";
}

function normalizeAttachmentId(value: string): string {
  const id = value.trim();
  if (!/^att-\d{14}-[a-f0-9]{12}$/.test(id)) throw badRequest("Invalid attachment id.");
  return id;
}

export function resolveAttachmentAbsolutePath(workbenchRoot: string, attachment: TopicAttachment): string {
  const id = normalizeAttachmentId(attachment.id);
  const attachmentRoot = resolve(workbenchRoot, ATTACHMENT_DIR, id);
  const absolute = resolve(workbenchRoot, attachment.storagePath);
  const rel = relative(attachmentRoot, absolute);
  if (rel.startsWith("..") || rel === "" || rel.includes("..\\") || rel.includes("../")) throw badRequest("Attachment path escaped its managed directory.");
  return absolute;
}

async function readAttachmentTextPreview(workbenchRoot: string, attachment: TopicAttachment): Promise<string> {
  const buffer = await readFile(resolveAttachmentAbsolutePath(workbenchRoot, attachment));
  const preview = buffer.subarray(0, MAX_TEXT_PREVIEW_BYTES).toString("utf8");
  return buffer.byteLength > MAX_TEXT_PREVIEW_BYTES ? `${preview}\n[truncated]` : preview;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 4096));
  return sample.includes(0);
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}

async function resolveAttachmentWorkbenchRoot(project: ManagedProject, unavailableMessage: string): Promise<string> {
  const runtime = await resolveProjectRuntimeState(project, {
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  });
  if (runtime.state !== "ready") throw badRequest(unavailableMessage);
  return runtime.resolution.paths.workbenchRoot;
}

/** Bounded raster preview; executable SVG and arbitrary paths are never served. */
export async function readTopicAttachmentPreview(project: ManagedProject, attachmentId: string, options: TopicAttachmentStorageOptions): Promise<{ data: Buffer; mediaType: string }> {
  const [attachment] = await resolveTopicAttachments(project, [attachmentId], options);
  if (!attachment || attachment.kind !== "image" || !["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].includes(attachment.mediaType)) throw badRequest("Attachment has no raster preview.");
  const previewPath = resolveAttachmentAbsolutePath(options.workbenchRoot!, attachment);
  const info = await stat(previewPath);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES || info.size !== attachment.size) throw badRequest("Attachment preview size does not match metadata.");
  const content = await readFile(previewPath);
  if (content.length > MAX_IMAGE_BYTES || content.length !== attachment.size || createHash("sha256").update(content).digest("hex") !== attachment.hash) throw badRequest("Attachment preview content does not match metadata.");
  return { data: content, mediaType: attachment.mediaType };
}
