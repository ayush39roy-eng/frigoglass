/**
 * Week-bucket coordinate system for the custom Gantt (`dataviz-gantt` SKILL).
 *
 * The x-axis is week-indexed, not date-indexed: `x = (week - originWeek) *
 * weekWidthPx`. Every bar's x / width is a PURE render of the server-provided
 * `planned_start_week` / `planned_end_week` / `actual_*_week` integers onto this
 * scale — no bar position is ever computed by summing `duration_weeks`, and no
 * `Date` object is involved (the domain model is week-granular everywhere).
 *
 * The axis is the 52-week plan year (`DISPLAY_HORIZON_WEEKS`, ADR 0024): W1–W52
 * and nothing after. A bar that runs past W52 is CLIPPED at the W52 end edge and
 * reports `continuesPastEnd` so the row can show its "Spillover → 2027" marker;
 * one that starts after W52 is not drawn at all. Clipping is geometry only — the
 * project's spillover verdict is still the server's `row.spillover` flag (I9).
 *
 * This module contains no business logic: it maps week numbers the API already
 * computed to pixels. It is unit-tested (`gantt-coordinates.test.ts`).
 */

import { DISPLAY_HORIZON_WEEKS } from '@/lib/domain-constants';

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

/** P13-T13: row density. `comfortable` shows the row meta (leader, code, type,
 *  D/L weeks) on a taller project row; `forest` is the compact overview — one
 *  line per project, so many more rows fit on screen. */
export type GanttDensity = 'comfortable' | 'forest';
export const ROW_HEIGHTS: Record<GanttDensity, { project: number; step: number }> = {
  comfortable: { project: 58, step: STEP_ROW_HEIGHT },
  forest: { project: 26, step: 22 },
};

export interface WeekScale {
  /** First week rendered (1-indexed, absolute). */
  readonly originWeek: number;
  /** Weeks on the axis: the 52-week plan year (`DISPLAY_HORIZON_WEEKS`). */
  readonly horizonWeeks: number;
  /** Pixels per one-week bucket. */
  readonly weekWidthPx: number;
  /** Full timeline width in pixels (`horizonWeeks * weekWidthPx`). */
  readonly totalWidthPx: number;
}

/** P13-T13 (API_CONTRACT_P13 §7): the toolbar's px zoom slider, 16–48 px per
 *  week. 16 keeps the whole 52-week year roughly in view (the old "weeks"
 *  level); 48 is the old "days" level. */
export const ZOOM_MIN_PX = 16;
export const ZOOM_MAX_PX = 48;
export const ZOOM_STEP_PX = 4;
export const ZOOM_DEFAULT_PX = ZOOM_MIN_PX;

/** Clamp a slider value into the 16–48 px range, rounding to whole pixels. */
export function clampZoomPx(px: number): number {
  if (!Number.isFinite(px)) return ZOOM_DEFAULT_PX;
  return Math.min(ZOOM_MAX_PX, Math.max(ZOOM_MIN_PX, Math.round(px)));
}

/** `zoom` is a named level or, since P13-T13, a px-per-week value (clamped
 *  16–48). Either way it changes only `weekWidthPx`, never the data query. */
export function makeWeekScale(zoom: GanttZoom | number, horizonWeeks: number = DISPLAY_HORIZON_WEEKS): WeekScale {
  const weekWidthPx = typeof zoom === 'number' ? clampZoomPx(zoom) : WEEK_WIDTH_PX[zoom];
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

/** The last week drawn on the axis (W52 on the plan-year scale). */
export function lastScaleWeek(scale: WeekScale): number {
  return scale.originWeek + scale.horizonWeeks - 1;
}

/** True when a served week falls after the axis' last week — i.e. it would sit
 *  in the spillover year, which the timeline does not draw. Geometry only. */
export function isPastScaleEnd(week: number | null | undefined, scale: WeekScale): boolean {
  return week != null && week > lastScaleWeek(scale);
}

export interface BarGeometry {
  /** Left edge in px. */
  x: number;
  /** Width in px. Always ≥ `weekWidthPx` (a step occupies whole weeks, inclusive). */
  width: number;
  /** Present (and `true`) only when the span ran past the axis' last week and
   *  was clipped at its end edge — the row then shows a spillover marker. */
  continuesPastEnd?: true;
}

/**
 * Geometry for a bar spanning `startWeek..endWeek` INCLUSIVE (the domain model's
 * convention — `step[n].start >= step[n-1].end + 1`, so a step's `end` is the
 * last week it occupies). Returns `null` when either bound is missing.
 *
 * NOTE: width comes from `(endWeek - startWeek + 1)`, i.e. the two server week
 * numbers — never from `duration_weeks`. Callers pass API fields directly.
 *
 * Clipped to the axis (ADR 0024): a span ending after the last week is cut at
 * the last week's end edge (`continuesPastEnd: true`); a span starting after
 * the last week returns `null` (nothing on W1–W52 to draw).
 */
export function barGeometry(
  startWeek: number | null | undefined,
  endWeek: number | null | undefined,
  scale: WeekScale,
): BarGeometry | null {
  if (startWeek == null || endWeek == null) return null;
  const last = lastScaleWeek(scale);
  if (startWeek > last) return null;
  const x = weekToX(startWeek, scale);
  const clippedEnd = Math.min(endWeek, last);
  const spanWeeks = Math.max(1, clippedEnd - startWeek + 1);
  const geom: BarGeometry = { x, width: spanWeeks * scale.weekWidthPx };
  if (endWeek > last) geom.continuesPastEnd = true;
  return geom;
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
  const last = lastScaleWeek(scale);
  // Planned end already past the axis: the whole delay is in the spillover year.
  if (plannedEndWeek >= last) return null;
  const x = weekEndToX(plannedEndWeek, scale);
  const width = (Math.min(delayedEndWeek, last) - plannedEndWeek) * scale.weekWidthPx;
  const geom: BarGeometry = { x, width };
  if (delayedEndWeek > last) geom.continuesPastEnd = true;
  return geom;
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

/** As `completionMarkerX`, but a week past the axis is pinned to the axis' end
 *  edge (where the spillover marker sits) instead of being drawn off-canvas. */
export function clippedCompletionMarkerX(week: number, scale: WeekScale): number {
  return weekEndToX(Math.min(week, lastScaleWeek(scale)), scale);
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
  const a = clippedCompletionMarkerX(expectedEndWeek, scale);
  const b = clippedCompletionMarkerX(projectedEndWeek, scale);
  // Both past the axis: nothing on W1–W52 to bracket.
  if (a === b) return null;
  return { x: Math.min(a, b), width: Math.abs(b - a) };
}

// ---------------------------------------------------------------------------
// P12 (ADR 0019): drag a step bar. Pure pointer-pixels → whole-weeks maths for
// the gesture only. The result is a REQUEST (`start_not_before_week` or
// `duration_override_weeks`); where the bar really lands is decided by the next
// schedule run (precedence and capacity still apply), never by this module.
// ---------------------------------------------------------------------------

/** Upper bound of `duration_override_weeks` (ADR 0019, `backend/schemas/step_timing.py`). */
export const DURATION_OVERRIDE_MAX_WEEKS = 104;

export type StepDragMode = 'move' | 'resize';

/** A pointer offset in px, snapped to whole weeks (round half away from zero). */
export function snapWeekDelta(dxPx: number, scale: WeekScale): number {
  if (!Number.isFinite(dxPx) || scale.weekWidthPx <= 0) return 0;
  const weeks = dxPx / scale.weekWidthPx;
  const snapped = Math.sign(weeks) * Math.round(Math.abs(weeks));
  return snapped === 0 ? 0 : snapped; // never -0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Body drag: the requested earliest start week, clamped to the axis (`1..52`). */
export function dragMoveStartWeek(originStartWeek: number, deltaWeeks: number, scale: WeekScale): number {
  return clamp(originStartWeek + deltaWeeks, scale.originWeek, scale.originWeek + scale.horizonWeeks - 1);
}

/** Right-edge drag: the requested duration, clamped to `1..104` weeks. */
export function dragResizeDuration(originDurationWeeks: number, deltaWeeks: number): number {
  return clamp(originDurationWeeks + deltaWeeks, 1, DURATION_OVERRIDE_MAX_WEEKS);
}

export interface StepDragOrigin {
  /** The bar as served: `planned_start_week..planned_end_week` (inclusive). */
  startWeek: number;
  endWeek: number;
  /** The served effective duration (`duration_weeks`). */
  durationWeeks: number;
}

export interface StepDragResult {
  /** The ghost bar's span, inclusive, for display while dragging. */
  ghost: { startWeek: number; endWeek: number };
  /** The value the drop would send, or `null` when the drop changes nothing. */
  request: { start_not_before_week: number } | { duration_override_weeks: number } | null;
}

/**
 * The ghost and request for a drag of `dxPx` from `origin`.
 * - `move`: the whole bar shifts; the request is the new start week as a floor.
 * - `resize`: the end edge moves; the request is the new duration
 *   (`durationWeeks + Δ`). For a started step the server derives the remaining
 *   tail from it, so the ghost is indicative only.
 * The ghost never extends past the horizon's last week.
 */
export function stepDragResult(
  mode: StepDragMode,
  origin: StepDragOrigin,
  dxPx: number,
  scale: WeekScale,
): StepDragResult {
  const delta = snapWeekDelta(dxPx, scale);
  const lastWeek = scale.originWeek + scale.horizonWeeks - 1;
  if (mode === 'move') {
    const start = dragMoveStartWeek(origin.startWeek, delta, scale);
    const shift = start - origin.startWeek;
    return {
      ghost: { startWeek: start, endWeek: Math.min(lastWeek, origin.endWeek + shift) },
      request: shift === 0 ? null : { start_not_before_week: start },
    };
  }
  const duration = dragResizeDuration(origin.durationWeeks, delta);
  const change = duration - origin.durationWeeks;
  const end = Math.min(lastWeek, Math.max(origin.startWeek, origin.endWeek + change));
  return {
    ghost: { startWeek: origin.startWeek, endWeek: end },
    request: change === 0 ? null : { duration_override_weeks: duration },
  };
}
