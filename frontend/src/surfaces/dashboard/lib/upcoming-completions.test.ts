import { describe, expect, it } from 'vitest';

import type { CompletingWithinYearRow } from '../api/types';
import { noFinishWeekCount, planWeekQuarter, quarterCounts, selectUpcomingCompletions } from './upcoming-completions';

function row(id: string, overrides: Partial<CompletingWithinYearRow> = {}): CompletingWithinYearRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'PD-India',
    category: null,
    priority: 'P1',
    within_year: true,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: 40,
    type: null,
    status: 'In Development',
    not_started: false,
    ...overrides,
  };
}

describe('selectUpcomingCompletions', () => {
  it('keeps served within-year rows in [current, current + 8), soonest first, blocked excluded', () => {
    const rows = [
      row('late', { last_step_end_week: 50 }), // W50 = 42 + 8, outside
      row('b', { last_step_end_week: 45 }),
      row('a', { last_step_end_week: 45 }),
      row('now', { last_step_end_week: 42 }),
      row('past', { last_step_end_week: 41 }),
      row('held', { last_step_end_week: 43, blocked: true }),
      row('spill', { last_step_end_week: 44, within_year: false, spillover: true }),
      row('nul', { last_step_end_week: null }),
    ];
    expect(selectUpcomingCompletions(rows, 42).map((f) => f.row.project_id)).toEqual(['now', 'a', 'b']);
  });
});

describe('quarterCounts', () => {
  it('counts within-year finishes per quarter by the ISO-Thursday month', () => {
    // 2026: W13 Thursday = 26 Mar (Q1), W14 Thursday = 2 Apr (Q2), W40 Thursday = 1 Oct (Q4).
    expect(planWeekQuarter(13, 2026)).toBe(0);
    expect(planWeekQuarter(14, 2026)).toBe(1);
    expect(planWeekQuarter(40, 2026)).toBe(3);
    const rows = [
      row('1', { last_step_end_week: 13 }),
      row('2', { last_step_end_week: 14 }),
      row('3', { last_step_end_week: 40 }),
      row('4', { last_step_end_week: 52 }),
      row('5', { last_step_end_week: 20, blocked: true }),
    ];
    expect(quarterCounts(rows, 2026)).toEqual([1, 1, 0, 2]);
  });
});

describe('noFinishWeekCount', () => {
  it('counts within-year rows with no served finish week, so the card reconciles with within_year_count', () => {
    const rows = [
      row('done', { last_step_end_week: null, status: 'Commercialized' }),
      row('q4', { last_step_end_week: 45 }),
      row('held', { last_step_end_week: null, blocked: true }),
      row('spill', { last_step_end_week: null, within_year: false, spillover: true }),
    ];
    expect(noFinishWeekCount(rows)).toBe(1);
    const sum = noFinishWeekCount(rows) + quarterCounts(rows, 2026).reduce((a, b) => a + b, 0);
    expect(sum).toBe(rows.filter((r) => r.within_year && !r.blocked).length);
  });
});
