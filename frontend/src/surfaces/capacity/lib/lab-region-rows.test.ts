import { describe, expect, it } from 'vitest';

import { hubRow } from '../test-fixtures';
import { labRegionRows } from './lab-region-rows';

describe('labRegionRows', () => {
  it('returns each lab region once, in first-seen order, with the hubs that share it', () => {
    const rows = [
      hubRow({ hub: 'R&D-India', lab_region: 'India', lab_load_weeks: 122 }),
      hubRow({ hub: 'R&D-Greece', lab_region: 'Greece', lab_load_weeks: 34 }),
      hubRow({ hub: 'PD-India', lab_region: 'India', lab_load_weeks: 122 }),
    ];
    const out = labRegionRows(rows);
    expect(out.map((r) => r.region)).toEqual(['India', 'Greece']);
    expect(out[0]?.hubs).toEqual(['R&D-India', 'PD-India']);
    // The served region figure is read, never added across its hubs.
    expect(out[0]?.row.lab_load_weeks).toBe(122);
  });

  it('returns nothing for no rows', () => {
    expect(labRegionRows([])).toEqual([]);
  });
});
