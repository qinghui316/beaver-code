import { fetchJson, postJson } from "../api.js";
import type { ProductMode, SkillListItem, SkillRootListItem } from "../types.js";

export interface SkillsSettingsIdentity {
  readonly projectId: string;
  readonly productMode: ProductMode;
  readonly conversationId: string | null;
  readonly providerId: string | null;
}

export interface SkillsCatalogPayload {
  readonly roots?: readonly SkillRootListItem[];
  readonly skills?: readonly SkillListItem[];
  readonly errors?: readonly { path: string; message: string }[];
}

export interface SkillsSettingsPort {
  load(identity: SkillsSettingsIdentity): Promise<SkillsCatalogPayload>;
  refresh(identity: SkillsSettingsIdentity): Promise<void>;
  setProviderEnabled(identity: SkillsSettingsIdentity, skillId: string, enabled: boolean): Promise<void>;
  addSource(identity: SkillsSettingsIdentity, rootPath: string): Promise<void>;
}

export const skillsSettingsHttpPort: SkillsSettingsPort = {
  load: async (identity) => fetchJson<SkillsCatalogPayload>(
    `/api/projects/${encodeURIComponent(identity.projectId)}/skills?${skillSearchParams(identity).toString()}`,
  ),
  refresh: async (identity) => {
    await postJson(`/api/projects/${encodeURIComponent(identity.projectId)}/skills`, requestBody(identity));
  },
  setProviderEnabled: async (identity, skillId, enabled) => {
    await postJson(
      `/api/projects/${encodeURIComponent(identity.projectId)}/skills/${encodeURIComponent(skillId)}/provider-enable`,
      { enabled, ...requestBody(identity) },
    );
  },
  addSource: async (identity, rootPath) => {
    await postJson(`/api/projects/${encodeURIComponent(identity.projectId)}/skill-roots`, {
      rootPath,
      sourceKind: "custom",
      ...requestBody(identity),
    });
  },
};

export function skillsSettingsIdentityKey(identity: Omit<SkillsSettingsIdentity, "projectId"> & { projectId: string | null }): string {
  return [identity.projectId ?? "", identity.productMode, identity.conversationId ?? "", identity.providerId ?? ""].join("\0");
}

function requestBody(identity: SkillsSettingsIdentity): {
  productMode: ProductMode;
  conversationId?: string;
  providerId?: string;
} {
  return {
    productMode: identity.productMode,
    conversationId: identity.conversationId ?? undefined,
    providerId: identity.providerId ?? undefined,
  };
}

function skillSearchParams(identity: SkillsSettingsIdentity): URLSearchParams {
  const params = new URLSearchParams({ productMode: identity.productMode });
  if (identity.conversationId) params.set("conversationId", identity.conversationId);
  if (identity.providerId) params.set("providerId", identity.providerId);
  return params;
}
