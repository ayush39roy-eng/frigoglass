import { afterEach, describe, expect, it } from 'vitest';

import type { MeResponse } from '@/lib/api/session';
import { useSessionStore } from '@/stores/session';

import {
  calendarYearOf,
  formatPlanWeek,
  formatWeekWithYear,
  formatWeek,
  formatWeekTitle,
  formatYearWeek,
  weekOfYear,
  weekTitleIfNextYear,
} from './format';

/**
 * Owner rule 2026-11-18: no screen shows week 53 or higher. Absolute weeks
 * past 52 are shown as the week of their own year ("W5 '27"), with the year
 * on hover ("Week 5 of 2027"). Display only.
 */
describe('week-of-year formatting (owner rule 2026-11-18)', () => {
  afterEach(() => {
    useSessionStore.setState({ me: null });
  });

  it('maps absolute weeks to the week of their year', () => {
    expect(weekOfYear(1)).toEqual({ week: 1, yearOffset: 0 });
    expect(weekOfYear(52)).toEqual({ week: 52, yearOffset: 0 });
    expect(weekOfYear(53)).toEqual({ week: 1, yearOffset: 1 });
    expect(weekOfYear(57)).toEqual({ week: 5, yearOffset: 1 });
    expect(weekOfYear(78)).toEqual({ week: 26, yearOffset: 1 });
    expect(weekOfYear(104)).toEqual({ week: 52, yearOffset: 1 });
    expect(weekOfYear(105)).toEqual({ week: 1, yearOffset: 2 });
  });

  it('prints every week with its short year tag (P62-F1), next-year weeks included', () => {
    // P62-F1 (owner 2026-11-25): the year is named inside the plan year too.
    expect(formatWeek(47, 2026)).toBe("W47 '26");
    expect(formatWeek(52, 2026)).toBe("W52 '26");
    expect(formatWeek(53, 2026)).toBe("W1 '27");
    expect(formatWeek(57, 2026)).toBe("W5 '27");
    expect(formatWeek(104, 2026)).toBe("W52 '27");
    expect(formatWeek(105, 2026)).toBe("W1 '28");
    expect(formatPlanWeek(57, 2026)).toBe("W5 '27");
    expect(formatYearWeek(57, 2026)).toBe("W5 '27");
  });

  it('never prints a week number above 52', () => {
    for (let w = 1; w <= 160; w += 1) {
      const n = Number(/^W(\d+)/.exec(formatWeek(w, 2026))?.[1]);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(52);
    }
  });

  it('names the year for hover text', () => {
    expect(formatWeekTitle(47, 2026)).toBe('Week 47 of 2026');
    expect(formatWeekTitle(57, 2026)).toBe('Week 5 of 2027');
    expect(weekTitleIfNextYear(47, 2026)).toBeUndefined();
    expect(weekTitleIfNextYear(null, 2026)).toBeUndefined();
    expect(weekTitleIfNextYear(57, 2026)).toBe('Week 5 of 2027');
  });

  it('P53: reads the served base and plan year; any year, no re-basing', () => {
    useSessionStore.setState({ me: { plan_year: 2027, week_base_year: 2026 } as MeResponse });
    // 2027 is the plan year: absolute 57 is its W5, shown with its year (P62-F1).
    expect(formatWeek(57)).toBe("W5 '27");
    expect(formatWeek(47)).toBe("W47 '26");
    expect(formatWeek(105)).toBe("W1 '28");
    expect(formatWeek(160)).toBe("W4 '29");
    expect(formatWeekTitle(57)).toBe('Week 5 of 2027');
    expect(formatWeekTitle(47)).toBe('Week 47 of 2026');
    expect(weekTitleIfNextYear(57)).toBeUndefined();
    expect(weekTitleIfNextYear(47)).toBe('Week 47 of 2026');
    expect(formatWeekWithYear(57)).toBe("W5 '27");
    // Far years are generic (owner: no cap at 2030).
    expect(formatWeek(52 * 10 + 5)).toBe("W5 '36");
  });

  it('P53 / I57: mirrors the backend week table (1, 52, 53, 104, 105, 364, 365)', () => {
    useSessionStore.setState({ me: { plan_year: 2026, week_base_year: 2026 } as MeResponse });
    const table: [number, number, number][] = [
      [1, 2026, 1],
      [52, 2026, 52],
      [53, 2027, 1],
      [104, 2027, 52],
      [105, 2028, 1],
      [364, 2032, 52],
      [365, 2033, 1],
    ];
    for (const [w, year, wk] of table) {
      expect(calendarYearOf(w)).toBe(year);
      expect(weekOfYear(w).week).toBe(wk);
    }
  });

  it('falls back to "next year" before /me has resolved', () => {
    useSessionStore.setState({ me: null });
    expect(formatWeek(57)).toBe('W5 (next year)');
    expect(formatWeekTitle(57)).toBe('Week 5 of next year');
    expect(formatWeek(40)).toBe('W40');
  });
});
