import { describe, expect, it } from 'vitest';

import {
  actualSpan,
  barGeometry,
  delayConnectorGeometry,
  dragMoveStartWeek,
  dragResizeDuration,
  makeWeekScale,
  plannedSpan,
  snapWeekDelta,
  stepDragResult,
  weekEndToX,
  weekToX,
  WEEK_WIDTH_PX,
  clippedCompletionMarkerX,
  isPastScaleEnd,
  lastScaleWeek,
  slipBracketGeometry,
} from './gantt-coordinates';

describe('gantt-coordinates — week→pixel scale', () => {
  it('maps week numbers to x with a linear, origin-1 scale', () => {
    const scale = makeWeekScale('weeks');
    expect(scale.weekWidthPx).toBe(WEEK_WIDTH_PX.weeks);
    // ADR 0024: the axis is the 52-week plan year — W1..W52, no W53+ columns.
    expect(scale.horizonWeeks).toBe(52);
    expect(scale.totalWidthPx).toBe(52 * WEEK_WIDTH_PX.weeks);
    // week 1 (origin) is at x = 0
    expect(weekToX(1, scale)).toBe(0);
    // week 42 (CURRENT_WEEK) start edge
    expect(weekToX(42, scale)).toBe(41 * WEEK_WIDTH_PX.weeks);
    // year-end marker = END edge of week 52 = the axis' right edge
    expect(weekEndToX(52, scale)).toBe(52 * WEEK_WIDTH_PX.weeks);
    expect(weekEndToX(52, scale)).toBe(scale.totalWidthPx);
  });

  it('days zoom widens weekWidthPx without changing the coordinate model', () => {
    const weeks = makeWeekScale('weeks');
    const days = makeWeekScale('days');
    expect(days.weekWidthPx).toBeGreaterThan(weeks.weekWidthPx);
    expect(weekToX(10, days)).toBe(9 * WEEK_WIDTH_PX.days);
  });
});

describe('gantt-coordinates — barGeometry (pure, from server week numbers only)', () => {
  const scale = makeWeekScale('weeks');
  const w = WEEK_WIDTH_PX.weeks;

  it('derives x from startWeek and width from (endWeek - startWeek + 1) — never from a duration', () => {
    // A 3-week step at weeks 5..7 inclusive.
    const geom = barGeometry(5, 7, scale);
    expect(geom).toEqual({ x: 4 * w, width: 3 * w });
  });

  it('a single-week step is one bucket wide', () => {
    expect(barGeometry(12, 12, scale)).toEqual({ x: 11 * w, width: 1 * w });
  });

  it('returns null when either bound is missing (unscheduled step)', () => {
    expect(barGeometry(null, 7, scale)).toBeNull();
    expect(barGeometry(5, null, scale)).toBeNull();
    expect(barGeometry(undefined, undefined, scale)).toBeNull();
  });

  it('two adjacent steps (I3: step[n].start = step[n-1].end + 1) produce touching, non-overlapping bars', () => {
    const a = barGeometry(1, 2, scale)!;
    const b = barGeometry(3, 5, scale)!;
    expect(a.x + a.width).toBe(b.x);
  });
});

describe('gantt-coordinates — delayConnectorGeometry', () => {
  const scale = makeWeekScale('weeks');
  const w = WEEK_WIDTH_PX.weeks;

  it('spans the planned end edge to the delayed end edge', () => {
    // planned ends week 20, delayed ends week 23 → connector covers weeks 21..23
    expect(delayConnectorGeometry(20, 23, scale)).toEqual({ x: 20 * w, width: 3 * w });
  });

  it('is null when there is no delay', () => {
    expect(delayConnectorGeometry(20, 20, scale)).toBeNull();
    expect(delayConnectorGeometry(20, 18, scale)).toBeNull();
    expect(delayConnectorGeometry(null, 23, scale)).toBeNull();
  });
});

describe('gantt-coordinates — plannedSpan / actualSpan (min/max over server fields)', () => {
  const steps = [
    { planned_start_week: 3, planned_end_week: 5, actual_start_week: 4, actual_end_week: 6 },
    { planned_start_week: 6, planned_end_week: 9, actual_start_week: null, actual_end_week: null },
    { planned_start_week: 10, planned_end_week: 12, actual_start_week: null, actual_end_week: null },
  ];

  it('plannedSpan is min(planned_start) .. max(planned_end)', () => {
    expect(plannedSpan(steps)).toEqual({ startWeek: 3, endWeek: 12 });
  });

  it('actualSpan uses only the steps that have actual weeks', () => {
    expect(actualSpan(steps)).toEqual({ startWeek: 4, endWeek: 6 });
  });

  it('both return null when no step has the relevant weeks', () => {
    expect(plannedSpan([{ planned_start_week: null, planned_end_week: null }])).toBeNull();
    expect(actualSpan([{ actual_start_week: null, actual_end_week: null }])).toBeNull();
  });
});

describe('step drag snapping (P12, ADR 0019)', () => {
  const weeks = makeWeekScale('weeks'); // 15 px / week, 52 weeks

  it('snaps a pointer offset to whole weeks, half away from zero, never -0', () => {
    expect(snapWeekDelta(0, weeks)).toBe(0);
    expect(snapWeekDelta(7, weeks)).toBe(0);
    expect(snapWeekDelta(7.5, weeks)).toBe(1);
    expect(snapWeekDelta(22, weeks)).toBe(1);
    expect(snapWeekDelta(23, weeks)).toBe(2);
    expect(snapWeekDelta(-7.5, weeks)).toBe(-1);
    expect(snapWeekDelta(-44, weeks)).toBe(-3);
    expect(Object.is(snapWeekDelta(-3, weeks), -0)).toBe(false);
    expect(snapWeekDelta(Number.NaN, weeks)).toBe(0);
  });

  it('uses the zoom level’s week width (days zoom = 48 px)', () => {
    const days = makeWeekScale('days');
    expect(snapWeekDelta(48 * 3, days)).toBe(3);
    expect(snapWeekDelta(23, days)).toBe(0);
  });

  it('move: shifts the whole ghost and requests the new start as a floor, clamped to 1..52', () => {
    const origin = { startWeek: 10, endWeek: 13, durationWeeks: 4 };
    expect(stepDragResult('move', origin, 45, weeks)).toEqual({
      ghost: { startWeek: 13, endWeek: 16 },
      request: { start_not_before_week: 13 },
    });
    expect(stepDragResult('move', origin, -15 * 30, weeks)).toEqual({
      ghost: { startWeek: 1, endWeek: 4 },
      request: { start_not_before_week: 1 },
    });
    const late = stepDragResult('move', origin, 15 * 100, weeks);
    expect(late.request).toEqual({ start_not_before_week: 52 });
    expect(late.ghost).toEqual({ startWeek: 52, endWeek: 52 });
    expect(dragMoveStartWeek(40, 50, weeks)).toBe(52);
  });

  it('move/resize below one snapped week sends nothing', () => {
    const origin = { startWeek: 10, endWeek: 13, durationWeeks: 4 };
    expect(stepDragResult('move', origin, 5, weeks).request).toBeNull();
    expect(stepDragResult('resize', origin, -5, weeks).request).toBeNull();
  });

  it('resize: moves only the end edge and requests duration + Δ, clamped to 1..104', () => {
    const origin = { startWeek: 10, endWeek: 13, durationWeeks: 4 };
    expect(stepDragResult('resize', origin, 30, weeks)).toEqual({
      ghost: { startWeek: 10, endWeek: 15 },
      request: { duration_override_weeks: 6 },
    });
    expect(stepDragResult('resize', origin, -15 * 10, weeks)).toEqual({
      ghost: { startWeek: 10, endWeek: 10 },
      request: { duration_override_weeks: 1 },
    });
    expect(dragResizeDuration(100, 10)).toBe(104);
    expect(dragResizeDuration(3, -9)).toBe(1);
  });

  it('resize of a started step uses the served effective duration, not the drawn tail', () => {
    // In Progress: the bar shows the remaining tail W30–W31, the effective duration is 6.
    const origin = { startWeek: 30, endWeek: 31, durationWeeks: 6 };
    const r = stepDragResult('resize', origin, 15 * 2, weeks);
    expect(r.request).toEqual({ duration_override_weeks: 8 });
    expect(r.ghost).toEqual({ startWeek: 30, endWeek: 33 });
  });

  it('the ghost never runs past W52 (the end of the plan-year axis)', () => {
    const origin = { startWeek: 44, endWeek: 51, durationWeeks: 8 };
    expect(stepDragResult('resize', origin, 15 * 10, weeks).ghost.endWeek).toBe(52);
    expect(stepDragResult('move', origin, 15 * 5, weeks).ghost.endWeek).toBe(52);
  });
});

describe('W52 clipping (ADR 0024 — 52-week display horizon)', () => {
  const scale = makeWeekScale('weeks');
  const w = WEEK_WIDTH_PX.weeks;

  it('reports the axis end as W52 and flags weeks past it', () => {
    expect(lastScaleWeek(scale)).toBe(52);
    expect(isPastScaleEnd(52, scale)).toBe(false);
    expect(isPastScaleEnd(53, scale)).toBe(true);
    expect(isPastScaleEnd(null, scale)).toBe(false);
  });

  it('a bar inside the year is unchanged and carries no clip flag', () => {
    expect(barGeometry(40, 52, scale)).toEqual({ x: 39 * w, width: 13 * w });
    expect(barGeometry(40, 52, scale)?.continuesPastEnd).toBeUndefined();
  });

  it('a bar running past W52 is clipped at the W52 end edge and flagged', () => {
    const geom = barGeometry(45, 70, scale);
    expect(geom).toEqual({ x: 44 * w, width: 8 * w, continuesPastEnd: true });
    // Its right edge is exactly the axis' right edge — nothing drawn on W53+.
    expect(geom!.x + geom!.width).toBe(scale.totalWidthPx);
  });

  it('a bar that starts after W52 is not drawn at all', () => {
    expect(barGeometry(53, 60, scale)).toBeNull();
  });

  it('the delay connector is clipped at W52 too, and dropped when wholly past it', () => {
    expect(delayConnectorGeometry(50, 58, scale)).toEqual({ x: 50 * w, width: 2 * w, continuesPastEnd: true });
    expect(delayConnectorGeometry(52, 58, scale)).toBeNull();
    expect(delayConnectorGeometry(55, 58, scale)).toBeNull();
  });

  it('completion markers past W52 pin to the axis edge; a slip bracket between two is dropped', () => {
    expect(clippedCompletionMarkerX(60, scale)).toBe(scale.totalWidthPx);
    expect(clippedCompletionMarkerX(40, scale)).toBe(40 * w);
    expect(slipBracketGeometry(48, 60, scale)).toEqual({ x: 48 * w, width: 4 * w });
    expect(slipBracketGeometry(55, 60, scale)).toBeNull();
  });
});
