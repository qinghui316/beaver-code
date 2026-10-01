import { describe, expect, it } from "vitest";
import {
  CodexCollaborationNormalizer,
  extractCodexCollaborationToolCall,
  extractCodexSubAgentActivity,
  roleHintFromAgentPath,
} from "../../src/codex/collaboration-normalizer.js";

describe("Codex collaboration normalizer", () => {
  it("parses only the current camelCase collaboration protocol", () => {
    expect(extractCodexCollaborationToolCall("item/started", {
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-main",
        receiverThreadIds: ["thread-planning"],
        prompt: "Plan this change.",
      },
    })).toEqual({
      itemId: "spawn-1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "thread-main",
      receiverThreadIds: ["thread-planning"],
      prompt: "Plan this change.",
    });
    expect(extractCodexCollaborationToolCall("item/started", {
      item: {
        type: "collabAgentToolCall",
        id: "legacy",
        tool: ["spawn", "agent"].join("_"),
        status: "inProgress",
        sender_thread_id: "thread-main",
        receiver_thread_ids: ["thread-planning"],
      },
    })).toBeNull();
  });

  it("correlates a delayed role hint with the original spawn activity", () => {
    const normalizer = new CodexCollaborationNormalizer();
    const initial = normalizer.normalize("item/started", {
      threadId: "thread-main",
      turnId: "turn-main-1",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-main",
        receiverThreadIds: ["thread-planning"],
      },
    });
    expect(initial.lifecycleEvents).toEqual([{
      kind: "started",
      activityId: "spawn-1",
      parentThreadId: "thread-main",
      childThreadId: "thread-planning",
      turnId: "turn-main-1",
    }]);

    const enriched = normalizer.normalize("item/completed", {
      threadId: "thread-main",
      turnId: "turn-main-1",
      item: {
        type: "subAgentActivity",
        id: "activity-1",
        kind: "started",
        agentThreadId: "thread-planning",
        agentPath: "/root/planning_agent",
      },
    });
    expect(enriched.lifecycleEvents).toEqual([{
      kind: "started",
      activityId: "spawn-1",
      parentThreadId: "thread-main",
      childThreadId: "thread-planning",
      turnId: "turn-main-1",
      roleHint: "planning-agent",
    }]);
    expect(normalizer.normalize("item/completed", {
      threadId: "thread-main",
      turnId: "turn-main-1",
      item: {
        type: "subAgentActivity",
        id: "activity-1",
        kind: "started",
        agentThreadId: "thread-planning",
        agentPath: "/root/planning_agent",
      },
    }).lifecycleEvents).toEqual([]);
  });

  it("normalizes send, resume, and successful close without treating failures as closure", () => {
    const normalizer = new CodexCollaborationNormalizer();
    const eventFor = (id: string, tool: "sendInput" | "resumeAgent" | "closeAgent", status: "inProgress" | "completed" | "failed") =>
      normalizer.normalize("item/completed", {
        threadId: "thread-main",
        turnId: "turn-main-2",
        item: {
          type: "collabAgentToolCall",
          id,
          tool,
          status,
          senderThreadId: "thread-main",
          receiverThreadIds: ["thread-planning"],
        },
      }).lifecycleEvents;

    expect(eventFor("send-1", "sendInput", "inProgress")[0]?.kind).toBe("continued");
    expect(eventFor("resume-1", "resumeAgent", "completed")[0]?.kind).toBe("continued");
    expect(eventFor("close-failed", "closeAgent", "failed")).toEqual([]);
    expect(eventFor("close-1", "closeAgent", "completed")).toEqual([expect.objectContaining({
      kind: "closed",
      activityId: "close-1",
      parentThreadId: "thread-main",
      childThreadId: "thread-planning",
    })]);
  });

  it("preserves terminal activity without minting a new child lifecycle identity", () => {
    const params = { threadId: "thread-main", turnId: "turn-main-1", item: {
      type: "subAgentActivity", id: "activity-completed", kind: "completed",
      agentThreadId: "thread-planning", agentPath: "/root/planning_agent",
    } };
    const result = new CodexCollaborationNormalizer().normalize("item/completed", params);
    expect(result.subAgentActivity).toMatchObject({ kind: "completed", threadId: "thread-planning" });
    expect(result.lifecycleEvents).toEqual([]);
  });

  it("keeps interrupted sub-agent activity diagnostic-only", () => {
    const params = {
      item: {
        type: "subAgentActivity",
        id: "activity-interrupted",
        kind: "interrupted",
        agentThreadId: "thread-planning",
        agentPath: "/root/planning_agent",
      },
    };
    expect(extractCodexSubAgentActivity("item/completed", params)).toMatchObject({ kind: "interrupted" });
    expect(new CodexCollaborationNormalizer().normalize("item/completed", params).lifecycleEvents).toEqual([]);
    expect(roleHintFromAgentPath("/root/planning_agent")).toBe("planning-agent");
    expect(roleHintFromAgentPath("/root/Planning Agent")).toBeUndefined();
  });
});
