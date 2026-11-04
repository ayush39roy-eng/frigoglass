import { describe, expect, it } from 'vitest';

import { buildSimulateRequest, editsForRequest, rosterForRow, withHubOrCategory, type EditMap } from './import-rows';
import { computeBlockedReason, checkImportFile, rowErrors } from './import-schema';
import { PARSE_RESPONSE, ROWS } from './test-fixtures';

const OPTS = {
  mode: 'merge' as const,
  planYearEndWeek: 104 as const,
  expandMulti: false,
};
const row = (i: number) => {
  const r = ROWS[i];
  if (!r) throw new Error('fixture');
  return r;
};

function edit(ref: string, step: string, start: number): EditMap {
  return {
    [`${ref}|${step}`]: {
      project_ref: ref,
      step_id: step,
      duration_weeks: null,
      start_not_before_week: start,
      overlap_weeks: null,
    },
  };
}

describe('review edits → simulate payload', () => {
  it('sends every row with its leader kind, the options and the edits', () => {
    const rows = [
      row(0),
      {
        ...row(1),
        leader: {
          kind: 'existing' as const,
          engineer_id: 'eng-2',
          name: 'Lokesh',
        },
      },
      { ...row(2), leader: { kind: 'new' as const, name: '  Maria  ' } },
    ];
    const body = buildSimulateRequest(
      rows,
      { mode: 'merge', planYearEndWeek: 52, expandMulti: true },
      edit('row-5', 'PDD-E', 50),
    );
    expect(body.mode).toBe('merge');
    expect(body.plan_year_end_week).toBe(52);
    expect(body.expand_multi).toBe(true);
    expect(body.rows.map((r) => r.leader)).toEqual([
      { kind: 'existing', engineer_id: 'eng-1', name: 'Nikos' },
      { kind: 'existing', engineer_id: 'eng-2', name: 'Lokesh' },
      { kind: 'new', name: 'Maria' },
    ]);
    expect(body.edits).toEqual([
      {
        project_ref: 'row-5',
        step_id: 'PDD-E',
        duration_weeks: null,
        start_not_before_week: 50,
        overlap_weeks: null,
      },
    ]);
  });

  it('keeps excluded rows in the body (the server drops them) but not their edits', () => {
    const rows = [{ ...row(0), include: false }, row(1)];
    const body = buildSimulateRequest(rows, OPTS, {
      ...edit('row-5', 'PDD-E', 50),
      ...edit('row-6', 'PDD-B', 60),
    });
    expect(body.rows.map((r) => [r.key, r.include])).toEqual([
      ['row-5', false],
      ['row-6', true],
    ]);
    expect(body.edits.map((e) => e.project_ref)).toEqual(['row-6']);
  });

  it('drops plan-project edits in "This file only" and for a project a matched row replaces', () => {
    const edits = {
      ...edit('plan-1', 'PDD-E', 50),
      ...edit('plan-9', 'PDD-E', 50),
    };
    expect(editsForRequest(edits, ROWS, OPTS).map((e) => e.project_ref)).toEqual(['plan-1']);
    expect(editsForRequest(edits, ROWS, { mode: 'file_only', expandMulti: false })).toEqual([]);
    // Excluding the matched row brings the replaced plan project back.
    const rows = [{ ...row(0), include: false }, row(1)];
    expect(editsForRequest(edits, rows, OPTS).map((e) => e.project_ref)).toEqual(['plan-1', 'plan-9']);
  });

  it('expanded copies (row-5-2) keep their edits only when expansion is on', () => {
    const edits = edit('row-5-2', 'PDD-E', 50);
    expect(editsForRequest(edits, ROWS, { ...OPTS, expandMulti: true })).toHaveLength(1);
    expect(editsForRequest(edits, ROWS, OPTS)).toHaveLength(0);
  });

  it('a hub change to an OEM hub re-keys stage, category and step weeks to the OEM workflow', () => {
    const next = withHubOrCategory(row(1), { hub: 'OEM-HCK' }, PARSE_RESPONSE);
    expect(next.category).toBe('B-OEM');
    expect(next.lead_time_label).toBe('B-OEM');
    expect(Object.keys(next.step_weeks).every((k) => k.startsWith('OEM-'))).toBe(true);
    expect(next.step_weeks['OEM-A']).toBe(4);
    const staged = withHubOrCategory(row(0), { hub: 'OEM-Seitek' }, PARSE_RESPONSE);
    expect(staged.stage_step_id).toBe('OEM-D');
    expect(staged.category).toBe('A-OEM');
    expect(staged.step_weeks['OEM-D']).toBe(2); // no A-OEM row in the file: weeks kept, re-keyed
  });

  it('a category change uses the file lead-time row of that category', () => {
    const next = withHubOrCategory(row(0), { category: 'B' }, PARSE_RESPONSE);
    expect(next.lead_time_label).toBe('B');
    expect(next.step_weeks['PDD-A']).toBe(3);
  });

  it('roster: the row capacity hub first (OEM rows → R&D-Greece)', () => {
    expect(rosterForRow(PARSE_RESPONSE.roster, 'PD-India').own.map((e) => e.name)).toEqual(['Lokesh', 'Priya']);
    expect(rosterForRow(PARSE_RESPONSE.roster, 'OEM-HCK').own.map((e) => e.name)).toEqual(['Nikos']);
  });

  it('client checks: file type and size, blank new designer, nothing included', () => {
    expect(checkImportFile({ name: 'plan.xlsx', size: 10 })).toBeNull();
    expect(checkImportFile({ name: 'plan.xls', size: 10 })).toMatch(/xlsx/);
    expect(checkImportFile({ name: 'plan.xlsx', size: 5 * 1024 * 1024 + 1 })).toMatch(/5 MB/);
    const blank = [{ ...row(2), leader: { kind: 'new' as const, name: '  ' } }];
    expect(rowErrors(blank)).toEqual({
      'row-7': 'Type the new designer’s name.',
    });
    expect(computeBlockedReason(blank)).toMatch(/engineer name/);
    expect(computeBlockedReason(ROWS.map((r) => ({ ...r, include: false })))).toMatch(/at least one/);
    expect(computeBlockedReason(ROWS)).toBeNull();
  });
});
