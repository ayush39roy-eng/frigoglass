import { describe, expect, it } from 'vitest';

import { settingsFixture } from '../test-fixtures';
import { heatStyle, labKindSteps, matrixChangeSet, matrixSummary, matrixTotals, parseWeeks, setWeeks } from './effort-matrix';

describe('P52-T01 effort-matrix helpers', () => {
  it('parseWeeks: whole weeks 0..104, empty = 0, anything else refused', () => {
    expect(parseWeeks('')).toBe(0);
    expect(parseWeeks(' 7 ')).toBe(7);
    expect(parseWeeks('104')).toBe(104);
    for (const bad of ['105', '-1', '1.5', 'abc', '1e2']) expect(parseWeeks(bad)).toBeNull();
  });

  it('setWeeks keeps a draft only while it differs from the saved value (gap drafts untouched)', () => {
    const saved = { 'PDD-E': { weeks: 6, gap_weeks: 0 } };
    const d1 = setWeeks({}, saved, 'PDD-E', 7);
    expect(d1).toEqual({ 'PDD-E': { weeks: 7 } });
    expect(setWeeks(d1, saved, 'PDD-E', 6)).toEqual({});
    expect(setWeeks({ 'PDD-E': { weeks: 7, gap_weeks: -1 } }, saved, 'PDD-E', 6)).toEqual({ 'PDD-E': { gap_weeks: -1 } });
  });

  it('matrixTotals sums all, design-kind and lab-kind weeks', () => {
    const kinds: Record<string, 'design' | 'lab' | 'elapsed'> = { a: 'design', b: 'lab', c: 'elapsed' };
    const weeks: Record<string, number> = { a: 3, b: 4, c: 5 };
    expect(matrixTotals(['a', 'b', 'c'], (id) => weeks[id]!, (id) => kinds[id]!)).toEqual({ total: 12, design: 3, lab: 4, labLength: 4 });
  });

  it('heatStyle: none for 0, green for few weeks, red for the most', () => {
    expect(heatStyle(0, 8)).toBeUndefined();
    expect(heatStyle(1, 8)?.backgroundColor).toMatch(/^hsl\(105 /);
    expect(heatStyle(8, 8)?.backgroundColor).toMatch(/^hsl\(0 /);
  });

  it('matrixChangeSet / matrixSummary: one entry per drafted (workflow, category) with its base_version', () => {
    const drafts = { PDD: { 'A+': { 'PDD-E': { weeks: 7 }, 'PDD-H': { gap_weeks: -2 } }, B: {} } };
    expect(matrixChangeSet(drafts, { 'A+': 3 })).toEqual({
      changes: [
        { workflow_id: 'PDD', category: 'A+', base_version: 3, steps: [{ step_id: 'PDD-E', weeks: 7 }, { step_id: 'PDD-H', gap_weeks: -2 }] },
      ],
    });
    const saved = { 'PDD-E': { weeks: 6, gap_weeks: 0 }, 'PDD-H': { weeks: 6, gap_weeks: 0 } };
    expect(matrixSummary(drafts, () => saved)).toEqual(['A+ · PDD-E length 6w → 7w', 'A+ · PDD-H gap 0w → −2w']);
  });

  it('labKindSteps follows the served kinds, PDD first, in sequence order', () => {
    const s = settingsFixture();
    expect(labKindSteps(s.workflows).map((x) => x.stepId)).toEqual(['PDD-F', 'PDD-H']);
    s.workflows[0]!.steps = s.workflows[0]!.steps.map((st) => (st.step_id === 'PDD-J' ? { ...st, kind: 'lab' } : st));
    expect(labKindSteps(s.workflows).map((x) => x.stepId)).toEqual(['PDD-F', 'PDD-H', 'PDD-J']);
  });
});
