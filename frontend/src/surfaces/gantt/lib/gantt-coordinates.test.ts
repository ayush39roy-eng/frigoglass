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
} from './gantt-coordinates';

describe('gantt-coordinates — week→pixel scale', () => {
  it('maps week numbers to x with a linear, origin-1 scale', () => {
    const scale = makeWeekScale('weeks');
    expect(scale.weekWidthPx).toBe(WEEK_WIDTH_PX.weeks);
    expect(scale.totalWidthPx).toBe(78 * WEEK_WIDTH_PX.weeks);
    // week 1 (origin) is at x = 0
    expect(weekToX(1, scale)).toBe(0);
    // week 31 (CURRENT_WEEK) start edge
    expect(weekToX(31, scale)).toBe(30 * WEEK_WIDTH_PX.weeks);
    // year-end marker = END edge of week 52 = start of week 53
    expect(weekEndToX(52, scale)).toBe(52 * WEEK_WIDTH_PX.weeks);
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
  const weeks = makeWeekScale('weeks'); // 15 px / week, 78 weeks

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

  it('move: shifts the whole ghost and requests the new start as a floor, clamped to 1..78', () => {
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
    expect(late.request).toEqual({ start_not_before_week: 78 });
    expect(late.ghost).toEqual({ startWeek: 78, endWeek: 78 });
    expect(dragMoveStartWeek(40, 50, weeks)).toBe(78);
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

  it('the ghost never runs past the horizon', () => {
    const origin = { startWeek: 70, endWeek: 77, durationWeeks: 8 };
    expect(stepDragResult('resize', origin, 15 * 10, weeks).ghost.endWeek).toBe(78);
    expect(stepDragResult('move', origin, 15 * 5, weeks).ghost.endWeek).toBe(78);
  });
});
