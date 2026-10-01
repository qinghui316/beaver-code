import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindProviderThreadFixture } from "../helpers/provider-thread-fixture.js";
import { sameTestPhysicalPath } from "../helpers/windows-short-path.js";

const appServerTurn = vi.hoisted(() => vi.fn());
const appServerChildTurn = vi.hoisted(() => vi.fn());
const appServerChildClose = vi.hoisted(() => vi.fn());
const appServerChildAvailable = vi.hoisted(() => vi.fn());
const appServerAnswer = vi.hoisted(() => vi.fn());
const getActiveAppServerTurn = vi.hoisted(() => vi.fn());
const projectHarnessAgentInput = vi.hoisted(() => ({
  identity: { projectId: "repo", skillName: "repo-harness", skillRevision: 27, contentFingerprint: "a".repeat(64) },
  providerSkillInput: { id: "repo-harness", path: "", contentHash: "b".repeat(64), source: "project-harness" as const, required: true },
}));

vi.mock("../../src/project-harness/agent-input.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/project-harness/agent-input.js")>(),
  resolveProjectHarnessAgentInput: vi.fn(async () => projectHarnessAgentInput),
}));

vi.mock("../../src/codex/app-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/codex/app-server.js")>();
  return {
    ...actual,
    detectCodexAppServerCapability: vi.fn(async () => ({
      available: true,
      supportsStdio: true,
      supportsRequiredLifecycle: true,
      nativeCollab: { multiAgent: "enabled", multiAgentV2: "enabled", configPath: "test", errors: [] },
      help: "codex app server --listen stdio://",
      errors: [],
    })),
    runCodexAppServerTurn: appServerTurn,
    runCodexAppServerChildTurn: appServerChildTurn,
    runCodexAppServerChildClose: appServerChildClose,
    isCodexAppServerChildAvailable: appServerChildAvailable,
    getActiveCodexAppServerTurn: getActiveAppServerTurn,
  };
});

vi.mock("../../src/codex/capabilities.js", () => ({
  detectCodexCapabilities: vi.fn(async () => readyCodexCapabilities()),
}));

vi.mock("../../src/codex/native-skills.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/codex/native-skills.js")>(),
  listCodexNativeSkills: vi.fn(async () => {
    const { hashNativeSkillPackageContent } = await import("../../src/skill/content-hash.js");
    const { getSystemSkillsRoot } = await import("../../src/template-source/paths.js");
    const projectHarnessRoot = join(root, ".agents", "skills", "repo-harness");
    const systemSkills = await Promise.all([
      "aho-main-orchestration",
      "aho-harness-engineering",
      "aho-workflow-authoring",
    ].map(async (name) => {
      const path = join(getSystemSkillsRoot(), name, "SKILL.md");
      return {
        name,
        description: `Test ${name}.`,
        path,
        scope: "system" as const,
        enabled: true,
        contentHash: await hashNativeSkillPackageContent(join(getSystemSkillsRoot(), name)),
      };
    }));
    const skills = existsSync(join(projectHarnessRoot, "SKILL.md"))
      ? [{
        name: "repo-harness",
        description: "Test project Harness.",
        path: join(projectHarnessRoot, "SKILL.md"),
        scope: "repo" as const,
        enabled: true,
        contentHash: await hashNativeSkillPackageContent(projectHarnessRoot),
      }, ...systemSkills]
      : systemSkills;
    return {
      providerId: "codex",
      projectPath: root,
      skills,
      errors: [],
    };
  }),
}));

import { normalizeCodexAppServerNotification } from "../../src/codex/app-server-realtime.js";
import {
  createProjectHarnessChange,
  listProjectHarnessChanges,
  loadProjectHarnessContract,
  publishProjectHarnessChange,
  rollbackUncommittedProjectHarnessChange,
} from "../../src/project-harness/change.js";
import {
  projectHarnessConversationLane,
  readProjectHarnessLane,
  resolveProjectHarnessRegistryContext,
} from "../../src/project-harness/registry.js";
import { DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY } from "../../src/provider-runtime/project-harness-discovery.js";
import { ProjectRegistryStore } from "../../src/registry/store.js";
import { ProjectRuntimeCoordinator } from "../../src/project-runtime/coordinator.js";
import { resolveProjectRuntimePaths, type ProjectRuntimePaths } from "../../src/project-runtime/paths.js";
import { defaultProviderRegistry } from "../../src/provider-runtime/index.js";
import { agentThreadSurfaceId } from "../../src/provider-runtime/agent-surface-id.js";
import { ProjectSkillRuntimeContextResolver } from "../../src/skill/project-skill-runtime-context-resolver.js";
import { git } from "../../src/project/git.js";
import type { ManagedProject } from "../../src/types/index.js";
import { appendCanonicalTimelineEntry } from "../../src/workbench/canonical-timeline-command.js";
import { listConversationMessages, postConversationMessage as postConversationMessageRaw } from "../../src/workbench/conversation-service.js";
import { resumeNativeGoalAfterAction, runWorkbenchWorkflowAction } from "../../src/workbench/workflow-conversation-bridge.js";
import { buildConversationInteractionQueue } from "../../src/workbench/conversation-interactions.js";
import { ConversationTurnControlOwner } from "../../src/workbench/conversation-turn-control.js";
import { createConversationTurnRouter } from "../../src/workbench/conversation-turn-router.js";
import type { ConversationTurnRoutingPort } from "../../src/workbench/conversation-turn-contract.js";
import { getWorkbenchSnapshot } from "../../src/workbench/projections/read-model/implementation.js";
import { listWorkflowRuns } from "../../src/workflow-run/manager.js";
import { getCanonicalTimelinePage } from "../../src/workbench/canonical-timeline-query.js";
import { getAgentSurfaceProjection } from "../../src/workbench/agent-surface-projection.js";
import { readLatestWorkflowGraphPlanAt } from "../../src/workflow-artifacts/manager.js";
import { openProjectRuntimeWorkbenchDatabase } from "../../src/workbench/persistence/open-workbench-database.js";
import { planDocumentContentHash } from "../../src/workbench/plan-documents.js";
import { createReadyProjectHarnessFixture } from "../helpers/project-harness-fixture.js";
import { createHarnessWorkbenchConversation as createHarnessWorkbenchConversation } from "../helpers/conversation-change-fixture.js";

let root: string;
let originalAhoHome: string | undefined;
let runtimePaths: ProjectRuntimePaths;
let skillRoot: string;
let turnRouter: ConversationTurnRoutingPort;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aho-provider-planning-"));
  originalAhoHome = process.env.AHO_HOME;
  process.env.AHO_HOME = join(root, ".aho-home");
  appServerTurn.mockReset();
  appServerChildTurn.mockReset();
  appServerChildClose.mockReset();
  appServerChildAvailable.mockReset();
  appServerChildAvailable.mockReturnValue(true);
  appServerAnswer.mockReset();
  getActiveAppServerTurn.mockReset();
  getActiveAppServerTurn.mockImplementation((runId: string) => ({
    changeId: "",
    runtimeScopeId: "conversation-1",
    roleId: "main-agent",
    runId,
    threadId: "thread-child",
    turnId: "turn-child",
    startedAt: "2026-07-15T00:00:00.000Z",
    steer: vi.fn(),
    interrupt: vi.fn(),
    respondToUserInput: appServerAnswer,
  }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "aho-test@example.invalid"]);
  await git(root, ["config", "user.name", "AHO Test"]);
  await writeFile(join(root, "package.json"), "{\"name\":\"provider-planning-fixture\"}\n", "utf8");
  await git(root, ["add", "package.json"]);
  await git(root, ["commit", "-m", "fixture baseline"]);
  const fixture = await createReadyProjectHarnessFixture({
    projectRoot: root,
    ahoHome: process.env.AHO_HOME,
    projectId: project().id,
    projectName: project().name,
  });
  runtimePaths = resolveProjectRuntimePaths(fixture.project.id, fixture.ahoHome);
  skillRoot = fixture.skillRoot;
  projectHarnessAgentInput.identity.skillRevision = 1;
  projectHarnessAgentInput.providerSkillInput.path = join(skillRoot, "SKILL.md");
  const projectRuntimeCoordinator = new ProjectRuntimeCoordinator({
    store: new ProjectRegistryStore(fixture.ahoHome),
    ahoHome: fixture.ahoHome,
    discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
  });
  const skillContext = new ProjectSkillRuntimeContextResolver({
    providerRegistry: defaultProviderRegistry,
    projectRuntimeCoordinator,
  });
  turnRouter = createConversationTurnRouter({
    skillContext,
    providerRegistry: defaultProviderRegistry,
    projectRuntimeCoordinator,
  });
});

afterEach(async () => {
  if (originalAhoHome === undefined) delete process.env.AHO_HOME;
  else process.env.AHO_HOME = originalAhoHome;
  await rm(root, { recursive: true, force: true });
});

function createWorkbenchConversation(
  projectInput: ManagedProject,
  input: Parameters<typeof createHarnessWorkbenchConversation>[1],
  live?: Parameters<typeof createHarnessWorkbenchConversation>[2],
  options: Parameters<typeof createHarnessWorkbenchConversation>[3] = {},
): ReturnType<typeof createHarnessWorkbenchConversation> {
  return createHarnessWorkbenchConversation(projectInput, input, live, { ...options, turnRouter });
}

function postConversationMessage(
  projectInput: ManagedProject,
  conversationId: string,
  input: Parameters<typeof postConversationMessageRaw>[2],
  live?: Parameters<typeof postConversationMessageRaw>[3],
  options: Parameters<typeof postConversationMessageRaw>[4] = {},
): ReturnType<typeof postConversationMessageRaw> {
  return postConversationMessageRaw(projectInput, conversationId, input, live, { ...options, turnRouter });
}

describe("Workbench provider planning flow", () => {
  it("keeps Harness Main Provider approval disabled and fails an unexpected callback closed", async () => {
    let observedApprovalMode: "never" | "on-request" | undefined;
    appServerTurn.mockImplementationOnce(async (options) => {
      observedApprovalMode = options.approvalMode;
      options.onApprovalRequest?.({
        requestId: "forbidden-harness-approval",
        kind: "command-execution",
        threadId: "thread-harness-approval",
        turnId: "turn-harness-approval",
        itemId: "item-harness-approval",
        runId: options.runId,
        runtimeScopeId: options.runtimeScopeId ?? options.runId,
        roleId: "main-agent",
        summary: { title: "Run command", command: "npm test", includesWrite: false },
        availableDecisions: ["approve-once", "decline"],
      });
      return {
        status: "interrupted",
        threadId: "thread-harness-approval",
        turnId: "turn-harness-approval",
        lastMessage: "",
        childThreads: [],
      };
    });

    const conversation = await createWorkbenchConversation(project(), {
      body: "Keep Provider approval outside Harness governance.",
    }, undefined, { runMainAgent: false });
    await expect(postConversationMessage(
      project(),
      conversation.conversationId,
      { mode: "chat", message: "Trigger the forbidden Provider approval callback." },
    )).rejects.toThrow("Provider approval is forbidden outside Direct Agent mode.");

    expect(observedApprovalMode).toBe("never");
    const messages = await listConversationMessages(project(), conversation.conversationId);
    expect(messages.some((message) => message.providerApproval)).toBe(false);
    expect(buildConversationInteractionQueue(conversation.conversationId, messages).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "provider-approval" })]));
  });

  it("releases Harness Turn control after terminal commit before publishing terminal rows", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Start without running Main yet.",
    }, undefined, { runMainAgent: false });
    appServerTurn.mockImplementation(async (options) => {
      emitMainThreadStarted(options, "thread-release-race", "turn-release-race");
      emitCanonicalMainText(
        options,
        "Harness turn completed.",
        "thread-release-race",
        "turn-release-race",
        "message-release-race",
      );
      return {
        status: "completed",
        threadId: "thread-release-race",
        turnId: "turn-release-race",
        lastMessage: "Harness turn completed.",
        childThreads: [],
      };
    });
    const projectRuntimeCoordinator = new ProjectRuntimeCoordinator({
      store: new ProjectRegistryStore(process.env.AHO_HOME!),
      ahoHome: process.env.AHO_HOME!,
      discoveryPolicy: DEFAULT_PROJECT_HARNESS_DISCOVERY_POLICY,
    });
    const skillContext = new ProjectSkillRuntimeContextResolver({
      providerRegistry: defaultProviderRegistry,
      projectRuntimeCoordinator,
    });
    const turnControl = new ConversationTurnControlOwner({
      providerRegistry: defaultProviderRegistry,
      projectRuntimeCoordinator,
      onInvalidated: () => undefined,
    });
    const router = createConversationTurnRouter({
      skillContext,
      providerRegistry: defaultProviderRegistry,
      projectRuntimeCoordinator,
      turnControl,
    });
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)!.currentGraphScopeId!;
    store.close();
    const nextRegistration = {
      projectId: project().id,
      productMode: "harness" as const,
      conversationId: conversation.conversationId,
      providerId: "codex" as const,
      expectedAttemptId: "attempt-next-harness-turn",
      graphScopeId,
      runId: "run-next-harness-turn",
      roleId: "main-agent" as const,
    };
    let nextRegistrationSucceeded = false;

    await postConversationMessageRaw(project(), conversation.conversationId, "Run Main once.", {
      emit: (event) => {
        if (event.event !== "timeline.patch"
          || !event.data.messageId.startsWith("assistant:")
          || nextRegistrationSucceeded) return;
        turnControl.registerAttempt(nextRegistration);
        nextRegistrationSucceeded = true;
      },
    }, { turnRouter: router });

    expect(nextRegistrationSucceeded).toBe(true);
    expect(turnControl.state(project().id, conversation.conversationId)).toMatchObject({
      state: "running",
      attemptId: nextRegistration.expectedAttemptId,
    });
    turnControl.release(nextRegistration);
  });

  it("does not fall back to a legacy gate when a bound Skill-native Conversation loses its graph", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Prepare a plan.",
    }, undefined, { runMainAgent: false });
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      const graphScopeId = store.conversations.readConversation(
        project().id,
        conversation.conversationId,
      )?.currentGraphScopeId;
      if (!graphScopeId) throw new Error("Fixture Conversation has no graph scope.");
      store.conversations.linkConversationChange(
        project().id,
        conversation.conversationId,
        "bound-stale-change",
        "2026-08-03T00:00:00.000Z",
      );
      store.unitOfWork.terminalizeConversationGraphScope(
        project().id,
        conversation.conversationId,
        graphScopeId,
        "2026-08-03T00:00:01.000Z",
      );
    } finally {
      store.close();
    }

    const snapshot = await getWorkbenchSnapshot(
      { project: project(), path: root },
      { topicId: conversation.conversationId },
    );
    expect(snapshot.harness).toMatchObject({ kind: "project-skill", projectId: project().id });
    expect(snapshot.right.confirmationQueue.current).toEqual([]);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
  });

  it("routes exact Child feedback through the dedicated continuation capability and Child Timeline only", async () => {
    const conversation = await createWorkbenchConversation(project(), { body: "Prepare a plan." }, undefined, { runMainAgent: false });
    const planningRunId = "planning-feedback-source";
    const proposalRoot = join(runtimePaths.workbenchRoot, "conversations", conversation.conversationId, "runs", planningRunId, "planner-proposal");
    await mkdir(proposalRoot, { recursive: true });
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)!.currentGraphScopeId!;
    try {
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-main-feedback", roleId: "main-agent", parentThreadId: null,
        changeId: null, graphScopeId, capabilityProfile: "main", updatedAt: "2026-07-25T00:00:00.000Z",
      });
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-child-feedback", roleId: "planning-agent", parentThreadId: "thread-main-feedback",
        changeId: null, graphScopeId, capabilityProfile: "planning", displayName: "Mendel", runId: planningRunId,
        updatedAt: "2026-07-25T00:00:01.000Z",
      });
    } finally {
      store.close();
    }
    const childSurfaceId = agentThreadSurfaceId("codex", "thread-child-feedback");
    appServerChildTurn.mockImplementationOnce(async (options) => {
      expect(options.parentThreadId).toBe("thread-main-feedback");
      expect(options.targetThreadId).toBe("thread-child-feedback");
      expect(options.prompt).toBe("Read the third line.");
      expect(options.sandboxPolicy).toBe("workspace-write");
      expect(options.writableRoots).toEqual([proposalRoot]);
      expect(options.skillInputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "repo-harness" }),
        expect.objectContaining({ name: "aho-workflow-authoring", path: expect.stringContaining("aho-workflow-authoring") }),
      ]));
      expect(await sameTestPhysicalPath(
        options.skillInputs?.find((skill) => skill.name === "repo-harness")?.path ?? "",
        join(skillRoot, "SKILL.md"),
      )).toBe(true);
      expect(options.requiredNativeSkills).toEqual(["repo-harness", "aho-workflow-authoring"]);
      for (const event of normalizeCodexAppServerNotification("item/agentMessage/delta", { itemId: "message-feedback", delta: "Third line read." }, {
        projectId: project().id, conversationId: options.conversationId, runId: options.runId,
        threadId: "thread-child-feedback", turnId: "turn-feedback", itemId: "message-feedback", roleId: "planning-agent", displayName: "Mendel",
      })) options.onRealtimeEvent?.(event);
      return {
        status: "completed", threadId: "thread-main-feedback", turnId: "turn-parent-feedback",
        lastMessageItemId: null, lastMessage: "AHO_CHILD_FOLLOWUP_COMPLETE",
        childThreads: [{
          parentThreadId: "thread-main-feedback", threadId: "thread-child-feedback",
          roleHint: "planning-agent",
          status: "completed", displayName: "Mendel", finalText: "Third line read.", changedFiles: [],
          snapshot: { thread: { turns: [{ id: "turn-feedback" }] } },
        }],
        changedFiles: [], host: { hostId: "host-1", generation: 1, pid: 101, cwd: root },
      };
    });

    await postConversationMessage(project(), conversation.conversationId, { mode: "chat", message: "Read the third line.", agentSurfaceId: childSurfaceId });

    const messages = await listConversationMessages(project(), conversation.conversationId);
    expect(messages.filter((message) => message.text === "Read the third line.")).toEqual([
      expect.objectContaining({ agentSurfaceId: childSurfaceId, threadId: "thread-child-feedback", agentRoleId: "planning-agent" }),
    ]);
    expect(messages.filter((message) => message.blocks?.some((block) => block.text === "Third line read."))).toEqual([
      expect.objectContaining({ agentSurfaceId: childSurfaceId, threadId: "thread-child-feedback", agentRoleId: "planning-agent" }),
    ]);
    expect(messages.filter((message) => message.agentSurfaceId === "main-agent" && /third line/i.test(JSON.stringify(message)))).toEqual([]);
    expect((await getAgentSurfaceProjection({ project: project(), path: root }, conversation.conversationId)).surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentSurfaceId: childSurfaceId, status: "completed" }),
    ]));
    expect(appServerTurn).not.toHaveBeenCalled();

  });

  it("fails closed when the Planning Agent proposal workspace can no longer be proven", async () => {
    const conversation = await createWorkbenchConversation(project(), { body: "Prepare a plan." }, undefined, { runMainAgent: false });
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)!.currentGraphScopeId!;
    try {
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-main-missing-workspace", roleId: "main-agent", parentThreadId: null,
        changeId: null, graphScopeId, capabilityProfile: "main", updatedAt: "2026-07-25T00:00:00.000Z",
      });
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-planning-missing-workspace", roleId: "planning-agent", parentThreadId: "thread-main-missing-workspace",
        changeId: null, graphScopeId, capabilityProfile: "planning", displayName: "Mendel", runId: "missing-planning-run",
        updatedAt: "2026-07-25T00:00:01.000Z",
      });
    } finally {
      store.close();
    }

    await expect(postConversationMessage(project(), conversation.conversationId, {
      mode: "chat",
      message: "Revise the proposal.",
      agentSurfaceId: agentThreadSurfaceId("codex", "thread-planning-missing-workspace"),
    })).rejects.toThrow();
    expect(appServerChildTurn).not.toHaveBeenCalled();
  });

  it("lets Main close one exact registered Agent through Provider close without a public terminate path", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Create a planning Agent.",
    }, undefined, { runMainAgent: false });
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)!.currentGraphScopeId!;
    try {
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-main-close", roleId: "main-agent", parentThreadId: null,
        changeId: null, graphScopeId, capabilityProfile: "main", updatedAt: "2026-07-25T00:00:00.000Z",
      });
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-child-close", roleId: "planning-agent", parentThreadId: "thread-main-close",
        changeId: null, graphScopeId, capabilityProfile: "planning", displayName: "Goodall", updatedAt: "2026-07-25T00:00:01.000Z",
      });
      store.providerAttempts.writeConversationProviderBinding({
        projectId: project().id,
        conversationId: conversation.conversationId,
        providerId: "codex",
        nativeSessionId: "thread-main-close",
        lastDeliveredCompletedTurn: 0,
        preferredModel: null,
        lastUsedAt: "2026-07-25T00:00:01.000Z",
        bindingStatus: "active",
      });
    } finally {
      store.close();
    }
    const childSurfaceId = agentThreadSurfaceId("codex", "thread-child-close");
    appServerChildClose.mockImplementationOnce(async (options) => {
      expect(options.parentThreadId).toBe("thread-main-close");
      expect(options.targetThreadId).toBe("thread-child-close");
      options.onChildLifecycleEvent?.({
        kind: "closed",
        activityId: "native-close-test",
        parentThreadId: "thread-main-close",
        childThreadId: "thread-child-close",
        roleHint: "planning-agent",
      });
      return {
        status: "completed", threadId: "thread-main-close", turnId: null,
        lastMessageItemId: null, lastMessage: "", childThreads: [], changedFiles: [],
        host: { hostId: "host-1", generation: 1, pid: 101, cwd: root },
      };
    });
    appServerTurn.mockImplementationOnce(async (options) => {
      const closeTool = options.dynamicTools?.find((tool) => tool.name === "aho_close_agent");
      expect(closeTool).toMatchObject({
        inputSchema: expect.objectContaining({
          properties: { agentSurfaceId: { type: "string" } },
          required: ["agentSurfaceId"],
          additionalProperties: false,
        }),
      });
      const closed = await options.onDynamicToolCall?.({
        requestId: "request-close",
        threadId: "thread-main-close",
        turnId: "turn-main-close",
        callId: "call-close",
        tool: "aho_close_agent",
        arguments: { agentSurfaceId: childSurfaceId },
      });
      expect(closed).toMatchObject({ success: true });
      return {
        status: "completed", threadId: "thread-main-close", turnId: "turn-main-close",
        lastMessage: "Agent closed.", goal: nativeGoal("active"), childThreads: [], changedFiles: [],
      };
    });

    await postConversationMessage(project(), conversation.conversationId, {
      mode: "chat",
      message: "Close the current Planning Agent.",
    });

    expect(appServerChildClose).toHaveBeenCalledTimes(1);
    expect((await getAgentSurfaceProjection({ project: project(), path: root }, conversation.conversationId)).surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentSurfaceId: childSurfaceId, status: "terminated", readOnly: true }),
    ]));
    const verified = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      expect(verified.providerAttempts.listProviderAttempts(project().id, conversation.conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ roleId: "planning-agent", nativeSessionId: "thread-child-close", status: "terminated" }),
      ]));
    } finally {
      verified.close();
    }
  });

  it("rejects Main, stale, and still-running targets before invoking the provider", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Prepare a plan.",
    }, undefined, { runMainAgent: false });
    await expect(postConversationMessage(project(), conversation.conversationId, {
      mode: "chat", message: "No.", agentSurfaceId: "main-agent",
    })).rejects.toThrow("cannot target Main Agent");
    await expect(postConversationMessage(project(), conversation.conversationId, {
      mode: "chat", message: "No.", agentSurfaceId: "agent:codex:thread:missing",
    })).rejects.toThrow("stale or does not belong");
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)!.currentGraphScopeId!;
    let runningSurfaceId = "";
    try {
      bindProviderThreadFixture(store, {
        projectId: project().id,
        conversationId: conversation.conversationId,
        providerId: "codex",
        providerThreadId: "thread-main-running-target",
        roleId: "main-agent",
        parentThreadId: null,
        changeId: null,
        graphScopeId,
        capabilityProfile: "main",
        updatedAt: "2026-07-25T00:00:00.000Z",
      });
      const child = bindProviderThreadFixture(store, {
        projectId: project().id,
        conversationId: conversation.conversationId,
        providerId: "codex",
        providerThreadId: "thread-child-running-target",
        roleId: "planning-agent",
        parentThreadId: "thread-main-running-target",
        changeId: null,
        graphScopeId,
        capabilityProfile: "planning",
        updatedAt: "2026-07-25T00:00:01.000Z",
      });
      store.providerAttempts.completeProviderAttempt(project().id, child.attemptId, "running", child.providerThreadId, "2026-07-25T00:00:02.000Z");
      runningSurfaceId = agentThreadSurfaceId("codex", child.providerThreadId);
    } finally {
      store.close();
    }
    await expect(postConversationMessage(project(), conversation.conversationId, {
      mode: "chat", message: "Not yet.", agentSurfaceId: runningSurfaceId,
    })).rejects.toThrow("still running");
    expect(appServerTurn).not.toHaveBeenCalled();
  });

  it("rejects a Child from a stale Host generation without inventing a Provider close", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Prepare a plan.",
    }, undefined, { runMainAgent: false });
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)!.currentGraphScopeId!;
    try {
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-main-stale", roleId: "main-agent", parentThreadId: null,
        changeId: null, graphScopeId, capabilityProfile: "main", updatedAt: "2026-07-25T00:00:00.000Z",
      });
      bindProviderThreadFixture(store, {
        projectId: project().id, conversationId: conversation.conversationId, providerId: "codex",
        providerThreadId: "thread-child-stale", roleId: "planning-agent", parentThreadId: "thread-main-stale",
        changeId: null, graphScopeId, capabilityProfile: "planning", updatedAt: "2026-07-25T00:00:01.000Z",
      });
    } finally {
      store.close();
    }
    appServerChildAvailable.mockReturnValue(false);
    const childSurfaceId = agentThreadSurfaceId("codex", "thread-child-stale");
    await expect(postConversationMessage(project(), conversation.conversationId, {
      mode: "chat", message: "This cannot cross generations.", agentSurfaceId: childSurfaceId,
    })).rejects.toThrow("stale Provider Host generation");
    expect(appServerChildTurn).not.toHaveBeenCalled();
    expect((await getAgentSurfaceProjection({ project: project(), path: root }, conversation.conversationId)).surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentSurfaceId: childSurfaceId, status: "completed" }),
    ]));
    expect((await listConversationMessages(project(), conversation.conversationId)).some((message) => message.text === "This cannot cross generations.")).toBe(false);
  });

  it("claims only the latest matching resume attempt and terminalizes older queued attempts", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Continue later.",
    }, undefined, { runMainAgent: false });
    const capabilitySnapshot = await defaultProviderRegistry.get("codex").capabilitySnapshot(project(), "harness", root);
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const stored = store.conversations.readConversation(project().id, conversation.conversationId)!;
    const baseAttempt = {
      projectId: project().id,
      conversationId: conversation.conversationId,
      graphScopeId: stored.currentGraphScopeId,
      changeId: null,
      agentTaskId: null,
      roleId: "main-agent",
      operationProfile: "main" as const,
      providerId: "codex",
      nativeSessionId: null,
      model: null,
      capabilitySnapshot,
      deliveredThroughCompletedTurn: 0,
      worktreeId: null,
      status: "queued" as const,
    };
    try {
      store.providerAttempts.writeProviderResumePoint({ projectId: project().id, conversationId: conversation.conversationId, resumePointId: "resume-old", graphScopeId: stored.currentGraphScopeId, changeId: null, previousProviderId: "alpha", targetProviderId: "codex", snapshotJson: "{}", snapshotHash: "old-hash", createdAt: "2026-07-15T00:00:00.000Z" });
      store.providerAttempts.createProviderAttempt({ ...baseAttempt, attemptId: "attempt-resume-old", handoffHash: "old-hash", createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z" });
      store.providerAttempts.writeProviderResumePoint({ projectId: project().id, conversationId: conversation.conversationId, resumePointId: "resume-latest", graphScopeId: stored.currentGraphScopeId, changeId: null, previousProviderId: "alpha", targetProviderId: "codex", snapshotJson: "{}", snapshotHash: "latest-hash", createdAt: "2026-07-15T00:00:01.000Z" });
      store.providerAttempts.createProviderAttempt({ ...baseAttempt, attemptId: "attempt-resume-latest", handoffHash: "latest-hash", createdAt: "2026-07-15T00:00:01.000Z", updatedAt: "2026-07-15T00:00:01.000Z" });
    } finally {
      store.close();
    }
    let resumeRequestSkills: Array<{ name: string; path: string }> = [];
    let resumeRequiredSkills: string[] = [];
    let resumeNativeSkillRoots: string[] = [];
    let resumeHandoffContext = "";
    appServerTurn.mockImplementationOnce(async (options) => {
      resumeRequestSkills = [...(options.skillInputs ?? [])];
      resumeRequiredSkills = [...(options.requiredNativeSkills ?? [])];
      resumeNativeSkillRoots = [...(options.nativeSkillRoots ?? [])];
      resumeHandoffContext = options.additionalContext?.["aho.shared-conversation-handoff"]?.value ?? "";
      return {
        status: "completed",
        threadId: "thread-main-resumed",
        turnId: "turn-main-resumed",
        lastMessage: "已继续。",
        goal: nativeGoal("active"),
        childThreads: [],
        changedFiles: [],
        error: null,
      };
    });

    await postConversationMessage(project(), conversation.conversationId, { mode: "chat", message: "继续。" });

    const verified = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      const attempts = verified.providerAttempts.listProviderAttempts(project().id, conversation.conversationId);
      expect(attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ attemptId: "attempt-resume-old", status: "interrupted" }),
        expect.objectContaining({ attemptId: "attempt-resume-latest", status: "completed" }),
      ]));
      const resumed = attempts.find((attempt) => attempt.attemptId === "attempt-resume-latest");
      expect(resumeRequiredSkills).toEqual(["aho-main-orchestration", "repo-harness"]);
      expect(resumed?.effectiveSkillInputs.map(({ id, path, required }) => ({ id, path, required }))).toEqual(
        resumeRequestSkills.map(({ name, path }) => ({ id: name, path, required: resumeRequiredSkills.includes(name) })),
      );
      expect(resumed?.handoffHash).toBe(expectedHarnessTurnHandoffHash({
        handoffContext: resumeHandoffContext,
        projectId: project().id,
        conversationId: conversation.conversationId,
        skillInputs: resumed?.effectiveSkillInputs ?? [],
        nativeSkillRoots: resumeNativeSkillRoots,
        requiredNativeSkills: resumeRequiredSkills,
      }));
    } finally {
      verified.close();
    }
  });

  it("terminalizes a live Planning child attempt when the parent provider turn fails", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Prepare a plan later.",
    }, undefined, { runMainAgent: false });
    appServerTurn.mockImplementationOnce(async (options) => {
      emitMainThreadStarted(options, "thread-main-failed", "turn-main-failed");
      emitPlanningChildStarted(options, "thread-main-failed", "thread-planner-failed", "activity-planner-failed");
      const identity = {
        runId: options.runId,
        threadId: "thread-planner-failed",
        parentThreadId: "thread-main-failed",
        turnId: "turn-planner-failed",
        roleId: "planning-agent",
      };
      for (const event of normalizeCodexAppServerNotification("turn/started", { turnId: identity.turnId }, identity)) {
        options.onRealtimeEvent?.(event);
      }
      throw new Error("provider disconnected after child start");
    });

    await expect(postConversationMessage(project(), conversation.conversationId, {
      mode: "chat",
      message: "请让 Plan Agent 编写计划。",
    })).rejects.toThrow("provider disconnected");

    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      const attempts = store.providerAttempts.listProviderAttempts(project().id, conversation.conversationId);
      expect(attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ roleId: "main-agent", status: "failed" }),
        expect.objectContaining({ roleId: "planning-agent", nativeSessionId: "thread-planner-failed", status: "failed" }),
      ]));
      expect(attempts.some((attempt) => attempt.status === "running")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("projects a registered native Child lifecycle into Agent Surface before the parent turn completes", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Spawn one child later.",
    }, undefined, { runMainAgent: false });
    appServerTurn.mockImplementationOnce(async (options) => {
      emitMainThreadStarted(options, "thread-live-main", "turn-live-main");
      emitPlanningChildStarted(options, "thread-live-main", "thread-live-child", "call-live-child");
      const graph = await getAgentSurfaceProjection({ project: project(), path: root }, conversation.conversationId);
      expect(graph.surfaces).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentSurfaceId: "agent:codex:thread:thread-live-child", roleId: "planning-agent", status: "running", parentAgentSurfaceId: "main-agent" }),
      ]));
      throw new Error("stop after live child graph assertion");
    });

    await expect(postConversationMessage(project(), conversation.conversationId, "请创建子 Agent。"))
      .rejects.toThrow("stop after live child graph assertion");
  });

  it("lets a provider-resolved empty answer win the turn-completion race", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Ask and continue.",
    }, undefined, { runMainAgent: false });
    appServerTurn.mockImplementationOnce(async (options) => {
      options.onUserInputRequest?.({
        requestId: "request-resolved-race",
        threadId: "thread-resolved-race",
        turnId: "turn-resolved-race",
        itemId: "item-resolved-race",
        runId: options.runId,
        runtimeScopeId: options.runtimeScopeId ?? conversation.conversationId,
        roleId: "main-agent",
        questions: [{ id: "choice", question: "继续吗？", options: [{ label: "继续" }] }],
      });
      options.onUserInputResolved?.({ requestId: "request-resolved-race", threadId: "thread-resolved-race" });
      return {
        status: "completed",
        threadId: "thread-resolved-race",
        turnId: "turn-resolved-race",
        lastMessage: "已根据现有信息继续。",
        goal: nativeGoal("active"),
        childThreads: [],
        changedFiles: [],
        error: null,
      };
    });

    await postConversationMessage(project(), conversation.conversationId, "请先提问。");

    const messages = await listConversationMessages(project(), conversation.conversationId);
    const resolved = messages.filter((message) => message.providerUserInput?.requestId === "request-resolved-race");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.providerUserInput).toMatchObject({
      status: "submitted",
      disposition: "skipped",
      skippedQuestionIds: ["choice"],
    });
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId ?? "";
    store.close();
    expect((await buildConversationInteractionQueue(runtimePaths, conversation.conversationId, graphScopeId, "harness")).items).toEqual([]);
  });

  it("projects a child provider question onto its exact canonical surface", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Let the child ask one question.",
    }, undefined, { runMainAgent: false });
    appServerTurn.mockImplementationOnce(async (options) => {
      options.onUserInputRequest?.({
        requestId: "request-child-question",
        threadId: "thread-child-question",
        turnId: "turn-child-question",
        itemId: "item-child-question",
        runId: options.runId,
        runtimeScopeId: options.runtimeScopeId ?? conversation.conversationId,
        roleId: "planning-agent",
        questions: [{ id: "choice", question: "采用哪种方案？", options: [{ label: "方案 A" }] }],
      });

      const childSurfaceId = agentThreadSurfaceId("codex", "thread-child-question");
      await vi.waitFor(async () => {
        const page = await getCanonicalTimelinePage(
          { project: project(), path: root },
          conversation.conversationId,
          childSurfaceId,
          "harness",
          { limit: 100 },
        );
        expect(page.entries).toEqual([
          expect.objectContaining({
            agentSurfaceId: childSurfaceId,
            cells: [],
          }),
        ]);
      });
      const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
      const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId ?? "";
      store.close();
      expect((await buildConversationInteractionQueue(runtimePaths, conversation.conversationId, graphScopeId, "harness")).items).toEqual([
        expect.objectContaining({ kind: "provider-input", status: "pending" }),
      ]);

      return {
        status: "completed",
        threadId: "thread-main-question",
        turnId: "turn-main-question",
        lastMessage: "已继续处理。",
        goal: nativeGoal("active"),
        childThreads: [],
        changedFiles: [],
        error: null,
      };
    });

    await postConversationMessage(project(), conversation.conversationId, "请让 Plan Agent 确认方案。");
  });

  it("keeps supplemental turns in the same unbound demand scope", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Start a simple demand.",
    }, undefined, { runMainAgent: false });
    const initialStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const initialScope = initialStore.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId;
    initialStore.close();
    appServerTurn.mockResolvedValue({
      status: "completed",
      threadId: "thread-main",
      turnId: "turn-supplement",
      lastMessage: "已处理补充要求。",
      childThreads: [],
    });

    await postConversationMessage(project(), conversation.conversationId, "补充第一个细节。");
    await postConversationMessage(project(), conversation.conversationId, "再补充第二个细节。");

    const finalStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      expect(finalStore.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId).toBe(initialScope);
      expect(finalStore.timeline.listConversationMessages(project().id, conversation.conversationId)
        .map((message) => JSON.parse(message.rawJson).graphScopeId)
        .filter(Boolean)).toEqual(expect.arrayContaining([initialScope, initialScope]));
    } finally {
      finalStore.close();
    }
  });

  it("starts a clean graph after a simple native Goal reaches complete", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Create a simple page.",
    }, undefined, { runMainAgent: false });
    const initialStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const initialScope = initialStore.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId;
    initialStore.close();
    appServerTurn
      .mockResolvedValueOnce({
        status: "completed",
        threadId: "thread-main",
        turnId: "turn-simple-complete",
        lastMessage: "简单需求已经完成。",
        goal: nativeGoal("complete"),
        childThreads: [],
      })
      .mockResolvedValueOnce({
        status: "completed",
        threadId: "thread-main",
        turnId: "turn-next-demand",
        lastMessage: "开始新的需求。",
        goal: nativeGoal("active"),
        childThreads: [],
      });

    await postConversationMessage(project(), conversation.conversationId, "完成这个简单需求。");
    await postConversationMessage(project(), conversation.conversationId, "这是一个新的顶层需求。");

    const finalStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      expect(finalStore.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId).not.toBe(initialScope);
    } finally {
      finalStore.close();
    }
  });

  it("does not mark a proposal accepted when Main declines the acceptance tool", async () => {
    const topic = await createSkillNativeConversationChange("declined-plan", "Declined plan", "Plan this work.");
    const sourceCanonicalItemId = "prose:codex:attempt-declined:thread-plan:turn-plan:item-plan";
    const planText = "# Plan\n\nA proposal that Main still needs to inspect.";
    const document = {
      documentId: "plan-document-declined",
      documentKind: "plan" as const,
      title: "实现计划",
      sourceMessageId: "message-declined-plan",
      sourceCanonicalItemId,
      proposalId: "proposal-declined",
      proposalHash: "proposal-hash-declined",
      proposalArtifact: "workbench/proposals/declined-plan.json",
      contentHash: planDocumentContentHash(planText),
      agentSurfaceId: "agent:codex:thread:thread-plan",
    };
    await appendCanonicalTimelineEntry(project(), topic.changeId, {
      type: "assistant.message",
      status: "planning-agent-generated",
      runId: "run-declined-plan",
      agentSurfaceId: document.agentSurfaceId,
      agentRoleId: "planning-agent",
      artifact: "workbench/proposals/declined-plan.json",
      document,
      blocks: [{
        id: sourceCanonicalItemId,
        providerId: "codex",
        attemptId: "attempt-declined",
        threadId: "thread-plan",
        turnId: "turn-plan",
        itemId: "item-plan",
        sequence: 1,
        kind: "prose",
        timestamp: "2026-07-16T00:00:00.000Z",
        source: "provider",
        text: planText,
        document,
      }],
    });
    appServerTurn.mockResolvedValueOnce({
      status: "completed",
      threadId: "thread-main",
      turnId: "turn-declined-plan",
      lastMessage: "当前计划还需要补充，不接受。",
      goal: nativeGoal("paused"),
      childThreads: [],
    });

    await postConversationMessage(project(), topic.conversationId, {
      mode: "chat",
      message: "执行当前计划",
      planHandoffIntent: {
        kind: "execute-plan",
        sourceRunId: "run-declined-plan",
        sourceAgentRoleId: "planning-agent",
        sourceArtifact: "workbench/proposals/declined-plan.json",
        sourceDocumentId: document.documentId,
        sourceCanonicalItemId,
        sourceProposalHash: document.proposalHash,
      },
    });

    const source = (await listConversationMessages(project(), topic.conversationId))
      .find((message) => message.artifact === "workbench/proposals/declined-plan.json");
    expect(source?.status).toBe("planning-agent-generated");
  });

  it("keeps one graph scope inside an active Change and starts clean after that Change ends", async () => {
    const conversation = await createWorkbenchConversation(project(), {
      body: "Create the initial demand scope.",
    }, undefined, { runMainAgent: false });
    const changeId = "scope-lifecycle-change";
    const changeClaim = await bindSkillNativeChange(conversation.conversationId, changeId);

    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    let initialScope: string;
    try {
      initialScope = store.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId ?? "";
      expect(initialScope).not.toBe("");
      store.conversations.linkConversationChange(project().id, conversation.conversationId, changeId, new Date().toISOString());
      bindProviderThreadFixture(store, {
        projectId: project().id,
        conversationId: conversation.conversationId,
        providerId: "codex",
        providerThreadId: "thread-main",
        roleId: "main-agent",
        parentThreadId: null,
        changeId,
        graphScopeId: initialScope,
        capabilityProfile: "main-agent-goal-v1",
        updatedAt: new Date().toISOString(),
      });
      bindProviderThreadFixture(store, {
        projectId: project().id,
        conversationId: conversation.conversationId,
        providerId: "codex",
        providerThreadId: "thread-old-child",
        roleId: "planning-agent",
        parentThreadId: "thread-main",
        changeId,
        graphScopeId: initialScope,
        capabilityProfile: "planner-child-v1",
        updatedAt: new Date().toISOString(),
      });
    } finally {
      store.close();
    }

    appServerTurn
      .mockResolvedValueOnce({
        status: "completed",
        threadId: "thread-main",
        turnId: "turn-same-change",
        lastMessage: "继续处理当前 Change。",
        childThreads: [],
      })
      .mockResolvedValueOnce({
        status: "completed",
        threadId: "thread-main",
        turnId: "turn-next-demand",
        lastMessage: "开始处理新的顶层需求。",
        childThreads: [],
      });

    await postConversationMessage(project(), conversation.conversationId, "继续当前 Change 的同一项工作。");
    const sameChangeStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      expect(sameChangeStore.conversations.readConversation(project().id, conversation.conversationId)).toMatchObject({
        boundChangeId: changeId,
        currentGraphScopeId: initialScope,
      });
    } finally {
      sameChangeStore.close();
    }

    await rollbackUncommittedProjectHarnessChange(
      changeClaim.context,
      changeId,
      changeClaim.claimToken,
    );
    await postConversationMessage(project(), conversation.conversationId, "这是下一个独立的顶层需求。");
    const nextDemandStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    try {
      const next = nextDemandStore.conversations.readConversation(project().id, conversation.conversationId);
      expect(next?.boundChangeId).toBeNull();
      expect(next?.currentGraphScopeId).not.toBe(initialScope);
      expect(nextDemandStore.providerAttempts.listProviderThreads(project().id, conversation.conversationId))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ providerThreadId: "thread-old-child", graphScopeId: initialScope }),
          expect.objectContaining({ providerThreadId: "thread-main", graphScopeId: next?.currentGraphScopeId }),
        ]));
    } finally {
      nextDemandStore.close();
    }
  });

  it("routes the first marker-free Main turn through the isolated Skill-native onboarding workspace", async () => {
    await Promise.all([
      rm(join(root, "AGENTS.md"), { force: true }),
      rm(join(root, "docs"), { recursive: true, force: true }),
      rm(join(root, "harness"), { recursive: true, force: true }),
      rm(join(root, "scripts"), { recursive: true, force: true }),
      rm(join(root, ".agent-harness"), { recursive: true, force: true }),
      rm(join(root, ".claude", "skills", "repo-harness"), { recursive: true, force: true }),
      rm(join(root, ".agents", "skills", "repo-harness"), { recursive: true, force: true }),
    ]);
    appServerTurn.mockImplementationOnce(async (options) => {
      expect(options.prompt).toBe("请先判断这个空项目需要哪些说明文件。不要假设固定模板。");
      expect(options.requiredNativeSkills).toEqual(["aho-main-orchestration", "aho-harness-engineering"]);
      expect(options.skillInputs).toEqual([
        expect.objectContaining({ name: "aho-main-orchestration" }),
        expect.objectContaining({ name: "aho-harness-engineering" }),
      ]);
      expect(options.writableRoots).toEqual([expect.stringContaining(join("onboarding", "bundle"))]);
      expect(options.writableRoots).not.toContain(root);
      expect(options.dynamicTools?.map((tool) => tool.name)).toEqual(["aho_prepare_project_harness"]);
      expect(options.additionalContext?.["aho.harness-onboarding"]).toMatchObject({ kind: "application" });
      expect(JSON.parse(options.additionalContext?.["aho.project"]?.value ?? "{}")).toEqual({
        projectId: project().id,
        projectRoot: root,
      });
      return {
        status: "completed",
        threadId: "thread-first-onboarding",
        turnId: "turn-first-onboarding",
        lastMessage: "我会先根据项目实际情况建立必要说明。",
        goal: nativeGoal("active"),
        childThreads: [],
        changedFiles: [],
      };
    });

    const conversation = await createWorkbenchConversation(project(), {
      body: "请先判断这个空项目需要哪些说明文件。不要假设固定模板。",
    });

    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, "docs"))).toBe(false);
    expect(existsSync(join(root, "harness"))).toBe(false);
    expect(existsSync(join(root, "scripts"))).toBe(false);
    expect(conversation.state).toBe("active");
  });

  it("ignores a partial legacy repo-local Harness while loading the native Harness Skill", async () => {
    await Promise.all([
      rm(join(root, "AGENTS.md"), { force: true }),
      rm(join(root, "docs"), { recursive: true, force: true }),
      rm(join(root, "scripts"), { recursive: true, force: true }),
    ]);
    await mkdir(join(root, "harness"), { recursive: true });
    await writeFile(join(root, "harness", "partial.txt"), "legacy partial content without a marker\n", "utf8");
    appServerTurn.mockImplementationOnce(async (options) => {
      expect(options.requiredNativeSkills).toEqual(["aho-main-orchestration", "repo-harness"]);
      expect(options.skillInputs).toEqual([
        expect.objectContaining({ name: "aho-main-orchestration" }),
        expect.objectContaining({ name: "repo-harness" }),
      ]);
      return {
        status: "completed",
        threadId: "thread-partial-onboarding",
        turnId: "turn-partial-onboarding",
        lastMessage: "继续补齐 Harness。",
        goal: nativeGoal("active"),
        childThreads: [],
        changedFiles: [],
      };
    });

    await createWorkbenchConversation(project(), {
      body: "继续补齐 Harness。",
    });
  });

  it("resumes the bound native Goal from committed post-apply evidence", async () => {
    const conversation = await createSkillNativeConversationChange(
      "post-apply-continuity",
      "Post apply continuity",
      "Apply and finalize.",
    );
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    const changeId = conversation.changeId;
    const graphScopeId = store.conversations.readConversation(project().id, conversation.conversationId)?.currentGraphScopeId ?? null;
    bindProviderThreadFixture(store, {
      projectId: project().id,
      conversationId: conversation.conversationId,
      providerId: "codex",
      providerThreadId: "thread-main",
      roleId: "main-agent",
      parentThreadId: null,
      changeId,
      graphScopeId,
      capabilityProfile: "main-agent-goal-v1",
      updatedAt: new Date().toISOString(),
    });
    store.close();
    appServerTurn.mockImplementationOnce(async (options) => {
      expect(options.goalResume).toMatchObject({
        deliveryKey: expect.stringMatching(/^approval:result\.apply:/),
        contextText: expect.stringContaining('"actionType": "result.apply"'),
      });
      return {
        status: "completed", threadId: "thread-main", turnId: "turn-post-apply",
        lastMessage: "Applied result is ready for finalization.", goal: nativeGoal("blocked"), childThreads: [],
      };
    });

    await resumeNativeGoalAfterAction({
      project: project(), changeId, actionRunId: "approval:result.apply:wt-1", actionType: "result.apply",
      status: "completed", result: { apply: { status: "applied", committed: true, commitHash: "abc" } },
    }, { continueMainAgentTurn: turnRouter.continueMainAgentTurn });

    expect(appServerTurn).toHaveBeenCalledTimes(1);
  });

  it("persists the complete parent message before failing closed when planning has no native Goal", async () => {
    appServerTurn.mockImplementationOnce(async (options) => {
      await writePlannerFiles(options.writableRoots?.[0] ?? "");
      emitMainThreadStarted(options, "thread-main", "turn-plan-without-goal");
      emitPlanningChildStarted(options, "thread-main", "thread-planner", "item-spawn-planner");
      const text = "规划子 Agent 已返回完整方案。\n当前还缺少可继续执行的目标状态。";
      emitCanonicalMainText(options, text, "thread-main", "turn-plan-without-goal", "message-no-goal");
      return {
        status: "failed",
        threadId: "thread-main",
        turnId: "turn-plan-without-goal",
        lastMessage: text,
        error: "Native Goal was not created.",
        goal: null,
        childThreads: [{
          itemId: "item-spawn-planner",
          parentThreadId: "thread-main",
          threadId: "thread-planner",
          roleHint: "planning-agent",
          prompt: `Write the proposal files under ${options.writableRoots?.[0] ?? "planner-proposal"}`,
          status: "completed",
          finalText: plannerPlanText(),
          changedFiles: [
            join(options.writableRoots?.[0] ?? "", "spec.md"),
            join(options.writableRoots?.[0] ?? "", "plan.md"),
            join(options.writableRoots?.[0] ?? "", "tasks.md"),
          ],
          snapshot: {},
        }],
      };
    });

    const creation = createWorkbenchConversation(project(), {
      body: "Create a structured health endpoint change.",
    });
    await expect(creation).rejects.toThrow("requires a native Goal");

    await creation.catch(() => undefined);
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    let conversationId = "";
    try {
      const conversations = store.conversations.listConversations(project().id, "harness");
      expect(conversations).toHaveLength(1);
      conversationId = conversations[0]?.conversationId ?? "";
      const attempts = store.providerAttempts.listProviderAttempts(project().id, conversationId);
      expect(attempts).toEqual(expect.arrayContaining([
        expect.objectContaining({ roleId: "planning-agent", nativeSessionId: "thread-planner", status: "completed" }),
      ]));
      expect(attempts.some((attempt) => attempt.status === "running")).toBe(false);
    } finally {
      store.close();
    }
    const messages = await listConversationMessages(project(), conversationId);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "assistant.message",
        text: "规划子 Agent 已返回完整方案。\n当前还缺少可继续执行的目标状态。",
      }),
    ]));
  });

  it("persists one Main Plan document reference when the provider returns no parent prose", async () => {
    appServerTurn.mockImplementationOnce(async (options) => {
      await writePlannerFiles(options.writableRoots?.[0] ?? "");
      emitMainThreadStarted(options, "thread-main-empty-prose", "turn-main-empty-prose");
      emitPlanningChildStarted(options, "thread-main-empty-prose", "thread-planner-empty-prose", "item-spawn-empty-prose-planner");
      emitCanonicalPlannerText(options, plannerPlanText(), "thread-main-empty-prose", "turn-main-empty-prose", "thread-planner-empty-prose", "turn-planner-empty-prose", "message-planner-empty-prose");
      return {
        status: "completed",
        threadId: "thread-main-empty-prose",
        turnId: "turn-main-empty-prose",
        lastMessage: "",
        goal: nativeGoal("active"),
        childThreads: [{
          itemId: "item-spawn-empty-prose-planner",
          parentThreadId: "thread-main-empty-prose",
          threadId: "thread-planner-empty-prose",
          roleHint: "planning-agent",
          status: "completed",
          displayName: "Sagan",
          finalText: plannerPlanText(),
          changedFiles: [
            join(options.writableRoots?.[0] ?? "", "spec.md"),
            join(options.writableRoots?.[0] ?? "", "plan.md"),
            join(options.writableRoots?.[0] ?? "", "tasks.md"),
          ],
          snapshot: {},
        }],
      };
    });

    const conversation = await createWorkbenchConversation(project(), {
      body: "Plan a small but structured change.",
    });
    const messages = await listConversationMessages(project(), conversation.conversationId);
    const marker = messages.find((message) => message.blocks?.some((block) => block.documentRef?.documentKind === "plan"));
    expect(marker).toMatchObject({
      type: "assistant.message",
      threadId: "thread-main-empty-prose",
      turnId: "turn-main-empty-prose",
    });
    expect(marker?.blocks).toEqual([
      expect.objectContaining({
        kind: "tool-result",
        title: "实现计划",
        documentRef: expect.objectContaining({ documentId: expect.stringMatching(/^plan-document-/) }),
      }),
    ]);
    const timeline = await getCanonicalTimelinePage({ project: project(), path: root }, conversation.conversationId, "main-agent", "harness");
    expect([...timeline.pinned, ...timeline.entries].flatMap((envelope) => envelope.cells)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "document-preview", title: "实现计划" }),
    ]));
  });

  it("carries a real planner-child result through execute intent into an accepted graph and concrete gate", async () => {
    let continueDeliveryKey = "";
    let createRequestSkills: Array<{ name: string; path: string }> = [];
    let createRequiredSkills: string[] = [];
    let createNativeSkillRoots: string[] = [];
    let createHandoffContext = "";
    appServerTurn
      .mockImplementationOnce(async (options) => {
        createRequestSkills = [...(options.skillInputs ?? [])];
        createRequiredSkills = [...(options.requiredNativeSkills ?? [])];
        createNativeSkillRoots = [...(options.nativeSkillRoots ?? [])];
        createHandoffContext = options.additionalContext?.["aho.shared-conversation-handoff"]?.value ?? "";
        expect(options.skillInputs).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "aho-main-orchestration", path: expect.stringContaining("aho-main-orchestration") }),
          expect.objectContaining({ name: "repo-harness" }),
        ]));
        expect(await sameTestPhysicalPath(
          options.skillInputs?.find((skill) => skill.name === "repo-harness")?.path ?? "",
          join(skillRoot, "SKILL.md"),
        )).toBe(true);
        expect(options.nativeSkillRoots).toEqual([expect.stringContaining("system-skills")]);
        expect(options.requiredNativeSkills).toEqual(["aho-main-orchestration", "repo-harness"]);
        expect(options.runtimeWorkspaceRoots).toEqual(expect.arrayContaining([expect.stringContaining("planner-proposal")]));
        expect(options.writableRoots).toEqual([expect.stringContaining("planner-proposal")]);
        await writePlannerFiles(options.writableRoots[0]);
        const childIdentity = {
          projectId: "repo",
          conversationId: "conversation-live",
          runId: options.runId,
          threadId: "thread-planner",
          parentThreadId: "thread-main",
          turnId: "turn-planner",
          roleId: "planning-agent",
          displayName: "Newton",
        };
        const childNotifications: Array<[string, Record<string, unknown>]> = [
          ["turn/started", { turnId: "turn-planner" }],
          ["item/reasoning/summaryTextDelta", { itemId: "reason-1", delta: "正在检查需求边界" }],
          ["item/started", { item: { id: "cmd-1", type: "commandExecution", command: "Get-Content index.html" } }],
          ["item/completed", { item: { id: "cmd-1", type: "commandExecution", command: "Get-Content index.html", aggregatedOutput: "ok", exitCode: 0 } }],
          ["item/completed", { item: { id: "file-1", type: "fileChange", path: "plan.md", status: "completed" } }],
          ["item/agentMessage/delta", { itemId: "message-1", delta: plannerPlanText() }],
          ["turn/completed", { turnId: "turn-planner" }],
        ];
        emitMainThreadStarted(options, "thread-main", "turn-plan");
        emitPlanningChildStarted(options, "thread-main", "thread-planner", "item-spawn-planner");
        for (const [method, params] of childNotifications) {
          for (const event of normalizeCodexAppServerNotification(method, params, childIdentity)) options.onRealtimeEvent?.(event);
        }
        const messagesBeforeChildInput = await listConversationMessages(project(), options.conversationId ?? "");
        const childProcessPosition = messagesBeforeChildInput.find(
          (message) => message.type === "assistant.message" && message.threadId === "thread-planner",
        )?.position;
        options.onChildThreadResult?.({
          itemId: "item-spawn-planner",
          parentThreadId: "thread-main",
          threadId: "thread-planner",
          roleHint: "planning-agent",
          status: "running",
          prompt: "Draft the exact proposal.",
          initialUserItem: { turnId: "turn-planner", itemId: "item-child-input", text: "Draft the exact proposal." },
          displayName: "Newton",
          finalText: "",
          changedFiles: [],
          snapshot: {},
        });
        const liveMessages = await listConversationMessages(project(), options.conversationId ?? "");
        const liveChildInput = liveMessages.find((message) => message.type === "user.message" && message.threadId === "thread-planner");
        expect(liveChildInput).toMatchObject({
          id: expect.stringContaining(":turn-planner:item-child-input"),
          attemptId: expect.stringContaining(":child:thread-planner"),
          turnId: "turn-planner",
          itemId: "item-child-input",
          text: "Draft the exact proposal.",
        });
        const liveChildProcess = liveMessages.filter((message) => message.type === "assistant.message" && message.threadId === "thread-planner" && !message.artifact);
        expect(liveChildProcess).toHaveLength(1);
        expect(liveChildProcess[0]?.position).toBe(childProcessPosition);
        expect(liveChildProcess[0]).toMatchObject({
          status: "completed",
          turnId: "turn-planner",
          agentRoleId: "planning-agent",
        });
        expect(liveChildProcess[0]?.blocks?.map((block) => block.kind)).toEqual(expect.arrayContaining([
          "reasoning-summary", "command", "file-change", "prose",
        ]));
        options.onChildThreadResult?.({
          itemId: "item-spawn-planner",
          parentThreadId: "thread-main",
          threadId: "thread-planner",
          roleHint: "planning-agent",
          status: "completed",
          displayName: "Newton",
          finalText: plannerPlanText(),
          changedFiles: [],
          snapshot: {},
        });
        options.onChildThreadResult?.({
          itemId: "item-spawn-planner",
          parentThreadId: "thread-main",
          threadId: "thread-planner",
          roleHint: "planning-agent",
          status: "completed",
          displayName: "Newton",
          finalText: plannerPlanText(),
          changedFiles: [],
          snapshot: {},
        });
        const liveStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
        try {
          expect(liveStore.providerAttempts.listProviderAttempts(project().id, options.conversationId ?? "")).toEqual(expect.arrayContaining([
            expect.objectContaining({ roleId: "planning-agent", operationProfile: "planning", nativeSessionId: "thread-planner", status: "completed" }),
          ]));
        } finally {
          liveStore.close();
        }
        const liveProjection = await getAgentSurfaceProjection({ project: project(), path: root }, options.conversationId ?? "");
        expect(liveProjection.surfaces).toEqual(expect.arrayContaining([
          expect.objectContaining({ agentSurfaceId: agentThreadSurfaceId("codex", "thread-planner"), status: "completed" }),
        ]));
        expect(options.dynamicTools).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "aho_goal_yield", inputSchema: expect.objectContaining({ additionalProperties: false }) }),
          expect.objectContaining({
            name: "aho_accept_current_plan",
            inputSchema: expect.objectContaining({
              required: ["proposalHash", "graphScopeId", "contractRequired", "contract", "validation"],
              additionalProperties: false,
            }),
          }),
          expect.objectContaining({
            name: "aho_close_agent",
            inputSchema: expect.objectContaining({
              properties: { agentSurfaceId: { type: "string" } },
              required: ["agentSurfaceId"],
              additionalProperties: false,
            }),
          }),
        ]));
        emitCanonicalMainText(options, "计划子 Agent 已返回方案。\n我还会把当前限制和验收事实一并说明。", "thread-main", "turn-plan", "message-plan");
        return {
          status: "completed",
          threadId: "thread-main",
          turnId: "turn-plan",
          lastMessage: "计划子 Agent 已返回方案。\n我还会把当前限制和验收事实一并说明。",
          goal: nativeGoal("active"),
          childThreads: [{
            itemId: "item-spawn-planner",
            parentThreadId: "thread-main",
            threadId: "thread-planner",
            roleHint: "planning-agent",
            status: "completed",
            displayName: "Newton",
            finalText: plannerPlanText(),
            changedFiles: [
              `${options.writableRoots[0]}/spec.md`,
              `${options.writableRoots[0]}/plan.md`,
              `${options.writableRoots[0]}/tasks.md`,
            ],
            snapshot: {},
          }],
        };
      })
      .mockImplementationOnce(async (options) => {
        expect(options.goalResume).toMatchObject({
          deliveryKey: expect.stringMatching(/^plan-handoff:/),
          contextText: expect.stringContaining("执行当前计划"),
        });
        // Native Goal recovery injects contextText and does not send turn/start additionalContext.
        const marker = "Current validated Plan handoff application context:\n";
        expect(options.goalResume.contextText).toContain(marker);
        const recoveredContext = JSON.parse(options.goalResume.contextText.split(marker)[1]);
        expect(Object.keys(recoveredContext).sort()).toEqual(["aho.plan-handoff", "aho.project", "aho.proposal-workspace"]);
        const recoveredHandoff = JSON.parse(recoveredContext["aho.plan-handoff"].value);
        expect(recoveredHandoff).toMatchObject({
          kind: "execute-plan", projectId: "repo", conversationId: options.conversationId,
          sourceDocumentId: expect.any(String), sourceCanonicalItemId: expect.any(String),
          sourceProposalHash: expect.any(String), graphScopeId: expect.any(String),
        });
        const arguments_ = mainAcceptanceArguments({ additionalContext: recoveredContext });
        const missingContract = await options.onDynamicToolCall?.({
          requestId: "request-missing-contract",
          threadId: "thread-main",
          turnId: "turn-accept",
          callId: "call-missing-contract",
          tool: "aho_accept_current_plan",
          arguments: { ...arguments_, contract: null },
        });
        expect(missingContract).toMatchObject({ success: false });
        expect(await listProjectHarnessChanges(skillRoot)).toEqual([]);
        const invalidContract = await options.onDynamicToolCall?.({
          requestId: "request-invalid-contract",
          threadId: "thread-main",
          turnId: "turn-accept",
          callId: "call-invalid-contract",
          tool: "aho_accept_current_plan",
          arguments: {
            ...arguments_,
            contract: { ...healthEndpointContract(), kind: "unknown" },
          },
        });
        expect(invalidContract).toMatchObject({ success: false });
        expect(await listProjectHarnessChanges(skillRoot)).toEqual([]);
        const unsafeContract = await options.onDynamicToolCall?.({
          requestId: "request-unsafe-contract",
          threadId: "thread-main",
          turnId: "turn-accept",
          callId: "call-unsafe-contract",
          tool: "aho_accept_current_plan",
          arguments: {
            ...arguments_,
            contract: { ...healthEndpointContract(), affected_paths: ["C:\\outside\\health.ts"] },
          },
        });
        expect(unsafeContract).toMatchObject({ success: false });
        expect(await listProjectHarnessChanges(skillRoot)).toEqual([]);
        const childAttempt = await options.onDynamicToolCall?.({
          requestId: "request-child-accept",
          threadId: "thread-planner",
          turnId: "turn-accept",
          callId: "call-child-accept",
          tool: "aho_accept_current_plan",
          arguments: arguments_,
        });
        expect(childAttempt).toMatchObject({ success: false });
        expect(await listProjectHarnessChanges(skillRoot)).toEqual([]);
        const accepted = await options.onDynamicToolCall?.({
          requestId: "request-accept",
          threadId: "thread-main",
          turnId: "turn-accept",
          callId: "call-accept",
          tool: "aho_accept_current_plan",
          arguments: arguments_,
        });
        expect(accepted).toMatchObject({ success: true });
        emitCanonicalMainText(options, "计划已接受，等待当前执行确认。", "thread-main", "turn-accept", "message-accept");
        return {
          status: "completed",
          threadId: "thread-main",
          turnId: "turn-accept",
          lastMessage: "计划已接受，等待当前执行确认。",
          goal: nativeGoal("paused"),
          childThreads: [],
        };
      })
      .mockImplementationOnce(async (options) => {
        expect(options.prompt).toContain("Continue the accepted health endpoint Goal.");
        expect(options.goalResume).toMatchObject({
          deliveryKey: expect.stringMatching(/^conversation-continue:/),
          contextText: expect.stringContaining("The user explicitly requested continuation"),
        });
        continueDeliveryKey = options.goalResume?.deliveryKey ?? "";
        return {
          status: "completed",
          threadId: "thread-main",
          turnId: "turn-continue",
          lastMessage: "继续检查当前目标。",
          goal: nativeGoal("blocked"),
          childThreads: [],
        };
      });

    const conversation = await createWorkbenchConversation(project(), {
      body: "Add GET /healthz returning status ok and add a regression test.",
    });
    const messages = await listConversationMessages(project(), conversation.conversationId);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "assistant.message",
        text: "计划子 Agent 已返回方案。\n我还会把当前限制和验收事实一并说明。",
      }),
    ]));
    const plan = messages.find((message) => message.agentRoleId === "planning-agent" && message.document?.documentKind === "plan");
    expect(plan).toMatchObject({ runId: expect.any(String), agentRoleId: "planning-agent" });
    expect(plan?.graphScopeId).toBeTruthy();
    expect(plan?.document).toMatchObject({ proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/), sourceCanonicalItemId: expect.stringContaining(":message-1") });
    expect((await buildConversationInteractionQueue(
      runtimePaths,
      conversation.conversationId,
      plan?.graphScopeId,
      "harness",
    )).items).toEqual([
      expect.objectContaining({ kind: "plan", graphScopeId: plan?.graphScopeId }),
    ]);
    const plannerSurfaces = await getAgentSurfaceProjection({ project: project(), path: root }, conversation.conversationId);
    expect(plannerSurfaces.surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentSurfaceId: agentThreadSurfaceId("codex", "thread-planner"), roleId: "planning-agent" }),
    ]));
    const plannerTimeline = await getCanonicalTimelinePage(
      { project: project(), path: root },
      conversation.conversationId,
      agentThreadSurfaceId("codex", "thread-planner"),
      "harness",
    );
    const plannerInputEnvelope = plannerTimeline.pinned.find((envelope) => envelope.orderClass === "thread-start");
    expect(plannerInputEnvelope).toMatchObject({ orderClass: "thread-start" });
    expect(plannerInputEnvelope?.cells[0]).toMatchObject({
      kind: "user-message",
      source: "provider-runtime",
      providerId: "codex",
      turnId: "turn-planner",
      itemId: "item-child-input",
      text: "Draft the exact proposal.",
    });
    const childTimeline = messages.filter((message) => message.agentRoleId === "planning-agent" && message.threadId === "thread-planner");
    expect(childTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user.message", text: "Draft the exact proposal." }),
      expect.objectContaining({ type: "assistant.message", artifact: expect.stringContaining("planner-proposal") }),
    ]));
    const childProcess = childTimeline.find((message) => message.type === "assistant.message");
    expect(childProcess).toMatchObject({ parentThreadId: "thread-main", turnId: "turn-planner", artifact: expect.stringContaining("planner-proposal") });
    expect(childProcess?.blocks?.map((block) => block.kind)).toEqual(expect.arrayContaining([
      "reasoning-summary", "command", "file-change", "prose",
    ]));
    expect(childProcess?.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "status", label: "thinking" }),
      expect.objectContaining({ kind: "status", label: "completed" }),
    ]));

    await postConversationMessage(project(), conversation.conversationId, {
      mode: "chat",
      message: "执行当前计划",
      planHandoffIntent: {
        kind: "execute-plan",
        sourceRunId: plan?.runId ?? "",
        sourceAgentRoleId: "planning-agent",
        sourceArtifact: plan?.document?.proposalArtifact,
        sourceDocumentId: plan?.document?.documentId,
        sourceCanonicalItemId: plan?.document?.sourceCanonicalItemId,
        sourceProposalHash: plan?.document?.proposalHash,
        executionMode: "stepwise",
      },
    });
    expect((await listConversationMessages(project(), conversation.conversationId))
      .filter((message) => message.agentRoleId === "planning-agent")
      .at(-1)).toMatchObject({ status: "accepted", artifact: undefined, threadId: "thread-planner" });

    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    let changeId: string;
    let currentGraphScopeId: string;
    try {
      const stored = store.conversations.readConversation(project().id, conversation.conversationId);
      expect(stored?.boundChangeId).toBeTruthy();
      changeId = stored?.boundChangeId ?? "";
      currentGraphScopeId = stored?.currentGraphScopeId ?? "";
      expect(store.providerAttempts.listProviderThreads(project().id, conversation.conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ roleId: "main-agent", providerThreadId: "thread-main" }),
        expect.objectContaining({ roleId: "planning-agent", providerThreadId: "thread-planner", parentThreadId: "thread-main", displayName: "Newton" }),
      ]));
      expect(store.providerAttempts.listProviderAttempts(project().id, conversation.conversationId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          providerId: "codex",
          roleId: "planning-agent",
          operationProfile: "planning",
          nativeSessionId: "thread-planner",
          status: "completed",
          capabilitySnapshot: expect.objectContaining({ providerId: "codex" }),
          handoffHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]));
      const mainAttempts = store.providerAttempts.listProviderAttempts(project().id, conversation.conversationId)
        .filter((attempt) => attempt.roleId === "main-agent" && attempt.operationProfile === "main");
      expect(mainAttempts.length).toBeGreaterThanOrEqual(2);
      const createdMain = mainAttempts[0];
      expect(createRequiredSkills).toEqual(["aho-main-orchestration", "repo-harness"]);
      expect(createdMain?.effectiveSkillInputs.map(({ id, path, required }) => ({ id, path, required }))).toEqual(
        createRequestSkills.map(({ name, path }) => ({ id: name, path, required: createRequiredSkills.includes(name) })),
      );
      expect(createdMain?.handoffHash).toBe(expectedHarnessTurnHandoffHash({
        handoffContext: createHandoffContext,
        projectId: project().id,
        conversationId: conversation.conversationId,
        skillInputs: createdMain?.effectiveSkillInputs ?? [],
        nativeSkillRoots: createNativeSkillRoots,
        requiredNativeSkills: createRequiredSkills,
      }));
    } finally {
      store.close();
    }
    const evidenceRoot = join(skillRoot, "state", "changes", "active", changeId);
    const authoredGraph = await readLatestWorkflowGraphPlanAt(evidenceRoot, changeId);
    expect(authoredGraph).toMatchObject({
      graphMode: "sequential-v1",
      nodes: [expect.objectContaining({ id: "health-endpoint" })],
    });
    await expect(loadProjectHarnessContract(skillRoot, changeId)).resolves.toMatchObject({
      change_id: changeId,
      ...healthEndpointContract(),
    });
    expect(JSON.parse(await readFile(
      join(evidenceRoot, "planning", "main-acceptance.json"),
      "utf8",
    ))).toMatchObject({
      acceptedBy: "main-agent",
      projectId: project().id,
      changeId,
      conversationId: conversation.conversationId,
      graphScopeId: currentGraphScopeId,
      contractRequired: true,
      contract: healthEndpointContract(),
    });
    const authorizationIntent = JSON.parse(await readFile(
      join(evidenceRoot, "planning", "execution-authorization-intent.json"),
      "utf8",
    ));
    expect(authorizationIntent).toMatchObject({
      status: "issued",
      changeId,
      conversationId: conversation.conversationId,
      graphId: expect.stringMatching(/^workflow-graph-/),
      authorizationId: expect.stringMatching(/^auth-/),
    });
    expect(JSON.parse(await readFile(
      join(runtimePaths.runsRoot, "execution-authorization", "authorizations", `${authorizationIntent.authorizationId}.json`),
      "utf8",
    ))).toMatchObject({
      id: authorizationIntent.authorizationId,
      providerThreadId: "thread-main",
      mode: "stepwise",
      status: "active",
    });
    const durableSurfaces = await getAgentSurfaceProjection({ project: project(), path: root }, conversation.conversationId);
    expect(durableSurfaces.surfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentSurfaceId: agentThreadSurfaceId("codex", "thread-planner"), roleId: "planning-agent" }),
    ]));
    const durablePlannerTimeline = await getCanonicalTimelinePage(
      { project: project(), path: root },
      conversation.conversationId,
      agentThreadSurfaceId("codex", "thread-planner"),
      "harness",
    );
    const durablePlannerCells = [...durablePlannerTimeline.pinned, ...durablePlannerTimeline.entries].flatMap((envelope) => envelope.cells);
    expect(durablePlannerCells.map((cell) => cell.kind)).toEqual(expect.arrayContaining([
      "process-row", "assistant-message",
    ]));
    expect(durablePlannerCells.filter((cell) => `${cell.title ?? ""}\n${cell.text}\n${cell.detailText ?? ""}`.includes("正在检查需求边界"))).toHaveLength(1);
    expect(durablePlannerCells.filter((cell) => `${cell.text}\n${cell.detailText ?? ""}`.includes("Add the route and regression coverage."))).toHaveLength(1);
    expect(durablePlannerCells.filter((cell) => cell.evidenceRefs?.some((ref) => ref.label === "Plan proposal"))).toHaveLength(1);
    const snapshot = await getWorkbenchSnapshot(
      { project: project(), path: root },
      { topicId: conversation.conversationId },
    );
    expect(snapshot.harness).toMatchObject({ kind: "project-skill", projectId: project().id });
    expect(snapshot.right.confirmationQueue.current).toHaveLength(1);
    expect(snapshot.right.confirmationQueue.primary).toMatchObject({
      conversationId: conversation.conversationId,
      changeId,
      graphScopeId: currentGraphScopeId,
      actions: [expect.objectContaining({
        actionType: "workflow.run.start",
        changeId,
        graphScopeId: currentGraphScopeId,
        workflowGraphPlanId: authoredGraph.id,
      })],
    });
    expect(await listWorkflowRuns(runtimePaths, changeId)).toEqual([]);
    const continued = await runWorkbenchWorkflowAction(project(), {
      actionType: "conversation.continue",
      changeId,
      prompt: "Continue the accepted health endpoint Goal.",
    }, undefined, {
      postConversationMessage,
      continueMainAgentTurn: turnRouter.continueMainAgentTurn,
    });
    expect(continued.error).toBeUndefined();
    expect(continued.status).toBe("completed");
    expect(continueDeliveryKey).toBe(`conversation-continue:${continued.actionRunId}`);
    expect(appServerTurn).toHaveBeenCalledTimes(3);
  });

  it("publishes no Registry contract when Main explicitly accepts the current plan without one", async () => {
    const { conversation, plan } = await createSimplePlannerProposal();
    appServerTurn.mockImplementationOnce(async (options) => {
      const result = await options.onDynamicToolCall?.({
        requestId: "request-no-contract",
        threadId: "thread-main",
        turnId: "turn-accept-no-contract",
        callId: "call-no-contract",
        tool: "aho_accept_current_plan",
        arguments: {
          ...mainAcceptanceArguments(options),
          contractRequired: false,
          contract: null,
          validation: ["Main Agent verified that this proposal does not change a Registry contract boundary."],
        },
      });
      expect(result).toMatchObject({ success: true });
      emitCanonicalMainText(options, "Plan accepted without a Registry contract.", "thread-main", "turn-accept-no-contract", "message-accept-no-contract");
      return {
        status: "completed",
        threadId: "thread-main",
        turnId: "turn-accept-no-contract",
        lastMessage: "Plan accepted without a Registry contract.",
        goal: nativeGoal("paused"),
        childThreads: [],
      };
    });

    await postConversationMessage(project(), conversation.conversationId, {
      mode: "chat",
      message: "执行当前计划",
      planHandoffIntent: planHandoffIntent(plan),
    });

    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    let changeId = "";
    try {
      changeId = store.conversations.readConversation(project().id, conversation.conversationId)?.boundChangeId ?? "";
    } finally {
      store.close();
    }
    expect(changeId).not.toBe("");
    await expect(loadProjectHarnessContract(skillRoot, changeId)).resolves.toBeNull();
    expect(await listProjectHarnessChanges(skillRoot)).toEqual([
      expect.objectContaining({ change_id: changeId, contract_required: false, contract_path: null }),
    ]);
    expect(await listWorkflowRuns(runtimePaths, changeId)).toEqual([]);
  });

  it("rejects a queued Plan handoff that also requests a Provider switch before side effects", async () => {
    const { conversation, plan } = await createSimplePlannerProposal();
    await seedActiveHarnessConversationQueue(conversation.conversationId, conversation.selectedProviderId);
    const before = await readQueueRoutingState(conversation.conversationId);
    const switchProviderAtSafePoint = vi.fn(async () => {
      throw new Error("Provider switching must not run for a queued Plan handoff.");
    });
    const admit = vi.fn(turnRouter.admit);
    const route = vi.fn(turnRouter.route);
    const guardedRouter: ConversationTurnRoutingPort = {
      assertRequestedMode: turnRouter.assertRequestedMode,
      admit,
      resolveAttachments: turnRouter.resolveAttachments,
      route,
      resolveProviderId: turnRouter.resolveProviderId,
      resolveRuntimeState: turnRouter.resolveRuntimeState,
      switchProviderAtSafePoint,
    };

    await expect(postConversationMessageRaw(project(), conversation.conversationId, {
      mode: "chat",
      message: "执行当前计划并切换 Provider",
      productMode: "harness",
      providerId: "other-provider",
      planHandoffIntent: planHandoffIntent(plan),
    }, undefined, { turnRouter: guardedRouter })).rejects.toMatchObject({
      name: "Conflict",
      message: "An active Conversation Turn queue must dispatch its FIFO head before another Turn.",
    });

    expect(switchProviderAtSafePoint).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(await readQueueRoutingState(conversation.conversationId)).toEqual(before);
  });

  it("rolls back Main acceptance when scoped preflight finds a Registry conflict", async () => {
    const seedContext = await resolveProjectHarnessRegistryContext({
      projectId: project().id,
      projectRoot: root,
      skillRoot,
    });
    seedContext.lane = projectHarnessConversationLane("seed-conversation", "graph:seed-conversation:initial");
    await createProjectHarnessChange(seedContext, { changeId: "existing-health-owner" });
    await publishProjectHarnessChange(seedContext, {
      changeId: "existing-health-owner",
      scope: "Existing health owner",
      paths: ["existing-owner/**"],
      status: "active",
      validation: ["Existing accepted Registry owner."],
      contract: {
        ...healthEndpointContract(),
        operation: "maintain-existing-health-endpoint",
        affected_paths: ["existing-owner/**"],
      },
    });

    const { conversation, plan } = await createSimplePlannerProposal();
    let rejected = false;
    appServerTurn.mockImplementationOnce(async (options) => {
      try {
        await options.onDynamicToolCall?.({
          requestId: "request-conflicting-contract",
          threadId: "thread-main",
          turnId: "turn-conflicting-contract",
          callId: "call-conflicting-contract",
          tool: "aho_accept_current_plan",
          arguments: mainAcceptanceArguments(options),
        });
      } catch (error) {
        rejected = true;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("preflight requires replanning");
        expect((error as Error).message).toContain('"type":"contract"');
        expect((error as Error).message).toContain('"other_change_id":"existing-health-owner"');
        expect((error as Error).message).toContain('"subject":"health-endpoint"');
      }
      emitCanonicalMainText(options, "Plan acceptance was blocked by Registry preflight.", "thread-main", "turn-conflicting-contract", "message-conflicting-contract");
      return {
        status: "completed",
        threadId: "thread-main",
        turnId: "turn-conflicting-contract",
        lastMessage: "Plan acceptance was blocked by Registry preflight.",
        goal: nativeGoal("paused"),
        childThreads: [],
      };
    });

    await postConversationMessage(project(), conversation.conversationId, {
      mode: "chat",
      message: "执行当前计划",
      planHandoffIntent: planHandoffIntent(plan),
    });

    expect(rejected).toBe(true);
    expect(await listProjectHarnessChanges(skillRoot)).toEqual([
      expect.objectContaining({ change_id: "existing-health-owner", status: "active" }),
    ]);
    const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
    let graphScopeId = "";
    try {
      const current = store.conversations.readConversation(project().id, conversation.conversationId);
      expect(current?.boundChangeId).toBeNull();
      graphScopeId = current?.currentGraphScopeId ?? "";
    } finally {
      store.close();
    }
    const currentLaneContext = await resolveProjectHarnessRegistryContext({
      projectId: project().id,
      projectRoot: root,
      skillRoot,
    });
    currentLaneContext.lane = projectHarnessConversationLane(conversation.conversationId, graphScopeId);
    await expect(readProjectHarnessLane(currentLaneContext)).resolves.toBeNull();
    expect(existsSync(join(runtimePaths.runsRoot, "execution-authorization"))).toBe(false);
  });
});

async function createSimplePlannerProposal() {
  appServerTurn.mockImplementationOnce(async (options) => {
    await writePlannerFiles(options.writableRoots?.[0] ?? "");
    emitMainThreadStarted(options, "thread-main", "turn-plan");
    emitPlanningChildStarted(options, "thread-main", "thread-planner", "item-spawn-planner");
    emitCanonicalPlannerText(
      options,
      plannerPlanText(),
      "thread-main",
      "turn-plan",
      "thread-planner",
      "turn-planner",
      "message-planner",
    );
    return {
      status: "completed",
      threadId: "thread-main",
      turnId: "turn-plan",
      lastMessage: "Planning proposal is ready.",
      goal: nativeGoal("active"),
      childThreads: [{
        itemId: "item-spawn-planner",
        parentThreadId: "thread-main",
        threadId: "thread-planner",
        roleHint: "planning-agent",
        status: "completed",
        displayName: "Newton",
        finalText: plannerPlanText(),
        changedFiles: [],
        snapshot: {},
      }],
    };
  });
  const conversation = await createWorkbenchConversation(project(), {
    body: "Add GET /healthz returning status ok and add a regression test.",
  });
  const messages = await listConversationMessages(project(), conversation.conversationId);
  const plan = messages.find((message) =>
    message.agentRoleId === "planning-agent" && message.document?.documentKind === "plan");
  if (!plan?.document?.proposalArtifact || !plan.document.proposalHash) {
    throw new Error("Simple planner fixture did not produce an exact proposal artifact.");
  }
  return { conversation, plan };
}

function planHandoffIntent(plan: Awaited<ReturnType<typeof listConversationMessages>>[number]) {
  return {
    kind: "execute-plan" as const,
    sourceRunId: plan.runId ?? "",
    sourceAgentRoleId: "planning-agent" as const,
    sourceArtifact: plan.document?.proposalArtifact,
    sourceDocumentId: plan.document?.documentId,
    sourceCanonicalItemId: plan.document?.sourceCanonicalItemId,
    sourceProposalHash: plan.document?.proposalHash,
    executionMode: "stepwise" as const,
  };
}

async function seedActiveHarnessConversationQueue(conversationId: string, providerId: string): Promise<void> {
  const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
  try {
    const queuedAt = new Date().toISOString();
    const queue = database.conversationTurnQueues.ensureQueue({
      projectId: project().id,
      conversationId,
      productMode: "harness",
      updatedAt: queuedAt,
    });
    database.transaction(() => {
      database.conversationTurnQueues.insertItem({
        projectId: project().id,
        conversationId,
        productMode: "harness",
        queueItemId: "queue-plan-provider-boundary",
        clientRequestId: "queue-plan-provider-boundary-request",
        requestHash: "queue-plan-provider-boundary-hash",
        position: 1,
        status: "queued",
        retryCount: 0,
        predecessorExecutionRevision: "execution:idle",
        dispatchRequestId: "queue-plan-provider-boundary-dispatch",
        text: "Queued Harness follow-up.",
        contextRefsJson: "[]",
        attachmentIdsJson: "[]",
        skillOverridesJson: "{}",
        providerId,
        agentTurnMode: null,
        agentModelId: null,
        agentReasoningEffort: null,
        diagnostic: null,
        createdAt: queuedAt,
        updatedAt: queuedAt,
        dispatchedAt: null,
      });
      database.conversationTurnQueues.advanceRevision(
        project().id,
        conversationId,
        queue.revision,
        queuedAt,
      );
    });
  } finally {
    database.close();
  }
}

async function readQueueRoutingState(conversationId: string) {
  const database = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
  try {
    const conversation = database.conversations.readConversation(project().id, conversationId)!;
    return {
      selectedProviderId: conversation.selectedProviderId,
      currentGraphScopeId: conversation.currentGraphScopeId,
      messages: database.timeline.listConversationMessages(project().id, conversationId).map((message) => message.id),
      attempts: database.providerAttempts.listProviderAttempts(project().id, conversationId).map((attempt) => attempt.attemptId),
      resumePoint: database.providerAttempts.readLatestProviderResumePoint(project().id, conversationId),
      queue: database.conversationTurnQueues.listItems(project().id, conversationId),
    };
  } finally {
    database.close();
  }
}

async function createSkillNativeConversationChange(
  changeId: string,
  title: string,
  body: string,
): Promise<{ changeId: string; conversationId: string; title: string; state: "active" }> {
  const conversation = await createWorkbenchConversation(project(), { body }, undefined, { runMainAgent: false });
  await bindSkillNativeChange(conversation.conversationId, changeId);
  return {
    changeId,
    conversationId: conversation.conversationId,
    title,
    state: "active",
  };
}

async function bindSkillNativeChange(conversationId: string, changeId: string): Promise<{
  context: Awaited<ReturnType<typeof resolveProjectHarnessRegistryContext>>;
  claimToken: string;
}> {
  const store = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
  let graphScopeId: string;
  try {
    graphScopeId = store.conversations.readConversation(project().id, conversationId)?.currentGraphScopeId ?? "";
  } finally {
    store.close();
  }
  if (!graphScopeId) throw new Error(`Conversation has no graph scope: ${conversationId}.`);
  const context = await resolveProjectHarnessRegistryContext({
    projectId: project().id,
    projectRoot: root,
    skillRoot,
  });
  context.lane = projectHarnessConversationLane(conversationId, graphScopeId);
  const change = await createProjectHarnessChange(context, { changeId });

  const boundStore = await openProjectRuntimeWorkbenchDatabase(runtimePaths);
  try {
    const now = new Date().toISOString();
    boundStore.unitOfWork.acceptConversationChangeBinding(
      project().id,
      conversationId,
      changeId,
      now,
      `fixture-acceptance:${changeId}`,
      `fixture-proposal:${changeId}`,
      undefined,
      graphScopeId,
    );
  } finally {
    boundStore.close();
  }
  return { context, claimToken: change.claim_token };
}

function emitCanonicalMainText(
  options: { runId: string; conversationId?: string; onRealtimeEvent?: (event: ReturnType<typeof normalizeCodexAppServerNotification>[number]) => void },
  text: string,
  threadId: string,
  turnId: string,
  itemId: string,
): void {
  for (const event of normalizeCodexAppServerNotification("item/agentMessage/delta", { itemId, delta: text }, {
    projectId: project().id,
    conversationId: options.conversationId,
    runId: options.runId,
    threadId,
    turnId,
    itemId,
    roleId: "main-agent",
  })) options.onRealtimeEvent?.(event);
}

function emitCanonicalPlannerText(
  options: { runId: string; conversationId?: string; onRealtimeEvent?: (event: ReturnType<typeof normalizeCodexAppServerNotification>[number]) => void },
  text: string,
  parentThreadId: string,
  parentTurnId: string,
  threadId: string,
  turnId: string,
  itemId: string,
): void {
  emitMainThreadStarted(options, parentThreadId, parentTurnId);
  for (const event of normalizeCodexAppServerNotification("item/agentMessage/delta", { itemId, delta: text }, {
    projectId: project().id,
    conversationId: options.conversationId,
    runId: options.runId,
    threadId,
    parentThreadId,
    turnId,
    itemId,
    roleId: "planning-agent",
  })) options.onRealtimeEvent?.(event);
}

function emitMainThreadStarted(
  options: { runId: string; conversationId?: string; onRealtimeEvent?: (event: ReturnType<typeof normalizeCodexAppServerNotification>[number]) => void },
  threadId: string,
  turnId: string,
): void {
  for (const event of normalizeCodexAppServerNotification("turn/started", { turnId }, {
    projectId: project().id,
    conversationId: options.conversationId,
    runId: options.runId,
    threadId,
    turnId,
    roleId: "main-agent",
  })) options.onRealtimeEvent?.(event);
}

function emitPlanningChildStarted(
  options: { onChildLifecycleEvent?: (event: {
    kind: "started" | "continued" | "closed";
    activityId: string;
    parentThreadId: string;
    childThreadId: string;
    roleHint?: string;
  }) => void },
  parentThreadId: string,
  childThreadId: string,
  activityId: string,
): void {
  options.onChildLifecycleEvent?.({
    kind: "started",
    activityId,
    parentThreadId,
    childThreadId,
    roleHint: "planning-agent",
  });
}

function nativeGoal(status: "active" | "paused" | "blocked" | "complete") {
  return {
    threadId: "thread-main",
    objective: "Add a health endpoint with regression coverage",
    status,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 1,
    createdAt: 100,
    updatedAt: 101,
  };
}

function expectedHarnessTurnHandoffHash(input: {
  handoffContext: string;
  projectId: string;
  conversationId: string;
  skillInputs: Array<{ id: string; path: string; source: string; contentHash: string; required: boolean }>;
  nativeSkillRoots: string[];
  requiredNativeSkills: string[];
}): string {
  const baseHandoffHash = createHash("sha256").update(input.handoffContext).digest("hex");
  const skillResolutionHash = createHash("sha256").update(JSON.stringify({
    projectId: input.projectId,
    conversationId: input.conversationId,
    productMode: "harness",
    providerId: "codex",
    skillInputs: input.skillInputs,
    diagnostics: [],
    nativeSkillRoots: input.nativeSkillRoots,
    requiredNativeSkills: input.requiredNativeSkills,
  })).digest("hex");
  return createHash("sha256").update(JSON.stringify({
    baseHandoffHash,
    skillResolutionHash,
  })).digest("hex");
}

function readyCodexCapabilities() {
  return {
    available: true,
    version: "test",
    approvalFlagPlacement: "exec" as const,
    supportsJson: true,
    supportsSandbox: true,
    supportsCd: true,
    supportsAddDir: true,
    supportsColor: true,
    supportsOutputLastMessage: true,
    supportsSafeResume: true,
    supportsResumeAddDir: true,
    errors: [],
  };
}

function plannerProposal(): string {
  return JSON.stringify({
    status: "proposed",
    specMd: "# Spec\n\n## Acceptance Criteria\n\n- AC-001: GET /healthz returns HTTP 200 and status ok without changing GET /.\n",
    planMd: [
      "# Plan", "", "## Approach", "Add the route and regression coverage.", "", "## Workflow", "", "```json",
      JSON.stringify({
        version: "1.0",
        mode: "sequential-v1",
        nodes: [{
          id: "health-endpoint",
          title: "Add health endpoint",
          taskIds: ["T-001"],
          acIds: ["AC-001"],
          prompt: "Objective: Add GET /healthz. Required behavior: Add regression coverage while preserving GET /. Constraints: Stay within src and test scopes. Expected evidence: Report changed files and test results.",
          dependsOn: [],
          sourceScopes: ["src/**", "test/**"],
        }],
      }, null, 2),
      "```", "",
    ].join("\n"),
    tasksMd: "# Tasks\n\n- [ ] T-001: Add GET /healthz and its regression test.\n  - Covers: AC-001\n",
    openQuestions: [],
    assumptions: [],
    warnings: [],
  });
}

function plannerPlanText(): string {
  return (JSON.parse(plannerProposal()) as { planMd: string }).planMd;
}

async function writePlannerFiles(directory: string): Promise<void> {
  const proposal = JSON.parse(plannerProposal()) as { specMd: string; planMd: string; tasksMd: string };
  await writeFile(join(directory, "spec.md"), proposal.specMd, "utf8");
  await writeFile(join(directory, "plan.md"), proposal.planMd, "utf8");
  await writeFile(join(directory, "tasks.md"), proposal.tasksMd, "utf8");
  await writeFile(join(directory, "registry-contract.json"), `${JSON.stringify({
    version: "1.0",
    required: true,
    contract: {
      kind: "api",
      subject: "unauthorized-planner-contract",
      operation: "must-not-publish",
      owner_module: "planning-agent",
      affected_paths: ["../planner-owned"],
      consumers: [],
      depends_on: [],
      depends_on_changes: [],
      compatibility: "This file must be ignored.",
      status: "active",
    },
    validation: ["Unauthorized Planning artifact."],
  }, null, 2)}\n`, "utf8");
}

function mainAcceptanceArguments(options: {
  additionalContext?: Record<string, { value: string }>;
}): Record<string, unknown> {
  const context = JSON.parse(options.additionalContext?.["aho.plan-handoff"]?.value ?? "{}") as {
    sourceProposalHash?: string;
    graphScopeId?: string;
  };
  return {
    proposalHash: context.sourceProposalHash,
    graphScopeId: context.graphScopeId,
    contractRequired: true,
    contract: healthEndpointContract(),
    validation: ["Main Agent verified the endpoint owner against the project Skill, source, and current Registry."],
  };
}

function healthEndpointContract() {
  return {
    kind: "api",
    subject: "health-endpoint",
    operation: "add-health-endpoint",
    owner_module: "http-service",
    affected_paths: ["src/**", "test/**"],
    consumers: ["operators"],
    depends_on: [],
    depends_on_changes: [],
    compatibility: "GET / remains unchanged.",
    status: "active",
  };
}

function project(): ManagedProject {
  return { id: "repo", name: "Repo", path: root, addedAt: "2026-07-10T00:00:00.000Z", lastSeenAt: "2026-07-10T00:00:00.000Z" };
}
