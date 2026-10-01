/**
 * Week-bucket coordinate system for the custom Gantt (`dataviz-gantt` SKILL).
 *
 * The x-axis is week-indexed, not date-indexed: `x = (week - originWeek) *
 * weekWidthPx`. Every bar's x / width is a PURE render of the server-provided
 * `planned_start_week` / `planned_end_week` / `actual_*_week` integers onto this
 * scale — no bar position is ever computed by summing `duration_weeks`, and no
 * `Date` object is involved (the domain model is week-granular everywhere).
 *
 * This module contains no business logic: it maps week numbers the API already
 * computed to pixels. It is unit-tested (`gantt-coordinates.test.ts`).
 */

import { HORIZON_WEEKS } from '@/lib/domain-constants';

/** Two zoom levels (`dataviz-gantt` SKILL): weeks (default, full horizon roughly
 *  fits) and days (wider, for inspecting step boundaries). Zoom changes only
 *  `weekWidthPx` — it never changes the data query. */
export type GanttZoom = 'weeks' | 'days';

export const WEEK_WIDTH_PX: Record<GanttZoom, number> = {
  weeks: 15,
  days: 48,
};

/** Fixed row heights — known ahead of layout, which is what makes row
 *  virtualization tractable (`dataviz-gantt` SKILL). */
export const PROJECT_ROW_HEIGHT = 40;
export const STEP_ROW_HEIGHT = 28;

export interface WeekScale {
  /** First week rendered (1-indexed, absolute). */
  readonly originWeek: number;
  /** Weeks in the horizon (78 per DOMAIN_RULES). */
  readonly horizonWeeks: number;
  /** Pixels per one-week bucket. */
  readonly weekWidthPx: number;
  /** Full timeline width in pixels (`horizonWeeks * weekWidthPx`). */
  readonly totalWidthPx: number;
}

export function makeWeekScale(zoom: GanttZoom, horizonWeeks: number = HORIZON_WEEKS): WeekScale {
  const weekWidthPx = WEEK_WIDTH_PX[zoom];
  return {
    originWeek: 1,
    horizonWeeks,
    weekWidthPx,
    totalWidthPx: horizonWeeks * weekWidthPx,
  };
}

/**
 * X pixel of the START edge of `week` (1-indexed). `weekToX(originWeek)` is 0.
 * A vertical marker "at week N" is drawn here.
 */
export function weekToX(week: number, scale: WeekScale): number {
  return (week - scale.originWeek) * scale.weekWidthPx;
}

/**
 * X pixel of the END edge of `week` (i.e. the start edge of `week + 1`). Used for
 * the year-end marker: `WITHIN_YEAR_WEEK` means "complete by the end of week 52".
 */
export function weekEndToX(week: number, scale: WeekScale): number {
  return weekToX(week + 1, scale);
}

export interface BarGeometry {
  /** Left edge in px. */
  x: number;
  /** Width in px. Always ≥ `weekWidthPx` (a step occupies whole weeks, inclusive). */
  width: number;
}

/**
 * Geometry for a bar spanning `startWeek..endWeek` INCLUSIVE (the domain model's
 * convention — `step[n].start >= step[n-1].end + 1`, so a step's `end` is the
 * last week it occupies). Returns `null` when either bound is missing.
 *
 * NOTE: width comes from `(endWeek - startWeek + 1)`, i.e. the two server week
 * numbers — never from `duration_weeks`. Callers pass API fields directly.
 */
export function barGeometry(
  startWeek: number | null | undefined,
  endWeek: number | null | undefined,
  scale: WeekScale,
): BarGeometry | null {
  if (startWeek == null || endWeek == null) return null;
  const x = weekToX(startWeek, scale);
  const spanWeeks = Math.max(1, endWeek - startWeek + 1);
  return { x, width: spanWeeks * scale.weekWidthPx };
}

/**
 * Geometry for the red delay connector: a horizontal segment from the planned end
 * edge to the delayed end edge. `plannedEndWeek` and `delayedEndWeek` are both
 * server-sourced week numbers (`planned_end_week`, and `planned_end_week +
 * delay_weeks` or `actual_end_week`). Returns `null` when there is no delay to
 * draw.
 */
export function delayConnectorGeometry(
  plannedEndWeek: number | null | undefined,
  delayedEndWeek: number | null | undefined,
  scale: WeekScale,
): BarGeometry | null {
  if (plannedEndWeek == null || delayedEndWeek == null) return null;
  if (delayedEndWeek <= plannedEndWeek) return null;
  const x = weekEndToX(plannedEndWeek, scale);
  const width = (delayedEndWeek - plannedEndWeek) * scale.weekWidthPx;
  return { x, width };
}

/**
 * The planned week span covering all of a project's steps: `min(planned_start_week)`
 * .. `max(planned_end_week)`. This is a min/max over server week numbers (like the
 * axis domain), not a recomputation of the schedule. Returns `null` if no step has
 * planned weeks.
 */
export function plannedSpan(
  steps: readonly { planned_start_week: number | null; planned_end_week: number | null }[],
): { startWeek: number; endWeek: number } | null {
  let startWeek = Number.POSITIVE_INFINITY;
  let endWeek = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    if (step.planned_start_week != null) startWeek = Math.min(startWeek, step.planned_start_week);
    if (step.planned_end_week != null) endWeek = Math.max(endWeek, step.planned_end_week);
  }
  if (!Number.isFinite(startWeek) || !Number.isFinite(endWeek)) return null;
  return { startWeek, endWeek };
}

/** The actual week span covering all of a project's steps: `min(actual_start_week)`
 *  .. `max(actual_end_week)`. Same min/max-of-server-fields rule as `plannedSpan`. */
export function actualSpan(
  steps: readonly { actual_start_week: number | null; actual_end_week: number | null }[],
): { startWeek: number; endWeek: number } | null {
  let startWeek = Number.POSITIVE_INFINITY;
  let endWeek = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    if (step.actual_start_week != null) startWeek = Math.min(startWeek, step.actual_start_week);
    if (step.actual_end_week != null) endWeek = Math.max(endWeek, step.actual_end_week);
  }
  if (!Number.isFinite(startWeek) || !Number.isFinite(endWeek)) return null;
  return { startWeek, endWeek };
}

/**
 * X pixel of a per-project completion marker (P9 — DOMAIN_RULES "Expected vs
 * projected completion"). A completion week means "done by the END of week
 * N", so the marker sits on the end edge of that week — the same convention
 * as the year-end marker. `week` is `expected_end_week` / `projected_end_week`
 * exactly as the API returned it (Invariant I16).
 */
export function completionMarkerX(week: number, scale: WeekScale): number {
  return weekEndToX(week, scale);
}

export interface SlipBracketGeometry {
  /** Left edge (the earlier of the two markers). */
  x: number;
  /** Right edge (the later of the two markers). */
  width: number;
}

/**
 * Geometry for the thin bracket drawn between the expected and projected
 * completion markers. Purely the span between the two server-provided week
 * numbers; the LABEL on it is `slip_weeks` from the API, never
 * `projected − expected` recomputed here. Returns `null` when either week is
 * missing or the two coincide (nothing to bracket).
 */
export function slipBracketGeometry(
  expectedEndWeek: number | null | undefined,
  projectedEndWeek: number | null | undefined,
  scale: WeekScale,
): SlipBracketGeometry | null {
  if (expectedEndWeek == null || projectedEndWeek == null) return null;
  if (expectedEndWeek === projectedEndWeek) return null;
  const a = completionMarkerX(expectedEndWeek, scale);
  const b = completionMarkerX(projectedEndWeek, scale);
  return { x: Math.min(a, b), width: Math.abs(b - a) };
}
