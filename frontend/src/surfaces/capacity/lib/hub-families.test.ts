import { describe, expect, it } from 'vitest';

import { firstHubPerLabRegion, groupByHubFamily, hubFamily } from './hub-families';

describe('hub-families (P19-T06)', () => {
  it('maps the hub name prefix to its family', () => {
    expect(hubFamily('R&D-Greece').key).toBe('rd');
    expect(hubFamily('R&D-India').label).toBe('R&D');
    expect(hubFamily('PD-Romania').label).toBe('PD (Product Development)');
    expect(hubFamily('OEM-Seitek').key).toBe('oem');
    expect(hubFamily('Lab-Nowhere').key).toBe('other');
  });

  it('groups in family order, keeps served order inside a family, omits empty families', () => {
    const rows = [{ hub: 'OEM-HCK' }, { hub: 'PD-India' }, { hub: 'X-New' }, { hub: 'OEM-Seitek' }];
    expect(groupByHubFamily(rows).map((g) => [g.family.key, g.rows.map((r) => r.hub)])).toEqual([
      ['pd', ['PD-India']],
      ['oem', ['OEM-HCK', 'OEM-Seitek']],
      ['other', ['X-New']],
    ]);
  });

  it('names the first hub of each lab region in display order', () => {
    const m = firstHubPerLabRegion([
      { hub: 'R&D-Greece', lab_region: 'Greece' },
      { hub: 'R&D-India', lab_region: 'India' },
      { hub: 'PD-India', lab_region: 'India' },
      { hub: 'OEM-HCK', lab_region: 'Greece' },
    ]);
    expect(Object.fromEntries(m)).toEqual({ Greece: 'R&D-Greece', India: 'R&D-India' });
  });
});
