import { describe, expect, it } from "vitest";
import { calculateTranscriptVirtualRange } from "../../src/web/src/panels/workbench/TranscriptVirtualList.js";
import {
  estimateTranscriptCellHeight,
  isLongTranscriptCell,
  transcriptCellDisplayText,
} from "../../src/web/src/panels/workbench/transcriptMeasurement.js";
import type { ParentAgentTranscriptCell } from "../../src/web/src/types.js";

describe("transcript virtual list pressure guards", () => {
  it("keeps a 50k row transcript range bounded to visible rows plus overscan", () => {
    const heights = Array.from({ length: 50_000 }, (_, index) => index % 7 === 0 ? 144 : 84);

    const range = calculateTranscriptVirtualRange({
      heights,
      scrollTop: 1_250_000,
      viewportHeight: 760,
      overscan: 10,
    });

    expect(range.totalHeight).toBeGreaterThan(4_000_000);
    expect(range.start).toBeGreaterThan(0);
    expect(range.end).toBeLessThanOrEqual(50_000);
    expect(range.end - range.start).toBeLessThanOrEqual(32);
    expect(range.topSpacer).toBeGreaterThan(0);
    expect(range.bottomSpacer).toBeGreaterThan(0);
  });

  it("folds long transcript cells and keeps fallback height estimation finite", () => {
    const hiddenSentinel = "SYNTHETIC_LONG_MESSAGE_END";
    const cell: ParentAgentTranscriptCell = {
      id: "cell:assistant:long",
      kind: "assistant-message",
      source: "provider-runtime",
      text: `Visible preview\n${"long output line\n".repeat(160)}${hiddenSentinel}`,
    };

    expect(isLongTranscriptCell(cell)).toBe(true);
    const foldedText = transcriptCellDisplayText(cell, false);
    expect(foldedText).toContain("Visible preview");
    expect(foldedText).not.toContain(hiddenSentinel);
    expect(foldedText.length).toBeLessThan(cell.text.length);

    const foldedHeight = estimateTranscriptCellHeight(cell, { expanded: false, width: 720 });
    const expandedHeight = estimateTranscriptCellHeight(cell, { expanded: true, width: 720 });
    expect(Number.isFinite(foldedHeight)).toBe(true);
    expect(Number.isFinite(expandedHeight)).toBe(true);
    expect(expandedHeight).toBeGreaterThan(foldedHeight);
  });

  it("reserves the hidden timestamp slot for message estimates", () => {
    const message: ParentAgentTranscriptCell = {
      id: "cell:assistant:timestamp",
      kind: "assistant-message",
      source: "provider-runtime",
      text: "short response",
      timestamp: "2026-08-20T06:31:00.000Z",
    };
    const activity: ParentAgentTranscriptCell = {
      id: "cell:process:timestamp",
      kind: "process-row",
      source: "provider-runtime",
      activityKind: "turn",
      title: "执行完成",
      text: "",
      status: "completed",
    };

    expect(estimateTranscriptCellHeight(message, { expanded: false, width: 720 }))
      .toBeGreaterThan(estimateTranscriptCellHeight(activity, { expanded: false, width: 720 }));
  });

  it("keeps activity row estimates compact while preserving expanded detail height", () => {
    const cell: ParentAgentTranscriptCell = {
      id: "cell:process:activity",
      kind: "process-row",
      source: "provider-runtime",
      title: "Planning draft generated",
      text: "Planning draft generated 已完成",
      status: "completed",
      detailText: "artifact: harness/runs/planning/latest.md\nstatus: completed",
      evidenceRefs: [{ kind: "artifact", label: "plan", ref: "harness/runs/planning/latest.md" }],
    };

    const collapsedHeight = estimateTranscriptCellHeight(cell, { expanded: false, width: 720 });
    const expandedHeight = estimateTranscriptCellHeight(cell, { expanded: true, width: 720 });

    expect(collapsedHeight).toBeLessThan(64);
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);
  });

  it("caps virtual height for very long expanded tool details", () => {
    const cell: ParentAgentTranscriptCell = {
      id: "cell:process:long-tool",
      kind: "process-row",
      source: "provider-runtime",
      title: "已运行命令",
      text: "已运行 1 条命令",
      detailText: Array.from({ length: 4_000 }, (_, index) => `line ${index}`).join("\n"),
    };

    const expandedHeight = estimateTranscriptCellHeight(cell, { expanded: true, width: 720 });
    expect(expandedHeight).toBeGreaterThan(320);
    expect(expandedHeight).toBeLessThanOrEqual(430);
  });
});
