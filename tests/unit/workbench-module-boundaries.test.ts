import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const retiredLoopName = ["goal", "loop"].join("-");
const retiredFiles = [
  `src/${retiredLoopName}`,
  `src/${retiredLoopName}-runtime`,
  "src/automation-runtime",
  `src/workbench/actions/handlers/${retiredLoopName}.ts`,
  `src/workbench/actions/handlers/${retiredLoopName}-runtime.ts`,
  "src/workbench/actions/handlers/automation.ts",
  "src/workbench/actions/visible-goal-loop-current-gate.ts",
  "src/workbench/actions/goal-loop-gate-confirmation.ts",
  "src/main-agent-orchestration/action-bridge.ts",
  "src/main-agent-orchestration/resume-continuation.ts",
  "src/main-agent-orchestration/strategy-advice-runtime.ts",
  "src/workflow-scheduler/controlled-step.ts",
];

describe("Workbench module boundaries", () => {
  it("keeps Electron Main out of business owners and limits Utility composition", () => {
    const main = readFileSync("src/desktop/main.ts", "utf8");
    const utility = readFileSync("src/desktop/utility.ts", "utf8");
    expect(main).not.toMatch(/\.\.\/server|\.\.\/workbench|\.\.\/provider-runtime|\.\.\/project-runtime/);
    expect(main).not.toMatch(/ipcRenderer|contextBridge|nodeIntegration:\s*true/);
    expect(main).toContain('window.on("page-title-updated"');
    expect(main).toContain('window?.setTitle(productName)');
    expect(main).toContain('const productName = buildInfo.channel === "test" ? "Beaver Code 更新测试" : "Beaver Code"');
    expect(main).toContain("return value === startupUrl");
    expect(main).not.toContain('return value.startsWith("file:")');
    expect(utility).toContain('from "../server/workbench-server.js"');
    expect(utility).toContain("process.parentPort");
    expect(utility).not.toMatch(/import\s*\{[^}]*parentPort[^}]*\}\s*from\s*["']electron["']/);
    expect(utility).not.toMatch(/\.\.\/workbench|\.\.\/provider-runtime|\.\.\/project-runtime/);
  });

  it("retires the legacy objective loop, controlled continuation, scoped automation, and bridge owners", () => {
    for (const file of retiredFiles) expect(existsSync(file), file).toBe(false);
  });

  it("keeps retired action ids out of product source", () => {
    const retiredActionPattern = [
      ["planning\\.", "goal", "-", "loop"].join(""),
      ["planning\\.scheduler\\.controlled-", "(step|advance)"].join(""),
      ["planning\\.automation\\.scoped-", "auto"].join(""),
    ].join("|");
    const output = rgOutput([
      "-n",
      retiredActionPattern,
      "src",
    ]);
    expect(output.trim()).toBe("");
  });

  it("keeps workflow-runtime independent of Workbench, web, and server UI types", () => {
    const output = rgOutput(["-n", "workbench|src/web|src/server", "src/workflow-runtime"]);
    expect(output.trim()).toBe("");
  });

  it("routes provider-switch DemandWorker reconciliation through the Skill-native Workbench owner", () => {
    const providerSwitch = readFileSync("src/workbench/provider-switch.ts", "utf8");
    expect(providerSwitch).toContain('from "./demand-workers/orchestration.js"');
    expect(providerSwitch).not.toMatch(/workflow-runtime\/demand-worker|reconcileDemandWorkersForRuntime/);
  });

  it("keeps Change acceptance independent of Workbench, web, and server storage", () => {
    const output = rgOutput(["-n", "workbench|src/web|src/server", "src/change"]);
    expect(output.trim()).toBe("");
  });

  it("keeps Codex launch sites behind the shared executable resolver", () => {
    const output = rgOutput([
      "-n",
      'spawn\\("codex"|command:\\s*"codex"|command:\\s*\\["codex"|return \\{ command: "codex"',
      "src/codex",
      "src/agent",
      "src/code",
    ]);
    expect(output.trim()).toBe("");
  });

  it("keeps Scheduler current-step selection in workflow-runtime and the leaf helper exact-target only", () => {
    const owner = readFileSync("src/workflow-runtime/scheduler-ready-set.ts", "utf8");
    const leaf = readFileSync("src/scheduler-runtime/worker-start.ts", "utf8");
    expect(owner).toContain("readLatestSchedulerCurrentTransitionView");
    expect(owner).toContain("runSchedulerReadySetCurrentStep");
    expect(owner).toContain("startSchedulerCoderWorkerForReadySetTarget");
    expect(leaf).not.toContain("findNextSchedulerReservationIntent");
    expect(leaf).not.toContain("start-all");
  });

  it("keeps native Goal lifecycle provider-owned without an AHO Goal state store", () => {
    const provider = readFileSync("src/codex/app-server.ts", "utf8");
    const conversation = readFileSync("src/workbench/main-agent-turn-coordinator.ts", "utf8");
    expect(provider).toContain('sendRequest("thread/goal/get"');
    expect(provider).toContain('sendRequest("thread/goal/set"');
    expect(conversation).toContain('name: "aho_goal_yield"');
    expect(conversation).toContain('name: "aho_finalize_current_change"');
    expect(existsSync("src/workbench/codex-chat")).toBe(false);
    expect(existsSync("src/goal-manager")).toBe(false);
  });

  it("keeps canonical Timeline delivery and Conversation lifecycle in exact owners", () => {
    for (const retired of [
      "src/workbench/chat.ts",
      "src/workbench/manager.ts",
      "src/workbench/canonical-timeline.ts",
      "src/workbench/conversation-thread.ts",
    ]) expect(existsSync(retired), retired).toBe(false);

    const directPublishers = rgOutput(["-l", 'emit\\(\\{ event: "timeline\\.patch"', "src/workbench"])
      .trim().split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/"));
    expect(directPublishers).toEqual(["src/workbench/canonical-timeline-delivery.ts"]);

    const directWrites = rgOutput(["-l", "\\.timeline\\.(appendMessage|updateMessage)\\(", "src/workbench"])
      .trim().split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/")).sort();
    expect(directWrites).toEqual([
      "src/workbench/canonical-timeline-delivery.ts",
      "src/workbench/conversation-fork-lifecycle.ts",
      "src/workbench/conversation-input-commit.ts",
      "src/workbench/conversation-review-lifecycle.ts",
      "src/workbench/persistence/repositories/conversation-context-repository.ts",
      "src/workbench/persistence/repositories/interaction-repository.ts",
      "src/workbench/persistence/unit-of-work.ts",
    ]);

    const contract = readFileSync("src/workbench/canonical-timeline-contract.ts", "utf8");
    expect(contract).not.toMatch(/read-model|database|\.\/types\.js/);
    expect(contract).toContain('import type { ProductMode } from "../provider-runtime/index.js";');
    const retiredSymbols = rgOutput([
      "-n",
      "knownIds|canonicalMessageIds|upsertCanonicalMessage|upsertBackgroundEntry|appendConversationTimelineEntry|openConversationTimelineWriter|ConversationTimelineWriter",
      "src",
    ]);
    expect(retiredSymbols.trim()).toBe("");
  });

  it("keeps Conversation, Main Agent, and Workflow lifecycle owners acyclic", () => {
    const conversation = readFileSync("src/workbench/conversation-service.ts", "utf8");
    const main = readFileSync("src/workbench/main-agent-turn-coordinator.ts", "utf8");
    const workflow = readFileSync("src/workbench/workflow-conversation-bridge.ts", "utf8");
    const identity = readFileSync("src/workbench/conversation-identity.ts", "utf8");

    expect(conversation).not.toContain('from "./main-agent-turn-coordinator.js"');
    expect(conversation).toContain('from "./workflow-conversation-bridge.js"');
    expect(main).not.toContain('from "./workflow-conversation-bridge.js"');
    expect(conversation).toContain("continueMainAgentTurn: turnRouter.continueMainAgentTurn");
    expect(workflow).toContain("resumeNativeGoalAfterAction");
    expect(workflow).toContain("requireContinueMainAgentTurn(ports)");
    expect(main).not.toMatch(/childProcessMessage\.attemptId\s*=\s*isPlannerChild/);
    expect(workflow).not.toMatch(/conversation-service|main-agent-turn-coordinator/);
    expect(workflow).toContain('from "./conversation-identity.js"');
    expect(identity).not.toMatch(/conversation-service|main-agent-turn-coordinator|workflow-conversation-bridge/);
  });
});

function rgOutput(args: string[]): string {
  const mode = args[0];
  const pattern = args[1];
  const roots = args.slice(2);
  if ((mode !== "-n" && mode !== "-l") || !pattern || roots.length === 0) {
    throw new Error(`Unsupported source scan arguments: ${args.join(" ")}`);
  }
  const matcher = new RegExp(pattern);
  const matches: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) throw new Error(`Source scan root does not exist: ${root}`);
    visit(root);
  }
  return matches.join("\n");

  function visit(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const candidate = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const normalized = candidate.replaceAll("\\", "/");
      const matchingLines = readFileSync(candidate, "utf8").split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => matcher.test(line));
      if (matchingLines.length === 0) continue;
      if (mode === "-l") matches.push(normalized);
      else matches.push(...matchingLines.map(({ line, number }) => `${normalized}:${number}:${line}`));
    }
  }
}
