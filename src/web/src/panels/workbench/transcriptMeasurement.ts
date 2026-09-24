import { layout, prepare } from "@chenglou/pretext";
import type { ParentAgentTranscriptCell } from "../../types.js";

const LONG_MESSAGE_CHAR_LIMIT = 6000;
const LONG_MESSAGE_LINE_LIMIT = 120;
const PREVIEW_CHAR_LIMIT = 2400;
const PREVIEW_LINE_LIMIT = 48;
const DEFAULT_TEXT_WIDTH = 760;
const PROSE_FONT = "15.5px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const PROSE_LINE_HEIGHT = 26;
const PROCESS_DETAIL_VIEWPORT_HEIGHT = 320;
const MESSAGE_TIMESTAMP_SLOT_HEIGHT = 16;
const MESSAGE_TIMESTAMP_GAP = 4;

export function isLongTranscriptCell(cell: ParentAgentTranscriptCell): boolean {
  if (cell.kind !== "assistant-message" && cell.kind !== "user-message") return false;
  const text = cell.text ?? "";
  return text.length > LONG_MESSAGE_CHAR_LIMIT || text.split(/\r?\n/).length > LONG_MESSAGE_LINE_LIMIT;
}

export function transcriptCellDisplayText(cell: ParentAgentTranscriptCell, expanded: boolean): string {
  if (expanded || !isLongTranscriptCell(cell)) return cell.text;
  return previewTranscriptText(cell.text);
}

export function previewTranscriptText(text: string): string {
  const lines = text.split(/\r?\n/);
  const linePreview = lines.length > PREVIEW_LINE_LIMIT ? lines.slice(0, PREVIEW_LINE_LIMIT).join("\n") : text;
  const preview = linePreview.length > PREVIEW_CHAR_LIMIT ? linePreview.slice(0, PREVIEW_CHAR_LIMIT) : linePreview;
  return `${preview.trimEnd()}\n\n...`;
}

export function estimateTranscriptCellHeight(cell: ParentAgentTranscriptCell, options: {
  expanded: boolean;
  width?: number;
}): number {
  if (cell.kind === "user-input") {
    const questionCount = Math.max(1, cell.interactionHistory?.questions?.length ?? 1);
    return Math.min(240, 72 + questionCount * 56);
  }
  if (cell.kind === "process-row" || cell.kind === "evidence-row") {
    const summaryLines = estimatePlainLineCount(cell.text, 96);
    if (!options.expanded) return Math.max(42, 30 + Math.min(summaryLines, 2) * 14);
    const detailLines = cell.detailText ? estimatePlainLineCount(cell.detailText, 92) : 0;
    const evidenceAllowance = cell.evidenceRefs?.length ? 30 : 0;
    const detailAllowance = Math.min(PROCESS_DETAIL_VIEWPORT_HEIGHT, detailLines * 18 + evidenceAllowance);
    return Math.max(82, 54 + Math.min(summaryLines, 3) * 14 + detailAllowance);
  }
  const text = transcriptCellDisplayText(cell, options.expanded);
  const titleAllowance = cell.title ? 28 : 0;
  const proseHeight = estimateTextHeightWithPretext(text, Math.max(280, options.width ?? DEFAULT_TEXT_WIDTH));
  const timestampAllowance = cell.kind === "user-message" || cell.kind === "assistant-message"
    ? MESSAGE_TIMESTAMP_SLOT_HEIGHT + MESSAGE_TIMESTAMP_GAP
    : 0;
  return Math.max(72, proseHeight + titleAllowance + 34 + timestampAllowance);
}

function estimateTextHeightWithPretext(text: string, width: number): number {
  if (isJSDomRuntime()) return estimatePlainLineCount(text, Math.max(24, Math.floor(width / 8))) * PROSE_LINE_HEIGHT;
  try {
    const measured = layout(prepare(text, PROSE_FONT, { whiteSpace: "pre-wrap" }), width, PROSE_LINE_HEIGHT);
    if (Number.isFinite(measured.height) && measured.height > 0) return measured.height;
  } catch {
    // Pretext relies on browser text primitives; keep Workbench usable if they
    // are unavailable in tests or an older embedded browser.
  }
  return estimatePlainLineCount(text, Math.max(24, Math.floor(width / 8))) * PROSE_LINE_HEIGHT;
}

function isJSDomRuntime(): boolean {
  return typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);
}

function estimatePlainLineCount(text: string, charsPerLine: number): number {
  const lines = text.split(/\r?\n/);
  return Math.max(1, lines.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0));
}
