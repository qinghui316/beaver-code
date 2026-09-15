import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintUiLanguage } from "../../scripts/lint-ui-language.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("UI language lint", () => {
  it("rejects internal visible copy and raw identifiers", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export const Panel = ({ item, taskId }) => <><button aria-label="Open Workpad">SchedulerRun</button><span>{item.taskRunId}</span><span>{taskId}</span><span>{"Plan mode"}</span></>;`,
    });
    const result = await lintUiLanguage(root);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("Workpad"),
      expect.stringContaining("SchedulerRun"),
      expect.stringContaining("taskRunId"),
      expect.stringContaining("taskId"),
      expect.stringContaining("Plan mode"),
    ]));
  });

  it("rejects nested visible expressions and same-scope raw identifier aliases", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export function Panel({ item, ok, value }) {
        const id = item.taskId;
        const forwardedId = id;
        return <>
          <span>{\`Workpad \${value}\`}</span>
          <span>{ok ? "TaskQueue" : "完成"}</span>
          <span>{forwardedId}</span>
          <button aria-label={ok ? \`Open SchedulerRun \${value}\` : item.runId}>打开</button>
        </>;
      }`,
    });
    const violations = (await lintUiLanguage(root)).violations.join("\n");
    for (const term of ["Workpad", "TaskQueue", "forwardedId", "SchedulerRun", "runId"]) {
      expect(violations).toContain(term);
    }
  });

  it("checks user-copy presenter modules and the complete forbidden vocabulary", async () => {
    const root = await fixture({
      "src/web/src/action-labels.ts": `export function label() { return "Topic Change TaskRun WorkerLease blocked audit-blocked queue blocked Approval Inbox Adapter Snapshot Capability revision SSE CAS Provider Session Skills Default Plan Review Queue Fork Harness"; }`,
    });
    const violations = (await lintUiLanguage(root)).violations.join("\n").toLowerCase();
    for (const term of ["Topic", "Change", "TaskRun", "WorkerLease", "blocked", "Approval Inbox", "Adapter", "Snapshot", "Capability", "revision", "SSE", "CAS", "Provider", "Session", "Skills", "Default", "Plan", "Review", "Queue", "Fork", "Harness"]) {
      expect(violations).toContain(term.toLowerCase());
    }
  });

  it("rejects direct raw errors and unregistered enum fallbacks", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export function Panel({ cause, response }) {
        const setError = () => undefined;
        setError(cause.message);
        setError(response.text());
        return <div>完成</div>;
      }`,
      "src/web/src/formatters.ts": `export function label(status) { return status; }`,
    });
    const violations = (await lintUiLanguage(root)).violations.join("\n");
    expect(violations).toContain("raw error or response body");
    expect(violations).toContain("unregistered raw enum value");
  });

  it("rejects direct raw error and state values in ordinary JSX", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export function Panel({ error, status }) { return <><p>{error}</p><span>{status}</span></>; }`,
    });
    const violations = (await lintUiLanguage(root)).violations.join("\n");
    expect(violations).toContain("raw error or response body");
    expect(violations).toContain("raw state status");
  });

  it("allows explicitly projected display strings and mapped local status copy", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export function Panel({ error }: { error: string | null }) { const status = true ? "已完成" : "需要处理"; return <>{error ? <p>{error}</p> : null}<span>{status}</span></>; }`,
    });
    expect((await lintUiLanguage(root)).violations).toEqual([]);
  });

  it("checks configured copy and raw fallback branches", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export function Panel({ state, cause }) {
        const labels = { ready: "完成" };
        const actions = [{ label: "Open Provider Snapshot" }];
        return <><span>{labels[state] ?? state}</span><button title={cause.message}>{actions[0].label}</button></>;
      }`,
    });
    const violations = (await lintUiLanguage(root)).violations.join("\n");
    expect(violations).toContain("Provider");
    expect(violations).toContain("Snapshot");
    expect(violations).toContain("raw state state");
    expect(violations).toContain("raw error or response body");
  });

  it("allows raw terms only inside an explicit Diagnostics evidence subtree", async () => {
    const root = await fixture({
      "src/web/src/panels/workbench/RuntimeDiagnosticsDock.tsx": `export const Diagnostics = ({ raw }) => <><header>Workpad</header><div data-diagnostic-raw-evidence>SchedulerRun {raw.taskRunId}</div></>;`,
      "src/web/src/Panel.tsx": `export const Panel = ({ message }) => <><code>SchedulerRun claim</code><p>{message}</p></>;`,
    });
    const result = await lintUiLanguage(root);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("Workpad");
  });

  it("preserves approved developer terminology and dynamic source-authored content", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export const Panel = ({ source }) => <>
        <p>在 Terminal 查看 Git Diff，与 Branch 比较 Commit，并创建 PR。Context 已使用 68% Token。</p>
        <h1>Agent Harness Orchestrator</h1>
        <section data-source-authored-content>{source}</section>
      </>;`,
    });
    expect((await lintUiLanguage(root)).violations).toEqual([]);
  });

  it("does not let a source-content marker exempt static product copy", async () => {
    const root = await fixture({
      "src/web/src/Panel.tsx": `export const Panel = ({ source }) => <section data-source-authored-content>{source}<span>Provider Snapshot</span></section>;`,
    });
    const violations = (await lintUiLanguage(root)).violations.join("\n");
    expect(violations).toContain("Provider");
    expect(violations).toContain("Snapshot");
  });
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aho-ui-language-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}
