import { beforeEach, describe, expect, it } from 'vitest';

import type { ImportRow, ImportSimulateResponse } from './import-types';
import { capacityCompare, delta, formatDelta, notPlacedOf, outcomeChanges } from './scenario-compare';
import { applyScenarioRules, describeRules, dimensionValues, emptyRules } from './scenario-rules';
import { MAX_COMPARE, useImportScenarios, type NewScenario } from './scenarios-store';
import { ROWS, SIMULATE_RESPONSE } from './test-fixtures';
import { projectInYear, yearOptions } from './year-filter';

function row(key: string, patch: Partial<ImportRow>): ImportRow {
  const base = ROWS[0];
  if (!base) throw new Error('fixture');
  return { ...base, key, file_row: Number(key.split('-')[1]), matched_project_id: null, include: true, ...patch };
}

/** Seven A+ rows in a deliberately shuffled order, two B rows, one excluded A+ row. */
const APLUS: ImportRow[] = [
  row('row-10', { category: 'A+', priority: 'P2', rank: null }),
  row('row-11', { category: 'A+', priority: 'P1', rank: 4 }),
  row('row-12', { category: 'A+', priority: 'P1', rank: 2 }),
  row('row-13', { category: 'A+', priority: 'P3', rank: null }),
  row('row-14', { category: 'A+', priority: 'P1', rank: null }),
  row('row-15', { category: 'A+', priority: 'P2', rank: null }),
  row('row-16', { category: 'A+', priority: 'P1', rank: 1 }),
  row('row-17', { category: 'B', priority: 'P4', hub: 'PD-India' }),
  row('row-18', { category: 'B', priority: 'P1', hub: 'PD-India', matched_project_id: 'plan-3' }),
  row('row-19', { category: 'A+', priority: 'P1', rank: 0, include: false }),
];

const included = (rows: ImportRow[]) => rows.filter((r) => r.include).map((r) => r.key);

describe('scenario rules', () => {
  it('"only 5 A+" keeps the first five A+ rows by priority → rank → file row; other categories untouched', () => {
    const rules = { ...emptyRules('merge'), caps: [{ category: 'A+', max: 5 }] };
    const out = applyScenarioRules(APLUS, rules);
    // P1 rank 1, P1 rank 2, P1 rank 4, P1 unranked, then P2 at the lower file row.
    expect(included(out)).toEqual(['row-10', 'row-11', 'row-12', 'row-14', 'row-16', 'row-17', 'row-18']);
    // An unticked row stays out even though it would rank first.
    expect(out.find((r) => r.key === 'row-19')?.include).toBe(false);
    expect(describeRules(rules)).toBe('at most 5 A+ · merged with the plan');
  });

  it('only / except per dimension, and source = matched or new', () => {
    const r1 = emptyRules('file_only');
    r1.filters.category = { op: 'only', values: ['B'] };
    expect(included(applyScenarioRules(APLUS, r1))).toEqual(['row-17', 'row-18']);
    const r2 = emptyRules('merge');
    r2.filters.priority = { op: 'except', values: ['P1'] };
    r2.filters.source = { op: 'only', values: ['new'] };
    expect(included(applyScenarioRules(APLUS, r2))).toEqual(['row-10', 'row-13', 'row-15', 'row-17']);
    expect(describeRules(r2)).toBe('Priority except P1 · Source only New in file · merged with the plan');
    expect(dimensionValues(APLUS, 'priority')).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(dimensionValues(APLUS, 'source')).toEqual(['matched', 'new']);
  });

  it('a cap of 0 drops the category; unchanged rows keep their identity', () => {
    const out = applyScenarioRules(APLUS, { ...emptyRules('merge'), caps: [{ category: 'B', max: 0 }] });
    expect(included(out)).not.toContain('row-17');
    expect(out[0]).toBe(APLUS[0]);
  });
});

describe('year filter', () => {
  const [file, auto, plan] = SIMULATE_RESPONSE.projects;
  it('filters by served finish week and outcome', () => {
    if (!file || !auto || !plan) throw new Error('fixture');
    expect(projectInYear(file, '2027', 2026)).toBe(true);
    expect(projectInYear(file, '2026', 2026)).toBe(false);
    expect(projectInYear(plan, 'later', 2026)).toBe(true);
    expect(projectInYear(auto, 'not_placed', 2026)).toBe(true);
    expect(projectInYear(auto, '2027', 2026)).toBe(false);
    expect(projectInYear({ finish_week: null, outcome: 'excluded' }, 'all', 2026)).toBe(true);
    expect(projectInYear({ finish_week: null, outcome: 'excluded' }, 'not_placed', 2026)).toBe(false);
  });
  it('uses the served year keys, short labels; a fallback without breakdowns', () => {
    expect(yearOptions(SIMULATE_RESPONSE).map((o) => o.short)).toEqual(['All', '2026', '2027', 'After 2027', 'Not placed']);
    const noBreakdowns = { base_year: 2026, breakdowns: undefined };
    expect(yearOptions(noBreakdowns).map((o) => o.key)).toEqual(['all', '2026', '2027', 'later', 'not_placed']);
  });
});

function variant(): ImportSimulateResponse {
  const [file, auto, plan] = SIMULATE_RESPONSE.projects;
  if (!file || !auto || !plan) throw new Error('fixture');
  return {
    ...SIMULATE_RESPONSE,
    kpis: { ...SIMULATE_RESPONSE.kpis, within_plan_year: 175, spillover: 50 },
    projects: [file, { ...auto, outcome: 'within_year', finish_week: 90 }, { ...file, ref: 'row-5-2', name: 'Copy 2' }],
    capacity: {
      ...SIMULATE_RESPONSE.capacity,
      hubs: [{ hub: 'PD-India', fte: 6.25, windows: [{ key: 'y1', load_weeks: 1, capacity_weeks: 2, booked_pct: 50, status: 'available' }] }],
    },
  };
}

describe('compare helpers', () => {
  it('deltas are the difference of served figures; not placed is the served block total', () => {
    expect(delta(171, 175)).toBe(4);
    expect(delta(null, 3)).toBeNull();
    expect(formatDelta(4)).toBe('+4');
    expect(formatDelta(-2)).toBe('−2');
    expect(formatDelta(0)).toBe('±0');
    expect(notPlacedOf(SIMULATE_RESPONSE)).toBe(1);
    expect(notPlacedOf({ ...SIMULATE_RESPONSE, breakdowns: undefined })).toBeNull();
  });
  it('outcome changes match by ref, with one-sided projects', () => {
    const changes = outcomeChanges(SIMULATE_RESPONSE, variant());
    expect(changes.map((c) => [c.ref, c.a?.outcome ?? null, c.b?.outcome ?? null])).toEqual([
      ['row-6', 'left_out', 'within_year'],
      ['plan-1', 'spillover', null],
      ['row-5-2', null, 'within_year'],
    ]);
  });
  it('capacity booked % per hub and window, side by side', () => {
    const rows = capacityCompare([SIMULATE_RESPONSE, variant()]);
    expect(rows.map((r) => [r.key, r.cells.map((c) => c?.booked_pct ?? null)])).toEqual([
      ['PD-India|y0', [84.17, null]],
      ['PD-India|y1', [75.18, 50]],
    ]);
  });
});

describe('scenarios store', () => {
  beforeEach(() => useImportScenarios.getState().clear());
  const snap = (name: string): NewScenario => ({
    name,
    origin: 'saved',
    rules: null,
    fileName: 'f.xlsx',
    rows: ROWS,
    options: { mode: 'merge', planYearEndWeek: 104, expandMulti: true },
    edits: {},
    response: SIMULATE_RESPONSE,
  });
  it('save / rename / delete, compare at most four, baseline first', () => {
    const st = useImportScenarios.getState;
    const ids = ['A', 'B', 'C', 'D', 'E'].map((n) => st().save(snap(n)));
    expect(st().compareIds).toHaveLength(MAX_COMPARE);
    expect(st().compareIds).not.toContain(ids[4]);
    expect(st().diffPair).toEqual([ids[0], ids[1]]);
    st().rename(ids[0] ?? '', '  Baseline plan  ');
    expect(st().scenarios[0]?.name).toBe('Baseline plan');
    st().rename(ids[0] ?? '', '   ');
    expect(st().scenarios[0]?.name).toBe('Baseline plan');
    st().makeBaseline(ids[2] ?? '');
    expect(st().compareIds[0]).toBe(ids[2]);
    st().remove(ids[2] ?? '');
    expect(st().scenarios.map((s) => s.name)).toEqual(['Baseline plan', 'B', 'D', 'E']);
    expect(st().compareIds).toEqual([ids[0], ids[1], ids[3]]);
    st().toggleCompare(ids[4] ?? '');
    expect(st().compareIds).toHaveLength(4);
  });
});
