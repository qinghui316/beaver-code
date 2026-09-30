import { describe, expect, it } from "vitest";
import { createAssistantTranscriptCapture } from "../../src/workbench/live-transcript.js";
import { applyFinalCaptureFallback, buildCanonicalCaptureWrites } from "../../src/workbench/provider-capture-persistence.js";
import { projectCanonicalTimelineEnvelope } from "../../src/workbench/canonical-timeline-projector.js";
import type { StoredTopicMessage } from "../../src/workbench/persistence/contracts.js";

const identity = { projectId: "project", productMode: "agent" as const, conversationId: "conversation", graphScopeId: "graph",
  providerId: "codex", attemptId: "attempt", runId: "run", threadId: "thread", turnId: "turn", itemId: "same-item" };
function started(capture: ReturnType<typeof createAssistantTranscriptCapture>) {
  capture.sink.emit({ event: "run.status", data: { ...identity, status: "thinking", label: "正在思考" } });
}
function delta(capture: ReturnType<typeof createAssistantTranscriptCapture>, text: string) {
  capture.sink.emit({ event: "assistant.delta", data: { ...identity, delta: text } });
}
function writes(capture: ReturnType<typeof createAssistantTranscriptCapture>) {
  return buildCanonicalCaptureWrites({ projectId: identity.projectId, conversationId: identity.conversationId, graphScopeId: identity.graphScopeId,
    runId: identity.runId, providerId: identity.providerId, attemptId: identity.attemptId, mainTimelineId: "fallback", mainSessionId: "thread", snapshot: capture });
}
function rows(capture: ReturnType<typeof createAssistantTranscriptCapture>): StoredTopicMessage[] {
  return writes(capture).map((write, i) => ({ ...write, position: i + 1, revision: i + 1, status: "completed",
    rawJson: JSON.stringify({ ...JSON.parse(write.rawJson), completedTurnSequence: 1 }) } as StoredTopicMessage));
}

describe("accepted input reading boundaries", () => {
  it("splits one Provider item across multiple inputs and keeps the semantic aggregate intact", () => {
    const capture = createAssistantTranscriptCapture(undefined);
    started(capture); delta(capture, "before"); capture.acceptInput("guide-1", "user-1");
    delta(capture, "middle"); capture.acceptInput("guide-2", "user-2"); delta(capture, "after");
    capture.acceptInput("guide-2", "user-2");
    const records = writes(capture);
    expect(records).toHaveLength(3);
    expect(records[0]!.text).toBe("beforemiddleafter");
    expect(records.slice(1).every((record) => record.type === "assistant.transcript-segment")).toBe(true);
    expect(records.map((record) => JSON.parse(record.rawJson).transcriptReading.text)).toEqual(["before", "middle", "after"]);
    expect(records.map((record) => JSON.parse(record.rawJson).transcriptReading.final)).toEqual([false, false, true]);
    const cells = rows(capture).flatMap((row) => projectCanonicalTimelineEnvelope(row, "agent").cells);
    expect(cells.filter((cell) => cell.kind === "assistant-message").map((cell) => cell.text)).toEqual(["before", "middle", "after"]);
    expect(new Set(cells.map((cell) => cell.id)).size).toBe(cells.length);
  });

  it("updates a tool started before a boundary in its original segment", () => {
    const capture = createAssistantTranscriptCapture(undefined); started(capture); delta(capture, "before");
    const main = [...capture.mainCaptures.values()][0]!;
    main.blocks.push({ ...identity, id: "tool", kind: "tool-call", sequence: 2, source: "provider", title: "shell", text: "pwd", status: "running" });
    capture.acceptInput("guide", "user");
    main.blocks.find((block) => block.id === "tool")!.status = "completed";
    main.blocks.find((block) => block.id === "tool")!.text = "done";
    delta(capture, "after");
    const readings = writes(capture).map((write) => JSON.parse(write.rawJson).transcriptReading);
    expect(readings[0].blocks.find((block: { id: string }) => block.id === "tool")).toMatchObject({ status: "completed", text: "done" });
    expect(readings[1].blocks.some((block: { id: string }) => block.id === "tool")).toBe(false);
  });

  it("puts a final-only reply in the last reading segment without copying a streamed aggregate", () => {
    const capture = createAssistantTranscriptCapture(undefined); started(capture); capture.acceptInput("guide", "user");
    applyFinalCaptureFallback(capture, "final only"); applyFinalCaptureFallback(capture, "duplicate");
    const records = writes(capture);
    expect(records[0]!.text).toBe("final only");
    expect(records.map((row) => JSON.parse(row.rawJson).transcriptReading.text)).toEqual(["", "final only"]);
    expect(records[1]!.text).toBe("final only");
  });

  it("shows one completion summary and keeps fork/retry references on the aggregate", () => {
    const capture = createAssistantTranscriptCapture(undefined); started(capture); delta(capture, "before"); capture.acceptInput("guide", "user"); delta(capture, "after");
    capture.sink.emit({ event: "run.status", data: { ...identity, status: "completed", label: "已完成" } });
    const records = rows(capture);
    const projected = records.map((row) => projectCanonicalTimelineEnvelope(row, "agent", (id) => records.find((candidate) => candidate.id === id) ?? null));
    expect(projected[0]!.cells.some((cell) => cell.activityKind === "turn")).toBe(false);
    const summary = projected[1]!.cells.filter((cell) => cell.activityKind === "turn");
    expect(summary).toHaveLength(1);
    expect(summary[0]!.forkTarget?.sourceMessageId).toBe(records[0]!.id);
  });

  it("reserves a new reading segment in the same persistence callback as acceptance", () => {
    const persisted: string[][] = [];
    const capture = createAssistantTranscriptCapture(undefined, (current) => { persisted.push(writes(current).map((row) => row.id)); return true; });
    started(capture); delta(capture, "before");
    const original = writes(capture)[0]!.id;
    capture.acceptInput("guide", "user");
    expect(persisted.at(-1)).toEqual([original, `${original}:segment:guide`]);
  });
});
