import { describe, expect, it, vi } from "vitest";
import * as repository from "../../src/agent-task/repository.js";
import { withForegroundRoleTaskLease } from "../../src/agent-task/role-dispatcher.js";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkpointAgentTask,
  claimAgentTask,
  completeAgentTask,
  createAgentTask,
  failAgentTask,
  heartbeatAgentTask,
  listAgentTasks,
  readAgentTaskResult,
  recoverExpiredAgentTasks,
} from "../../src/agent-task/manager.js";
import { resolveFixtureRuntime } from "./workbench/fixtures.js";

async function setup() {
  const memory = await resolveFixtureRuntime();
  const task = await createAgentTask(memory, {
    conversationId: "durable-lifecycle",
    changeId: "durable-lifecycle",
    roleId: "harness-evolution-agent",
    kind: "background",
    summary: "Run durable evolution analysis",
    idempotencyKey: "evolution:42",
    maxAttempts: 2,
  });
  return { memory, task };
}

describe("durable AgentTask lifecycle", () => {
  async function foreground() {
    const memory = await resolveFixtureRuntime();
    const task = await createAgentTask(memory, {
      conversationId: "foreground-lease", changeId: "foreground-lease", roleId: "coder-agent",
      kind: "foreground", summary: "Long foreground execution",
    });
    const claimed = await claimAgentTask(memory, task, { owner: "foreground-worker", leaseDurationMs: 4_000 });
    return { memory, task: await repository.startAgentTask(memory, claimed) };
  }

  it("renews a foreground writer beyond its original expiry and drains before committing", async () => {
    const { memory, task } = await foreground();
    const heartbeat = vi.spyOn(repository, "heartbeatAgentTask");
    try {
      const result = await withForegroundRoleTaskLease(memory, task, async (settle) => {
        await new Promise((resolve) => setTimeout(resolve, 9_000));
        const current = (await listAgentTasks(memory, task.changeId))[0];
        expect(current.lease).toMatchObject({ claimToken: task.lease!.claimToken, fencingToken: task.lease!.fencingToken });
        expect(Date.parse(current.lease!.expiresAt)).toBeGreaterThan(Date.now());
        return settle({ status: "completed", summary: "Long execution completed" });
      });
      expect(result.status).toBe("completed");
      expect(heartbeat.mock.calls.length).toBeGreaterThan(2);
      const count = heartbeat.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(heartbeat).toHaveBeenCalledTimes(count);
      expect((await listAgentTasks(memory, task.changeId))[0]).toMatchObject({ status: "completed", lease: null });
    } finally { heartbeat.mockRestore(); }
  }, 20_000);

  it("stops foreground renewal on an unexpected execution error", async () => {
    const { memory, task } = await foreground();
    const heartbeat = vi.spyOn(repository, "heartbeatAgentTask");
    try {
      await expect(withForegroundRoleTaskLease(memory, task, async () => { throw new Error("execution failed"); }))
        .rejects.toThrow("execution failed");
      const count = heartbeat.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(heartbeat).toHaveBeenCalledTimes(count);
      expect(await readAgentTaskResult(memory, task.id)).toBeNull();
    } finally { heartbeat.mockRestore(); }
  });

  it("does not reclaim or publish after the captured foreground writer is fenced", async () => {
    const { memory, task } = await foreground();
    let replacement: typeof task | undefined;
    await expect(withForegroundRoleTaskLease(memory, task, async (settle) => {
      await recoverExpiredAgentTasks(memory, new Date(Date.now() + 60_000).toISOString());
      const queued = (await listAgentTasks(memory, task.changeId))[0];
      replacement = await claimAgentTask(memory, queued, { owner: "replacement-worker", leaseDurationMs: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return settle({ status: "completed", summary: "Stale output" });
    })).rejects.toThrow(/stale writer rejected/);
    expect((await listAgentTasks(memory, task.changeId))[0]).toMatchObject({ status: "claimed", lease: replacement!.lease });
    expect(await readAgentTaskResult(memory, task.id)).toBeNull();
  });

  it("deduplicates concurrent creates and excludes concurrent claimers", async () => {
    const { memory, task } = await setup();
    const duplicate = await createAgentTask(memory, {
      conversationId: "other",
      changeId: "other",
      roleId: "harness-evolution-agent",
      kind: "background",
      summary: "Duplicate",
      idempotencyKey: "evolution:42",
    });
    expect(duplicate.id).toBe(task.id);

    const claims = await Promise.allSettled([
      claimAgentTask(memory, task, { owner: "worker-a", leaseDurationMs: 60_000 }),
      claimAgentTask(memory, task, { owner: "worker-b", leaseDurationMs: 60_000 }),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
  });

  it("fences stale writers while allowing heartbeat and checkpoints", async () => {
    const { memory, task } = await setup();
    const claimed = await claimAgentTask(memory, task, { owner: "worker-a", leaseDurationMs: 60_000 });
    const writer = { claimToken: claimed.lease!.claimToken, fencingToken: claimed.lease!.fencingToken };
    const heartbeat = await heartbeatAgentTask(memory, claimed, writer, 120_000);
    const checkpoint = await checkpointAgentTask(memory, heartbeat, writer, { summary: "provider finished", artifactRefs: ["run/provider.json"] });
    expect(checkpoint.checkpoint).toMatchObject({ sequence: 1, artifactRefs: ["run/provider.json"] });
    await expect(checkpointAgentTask(memory, checkpoint, { ...writer, fencingToken: writer.fencingToken + 1 }, { summary: "stale", artifactRefs: [] }))
      .rejects.toThrow(/stale writer rejected/);
  });

  it("recovers expired leases with increasing fencing and bounded attempts", async () => {
    const { memory, task } = await setup();
    const first = await claimAgentTask(memory, task, { owner: "worker-a", leaseDurationMs: 1, now: "2026-01-01T00:00:00.000Z" });
    await recoverExpiredAgentTasks(memory, "2026-01-01T00:00:01.000Z");
    const queued = (await listAgentTasks(memory, task.changeId))[0];
    expect(queued).toMatchObject({ status: "queued", attempt: 1, failureDisposition: "retryable" });
    const second = await claimAgentTask(memory, queued, { owner: "worker-b", leaseDurationMs: 1, now: "2026-01-01T00:00:02.000Z" });
    expect(second.lease!.fencingToken).toBeGreaterThan(first.lease!.fencingToken);
    await recoverExpiredAgentTasks(memory, "2026-01-01T00:00:03.000Z");
    await expect(readAgentTaskResult(memory, task.id)).resolves.toMatchObject({ status: "failed", failureDisposition: "terminal", attempt: 2 });
  });

  it("retries retryable failures and writes terminal result idempotently", async () => {
    const { memory, task } = await setup();
    const claimed = await claimAgentTask(memory, task, { owner: "worker-a", leaseDurationMs: 60_000 });
    const writer = { claimToken: claimed.lease!.claimToken, fencingToken: claimed.lease!.fencingToken };
    const retry = await failAgentTask(memory, claimed, { retryable: true, writer, summary: "transient provider failure" });
    expect(retry).toMatchObject({ status: "queued", failureDisposition: "retryable" });
    const reclaimed = await claimAgentTask(memory, retry as typeof task, { owner: "worker-b", leaseDurationMs: 60_000 });
    const result = await completeAgentTask(memory, reclaimed, { status: "completed", summary: "done", artifactRefs: ["run/result.json"] });
    const repeated = await completeAgentTask(memory, reclaimed, { status: "completed", summary: "ignored" });
    expect(repeated).toEqual(result);
    await expect(listAgentTasks(memory, task.changeId)).resolves.toMatchObject([expect.objectContaining({ status: "completed", lease: null })]);
  });

  it("treats a terminal result as the commit point after a crash before task convergence", async () => {
    const { memory, task } = await setup();
    const claimed = await claimAgentTask(memory, task, { owner: "worker-a", leaseDurationMs: 60_000 });
    await completeAgentTask(memory, claimed, { status: "completed", summary: "committed", artifactRefs: ["run/result.json"] });
    const taskPath = join(memory.workbenchRoot, "agent-tasks", "tasks", task.id, "task.json");
    const stale = { ...claimed, status: "running", finishedAt: null };
    await writeFile(taskPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
    await writeFile(join(dirname(taskPath), "claim.json"), `${JSON.stringify(claimed.lease, null, 2)}\n`, "utf8");

    await expect(claimAgentTask(memory, stale, { owner: "worker-b" })).rejects.toThrow(/terminal result/);
    expect(JSON.parse(await readFile(taskPath, "utf8"))).toMatchObject({ status: "completed", lease: null, summary: "committed" });
  });
});
