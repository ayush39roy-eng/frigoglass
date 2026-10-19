import { describe, expect, it } from 'vitest';

import { formatServedPct, pivotCompleting, typeCode, typeLabel } from './analytics';

describe('analytics layout helpers (P13-T10)', () => {
  it('labels served type keys, including Unmapped', () => {
    expect(typeLabel('CO')).toBe('Cost Optimization');
    expect(typeLabel('Unmapped')).toBe('Unmapped');
    expect(typeLabel(null)).toBe('Unmapped');
    expect(typeCode('NM')).toBe('NM');
    expect(typeCode('Unmapped')).toBe('—');
  });

  it('prints a served percentage as served (no re-rounding)', () => {
    expect(formatServedPct(8.54)).toBe('8.54%');
    expect(formatServedPct(100)).toBe('100%');
  });

  it('pivots served cells: canonical hub order, served type order, served totals', () => {
    const pivot = pivotCompleting(
      [
        { hub: 'PD-India', type: 'CO', pipeline_count: 82, completing_count: 7, completing_pct: 8.54 },
        { hub: 'R&D-Greece', type: 'NM', pipeline_count: 5, completing_count: 1, completing_pct: 20 },
        { hub: 'PD-India', type: null, pipeline_count: 2, completing_count: 0, completing_pct: 0 },
      ],
      [
        { key: 'NM', pipeline_count: 5, completing_count: 1, completing_pct: 20 },
        { key: 'CO', pipeline_count: 89, completing_count: 10, completing_pct: 11.24 },
      ],
    );
    expect(pivot.hubs).toEqual(['R&D-Greece', 'PD-India']);
    expect(pivot.types).toEqual(['NM', 'CO', 'Unmapped']);
    expect(pivot.cell('PD-India', 'CO')?.completing_pct).toBe(8.54);
    expect(pivot.cell('PD-India', 'Unmapped')?.pipeline_count).toBe(2);
    expect(pivot.cell('R&D-Greece', 'CO')).toBeNull();
    // The Total row is the served per-type row, never a column sum.
    expect(pivot.total('CO')?.completing_count).toBe(10);
    expect(pivot.total('Unmapped')).toBeNull();
    expect(pivot.hubTotal('PD-India')).toBeNull();
  });

  it('exposes served per-hub totals, adding a hub that only appears there', () => {
    const pivot = pivotCompleting([], [], [
      { key: 'PD-Romania', pipeline_count: 24, completing_count: 11, completing_pct: 45.83 },
    ]);
    expect(pivot.hubs).toEqual(['PD-Romania']);
    expect(pivot.hubTotal('PD-Romania')?.completing_pct).toBe(45.83);
  });
});
