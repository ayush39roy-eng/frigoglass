import { describe, expect, it } from 'vitest';

import { buildScoringModel, formatWeight } from './scoring-model';

describe('scoring model (ADR 0029)', () => {
  it('uses the new labels and pillars, with ROI under Investment & Feasibility', () => {
    const m = buildScoringModel(null);
    const gp = m.dimensions.find((d) => d.key === 'gross_margins');
    const roi = m.dimensions.find((d) => d.key === 'profitability');
    expect(gp?.label).toBe('Gross Profitability');
    expect(roi?.label).toBe('ROI');
    expect(roi?.pillar).toBe('Investment & Feasibility');
    expect(m.total_weight).toBeNull();
  });

  it('prefers the served table and shows served scaled weights', () => {
    const m = buildScoringModel({
      total_weight: 295,
      dimensions: [{ key: 'profitability', label: 'ROI', pillar: 'Investment & Feasibility', weight: 25, scaled_weight: 8.47 }],
    });
    const roi = m.dimensions.find((d) => d.key === 'profitability');
    expect(formatWeight(roi?.weight ?? 0, roi?.scaled_weight ?? null)).toBe('25 (8.5 of 100)');
    expect(m.total_weight).toBe(295);
  });
});
