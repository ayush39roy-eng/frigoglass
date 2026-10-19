import { describe, expect, it } from 'vitest';

import { groupRows } from './group-rows';

describe('groupRows (P13-T17)', () => {
  it('groups in canonical order, unknown keys last, keeping served row order', () => {
    const rows = [
      { n: 'a', g: 'India' },
      { n: 'b', g: 'Zeta' },
      { n: 'c', g: 'Greece' },
      { n: 'd', g: 'India' },
      { n: 'e', g: 'Alpha' },
    ];
    const groups = groupRows(rows, (r) => r.g, ['Greece', 'India', 'Romania']);
    expect(groups.map((g) => g.key)).toEqual(['Greece', 'India', 'Alpha', 'Zeta']);
    expect(groups[1]!.rows.map((r) => r.n)).toEqual(['a', 'd']);
  });

  it('returns no groups for no rows', () => {
    expect(groupRows([], () => 'x')).toEqual([]);
  });
});
