import { fetchJson, postJson } from "../api.js";
import type { ConversationAccessApi, ConversationAccessIdentity, ConversationAccessSelection } from "./conversation-access-contract.js";

function path(identity: ConversationAccessIdentity): string {
  return `/api/projects/${encodeURIComponent(identity.projectId)}/conversations/${encodeURIComponent(identity.conversationId!)}/access`;
}

export const conversationAccessApi: ConversationAccessApi = {
  read: async (identity) => selection(await fetchJson<unknown>(`${path(identity)}?${new URLSearchParams({ productMode: "agent", providerId: identity.providerId })}`), identity),
  save: async (identity, selected, accessMode, confirmFullAccess) => selection(await postJson<unknown>(path(identity), {
    productMode: "agent", providerId: identity.providerId, accessMode,
    expectedRevision: selected.revision, confirmFullAccess,
  }), identity),
};

function selection(value: unknown, identity: ConversationAccessIdentity): ConversationAccessSelection {
  if (!value || typeof value !== "object") throw new Error("权限设置暂时无法读取。");
  const candidate = value as Partial<ConversationAccessSelection>;
  if ((candidate.accessMode !== "default" && candidate.accessMode !== "full-access")
    || candidate.providerId !== identity.providerId || !Number.isSafeInteger(candidate.revision)
    || candidate.revision! < 0) throw new Error("权限设置暂时无法读取。");
  return { accessMode: candidate.accessMode, revision: candidate.revision!, providerId: candidate.providerId };
}
