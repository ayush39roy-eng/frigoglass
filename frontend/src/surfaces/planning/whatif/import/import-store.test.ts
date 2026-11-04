import { beforeEach, describe, expect, it } from 'vitest';

import { useImportPlan } from './import-store';
import { PARSE_RESPONSE, SIMULATE_RESPONSE } from './test-fixtures';

const s = () => useImportPlan.getState();

describe('import store (session only)', () => {
  beforeEach(() => s().reset());

  it('a parse moves to Review with the served rows, default options and no edits', () => {
    s().applyEdit('plan-1', 'PDD-E', { start_not_before_week: 60 }, {});
    s().setResult(SIMULATE_RESPONSE);
    s().setParsed(PARSE_RESPONSE);
    expect(s().step).toBe('review');
    expect(s().rows).toEqual(PARSE_RESPONSE.rows);
    expect(s().rows[0]).not.toBe(PARSE_RESPONSE.rows[0]);
    expect(s().options).toEqual({
      mode: 'merge',
      planYearEndWeek: 104,
      expandMulti: false,
    });
    expect(s().edits).toEqual({});
    expect(s().result).toBeNull();
  });

  it('updates a row, options and include-all', () => {
    s().setParsed(PARSE_RESPONSE);
    const row = s().rows[1];
    if (!row) throw new Error('fixture');
    s().updateRow('row-6', { ...row, priority: 'P1' });
    expect(s().rows[1]?.priority).toBe('P1');
    s().setOptions({ mode: 'file_only' });
    expect(s().options).toMatchObject({
      mode: 'file_only',
      planYearEndWeek: 104,
    });
    s().setAllIncluded(false);
    expect(s().rows.every((r) => !r.include)).toBe(true);
  });

  it('a first edit starts from the served timing triple; later edits keep earlier fields', () => {
    s().applyEdit(
      'plan-1',
      'PDD-E',
      { start_not_before_week: 60, overlap_weeks: null },
      { duration_weeks: 5, start_not_before_week: null, overlap_weeks: 1 },
    );
    expect(s().edits['plan-1|PDD-E']).toEqual({
      project_ref: 'plan-1',
      step_id: 'PDD-E',
      duration_weeks: 5,
      start_not_before_week: 60,
      overlap_weeks: null,
    });
    s().applyEdit('plan-1', 'PDD-E', { duration_weeks: 7 }, { duration_weeks: 5 });
    expect(s().edits['plan-1|PDD-E']).toMatchObject({
      duration_weeks: 7,
      start_not_before_week: 60,
    });
  });

  it('an edit that sets nothing is dropped; undo and reset work', () => {
    s().applyEdit('row-5', 'PDD-E', { start_not_before_week: 50 }, {});
    s().applyEdit('row-5', 'PDD-F', { duration_weeks: 3 }, {});
    expect(Object.keys(s().edits)).toHaveLength(2);
    s().undoEdit();
    expect(Object.keys(s().edits)).toEqual(['row-5|PDD-E']);
    s().resetEdits();
    expect(s().edits).toEqual({});
    s().undoEdit();
    expect(Object.keys(s().edits)).toEqual(['row-5|PDD-E']);
    s().applyEdit('row-5', 'PDD-E', { start_not_before_week: null }, {});
    expect(s().edits).toEqual({});
  });

  it('prunes edits that no longer apply', () => {
    s().setParsed(PARSE_RESPONSE);
    s().applyEdit('plan-9', 'PDD-E', { start_not_before_week: 50 }, {});
    s().applyEdit('plan-1', 'PDD-E', { start_not_before_week: 50 }, {});
    s().applyEdit('row-6', 'PDD-E', { start_not_before_week: 50 }, {});
    s().pruneEdits();
    expect(Object.keys(s().edits).sort()).toEqual(['plan-1|PDD-E', 'row-6|PDD-E']);
    s().setOptions({ mode: 'file_only' });
    s().pruneEdits();
    expect(Object.keys(s().edits)).toEqual(['row-6|PDD-E']);
  });
});
