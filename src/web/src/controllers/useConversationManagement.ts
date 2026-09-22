import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, postJson } from "../api.js";
import { fetchCanonicalTimelinePage } from "../canonicalTimelineController.js";
import { userFacingErrorMessage } from "../presentation/user-facing-language.js";
import type { CanonicalTimelinePage, ConversationDeleteConfirmation, ConversationLifecycleSnapshot, ProductMode, ProjectStatus } from "../types.js";

export interface ManagementConversation {
  projectId: string;
  projectName: string;
  conversationId: string;
  productMode: ProductMode;
  title: string;
  state: "active" | "archive";
  archiveOrigin: "agent-user" | "harness-workflow" | null;
  lifecycleRevision: string;
  updatedAt: string;
  canArchive: boolean;
  canRestore: boolean;
  canDelete: boolean;
  providerSyncStatus: string;
  diagnostic: string | null;
}
type Page = {
  conversations: ManagementConversation[];
  nextCursor: string | null;
  unreadableProjects: Array<{ projectId: string; projectName: string; reason: string }>;
  partial: boolean;
};
type Filters = { scope: "project" | "all"; projectId: string; productMode: ProductMode | "all"; state: "active" | "archive" | "all"; search: string };

export function useConversationManagement(input: {
  active: boolean;
  currentProjectId: string | null;
  projects: ProjectStatus[];
  refreshVersions: Record<string, number>;
  onChanged: (item: ManagementConversation, action: "archive" | "restore" | "delete") => void;
}) {
  const [filters, setFilters] = useState<Filters>({ scope: input.currentProjectId ? "project" : "all", projectId: input.currentProjectId ?? "", productMode: "all", state: "archive", search: "" });
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ item: ManagementConversation; lifecycle: ConversationLifecycleSnapshot; pages: CanonicalTimelinePage[] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ item: ManagementConversation; token: ConversationDeleteConfirmation } | null>(null);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const deleteGeneration = useRef(0);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const projectSetKey = input.projects.map((item) => item.project?.id ?? "").sort().join("\0");
  const refreshVersion = Object.entries(input.refreshVersions).reduce((total, [key, version]) => {
    const separator = key.lastIndexOf("\0");
    const projectId = key.slice(0, separator);
    const productMode = key.slice(separator + 1);
    return (filters.scope === "all" || filters.projectId === projectId)
      && (filters.productMode === "all" || filters.productMode === productMode) ? total + version : total;
  }, 0);

  const load = useCallback(async (nextFilters: Filters, cursor: string | null = null, append = false) => {
    const request = ++generation.current;
    if (!append) {
      ++deleteGeneration.current;
      ++previewGeneration.current;
      setPreviewLoading(false);
    }
    const previewRequest = previewGeneration.current;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ ...nextFilters, ...(cursor ? { cursor } : {}) });
    try {
      const result = await fetchJson<Page>(`/api/workbench/conversation-management?${query}`);
      if (request !== generation.current) return;
      setPage((current) => append && current ? { ...result, conversations: [...current.conversations, ...result.conversations] } : result);
      if (!append) {
        const stillArchived = (item: ManagementConversation) => result.conversations.find((candidate) =>
          candidate.projectId === item.projectId && candidate.productMode === item.productMode
          && candidate.conversationId === item.conversationId && candidate.state === "archive"
          && candidate.lifecycleRevision === item.lifecycleRevision);
        const currentPreview = previewRef.current;
        if (previewRequest === previewGeneration.current) {
          if (currentPreview && !stillArchived(currentPreview.item)) {
            try {
              const { item } = currentPreview;
              const latest = await fetchJson<ConversationLifecycleSnapshot>(
                `/api/projects/${encodeURIComponent(item.projectId)}/workbench/conversations/${encodeURIComponent(item.conversationId)}/lifecycle?productMode=${item.productMode}`,
              );
              if (request !== generation.current || previewRequest !== previewGeneration.current) return;
              setPreview((current) => current && current.item.conversationId === item.conversationId
                && current.item.projectId === item.projectId && current.item.productMode === item.productMode
                && latest.state === "archived" && latest.lifecycleRevision === current.lifecycle.lifecycleRevision
                ? { ...current, lifecycle: latest } : null);
            } catch {
              if (request === generation.current && previewRequest === previewGeneration.current) setPreview(null);
            }
          } else {
            setPreview((current) => current && stillArchived(current.item) ? current : null);
          }
        }
        setDeleteConfirmation((current) => current && stillArchived(current.item) ? current : null);
      }
    } catch (cause) {
      if (request === generation.current) setError(userFacingErrorMessage(cause, "load"));
    } finally { if (request === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!input.active) { ++generation.current; ++previewGeneration.current; ++deleteGeneration.current; return; }
    const next = filters.scope === "project" && !filters.projectId && input.currentProjectId
      ? { ...filters, projectId: input.currentProjectId } : filters;
    if (next !== filters) { setFilters(next); return; }
    void load(next);
  }, [input.active, input.currentProjectId, refreshVersion, projectSetKey, filters, load]);

  const changeFilters = (patch: Partial<Filters>) => {
    ++generation.current;
    ++previewGeneration.current;
    ++deleteGeneration.current;
    setPreview(null);
    setDeleteConfirmation(null);
    setPage(null);
    setLoading(false);
    setFilters((current) => ({ ...current, ...patch,
      ...(patch.scope === "project" && !current.projectId
        ? { projectId: input.currentProjectId ?? input.projects.find((item) => item.project)?.project?.id ?? "" } : {}),
    }));
  };

  const openPreview = async (item: ManagementConversation) => {
    const request = ++previewGeneration.current;
    setPreview(null);
    setPreviewLoading(true);
    setError(null);
    try {
      const root = `/api/projects/${encodeURIComponent(item.projectId)}/workbench/conversations/${encodeURIComponent(item.conversationId)}`;
      const lifecycle = await fetchJson<ConversationLifecycleSnapshot>(`${root}/lifecycle?productMode=${item.productMode}`);
      if (request !== previewGeneration.current) return;
      if (lifecycle.lifecycleRevision !== item.lifecycleRevision || lifecycle.state !== "archived") {
        setError("会话状态已变化，列表正在更新。");
        void load(filtersRef.current);
        return;
      }
      const timeline = await fetchCanonicalTimelinePage({ projectId: item.projectId, productMode: item.productMode,
        conversationId: item.conversationId, agentSurfaceId: "main-agent" });
      if (request === previewGeneration.current) setPreview({ item, lifecycle, pages: [timeline] });
    } catch (cause) {
      if (request === previewGeneration.current) setError(userFacingErrorMessage(cause, "conversation"));
    } finally { if (request === previewGeneration.current) setPreviewLoading(false); }
  };

  const loadEarlier = async () => {
    if (!preview) return;
    const cursor = preview.pages[0]?.paging.nextBeforeCursor;
    if (!cursor) return;
    const request = previewGeneration.current;
    setPreviewLoading(true);
    try {
      const item = preview.item;
      const result = await fetchCanonicalTimelinePage({ projectId: item.projectId, productMode: item.productMode,
        conversationId: item.conversationId, agentSurfaceId: "main-agent" }, cursor);
      if (request === previewGeneration.current) setPreview((current) => current ? { ...current, pages: [result, ...current.pages] } : null);
    } catch (cause) { if (request === previewGeneration.current) setError(userFacingErrorMessage(cause, "conversation")); }
    finally { if (request === previewGeneration.current) setPreviewLoading(false); }
  };

  const settle = async (item: ManagementConversation, action: "archive" | "restore" | "delete", token?: string) => {
    const key = `${item.projectId}:${item.productMode}:${item.conversationId}`;
    if (busyKey) return;
    setBusyKey(key);
    setError(null);
    try {
      const root = `/api/projects/${encodeURIComponent(item.projectId)}/workbench/conversations/${encodeURIComponent(item.conversationId)}`;
      const latest = await fetchJson<ConversationLifecycleSnapshot>(`${root}/lifecycle?productMode=${item.productMode}`);
      if (latest.lifecycleRevision !== item.lifecycleRevision) throw new Error("会话状态已变化，请刷新后重试。");
      await postJson(`${root}/lifecycle`, {
        productMode: item.productMode, action, expectedLifecycleRevision: latest.lifecycleRevision,
        clientRequestId: `conversation-management-${crypto.randomUUID()}`,
        confirmationToken: token ?? null,
      });
      ++previewGeneration.current;
      setPreview(null);
      setDeleteConfirmation(null);
      input.onChanged(item, action);
      await load(filtersRef.current);
    } catch (cause) { setError(userFacingErrorMessage(cause, "conversation")); }
    finally { setBusyKey(null); }
  };

  const prepareDelete = async (item: ManagementConversation) => {
    const request = ++deleteGeneration.current;
    setError(null);
    setDeleteConfirmation(null);
    try {
      const token = await postJson<ConversationDeleteConfirmation>(
        `/api/projects/${encodeURIComponent(item.projectId)}/workbench/conversations/${encodeURIComponent(item.conversationId)}/lifecycle/delete-confirmation`,
        { productMode: item.productMode, expectedLifecycleRevision: item.lifecycleRevision },
      );
      if (request === deleteGeneration.current) setDeleteConfirmation({ item, token });
    } catch (cause) { if (request === deleteGeneration.current) setError(userFacingErrorMessage(cause, "conversation")); }
  };

  return { filters, changeFilters, page, loading, error, preview, previewLoading, busyKey,
    deleteConfirmation, setDeleteConfirmation, openPreview, loadEarlier, settle, prepareDelete,
    loadMore: () => page?.nextCursor ? load(filtersRef.current, page.nextCursor, true) : Promise.resolve(),
    projects: input.projects };
}
