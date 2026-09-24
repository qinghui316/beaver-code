import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { buildTranscriptOffsets, calculateTranscriptVirtualRange, findTranscriptOffsetIndex } from "./TranscriptVirtualList.js";
import { estimateTranscriptCellHeight } from "./transcriptMeasurement.js";
import type { ParentAgentTranscriptCell } from "../../types.js";

const TRANSCRIPT_VIRTUALIZATION_THRESHOLD = 80;

export function TranscriptCellVirtualList({
  cells,
  scrollContainerRef,
  className,
  testId,
  emptyMessage,
  groupedByTurn = false,
  renderCell,
}: {
  cells: ParentAgentTranscriptCell[];
  scrollContainerRef?: RefObject<HTMLElement | null>;
  className: string;
  testId: string;
  emptyMessage: string;
  groupedByTurn?: boolean;
  renderCell: (cell: ParentAgentTranscriptCell, expanded: boolean, onToggleExpanded: () => void) => ReactNode;
}): ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [expandedCells, setExpandedCells] = useState<Set<string>>(new Set());
  const virtualization = useTranscriptVirtualization({ cells, expandedCells, listRef, scrollContainerRef, groupedByTurn });

  return (
    <div ref={listRef} className={className} data-testid={testId}>
      {cells.length === 0 ? <div className="empty-state">{emptyMessage}</div> : null}
      {virtualization.topSpacer > 0 ? <div className="transcript-virtual-spacer" style={{ height: virtualization.topSpacer }} /> : null}
      {virtualization.visibleCells.map((cell, visibleIndex) => {
        const cellIndex = virtualization.start + visibleIndex;
        const previous = cellIndex > 0 ? cells[cellIndex - 1] : undefined;
        const boundaryClass = groupedByTurn
          ? sameProviderTurn(previous, cell) ? "transcript-same-turn" : "transcript-turn-boundary"
          : undefined;
        return (
          <div key={cell.id} data-transcript-cell-id={cell.id} className={boundaryClass}>
            {renderCell(cell, expandedCells.has(cell.id), () => {
                virtualization.forgetMeasurement(cell.id);
                setExpandedCells((current) => {
                  const next = new Set(current);
                  if (next.has(cell.id)) next.delete(cell.id);
                  else next.add(cell.id);
                  return next;
                });
              })}
          </div>
        );
      })}
      {virtualization.bottomSpacer > 0 ? <div className="transcript-virtual-spacer" style={{ height: virtualization.bottomSpacer }} /> : null}
    </div>
  );
}

function useTranscriptVirtualization({
  cells,
  expandedCells,
  listRef,
  scrollContainerRef,
  groupedByTurn,
}: {
  cells: ParentAgentTranscriptCell[];
  expandedCells: Set<string>;
  listRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  groupedByTurn: boolean;
}) {
  const [measuredCellHeights, setMeasuredCellHeights] = useState<Record<string, number>>({});
  const [scrollMetrics, setScrollMetrics] = useState({ scrollTop: 0, viewportHeight: 720, listWidth: 760 });
  const heights = useMemo(() => buildTranscriptCellHeights({
    cells,
    expandedCells,
    groupedByTurn,
    measuredCellHeights,
    listWidth: scrollMetrics.listWidth,
  }), [cells, expandedCells, groupedByTurn, measuredCellHeights, scrollMetrics.listWidth]);
  const heightsRef = useRef(heights);
  const scrollMetricsRef = useRef(scrollMetrics);
  const generationRef = useRef(0);
  const pendingMeasurementAnchorRef = useRef<MeasurementAnchor | null>(null);
  const measuredCellHeightsRef = useRef(measuredCellHeights);
  const cellsSignature = useMemo(() => cells.map((cell) => cell.id).join("\u001f"), [cells]);
  heightsRef.current = heights;
  scrollMetricsRef.current = scrollMetrics;
  measuredCellHeightsRef.current = measuredCellHeights;
  const range = useMemo(() => cells.length <= TRANSCRIPT_VIRTUALIZATION_THRESHOLD
    ? { start: 0, end: cells.length, topSpacer: 0, bottomSpacer: 0 }
    : calculateTranscriptVirtualRange({
      heights,
      scrollTop: scrollMetrics.scrollTop,
      viewportHeight: scrollMetrics.viewportHeight,
      overscan: 10,
    }), [cells.length, heights, scrollMetrics.scrollTop, scrollMetrics.viewportHeight]);
  const visibleCells = cells.slice(range.start, range.end);
  const visibleCellIds = visibleCells.map((cell) => cell.id).join("|");

  useLayoutEffect(() => {
    generationRef.current += 1;
    pendingMeasurementAnchorRef.current = null;
  }, [cellsSignature]);

  useEffect(() => {
    const currentIds = new Set(cells.map((cell) => cell.id));
    setMeasuredCellHeights((current) => {
      const entries = Object.entries(current).filter(([id]) => currentIds.has(id));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [cells]);

  useEffect(() => {
    const root = listRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let active = true;
    const observerGeneration = generationRef.current;
    const currentCellIds = new Set(cells.map((cell) => cell.id));
    const observer = new ResizeObserver((entries) => {
      if (!active || observerGeneration !== generationRef.current) return;
      const resolvedNode = scrollContainerRef?.current ?? listRef.current?.parentElement;
      const currentHeights = heightsRef.current;
      const currentMetrics = scrollMetricsRef.current;
      const nextMeasuredHeights = { ...measuredCellHeightsRef.current };
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.transcriptCellId;
        const height = Math.ceil(entry.contentRect.height);
        if (id && currentCellIds.has(id) && height > 0 && nextMeasuredHeights[id] !== height) {
          nextMeasuredHeights[id] = height;
          changed = true;
        }
      }
      if (changed && resolvedNode) {
        const anchor = calculateMeasurementAnchor(cells, currentHeights, resolvedNode);
        if (anchor) {
          const nextHeights = buildTranscriptCellHeights({
            cells,
            expandedCells,
            groupedByTurn,
            measuredCellHeights: nextMeasuredHeights,
            listWidth: currentMetrics.listWidth,
          });
          pendingMeasurementAnchorRef.current = {
            ...anchor,
            generation: generationRef.current,
            nextAnchorOffset: anchorOffsetForCell(cells, nextHeights, anchor.cellId),
          };
        }
      }
      if (changed) {
        measuredCellHeightsRef.current = nextMeasuredHeights;
        setMeasuredCellHeights(nextMeasuredHeights);
      }
    });
    root.querySelectorAll<HTMLElement>("[data-transcript-cell-id]").forEach((node) => observer.observe(node));
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [cells, expandedCells, groupedByTurn, listRef, scrollContainerRef, visibleCellIds]);

  useLayoutEffect(() => {
    const anchor = pendingMeasurementAnchorRef.current;
    if (!anchor) return;
    pendingMeasurementAnchorRef.current = null;
    if (anchor.generation !== generationRef.current) return;
    const node = scrollContainerRef?.current ?? listRef.current?.parentElement;
    if (!node) return;
    if (anchor.pinned) {
      node.scrollTop = node.scrollHeight;
    } else if (anchor.nextAnchorOffset != null) {
      node.scrollTop = Math.max(0, anchor.nextAnchorOffset + anchor.offsetWithinCell);
    }
    const nextMetrics = { ...scrollMetricsRef.current, scrollTop: node.scrollTop };
    scrollMetricsRef.current = nextMetrics;
    setScrollMetrics(nextMetrics);
  }, [heights, listRef, scrollContainerRef]);

  useEffect(() => {
    const resolvedNode = scrollContainerRef?.current ?? listRef.current?.parentElement;
    if (!resolvedNode) return;
    const node = resolvedNode;
    function updateMetrics(): void {
      const nextMetrics = {
        scrollTop: node.scrollTop,
        viewportHeight: node.clientHeight || 720,
        listWidth: Math.max(320, node.clientWidth - 80),
      };
      const currentMetrics = scrollMetricsRef.current;
      if (nextMetrics.scrollTop === currentMetrics.scrollTop
        && nextMetrics.viewportHeight === currentMetrics.viewportHeight
        && nextMetrics.listWidth === currentMetrics.listWidth) return;
      if (nextMetrics.listWidth !== currentMetrics.listWidth) {
        const anchor = calculateMeasurementAnchor(cells, heightsRef.current, node);
        if (anchor) {
          const nextHeights = buildTranscriptCellHeights({
            cells,
            expandedCells,
            groupedByTurn,
            measuredCellHeights: {},
            listWidth: nextMetrics.listWidth,
          });
          pendingMeasurementAnchorRef.current = {
            ...anchor,
            generation: generationRef.current,
            nextAnchorOffset: anchorOffsetForCell(cells, nextHeights, anchor.cellId),
          };
        }
        measuredCellHeightsRef.current = {};
        setMeasuredCellHeights({});
      }
      scrollMetricsRef.current = nextMetrics;
      setScrollMetrics(nextMetrics);
    }
    updateMetrics();
    node.addEventListener("scroll", updateMetrics);
    window.addEventListener("resize", updateMetrics);
    return () => {
      node.removeEventListener("scroll", updateMetrics);
      window.removeEventListener("resize", updateMetrics);
    };
  }, [cells, expandedCells, groupedByTurn, listRef, scrollContainerRef]);

  return {
    ...range,
    visibleCells,
    forgetMeasurement(cellId: string) {
      setMeasuredCellHeights((current) => {
        if (!(cellId in current)) return current;
        const next = { ...current };
        delete next[cellId];
        return next;
      });
    },
  };
}

type MeasurementAnchor = {
  cellId: string;
  offsetWithinCell: number;
  pinned: boolean;
  generation: number;
  nextAnchorOffset: number | null;
};

function buildTranscriptCellHeights({ cells, expandedCells, groupedByTurn, measuredCellHeights, listWidth }: {
  cells: ParentAgentTranscriptCell[];
  expandedCells: Set<string>;
  groupedByTurn: boolean;
  measuredCellHeights: Record<string, number>;
  listWidth: number;
}): number[] {
  return cells.map((cell, index) => (
    measuredCellHeights[cell.id] ?? estimateTranscriptCellHeight(cell, {
      expanded: expandedCells.has(cell.id),
      width: listWidth,
    })
  ) + (groupedByTurn && index > 0 ? sameProviderTurn(cells[index - 1], cell) ? 8 : 20 : 0));
}

function calculateMeasurementAnchor(cells: ParentAgentTranscriptCell[], heights: number[], node: HTMLElement): Omit<MeasurementAnchor, "generation" | "nextAnchorOffset"> | null {
  if (cells.length === 0) return null;
  const offsets = buildTranscriptOffsets(heights);
  const scrollTop = Math.max(0, node.scrollTop);
  const index = findTranscriptOffsetIndex(offsets, scrollTop);
  const cell = cells[index];
  if (!cell) return null;
  return {
    cellId: cell.id,
    offsetWithinCell: scrollTop - (offsets[index] ?? 0),
    pinned: node.scrollHeight - node.scrollTop - node.clientHeight <= 140,
  };
}

function anchorOffsetForCell(cells: ParentAgentTranscriptCell[], heights: number[], cellId: string): number | null {
  const index = cells.findIndex((cell) => cell.id === cellId);
  if (index < 0) return null;
  return buildTranscriptOffsets(heights)[index] ?? null;
}

function sameProviderTurn(previous: ParentAgentTranscriptCell | undefined, current: ParentAgentTranscriptCell): boolean {
  return Boolean(previous?.threadId && previous.turnId && current.threadId && current.turnId
    && previous.threadId === current.threadId
    && previous.turnId === current.turnId);
}
