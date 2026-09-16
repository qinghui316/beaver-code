import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateCodexAppServerCapabilities, extractCodexAppServerPlanText, extractCodexAppServerThreadDisplayName, extractCodexAppServerThreadFinalText, extractCodexAppServerThreadInitialPrompt, extractCodexAppServerThreadInitialUserItem } from "../../src/codex/app-server.js";
import { buildCodexReadonlyArgv, buildCodexReadonlyResumeArgv, buildCodexWorkspaceWriteArgv, detectCodexCapabilities, evaluateCodexCapabilities } from "../../src/codex/capabilities.js";
import { codexExecutableEnvironmentKey, resetCodexRuntimeForTests, resolveCodexExecutable, resolveCodexRuntime } from "../../src/codex/executable.js";
import { defaultCodexAppServerHostRegistry } from "../../src/codex/app-server-host.js";
import { createCodexJsonlStreamParser, extractFinalMessageFromCodexJsonl, truncateReadablePreview, type CodexJsonlStreamEvent } from "../../src/codex/jsonl.js";
import { candidatesFromModelListResponse, getCodexModelSettingsSnapshot, resolveCodexEffectiveModel, setSelectedCodexModel } from "../../src/codex/model-settings.js";
import { composeCodexPrompt, readPromptInput } from "../../src/codex/prompt.js";
import { readCodexConfigModelStatus, readCodexNativeCollabConfigStatus } from "../../src/codex/trust.js";
import {
  assertProductMode,
  parseProductMode,
  PRODUCT_MODES,
  stableCapabilitySnapshotHash,
} from "../../src/provider-runtime/index.js";
import { resolveCodexModeReadiness } from "../../src/provider-runtime/codex.js";
import { PROVIDER_OPERATION_CAPABILITIES, type ProviderCapabilityItem } from "../../src/provider-runtime/types.js";
import { renderTopicFileReferencesForPrompt } from "../../src/workbench/file-references.js";

const rootHelp = "Usage: codex [OPTIONS]\n  -a, --ask-for-approval <APPROVAL_POLICY>\n";
const execHelp = [
  "Usage: codex exec [OPTIONS]",
  "  --json",
  "  --color <COLOR>",
  "  -s, --sandbox <SANDBOX_MODE>",
  "  -C, --cd <DIR>",
  "  --add-dir <DIR>",
  "  -o, --output-last-message <FILE>",
].join("\n");

describe("codex capabilities", () => {
  it("uses one explicit environment key for Codex runtime selection", () => {
    expect(codexExecutableEnvironmentKey()).toBe("AHO_CODEX_BIN");
  });

  it.runIf(process.platform === "win32")("selects the newest compatible Codex runtime from PATH", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho codex runtime "));
    const oldDir = join(temp, "old");
    const newDir = join(temp, "new");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await writeCompatibleCodexCmd(join(oldDir, "codex.cmd"), "0.144.0");
    await writeCompatibleCodexCmd(join(newDir, "codex.cmd"), "0.154.0-alpha.6.2");
    await writeFile(join(temp, "codex.cmd"), "@echo off\r\necho broken\r\n", "utf8");
    try {
      const runtime = resolveCodexRuntime({ PATH: `${temp};${oldDir};${newDir}`, PATHEXT: ".CMD" });
      expect(runtime.command).toBe(join(newDir, "codex.cmd"));
      expect(runtime.version).toContain("0.154.0-alpha.6.2");
      expect(runtime.source).toBe("path");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("prefers a stable release over a prerelease with the same core version", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho codex stable "));
    const prereleaseDir = join(temp, "prerelease");
    const stableDir = join(temp, "stable");
    await mkdir(prereleaseDir, { recursive: true });
    await mkdir(stableDir, { recursive: true });
    await writeCompatibleCodexCmd(join(prereleaseDir, "codex.cmd"), "0.154.0-alpha.9");
    await writeCompatibleCodexCmd(join(stableDir, "codex.cmd"), "0.154.0");
    try {
      expect(resolveCodexRuntime({ PATH: `${prereleaseDir};${stableDir}`, PATHEXT: ".CMD" }).command).toBe(join(stableDir, "codex.cmd"));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("honors a compatible explicit Codex runtime override", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho codex override "));
    const executable = join(temp, "explicit codex.cmd");
    await writeCompatibleCodexCmd(executable, "0.140.0");
    try {
      expect(resolveCodexExecutable({ AHO_CODEX_BIN: ` ${executable} ` })).toBe(executable);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("starts an explicitly configured Windows .cmd executable during capability probing", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho codex cmd "));
    const executable = join(temp, "fake codex.cmd");
    const previous = process.env.AHO_CODEX_BIN;
    try {
      await writeFile(executable, [
        "@echo off",
        "echo codex-cli fixture",
        "echo app server --listen stdio:// --json --sandbox --cd --add-dir --color --output-last-message",
      ].join("\r\n"), "utf8");
      process.env.AHO_CODEX_BIN = executable;
      resetCodexRuntimeForTests();

      const capabilities = await detectCodexCapabilities();

      expect(capabilities.available).toBe(true);
      expect(capabilities.version).toContain("codex-cli fixture");
      expect(capabilities.supportsJson).toBe(true);
      expect(capabilities.supportsSandbox).toBe(true);
      expect(capabilities.supportsCd).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AHO_CODEX_BIN;
      else process.env.AHO_CODEX_BIN = previous;
      resetCodexRuntimeForTests();
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("detects app-server stdio lifecycle support from help", () => {
    const capabilities = evaluateCodexAppServerCapabilities("Usage: codex app-server [OPTIONS]\n  --listen <URL>  default: stdio://\nRun the app server");

    expect(capabilities).toMatchObject({
      available: true,
      supportsStdio: true,
      supportsRequiredLifecycle: true,
      errors: [],
    });
  });

  it("falls back when app-server stdio transport is unavailable", () => {
    const capabilities = evaluateCodexAppServerCapabilities("Usage: codex app-server [OPTIONS]", "spawn failed");

    expect(capabilities.available).toBe(false);
    expect(capabilities.errors).toEqual(expect.arrayContaining([
      "spawn failed",
      "Codex app-server does not advertise stdio transport.",
    ]));
  });

  it("uses plan item content as the native Plan transcript and ignores turn checklist updates", () => {
    expect(extractCodexAppServerPlanText("item/plan/delta", { delta: "step 1" })).toBe("step 1");
    expect(extractCodexAppServerPlanText("turn/plan/updated", {
      plan: {
        steps: [
          { title: "确认目标", description: "先确认需求和验收标准。" },
          { title: "实施", description: "按确认后的范围修改。" },
        ],
      },
    })).toBe("");
    const arrayPlan = extractCodexAppServerPlanText("turn/plan/updated", {
      explanation: "只记录后续工作安排，不做任何文件修改或命令执行。",
      plan: [
        { step: "确认项目说明和当前记录中没有更高优先级限制。", status: "pending" },
        { step: "修改后运行 `node test.mjs`，用测试结果确认目标字符串被接受。", status: "pending" },
      ],
    });
    expect(arrayPlan).toBe("");
    expect(extractCodexAppServerPlanText("item/completed", {
      item: { type: "proposed-plan", markdown: "## 目标\n生成计划\n\n## 验收\n通过测试" },
    })).toContain("## 目标");
  });

  it("reads the final assistant output from a provider child thread snapshot", () => {
    const snapshot = {
      thread: {
        id: "thread-child",
        agentNickname: "Newton",
        agentRole: "planner",
        turns: [{ id: "turn-child-1", items: [
          { id: "item-child-input-1", type: "userMessage", role: "user", content: [{ type: "input_text", text: "Use $aho-workflow-authoring and draft the proposal." }] },
          { type: "agentMessage", role: "assistant", content: [{ type: "output_text", text: "{\"planMd\":\"# Plan\"}" }] },
        ] }],
      },
    };
    expect(extractCodexAppServerThreadInitialPrompt(snapshot)).toBe("Use $aho-workflow-authoring and draft the proposal.");
    expect(extractCodexAppServerThreadInitialUserItem(snapshot)).toEqual({
      turnId: "turn-child-1",
      itemId: "item-child-input-1",
      text: "Use $aho-workflow-authoring and draft the proposal.",
    });
    expect(extractCodexAppServerThreadInitialUserItem({ thread: { turns: [{ id: "turn-1", items: [{ id: "developer-1", type: "developerMessage", role: "developer", content: [{ type: "input_text", text: "hidden" }] }] }] } })).toBeUndefined();
    expect(extractCodexAppServerThreadInitialUserItem({ thread: { turns: [{ items: [{ id: "item-1", type: "userMessage", content: [{ type: "input_text", text: "missing turn" }] }] }] } })).toBeUndefined();
    expect(extractCodexAppServerThreadFinalText(snapshot)).toBe('{"planMd":"# Plan"}');
    expect(extractCodexAppServerThreadDisplayName(snapshot)).toBe("Newton");
    expect(extractCodexAppServerThreadDisplayName({ thread: { id: "unnamed-child" } })).toBeUndefined();
  });

  it("builds root-level approval argv", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", rootHelp, execHelp);

    const argv = buildCodexReadonlyArgv(capabilities, {
      projectPath: "C:/repo",
      lastMessagePath: "C:/repo/.agent-harness/runs/run/last-message.md",
      model: "gpt-5.3-codex",
      profile: "default",
    });

    expect(argv.args.slice(0, 6)).toEqual(["-c", 'service_tier="fast"', "--ask-for-approval", "never", "exec", "--json"]);
    expect(argv.args).toContain("--sandbox");
    expect(argv.args).toContain("read-only");
    expect(argv.args).toContain("--output-last-message");
    expect(argv.args).toContain("--model");
    expect(argv.args).toContain("--profile");
    expect(capabilities.supportsAddDir).toBe(true);
    expect(argv.args).toContain("-");
    expect(argv.args).not.toContain("--full-auto");
    expect(argv.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.args).not.toContain("--ignore-user-config");
    expect(argv.args).not.toContain("--skip-git-repo-check");
    expect(argv.args).toContain('service_tier="fast"');
  });

  it("builds exec-level approval argv", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", "Usage: codex", `${execHelp}\n--ask-for-approval <APPROVAL_POLICY>`);

    const argv = buildCodexReadonlyArgv(capabilities, {
      projectPath: "/repo",
      lastMessagePath: "/repo/.agent-harness/runs/run/last-message.md",
    });

    expect(argv.args.slice(0, 6)).toEqual(["-c", 'service_tier="fast"', "exec", "--ask-for-approval", "never", "--json"]);
  });

  it("fails capability evaluation without safe required flags", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", "Usage: codex", "Usage: codex exec");

    expect(capabilities.errors).toEqual(expect.arrayContaining([
      "Codex exec does not support --json.",
      "Codex exec does not support --sandbox.",
      "Codex exec does not support --cd.",
    ]));
    expect(() => buildCodexReadonlyArgv(capabilities, { projectPath: "/repo", lastMessagePath: "/repo/out.md" })).toThrow("safe read-only");
  });

  it("allows missing output-last-message and relies on JSONL fallback", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", rootHelp, execHelp.replace("  -o, --output-last-message <FILE>", ""));
    const argv = buildCodexReadonlyArgv(capabilities, { projectPath: "/repo", lastMessagePath: "/repo/out.md" });

    expect(capabilities.supportsOutputLastMessage).toBe(false);
    expect(capabilities.errors).toHaveLength(0);
    expect(argv.args).not.toContain("--output-last-message");
  });

  it("adds optional read-only memory directories when supported", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", rootHelp, execHelp);
    const argv = buildCodexReadonlyArgv(capabilities, {
      projectPath: "/worktree",
      lastMessagePath: "/memory/runs/run/last-message.md",
      additionalReadDirs: ["/memory"],
    });

    expect(argv.args).toContain("--add-dir");
    expect(argv.args).toContain("/memory");
  });

  it("only allows resume when resume help exposes equivalent sandbox and cwd constraints", () => {
    const unsafe = evaluateCodexCapabilities("codex-cli 1.0", rootHelp, execHelp, undefined, "Usage: codex exec resume [SESSION]");
    expect(unsafe.supportsSafeResume).toBe(false);
    expect(() => buildCodexReadonlyResumeArgv(unsafe, {
      projectPath: "/repo",
      lastMessagePath: "/repo/out.md",
      sessionId: "session-1",
    })).toThrow("equivalent read-only");

    const safe = evaluateCodexCapabilities("codex-cli 1.0", rootHelp, execHelp, undefined, "Usage: codex exec resume --sandbox <MODE> --cd <DIR> --add-dir <DIR>");
    const argv = buildCodexReadonlyResumeArgv(safe, {
      projectPath: "/repo",
      lastMessagePath: "/repo/out.md",
      sessionId: "session-1",
      additionalReadDirs: ["/memory"],
    });
    expect(argv.args).toContain("--sandbox");
    expect(argv.args).toContain("read-only");
    expect(argv.args).toContain("--cd");
    expect(argv.args).toContain("/repo");
    expect(argv.args).toContain("--add-dir");
    expect(argv.args).toContain("/memory");

    const noAddDirResume = evaluateCodexCapabilities("codex-cli 1.0", rootHelp, execHelp, undefined, "Usage: codex exec resume --sandbox <MODE> --cd <DIR>");
    expect(() => buildCodexReadonlyResumeArgv(noAddDirResume, {
      projectPath: "/repo",
      lastMessagePath: "/repo/out.md",
      sessionId: "session-1",
      additionalReadDirs: ["/memory"],
    })).toThrow("--add-dir");
  });

  it("omits optional read-only memory directories when unsupported", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", rootHelp, execHelp.replace("  --add-dir <DIR>\n", ""));
    const argv = buildCodexReadonlyArgv(capabilities, {
      projectPath: "/worktree",
      lastMessagePath: "/memory/runs/run/last-message.md",
      additionalReadDirs: ["/memory"],
    });

    expect(capabilities.supportsAddDir).toBe(false);
    expect(argv.args).not.toContain("--add-dir");
  });

  it("builds workspace-write argv without requiring approval support", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", "Usage: codex", execHelp);
    const argv = buildCodexWorkspaceWriteArgv(capabilities, {
      projectPath: "/repo/.agent-harness/worktrees/checkout",
      lastMessagePath: "/memory/runs/run/last-message.md",
    });

    expect(argv.args).toEqual([
      "-c",
      'service_tier="fast"',
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--cd",
      "/repo/.agent-harness/worktrees/checkout",
      "--output-last-message",
      "/memory/runs/run/last-message.md",
      "-",
    ]);
    expect(argv.args).not.toContain("read-only");
    expect(argv.args).not.toContain("--full-auto");
    expect(argv.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.args).not.toContain("--ignore-user-config");
    expect(argv.args).not.toContain("--skip-git-repo-check");
  });

  it("adds optional workspace-write memory directories when supported", () => {
    const capabilities = evaluateCodexCapabilities("codex-cli 1.0", "Usage: codex", execHelp);
    const argv = buildCodexWorkspaceWriteArgv(capabilities, {
      projectPath: "/worktree",
      lastMessagePath: "/memory/runs/run/last-message.md",
      additionalReadDirs: ["/memory"],
    });

    expect(argv.args).toContain("--add-dir");
    expect(argv.args).toContain("/memory");
  });
});

describe("codex prompt and JSONL parsing", () => {
  it("composes a read-only prompt with context and user prompt", () => {
    const prompt = composeCodexPrompt({
      context: "- AC-001: Capture Codex proposal\n- [ ] T-001: Implement adapter",
      userPrompt: "Propose an implementation plan.",
    });

    expect(prompt).toContain("read-only proposal executor");
    expect(prompt).toContain("Do not edit files.");
    expect(prompt).toContain("AC-001");
    expect(prompt).toContain("T-001");
    expect(prompt).toContain("Propose an implementation plan.");
  });

  it("renders file references as bounded Codex runtime context", () => {
    const section = renderTopicFileReferencesForPrompt([
      { relativePath: "src/pricing.ts", name: "pricing.ts", kind: "file", extension: ".ts", size: 123 },
      { relativePath: "docs", name: "docs", kind: "directory", size: 0 },
    ]).join("\n");

    expect(section).toContain("file: src/pricing.ts");
    expect(section).toContain("directory: docs");
    expect(section).toContain("runtime context only");
    expect(section).not.toContain("export const");
  });

  it("requires exactly one prompt input", async () => {
    await expect(readPromptInput({})).rejects.toThrow("requires --prompt or --prompt-file");
    await expect(readPromptInput({ prompt: "x", promptFile: "y" })).rejects.toThrow("either --prompt or --prompt-file");
  });

  it("extracts final messages from common Codex JSONL events", () => {
    const output = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final from item" } }),
      JSON.stringify({ type: "message", content: [{ type: "text", text: "final from message" }] }),
      "not json",
    ].join("\n");

    expect(extractFinalMessageFromCodexJsonl(output)).toBe("final from item\n\nfinal from message");
  });

  it("parses Codex JSONL chunks into UI-friendly streaming events", () => {
    const events: CodexJsonlStreamEvent[] = [];
    const parser = createCodexJsonlStreamParser((event) => events.push(event));
    const first = JSON.stringify({ type: "thread.started" });
    const second = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } });
    const third = JSON.stringify({ type: "item.completed", item: { type: "command_execution", id: "cmd-1", command: "npm test", exit_code: 0, aggregated_output: "ok" } });
    const fourth = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });

    parser.feed(`${first}\n${second.slice(0, 20)}`);
    parser.feed(`${second.slice(20)}\nnot-json\n${third}\n${fourth}`);
    parser.flush();

    expect(events).toEqual(expect.arrayContaining([
      { type: "status", label: "initializing", raw: expect.any(Object) },
      { type: "text_delta", delta: "hello", raw: expect.any(Object) },
      expect.objectContaining({ type: "tool_event", phase: "completed", id: "cmd-1", command: "npm test", output: "ok", isError: false }),
      expect.objectContaining({ type: "readable_event", event: expect.objectContaining({ kind: "command", command: "npm test", preview: "ok" }) }),
      { type: "raw", line: "not-json" },
      { type: "usage", usage: { input_tokens: 1, output_tokens: 2 }, raw: expect.any(Object) },
      { type: "turn_completed", usage: { input_tokens: 1, output_tokens: 2 }, raw: expect.any(Object) },
    ]));
  });

  it("parses readable Codex model events without exposing raw JSONL as transcript", () => {
    const events: CodexJsonlStreamEvent[] = [];
    const parser = createCodexJsonlStreamParser((event) => events.push(event));
    parser.feed([
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", id: "r1", summary: [{ text: "Checked the current workflow state." }], content: "hidden reasoning" } }),
      JSON.stringify({ type: "item.completed", item: { type: "file_change", id: "f1", changes: [{ path: "src/app.ts", kind: "modified", diff: "+ok" }] } }),
      JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", id: "m1", server: "openai", tool: "docs", arguments: { q: "SSE" }, result: "docs found" } }),
      JSON.stringify({ type: "item.completed", item: { type: "web_search", id: "w1", query: "Codex app" } }),
      JSON.stringify({ type: "item.completed", item: { type: "plan_update", id: "p1", text: "1. Inspect\n2. Patch" } }),
      JSON.stringify({ type: "item.completed", item: { type: "tool_result", id: "t1", content: "tool returned" } }),
      JSON.stringify({ type: "item.completed", item: { type: "unknown_payload", value: "raw only" } }),
      "",
    ].join("\n"));

    const readable = events.filter((event): event is Extract<CodexJsonlStreamEvent, { type: "readable_event" }> => event.type === "readable_event");
    expect(readable.map((event) => event.event.kind)).toEqual(expect.arrayContaining([
      "reasoning-summary",
      "file-change",
      "mcp-tool",
      "web-search",
      "plan-update",
      "tool-result",
    ]));
    expect(readable.find((event) => event.event.kind === "reasoning-summary")?.event.preview).toContain("Checked the current workflow state.");
    expect(readable.find((event) => event.event.kind === "reasoning-summary")?.event.preview).not.toContain("hidden reasoning");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "raw" })]));
  });

  it("bounds readable command previews by byte and line limits", () => {
    const longOutput = Array.from({ length: 120 }, (_, index) => `${index}: ${"x".repeat(80)}`).join("\n");
    const preview = truncateReadablePreview(longOutput);

    expect(preview.truncated).toBe(true);
    expect(preview.preview).toContain("[truncated; see raw log]");
    expect(Buffer.byteLength(preview.preview ?? "", "utf8")).toBeLessThanOrEqual(2300);
    expect((preview.preview ?? "").split(/\r?\n/).length).toBeLessThanOrEqual(81);
  });

  it("keeps provider capability snapshot identity stable across checkedAt refreshes", () => {
    const base = {
      providerId: "codex" as const,
      displayName: "Codex",
      productMode: "harness" as const,
      status: "degraded" as const,
      runnable: true,
      checkedAt: "2026-06-29T00:00:00.000Z",
      snapshotVersion: 2,
      effectiveModel: "gpt-5.5",
      effectiveModelSource: "selected" as const,
      degradedReasons: ["model list unavailable"],
      capabilities: [
        {
          key: "model.list" as const,
          label: "模型列表",
          spec: "supported" as const,
          runtime: "degraded" as const,
          summary: "模型列表不可用。",
          reason: "model list unavailable",
        },
      ],
    };

    expect(stableCapabilitySnapshotHash(base)).toBe(stableCapabilitySnapshotHash({
      ...base,
      checkedAt: "2026-06-29T01:00:00.000Z",
    }));
  });

  it("uses one strict product-mode parser and assertion boundary", () => {
    expect(PRODUCT_MODES).toEqual(["agent", "harness"]);
    expect(parseProductMode("agent")).toBe("agent");
    expect(parseProductMode("harness")).toBe("harness");
    expect(parseProductMode("planning")).toBeNull();
    expect(assertProductMode("agent")).toBe("agent");
    expect(() => assertProductMode("planning")).toThrow("productMode must be agent or harness.");
  });

  it("computes Agent readiness only from the Agent operation profile", () => {
    const agentKeys = new Set(PROVIDER_OPERATION_CAPABILITIES.agent);
    const capabilities: ProviderCapabilityItem[] = [
      ...PROVIDER_OPERATION_CAPABILITIES.agent.map((key) => ({
        key,
        label: key,
        spec: "supported" as const,
        runtime: "ready" as const,
        summary: "ready",
      })),
      {
        key: "child.spawn",
        label: "child.spawn",
        spec: "supported",
        runtime: "unavailable",
        summary: "child orchestration unavailable",
      },
      {
        key: "workspace.multiroot",
        label: "workspace.multiroot",
        spec: "supported",
        runtime: "unavailable",
        summary: "multiroot unavailable",
      },
    ];

    const agent = resolveCodexModeReadiness(capabilities, "agent", true, true);
    expect(agent).toMatchObject({ status: "ready", runnable: true, missingCapabilityKeys: [] });
    expect(agent.relevantCapabilities.every((item) => agentKeys.has(item.key))).toBe(true);

    const harness = resolveCodexModeReadiness(capabilities, "harness", true, true);
    expect(harness).toMatchObject({ status: "degraded", runnable: true });

    const withoutSession = resolveCodexModeReadiness(
      capabilities.filter((item) => item.key !== "session.continuation"),
      "agent",
      true,
      true,
    );
    expect(withoutSession).toMatchObject({
      status: "degraded",
      runnable: false,
      missingCapabilityKeys: ["session.continuation"],
    });
  });
});

describe("codex model settings", () => {
  it("reads model from Codex config.toml with a TOML parser", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho-codex-model-"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = temp;
    try {
      await writeFile(join(temp, "config.toml"), "model = \"gpt-5.5\"\n[profiles.dev]\nmodel = \"ignored-profile\"\n", "utf8");

      const status = await readCodexConfigModelStatus();

      expect(status.model).toBe("gpt-5.5");
      expect(status.configExists).toBe(true);
      expect(status.reason).toBeUndefined();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("degrades cleanly when Codex config.toml is invalid", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho-codex-model-"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = temp;
    try {
      await writeFile(join(temp, "config.toml"), "model = [", "utf8");

      const status = await readCodexConfigModelStatus();

      expect(status.model).toBeNull();
      expect(status.configExists).toBe(true);
      expect(status.reason).toContain("Invalid Codex config.toml");
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("reads native Codex collab feature config without requiring AHO-managed dynamic tools", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho-codex-collab-"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = temp;
    try {
      await writeFile(join(temp, "config.toml"), [
        "[features]",
        "multi_agent = true",
        "",
        "[features.multi_agent_v2]",
        "enabled = true",
        "max_concurrent_threads_per_session = 4",
        "",
      ].join("\n"), "utf8");

      const status = await readCodexNativeCollabConfigStatus();

      expect(status.multiAgent).toBe("enabled");
      expect(status.multiAgentV2).toBe("enabled");
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("extracts runtime model candidates from model_list responses", () => {
    const candidates = candidatesFromModelListResponse({
      data: [
        {
          id: "gpt-5.5",
          displayName: "GPT 5.5",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Faster" },
            { reasoningEffort: "high", description: "Deeper" },
          ],
          defaultReasoningEffort: "high",
        },
        { model: "gpt-5.3-codex", display_name: "GPT 5.3 Codex" },
      ],
    });

    expect(candidates.map((candidate) => candidate.model)).toEqual(["gpt-5.5", "gpt-5.3-codex"]);
    expect(candidates[0]).toMatchObject({
      label: "GPT 5.5",
      source: "runtime",
      isDefault: true,
      supportedReasoningEfforts: [
        { value: "low", label: "低", description: "Faster" },
        { value: "high", label: "高", description: "Deeper" },
      ],
      defaultReasoningEffort: "high",
    });
  });

  it("resolves selected model before Codex config model", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho-codex-model-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAhoHome = process.env.AHO_HOME;
    const previousPath = process.env.PATH;
    process.env.CODEX_HOME = join(temp, "codex-home");
    process.env.AHO_HOME = join(temp, "aho-home");
    process.env.PATH = "";
    try {
      await mkdir(process.env.CODEX_HOME, { recursive: true });
      await writeFile(join(process.env.CODEX_HOME, "config.toml"), "model = \"config-model\"\n", "utf8");
      await setSelectedCodexModel("runtime-model");

      const effective = await resolveCodexEffectiveModel();

      expect(effective).toEqual({ model: "runtime-model", source: "selected" });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousAhoHome === undefined) delete process.env.AHO_HOME;
      else process.env.AHO_HOME = previousAhoHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("cleans legacy custom model settings from the visible model snapshot", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aho-codex-model-"));
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAhoHome = process.env.AHO_HOME;
    const previousPath = process.env.PATH;
    process.env.CODEX_HOME = join(temp, "codex-home");
    process.env.AHO_HOME = join(temp, "aho-home");
    process.env.PATH = "";
    try {
      await mkdir(process.env.CODEX_HOME, { recursive: true });
      await mkdir(process.env.AHO_HOME, { recursive: true });
      await writeFile(join(process.env.CODEX_HOME, "config.toml"), "model = \"config-model\"\n", "utf8");
      await writeFile(join(process.env.AHO_HOME, "settings.json"), JSON.stringify({
        version: "1.0",
        codex: {
          selectedModel: "custom-model",
          customModels: [{ id: "custom-model", updatedAt: "2026-06-27T00:00:00.000Z" }],
        },
      }, null, 2), "utf8");

      const snapshot = await getCodexModelSettingsSnapshot(temp);

      expect(snapshot.selectedModel).toBeNull();
      expect(snapshot.customModels).toEqual([]);
      expect(snapshot.candidates.some((candidate) => candidate.source === "config" && candidate.model === "config-model")).toBe(true);
      expect(snapshot.candidates.some((candidate) => candidate.model === "custom-model")).toBe(false);
      expect(snapshot.effectiveModel).toBe("config-model");
      expect(snapshot.effectiveModelSource).toBe("config");
      expect(await readFile(join(process.env.AHO_HOME, "settings.json"), "utf8")).toContain("custom-model");
    } finally {
      await defaultCodexAppServerHostRegistry.dispose(temp, "Codex model settings test completed.");
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousAhoHome === undefined) delete process.env.AHO_HOME;
      else process.env.AHO_HOME = previousAhoHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(temp, { recursive: true, force: true });
    }
  });
});

async function writeCompatibleCodexCmd(path: string, version: string): Promise<void> {
  await writeFile(path, [
    "@echo off",
    `echo codex-cli ${version}`,
    "echo app server --listen stdio:// --json --sandbox --cd --add-dir --color --output-last-message",
  ].join("\r\n"), "utf8");
}
