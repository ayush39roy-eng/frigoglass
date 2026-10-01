import { describe, expect, it } from 'vitest';

import { hubRow } from '../test-fixtures';
import { portfolioTotals } from './portfolio-totals';

/**
 * The live `GET /capacity/hub-load` shape as of 2026-10-01: six hubs, three lab
 * regions, with India repeated on four of them carrying one identical lab figure.
 * Values are the real served ones, so the double-count this module exists to
 * prevent is asserted against reality rather than a contrived fixture.
 */
const LIVE_ROWS = [
  hubRow({ hub: 'R&D-Greece', lab_region: 'Greece', design_load_weeks: 55, design_capacity_year: 124.88, lab_load_weeks: 34, lab_capacity_year: 73.34 }),
  hubRow({ hub: 'R&D-India', lab_region: 'India', design_load_weeks: 66, design_capacity_year: 132.5, lab_load_weeks: 122, lab_capacity_year: 188.3 }),
  hubRow({ hub: 'PD-India', lab_region: 'India', design_load_weeks: 163, design_capacity_year: 198.75, lab_load_weeks: 122, lab_capacity_year: 188.3 }),
  hubRow({ hub: 'PD-Romania', lab_region: 'Romania', design_load_weeks: 70, design_capacity_year: 123.2, lab_load_weeks: 36, lab_capacity_year: 216.3 }),
  hubRow({ hub: 'OEM-HCK', lab_region: 'India', design_load_weeks: 7, design_capacity_year: 0, lab_load_weeks: 122, lab_capacity_year: 188.3 }),
  hubRow({ hub: 'OEM-Seltek', lab_region: 'India', design_load_weeks: 14, design_capacity_year: 0, lab_load_weeks: 122, lab_capacity_year: 188.3 }),
];

describe('portfolioTotals', () => {
  it('sums design figures over every hub row', () => {
    const totals = portfolioTotals(LIVE_ROWS);
    expect(totals.designLoad).toBe(55 + 66 + 163 + 70 + 7 + 14);
    expect(totals.designCapacity).toBeCloseTo(124.88 + 132.5 + 198.75 + 123.2, 2);
  });

  it('counts each lab region ONCE, however many hubs repeat it', () => {
    const totals = portfolioTotals(LIVE_ROWS);
    expect(totals.labRegionCount).toBe(3);
    // Greece 34 + India 122 (not 4x122) + Romania 36
    expect(totals.labLoad).toBe(192);
    expect(totals.labCapacity).toBeCloseTo(73.34 + 188.3 + 216.3, 2);
  });

  it('does not round — two-decimal supply figures survive intact (ADR 0008 / I17)', () => {
    const totals = portfolioTotals([
      hubRow({ hub: 'R&D-Greece', lab_region: 'Greece', design_capacity_year: 179.75, lab_capacity_year: 0.33 }),
      hubRow({ hub: 'PD-Romania', lab_region: 'Romania', design_capacity_year: 0.5, lab_capacity_year: 0.33 }),
    ]);
    expect(totals.designCapacity).toBe(180.25);
    expect(totals.labCapacity).toBeCloseTo(0.66, 2);
  });

  it('returns zeros for an empty row set rather than NaN', () => {
    expect(portfolioTotals([])).toEqual({
      designLoad: 0,
      designCapacity: 0,
      labLoad: 0,
      labCapacity: 0,
      labRegionCount: 0,
    });
  });
});
