import { describe, expect, it } from 'vitest';

import type { HubTypePipelineRow } from '../api/types';
import { buildHubTotals, HUB_COUNTRY } from './hub-geo';

describe('buildHubTotals', () => {
  it('sums real per-(hub,type) counts down to one total per hub, ranked by count', () => {
    const rows: HubTypePipelineRow[] = [
      { hub: 'R&D-Greece', type: 'NM', count: 3 },
      { hub: 'R&D-Greece', type: 'CO', count: 2 },
      { hub: 'PD-India', type: 'NM', count: 10 },
      { hub: 'PD-Romania', type: null, count: 1 },
    ];

    const totals = buildHubTotals(rows);

    expect(totals.map((t) => t.hub)).toEqual(['PD-India', 'R&D-Greece', 'PD-Romania']);
    expect(totals.find((t) => t.hub === 'R&D-Greece')?.count).toBe(5);
    expect(totals.find((t) => t.hub === 'PD-India')?.count).toBe(10);
    // A real country label, never a fabricated business number.
    expect(totals.find((t) => t.hub === 'PD-India')?.country).toBe('India');
  });

  it('omits hubs with no projects in scope rather than showing a fabricated zero row', () => {
    const totals = buildHubTotals([{ hub: 'R&D-Greece', type: 'NM', count: 1 }]);
    expect(totals).toHaveLength(1);
    expect(totals[0]?.hub).toBe('R&D-Greece');
  });

  it('has a real country for every one of the six DOMAIN_RULES.md hubs', () => {
    const hubs = Object.keys(HUB_COUNTRY);
    expect(hubs).toHaveLength(6);
    for (const hub of hubs) {
      expect(HUB_COUNTRY[hub as keyof typeof HUB_COUNTRY]).toMatch(/Greece|India|Romania/);
    }
  });

  it('returns an empty list for an empty response', () => {
    expect(buildHubTotals([])).toEqual([]);
  });
});
