import { describe, expect, it } from 'vitest';

import { OUTCOME_LABEL, OUTCOME_ORDER } from '../components/outcome-meta';
import { yearKeyOf } from './drilldown';
import { importSimulateResponseSchema } from './import-schema';
import { projectInYear, YEAR_ALL, YEAR_NOT_PLACED } from './year-filter';

/**
 * P42-T04 (API_CONTRACT_P42 §10): the What-if / plan-import outcome classes
 * `queued` and `not_scheduled_priority`. Row filtering follows the server's
 * C1 year blocks: a queued project sits in its finish-year block (never in
 * `within_year`), or in `not_placed` with no slot; a not-scheduled project is
 * only in `all`.
 */

const BASE = 2026;

describe('P42 import year blocks', () => {
  it('a queued project with a finish week goes by that week', () => {
    const p = { outcome: 'queued' as const, finish_week: 40 };
    expect(yearKeyOf(p, BASE)).toBe('2026');
    expect(projectInYear(p, '2026', BASE)).toBe(true);
    expect(projectInYear(p, YEAR_NOT_PLACED, BASE)).toBe(false);
    expect(yearKeyOf({ outcome: 'queued', finish_week: 70 }, BASE)).toBe('2027');
  });

  it('a queued project with no slot is not placed', () => {
    const p = { outcome: 'queued' as const, finish_week: null };
    expect(yearKeyOf(p, BASE)).toBe(YEAR_NOT_PLACED);
    expect(projectInYear(p, YEAR_NOT_PLACED, BASE)).toBe(true);
  });

  it('a not-scheduled (P4) project is only in "all"', () => {
    const p = { outcome: 'not_scheduled_priority' as const, finish_week: null };
    expect(yearKeyOf(p, BASE)).toBeNull();
    expect(projectInYear(p, YEAR_ALL, BASE)).toBe(true);
    expect(projectInYear(p, YEAR_NOT_PLACED, BASE)).toBe(false);
    expect(projectInYear(p, '2026', BASE)).toBe(false);
  });

  it('labels both classes in plain words', () => {
    expect(OUTCOME_LABEL.queued).toBe('Queued (not counted)');
    expect(OUTCOME_LABEL.not_scheduled_priority).toBe('Not scheduled (P4)');
    expect(OUTCOME_ORDER).toContain('queued');
    expect(OUTCOME_ORDER).toContain('not_scheduled_priority');
  });

  it('the response check accepts the two new classes and the P42 counts', () => {
    const outcome = importSimulateResponseSchema;
    // Only the enum is exercised here: a P42 project row parses, a bogus class does not.
    const enumOf = (o: string) =>
      outcome.safeParse({ projects: [{ outcome: o }] }).error?.issues.some((i) => i.path.join('.') === 'projects.0.outcome') ?? false;
    expect(enumOf('queued')).toBe(false);
    expect(enumOf('not_scheduled_priority')).toBe(false);
    expect(enumOf('bogus')).toBe(true);
  });
});
