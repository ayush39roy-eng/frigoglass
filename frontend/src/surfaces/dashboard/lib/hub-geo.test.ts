import { describe, expect, it } from 'vitest';

import type { HubTypePipelineRow } from '../api/types';
import { buildHubTotals, HUB_COUNTRY, hubCountryMap } from './hub-geo';

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

  it('places the OEM hubs in Europe (Greece), not India — client correction 2026-10-13', () => {
    expect(HUB_COUNTRY['OEM-HCK']).toBe('Greece');
    expect(HUB_COUNTRY['OEM-Seltek']).toBe('Greece');
  });

  it('prefers the served GET /hubs lab_region over the fallback map', () => {
    const map = hubCountryMap([
      { name: 'OEM-HCK', lab_region: 'Greece' },
      { name: 'PD-Romania', lab_region: 'Romania' },
      { name: 'R&D-India', lab_region: 'India' },
    ]);
    expect(map['OEM-HCK']).toBe('Greece');
    expect(map['OEM-Seltek']).toBe('Greece'); // fallback, not served here
    expect(hubCountryMap([{ name: 'R&D-Greece', lab_region: 'Romania' }])['R&D-Greece']).toBe('Romania');
    expect(hubCountryMap(undefined)).toEqual(HUB_COUNTRY);
    expect(buildHubTotals([{ hub: 'OEM-Seltek', type: 'NM', count: 2 }], map)[0]?.country).toBe('Greece');
  });
});
