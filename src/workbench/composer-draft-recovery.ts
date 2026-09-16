import { z } from "zod";
import { assertAgentTurnMode, type AgentTurnMode, type ProductMode, type ProviderId } from "../provider-runtime/index.js";
import type { ProviderRegistry } from "../provider-runtime/registry.js";
import type { ManagedProject } from "../types/index.js";
import { restoreTopicFileReference } from "./file-references.js";
import type { StoredComposerDraft } from "./persistence/contracts.js";
import type { ComposerDraftWrite } from "./persistence/repositories/composer-draft-repository.js";
import type { TurnAttachmentResolver } from "./turn-attachment-resolver.js";
import type { TopicAttachmentEvidence } from "./attachments.js";
import type { TopicFileReference } from "./types.js";

export interface ComposerDraftDiagnostic {
  code: "invalid-field" | "unavailable-reference" | "unavailable-attachment" | "unavailable-provider" | "unavailable-skill";
  message: string;
}

export interface ComposerDraftSnapshot {
  projectId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  text: string;
  contextRefs: TopicFileReference[];
  attachments: TopicAttachmentEvidence[];
  skillOverrides: Record<string, boolean>;
  selectedProviderId: ProviderId | null;
  updatedAt: string;
  diagnostics: ComposerDraftDiagnostic[];
}

export interface ComposerDraftWriteRequest {
  projectId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
  text: string;
  contextRefs: TopicFileReference[];
  attachmentIds: string[];
  skillOverrides: Record<string, boolean>;
  selectedProviderId: ProviderId | null;
}

const FileReferenceSchema = z.object({
  relativePath: z.string().min(1).max(4096),
  name: z.string().min(1).max(512),
  kind: z.enum(["file", "directory"]),
  extension: z.string().max(64).optional(),
  size: z.number().nonnegative().finite().optional(),
  source: z.literal("composer").optional(),
});
const StoredFileReferencesSchema = z.array(FileReferenceSchema).max(100);
const StoredAttachmentIdsSchema = z.array(z.string().min(1).max(160)).max(50);
const StoredSkillOverridesSchema = z.record(z.string(), z.boolean());
const DraftWriteSchema = z.object({
  productMode: z.enum(["agent", "harness"]),
  agentTurnMode: z.unknown().optional().nullable(),
  agentModelId: z.string().min(1).max(300).optional().nullable(),
  agentReasoningEffort: z.string().min(1).max(100).optional().nullable(),
  text: z.string().max(2 * 1024 * 1024),
  contextRefs: StoredFileReferencesSchema.default([]),
  attachmentIds: StoredAttachmentIdsSchema.default([]),
  skillOverrides: StoredSkillOverridesSchema.default({}),
  selectedProviderId: z.string().min(1).max(200).optional().nullable(),
});

export class ComposerDraftRecoveryService {
  constructor(private readonly options: {
    attachmentResolver: TurnAttachmentResolver;
    providerRegistry: Pick<ProviderRegistry, "list">;
  }) {}

  async restore(project: ManagedProject, stored: StoredComposerDraft | null): Promise<ComposerDraftSnapshot | null> {
    if (!stored) return null;
    const diagnostics: ComposerDraftDiagnostic[] = [];
    const contextRefs = await this.restoreContextRefs(project, stored.contextRefsJson, diagnostics);
    const attachments = await this.restoreAttachments(project, stored.attachmentIdsJson, diagnostics);
    const skillOverrides = parseSkillOverrides(stored.skillOverridesJson, diagnostics);
    const agentTurnMode = restoredAgentTurnMode(stored, diagnostics);
    const selectedProviderId = stored.selectedProviderId;
    if (selectedProviderId && !this.options.providerRegistry.list().some((provider) => provider.id === selectedProviderId)) {
      diagnostics.push({ code: "unavailable-provider", message: "已保存的 Agent 当前不可用，请重新选择后再发送。" });
    }
    return {
      projectId: stored.projectId,
      productMode: stored.productMode,
      agentTurnMode,
      agentModelId: stored.agentModelId,
      agentReasoningEffort: stored.agentReasoningEffort,
      text: stored.text,
      contextRefs,
      attachments,
      skillOverrides,
      selectedProviderId,
      updatedAt: stored.updatedAt,
      diagnostics: diagnostics.slice(0, 50),
    };
  }

  async prepareWrite(project: ManagedProject, raw: unknown, updatedAt: string): Promise<ComposerDraftWrite> {
    const parsed = DraftWriteSchema.safeParse(raw);
    if (!parsed.success) throw badRequest("Composer draft payload is invalid.");
    const productMode = parsed.data.productMode;
    const agentTurnMode = parseWriteTurnMode(productMode, parsed.data.agentTurnMode);
    const agentModelId = parseWriteModelSelection(parsed.data.agentModelId);
    const agentReasoningEffort = parseWriteModelSelection(parsed.data.agentReasoningEffort);
    const contextRefs: TopicFileReference[] = [];
    for (const reference of uniqueReferences(parsed.data.contextRefs)) {
      const safe = await restoreTopicFileReference(project, reference).catch(() => null);
      if (!safe) throw badRequest("One or more Composer file references are no longer available.");
      contextRefs.push(safe);
    }
    const attachmentIds = uniqueStrings(parsed.data.attachmentIds);
    for (const attachmentId of attachmentIds) {
      const metadata = await this.options.attachmentResolver.resolveMetadata(project, [attachmentId]);
      await this.options.attachmentResolver.resolve(project, metadata);
    }
    const skillOverrides = normalizeSkillOverrides(parsed.data.skillOverrides);
    const selectedProviderId = parsed.data.selectedProviderId as ProviderId | null;
    return {
      projectId: project.id,
      productMode,
      agentTurnMode,
      agentModelId,
      agentReasoningEffort,
      text: parsed.data.text,
      contextRefsJson: JSON.stringify(contextRefs),
      attachmentIdsJson: JSON.stringify(attachmentIds),
      skillOverridesJson: JSON.stringify(skillOverrides),
      selectedProviderId,
      updatedAt,
    };
  }

  private async restoreContextRefs(
    project: ManagedProject,
    raw: string,
    diagnostics: ComposerDraftDiagnostic[],
  ): Promise<TopicFileReference[]> {
    const parsed = parseStoredJson(raw, StoredFileReferencesSchema);
    if (!parsed) {
      diagnostics.push({ code: "invalid-field", message: "部分已保存的文件引用已损坏，已从草稿中移除。" });
      return [];
    }
    const restored: TopicFileReference[] = [];
    for (const ref of parsed) {
      const restoredReference = await restoreTopicFileReference(project, ref).catch(() => null);
      if (restoredReference) restored.push(restoredReference);
      else diagnostics.push({ code: "unavailable-reference", message: `文件引用“${boundedName(ref.name)}”已不可用，已从草稿中移除。` });
    }
    return restored;
  }

  private async restoreAttachments(
    project: ManagedProject,
    raw: string,
    diagnostics: ComposerDraftDiagnostic[],
  ): Promise<TopicAttachmentEvidence[]> {
    const parsed = parseStoredJson(raw, StoredAttachmentIdsSchema);
    if (!parsed) {
      diagnostics.push({ code: "invalid-field", message: "部分已保存的附件记录已损坏，已从草稿中移除。" });
      return [];
    }
    const restored: TopicAttachmentEvidence[] = [];
    for (const attachmentId of uniqueStrings(parsed)) {
      try {
        const metadata = await this.options.attachmentResolver.resolveMetadata(project, [attachmentId]);
        const resolution = await this.options.attachmentResolver.resolve(project, metadata);
        const item = resolution.evidence[0];
        const source = metadata[0];
        if (!item || !source) throw new Error("Attachment evidence is unavailable.");
        restored.push({
          id: item.id,
          fileName: item.fileName,
          mediaType: item.mediaType,
          kind: item.kind,
          size: item.size,
          hash: item.contentHash,
          source: "composer",
          createdAt: source.createdAt,
          runtimeMode: item.runtimeMode,
        });
      } catch {
        diagnostics.push({ code: "unavailable-attachment", message: `附件“${boundedName(attachmentId)}”已不可用，已从草稿中移除。` });
      }
    }
    return restored;
  }
}

export function nextComposerDraftTimestamp(current: StoredComposerDraft | null, now = new Date()): string {
  const currentTime = current ? Date.parse(current.updatedAt) : Number.NaN;
  const nextTime = Number.isFinite(currentTime) && now.getTime() <= currentTime ? currentTime + 1 : now.getTime();
  return new Date(nextTime).toISOString();
}

function restoredAgentTurnMode(
  stored: StoredComposerDraft,
  diagnostics: ComposerDraftDiagnostic[],
): AgentTurnMode | null {
  if (stored.productMode === "harness") return null;
  if (stored.agentTurnMode === "default" || stored.agentTurnMode === "plan") return stored.agentTurnMode;
  diagnostics.push({ code: "invalid-field", message: "已保存的 Agent 回合模式无效，已恢复为 Default。" });
  return "default";
}

function parseWriteTurnMode(productMode: ProductMode, value: unknown): AgentTurnMode | null {
  if (productMode === "harness") {
    if (value !== null && value !== undefined) throw conflict("Harness Composer drafts cannot carry agentTurnMode.");
    return null;
  }
  try {
    return assertAgentTurnMode(value, "ComposerDraft agentTurnMode");
  } catch {
    throw badRequest("Agent Composer drafts require a valid agentTurnMode.");
  }
}

function parseWriteModelSelection(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function parseSkillOverrides(raw: string, diagnostics: ComposerDraftDiagnostic[]): Record<string, boolean> {
  const parsed = parseStoredJson(raw, StoredSkillOverridesSchema);
  if (!parsed) {
    diagnostics.push({ code: "invalid-field", message: "部分已保存的 Skill 选择已损坏，已从草稿中移除。" });
    return {};
  }
  return normalizeSkillOverrides(parsed);
}

function normalizeSkillOverrides(value: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(value)
    .map(([skillId, enabled]) => [skillId.trim(), enabled] as const)
    .filter(([skillId]) => skillId.length > 0 && skillId.length <= 300)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 200));
}

function parseStoredJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueReferences(values: readonly TopicFileReference[]): TopicFileReference[] {
  return [...new Map(values.map((item) => [item.relativePath, item])).values()];
}

function boundedName(value: string): string {
  const clean = value.replace(/[\r\n\0]/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "BadRequest";
  return error;
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}
