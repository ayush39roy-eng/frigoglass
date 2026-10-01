import { describe, expect, it } from 'vitest';

import type { HubTypePipelineRow } from '../api/types';
import { buildHubMarkers, HUB_ANCHORS, HUB_COUNTRY } from './hub-geo';

describe('buildHubMarkers', () => {
  it('sums real per-(hub,type) counts down to one marker per hub, ranked by count', () => {
    const rows: HubTypePipelineRow[] = [
      { hub: 'R&D-Greece', type: 'NM', count: 3 },
      { hub: 'R&D-Greece', type: 'CO', count: 2 },
      { hub: 'PD-India', type: 'NM', count: 10 },
      { hub: 'PD-Romania', type: null, count: 1 },
    ];

    const markers = buildHubMarkers(rows);

    expect(markers.map((m) => m.hub)).toEqual(['PD-India', 'R&D-Greece', 'PD-Romania']);
    expect(markers.find((m) => m.hub === 'R&D-Greece')?.count).toBe(5);
    expect(markers.find((m) => m.hub === 'PD-India')?.count).toBe(10);
  });

  it('omits hubs with no projects in scope rather than showing a fabricated zero marker', () => {
    const markers = buildHubMarkers([{ hub: 'R&D-Greece', type: 'NM', count: 1 }]);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.hub).toBe('R&D-Greece');
  });

  it('has a real anchor and country for every one of the six DOMAIN_RULES.md hubs', () => {
    const hubs = Object.keys(HUB_ANCHORS);
    expect(hubs).toHaveLength(6);
    for (const hub of hubs) {
      expect(HUB_COUNTRY[hub as keyof typeof HUB_COUNTRY]).toMatch(/Greece|India|Romania/);
    }
  });

  it('returns an empty list for an empty response', () => {
    expect(buildHubMarkers([])).toEqual([]);
  });
});
