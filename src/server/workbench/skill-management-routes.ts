import type { IncomingMessage, ServerResponse } from "node:http";
import { SkillManagementCatalog, subscribeSkillConfiguration } from "../../skill/management-catalog.js";
import { getSystemSkillsRoot } from "../../template-source/paths.js";
import type { SkillConfigurationChange } from "../../types/skill-catalog.js";
import { readJsonBody, sendJson } from "./http.js";
import type { WorkbenchServerContext } from "./types.js";

const catalogs = new WeakMap<WorkbenchServerContext, SkillManagementCatalog>();

export function skillManagementCatalog(context: WorkbenchServerContext): SkillManagementCatalog {
  let catalog = catalogs.get(context);
  if (!catalog) {
    catalog = new SkillManagementCatalog({ providers: context.providerRegistry,
      listProjects: async () => {
        const projects = await context.store.listProjects();
        const direct = context.input?.project;
        if (direct && !projects.some((project) => project.id === direct.id)) projects.push(direct);
        return projects;
      },
      resolveProject: (project) => context.projectRuntimeCoordinator.resolve(project), systemRoot: getSystemSkillsRoot() });
    catalogs.set(context, catalog);
  }
  return catalog;
}

export async function handleSkillManagementApi(context: WorkbenchServerContext, request: IncomingMessage,
  response: ServerResponse, url: URL): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/skills/events") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    response.write("event: ready\ndata: {}\n\n");
    const unsubscribe = subscribeSkillConfiguration((providerId) => {
      if (!response.destroyed) response.write(`event: skills.invalidated\ndata: ${JSON.stringify({ providerId })}\n\n`);
    });
    response.once("close", unsubscribe);
    return true;
  }
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/skills$/);
  if (request.method === "POST" && projectMatch && url.searchParams.get("catalog") === "management") {
    const body = await readJsonBody<{ providerId?: string }>(request);
    const providerId = resolveProvider(context, body.providerId);
    sendJson(response, 200, await skillManagementCatalog(context).read({ kind: "project",
      projectId: decodeURIComponent(projectMatch[1]!), providerId }, true));
    return true;
  }
  const projectEnable = url.pathname.match(/^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/provider-enable$/);
  if (request.method === "POST" && projectEnable && url.searchParams.get("catalog") === "management") {
    const body = await readJsonBody<SkillConfigurationChange & { providerId?: string }>(request);
    if (typeof body.enabled !== "boolean" || typeof body.expectedEnabled !== "boolean"
      || typeof body.sourceIdentity !== "string" || typeof body.expectedContentHash !== "string") {
      sendJson(response, 400, { error: "技能修改需要当前来源、内容和启用状态。" }); return true;
    }
    const providerId = resolveProvider(context, body.providerId);
    sendJson(response, 200, await skillManagementCatalog(context).setEnabled({ kind: "project",
      projectId: decodeURIComponent(projectEnable[1]!), providerId }, decodeURIComponent(projectEnable[2]!), body));
    return true;
  }
  if (request.method === "GET" && projectMatch && url.searchParams.get("catalog") === "management") {
    const providerId = resolveProvider(context, url.searchParams.get("providerId"));
    sendJson(response, 200, await skillManagementCatalog(context).read({ kind: "project",
      projectId: decodeURIComponent(projectMatch[1]!), providerId }));
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/skills") {
    const providerId = resolveProvider(context, url.searchParams.get("providerId"));
    sendJson(response, 200, await skillManagementCatalog(context).read({ kind: "global", providerId }));
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/skills/refresh") {
    const body = await readJsonBody<{ providerId?: string }>(request);
    const providerId = resolveProvider(context, body.providerId);
    sendJson(response, 200, await skillManagementCatalog(context).read({ kind: "global", providerId }, true));
    return true;
  }
  const enable = url.pathname.match(/^\/api\/skills\/([^/]+)\/provider-enable$/);
  if (request.method === "POST" && enable) {
    const body = await readJsonBody<SkillConfigurationChange & { providerId?: string }>(request);
    if (typeof body.enabled !== "boolean" || typeof body.expectedEnabled !== "boolean"
      || typeof body.sourceIdentity !== "string" || typeof body.expectedContentHash !== "string") {
      sendJson(response, 400, { error: "技能修改需要当前来源、内容和启用状态。" });
      return true;
    }
    const providerId = resolveProvider(context, body.providerId);
    sendJson(response, 200, await skillManagementCatalog(context).setEnabled({ kind: "global", providerId },
      decodeURIComponent(enable[1]!), body));
    return true;
  }
  return false;
}

function resolveProvider(context: WorkbenchServerContext, value?: string | null): string {
  return value?.trim() ? context.providerRegistry.get(value.trim()).id : context.providerRegistry.requireOnly().id;
}
