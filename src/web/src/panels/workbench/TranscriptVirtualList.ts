export interface TranscriptVirtualRange {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
  totalHeight: number;
}

export function buildTranscriptOffsets(heights: number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index + 1] = offsets[index] + Math.max(1, heights[index]);
  }
  return offsets;
}

export function calculateTranscriptVirtualRange(input: {
  heights: number[];
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): TranscriptVirtualRange {
  const offsets = buildTranscriptOffsets(input.heights);
  const totalHeight = offsets[offsets.length - 1] ?? 0;
  if (input.heights.length === 0) {
    return { start: 0, end: 0, topSpacer: 0, bottomSpacer: 0, totalHeight: 0 };
  }
  const viewportHeight = Math.max(1, input.viewportHeight || 720);
  const overscan = Math.max(0, input.overscan ?? 8);
  const firstVisible = Math.max(0, findTranscriptOffsetIndex(offsets, Math.max(0, input.scrollTop)) - overscan);
  const lastVisible = Math.min(input.heights.length, findTranscriptOffsetIndex(offsets, input.scrollTop + viewportHeight) + overscan + 1);
  return {
    start: firstVisible,
    end: Math.max(firstVisible + 1, lastVisible),
    topSpacer: offsets[firstVisible] ?? 0,
    bottomSpacer: Math.max(0, totalHeight - (offsets[Math.max(firstVisible + 1, lastVisible)] ?? totalHeight)),
    totalHeight,
  };
}

export function findTranscriptOffsetIndex(offsets: number[], value: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid + 1] <= value) {
      low = mid + 1;
    } else if (offsets[mid] > value) {
      high = mid - 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(offsets.length - 2, low));
}
