import { describe, expect, it } from 'vitest';

import { planWeekMonth } from './plan-month';

describe('planWeekMonth', () => {
  it('gives each 2026 ISO week the month of its Thursday', () => {
    // 2026-01-01 is a Thursday, so W1 is January.
    expect(planWeekMonth(1, 2026)).toBe(0);
    // W5 Thursday = 29 Jan; W6 Thursday = 5 Feb.
    expect(planWeekMonth(5, 2026)).toBe(0);
    expect(planWeekMonth(6, 2026)).toBe(1);
    // W43 Thursday = 22 Oct 2026.
    expect(planWeekMonth(43, 2026)).toBe(9);
    // W52 Thursday = 24 Dec.
    expect(planWeekMonth(52, 2026)).toBe(11);
  });

  it('handles a year whose week 1 starts in January', () => {
    // 2024-01-04 is a Thursday; W1 Thursday = 4 Jan, W9 Thursday = 29 Feb.
    expect(planWeekMonth(1, 2024)).toBe(0);
    expect(planWeekMonth(9, 2024)).toBe(1);
    expect(planWeekMonth(10, 2024)).toBe(2);
  });

  it('maps all 52 weeks into the twelve months, in order', () => {
    const months = Array.from({ length: 52 }, (_, i) => planWeekMonth(i + 1, 2026));
    expect(new Set(months).size).toBe(12);
    expect([...months].sort((a, b) => a - b)).toEqual(months);
  });
});
