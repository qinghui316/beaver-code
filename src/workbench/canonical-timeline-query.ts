import type { WorkbenchProjectInput } from "./read-model-types.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../provider-runtime/project-harness-discovery.js";
import { resolveProjectRuntimeState } from "../project-runtime/coordinator.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type { CanonicalTimelineCursor, CanonicalTimelinePage, CanonicalTimelineScope } from "./canonical-timeline-contract.js";
import { projectCanonicalTimelineEnvelope } from "./canonical-timeline-projector.js";
import type { ProductMode } from "../provider-runtime/index.js";

const DEFAULT_TIMELINE_PAGE_LIMIT = 100;
const MAX_TIMELINE_PAGE_LIMIT = 500;
const TIMELINE_CURSOR_PREFIX = "canonical-timeline-v1:";

export async function getCanonicalTimelinePage(
  input: WorkbenchProjectInput,
  conversationId: string,
  agentSurfaceId: string,
  productMode: ProductMode,
  options: { limit?: number; beforeCursor?: string } = {},
): Promise<CanonicalTimelinePage> {
  if (!input.project) throw notFound(`Conversation not found: ${conversationId}.`);
  const state = input.runtimeStateResolver
    ? await input.runtimeStateResolver(input.project)
    : await resolveProjectRuntimeState(input.project, { discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY });
  const paths = state.state === "onboarding" ? state.paths : state.resolution.paths;
  const scope = { projectId: paths.projectId, conversationId, agentSurfaceId };
  const limit = normalizePageLimit(options.limit);
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const cursor = options.beforeCursor ? decodeCanonicalTimelineCursor(options.beforeCursor, scope) : undefined;
    const snapshot = database.timeline.readTimelineSurfacePageSnapshot(scope.projectId, conversationId, agentSurfaceId, {
      beforePosition: cursor?.beforePosition,
      limit,
    });
    if (!snapshot) throw notFound(`Conversation not found: ${conversationId}.`);
    if (snapshot.conversation.productMode !== productMode) {
      const error = new Error("Conversation productMode does not match the requested mode.");
      error.name = "Conflict";
      throw error;
    }
    if (cursor && cursor.watermarkRevision > snapshot.conversation.timelineRevision) throw invalidCursor();
    const firstPosition = snapshot.rows[0]?.position;
    const watermark = snapshot.conversation.timelineRevision;
    return {
      projectId: scope.projectId,
      productMode,
      conversationId,
      agentSurfaceId,
      watermark,
      pinned: snapshot.pinnedRows.map((row) => projectCanonicalTimelineEnvelope(row, productMode, (id) => database.timeline.readMessage(scope.projectId, conversationId, id))),
      entries: snapshot.rows.map((row) => projectCanonicalTimelineEnvelope(row, productMode, (id) => database.timeline.readMessage(scope.projectId, conversationId, id))),
      paging: {
        limit,
        totalCount: snapshot.totalCount,
        hasMoreBefore: snapshot.hasMoreBefore,
        ...(snapshot.hasMoreBefore && firstPosition !== undefined ? {
          nextBeforeCursor: encodeCanonicalTimelineCursor({ ...scope, beforePosition: firstPosition, watermarkRevision: watermark }),
        } : {}),
      },
    };
  } finally {
    database.close();
  }
}

export function encodeCanonicalTimelineCursor(cursor: CanonicalTimelineCursor): string {
  return `${TIMELINE_CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

export function decodeCanonicalTimelineCursor(cursor: string, expectedScope: CanonicalTimelineScope): CanonicalTimelineCursor {
  if (!cursor.startsWith(TIMELINE_CURSOR_PREFIX)) throw invalidCursor();
  try {
    const decoded = JSON.parse(Buffer.from(cursor.slice(TIMELINE_CURSOR_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!isRecord(decoded)
      || decoded.projectId !== expectedScope.projectId
      || decoded.conversationId !== expectedScope.conversationId
      || decoded.agentSurfaceId !== expectedScope.agentSurfaceId
      || !isPositiveSafeInteger(decoded.beforePosition)
      || !isNonNegativeSafeInteger(decoded.watermarkRevision)) throw invalidCursor();
    return decoded as unknown as CanonicalTimelineCursor;
  } catch (error) {
    if (error instanceof Error && error.name === "BadRequest") throw error;
    throw invalidCursor();
  }
}

function normalizePageLimit(value?: number): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_TIMELINE_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_TIMELINE_PAGE_LIMIT, Math.trunc(value)));
}

function invalidCursor(): Error {
  const error = new Error("Invalid canonical Timeline cursor.");
  error.name = "BadRequest";
  return error;
}

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFound";
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
