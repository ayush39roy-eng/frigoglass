import { describe, expect, it } from 'vitest';

import { axisTicks, longWeekLabel, planYearOf, shortWeekLabel, weekOrDash, weekYear } from './week-labels';

describe('year-aware week labels', () => {
  it.each([
    [1, "W1 '26", '2026 W1'],
    [42, "W42 '26", '2026 W42'],
    [52, "W52 '26", '2026 W52'],
    [53, "W1 '27", '2027 W1'],
    [57, "W5 '27", '2027 W5'],
    [104, "W52 '27", '2027 W52'],
    [105, "W1 '28", '2028 W1'],
    [130, "W26 '28", '2028 W26'],
  ])('week %i', (w, short, long) => {
    expect(shortWeekLabel(w, 2026)).toBe(short);
    expect(longWeekLabel(w, 2026)).toBe(long);
  });

  it('names the plan year and dashes a missing week', () => {
    expect(planYearOf(104, 2026)).toBe(2027);
    expect(planYearOf(52, 2026)).toBe(2026);
    expect(weekOrDash(null, 2026)).toBe('—');
    expect(weekYear(53, 2026)).toEqual({ year: 2027, week: 1 });
  });

  it('ticks start at the first week, mark every year start and do not crowd the first label', () => {
    const ticks = axisTicks(42, 60, 2026);
    expect(ticks[0]).toMatchObject({ week: 42, label: "W42 '26" });
    expect(ticks.find((t) => t.week === 53)).toMatchObject({
      yearStart: true,
      label: "W1 '27",
    });
    expect(ticks.some((t) => t.week === 43)).toBe(false);
    expect(ticks.map((t) => t.week)).toContain(49);
  });
});
