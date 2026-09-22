import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { openNativeFolderDialog } from "./native-dialog.js";
import { matchProjectWorkbenchRoute } from "./routes.js";
import { resolveProjectInputWithDirect } from "./direct-project.js";
import { listConversationManagement, type ManagementMode, type ManagementState } from "./conversation-management.js";
import { getRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { getRuntimeActivityLog } from "./runtime-activity-log.js";
import { defaultProviderRegistry, type ProductMode } from "../../provider-runtime/index.js";
import type { ProviderRegistry } from "../../provider-runtime/registry.js";
import { listProjectFileChildren, readProjectFilePreview, searchProjectFiles } from "../../workbench/file-references.js";
import { resolveWorkspaceResource, type WorkspaceResourceTarget } from "../../workbench/workspace-resources.js";
import { createTopicAttachment, deleteTopicAttachment, toTopicAttachmentEvidence } from "../../workbench/attachments.js";
import { getProjectGitCommitDetail, getProjectGitCommitDiff, getProjectGitDiff, getProjectGitHistory, getProjectGitReviewOptions, getProjectGitStatus } from "../../workbench/git-panel.js";
import { addSkillRoot, listSkillRoots, listSkills, setSkillEnabled, type SkillCatalogResult } from "../../skill/catalog.js";
import { hashNativeSkillPackageContent } from "../../skill/content-hash.js";
import { getSystemSkillsRoot } from "../../template-source/paths.js";
import type { ManagedProject } from "../../types/index.js";
import { addExistingProject, createNewProject, listProjectStatuses, prepareRegisteredProjectRemoval, removeRegisteredProject } from "./project-admin.js";
import { handleDirectWorkbenchApi } from "./direct-routes.js";
import { handleProjectWorkbenchApi } from "./project-routes.js";
import { handleTerminalApi } from "./terminal-routes.js";
import { assertConfirmed, assertLocalWorkbenchRequest, assertRegisteredProject, readJsonBody, requireProductMode, sendJson } from "./http.js";
import type { AddExistingProjectRequest, CreateNewProjectRequest, RemoveProjectRequest, WorkbenchServerContext } from "./types.js";
import type { ProviderSkillInput } from "../../project-harness/contracts.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../workbench/persistence/open-workbench-database.js";
import type { ProjectRuntimePaths } from "../../project-runtime/paths.js";
import { DESKTOP_MENU_IDS, isDesktopMenuOpenRequest } from "../../types/desktop-shell.js";

const AGENT_HIDDEN_SKILL_NAMES = new Set([
  "aho-main-orchestration",
  "aho-harness-engineering",
  "aho-workflow-authoring",
]);

export async function handleApi(context: WorkbenchServerContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const trackedProjectId = projectIdForTrackedRequest(url.pathname)
    ?? directProjectIdForTrackedRequest(context, url.pathname);
  const lease = trackedProjectId
    ? context.projectRemoval.beginProjectRequest(trackedProjectId, response, {
      stream: isProjectStreamingRequest(url.pathname),
    })
    : null;
  try {
    if (trackedProjectId) await context.ensureProjectRecovered(trackedProjectId);
    await handleApiRequest(context, request, response, url);
  } finally {
    lease?.complete();
  }
}

async function handleApiRequest(context: WorkbenchServerContext, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  if (request.method !== "GET") {
    assertLocalWorkbenchRequest(request);
    await assertProjectMutationAvailable(context, url.pathname);
  }

  const projectWorkbench = matchProjectWorkbenchRoute(url.pathname);
  if (projectWorkbench) {
    const resolvedInput = await resolveProjectInputWithDirect(context.store, context.input, projectWorkbench.projectId);
    const input = {
      ...resolvedInput,
      runtimeStateResolver: (project: ManagedProject) => context.projectRuntimeCoordinator.resolve(project),
      turnControlStateResolver: (projectId: string, conversationId: string, attemptId?: string) => context.turnControl.state(projectId, conversationId, attemptId),
      activeProviderTurnResolver: (conversationId: string) => Boolean(context.providerRegistry.findActiveTurn(conversationId)),
      conversationContextSnapshotResolver: (project: ManagedProject, productMode: ProductMode, conversationId: string) => context.conversationContext.read(project, productMode, conversationId),
      conversationLifecycleSnapshotResolver: (project: ManagedProject, productMode: ProductMode, conversationId: string) => context.conversationLifecycle.read(project, productMode, conversationId),
      conversationLifecycleSnapshotsResolver: (project: ManagedProject, productMode: ProductMode) => context.conversationLifecycle.readMany(project, productMode),
    };
    await handleProjectWorkbenchApi(context, input, request, response, projectWorkbench.rest, url);
    return;
  }

  if (await handleTerminalApi(context, request, response, url)) return;

  if (request.method === "GET" && url.pathname === "/api/app/status") {
    sendJson(response, 200, { mode: context.input ? "project" : "app", directProjectId: context.input?.project?.id ?? null,
      ...(context.updateChannel ? { desktopUpdates: true } : {}),
      ...(context.desktopHost?.openMenu ? { desktopShell: { available: true, menus: [...DESKTOP_MENU_IDS] } } : {}) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/desktop/menu/open") {
    const body = await readJsonBody<unknown>(request);
    if (!context.desktopHost?.openMenu) {
      sendJson(response, 404, { error: "Desktop menu is unavailable." });
      return;
    }
    if (!isDesktopMenuOpenRequest(body)) {
      const error = new Error("Desktop menu request is invalid.");
      error.name = "BadRequest";
      throw error;
    }
    sendJson(response, 200, await context.desktopHost.openMenu(body));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/runtime/diagnostics") {
    sendJson(response, 200, await getRuntimeDiagnostics(context, null));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/providers/capabilities") {
    const productMode = requireProductMode(url.searchParams.get("productMode"));
    const runtimeSummaries = await Promise.all(context.providerRegistry.list().map((provider) => provider.runtimeSummary(null, productMode)));
    sendJson(response, 200, { providers: runtimeSummaries.map((summary) => summary.snapshot), runtimeSummaries });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/providers") {
    sendJson(response, 200, { providers: context.providerRegistry.list().map((provider) => ({ providerId: provider.id, displayName: provider.displayName })) });
    return;
  }
  const globalProviderSurface = url.pathname.match(/^\/api\/providers\/([^/]+)\/(diagnostics|models)$/);
  if (globalProviderSurface?.[1] && globalProviderSurface[2]) {
    const provider = context.providerRegistry.get(decodeURIComponent(globalProviderSurface[1]));
    if (request.method === "GET" && globalProviderSurface[2] === "diagnostics") {
      sendJson(response, 200, await provider.diagnostics(null));
      return;
    }
    if (globalProviderSurface[2] === "models" && (request.method === "GET" || request.method === "POST")) {
      const selected = request.method === "POST" ? (await readJsonBody<{ selectedModel?: string | null }>(request)).selectedModel ?? null : undefined;
      sendJson(response, 200, selected === undefined ? await provider.models.read() : await provider.models.select(selected));
      return;
    }
  }
  if (request.method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, { projects: await listProjectStatuses(context.store, context.input, context.projectRuntimeCoordinator) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workbench/conversation-management") {
    const scope = url.searchParams.get("scope");
    const productMode = url.searchParams.get("productMode");
    const state = url.searchParams.get("state");
    const search = url.searchParams.get("search")?.trim() ?? "";
    if ((scope !== "project" && scope !== "all")
      || (productMode !== "agent" && productMode !== "harness" && productMode !== "all")
      || (state !== "active" && state !== "archive" && state !== "all")
      || search.length > 200) {
      const error = new Error("Invalid conversation management filters.");
      error.name = "BadRequest";
      throw error;
    }
    sendJson(response, 200, await listConversationManagement({
      store: context.store, directInput: context.input, coordinator: context.projectRuntimeCoordinator,
      scope, projectId: url.searchParams.get("projectId"),
      productMode: productMode as ManagementMode, state: state as ManagementState,
      search, cursor: url.searchParams.get("cursor"),
      activeTurn: (projectId, conversationId) => context.turnControl.state(projectId, conversationId).state !== "idle"
        || Boolean(context.providerRegistry.findActiveTurn(conversationId)),
    }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/projects") {
    const result = await addExistingProject(
      context.store,
      await readJsonBody<AddExistingProjectRequest>(request),
      context.projectRuntimeCoordinator,
      context.projectRemoval,
    );
    sendJson(response, 200, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/projects/new") {
    const result = await createNewProject(
      context.store,
      await readJsonBody<CreateNewProjectRequest>(request),
      context.projectRuntimeCoordinator,
      context.projectRemoval,
    );
    sendJson(response, 200, result);
    return;
  }
  const projectRemovalConfirmationMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/removal-confirmation$/);
  if (request.method === "POST" && projectRemovalConfirmationMatch?.[1]) {
    sendJson(response, 200, await prepareRegisteredProjectRemoval(
      context.projectRemoval,
      decodeURIComponent(projectRemovalConfirmationMatch[1]),
    ));
    return;
  }
  const projectRemoveMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/remove$/);
  if (request.method === "POST" && projectRemoveMatch?.[1]) {
    const projectId = decodeURIComponent(projectRemoveMatch[1]);
    sendJson(response, 200, await removeRegisteredProject(context.projectRemoval, projectId, await readJsonBody<RemoveProjectRequest>(request)));
    if (context.input?.project?.id === projectId) context.input = null;
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/dialog/open-folder") {
    sendJson(response, 200, await openNativeFolderDialog(context.desktopHost?.openFolder));
    return;
  }
  const runtimeDiagnosticsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runtime\/diagnostics$/);
  if (request.method === "GET" && runtimeDiagnosticsMatch?.[1]) {
    sendJson(response, 200, await getRuntimeDiagnostics(context, decodeURIComponent(runtimeDiagnosticsMatch[1])));
    return;
  }
  const runtimeActivityMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runtime\/activity$/);
  if (request.method === "GET" && runtimeActivityMatch?.[1]) {
    sendJson(response, 200, await getRuntimeActivityLog(context, decodeURIComponent(runtimeActivityMatch[1]), {
      topicId: url.searchParams.get("topicId"),
      limit: Number(url.searchParams.get("limit") ?? undefined),
    }));
    return;
  }
  const providerCapabilitiesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/providers\/capabilities$/);
  if (request.method === "GET" && providerCapabilitiesMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(providerCapabilitiesMatch[1]));
    const productMode = requireProductMode(url.searchParams.get("productMode"));
    const runtimeSummaries = await Promise.all(context.providerRegistry.list().map((provider) => provider.runtimeSummary(input.project, productMode, input.path)));
    sendJson(response, 200, { providers: runtimeSummaries.map((summary) => summary.snapshot), runtimeSummaries });
    return;
  }
  const projectProviderDefaultMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/provider-default$/);
  if (request.method === "POST" && projectProviderDefaultMatch?.[1]) {
    const projectId = decodeURIComponent(projectProviderDefaultMatch[1]);
    const body = await readJsonBody<{ providerId?: string | null }>(request);
    if (body.providerId) context.providerRegistry.get(body.providerId);
    sendJson(response, 200, { project: await context.store.setDefaultProvider(projectId, body.providerId ?? null) });
    return;
  }
  const projectProviderSurface = url.pathname.match(/^\/api\/projects\/([^/]+)\/providers\/([^/]+)\/(diagnostics|models)$/);
  if (projectProviderSurface?.[1] && projectProviderSurface[2] && projectProviderSurface[3]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(projectProviderSurface[1]));
    const provider = context.providerRegistry.get(decodeURIComponent(projectProviderSurface[2]));
    if (request.method === "GET" && projectProviderSurface[3] === "diagnostics") {
      sendJson(response, 200, await provider.diagnostics(input.project, input.path));
      return;
    }
    if (projectProviderSurface[3] === "models" && (request.method === "GET" || request.method === "POST")) {
      const selected = request.method === "POST" ? (await readJsonBody<{ selectedModel?: string | null }>(request)).selectedModel ?? null : undefined;
      sendJson(response, 200, selected === undefined ? await provider.models.read(input.path) : await provider.models.select(selected, input.path));
      return;
    }
  }
  const projectProviderAction = url.pathname.match(/^\/api\/projects\/([^/]+)\/providers\/([^/]+)\/actions\/([^/]+)$/);
  if (request.method === "POST" && projectProviderAction?.[1] && projectProviderAction[2] && projectProviderAction[3]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(projectProviderAction[1]));
    assertRegisteredProject(input);
    assertConfirmed((await readJsonBody<{ confirm?: boolean }>(request)).confirm);
    const provider = context.providerRegistry.get(decodeURIComponent(projectProviderAction[2]));
    sendJson(response, 200, await provider.projectActions.execute(decodeURIComponent(projectProviderAction[3]), input.project, input.path));
    return;
  }
  const fileSearchMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/search$/);
  if (request.method === "GET" && fileSearchMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(fileSearchMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project file search requires a selected project." });
      return;
    }
    const limit = Number(url.searchParams.get("limit") ?? undefined);
    sendJson(response, 200, {
      files: await searchProjectFiles(input.project, {
        query: url.searchParams.get("q") ?? "",
        limit,
      }),
    });
    return;
  }
  const attachmentCreateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/attachments$/);
  if (request.method === "POST" && attachmentCreateMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(attachmentCreateMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Composer attachments require a selected project." });
      return;
    }
    try {
      const body = await readJsonBody<{ fileName?: string; mediaType?: string; data?: string }>(request);
      const attachment = await createTopicAttachment(input.project, body, {
          workbenchRoot: context.projectRuntimeCoordinator.runtimePaths(input.project.id).workbenchRoot,
      });
      sendJson(response, 200, { attachment: toTopicAttachmentEvidence(attachment) });
    } catch (error) {
      sendJson(response, error instanceof Error && error.name === "BadRequest" ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const attachmentDeleteMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/attachments\/([^/]+)$/);
  if (request.method === "DELETE" && attachmentDeleteMatch?.[1] && attachmentDeleteMatch?.[2]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(attachmentDeleteMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Composer attachments require a selected project." });
      return;
    }
    try {
      sendJson(response, 200, await deleteTopicAttachment(input.project, decodeURIComponent(attachmentDeleteMatch[2]), {
        workbenchRoot: context.projectRuntimeCoordinator.runtimePaths(input.project.id).workbenchRoot,
      }));
    } catch (error) {
      sendJson(response, error instanceof Error && error.name === "BadRequest" ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const fileChildrenMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/children$/);
  if (request.method === "GET" && fileChildrenMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(fileChildrenMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project file tree requires a selected project." });
      return;
    }
    try {
      sendJson(response, 200, await listProjectFileChildren(input.project, url.searchParams.get("path") ?? ""));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const workspaceResourceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/workspace-resources\/resolve$/);
  if (request.method === "POST" && workspaceResourceMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(workspaceResourceMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Workspace resources require a selected project." });
      return;
    }
    try {
      const body = await readJsonBody<{ target?: WorkspaceResourceTarget }>(request);
      if (!body.target) throw new Error("Workspace resource target is required.");
      sendJson(response, 200, await resolveWorkspaceResource({ ...input, project: input.project }, body.target));
    } catch (error) {
      const status = error instanceof Error && error.name === "NotFound" ? 404 : 400;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const filePreviewMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/preview$/);
  if (request.method === "GET" && filePreviewMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(filePreviewMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project file preview requires a selected project." });
      return;
    }
    sendJson(response, 200, await readProjectFilePreview(input.project, url.searchParams.get("path") ?? ""));
    return;
  }
  const gitStatusMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/status$/);
  if (request.method === "GET" && gitStatusMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(gitStatusMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project Git status requires a selected project." });
      return;
    }
    sendJson(response, 200, await getProjectGitStatus(input.project));
    return;
  }
  const gitReviewOptionsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/review-options$/);
  if (request.method === "GET" && gitReviewOptionsMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(gitReviewOptionsMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project Code Review options require a selected project." });
      return;
    }
    sendJson(response, 200, await getProjectGitReviewOptions(input.project));
    return;
  }
  const gitDiffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/diff$/);
  if (request.method === "GET" && gitDiffMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(gitDiffMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project Git diff requires a selected project." });
      return;
    }
    sendJson(response, 200, await getProjectGitDiff(input.project, url.searchParams.get("path") ?? ""));
    return;
  }
  const gitHistoryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/history$/);
  if (request.method === "GET" && gitHistoryMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(gitHistoryMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project Git history requires a selected project." });
      return;
    }
    sendJson(response, 200, await getProjectGitHistory(input.project, {
      limit: Number.parseInt(url.searchParams.get("limit") ?? "", 10),
      offset: Number.parseInt(url.searchParams.get("offset") ?? "", 10),
      query: url.searchParams.get("query") ?? "",
    }));
    return;
  }
  const gitCommitMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/commit$/);
  if (request.method === "GET" && gitCommitMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(gitCommitMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project Git commit requires a selected project." });
      return;
    }
    sendJson(response, 200, await getProjectGitCommitDetail(input.project, url.searchParams.get("sha") ?? ""));
    return;
  }
  const gitCommitDiffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/git\/commit-diff$/);
  if (request.method === "GET" && gitCommitDiffMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(gitCommitDiffMatch[1]));
    if (!input.project) {
      sendJson(response, 400, { error: "Project Git commit diff requires a selected project." });
      return;
    }
    sendJson(response, 200, await getProjectGitCommitDiff(input.project, url.searchParams.get("sha") ?? "", url.searchParams.get("path") ?? ""));
    return;
  }
  const skillRootsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/skill-roots$/);
  if (skillRootsMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(skillRootsMatch[1]));
    assertRegisteredProject(input);
    if (request.method === "GET") {
      const skillContext = await resolveSkillApiContext(context, input.project, {
        productMode: requireProductMode(url.searchParams.get("productMode")),
        conversationId: url.searchParams.get("conversationId"),
        providerId: url.searchParams.get("providerId"),
      }, "read");
      sendJson(response, 200, { roots: await listSkillRoots(skillContext.paths) });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody<{ rootPath?: string; productMode?: ProductMode; conversationId?: string; providerId?: string }>(request);
      if (!body.rootPath) {
        sendJson(response, 400, { error: "rootPath is required." });
        return;
      }
      const skillContext = await resolveSkillApiContext(context, input.project, {
        productMode: requireProductMode(body.productMode),
        conversationId: body.conversationId,
        providerId: body.providerId,
      }, "mutation");
      sendJson(response, 200, { roots: await addSkillRoot(skillContext.paths, body.rootPath) });
      return;
    }
  }
  const skillsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/skills$/);
  if (skillsMatch?.[1]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(skillsMatch[1]));
    assertRegisteredProject(input);
    if (request.method === "GET") {
      const skillContext = await resolveSkillApiContext(context, input.project, skillApiQuery(url), "read");
      sendJson(response, 200, catalogResponse(await loadNativeSkillCatalog(input.project, skillContext, false)));
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody<{ productMode?: ProductMode; conversationId?: string; providerId?: string }>(request);
      const skillContext = await resolveSkillApiContext(context, input.project, {
        productMode: requireProductMode(body.productMode),
        conversationId: body.conversationId,
        providerId: body.providerId,
      }, "read");
      sendJson(response, 200, catalogResponse(await loadNativeSkillCatalog(input.project, skillContext, true)));
      return;
    }
  }
  const skillEnableMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/enable$/);
  if (request.method === "POST" && skillEnableMatch?.[1] && skillEnableMatch?.[2]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(skillEnableMatch[1]));
    assertRegisteredProject(input);
    const body = await readJsonBody<{ enabled?: boolean; conversationId?: string; productMode?: ProductMode; providerId?: string }>(request);
    const skillContext = await resolveSkillApiContext(context, input.project, {
      productMode: requireProductMode(body.productMode),
      conversationId: body.conversationId,
      providerId: body.providerId,
    }, "mutation");
    const catalog = await loadNativeSkillCatalog(input.project, skillContext, false);
    sendJson(response, 200, catalogResponseForMode(await setSkillEnabled(
      skillContext.paths,
      catalog.snapshot,
      decodeURIComponent(skillEnableMatch[2]),
      { enabled: Boolean(body.enabled), conversationId: skillContext.conversationId ?? undefined },
      skillContext.requiredInputs,
      skillContext.identityInputs,
    ), skillContext.productMode));
    return;
  }
  const providerSkillEnableMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/skills\/([^/]+)\/provider-enable$/);
  if (request.method === "POST" && providerSkillEnableMatch?.[1] && providerSkillEnableMatch[2]) {
    const input = await resolveProjectInputWithDirect(context.store, context.input, decodeURIComponent(providerSkillEnableMatch[1]));
    assertRegisteredProject(input);
    const body = await readJsonBody<{ productMode?: ProductMode; conversationId?: string; providerId?: string; enabled?: boolean }>(request);
    const skillContext = await resolveSkillApiContext(context, input.project, {
      productMode: requireProductMode(body.productMode),
      conversationId: body.conversationId,
      providerId: body.providerId,
    }, "mutation");
    const before = await loadNativeSkillCatalog(input.project, skillContext, false);
    const skillId = decodeURIComponent(providerSkillEnableMatch[2]);
    const skill = before.skills.find((item) => item.skillId === skillId);
    if (!skill) throw new Error(`Unknown native Skill: ${skillId}`);
    if (skill.required || skill.runtimeAssigned || skill.sourceKind === "project-harness") {
      throw new Error(`Skill ${skillId} is assigned by the Runtime and cannot be disabled.`);
    }
    await skillContext.provider.skills.setEnabled({ projectPath: input.project.path, path: skill.sourcePath, enabled: Boolean(body.enabled) });
    sendJson(response, 200, catalogResponse(await loadNativeSkillCatalog(input.project, skillContext, true)));
    return;
  }

  if (await handleDirectWorkbenchApi(context, request, response, url)) return;
  sendJson(response, 404, { error: "Not found." });
}

async function assertProjectMutationAvailable(context: WorkbenchServerContext, pathname: string): Promise<void> {
  if (/^\/api\/projects\/[^/]+\/(?:removal-confirmation|remove)$/.test(pathname)) return;
  const projectId = projectIdForTrackedRequest(pathname)
    ?? directProjectIdForTrackedRequest(context, pathname);
  if (!projectId) return;
  const input = await resolveProjectInputWithDirect(context.store, context.input, projectId);
  if (input.project) await context.projectRuntimeCoordinator.resolve(input.project);
}

export function resolveProjectSkillProvider(project: { defaultProviderId?: string }, requestedProviderId?: string | null, registry: ProviderRegistry = defaultProviderRegistry) {
  const providerId = requestedProviderId || project.defaultProviderId;
  if (providerId) return registry.get(providerId);
  return registry.requireOnly();
}

async function loadNativeSkillCatalog(
  project: ManagedProject,
  context: SkillApiContext,
  forceReload: boolean,
) {
  const roots = await listSkillRoots(context.paths);
  const snapshot = await context.provider.skills.list({
    projectPath: project.path,
    extraRoots: [
      getSystemSkillsRoot(),
      ...roots.map((root) => root.rootPath),
    ],
    forceReload,
  });
  const catalog = await listSkills(context.paths, snapshot, context.requiredInputs, context.identityInputs);
  return {
    ...catalog,
    skills: catalogResponseForMode(catalog, context.productMode).skills,
    snapshot,
  };
}


interface SkillApiContext {
  productMode: ProductMode;
  conversationId: string | null;
  paths: ProjectRuntimePaths;
  provider: ReturnType<typeof resolveProjectSkillProvider>;
  identityInputs: ProviderSkillInput[];
  requiredInputs: ProviderSkillInput[];
}

function skillApiQuery(url: URL): { productMode: ProductMode; conversationId: string | null; providerId: string | null } {
  return {
    productMode: requireProductMode(url.searchParams.get("productMode")),
    conversationId: url.searchParams.get("conversationId"),
    providerId: url.searchParams.get("providerId"),
  };
}

async function resolveSkillApiContext(
  context: WorkbenchServerContext,
  project: ManagedProject,
  request: { productMode: ProductMode; conversationId?: string | null; providerId?: string | null },
  access: "read" | "mutation",
): Promise<SkillApiContext> {
  const state = await context.projectRuntimeCoordinator.resolve(project);
  if (request.productMode === "harness" && state.state !== "ready") {
    throw new Error(`Project Harness onboarding is incomplete for ${project.id}.`);
  }
  const paths = state.state === "onboarding" ? state.paths : state.resolution.paths;
  const identityInputs = state.state === "onboarding" ? [] : [state.resolution.providerInput];
  let conversationId = request.conversationId?.trim() || null;
  let authoritativeProviderId = request.providerId?.trim() || null;
  if (conversationId) {
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, conversationId);
      if (!conversation || conversation.deletedAt) {
        const error = new Error(`Conversation not found: ${conversationId}.`);
        error.name = "NotFound";
        throw error;
      }
      if (conversation.productMode !== request.productMode) throw skillApiConflict("Conversation productMode does not match the Skill request mode.");
      if (authoritativeProviderId && authoritativeProviderId !== conversation.selectedProviderId) {
        throw skillApiConflict("Conversation Provider does not match the Skill request Provider.");
      }
      if (access === "mutation" && conversation.state !== "active") {
        throw skillApiConflict("Archived Conversation Skill settings are read-only.");
      }
      conversationId = conversation.conversationId;
      authoritativeProviderId = conversation.selectedProviderId;
    } finally {
      database.close();
    }
  }
  const provider = resolveProjectSkillProvider(project, authoritativeProviderId, context.providerRegistry);
  const requiredInputs = request.productMode === "harness"
    ? [...identityInputs, await mainOrchestrationSkillInput()]
    : [];
  return { productMode: request.productMode, conversationId, paths, provider, identityInputs, requiredInputs };
}

async function mainOrchestrationSkillInput(): Promise<ProviderSkillInput> {
  const root = join(getSystemSkillsRoot(), "aho-main-orchestration");
  return {
    id: "aho-main-orchestration",
    path: join(root, "SKILL.md"),
    contentHash: await hashNativeSkillPackageContent(root),
    source: "aho-system",
    required: true,
  };
}

function skillApiConflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function catalogResponse(result: SkillCatalogResult & { snapshot: unknown }): SkillCatalogResult {
  return { roots: result.roots, skills: result.skills, errors: result.errors };
}

function catalogResponseForMode(result: SkillCatalogResult, productMode: ProductMode): SkillCatalogResult {
  return productMode === "agent"
    ? { ...result, skills: result.skills.filter((skill) => !AGENT_HIDDEN_SKILL_NAMES.has(skill.name)) }
    : result;
}

function projectIdForTrackedRequest(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2] || match[2] === "remove" || match[2] === "removal-confirmation") return null;
  return decodeURIComponent(match[1]);
}

function directProjectIdForTrackedRequest(context: WorkbenchServerContext, pathname: string): string | null {
  if (!context.input?.project || !pathname.startsWith("/api/workbench/")) return null;
  return context.input.project.id;
}

function isProjectStreamingRequest(pathname: string): boolean {
  return /\/(?:live|settle|events)$/.test(pathname);
}
