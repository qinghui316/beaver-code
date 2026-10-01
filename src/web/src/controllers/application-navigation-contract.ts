import type { ProductMode, WorkspaceResourceTarget } from "../types.js";

export type ApplicationSettingsSection = "basic" | "project" | "provider" | "skills" | "conversations";
export interface ApplicationLocation {
  productMode: ProductMode;
  projectId: string | null;
  conversationId: string | null;
  surface: "workspace" | "settings" | "orchestration";
  settingsSection: ApplicationSettingsSection;
  resource: WorkspaceResourceTarget | null;
}

export function readApplicationLocation(url: URL, fallbackMode: ProductMode): ApplicationLocation {
  const params = url.searchParams;
  const mode = params.get("mode");
  const projectId = identity(params.get("project"));
  const conversationId = projectId ? identity(params.get("topic")) : null;
  const tab = params.get("tab");
  const section = params.get("settings");
  const settingsSection = section === "skills" || section === "conversations" ? section : "provider";
  return { productMode: mode === "agent" || mode === "harness" ? mode : fallbackMode,
    projectId, conversationId, surface: tab === "settings" ? "settings"
      : tab === "orchestration" && conversationId ? "orchestration" : "workspace", settingsSection,
    resource: projectId ? readResource(params.get("resource"), conversationId) : null };
}

export function applicationLocationUrl(location: ApplicationLocation, current: URL): string {
  const url = new URL(current);
  for (const name of ["project", "topic", "tab", "settings", "mode", "resource"]) url.searchParams.delete(name);
  url.searchParams.set("mode", location.productMode);
  if (location.projectId) url.searchParams.set("project", location.projectId);
  if (location.projectId && location.conversationId && !location.conversationId.startsWith("pending:")) url.searchParams.set("topic", location.conversationId);
  if (location.surface !== "workspace") url.searchParams.set("tab", location.surface);
  if (location.surface === "settings") url.searchParams.set("settings", canonicalSettingsSection(location.settingsSection));
  if (location.resource) url.searchParams.set("resource", JSON.stringify(location.resource));
  return `${url.pathname}${url.search}${url.hash}`;
}

export function canonicalSettingsSection(section: ApplicationSettingsSection): ApplicationSettingsSection {
  return section === "basic" || section === "project" ? "provider" : section;
}

export function sameApplicationLocation(left: ApplicationLocation, right: ApplicationLocation): boolean {
  return left.productMode === right.productMode && left.projectId === right.projectId
    && left.conversationId === right.conversationId && left.surface === right.surface
    && (left.surface !== "settings" || canonicalSettingsSection(left.settingsSection) === canonicalSettingsSection(right.settingsSection))
    && JSON.stringify(left.resource) === JSON.stringify(right.resource);
}

function hasControlCharacters(value: string): boolean { return [...value].some((character) => character.charCodeAt(0) < 32); }
function identity(value: string | null): string | null { return value && value.length <= 512 && !hasControlCharacters(value) ? value : null; }
function readResource(value: string | null, conversationId: string | null): WorkspaceResourceTarget | null {
  if (!value || value.length > 4096) return null;
  try {
    const target = JSON.parse(value) as Record<string, unknown>;
    if (target.kind === "project-file" && typeof target.relativePath === "string"
      && target.relativePath.length > 0 && !/^(?:[a-z]:|[/\\])/i.test(target.relativePath)
      && !target.relativePath.split(/[/\\]/).includes("..") && !hasControlCharacters(target.relativePath)) {
      return { kind: "project-file", relativePath: target.relativePath };
    }
    if (!conversationId || target.conversationId !== conversationId) return null;
    if (target.kind === "document" && typeof target.documentId === "string" && identity(target.documentId)) {
      return { kind: "document", conversationId, documentId: target.documentId };
    }
    if (target.kind === "agent" && typeof target.agentSurfaceId === "string" && identity(target.agentSurfaceId)) {
      return { kind: "agent", conversationId, agentSurfaceId: target.agentSurfaceId };
    }
  } catch { /* Malformed links must not create a resource target. */ }
  return null;
}
