import { fetchJson, postJson } from "../api.js";
import type { ProductMode, SkillListItem, SkillRootListItem } from "../types.js";
import type { ManagedSkillCatalogItem, SkillConfigurationChange } from "../../../types/skill-catalog.js";

export interface SkillsSettingsIdentity {
  readonly projectId: string | null;
  readonly productMode: ProductMode;
  readonly conversationId: string | null;
  readonly providerId: string | null;
}

export interface SkillsCatalogPayload {
  readonly roots?: readonly SkillRootListItem[];
  readonly skills?: readonly SkillListItem[];
  readonly errors?: readonly { path: string; message: string }[];
  readonly scope?: { providerId: string };
}

export interface SkillsSettingsPort {
  load(identity: SkillsSettingsIdentity): Promise<SkillsCatalogPayload>;
  refresh(identity: SkillsSettingsIdentity): Promise<void>;
  setProviderEnabled(identity: SkillsSettingsIdentity, skillId: string, enabled: boolean, item?: ManagedSkillCatalogItem): Promise<void>;
  addSource(identity: SkillsSettingsIdentity, rootPath: string): Promise<void>;
}

const catalogListeners = new Set<(providerId: string | null) => void>();
let catalogStream: EventSource | null = null;
export function subscribeSkillCatalogChanges(listener: (providerId: string | null) => void): () => void {
  if (typeof EventSource === "undefined" || typeof EventSource.prototype.addEventListener !== "function") return () => undefined;
  catalogListeners.add(listener);
  if (!catalogStream) {
    catalogStream = new EventSource("/api/skills/events");
    let connected = false;
    const publish = (providerId: string | null): void => { for (const subscriber of catalogListeners) subscriber(providerId); };
    catalogStream.addEventListener("ready", () => { if (connected) publish(null); connected = true; });
    catalogStream.addEventListener("skills.invalidated", (event) => {
      try { const data = JSON.parse((event as MessageEvent).data) as { providerId?: unknown };
        if (typeof data.providerId === "string") publish(data.providerId);
      } catch { /* Explicit refresh is available. */ }
    });
  }
  return () => { catalogListeners.delete(listener); if (!catalogListeners.size) { catalogStream?.close(); catalogStream = null; } };
}

export const skillsSettingsHttpPort: SkillsSettingsPort = {
  load: async (identity) => fetchJson<SkillsCatalogPayload>(
    `${catalogUrl(identity)}?${skillSearchParams(identity).toString()}`,
  ),
  refresh: async (identity) => {
    await postJson(identity.projectId ? `/api/projects/${encodeURIComponent(identity.projectId)}/skills?catalog=management` : "/api/skills/refresh", requestBody(identity));
  },
  setProviderEnabled: async (identity, skillId, enabled, item) => {
    const expected: Partial<SkillConfigurationChange> = item ? { expectedEnabled: item.providerEnabled,
      sourceIdentity: item.sourceIdentity, expectedContentHash: item.contentHash } : {};
    await postJson(
      `${catalogUrl(identity)}/${encodeURIComponent(skillId)}/provider-enable${identity.projectId ? "?catalog=management" : ""}`,
      { enabled, ...expected, ...requestBody(identity) },
    );
  },
  addSource: async (identity, rootPath) => {
    if (!identity.projectId) throw new Error("请选择来源所属的项目。");
    await postJson(`/api/projects/${encodeURIComponent(identity.projectId)}/skill-roots`, {
      rootPath,
      sourceKind: "custom",
      ...requestBody(identity),
    });
  },
};

function catalogUrl(identity: SkillsSettingsIdentity): string {
  return identity.projectId ? `/api/projects/${encodeURIComponent(identity.projectId)}/skills` : "/api/skills";
}

export function skillsSettingsIdentityKey(identity: Omit<SkillsSettingsIdentity, "projectId"> & { projectId: string | null }): string {
  return [identity.projectId ?? "", identity.productMode, identity.conversationId ?? "", identity.providerId ?? ""].join("\0");
}

function requestBody(identity: SkillsSettingsIdentity): {
  productMode: ProductMode;
  catalog: "management";
  conversationId?: string;
  providerId?: string;
} {
  return {
    catalog: "management",
    productMode: identity.productMode,
    conversationId: identity.conversationId ?? undefined,
    providerId: identity.providerId ?? undefined,
  };
}

function skillSearchParams(identity: SkillsSettingsIdentity): URLSearchParams {
  const params = new URLSearchParams({ productMode: identity.productMode });
  params.set("catalog", "management");
  if (identity.conversationId) params.set("conversationId", identity.conversationId);
  if (identity.providerId) params.set("providerId", identity.providerId);
  return params;
}
