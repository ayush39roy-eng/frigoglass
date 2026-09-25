import { describe, expect, it } from 'vitest';

import {
  actualSpan,
  barGeometry,
  delayConnectorGeometry,
  makeWeekScale,
  plannedSpan,
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
