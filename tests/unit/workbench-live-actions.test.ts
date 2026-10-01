import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

const mocks = vi.hoisted(() => ({
  runWorkbenchWorkflowAction: vi.fn(),
  getWorkbenchSnapshot: vi.fn(),
  assertCurrentWorkflowAction: vi.fn(),
}));

vi.mock("../../src/workbench/workflow-conversation-bridge.js", () => ({
  runWorkbenchWorkflowAction: mocks.runWorkbenchWorkflowAction,
}));

vi.mock("../../src/workbench/projections/read-model/implementation.js", () => ({
  getWorkbenchSnapshot: mocks.getWorkbenchSnapshot,
}));

vi.mock("../../src/server/workbench/action-revalidation.js", () => ({
  assertCurrentWorkflowAction: mocks.assertCurrentWorkflowAction,
}));

import { sendWorkbenchActionLive } from "../../src/server/workbench/live-actions.js";

class FakeSseResponse {
  destroyed = false;
  writableEnded = false;
  chunks: string[] = [];
  headers: unknown[] = [];
  private listeners = new Map<string, Array<() => void>>();

  writeHead(statusCode: number, headers: Record<string, string>): void {
    this.headers.push({ statusCode, headers });
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.writableEnded = true;
    for (const listener of this.listeners.get("finish") ?? []) listener();
  }

  on(event: string, listener: () => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
}

function jsonRequest(body: unknown): Readable {
  return Readable.from([JSON.stringify(body)]);
}

describe("Workbench live actions", () => {
  beforeEach(() => {
    mocks.runWorkbenchWorkflowAction.mockReset();
    mocks.getWorkbenchSnapshot.mockReset();
    mocks.assertCurrentWorkflowAction.mockReset();
    mocks.runWorkbenchWorkflowAction.mockResolvedValue({ status: "completed" });
    mocks.getWorkbenchSnapshot.mockResolvedValue({ ok: true });
  });

  it("rejects removed planning confirmation actions on the live workflow endpoint", async () => {
    const response = new FakeSseResponse();

    await sendWorkbenchActionLive({
      path: "project-root",
      project: {
        id: "repo",
        name: "Repo",
        path: "project-root",
        addedAt: "2026-06-25T00:00:00.000Z",
        lastSeenAt: "2026-06-25T00:00:00.000Z",
      },
    }, jsonRequest({
      actionType: "planning.confirm-execution",
      changeId: "change-1",
      planningBundleId: "planning-bundle-1",
      confirm: true,
      postPlanAutomationMode: "scoped-auto",
    }) as never, response as unknown as ServerResponse);

    expect(mocks.assertCurrentWorkflowAction).not.toHaveBeenCalled();
    expect(mocks.runWorkbenchWorkflowAction).not.toHaveBeenCalled();
    expect(response.chunks.join("\n")).toContain("Action planning.confirm-execution is not supported by the live endpoint.");
  });

  it("preserves the exact graph identity after current-action validation", async () => {
    const input = { path: "project-root", project: {
      id: "repo", name: "Repo", path: "project-root",
      addedAt: "2026-06-25T00:00:00.000Z", lastSeenAt: "2026-06-25T00:00:00.000Z",
    } };
    const body = { actionType: "workflow.run.start", changeId: "change-1",
      graphScopeId: "graph-scope-1", workflowGraphPlanId: "authored-graph-1", confirm: true };
    const response = new FakeSseResponse();
    await sendWorkbenchActionLive(input, jsonRequest(body) as never, response as unknown as ServerResponse, {} as never);
    expect(mocks.assertCurrentWorkflowAction).toHaveBeenCalledWith(input, body, expect.anything());
    expect(mocks.runWorkbenchWorkflowAction).toHaveBeenCalledWith(input.project,
      expect.objectContaining({ actionType: body.actionType, changeId: body.changeId,
        graphScopeId: body.graphScopeId, workflowGraphPlanId: body.workflowGraphPlanId }), expect.anything(), expect.anything());
    expect(mocks.assertCurrentWorkflowAction.mock.invocationCallOrder[0]).toBeLessThan(mocks.runWorkbenchWorkflowAction.mock.invocationCallOrder[0]);

    mocks.runWorkbenchWorkflowAction.mockClear();
    mocks.assertCurrentWorkflowAction.mockRejectedValueOnce(new Error("Current graph identity changed."));
    const rejected = new FakeSseResponse();
    await sendWorkbenchActionLive(input, jsonRequest(body) as never, rejected as unknown as ServerResponse, {} as never);
    expect(mocks.runWorkbenchWorkflowAction).not.toHaveBeenCalled();
    expect(rejected.chunks.join("\n")).toContain("Current graph identity changed.");
  });
});
