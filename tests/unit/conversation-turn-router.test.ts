import { describe, expect, it, vi } from "vitest";
import type { ManagedProject } from "../../src/types/index.js";
import { PROVIDER_OPERATION_CAPABILITIES, type ProviderCapabilitySnapshot } from "../../src/provider-runtime/types.js";
import { ProviderRegistry } from "../../src/provider-runtime/registry.js";
import { resolveProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import type { ProjectRuntimeState } from "../../src/project-runtime/coordinator.js";
import { ConversationTurnRouter } from "../../src/workbench/conversation-turn-router.js";
import { DirectAgentConversationTurnStrategy } from "../../src/workbench/direct-agent-conversation-turn-strategy.js";
import { HarnessConversationTurnStrategy } from "../../src/workbench/harness-conversation-turn-strategy.js";
import type {
  ConversationTurnExecutionPorts,
  ConversationTurnRequest,
  ConversationTurnStrategy,
  ConversationTurnStrategyInput,
} from "../../src/workbench/conversation-turn-contract.js";
import type { StoredConversation, StoredTopicMessage } from "../../src/workbench/persistence/contracts.js";
import type { TopicMessageResult, TopicThreadEntry } from "../../src/workbench/types.js";

describe("ConversationTurnRouter", () => {
  it("selects exactly one Strategy from the persisted Conversation mode", async () => {
    const agentResult = topicResult("agent");
    const harnessResult = topicResult("harness");
    const agent = strategy("agent", agentResult);
    const harness = strategy("harness", harnessResult);
    const router = new ConversationTurnRouter({ agent, harness }, ports(), compositionOwner());

    await expect(router.route(turnInput("harness"), "harness")).resolves.toBe(harnessResult);
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(agent.execute).not.toHaveBeenCalled();

    await expect(router.route(turnInput("agent"), "agent")).resolves.toBe(agentResult);
    expect(agent.execute).toHaveBeenCalledOnce();
  });

  it("rejects an asserted mode mismatch before invoking any Strategy", async () => {
    const agent = strategy("agent", topicResult("agent"));
    const harness = strategy("harness", topicResult("harness"));
    const router = new ConversationTurnRouter({ agent, harness }, ports(), compositionOwner());

    expect(() => router.assertRequestedMode(conversation("harness"), "agent"))
      .toThrow("Conversation productMode does not match the requested mode.");
    await expect(router.route(turnInput("harness"), "agent")).rejects.toMatchObject({ name: "Conflict" });
    expect(agent.execute).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("fails construction when a Strategy is registered under the wrong mode", () => {
    const harness = strategy("harness", topicResult("harness"));
    expect(() => new ConversationTurnRouter({ agent: harness, harness }, ports(), compositionOwner()))
      .toThrow("Conversation Turn Strategy for agent must declare the same productMode.");
  });

  it("resolves one immutable Skill context for each non-onboarding top-level Turn", async () => {
    const resolution = Object.freeze({
      skillInputs: Object.freeze([{ id: "marker", path: "C:\\skills\\marker\\SKILL.md", contentHash: "marker-hash", source: "provider-native" as const, required: false }]),
      diagnostics: Object.freeze([]),
      nativeSkillRoots: Object.freeze(["C:\\skills"]),
      requiredNativeSkills: Object.freeze([]),
      resolutionHash: "resolution-hash",
    });
    const resolveSkillContext = vi.fn(async () => resolution);
    const agent = strategy("agent", topicResult("agent"));
    const harness = strategy("harness", topicResult("harness"));
    const input = turnRequest("agent");
    const owner = compositionOwner(readyState(project()));
    const readyRouter = new ConversationTurnRouter(
      { agent, harness },
      ports(resolveSkillContext),
      owner,
    );

    await expect(readyRouter.route(input, "agent")).resolves.toEqual(topicResult("agent"));
    expect(resolveSkillContext).toHaveBeenCalledOnce();
    const routedInput = agent.execute.mock.calls[0]![0] as ConversationTurnStrategyInput;
    expect(routedInput.turnSkillResolution).toBe(resolution);
    expect(Object.isFrozen(routedInput.turnSkillResolution)).toBe(true);
    expect(Object.isFrozen(routedInput.turnSkillResolution?.skillInputs)).toBe(true);
  });

  it("does not resolve Skill context for a Harness onboarding Turn", async () => {
    const resolveSkillContext = vi.fn(async () => ({ skillInputs: [], diagnostics: [] }));
    const agent = strategy("agent", topicResult("agent"));
    const harness = strategy("harness", topicResult("harness"));
    const router = new ConversationTurnRouter(
      { agent, harness },
      ports(resolveSkillContext),
      compositionOwner(),
    );

    await expect(router.route(turnRequest("harness"), "harness"))
      .resolves.toEqual(topicResult("harness"));
    expect(resolveSkillContext).not.toHaveBeenCalled();
    expect(harness.execute.mock.calls[0]![0]).toMatchObject({ turnSkillResolution: null });
  });

  it("admits an AHO Main Turn with the same explicit model selection contract as Agent mode", async () => {
    const modelAdmission = {
      providerId: "codex",
      requested: { providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" },
      resolvedModelId: "gpt-test",
      resolvedReasoningEffort: "high",
      modelSource: "explicit" as const,
      effortSource: "explicit" as const,
      catalogGeneration: "catalog-generation",
    };
    const admit = vi.fn(async () => modelAdmission);
    const capabilitySnapshot: ProviderCapabilitySnapshot = {
      ...agentCapabilitySnapshot(),
      productMode: "harness",
      capabilities: PROVIDER_OPERATION_CAPABILITIES.main.map((key) => ({
        key, label: key, spec: "supported", runtime: "ready", summary: "ready",
      })),
    };
    const providerRegistry = {
      requireProfiles: vi.fn(async () => ({ descriptor: {}, snapshot: capabilitySnapshot })),
    };
    const router = new ConversationTurnRouter(
      { agent: strategy("agent", topicResult("agent")), harness: strategy("harness", topicResult("harness")) },
      ports(),
      {
        projectRuntimeCoordinator: {
          resolve: async () => readyState(project()),
          runtimePaths: (projectId: string) => resolveProjectRuntimePaths(projectId, "C:\\aho-test"),
        },
        providerRegistry: providerRegistry as never,
        modelAdmissionOwner: { admit } as never,
      },
    );

    await expect(router.admit({
      project: project(),
      productMode: "harness",
      conversationId: "conversation-1",
      providerId: "codex",
      agentTurnMode: null,
      modelId: "gpt-test",
      reasoningEffort: "high",
      attachments: [],
    })).resolves.toMatchObject({
      productMode: "harness",
      providerId: "codex",
      agentTurnMode: null,
      model: { providerId: "codex", modelId: "gpt-test" },
      modelAdmission,
      capabilitySnapshot,
    });
    expect(providerRegistry.requireProfiles).toHaveBeenCalledWith("codex", ["main"], "harness", project(), project().path);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      requested: { providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" },
    }));
  });

  it("rejects an attachment Turn whose admission lacks the immutable resolution", async () => {
    const resolveSkillContext = vi.fn(async () => ({ skillInputs: [], diagnostics: [] }));
    const agent = new DirectAgentConversationTurnStrategy({
      providerRegistry: {
        requireProfiles: vi.fn(),
        findActiveTurn: vi.fn(),
      },
    });
    const harness = strategy("harness", topicResult("harness"));
    const router = new ConversationTurnRouter(
      { agent, harness },
      ports(resolveSkillContext),
      compositionOwner(),
    );

    await expect(router.route({
      ...turnRequest("agent"),
      attachments: [{
        id: "attachment-1",
        fileName: "note.txt",
        mediaType: "text/plain",
        kind: "text",
        size: 4,
        hash: "attachment-hash",
        source: "composer",
        createdAt: "2026-08-11T00:00:00.000Z",
        storagePath: "attachments/attachment-1/note.txt",
        runtimeMode: "bounded-text-preview",
      }],
    }, "agent")).rejects.toMatchObject({
      name: "Conflict",
      message: "Turn admission attachment identity does not match the committed message.",
    });
    expect(resolveSkillContext).not.toHaveBeenCalled();
  });

  it("rejects repair-required Harness Turns before resolving Skills", async () => {
    const resolveSkillContext = vi.fn(async () => ({ skillInputs: [], diagnostics: [] }));
    const runTurn = vi.fn(async () => { throw new Error("must not run"); });
    const agent = strategy("agent", topicResult("agent"));
    const harness = new HarnessConversationTurnStrategy(runTurn);
    const request = turnRequest("harness");
    const runtimeState = repairRequiredState(request.project);
    request.admission = { ...request.admission, runtimeState };
    const router = new ConversationTurnRouter(
      { agent, harness },
      ports(resolveSkillContext),
      compositionOwner(runtimeState),
    );

    await expect(router.route(request, "harness"))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(resolveSkillContext).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("does not expose runtime state or a pre-resolved Skill context on the public route input", () => {
    const request: ConversationTurnRequest = turnRequest("agent");
    // @ts-expect-error Production callers cannot inject a Skill resolution.
    request.turnSkillResolution = { skillInputs: [], diagnostics: [] };
    // @ts-expect-error Production callers cannot bypass the composition-owned runtime coordinator.
    request.runtimeState = readyState(project());
  });

  it("rejects Agent and non-ready Conversations before resolving continuation Skills", async () => {
    const resolveSkillContext = vi.fn(async () => ({ skillInputs: [], diagnostics: [] }));
    const agent = strategy("agent", topicResult("agent"));
    const harness = strategy("harness", topicResult("harness"));
    const router = new ConversationTurnRouter({ agent, harness }, ports(resolveSkillContext), compositionOwner());
    const internal = router as unknown as {
      readContinuationTurn: (selectedProject: ManagedProject, conversationId: string) => Promise<{
        conversation: StoredConversation;
        runtimeState: ProjectRuntimeState;
      }>;
    };

    internal.readContinuationTurn = vi.fn(async () => ({
      conversation: conversation("agent"),
      runtimeState: readyState(project()),
    }));
    await expect(router.continueMainAgentTurn(project(), "conversation-1", "continue"))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(resolveSkillContext).not.toHaveBeenCalled();
    expect(agent.execute).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();

    internal.readContinuationTurn = vi.fn(async () => ({
      conversation: conversation("harness"),
      runtimeState: onboardingState(project()),
    }));
    await expect(router.continueMainAgentTurn(project(), "conversation-1", "continue"))
      .rejects.toMatchObject({ name: "Conflict" });
    expect(resolveSkillContext).not.toHaveBeenCalled();
  });
});

describe("Conversation Turn Strategies", () => {
  it("adapts a committed Harness message to the existing Main turn runner", async () => {
    const assistant: TopicThreadEntry = {
      id: "assistant-1",
      type: "assistant.message",
      timestamp: "2026-08-11T00:00:01.000Z",
      conversationId: "conversation-1",
      graphScopeId: "graph:conversation-1",
      changeId: "",
      text: "Harness reply",
    };
    const runTurn = vi.fn(async () => assistant);
    const strategyUnderTest = new HarnessConversationTurnStrategy(runTurn);
    const input = turnInput("harness");

    await expect(strategyUnderTest.execute(input, ports())).resolves.toMatchObject({
      user: { id: "user-1", text: "User message", graphScopeId: "graph:conversation-1" },
      assistant,
      assistantMessage: "Harness reply",
    });
    expect(runTurn).toHaveBeenCalledWith(
      input.project,
      input.conversation.conversationId,
      "User message",
      undefined,
      undefined,
      {
        graphScopeId: "graph:conversation-1",
        model: null,
        reasoningEffort: null,
        runtimeState: input.runtimeState,
        turnSkillResolution: null,
      },
    );
  });
});

function strategy(productMode: "agent" | "harness", result: TopicMessageResult): ConversationTurnStrategy & {
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    productMode,
    execute: vi.fn(async () => result),
  };
}

function ports(
  resolve: ConversationTurnExecutionPorts["skillContext"]["resolve"] = async () => ({ skillInputs: [], diagnostics: [] }),
): ConversationTurnExecutionPorts {
  return {
    skillContext: {
      resolve,
    },
  };
}

function compositionOwner(state?: ProjectRuntimeState) {
  return {
    projectRuntimeCoordinator: {
      resolve: async (selectedProject: ManagedProject) => state ?? onboardingState(selectedProject),
      runtimePaths: (projectId: string) => resolveProjectRuntimePaths(projectId, "C:\\aho-test"),
    },
    providerRegistry: new ProviderRegistry(),
  };
}

function readyState(selectedProject: ManagedProject): ProjectRuntimeState {
  const paths = resolveProjectRuntimePaths(selectedProject.id, "C:\\aho-test");
  const skillRoot = "C:\\project\\.agents\\skills\\project-harness";
  return {
    state: "ready",
    project: selectedProject,
    resolution: {
      projectRoot: selectedProject.path,
      harness: {
        projectId: selectedProject.id,
        skillName: `${selectedProject.id}-harness`,
        skillRevision: 1,
        skillRoot,
        contentFingerprint: "harness-fingerprint",
      },
      binding: {
        projectId: selectedProject.id,
        skillName: `${selectedProject.id}-harness`,
        sourcePath: `${skillRoot}\\SKILL.md`,
        contentFingerprint: "harness-fingerprint",
        providers: [],
      },
      providerInput: {
        id: `${selectedProject.id}-harness`,
        path: `${skillRoot}\\SKILL.md`,
        contentHash: "harness-fingerprint",
        source: "project-harness",
        required: true,
      },
      paths,
    },
  };
}

function onboardingState(selectedProject: ManagedProject): ProjectRuntimeState {
  return {
    state: "onboarding",
    project: selectedProject,
    projectRoot: selectedProject.path,
    paths: resolveProjectRuntimePaths(selectedProject.id, "C:\\aho-test"),
    reservedProjectId: selectedProject.id,
  };
}

function repairRequiredState(selectedProject: ManagedProject): ProjectRuntimeState {
  const ready = readyState(selectedProject);
  if (ready.state !== "ready") throw new Error("Expected ready state fixture.");
  return {
    state: "repair-required",
    project: selectedProject,
    resolution: ready.resolution,
    doctor: {} as Extract<ProjectRuntimeState, { state: "repair-required" }>["doctor"],
    audit: {} as Extract<ProjectRuntimeState, { state: "repair-required" }>["audit"],
  } as ProjectRuntimeState;
}

function turnInput(productMode: "agent" | "harness"): ConversationTurnStrategyInput {
  const selectedProject = project();
  const selectedConversation = conversation(productMode);
  const runtimeState = onboardingState(selectedProject);
  return {
    project: selectedProject,
    conversation: selectedConversation,
    committedMessage: committedMessage(),
    attachments: [],
    providerId: "codex",
    admission: turnAdmission(selectedProject, selectedConversation, runtimeState),
    runtimeState,
    turnSkillResolution: productMode === "agent" ? { skillInputs: [], diagnostics: [] } : null,
  };
}

function turnRequest(productMode: "agent" | "harness"): ConversationTurnRequest {
  const input = turnInput(productMode);
  return {
    project: input.project,
    conversation: input.conversation,
    committedMessage: input.committedMessage,
    attachments: input.attachments,
    providerId: input.providerId,
    admission: input.admission,
  };
}

function turnAdmission(
  selectedProject: ManagedProject,
  selectedConversation: StoredConversation,
  runtimeState: ProjectRuntimeState,
): ConversationTurnStrategyInput["admission"] {
  const agentMode = selectedConversation.productMode === "agent";
  return {
    projectId: selectedProject.id,
    productMode: selectedConversation.productMode,
    conversationId: selectedConversation.conversationId,
    providerId: selectedConversation.selectedProviderId,
    agentTurnMode: agentMode ? selectedConversation.agentTurnMode ?? "default" : null,
    capabilitySnapshot: agentMode ? agentCapabilitySnapshot() : null,
    model: agentMode ? { providerId: selectedConversation.selectedProviderId, modelId: "test-model" } : null,
    sandboxPolicy: "workspace-write",
    writableRoots: [selectedProject.path],
    runtimeState,
  };
}

function agentCapabilitySnapshot(): ProviderCapabilitySnapshot {
  return {
    providerId: "codex",
    displayName: "Codex",
    productMode: "agent",
    status: "ready",
    runnable: true,
    checkedAt: "2026-08-11T00:00:00.000Z",
    snapshotHash: "agent-capabilities",
    snapshotVersion: 1,
    effectiveModel: "test-model",
    effectiveModelSource: "provider-default",
    degradedReasons: [],
    capabilities: PROVIDER_OPERATION_CAPABILITIES.agent.map((key) => ({
      key,
      label: key,
      spec: "supported",
      runtime: "ready",
      summary: "ready",
    })),
  };
}

function conversation(productMode: "agent" | "harness"): StoredConversation {
  return {
    projectId: "project-1",
    conversationId: "conversation-1",
    productMode,
    agentTurnMode: productMode === "agent" ? "default" : null,
    clientCreateRequestId: null,
    clientCreateRequestHash: null,
    title: "Conversation",
    state: "active",
    boundChangeId: null,
    currentGraphScopeId: "graph:conversation-1",
    selectedProviderId: "codex",
    completedTurnSequence: 0,
    timelinePosition: 1,
    timelineRevision: 1,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    deletedAt: null,
  };
}

function committedMessage(): StoredTopicMessage {
  return {
    id: "user-1",
    projectId: "project-1",
    conversationId: "conversation-1",
    changeId: "",
    position: 1,
    revision: 1,
    agentSurfaceId: "main-agent",
    initialThreadInput: false,
    type: "user.message",
    timestamp: "2026-08-11T00:00:00.000Z",
    text: "User message",
    actionRunId: null,
    actionType: null,
    status: null,
    runId: null,
    artifact: null,
    error: null,
    rawJson: JSON.stringify({ graphScopeId: "graph:conversation-1" }),
  };
}

function topicResult(label: string): TopicMessageResult {
  return {
    user: {
      id: `user-${label}`,
      type: "user.message",
      timestamp: "2026-08-11T00:00:00.000Z",
      conversationId: "conversation-1",
      changeId: "",
      text: label,
    },
    assistant: null,
    run: null,
    providerSessionId: null,
  };
}

function project(): ManagedProject {
  return {
    id: "project-1",
    name: "Project",
    path: "C:\\project",
    addedAt: "2026-08-11T00:00:00.000Z",
    lastSeenAt: "2026-08-11T00:00:00.000Z",
  };
}
