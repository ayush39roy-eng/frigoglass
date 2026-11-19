import { describe, expect, it } from 'vitest';

import { absWeek, roundUpToYearEnd, weekOfYearNumber, yearEnd, yearOf, yearSpans, yearStart } from './week-line';

/** I57: the browser mirror of the backend week helpers, on the shared table. */
describe('week line helpers (R53-1)', () => {
  const table: [number, number, number][] = [
    [1, 2026, 1],
    [52, 2026, 52],
    [53, 2027, 1],
    [104, 2027, 52],
    [105, 2028, 1],
    [364, 2032, 52],
    [365, 2033, 1],
  ];

  it('year_of / week_of_year', () => {
    for (const [w, y, wk] of table) {
      expect(yearOf(w, 2026)).toBe(y);
      expect(weekOfYearNumber(w)).toBe(wk);
    }
  });

  it('year_start / year_end / abs_week', () => {
    expect(yearStart(2027, 2026)).toBe(53);
    expect(yearEnd(2027, 2026)).toBe(104);
    expect(yearEnd(2040, 2026)).toBe(780);
    expect(absWeek(2027, 5, 2026)).toBe(57);
    expect(absWeek(2026, 53, 2026)).toBe(52);
    expect(absWeek(2025, 10, 2026)).toBeNull();
  });

  it('rounds a finish week up to its year end and spans years', () => {
    expect(roundUpToYearEnd(52)).toBe(52);
    expect(roundUpToYearEnd(53)).toBe(104);
    expect(roundUpToYearEnd(150)).toBe(156);
    expect(yearSpans(1, 130)).toEqual([
      { yearIndex: 0, startWeek: 1, endWeek: 52 },
      { yearIndex: 1, startWeek: 53, endWeek: 104 },
      { yearIndex: 2, startWeek: 105, endWeek: 130 },
    ]);
  });
});
