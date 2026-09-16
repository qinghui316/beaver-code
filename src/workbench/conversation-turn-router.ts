import type { ProductMode, ProviderRegistry } from "../provider-runtime/index.js";
import type { ProjectRuntimeCoordinatorPort, ProjectRuntimeState } from "../project-runtime/coordinator.js";
import type { ProjectRuntimePaths } from "../project-runtime/paths.js";
import { DirectAgentConversationTurnStrategy } from "./direct-agent-conversation-turn-strategy.js";
import { HarnessConversationTurnStrategy } from "./harness-conversation-turn-strategy.js";
import { runProjectScopedMainAgentTurn } from "./main-agent-turn-coordinator.js";
import { switchConversationProviderAtSafePoint } from "./provider-switch.js";
import { openProjectRuntimeWorkbenchDatabase } from "./persistence/open-workbench-database.js";
import type { ManagedProject } from "../types/index.js";
import type { StoredConversation } from "./persistence/contracts.js";
import type {
  ConversationTurnContinuationOptions,
  ConversationTurnContinuationPort,
  ConversationTurnAdmission,
  ConversationTurnAdmissionRequest,
  ConversationTurnExecutionPorts,
  ConversationTurnRequest,
  ConversationTurnStrategy,
  ConversationTurnRoutingPort,
} from "./conversation-turn-contract.js";
import type { TopicMessageResult, TopicThreadEntry, ValidatedPlanHandoffIntent, WorkbenchLiveSink } from "./types.js";
import type { TurnSkillContextPort } from "./conversation-turn-contract.js";
import { TurnAttachmentResolver } from "./turn-attachment-resolver.js";
import type { ConversationTurnControlOwner } from "./conversation-turn-control.js";
import { ConversationModelAdmissionOwner } from "./conversation-model-admission.js";
import type { ConversationContextLifecycleOwner } from "./conversation-context-lifecycle.js";

export type ConversationTurnStrategies = Readonly<Record<ProductMode, ConversationTurnStrategy>>;

export interface ConversationTurnRouterCompositionOptions {
  skillContext: TurnSkillContextPort;
  providerRegistry: ProviderRegistry;
  projectRuntimeCoordinator: Pick<ProjectRuntimeCoordinatorPort, "resolve" | "runtimePaths">;
  resolveRuntimePaths?: (projectId: string) => ProjectRuntimePaths;
  attachmentResolver?: TurnAttachmentResolver;
  turnControl?: ConversationTurnControlOwner;
  modelAdmissionOwner?: ConversationModelAdmissionOwner;
  contextLifecycle?: ConversationContextLifecycleOwner;
}

export function createConversationTurnRouter(
  options: ConversationTurnRouterCompositionOptions,
): ConversationTurnRouter {
  const resolveRuntimePaths = options.resolveRuntimePaths
    ?? ((projectId: string) => options.projectRuntimeCoordinator.runtimePaths(projectId));
  const attachmentResolver = options.attachmentResolver ?? new TurnAttachmentResolver({ resolveRuntimePaths });
  const modelAdmissionOwner = options.modelAdmissionOwner ?? new ConversationModelAdmissionOwner(options.providerRegistry);
  return new ConversationTurnRouter(
    {
      agent: new DirectAgentConversationTurnStrategy({
        providerRegistry: options.providerRegistry,
        resolveRuntimePaths,
        attachmentResolver,
        turnControl: options.turnControl,
        contextLifecycle: options.contextLifecycle,
      }),
      harness: new HarnessConversationTurnStrategy((project, conversationId, userMessage, live, handoff, runnerOptions) => (
        runProjectScopedMainAgentTurn(project, conversationId, userMessage, live, handoff, {
          ...runnerOptions,
          providerRegistry: options.providerRegistry,
          runtimeState: runnerOptions.runtimeState!,
          turnControl: options.turnControl,
          contextLifecycle: options.contextLifecycle,
        })
      )),
    },
    { skillContext: options.skillContext },
    {
      projectRuntimeCoordinator: options.projectRuntimeCoordinator,
      providerRegistry: options.providerRegistry,
      attachmentResolver,
      modelAdmissionOwner,
    },
  );
}

export class ConversationTurnRouter {
  private readonly runtimeStateResolver: (project: ManagedProject) => Promise<ProjectRuntimeState>;

  constructor(
    private readonly strategies: ConversationTurnStrategies,
    private readonly ports: ConversationTurnExecutionPorts,
    options: Pick<ConversationTurnRouterCompositionOptions, "projectRuntimeCoordinator" | "providerRegistry" | "turnControl" | "modelAdmissionOwner" | "contextLifecycle"> & { attachmentResolver?: TurnAttachmentResolver },
  ) {
    this.runtimeStateResolver = (project) => options.projectRuntimeCoordinator.resolve(project);
    this.providerRegistry = options.providerRegistry;
    this.turnControl = options.turnControl;
    this.attachmentResolver = options.attachmentResolver ?? new TurnAttachmentResolver({
      resolveRuntimePaths: (projectId) => options.projectRuntimeCoordinator.runtimePaths(projectId),
    });
    this.modelAdmissionOwner = options.modelAdmissionOwner ?? new ConversationModelAdmissionOwner(options.providerRegistry);
    this.contextLifecycle = options.contextLifecycle;
    for (const productMode of ["agent", "harness"] as const) {
      if (strategies[productMode].productMode !== productMode) {
        throw new Error(`Conversation Turn Strategy for ${productMode} must declare the same productMode.`);
      }
    }
  }

  private readonly providerRegistry: ProviderRegistry;
  private readonly attachmentResolver: TurnAttachmentResolver;
  private readonly turnControl?: ConversationTurnControlOwner;
  private readonly modelAdmissionOwner: ConversationModelAdmissionOwner;
  private readonly contextLifecycle?: ConversationContextLifecycleOwner;

  readonly resolveAttachments = (project: ManagedProject, attachmentIds: readonly string[] = []) => (
    this.attachmentResolver.resolveMetadata(project, attachmentIds)
  );

  assertRequestedMode(conversation: StoredConversation, requestedMode?: ProductMode): void {
    if (requestedMode === undefined || requestedMode === conversation.productMode) return;
    const error = new Error("Conversation productMode does not match the requested mode.");
    error.name = "Conflict";
    throw error;
  }

  async route(input: ConversationTurnRequest, requestedMode?: ProductMode): Promise<TopicMessageResult> {
    this.assertRequestedMode(input.conversation, requestedMode);
    assertProviderIdentity(input);
    assertAdmissionIdentity(input);
    const runtimeState = input.admission.runtimeState;
    const strategy = this.strategies[input.conversation.productMode];
    await strategy.preflight?.({ ...input, runtimeState });
    const turnSkillResolution = input.preparedSkillResolution === undefined
      ? await this.resolveSkillContextForTurn(input, runtimeState)
      : input.preparedSkillResolution;
    assertExpectedSkillInputs(input.expectedSkillInputs, turnSkillResolution);
    return strategy.execute({
      ...input,
      runtimeState,
      turnSkillResolution: freezeResolution(turnSkillResolution),
    }, this.ports);
  }

  async admit(input: ConversationTurnAdmissionRequest): Promise<ConversationTurnAdmission> {
    const runtimeState = await this.requireRuntimeState(input.project);
    if (input.productMode === "harness") {
      if (input.agentTurnMode !== null) throw conflict("Harness Turn cannot carry an Agent Turn mode.");
      const resolved = await this.providerRegistry.requireProfiles(
        input.providerId,
        ["main"],
        "harness",
        input.project,
        input.project.path,
      );
      const modelAdmission = await this.modelAdmissionOwner.admit({
        project: input.project,
        providerId: input.providerId,
        requested: { providerId: input.providerId, modelId: input.modelId, reasoningEffort: input.reasoningEffort },
        requireResolvedModel: false,
      });
      return freezeAdmission({
        projectId: input.project.id,
        productMode: input.productMode,
        conversationId: input.conversationId,
        providerId: input.providerId,
        agentTurnMode: null,
        capabilitySnapshot: resolved.snapshot,
        model: modelAdmission.resolvedModelId
          ? { providerId: input.providerId, modelId: modelAdmission.resolvedModelId }
          : null,
        modelAdmission,
        sandboxPolicy: "workspace-write",
        writableRoots: [input.project.path],
        runtimeState,
        attachmentResolution: null,
      });
    }
    const attachmentResolution = await this.attachmentResolver.resolve(input.project, input.attachments);
    const agentTurnMode = input.agentTurnMode ?? "default";
    const resolved = await this.providerRegistry.requireProfiles(
      input.providerId,
      ["agent"],
      "agent",
      input.project,
      input.project.path,
    );
    if (agentTurnMode === "plan") {
      const plan = resolved.snapshot.capabilities.find((capability) => capability.key === "turn.plan");
      if (plan?.runtime !== "ready") {
        throw conflict("Selected Provider cannot run Agent Plan turns.");
      }
    }
    const modelAdmission = await this.modelAdmissionOwner.admit({
      project: input.project,
      providerId: input.providerId,
      requested: { providerId: input.providerId, modelId: input.modelId, reasoningEffort: input.reasoningEffort },
      requireResolvedModel: agentTurnMode === "plan",
    });
    requireAttachmentCapabilities(resolved.snapshot, attachmentResolution);
    return freezeAdmission({
      projectId: input.project.id,
      productMode: "agent",
      conversationId: input.conversationId,
      providerId: input.providerId,
      agentTurnMode,
      capabilitySnapshot: resolved.snapshot,
      model: modelAdmission.resolvedModelId
        ? { providerId: input.providerId, modelId: modelAdmission.resolvedModelId }
        : null,
      modelAdmission,
      sandboxPolicy: agentTurnMode === "plan" ? "read-only" : "workspace-write",
      writableRoots: agentTurnMode === "plan" ? [] : [input.project.path],
      runtimeState,
      attachmentResolution,
    });
  }

  readonly resolveRuntimeState = async (project: ManagedProject): Promise<ProjectRuntimeState> => this.requireRuntimeState(project);

  readonly resolveTurnSkills: NonNullable<ConversationTurnRoutingPort["resolveTurnSkills"]> = async (
    project,
    conversation,
    requiredSkillIds = [],
  ) => freezeResolution(await this.resolveSkillContextForTurn(
    { project, conversation, requiredSkillIds },
    await this.requireRuntimeState(project),
  ));

  readonly resolveProviderId = (project: ManagedProject, requestedProviderId?: string): string => {
    return (requestedProviderId
      ? this.providerRegistry.get(requestedProviderId)
      : project.defaultProviderId
        ? this.providerRegistry.get(project.defaultProviderId)
        : this.providerRegistry.requireOnly()).id;
  };

  readonly switchProviderAtSafePoint: NonNullable<ConversationTurnRoutingPort["switchProviderAtSafePoint"]> = (input) => (
    switchConversationProviderAtSafePoint({
      ...input,
      registry: this.providerRegistry,
    })
  );

  readonly interruptMainAgentTurn: NonNullable<ConversationTurnRoutingPort["interruptMainAgentTurn"]> = async (
    project,
    conversationId,
  ) => {
    if (!this.turnControl) return null;
    const runtime = await this.requireRuntimeState(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, conversationId);
      if (!conversation || conversation.deletedAt) throw notFound("Conversation not found.");
      if (conversation.productMode !== "harness") throw conflict("Harness Turn interrupt requires a Harness Conversation.");
      const attempt = [...database.providerAttempts.listProviderAttempts(paths.projectId, conversation.conversationId)]
        .reverse()
        .find((candidate) => candidate.productMode === "harness"
          && candidate.operationProfile === "main"
          && candidate.roleId === "main-agent"
          && candidate.graphScopeId === conversation.currentGraphScopeId
          && (candidate.status === "queued" || candidate.status === "running"));
      if (!attempt) return null;
      const state = this.turnControl.state(paths.projectId, conversation.conversationId, attempt.attemptId);
      if (!state.canInterrupt) return null;
      return this.turnControl.interrupt(project, {
        projectId: paths.projectId,
        productMode: "harness",
        conversationId: conversation.conversationId,
        providerId: attempt.providerId,
        expectedAttemptId: attempt.attemptId,
      });
    } finally {
      database.close();
    }
  };

  readonly steerMainAgentTurn: NonNullable<ConversationTurnRoutingPort["steerMainAgentTurn"]> = async (
    project,
    conversationId,
    clientRequestId,
    text,
  ) => {
    if (!this.turnControl) return null;
    const runtime = await this.requireRuntimeState(project);
    const paths = runtime.state === "onboarding" ? runtime.paths : runtime.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, conversationId);
      if (!conversation || conversation.deletedAt) throw notFound("Conversation not found.");
      if (conversation.productMode !== "harness") throw conflict("Harness Turn steering requires a Harness Conversation.");
      const attempt = [...database.providerAttempts.listProviderAttempts(paths.projectId, conversation.conversationId)]
        .reverse()
        .find((candidate) => candidate.productMode === "harness"
          && candidate.operationProfile === "main"
          && candidate.roleId === "main-agent"
          && candidate.graphScopeId === conversation.currentGraphScopeId
          && (candidate.status === "queued" || candidate.status === "running"));
      if (!attempt) return null;
      const state = this.turnControl.state(paths.projectId, conversation.conversationId, attempt.attemptId);
      if (state.state === "idle") throw conflict("The current Harness Attempt is not owned by a current-process Provider Turn.");
      return this.turnControl.steer(project, {
        projectId: paths.projectId,
        productMode: "harness",
        conversationId: conversation.conversationId,
        providerId: attempt.providerId,
        expectedAttemptId: attempt.attemptId,
        clientRequestId,
        text,
      });
    } finally {
      database.close();
    }
  };

  readonly runAgentNativeChildFollowup: NonNullable<ConversationTurnRoutingPort["runAgentNativeChildFollowup"]> = async (input) => {
    const { runAgentNativeChildFollowup } = await import("./agent-native-child-lifecycle-service.js");
    return runAgentNativeChildFollowup({ ...input, providerRegistry: this.providerRegistry });
  };

  readonly runExactChildAgentTurn: NonNullable<ConversationTurnRoutingPort["runExactChildAgentTurn"]> = async (input) => {
    const { runExactChildAgentTurn } = await import("./provider-child-turn-coordinator.js");
    return runExactChildAgentTurn(input);
  };

  readonly continueMainAgentTurn: ConversationTurnContinuationPort = async (
    project: ManagedProject,
    conversationId: string,
    message: string,
    live?: WorkbenchLiveSink,
    planHandoff?: ValidatedPlanHandoffIntent,
    options?: ConversationTurnContinuationOptions,
  ): Promise<TopicThreadEntry> => {
    const turn = await this.readContinuationTurn(project, conversationId);
    if (turn.conversation.productMode !== "harness") {
      const error = new Error("Main Agent continuation requires a Harness Conversation.");
      error.name = "Conflict";
      throw error;
    }
    if (turn.runtimeState.state !== "ready") {
      const error = new Error(`Main Agent continuation requires a ready Project Harness, got ${turn.runtimeState.state}.`);
      error.name = "Conflict";
      throw error;
    }
    const turnSkillResolution = await this.resolveSkillContextForTurn({
      project,
      conversation: turn.conversation,
      requiredSkillIds: [],
    }, turn.runtimeState);
    const modelAdmission = await this.modelAdmissionOwner.admit({
      project,
      providerId: turn.conversation.selectedProviderId,
      requested: {
        providerId: turn.conversation.selectedProviderId,
        modelId: turn.conversation.agentModelId,
        reasoningEffort: turn.conversation.agentReasoningEffort,
      },
      requireResolvedModel: false,
    });
    return runProjectScopedMainAgentTurn(project, conversationId, message, live, planHandoff, {
      ...options,
      providerRegistry: this.providerRegistry,
      runtimeState: turn.runtimeState,
      turnSkillResolution: freezeResolution(turnSkillResolution),
      model: modelAdmission.resolvedModelId
        ? { providerId: turn.conversation.selectedProviderId, modelId: modelAdmission.resolvedModelId }
        : null,
      reasoningEffort: modelAdmission.resolvedReasoningEffort,
      turnControl: this.turnControl,
      contextLifecycle: this.contextLifecycle,
    });
  };

  private async requireRuntimeState(project: ManagedProject): Promise<ProjectRuntimeState> {
    return this.runtimeStateResolver(project);
  }

  private async resolveSkillContextForTurn(
    input: Pick<ConversationTurnRequest, "project" | "conversation" | "requiredSkillIds">,
    runtimeState: ProjectRuntimeState,
  ): Promise<import("./conversation-turn-contract.js").TurnSkillContextResolution | null> {
    if (input.conversation.productMode === "harness" && runtimeState.state === "onboarding") {
      return null;
    }
    return this.ports.skillContext.resolve({
      project: input.project,
      conversation: input.conversation,
      requiredSkillIds: input.requiredSkillIds ?? [],
      runtimeState,
    });
  }

  private async readContinuationTurn(project: ManagedProject, conversationId: string): Promise<{
    conversation: StoredConversation;
    runtimeState: ProjectRuntimeState;
  }> {
    const runtimeState = await this.requireRuntimeState(project);
    const paths = runtimeState.state === "onboarding" ? runtimeState.paths : runtimeState.resolution.paths;
    const database = await openProjectRuntimeWorkbenchDatabase(paths);
    try {
      const conversation = database.conversations.readConversation(paths.projectId, conversationId);
      if (!conversation) throw new Error(`Conversation not found: ${conversationId}.`);
      return { conversation, runtimeState };
    } finally {
      database.close();
    }
  }
}

function freezeAdmission(admission: ConversationTurnAdmission): ConversationTurnAdmission {
  if (admission.capabilitySnapshot) {
    const capabilities = admission.capabilitySnapshot.capabilities.map((capability) => Object.freeze({ ...capability }));
    admission.capabilitySnapshot = Object.freeze({
      ...admission.capabilitySnapshot,
      degradedReasons: Object.freeze([...admission.capabilitySnapshot.degradedReasons]) as unknown as string[],
      capabilities: Object.freeze(capabilities) as unknown as typeof admission.capabilitySnapshot.capabilities,
    });
  }
  if (admission.model) admission.model = Object.freeze({ ...admission.model });
  if (admission.modelAdmission) {
    Object.freeze(admission.modelAdmission.requested);
    Object.freeze(admission.modelAdmission);
  }
  Object.freeze(admission.writableRoots);
  return Object.freeze(admission);
}

function freezeResolution(
  resolution: import("./conversation-turn-contract.js").TurnSkillContextResolution | null,
): import("./conversation-turn-contract.js").TurnSkillContextResolution | null {
  if (!resolution) return null;
  Object.freeze(resolution.skillInputs);
  Object.freeze(resolution.diagnostics);
  if (resolution.nativeSkillRoots) Object.freeze(resolution.nativeSkillRoots);
  if (resolution.requiredNativeSkills) Object.freeze(resolution.requiredNativeSkills);
  return Object.freeze(resolution);
}

function assertProviderIdentity(input: import("./conversation-turn-contract.js").ConversationTurnRequest): void {
  if (input.providerId === input.conversation.selectedProviderId) return;
  const error = new Error("Conversation Provider does not match the requested Provider.");
  error.name = "Conflict";
  throw error;
}

function assertAdmissionIdentity(input: import("./conversation-turn-contract.js").ConversationTurnRequest): void {
  const admission = input.admission;
  if (admission.projectId !== input.project.id
    || admission.productMode !== input.conversation.productMode
    || admission.conversationId !== input.conversation.conversationId
    || admission.providerId !== input.providerId
    || admission.agentTurnMode !== (input.actualAgentTurnMode ?? input.conversation.agentTurnMode)) {
    throw conflict("Turn admission does not match the committed Conversation identity.");
  }
  if (input.conversation.productMode === "agent") {
    const expected = [...new Set(input.attachments.map((attachment) => attachment.id))].sort();
    const admitted = admission.attachmentResolution?.attachmentIds ?? [];
    if (JSON.stringify(expected) !== JSON.stringify(admitted)) {
      throw conflict("Turn admission attachment identity does not match the committed message.");
    }
  }
}

function assertExpectedSkillInputs(
  expected: readonly import("../project-harness/contracts.js").ProviderSkillInput[] | undefined,
  resolution: import("./conversation-turn-contract.js").TurnSkillContextResolution | null,
): void {
  if (!expected) return;
  const stable = (items: readonly import("../project-harness/contracts.js").ProviderSkillInput[]) => items
    .map((item) => ({
      id: item.id,
      path: item.path,
      source: item.source,
      contentHash: item.contentHash,
      required: item.required,
    }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  if (!resolution || JSON.stringify(stable(expected)) !== JSON.stringify(stable(resolution.skillInputs))) {
    throw conflict("Retry Skill inputs no longer match the failed Agent Turn.");
  }
}

function conflict(message: string): Error {
  const error = new Error(message);
  error.name = "Conflict";
  return error;
}

function notFound(message: string): Error {
  const error = new Error(message);
  error.name = "NotFound";
  return error;
}

function requireAttachmentCapabilities(
  snapshot: import("../provider-runtime/index.js").ProviderCapabilitySnapshot,
  resolution: import("./conversation-turn-contract.js").TurnAttachmentResolution,
): void {
  const readiness = new Map(snapshot.capabilities.map((item) => [item.key, item.runtime]));
  const missing: string[] = [];
  if (resolution.imageInputs.length > 0 && readiness.get("image.input") !== "ready") missing.push("image.input");
  if (resolution.fileInputs.length > 0 && readiness.get("file.reference") !== "ready") missing.push("file.reference");
  if (missing.length > 0) throw conflict(`Selected Provider cannot accept the managed attachments; missing ready capabilities: ${missing.join(", ")}.`);
}
