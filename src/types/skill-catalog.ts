import type { SkillListItem, SkillRootListItem } from "../skill/catalog.js";

export type SkillCatalogScope =
  | { kind: "global"; providerId: string }
  | { kind: "project"; projectId: string; providerId: string };

export interface ManagedSkillCatalogItem extends SkillListItem {
  catalogId: string;
  sourceIdentity: string;
  catalogScope: SkillCatalogScope;
  canChangeProviderEnabled: boolean;
  lockReason: string | null;
}

export interface ManagedSkillCatalog {
  scope: SkillCatalogScope;
  roots: SkillRootListItem[];
  skills: ManagedSkillCatalogItem[];
  errors: Array<{ path: string; message: string }>;
}

export interface SkillConfigurationChange {
  enabled: boolean;
  expectedEnabled?: boolean;
  sourceIdentity?: string;
  expectedContentHash?: string;
}
