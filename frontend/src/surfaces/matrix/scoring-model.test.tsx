import { describe, expect, it } from 'vitest';

import { buildScoringModel, formatWeight, layoutDimensions } from './lib/scoring-model-core';
import { FOURTEEN_TEST_DIMENSIONS, testDimensionScores, testDimensionTable, uniformScores } from './test-fixtures';

describe('scoring model (ADR 0029; P26 ADR 0037)', () => {
  it('is empty until the table is served — no static dimension list', () => {
    const m = buildScoringModel(null);
    expect(m.loaded).toBe(false);
    expect(m.dimensions).toEqual([]);
    expect(m.total_weight).toBeNull();
    expect(m.rubric_version).toBeNull();
  });

  it('uses the served table: any number of dimensions, served order, weights, total and rubric version', () => {
    const m = buildScoringModel(testDimensionTable(FOURTEEN_TEST_DIMENSIONS, 3));
    expect(m.loaded).toBe(true);
    expect(m.dimensions).toHaveLength(14);
    expect(m.dimensions.at(-1)).toMatchObject({ key: 'sustainability_esg', pillar: 'Sustainability', weight: 30 });
    expect(m.total_weight).toBe(325);
    expect(m.rubric_version).toBe(3);
    const roi = m.dimensions.find((d) => d.key === 'profitability');
    expect(formatWeight(roi?.weight ?? 0, roi?.scaled_weight ?? null)).toBe('25 (7.7 of 100)');
  });

  it('lays out the served table, else the first row with dimensions', () => {
    const rows = [{ dimension_scores: [] }, { dimension_scores: testDimensionScores(uniformScores(2)) }];
    expect(layoutDimensions(buildScoringModel(null), rows).map((d) => d.key)).toHaveLength(13);
    expect(layoutDimensions(buildScoringModel(testDimensionTable(FOURTEEN_TEST_DIMENSIONS)), rows)).toHaveLength(14);
    expect(layoutDimensions(buildScoringModel(null), [])).toEqual([]);
  });
});
