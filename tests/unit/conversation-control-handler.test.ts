import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedProject } from "../../src/types/index.js";

const mocks = vi.hoisted(() => ({
  append: vi.fn(async () => undefined),
  upsert: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../src/workbench/canonical-timeline-command.js", () => ({
  appendCanonicalTimelineEntry: mocks.append,
  openCanonicalTimelineWriter: vi.fn(async () => ({ upsert: mocks.upsert, close: mocks.close })),
}));

import { interruptConversation, steerConversation } from "../../src/workbench/actions/handlers/control.js";

describe("conversation interrupt handler", () => {
  beforeEach(() => {
    mocks.append.mockClear();
    mocks.upsert.mockClear();
    mocks.close.mockClear();
  });

  it("delegates accepted steering persistence to the delivery owner", async () => {
    const order: string[] = [];
    const steerProviderTurn = vi.fn(async () => {
      order.push("provider-accepted");
      return { status: "steer-accepted" as const, attemptId: "attempt-provider", runId: "run-provider" };
    });
    mocks.upsert.mockImplementation(() => { order.push("timeline-upsert"); });
    const findRunningRunForChange = vi.fn(async () => {
      throw new Error("local fallback must not run");
    });

    await expect(steerConversation(
      project(),
      "change-1",
      "conversation-1",
      "  add one constraint  ",
      "request-1",
      undefined,
      { steerProviderTurn, findRunningRunForChange },
    )).resolves.toMatchObject({ status: "steered", realtime: true, runId: "run-provider" });

    expect(order).toEqual(["provider-accepted"]);
    expect(steerProviderTurn).toHaveBeenCalledWith(project(), "conversation-1", "request-1", "add one constraint");
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("passes request identity to the owner without writing a second steering path", async () => {
    const attempts = ["attempt-first", "attempt-second"];
    const steerProviderTurn = vi.fn(async () => ({
      status: "steer-accepted" as const,
      attemptId: attempts.shift()!,
      runId: "run-provider",
    }));
    const deps = { steerProviderTurn, findRunningRunForChange: vi.fn() };

    await steerConversation(project(), "change-1", "conversation-1", "first", "reused-request", undefined, deps);
    await steerConversation(project(), "change-1", "conversation-1", "second", "reused-request", undefined, deps);

    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(steerProviderTurn).toHaveBeenNthCalledWith(1, project(), "conversation-1", "reused-request", "first");
    expect(steerProviderTurn).toHaveBeenNthCalledWith(2, project(), "conversation-1", "reused-request", "second");
  });

  it("rejects Harness steering without an owned Provider Turn and writes no pending feedback", async () => {
    const steerProviderTurn = vi.fn(async () => null);
    const findRunningRunForChange = vi.fn(async () => ({ id: "run-local" } as never));

    await expect(steerConversation(
      project(),
      "change-1",
      "conversation-1",
      "next round",
      "request-2",
      undefined,
      { steerProviderTurn, findRunningRunForChange },
    )).rejects.toMatchObject({ name: "Conflict" });

    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(findRunningRunForChange).not.toHaveBeenCalled();
  });

  it("uses the shared Provider Turn owner before considering the local-run fallback", async () => {
    const interruptProviderTurn = vi.fn(async () => ({
      status: "interrupt-requested" as const,
      attemptId: "attempt-provider",
      runId: "run-provider",
    }));
    const findRunningRunForChange = vi.fn(async () => {
      throw new Error("local fallback must not run");
    });

    await expect(interruptConversation(
      project(),
      "change-1",
      "conversation-1",
      undefined,
      undefined,
      { interruptProviderTurn, findRunningRunForChange },
    )).resolves.toMatchObject({
      status: "interrupt-requested",
      realtime: true,
      runId: "run-provider",
      roleId: "main-agent",
    });

    expect(interruptProviderTurn).toHaveBeenCalledOnce();
    expect(findRunningRunForChange).not.toHaveBeenCalled();
    expect(mocks.append).toHaveBeenCalledWith(
      project(),
      "change-1",
      expect.objectContaining({ status: "interrupt-requested", runId: "run-provider" }),
      undefined,
    );
  });

  it("uses the existing local-run stop only when no active Provider Turn is owned", async () => {
    const interruptProviderTurn = vi.fn(async () => null);
    const findRunningRunForChange = vi.fn(async () => null);

    await expect(interruptConversation(
      project(),
      "change-1",
      "conversation-1",
      undefined,
      undefined,
      { interruptProviderTurn, findRunningRunForChange },
    )).resolves.toMatchObject({ status: "already-completed" });

    expect(interruptProviderTurn).toHaveBeenCalledOnce();
    expect(findRunningRunForChange).toHaveBeenCalledOnce();
  });

  it("uses the local-run fallback when the Provider Turn becomes terminal during Stop", async () => {
    const interruptProviderTurn = vi.fn(async () => ({
      status: "already-terminal" as const,
      attemptId: "attempt-terminal",
    }));
    const findRunningRunForChange = vi.fn(async () => null);

    await expect(interruptConversation(
      project(),
      "change-1",
      "conversation-1",
      undefined,
      undefined,
      { interruptProviderTurn, findRunningRunForChange },
    )).resolves.toMatchObject({ status: "already-completed" });

    expect(interruptProviderTurn).toHaveBeenCalledOnce();
    expect(findRunningRunForChange).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledWith(
      project(),
      "change-1",
      expect.objectContaining({ status: "stop-not-needed" }),
      undefined,
    );
    expect(mocks.append).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ status: "interrupt-requested" }),
      expect.anything(),
    );
  });
});

function project(): ManagedProject {
  return { id: "project-1", name: "Project", path: "E:\\project" } as ManagedProject;
}
