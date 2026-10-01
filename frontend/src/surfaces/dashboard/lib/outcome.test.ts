import { describe, expect, it } from 'vitest';

import type { CompletingWithinYearRow } from '../api/types';
import { OUTCOME_STYLE, outcomeOf } from './outcome';

function row(overrides: Partial<CompletingWithinYearRow>): CompletingWithinYearRow {
  return {
    project_id: 'p1',
    project_name: 'Project',
    hub: 'R&D-Greece',
    category: 'A+',
    priority: 'P1',
    within_year: false,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: null,
    ...overrides,
  };
}

describe('outcomeOf', () => {
  it('mirrors the backend precedence: blocked wins outright over within_year', () => {
    // P9-F02: `blocked_count` is exclusive — a row with BOTH flags is counted in
    // blocked_count only, never also in within_year_count. A per-row reading that
    // picked within_year here would make the cards disagree with the KPI tiles.
    expect(outcomeOf(row({ blocked: true, within_year: true }))).toBe('blocked');
    expect(outcomeOf(row({ blocked: true, spillover: true }))).toBe('blocked');
    expect(outcomeOf(row({ blocked: true, left_out: true }))).toBe('blocked');
  });

  it('resolves each remaining flag in the documented order', () => {
    expect(outcomeOf(row({ within_year: true, spillover: true }))).toBe('within_year');
    expect(outcomeOf(row({ spillover: true, left_out: true }))).toBe('spillover');
    expect(outcomeOf(row({ left_out: true }))).toBe('left_out');
  });

  it('never guesses an outcome from a week number when no flag is set', () => {
    // last_step_end_week is present but every flag is false: the row gets the
    // explicit "unresolved" bucket rather than this surface inferring an outcome
    // from the week (Invariant I9 — no independent calculation in the frontend).
    expect(outcomeOf(row({ last_step_end_week: 12 }))).toBe('unresolved');
  });

  it('reuses the existing outcome colour semantics — within year favourable, the rest warning', () => {
    expect(OUTCOME_STYLE.within_year.colorToken).toBe('--color-success');
    expect(OUTCOME_STYLE.spillover.colorToken).toBe('--color-warning');
    expect(OUTCOME_STYLE.left_out.colorToken).toBe('--color-warning');
    expect(OUTCOME_STYLE.blocked.colorToken).toBe('--color-warning');
  });
});
