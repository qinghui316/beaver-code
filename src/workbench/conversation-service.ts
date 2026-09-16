import { createHash, randomUUID } from "node:crypto";
import { assertAgentTurnMode, assertProductMode, type AgentTurnMode, type ProductMode } from "../provider-runtime/index.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../provider-runtime/project-harness-discovery.js";
import { readProjectHarnessChangeContext } from "../project-harness/change.js";
import { resolveProjectRuntimeState, type ProjectRuntimeState } from "../project-runtime/coordinator.js";
import type { ManagedProject } from "../types/index.js";
import {
  normalizeTopicAttachmentIds,
  resolveTopicAttachments,
  toTopicAttachmentEvidence,
  type TopicAttachment,
  type TopicAttachmentEvidence,
} from "./attachments.js";
import { resolveTopicFileReferences } from "./file-references.js";
import { validatePlanHandoffIntent } from "./plan-handoff.js";
import { hasPlanningExecutionEvidence } from "../project-runtime/planning-publication.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import { fromStoredThreadMessage } from "./conversation-thread-log.js";
import { CanonicalTimelineDelivery, publishCommittedCanonicalTimelineRow } from "./canonical-timeline-delivery.js";
import { toCanonicalTimelineMessage } from "./canonical-timeline-message.js";
import { resolveProviderSwitchWorkflowResumeRequest, type ProviderSwitchResult } from "./provider-switch.js";
import { resolveConversationId } from "./conversation-identity.js";
import { runWorkbenchWorkflowAction } from "./workflow-conversation-bridge.js";
import type { NewConversationSkillOverride, TopicMessageInput, TopicMessageResult, TopicThreadEntry, ValidatedPlanHandoffIntent, WorkbenchLiveSink } from "./types.js";
import { publishAgentSurfacesInvalidated, publishProjectLiveEvent } from "./project-live-events.js";
import type { WorkbenchDatabase } from "./persistence/database.js";
import type { StoredConversation, StoredTopicMessage } from "./persistence/contracts.js";
import { createConversationGraphScopeId } from "./conversation-graph-scope.js";
import type { ConversationTurnRoutingPort } from "./conversation-turn-contract.js";

export type { ConversationTurnRoutingPort } from "./conversation-turn-contract.js";

export interface CreateWorkbenchConversationInput {
  body?: string;
  contextRefs?: TopicMessageInput["contextRefs"];
  attachmentIds?: string[];
  providerId?: string;
  productMode: ProductMode;
  clientRequestId: string;
  skillOverrides?: NewConversationSkillOverride[];
  agentTurnMode?: AgentTurnMode;
  modelId?: string | null;
  reasoningEffort?: string | null;
}

export interface PreparedWorkbenchConversation {
  projectId: string;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
  clientRequestId: string;
  skillOverrides: NewConversationSkillOverride[];
  resolvedText: string;
  contextRefs: NonNullable<TopicMessageInput["contextRefs"]>;
  attachments: TopicAttachmentEvidence[];
  runtimeAttachments: TopicAttachment[] | null;
  title: string;
  body: string;
  conversationId: string;
  graphScopeId: string;
  selectedProviderId: string;
  requestHash: string;
  admission: Awaited<ReturnType<ConversationTurnRoutingPort["admit"]>> | null;
  replayed: boolean;
  requestSignature: string;
}

type NormalizedTopicMessageInput = Required<Pick<TopicMessageInput, "mode" | "message">> & {
  clientRequestId?: string;
  requestHash?: string;
  contextRefs?: TopicMessageInput["contextRefs"];
  attachments?: TopicAttachment[];
  planHandoffIntent?: TopicMessageInput["planHandoffIntent"];
  providerId?: string;
  providerSwitchIntent: "resume-workflow" | "conversation-only";
  agentSurfaceId?: string;
  agentTurnMode?: AgentTurnMode;
  modelId?: string | null;
  reasoningEffort?: string | null;
  skillOverrides: NewConversationSkillOverride[];
  queuedTurnDispatch?: TopicMessageInput["queuedTurnDispatch"];
};

export interface PreparedConversationMessage {
  projectId: string;
  requestedConversationId: string;
  conversationId: string;
  requestedMode?: ProductMode;
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>;
  parsed: NormalizedTopicMessageInput;
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
  admission: Awaited<ReturnType<ConversationTurnRoutingPort["admit"]>> | null;
  requestSignature: string;
  requestHash: string | null;
  replay: TopicMessageResult | null;
}

interface ConversationMessageFlight {
  requestHash: string;
  promise: Promise<TopicMessageResult>;
}

interface ConversationMessageExecutionFlight {
  promise: Promise<TopicMessageResult>;
}

interface ConversationMessagePreparationFlight {
  requestHash: string;
  promise: Promise<PreparedConversationMessage>;
  expiry: ReturnType<typeof setTimeout> | null;
}

const conversationMessageFlights = new Map<string, ConversationMessageFlight>();
const conversationMessageExecutionFlights = new Map<string, ConversationMessageExecutionFlight>();
const conversationMessagePreparationFlights = new Map<string, ConversationMessagePreparationFlight>();

export async function createWorkbenchConversation(
  project: ManagedProject,
  input: CreateWorkbenchConversationInput,
  live?: WorkbenchLiveSink,
  options: { runMainAgent?: boolean; turnRouter?: ConversationTurnRoutingPort; runtimeStateResolver?: (project: ManagedProject) => Promise<ProjectRuntimeState>; prepared?: PreparedWorkbenchConversation } = {},
): Promise<{
  conversationId: string;
  title: string;
  state: "active" | "archive";
  productMode: ProductMode;
  clientRequestId: string;
  replayed: boolean;
  selectedProviderId: string;
  agentTurnMode: AgentTurnMode | null;
  agentModelId: string | null;
  agentReasoningEffort: string | null;
}> {
  const turnRouter = options.turnRouter;
  if (options.runMainAgent !== false) requireComposedTurnRouter(turnRouter);
  const prepared = options.prepared ?? await prepareWorkbenchConversation(project, input, {
    runMainAgent: options.runMainAgent,
    turnRouter,
    runtimeStateResolver: options.runtimeStateResolver,
  });
  assertPreparedCreateIdentity(project, input, prepared);
  const {
    productMode,
    agentTurnMode,
    modelId,
    reasoningEffort,
    clientRequestId,
    skillOverrides,
    attachments,
    runtimeAttachments,
    title,
    body,
    conversationId,
    graphScopeId,
    selectedProviderId,
    requestHash,
  } = prepared;
  const resolved = { text: prepared.resolvedText, contextRefs: prepared.contextRefs };
  const now = new Date().toISOString();
  const persistence = await openProjectConversationDatabase(
    project,
    options.runtimeStateResolver ?? turnRouter?.resolveRuntimeState,
    options.runMainAgent === false && !turnRouter,
  );
  const database = persistence.database;
  let creation: ReturnType<WorkbenchDatabase["unitOfWork"]["createConversationFromFirstSend"]>;
  let pendingAdmission: Awaited<ReturnType<ConversationTurnRoutingPort["admit"]>> | null = null;
  try {
    const existing = database.conversations.readConversationByClientCreateRequestId(persistence.projectId, clientRequestId);
    if (existing) {
      assertExistingCreateReplay(existing, prepared);
      creation = { conversation: existing, message: null, replayed: true };
    } else {
      const admission = prepared.admission;
      if (!runtimeAttachments) throw conflict("Prepared Conversation Turn is missing runtime attachment inputs.");
      creation = database.unitOfWork.createConversationFromFirstSend({
        conversation: {
          projectId: persistence.projectId,
          conversationId,
          productMode,
          agentTurnMode,
          agentModelId: modelId,
          agentReasoningEffort: reasoningEffort,
          clientCreateRequestId: clientRequestId,
          clientCreateRequestHash: requestHash,
          title,
          state: "active",
          boundChangeId: null,
          currentGraphScopeId: graphScopeId,
          selectedProviderId,
          completedTurnSequence: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        message: toCanonicalTimelineMessage(persistence.projectId, conversationId, {
          id: `user:${conversationId}:1`,
          clientRequestId,
          requestHash,
          type: "user.message",
          timestamp: now,
          conversationId,
          graphScopeId,
          changeId: "",
          completedTurnSequence: 1,
          text: body,
          contextRefs: resolved.contextRefs.length > 0 ? resolved.contextRefs : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          agentTurnMode: agentTurnMode ?? undefined,
          agentModelId: modelId ?? undefined,
          agentReasoningEffort: reasoningEffort ?? undefined,
        }),
        skillOverrides,
      });
      if (admission && !creation.replayed) pendingAdmission = admission;
    }
  } finally {
    database.close();
  }
  const committed = creation.conversation;
  live?.emit({
    event: "topic.created",
    data: {
      projectId: persistence.projectId,
      productMode: committed.productMode,
      conversationId: committed.conversationId,
      clientRequestId,
      replayed: creation.replayed,
      topic: {
        id: committed.conversationId,
        conversationId: committed.conversationId,
        title: committed.title,
        state: committed.state,
        selectedProviderId: committed.selectedProviderId,
        productMode: committed.productMode,
        agentTurnMode: committed.agentTurnMode,
        agentModelId: committed.agentModelId,
        agentReasoningEffort: committed.agentReasoningEffort,
      },
    },
  });
  if (creation.message) publishCommittedCanonicalTimelineRow(live, creation.message, committed.productMode);
  if (!creation.replayed && options.runMainAgent !== false) {
    if (!creation.message) throw new Error("Committed first send is missing its canonical Timeline message.");
    if (!turnRouter) throw new Error("Workbench Conversation turn routing is not composed for Provider execution.");
    await turnRouter.route({
      project,
      conversation: committed,
      committedMessage: creation.message,
      attachments: runtimeAttachments!,
      providerId: committed.selectedProviderId,
      live,
      admission: pendingAdmission!,
    }, productMode);
  }
  return {
    conversationId: committed.conversationId,
    title: committed.title,
    state: committed.state,
    productMode: committed.productMode,
    clientRequestId,
    replayed: creation.replayed,
    selectedProviderId: committed.selectedProviderId,
    agentTurnMode: committed.agentTurnMode,
    agentModelId: committed.agentModelId,
    agentReasoningEffort: committed.agentReasoningEffort,
  };
}

export async function prepareWorkbenchConversation(
  project: ManagedProject,
  input: CreateWorkbenchConversationInput,
  options: { runMainAgent?: boolean; turnRouter?: ConversationTurnRoutingPort; runtimeStateResolver?: (project: ManagedProject) => Promise<ProjectRuntimeState> } = {},
): Promise<PreparedWorkbenchConversation> {
  const productMode = assertProductMode(input.productMode);
  const agentTurnMode = normalizeRequestedAgentTurnMode(productMode, input.agentTurnMode);
  const selection = normalizeRequestedAgentModelSelection(productMode, input.modelId, input.reasoningEffort);
  const clientRequestId = normalizeClientRequestId(input.clientRequestId);
  const skillOverrides = normalizeSkillOverrides(input.skillOverrides);
  const turnRouter = options.turnRouter;
  if (options.runMainAgent !== false) requireComposedTurnRouter(turnRouter);
  const resolved = await resolveTopicFileReferences(project, input.body ?? "", input.contextRefs);
  const attachmentIds = normalizeTopicAttachmentIds(input.attachmentIds);
  const selectedProviderId = turnRouter?.resolveProviderId(project, input.providerId)
    ?? resolvePersistenceOnlyProviderId(project, input.providerId);
  const persistence = await openProjectConversationDatabase(
    project,
    options.runtimeStateResolver ?? turnRouter?.resolveRuntimeState,
    options.runMainAgent === false && !turnRouter,
  );
  let replay: { conversation: StoredConversation; attachments: TopicAttachmentEvidence[]; body: string } | null = null;
  try {
    const existing = persistence.database.conversations.readConversationByClientCreateRequestId(persistence.projectId, clientRequestId);
    if (existing) {
      const firstMessage = persistence.database.timeline.readMessage(
        persistence.projectId,
        existing.conversationId,
        `user:${existing.conversationId}:1`,
      );
      if (!firstMessage) throw conflict("Existing Conversation replay evidence is incomplete.");
      const entry = fromStoredThreadMessage(firstMessage);
      const attachments = entry.attachments ?? [];
      const persistedIds = [...attachments.map((attachment) => attachment.id)].sort();
      const requestedIds = [...attachmentIds].sort();
      if (JSON.stringify(persistedIds) !== JSON.stringify(requestedIds)) {
        throw conflict("clientRequestId was already used for a different Conversation request.");
      }
      const body = resolved.text || defaultAttachmentMessage(attachments);
      const requestHash = stableConversationCreateRequestHash({
        productMode,
        body,
        contextRefs: resolved.contextRefs,
        attachments,
        providerId: selectedProviderId,
        skillOverrides,
        agentTurnMode,
        modelId: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
      });
      const preparedReplay = createPreparedConversation({
        project,
        productMode,
        agentTurnMode,
        modelId: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
        clientRequestId,
        skillOverrides,
        resolvedText: resolved.text,
        contextRefs: resolved.contextRefs,
        attachments,
        runtimeAttachments: null,
        title: existing.title,
        body,
        conversationId: existing.conversationId,
        graphScopeId: existing.currentGraphScopeId ?? createConversationGraphScopeId(existing.conversationId),
        selectedProviderId,
        requestHash,
        admission: null,
        replayed: true,
        requestSignature: stableCreatePreparationSignature(input),
      });
      assertExistingCreateReplay(existing, preparedReplay);
      replay = { conversation: existing, attachments, body };
    }
  } finally {
    persistence.database.close();
  }
  if (replay) {
    const existing = replay.conversation;
    return createPreparedConversation({
      project,
      productMode,
      agentTurnMode,
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
      clientRequestId,
      skillOverrides,
      resolvedText: resolved.text,
      contextRefs: resolved.contextRefs,
      attachments: replay.attachments,
      runtimeAttachments: null,
      title: existing.title,
      body: replay.body,
      conversationId: existing.conversationId,
      graphScopeId: existing.currentGraphScopeId ?? createConversationGraphScopeId(existing.conversationId),
      selectedProviderId,
      requestHash: stableConversationCreateRequestHash({
        productMode,
        body: replay.body,
        contextRefs: resolved.contextRefs,
        attachments: replay.attachments,
        providerId: selectedProviderId,
        skillOverrides,
        agentTurnMode,
        modelId: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
      }),
      admission: null,
      replayed: true,
      requestSignature: stableCreatePreparationSignature(input),
    });
  }
  const attachments = turnRouter
    ? [...await turnRouter.resolveAttachments(project, attachmentIds)]
    : await resolveTopicAttachments(project, attachmentIds);
  const title = deriveConversationTitle(resolved.text, attachments.length > 0);
  const body = resolved.text || defaultAttachmentMessage(attachments);
  const conversationId = `conv-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const graphScopeId = createConversationGraphScopeId(conversationId);
  const requestHash = stableConversationCreateRequestHash({
    productMode,
    body,
    contextRefs: resolved.contextRefs,
    attachments,
    providerId: selectedProviderId,
    skillOverrides,
    agentTurnMode,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort,
  });
  const admission = options.runMainAgent === false
    ? null
    : await turnRouter!.admit({
      project,
      productMode,
      conversationId,
      providerId: selectedProviderId,
      agentTurnMode,
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
      attachments,
    });
  return createPreparedConversation({
    project,
    productMode,
    agentTurnMode,
    modelId: selection.modelId,
    reasoningEffort: selection.reasoningEffort,
    clientRequestId,
    skillOverrides: Object.freeze([...skillOverrides]) as unknown as NewConversationSkillOverride[],
    resolvedText: resolved.text,
    contextRefs: Object.freeze([...resolved.contextRefs]) as NonNullable<TopicMessageInput["contextRefs"]>,
    attachments: attachments.map(toTopicAttachmentEvidence),
    runtimeAttachments: attachments,
    title,
    body,
    conversationId,
    graphScopeId,
    selectedProviderId,
    requestHash,
    admission,
    replayed: false,
    requestSignature: stableCreatePreparationSignature(input),
  });
}

export async function updateWorkbenchConversationTitle(
  project: ManagedProject,
  conversationId: string,
  input: { title: string },
  options: { runtimeStateResolver?: (project: ManagedProject) => Promise<ProjectRuntimeState> } = {},
): Promise<{ id: string; productMode: ProductMode; title: string; state: string; updatedAt: string; selectedProviderId?: string }> {
  const persistence = await openProjectConversationDatabase(project, options.runtimeStateResolver, true);
  const title = normalizeConversationTitle(input.title);
  const updatedAt = new Date().toISOString();
  const database = persistence.database;
  try {
    const conversation = database.conversations.updateConversationTitle(persistence.projectId, conversationId, title, updatedAt);
    const projection = {
      id: conversation.conversationId,
      productMode: conversation.productMode,
      title: conversation.title,
      state: conversation.state,
      updatedAt: conversation.updatedAt,
      selectedProviderId: conversation.selectedProviderId,
    };
    publishProjectLiveEvent(persistence.projectId, { event: "topic.updated", data: { conversation: projection } });
    return projection;
  } finally {
    database.close();
  }
}

export function deriveConversationTitle(text: string, hasAttachments = false): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:(?:#{1,6}|>|[-+*]|\d+[.)])\s+)+/, "").trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ")
    .trim() ?? "";
  if (!normalized) {
    if (hasAttachments) return "附件需求";
    const error = new Error("Demand conversation text or attachment is required.");
    error.name = "BadRequest";
    throw error;
  }
  return Array.from(normalized).slice(0, 48).join("");
}

export function normalizeConversationTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  const length = Array.from(title).length;
  if (length < 1 || length > 80) {
    const error = new Error("Conversation title must contain 1 to 80 characters.");
    error.name = "BadRequest";
    throw error;
  }
  return title;
}

export async function postConversationMessage(
  project: ManagedProject,
  conversationId: string,
  input: string | TopicMessageInput,
  live?: WorkbenchLiveSink,
  options: { turnRouter?: ConversationTurnRoutingPort; runtimeStateResolver?: (project: ManagedProject) => Promise<ProjectRuntimeState>; prepared?: PreparedConversationMessage } = {},
): Promise<TopicMessageResult> {
  const turnRouter = options.turnRouter;
  requireComposedTurnRouter(turnRouter);
  const identity = options.prepared?.identity
    ?? await resolveStoredConversationIdentity(project, conversationId, options.runtimeStateResolver ?? turnRouter.resolveRuntimeState);
  if (options.prepared) assertPreparedMessageIdentity(project, conversationId, input, options.prepared);
  conversationId = identity.conversationId;
  const requestedMode = options.prepared?.requestedMode ?? (typeof input === "string" ? undefined : input.productMode);
  turnRouter.assertRequestedMode(identity.conversation, requestedMode);
  const parsed = options.prepared?.parsed
    ?? await normalizeTopicMessageInput(project, input, turnRouter.resolveAttachments);
  const runtimeState = identity.runtimeState;
  if (identity.conversation.productMode === "agent" && parsed.planHandoffIntent) {
    const error = new Error("Agent mode does not accept AHO child feedback or planning handoffs.");
    error.name = "Conflict";
    throw error;
  }
  if (parsed.agentSurfaceId) {
    if (identity.conversation.productMode === "agent") {
      if (parsed.contextRefs?.length || parsed.attachments?.length || parsed.planHandoffIntent || parsed.providerId
        || parsed.modelId !== undefined || parsed.reasoningEffort !== undefined) {
        const error = new Error("Native child follow-up supports plain text only and cannot switch Providers or carry Main context.");
        error.name = "BadRequest";
        throw error;
      }
      if (!turnRouter?.runAgentNativeChildFollowup) throw new Error("Workbench Agent child routing is not composed.");
      return turnRouter.runAgentNativeChildFollowup({
        project,
        conversationId,
        agentSurfaceId: parsed.agentSurfaceId,
        message: parsed.message,
        live,
      });
    }
    if (runtimeState.state === "onboarding") {
      const error = new Error("Project Harness onboarding accepts Main conversation text and attachments only.");
      error.name = "Conflict";
      throw error;
    }
    if (runtimeState.state === "repair-required") {
      throw new Error("Project Harness requires repair before planning or source execution.");
    }
    if (parsed.contextRefs?.length || parsed.attachments?.length || parsed.planHandoffIntent || parsed.providerId
      || parsed.modelId !== undefined || parsed.reasoningEffort !== undefined) {
      const error = new Error("Child Agent feedback supports text only and cannot switch providers or carry Main planning context.");
      error.name = "BadRequest";
      throw error;
    }
    if (!turnRouter?.runExactChildAgentTurn) throw new Error("Workbench Harness child routing is not composed.");
    return turnRouter.runExactChildAgentTurn({ project, conversationId, agentSurfaceId: parsed.agentSurfaceId, message: parsed.message, live });
  }
  if (identity.conversation.productMode === "harness" && runtimeState.state === "onboarding"
    && (parsed.planHandoffIntent || parsed.providerId)) {
    const error = new Error("Project Harness onboarding accepts Main conversation text and attachments only.");
    error.name = "Conflict";
    throw error;
  }
  if (identity.conversation.productMode === "harness" && runtimeState.state === "repair-required") {
    throw new Error("Project Harness requires repair before planning or source execution.");
  }
  const agentTurnMode = options.prepared?.agentTurnMode ?? normalizeRequestedAgentTurnMode(
    identity.conversation.productMode,
    parsed.agentTurnMode ?? identity.conversation.agentTurnMode ?? undefined,
  );
  const modelId = options.prepared
    ? options.prepared.modelId
    : parsed.modelId === undefined ? identity.conversation.agentModelId : parsed.modelId;
  const reasoningEffort = options.prepared
    ? options.prepared.reasoningEffort
    : parsed.reasoningEffort === undefined ? identity.conversation.agentReasoningEffort : parsed.reasoningEffort;
  const requestHash = options.prepared?.requestHash ?? conversationMessageRequestHash(
    identity.conversation,
    parsed,
    agentTurnMode,
    modelId,
    reasoningEffort,
  );
  const result = runConversationMessageSingleFlight(identity, parsed.clientRequestId, requestHash, async () => {
    const replay = options.prepared?.replay
      ?? await readConversationMessageReplay(identity, parsed.clientRequestId, requestHash);
    if (replay) return replay;
    return runConversationMessageExecutionExclusive(identity, async () => {
    const concurrentReplay = await readConversationMessageReplay(identity, parsed.clientRequestId, requestHash);
    if (concurrentReplay) return concurrentReplay;
    await assertConversationQueueAdmission(identity, parsed);
    let providerSwitch: ProviderSwitchResult | null = null;
    if (parsed.providerId && identity.conversation.productMode === "harness" && runtimeState.state === "ready") {
      if (!turnRouter.switchProviderAtSafePoint) {
        throw new Error("Workbench Provider switching is not composed.");
      }
      providerSwitch = await turnRouter.switchProviderAtSafePoint({
        project,
        resolution: runtimeState.resolution,
        conversationId,
        targetProviderId: parsed.providerId,
      });
    }
    if (parsed.providerId && identity.conversation.productMode === "agent") {
      if (parsed.providerId !== identity.conversation.selectedProviderId) {
        const error = new Error("Direct Agent provider switching is not supported in this increment.");
        error.name = "Conflict";
        throw error;
      }
    }
    const admissionProviderId = providerSwitch?.selectedProviderId ?? identity.conversation.selectedProviderId;
    const admission = options.prepared?.admission ?? await turnRouter.admit({
      project,
      productMode: identity.conversation.productMode,
      conversationId,
      providerId: admissionProviderId,
      agentTurnMode,
      modelId,
      reasoningEffort,
      attachments: parsed.attachments ?? [],
    });
    if (!admission) throw new Error("Prepared Conversation Turn is missing admission evidence.");
    const committed = await commitTopLevelConversationMessage(identity, {
      ...parsed,
      requestHash: requestHash ?? undefined,
      agentTurnMode: agentTurnMode ?? undefined,
      modelId,
      reasoningEffort,
    }, turnRouter, live);
    if (committed.replayed) return replayedConversationMessageResult(committed.message);
    const result = await turnRouter.route({
      project,
      conversation: committed.conversation,
      committedMessage: committed.message,
      attachments: parsed.attachments ?? [],
      providerId: committed.conversation.selectedProviderId,
      live,
      harnessHandoff: committed.planHandoff,
      admission,
    }, requestedMode);
    if (providerSwitch && parsed.providerSwitchIntent === "resume-workflow") {
      if (runtimeState.state !== "ready") {
        throw new Error("Provider workflow continuation requires a ready project Harness.");
      }
      const request = await resolveProviderSwitchWorkflowResumeRequest({
        project,
        resolution: runtimeState.resolution,
        conversationId,
        switchResult: providerSwitch,
      });
      if (request) {
        await runWorkbenchWorkflowAction(project, request, live, {
          postConversationMessage: (ownerProject, ownerConversationId, ownerInput, ownerLive) => postConversationMessage(
            ownerProject,
            ownerConversationId,
            ownerInput,
            ownerLive,
            { turnRouter },
          ),
          continueMainAgentTurn: turnRouter.continueMainAgentTurn,
        });
      }
    }
      return result;
    });
  });
  if (options.prepared) {
    return result.finally(() => clearConversationMessagePreparationFlight(
      options.prepared!.identity,
      options.prepared!.parsed.clientRequestId,
      options.prepared!.requestHash,
    ));
  }
  return result;
}

export async function listConversationMessages(project: ManagedProject, conversationId: string): Promise<TopicThreadEntry[]> {
  const persistence = await openProjectConversationDatabase(project, undefined, true);
  if (!persistence.projectId) return [];
  if (persistence.runtimeState.state === "ready") conversationId = await resolveConversationId(project, conversationId);
  const database = persistence.database;
  try {
    return database.timeline.listConversationMessages(persistence.projectId, conversationId).map(fromStoredThreadMessage);
  } finally {
    database.close();
  }
}

async function openProjectConversationDatabase(
  project: ManagedProject,
  runtimeStateResolver: ((project: ManagedProject) => Promise<ProjectRuntimeState>) | undefined,
  allowUncomposedPersistence = false,
): Promise<{
  projectId: string;
  database: WorkbenchDatabase;
  runtimeState: ProjectRuntimeState;
}> {
  if (!runtimeStateResolver) {
    if (!allowUncomposedPersistence) throw new Error("Workbench Conversation runtime state is not composed.");
    runtimeStateResolver = (selectedProject) => resolveProjectRuntimeState(selectedProject, {
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });
  }
  const runtimeState = await runtimeStateResolver(project);
  const paths = runtimeState.state === "onboarding" ? runtimeState.paths : runtimeState.resolution.paths;
  return {
    projectId: paths.projectId,
    database: await openProjectRuntimeWorkbenchDatabase(paths),
    runtimeState,
  };
}

function requireComposedTurnRouter(turnRouter: ConversationTurnRoutingPort | undefined): asserts turnRouter is ConversationTurnRoutingPort & {
  resolveProviderId: NonNullable<ConversationTurnRoutingPort["resolveProviderId"]>;
  resolveRuntimeState: NonNullable<ConversationTurnRoutingPort["resolveRuntimeState"]>;
} {
  if (!turnRouter) throw new Error("Workbench Conversation turn routing is not composed for Provider execution.");
  if (!turnRouter.resolveProviderId || !turnRouter.resolveRuntimeState) {
    throw new Error("Workbench Conversation Provider/runtime composition is incomplete.");
  }
}

function resolvePersistenceOnlyProviderId(project: ManagedProject, requestedProviderId?: string): string {
  const providerId = requestedProviderId?.trim() || project.defaultProviderId?.trim();
  // This branch exists only for runMainAgent:false persistence fixtures. Any
  // execution path is rejected above unless the server-composed Router owns
  // Provider validation and runtime identity.
  if (!providerId) throw new Error("Persistence-only Conversation creation requires a Provider identity.");
  return providerId;
}

async function normalizeTopicMessageInput(
  project: ManagedProject,
  input: string | TopicMessageInput,
  attachmentResolver: ConversationTurnRoutingPort["resolveAttachments"],
): Promise<NormalizedTopicMessageInput> {
  const mode = typeof input === "string" ? "chat" : input.mode ?? "chat";
  const message = typeof input === "string" ? input : input.message ?? input.text ?? "";
  if (mode !== "chat") throw new Error("Message mode must be chat; planning is delegated by the Main Agent to a real child.");
  const attachments = [...await attachmentResolver(project, typeof input === "string" ? [] : input.attachmentIds)];
  if (!message.trim() && attachments.length === 0) throw new Error("Message text is required.");
  const resolved = await resolveTopicFileReferences(project, message, typeof input === "string" ? [] : input.contextRefs);
  const resolvedMessage = resolved.text.trim() || defaultAttachmentMessage(attachments);
  if (!resolvedMessage.trim()) throw new Error("Message text is required.");
  return {
    clientRequestId: typeof input === "string" || input.clientRequestId === undefined
      ? (typeof input === "string" || !input.queuedTurnDispatch?.dispatchRequestId
        ? undefined
        : normalizeConversationClientRequestId(input.queuedTurnDispatch.dispatchRequestId))
      : normalizeConversationClientRequestId(input.clientRequestId),
    mode,
    message: resolvedMessage,
    contextRefs: resolved.contextRefs.length > 0 ? resolved.contextRefs : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    planHandoffIntent: typeof input === "string" ? undefined : input.planHandoffIntent,
    providerId: typeof input === "string" ? undefined : input.providerId,
    providerSwitchIntent: typeof input === "string" ? "conversation-only" : input.providerSwitchIntent ?? (input.providerId ? "resume-workflow" : "conversation-only"),
    agentSurfaceId: typeof input === "string" ? undefined : input.agentSurfaceId?.trim() || undefined,
    agentTurnMode: typeof input === "string" || input.agentTurnMode === undefined
      ? undefined
      : assertAgentTurnMode(input.agentTurnMode),
    modelId: typeof input === "string" || input.modelId === undefined
      ? undefined
      : normalizeNullableSelection(input.modelId, "modelId"),
    reasoningEffort: typeof input === "string" || input.reasoningEffort === undefined
      ? undefined
      : normalizeNullableSelection(input.reasoningEffort, "reasoningEffort"),
    skillOverrides: normalizeSkillOverrides(typeof input === "string" ? undefined : input.skillOverrides),
    queuedTurnDispatch: typeof input === "string" ? undefined : input.queuedTurnDispatch,
  };
}

function defaultAttachmentMessage(attachments: readonly TopicAttachmentEvidence[]): string {
  if (attachments.length === 0) return "";
  const imageCount = attachments.filter((attachment) => attachment.kind === "image").length;
  const textCount = attachments.filter((attachment) => attachment.kind === "text").length;
  if (imageCount > 0 && textCount === 0) return "Please inspect the attached image first, describe what you see, and ask a clarifying question if the requested outcome is unclear.";
  if (textCount > 0 && imageCount === 0) return "Please use the attached file content as message-scoped context for this request.";
  return "Please use the attached images and files as message-scoped context for this request.";
}

async function resolveStoredConversationIdentity(
  project: ManagedProject,
  requestedConversationId: string,
  runtimeStateResolver?: (project: ManagedProject) => Promise<ProjectRuntimeState>,
): Promise<{ conversationId: string; conversation: StoredConversation; runtimeState: ProjectRuntimeState }> {
  const persistence = await openProjectConversationDatabase(project, runtimeStateResolver);
  let conversationId = requestedConversationId;
  try {
    let conversation = persistence.database.conversations.readConversation(
      persistence.projectId,
      conversationId,
    );
    if (!conversation && persistence.runtimeState.state === "ready") {
      conversationId = await resolveConversationId(project, requestedConversationId);
      conversation = persistence.database.conversations.readConversation(
        persistence.projectId,
        conversationId,
      );
    }
    if (!conversation) {
      const error = new Error(`Conversation not found: ${requestedConversationId}.`);
      error.name = "NotFound";
      throw error;
    }
    if (conversation.deletedAt || conversation.state !== "active") {
      throw conflict("Conversation is not active.");
    }
    return {
      conversationId: conversation.conversationId,
      conversation,
      runtimeState: persistence.runtimeState,
    };
  } finally {
    persistence.database.close();
  }
}

async function commitTopLevelConversationMessage(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  parsed: Awaited<ReturnType<typeof normalizeTopicMessageInput>>,
  turnRouter: ConversationTurnRoutingPort,
  live?: WorkbenchLiveSink,
): Promise<{
  conversation: StoredConversation;
  message: StoredTopicMessage;
  planHandoff?: ValidatedPlanHandoffIntent;
  replayed: boolean;
}> {
  const { runtimeState } = identity;
  const paths = runtimeState.state === "onboarding" ? runtimeState.paths : runtimeState.resolution.paths;
  const projectId = identity.conversation.projectId;
  const conversationId = identity.conversationId;
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const conversation = database.conversations.readConversation(projectId, conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}.`);
    if (conversation.deletedAt || conversation.state !== "active") throw conflict("Conversation is not active.");
    turnRouter.assertRequestedMode(conversation, identity.conversation.productMode);
    const delivery = new CanonicalTimelineDelivery(database, conversation.productMode, live);
    const now = new Date().toISOString();
    let planHandoff: ValidatedPlanHandoffIntent | undefined;
    let graphScopeId = conversation.currentGraphScopeId ?? createConversationGraphScopeId(conversationId);
    if (conversation.productMode === "harness" && runtimeState.state === "ready") {
      planHandoff = validatePlanHandoffIntent(
        database.timeline.listConversationMessages(projectId, conversationId).map(fromStoredThreadMessage),
        parsed.planHandoffIntent,
      );
      const supersedingExecutedChange = Boolean(planHandoff?.kind === "revise-plan"
        && conversation.boundChangeId
        && await hasPlanningExecutionEvidence({
          projectId,
          projectRoot: runtimeState.resolution.projectRoot,
          runsRoot: runtimeState.resolution.paths.runsRoot,
          workbenchRoot: runtimeState.resolution.paths.workbenchRoot,
          worktreeMetadataRoot: runtimeState.resolution.paths.worktreeMetadataRoot,
        }, conversation.boundChangeId));
      const completedBoundChange = Boolean(!planHandoff && conversation.boundChangeId
        && await readProjectHarnessChangeContext(
          runtimeState.resolution.harness.skillRoot,
          conversation.boundChangeId,
          false,
        ).then((context) => context.evidence_state !== "active").catch(() => true));
      const terminalGraphScope = Boolean(conversation.currentGraphScopeId
        && database.conversations.isConversationGraphScopeTerminal(projectId, conversation.currentGraphScopeId));
      graphScopeId = !completedBoundChange && !supersedingExecutedChange && !terminalGraphScope && conversation.currentGraphScopeId
        ? conversation.currentGraphScopeId
        : createConversationGraphScopeId(conversationId);
    }
    const graphScopeChanged = graphScopeId !== conversation.currentGraphScopeId;
    const user: TopicThreadEntry = {
      id: parsed.clientRequestId
        ? `user:${conversationId}:request:${createHash("sha256").update(parsed.clientRequestId).digest("hex").slice(0, 24)}`
        : `user:${conversationId}:${Date.now().toString(36)}`,
      clientRequestId: parsed.clientRequestId,
      requestHash: parsed.requestHash,
      type: "user.message",
      timestamp: now,
      conversationId,
      graphScopeId,
      changeId: "",
      completedTurnSequence: conversation.completedTurnSequence + 1,
      text: parsed.message,
      contextRefs: parsed.contextRefs,
      attachments: parsed.attachments,
      planHandoff,
      agentTurnMode: parsed.agentTurnMode,
      agentModelId: parsed.modelId,
      agentReasoningEffort: parsed.reasoningEffort,
      queuedTurnDispatch: parsed.queuedTurnDispatch,
    };
    const userWrite = toCanonicalTimelineMessage(projectId, conversationId, user);
    let replayed = false;
    if (conversation.productMode === "agent") {
      const committed = database.unitOfWork.commitAgentConversationMessage({
        projectId,
        conversationId,
        graphScopeId,
        expectedAgentTurnMode: conversation.agentTurnMode ?? "default",
        expectedAgentModelId: conversation.agentModelId,
        expectedAgentReasoningEffort: conversation.agentReasoningEffort,
        agentTurnMode: parsed.agentTurnMode ?? conversation.agentTurnMode ?? "default",
        agentModelId: parsed.modelId ?? null,
        agentReasoningEffort: parsed.reasoningEffort ?? null,
        skillOverrides: parsed.skillOverrides,
        queuedTurnDispatch: parsed.queuedTurnDispatch,
        updatedAt: now,
        message: userWrite,
      });
      replayed = committed.replayed;
      if (!committed.replayed) {
        delivery.publishCommittedMany(committed.graphScopeRows);
        delivery.publishCommitted(committed.message);
      }
    } else {
      const committed = database.unitOfWork.commitConversationMessage({
        projectId,
        conversationId,
        graphScopeId,
        message: userWrite,
        skillOverrides: parsed.skillOverrides,
        queuedTurnDispatch: parsed.queuedTurnDispatch,
        allowActiveQueue: Boolean(planHandoff),
        expectedModelId: conversation.agentModelId,
        expectedReasoningEffort: conversation.agentReasoningEffort,
        modelId: parsed.modelId ?? null,
        reasoningEffort: parsed.reasoningEffort ?? null,
        updatedAt: now,
      });
      replayed = committed.replayed;
      if (!committed.replayed) {
        delivery.publishCommittedMany(committed.graphScopeRows);
        delivery.publishCommitted(committed.message);
      }
    }
    if (replayed) {
      const committedConversation = database.conversations.readConversation(projectId, conversationId);
      const committedMessage = database.timeline.readMessage(projectId, conversationId, user.id);
      if (!committedConversation || !committedMessage) {
        throw new Error("Replayed Conversation Turn could not be reloaded.");
      }
      return { conversation: committedConversation, message: committedMessage, replayed: true };
    }
    if (graphScopeChanged) {
      publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "scope-changed" });
    }
    const proposalStatus = planHandoff?.kind === "revise-plan"
      ? "revision-requested"
      : planHandoff?.kind === "skip-plan" ? "skipped" : null;
    if (proposalStatus && planHandoff) {
      delivery.publishCommitted(database.interactions.updatePlanningMessageStatus(
        projectId,
        conversationId,
        planHandoff.sourceArtifact,
        proposalStatus,
      ));
      publishAgentSurfacesInvalidated(projectId, { conversationId, graphScopeId, reason: "interaction-updated" });
    }
    const committedConversation = database.conversations.readConversation(projectId, conversationId);
    const committedMessage = database.timeline.readMessage(projectId, conversationId, user.id);
    if (!committedConversation || !committedMessage) {
      throw new Error("Committed Conversation Turn could not be reloaded.");
    }
    return { conversation: committedConversation, message: committedMessage, planHandoff, replayed: false };
  } finally {
    database.close();
  }
}

export function normalizeConversationClientRequestId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9_:-]+$/.test(normalized)) {
    const error = new Error("clientRequestId must be 1 to 128 URL-safe characters.");
    error.name = "BadRequest";
    throw error;
  }
  return normalized;
}

const normalizeClientRequestId = normalizeConversationClientRequestId;

function normalizeSkillOverrides(value: NewConversationSkillOverride[] | undefined): NewConversationSkillOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    const error = new Error("skillOverrides must be an array.");
    error.name = "BadRequest";
    throw error;
  }
  const normalized = new Map<string, boolean>();
  for (const item of value) {
    const skillId = typeof item?.skillId === "string" ? item.skillId.trim() : "";
    if (!skillId || typeof item?.enabled !== "boolean" || normalized.has(skillId)) {
      const error = new Error("skillOverrides must contain unique non-empty skillId values and boolean enabled values.");
      error.name = "BadRequest";
      throw error;
    }
    normalized.set(skillId, item.enabled);
  }
  return [...normalized]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([skillId, enabled]) => ({ skillId, enabled }));
}

function stableConversationCreateRequestHash(input: {
  productMode: ProductMode;
  body: string;
  contextRefs: TopicMessageInput["contextRefs"];
  attachments: readonly TopicAttachmentEvidence[];
  providerId: string;
  skillOverrides: NewConversationSkillOverride[];
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: 4,
    productMode: input.productMode,
    body: input.body,
    contextRefs: input.contextRefs ?? [],
    attachments: [...input.attachments]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        size: attachment.size,
        contentHash: attachment.hash,
        runtimeMode: attachment.kind === "image" ? "provider-image-input" : "provider-file-reference",
      })),
    providerId: input.providerId,
    skillOverrides: input.skillOverrides,
    agentTurnMode: input.agentTurnMode,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
  })).digest("hex");
}

function stableConversationCreateRequestHashV1(input: {
  productMode: ProductMode;
  body: string;
  contextRefs: TopicMessageInput["contextRefs"];
  attachmentIds: string[];
  providerId: string;
  skillOverrides: NewConversationSkillOverride[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    productMode: input.productMode,
    body: input.body,
    contextRefs: input.contextRefs ?? [],
    attachmentIds: input.attachmentIds,
    providerId: input.providerId,
    skillOverrides: input.skillOverrides,
  })).digest("hex");
}

export async function prepareConversationMessage(
  project: ManagedProject,
  conversationId: string,
  input: string | TopicMessageInput,
  options: { turnRouter: ConversationTurnRoutingPort; runtimeStateResolver?: (project: ManagedProject) => Promise<ProjectRuntimeState> },
): Promise<PreparedConversationMessage> {
  const turnRouter = options.turnRouter;
  requireComposedTurnRouter(turnRouter);
  const identity = await resolveStoredConversationIdentity(project, conversationId, options.runtimeStateResolver ?? turnRouter.resolveRuntimeState);
  const requestedMode = typeof input === "string" ? undefined : input.productMode;
  turnRouter.assertRequestedMode(identity.conversation, requestedMode);
  if (identity.conversation.productMode !== "agent") throw conflict("Prepared message admission is only used by Direct Agent turns.");
  const parsed = await normalizeTopicMessageInput(project, input, turnRouter.resolveAttachments);
  if (parsed.planHandoffIntent) throw conflict("Agent mode does not accept AHO child feedback or planning handoffs.");
  if (parsed.agentSurfaceId) {
    if (parsed.contextRefs?.length || parsed.attachments?.length || parsed.providerId) {
      const error = new Error("Native child follow-up supports plain text only and cannot switch Providers or carry Main context.");
      error.name = "BadRequest";
      throw error;
    }
    throw conflict("Native child follow-up does not use top-level prepared Turn admission.");
  }
  if (parsed.providerId && parsed.providerId !== identity.conversation.selectedProviderId) {
    throw conflict("Direct Agent provider switching is not supported in this increment.");
  }
  const agentTurnMode = normalizeRequestedAgentTurnMode(
    "agent",
    parsed.agentTurnMode ?? identity.conversation.agentTurnMode ?? undefined,
  );
  const modelId = parsed.modelId === undefined ? identity.conversation.agentModelId : parsed.modelId;
  const reasoningEffort = parsed.reasoningEffort === undefined
    ? identity.conversation.agentReasoningEffort
    : parsed.reasoningEffort;
  const requestHash = conversationMessageRequestHash(identity.conversation, parsed, agentTurnMode, modelId, reasoningEffort);
  return runConversationMessagePreparationSingleFlight(identity, parsed.clientRequestId, requestHash, async () => {
    const replay = await readConversationMessageReplay(identity, parsed.clientRequestId, requestHash);
    if (!replay) await assertConversationQueueAdmission(identity, parsed);
    const admission = replay ? null : await turnRouter.admit({
      project,
      productMode: "agent",
      conversationId: identity.conversationId,
      providerId: identity.conversation.selectedProviderId,
      agentTurnMode,
      modelId,
      reasoningEffort,
      attachments: parsed.attachments ?? [],
    });
    return Object.freeze({
      projectId: project.id,
      requestedConversationId: conversationId,
      conversationId: identity.conversationId,
      requestedMode,
      identity,
      parsed: Object.freeze({ ...parsed, attachments: parsed.attachments ? Object.freeze([...parsed.attachments]) as unknown as TopicAttachment[] : undefined }),
      agentTurnMode,
      modelId,
      reasoningEffort,
      admission,
      requestSignature: stableMessagePreparationSignature(input),
      requestHash,
      replay,
    });
  });
}

function stableConversationCreateRequestHashV2(input: Parameters<typeof stableConversationCreateRequestHashV1>[0] & {
  agentTurnMode: AgentTurnMode | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    productMode: input.productMode,
    body: input.body,
    contextRefs: input.contextRefs ?? [],
    attachmentIds: input.attachmentIds,
    providerId: input.providerId,
    skillOverrides: input.skillOverrides,
    agentTurnMode: input.agentTurnMode,
  })).digest("hex");
}

function stableConversationCreateRequestHashV3(input: Omit<Parameters<typeof stableConversationCreateRequestHash>[0], "modelId" | "reasoningEffort">): string {
  return createHash("sha256").update(JSON.stringify({
    version: 3,
    productMode: input.productMode,
    body: input.body,
    contextRefs: input.contextRefs ?? [],
    attachments: [...input.attachments]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        size: attachment.size,
        contentHash: attachment.hash,
        runtimeMode: attachment.kind === "image" ? "provider-image-input" : "provider-file-reference",
      })),
    providerId: input.providerId,
    skillOverrides: input.skillOverrides,
    agentTurnMode: input.agentTurnMode,
  })).digest("hex");
}

function createPreparedConversation(input: {
  project: ManagedProject;
  productMode: ProductMode;
  agentTurnMode: AgentTurnMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
  clientRequestId: string;
  skillOverrides: NewConversationSkillOverride[];
  resolvedText: string;
  contextRefs: NonNullable<TopicMessageInput["contextRefs"]>;
  attachments: TopicAttachmentEvidence[];
  runtimeAttachments: TopicAttachment[] | null;
  title: string;
  body: string;
  conversationId: string;
  graphScopeId: string;
  selectedProviderId: string;
  requestHash: string;
  admission: Awaited<ReturnType<ConversationTurnRoutingPort["admit"]>> | null;
  replayed: boolean;
  requestSignature: string;
}): PreparedWorkbenchConversation {
  return Object.freeze({
    projectId: input.project.id,
    productMode: input.productMode,
    agentTurnMode: input.agentTurnMode,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    clientRequestId: input.clientRequestId,
    skillOverrides: Object.freeze([...input.skillOverrides]) as unknown as NewConversationSkillOverride[],
    resolvedText: input.resolvedText,
    contextRefs: Object.freeze([...input.contextRefs]) as NonNullable<TopicMessageInput["contextRefs"]>,
    attachments: Object.freeze(input.attachments.map((attachment) => Object.freeze({ ...attachment }))) as unknown as TopicAttachmentEvidence[],
    runtimeAttachments: input.runtimeAttachments
      ? Object.freeze([...input.runtimeAttachments]) as unknown as TopicAttachment[]
      : null,
    title: input.title,
    body: input.body,
    conversationId: input.conversationId,
    graphScopeId: input.graphScopeId,
    selectedProviderId: input.selectedProviderId,
    requestHash: input.requestHash,
    admission: input.admission,
    replayed: input.replayed,
    requestSignature: input.requestSignature,
  });
}

function assertExistingCreateReplay(
  existing: StoredConversation,
  prepared: PreparedWorkbenchConversation,
): void {
  const attachmentIds = prepared.attachments.map((attachment) => attachment.id);
  const previousRequestHash = stableConversationCreateRequestHashV2({
    productMode: prepared.productMode,
    body: prepared.body,
    contextRefs: prepared.contextRefs,
    attachmentIds,
    providerId: prepared.selectedProviderId,
    skillOverrides: prepared.skillOverrides,
    agentTurnMode: prepared.agentTurnMode,
  });
  const attachmentRequestHash = stableConversationCreateRequestHashV3({
    productMode: prepared.productMode,
    body: prepared.body,
    contextRefs: prepared.contextRefs,
    attachments: prepared.attachments,
    providerId: prepared.selectedProviderId,
    skillOverrides: prepared.skillOverrides,
    agentTurnMode: prepared.agentTurnMode,
  });
  const legacyRequestHash = stableConversationCreateRequestHashV1({
    productMode: prepared.productMode,
    body: prepared.body,
    contextRefs: prepared.contextRefs,
    attachmentIds,
    providerId: prepared.selectedProviderId,
    skillOverrides: prepared.skillOverrides,
  });
  const requestMatches = existing.clientCreateRequestHash === prepared.requestHash
    || existing.clientCreateRequestHash === attachmentRequestHash
    || existing.clientCreateRequestHash === previousRequestHash
    || (existing.agentTurnMode === prepared.agentTurnMode && existing.clientCreateRequestHash === legacyRequestHash);
  if (existing.productMode !== prepared.productMode
    || !requestMatches) {
    throw conflict("clientRequestId was already used for a different Conversation request.");
  }
}

function stableCreatePreparationSignature(input: CreateWorkbenchConversationInput): string {
  return createHash("sha256").update(JSON.stringify({
    body: input.body ?? "",
    contextRefs: input.contextRefs ?? [],
    attachmentIds: input.attachmentIds ?? [],
    providerId: input.providerId ?? null,
    productMode: input.productMode,
    clientRequestId: input.clientRequestId,
    skillOverrides: input.skillOverrides ?? [],
    agentTurnMode: input.agentTurnMode ?? null,
    modelId: input.modelId ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
  })).digest("hex");
}

function assertPreparedCreateIdentity(
  project: ManagedProject,
  input: CreateWorkbenchConversationInput,
  prepared: PreparedWorkbenchConversation,
): void {
  const requestedMode = assertProductMode(input.productMode);
  const requestedAgentTurnMode = normalizeRequestedAgentTurnMode(requestedMode, input.agentTurnMode);
  const requestedSelection = normalizeRequestedAgentModelSelection(requestedMode, input.modelId, input.reasoningEffort);
  if (prepared.projectId !== project.id
    || prepared.productMode !== requestedMode
    || prepared.agentTurnMode !== requestedAgentTurnMode
    || prepared.modelId !== requestedSelection.modelId
    || prepared.reasoningEffort !== requestedSelection.reasoningEffort
    || prepared.clientRequestId !== normalizeClientRequestId(input.clientRequestId)
    || prepared.requestSignature !== stableCreatePreparationSignature(input)) {
    const error = new Error("Prepared Conversation Turn does not match the current request identity.");
    error.name = "Conflict";
    throw error;
  }
}

function assertPreparedMessageIdentity(
  project: ManagedProject,
  conversationId: string,
  input: string | TopicMessageInput,
  prepared: PreparedConversationMessage,
): void {
  if (prepared.projectId !== project.id
    || prepared.requestedConversationId !== conversationId
    || prepared.requestSignature !== stableMessagePreparationSignature(input)) {
    throw conflict("Prepared Conversation message does not match the current request identity.");
  }
}

function stableMessagePreparationSignature(input: string | TopicMessageInput): string {
  return createHash("sha256").update(JSON.stringify(typeof input === "string" ? { message: input } : {
    clientRequestId: input.clientRequestId ?? null,
    message: input.message ?? input.text ?? "",
    mode: input.mode ?? "chat",
    productMode: input.productMode ?? null,
    providerId: input.providerId ?? null,
    providerSwitchIntent: input.providerSwitchIntent ?? null,
    agentSurfaceId: input.agentSurfaceId ?? null,
    agentTurnMode: input.agentTurnMode ?? null,
    modelId: input.modelId ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    skillOverrides: input.skillOverrides ?? [],
    contextRefs: input.contextRefs ?? [],
    attachmentIds: input.attachmentIds ?? [],
    planHandoffIntent: input.planHandoffIntent ?? null,
    queuedTurnDispatch: input.queuedTurnDispatch ?? null,
  })).digest("hex");
}

function conversationMessageRequestHash(
  conversation: StoredConversation,
  input: NormalizedTopicMessageInput,
  agentTurnMode: AgentTurnMode | null,
  modelId: string | null,
  reasoningEffort: string | null,
): string | null {
  if (!input.clientRequestId) return null;
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    conversationId: conversation.conversationId,
    productMode: conversation.productMode,
    message: input.message,
    contextRefs: input.contextRefs ?? [],
    attachments: (input.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      size: attachment.size,
      hash: attachment.hash,
      runtimeMode: attachment.runtimeMode,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    planHandoffIntent: input.planHandoffIntent ?? null,
    providerId: input.providerId ?? conversation.selectedProviderId,
    providerSwitchIntent: input.providerSwitchIntent,
    agentSurfaceId: input.agentSurfaceId ?? null,
    agentTurnMode,
    modelId,
    reasoningEffort,
    skillOverrides: input.skillOverrides,
    queuedTurnDispatch: input.queuedTurnDispatch ?? null,
  })).digest("hex");
}

async function readConversationMessageReplay(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  clientRequestId: string | undefined,
  requestHash: string | null,
): Promise<TopicMessageResult | null> {
  if (!clientRequestId || !requestHash) return null;
  const paths = identity.runtimeState.state === "onboarding"
    ? identity.runtimeState.paths
    : identity.runtimeState.resolution.paths;
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const matching = database.timeline.listConversationMessages(
      identity.conversation.projectId,
      identity.conversationId,
    ).find((row) => {
      try {
        const raw = JSON.parse(row.rawJson) as { clientRequestId?: unknown };
        return raw.clientRequestId === clientRequestId;
      } catch {
        return false;
      }
    });
    if (!matching) return null;
    const entry = fromStoredThreadMessage(matching);
    if (entry.requestHash !== requestHash) {
      throw conflict("clientRequestId was already used for a different Conversation message.");
    }
    return {
      user: entry,
      assistant: null,
      run: null,
      providerSessionId: null,
      mode: "chat",
    };
  } finally {
    database.close();
  }
}

function runConversationMessageSingleFlight(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  clientRequestId: string | undefined,
  requestHash: string | null,
  execute: () => Promise<TopicMessageResult>,
): Promise<TopicMessageResult> {
  if (!clientRequestId || !requestHash) return execute();
  const key = conversationMessageFlightKey(identity, clientRequestId);
  const existing = conversationMessageFlights.get(key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return Promise.reject(conflict("clientRequestId was already used for a different Conversation message."));
    }
    return existing.promise;
  }
  const promise = Promise.resolve().then(execute);
  conversationMessageFlights.set(key, { requestHash, promise });
  void promise.then(
    () => clearConversationMessageFlight(key, promise),
    () => clearConversationMessageFlight(key, promise),
  );
  return promise;
}

function runConversationMessageExecutionExclusive(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  execute: () => Promise<TopicMessageResult>,
): Promise<TopicMessageResult> {
  const key = conversationMessageExecutionFlightKey(identity);
  const existing = conversationMessageExecutionFlights.get(key);
  if (existing) {
    return Promise.reject(conflict("A Conversation Turn is already starting or running."));
  }
  const promise = Promise.resolve().then(execute);
  conversationMessageExecutionFlights.set(key, { promise });
  void promise.then(
    () => clearConversationMessageExecutionFlight(key, promise),
    () => clearConversationMessageExecutionFlight(key, promise),
  );
  return promise;
}

function runConversationMessagePreparationSingleFlight(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  clientRequestId: string | undefined,
  requestHash: string | null,
  execute: () => Promise<PreparedConversationMessage>,
): Promise<PreparedConversationMessage> {
  if (!clientRequestId || !requestHash) return execute();
  const key = conversationMessageFlightKey(identity, clientRequestId);
  const existing = conversationMessagePreparationFlights.get(key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return Promise.reject(conflict("clientRequestId was already used for a different Conversation message."));
    }
    return existing.promise;
  }
  const promise = Promise.resolve().then(execute);
  const flight: ConversationMessagePreparationFlight = { requestHash, promise, expiry: null };
  conversationMessagePreparationFlights.set(key, flight);
  void promise.then(
    () => {
      if (conversationMessagePreparationFlights.get(key)?.promise !== promise) return;
      flight.expiry = setTimeout(
        () => clearConversationMessagePreparationFlight(identity, clientRequestId, requestHash),
        30_000,
      );
      flight.expiry.unref?.();
    },
    () => clearConversationMessagePreparationFlight(identity, clientRequestId, requestHash),
  );
  return promise;
}

function clearConversationMessagePreparationFlight(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  clientRequestId: string | undefined,
  requestHash: string | null,
): void {
  if (!clientRequestId || !requestHash) return;
  const key = conversationMessageFlightKey(identity, clientRequestId);
  const flight = conversationMessagePreparationFlights.get(key);
  if (!flight || flight.requestHash !== requestHash) return;
  if (flight.expiry) clearTimeout(flight.expiry);
  conversationMessagePreparationFlights.delete(key);
}

function conversationMessageFlightKey(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  clientRequestId: string,
): string {
  return [identity.conversation.projectId, identity.conversation.productMode, identity.conversationId, clientRequestId].join("\0");
}

function conversationMessageExecutionFlightKey(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
): string {
  return [identity.conversation.projectId, identity.conversation.productMode, identity.conversationId].join("\0");
}

function clearConversationMessageFlight(key: string, promise: Promise<TopicMessageResult>): void {
  if (conversationMessageFlights.get(key)?.promise === promise) conversationMessageFlights.delete(key);
}

function clearConversationMessageExecutionFlight(key: string, promise: Promise<TopicMessageResult>): void {
  if (conversationMessageExecutionFlights.get(key)?.promise === promise) conversationMessageExecutionFlights.delete(key);
}

function replayedConversationMessageResult(message: StoredTopicMessage): TopicMessageResult {
  return {
    user: fromStoredThreadMessage(message),
    assistant: null,
    run: null,
    providerSessionId: null,
    mode: "chat",
  };
}

async function assertConversationQueueAdmission(
  identity: Awaited<ReturnType<typeof resolveStoredConversationIdentity>>,
  parsed: Awaited<ReturnType<typeof normalizeTopicMessageInput>>,
): Promise<void> {
  if (parsed.agentSurfaceId) return;
  const paths = identity.runtimeState.state === "onboarding"
    ? identity.runtimeState.paths
    : identity.runtimeState.resolution.paths;
  const database = await openProjectRuntimeWorkbenchDatabase(paths);
  try {
    const head = database.conversationTurnQueues.listItems(
      identity.conversation.projectId,
      identity.conversationId,
    )[0];
    if (!head) {
      if (parsed.queuedTurnDispatch) throw conflict("Queued Turn dispatch no longer matches an active FIFO item.");
      return;
    }
    if (parsed.queuedTurnDispatch) {
      if (parsed.planHandoffIntent || head.status !== "dispatching"
        || head.queueItemId !== parsed.queuedTurnDispatch.queueItemId
        || head.dispatchRequestId !== parsed.queuedTurnDispatch.dispatchRequestId
        || head.requestHash !== parsed.queuedTurnDispatch.requestHash) {
        throw conflict("Queued Turn dispatch does not match the exact dispatching FIFO head.");
      }
      return;
    }
    if (identity.conversation.productMode === "harness" && parsed.planHandoffIntent && !parsed.providerId) {
      validatePlanHandoffIntent(
        database.timeline.listConversationMessages(identity.conversation.projectId, identity.conversationId)
          .map(fromStoredThreadMessage),
        parsed.planHandoffIntent,
      );
      return;
    }
    throw conflict("An active Conversation Turn queue must dispatch its FIFO head before another Turn.");
  } finally {
    database.close();
  }
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function normalizeRequestedAgentTurnMode(productMode: ProductMode, value: AgentTurnMode | undefined): AgentTurnMode | null {
  if (productMode === "harness") {
    if (value !== undefined) {
      const error = new Error("Harness requests cannot carry agentTurnMode.");
      error.name = "Conflict";
      throw error;
    }
    return null;
  }
  if (value === undefined) return "default";
  try {
    return assertAgentTurnMode(value);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.name = "BadRequest";
    throw error;
  }
}

function normalizeRequestedAgentModelSelection(
  _productMode: ProductMode,
  modelId: string | null | undefined,
  reasoningEffort: string | null | undefined,
): { modelId: string | null; reasoningEffort: string | null } {
  return {
    modelId: normalizeNullableSelection(modelId ?? null, "modelId"),
    reasoningEffort: normalizeNullableSelection(reasoningEffort ?? null, "reasoningEffort"),
  };
}

function normalizeNullableSelection(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  const error = new Error(`${field} must be a non-empty string or null.`);
  error.name = "BadRequest";
  throw error;
}
