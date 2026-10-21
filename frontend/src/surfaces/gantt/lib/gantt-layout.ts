import * as React from 'react';

/**
 * Responsive column layout for the Gantt (P19-R02, gate finding QA-P19-2).
 *
 * At 1280 px and wider the chart keeps its two fixed columns (272 px names,
 * 148 px status) exactly as before. Below 768 px those two columns are wider
 * than the whole chart, so the narrow layout keeps ONE slim sticky name column
 * and drops the sticky status column: the status chips move into the
 * project's details dialog (and a compact icon on the row), and the timeline
 * gets the rest of the width and scrolls horizontally.
 *
 * Pure presentation. Nothing here touches a served number.
 */

/** Below this viewport width the narrow layout is used (Tailwind `md`). */
export const GANTT_NARROW_MAX_PX = 767;
const NARROW_QUERY = `(max-width: ${String(GANTT_NARROW_MAX_PX)}px)`;

export interface GanttColumnWidths {
  /** Sticky project / step name column, px. */
  left: number;
  /** Sticky status column, px. 0 = no status column (narrow layout). */
  status: number;
}

export const GANTT_WIDE_COLUMNS: GanttColumnWidths = { left: 272, status: 148 };
/** Narrow name column bounds, px. Within them it takes 40 % of the chart, so
 *  the timeline always keeps the larger share (at a 198 px chart: 88 / 110). */
export const GANTT_NARROW_LEFT_MIN = 88;
export const GANTT_NARROW_LEFT_MAX = 124;
const GANTT_NARROW_LEFT_SHARE = 0.4;

/**
 * Column widths for a layout. `chartWidth` is the measured width of the chart
 * box (0 / unknown = before layout, which takes the narrow maximum).
 */
export function ganttColumnWidths(narrow: boolean, chartWidth = 0): GanttColumnWidths {
  if (!narrow) return GANTT_WIDE_COLUMNS;
  const share = chartWidth > 0 ? Math.round(chartWidth * GANTT_NARROW_LEFT_SHARE) : GANTT_NARROW_LEFT_MAX;
  return { left: Math.min(GANTT_NARROW_LEFT_MAX, Math.max(GANTT_NARROW_LEFT_MIN, share)), status: 0 };
}

/** Width of an element, live (ResizeObserver); 0 until measured. */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** True below 768 px viewport width (live: follows resize / rotation). */
export function useNarrowGantt(): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    const mql = window.matchMedia(NARROW_QUERY);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}

export interface DragLabelPlacementInput {
  /** x of the cursor-side edge of the ghost bar, in overlay px. */
  anchorX: number;
  /** Rendered label width, px. */
  labelWidth: number;
  /** Gap between anchor and label, px. */
  gap: number;
  /** Visible timeline area (not covered by the sticky columns), overlay px. */
  visibleLeft: number;
  visibleRight: number;
}

export interface DragLabelPlacement {
  left: number;
  side: 'right' | 'left';
}

/**
 * Where the live drag label goes (gate observation O1): to the right of the
 * cursor by default; flipped to its left when it would run past the visible
 * timeline's right edge (under the sticky status column or off-screen), and
 * never further left than the visible area. An unmeasured viewport (zero
 * width, e.g. before layout) keeps the default.
 */
export function placeDragLabel({
  anchorX,
  labelWidth,
  gap,
  visibleLeft,
  visibleRight,
}: DragLabelPlacementInput): DragLabelPlacement {
  const rightSide = anchorX + gap;
  if (visibleRight <= visibleLeft || rightSide + labelWidth <= visibleRight) {
    return { left: rightSide, side: 'right' };
  }
  return { left: Math.max(visibleLeft, anchorX - gap - labelWidth), side: 'left' };
}
