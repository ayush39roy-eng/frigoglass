import { describe, expect, it } from 'vitest';

import type { PriorityMatrixRow } from '../api/types';
import { P13_MATRIX_ROW_DEFAULTS, testDimensionScores } from '../test-fixtures';
import { buildGridApplyBody, changedProjectIds, parseScoreInput, setDraftGate, setDraftScore } from './grid-edit';
import { distributionFromRows, narrowByBand, narrowExceptBand, rowLastScoreVersion, sortMatrixRows } from './matrix-rows';

function row(overrides: Partial<PriorityMatrixRow> = {}): PriorityMatrixRow {
  return {
    priority_applicable: true,
    project_id: 'p1', project_name: 'Cooler A', hub: 'R&D-Greece', category: 'A', type: 'NM', set_priority: 'P2',
    has_score: true, hard_gates: [], weighted_score: 200, normalized_pct: 70, suggested_band: 'P1',
    is_new_model: false, is_rm_saving_project: false, currency: 'EUR', capex_keur: null, rm_savings_keur: null,
    tcogs_eur: null, selling_price_eur: null, gross_margin_pct: null,
    ...P13_MATRIX_ROW_DEFAULTS,
    dimension_scores: testDimensionScores({ strategic_project: 5, new_customer: 3 }),
    ...overrides,
  };
}

const NONE = { q: '', hubText: '', leaderText: '', capacityFill: false, vipOnly: false };

describe('matrix-rows (P34-T02, D34-2 / D34-3)', () => {
  it('searches the loaded rows by name and, when served, external code (case-insensitive)', () => {
    const rows = [
      row({ project_id: 'a', project_name: 'Evaporator Retrofit' }),
      { ...row({ project_id: 'b', project_name: 'Door seal' }), external_code: 'FG-EVA-7' } as PriorityMatrixRow,
      row({ project_id: 'c', project_name: 'Chest' }),
    ];
    expect(narrowExceptBand(rows, { ...NONE, q: ' eva ' }).map((r) => r.project_id)).toEqual(['a', 'b']);
    expect(narrowExceptBand(rows, { ...NONE, q: 'fg-eva' }).map((r) => r.project_id)).toEqual(['b']);
  });

  it('P34-T03: a served null code, or a pre-P34-T03 row without the field, searches by name only', () => {
    const older: Partial<PriorityMatrixRow> = row({ project_id: 'b', project_name: 'Door seal' });
    delete older.external_code;
    const rows = [row({ project_id: 'a', project_name: 'Chest', external_code: null }), older as PriorityMatrixRow];
    expect(narrowExceptBand(rows, { ...NONE, q: 'door' }).map((r) => r.project_id)).toEqual(['b']);
    expect(narrowExceptBand(rows, { ...NONE, q: 'fg-' })).toEqual([]);
  });

  it('Hub, Leader ("unavailable"), VIP and capacity fill narrow; the band is separate', () => {
    const rows = [
      row({ project_id: 'a', hub: 'PD-India', leader_engineer_id: 'e1', is_vip: true }),
      row({ project_id: 'b', leader_name: 'Rishi', capacity_fill: true, suggested_band: 'P1' }),
      row({ project_id: 'c', suggested_band: 'P3' }),
    ];
    expect(narrowExceptBand(rows, { ...NONE, hubText: 'india' }).map((r) => r.project_id)).toEqual(['a']);
    expect(narrowExceptBand(rows, { ...NONE, leaderText: 'unavail' }).map((r) => r.project_id)).toEqual(['a']);
    expect(narrowExceptBand(rows, { ...NONE, vipOnly: true }).map((r) => r.project_id)).toEqual(['a']);
    expect(narrowExceptBand(rows, { ...NONE, capacityFill: true }).map((r) => r.project_id)).toEqual(['b']);
    expect(narrowByBand(rows, 'P3').map((r) => r.project_id)).toEqual(['c']);
  });

  it('sorts once: VIP first, then served rank, then served score, then name', () => {
    const rows = [
      row({ project_id: 'low', project_name: 'B', rank: 3 }),
      row({ project_id: 'none', project_name: 'G', rank: null, weighted_score: null, has_score: false }),
      row({ project_id: 'vip', project_name: 'V', rank: 9, is_vip: true }),
      row({ project_id: 'top', project_name: 'Z', rank: 1 }),
    ];
    expect(sortMatrixRows(rows).map((r) => r.project_id)).toEqual(['vip', 'top', 'low', 'none']);
  });

  it('counts the served bands of the rows given; Q stays 0; fill counts capacity_fill', () => {
    const d = distributionFromRows([
      row({ suggested_band: 'P1', capacity_fill: true }),
      row({ suggested_band: 'P2' }),
      row({ suggested_band: null, has_score: false }),
    ]);
    const count = (b: string) => d.band_distribution.find((e) => e.band === b);
    expect(count('P1')).toEqual({ band: 'P1', count: 1, share_pct: 33.3 });
    expect(count('Unscored')?.count).toBe(1);
    expect(count('Q')?.count).toBe(0);
    expect(d.capacity_fill_count).toBe(1);
    expect(d.total_projects).toBe(3);
    expect(distributionFromRows([]).band_distribution.every((e) => e.count === 0 && e.share_pct === 0)).toBe(true);
  });

  it('last_score_version absent from an older API reads as null', () => {
    const older = { ...row() } as Partial<PriorityMatrixRow>;
    delete older.last_score_version;
    expect(rowLastScoreVersion(older as PriorityMatrixRow)).toBeNull();
    const v = { version: 3, created_at: '2026-11-01T00:00:00Z', applied_by_name: 'Ada' };
    expect(rowLastScoreVersion(row({ last_score_version: v }))).toEqual(v);
  });
});

describe('grid-edit (P34-T02, D34-1)', () => {
  it('parses 0–5 or empty (null, not scored); anything else is rejected', () => {
    expect(parseScoreInput('0')).toBe(0);
    expect(parseScoreInput('5')).toBe(5);
    expect(parseScoreInput(' ')).toBeNull();
    expect(parseScoreInput('6')).toBeUndefined();
    expect(parseScoreInput('a')).toBeUndefined();
  });

  it('keeps only drafts that differ from the base; one body with full maps and gates', () => {
    const a = row({ project_id: 'a' });
    const b = row({ project_id: 'b', hard_gates: ['Active safety non-compliance'] });
    let drafts = setDraftScore({}, a, 'strategic_project', 2);
    drafts = setDraftGate(drafts, b, 'Active safety non-compliance', false);
    expect(changedProjectIds(drafts, [a, b])).toEqual(['a', 'b']);
    // Back to the base value: the draft is dropped.
    expect(Object.keys(setDraftScore(drafts, a, 'strategic_project', 5))).toEqual(['b']);

    const body = buildGridApplyBody(drafts, [a, b], '  ');
    expect(body.notes).toBeNull();
    expect(body.priority_scores).toHaveLength(2);
    const [first, second] = body.priority_scores;
    expect(Object.keys(first?.scores ?? {})).toEqual(a.dimension_scores.map((d) => d.key));
    expect(first?.scores.strategic_project).toBe(2);
    expect(first?.scores.new_customer).toBe(3);
    expect(second?.hard_gates).toEqual([]);
  });
});
