import { describe, expect, it } from 'vitest';

import type { WorkflowStepKind } from '@/types/enums';

import { buildLeadTimeGrid, changedLeadTimes, rowTotals, type LeadTimeCell } from './lead-times';

const STEP_IDS = Array.from({ length: 14 }, (_, i) => `PDD-${String.fromCharCode(65 + i)}`);
// PDD kinds (ADR 0007): design = A B D E I J K M; lab = F H; elapsed = C G L N
const KINDS: Record<string, WorkflowStepKind> = Object.fromEntries(
  STEP_IDS.map((id) => {
    const letter = id.slice(-1);
    const kind: WorkflowStepKind = 'FH'.includes(letter) ? 'lab' : 'CGLN'.includes(letter) ? 'elapsed' : 'design';
    return [id, kind];
  }),
);
// docs/CLIENT_FORMULAS.md §1.1, category A+
const A_PLUS = [1, 8, 4, 1, 6, 6, 2, 6, 2, 1, 2, 3, 1, 1];
const B = [1, 0, 0, 1, 4, 0, 0, 6, 0, 1, 2, 1, 1, 1];

function rows(cat: 'A+' | 'B', weeks: number[]): LeadTimeCell[] {
  return weeks.map((w, i) => ({ workflow_id: 'PDD', category: cat, step_id: STEP_IDS[i]!, weeks: w }));
}

describe('lead-time grid sums (the workbook’s own row formulas)', () => {
  it('A+ sums to 44 total, 22 design, 12 lab, 10 elapsed', () => {
    const grid = buildLeadTimeGrid(rows('A+', A_PLUS), 'PDD', STEP_IDS);
    const aPlus = grid.find((r) => r.category === 'A+')!;
    expect(rowTotals(aPlus.cells, KINDS)).toEqual({ total: 44, design: 22, lab: 12, elapsed: 10 });
  });

  it('B sums to 18 total, 10 design, 6 lab, 2 elapsed — A and J kept as design (ADR 0007 / OQ #13; the workbook’s 8 omits them)', () => {
    const grid = buildLeadTimeGrid(rows('B', B), 'PDD', STEP_IDS);
    const b = grid.find((r) => r.category === 'B')!;
    expect(rowTotals(b.cells, KINDS)).toEqual({ total: 18, design: 10, lab: 6, elapsed: 2 });
  });

  it('builds every category row for the workflow, reading a missing server cell as 0', () => {
    const grid = buildLeadTimeGrid(rows('A+', A_PLUS), 'PDD', STEP_IDS);
    expect(grid.map((r) => r.category)).toEqual(['A+', 'A', 'B', 'C']);
    expect(grid.find((r) => r.category === 'C')!.cells['PDD-A']).toBe(0);
    expect(buildLeadTimeGrid([], 'OEM', STEP_IDS).map((r) => r.category)).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
  });

  it('changedLeadTimes emits only the edited cells as PUT rows', () => {
    const original = buildLeadTimeGrid(rows('A+', A_PLUS), 'PDD', STEP_IDS);
    const edited = original.map((r) =>
      r.category === 'A+' ? { ...r, cells: { ...r.cells, 'PDD-B': 6 } } : r,
    );
    expect(changedLeadTimes(original, edited, 'PDD')).toEqual([
      { workflow_id: 'PDD', category: 'A+', step_id: 'PDD-B', weeks: 6 },
    ]);
  });
});
