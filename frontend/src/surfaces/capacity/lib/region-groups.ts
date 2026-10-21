import type { LabRegion } from '@/types/enums';

import type { HubCapacityRow } from '../api/types';

/**
 * P19-T02: the served hub rows grouped by their lab region, for display only.
 * Lab load / capacity / booked % are region-level (I7, ADR 0016): every hub row
 * of a region carries the same served lab figures, so the summary table shows
 * them ONCE per group, read from the group's first row. Nothing is summed or
 * derived here; hub order inside a group is the served order.
 *
 * Display order is Greece, Romania, India (the owner's reading order); any
 * region not listed keeps its first-appearance order after those.
 */
const DISPLAY_ORDER: readonly string[] = ['Greece', 'Romania', 'India'];

export interface RegionGroup {
  region: LabRegion;
  rows: HubCapacityRow[];
}

export function groupRowsByLabRegion(rows: readonly HubCapacityRow[]): RegionGroup[] {
  const groups = new Map<string, RegionGroup>();
  for (const row of rows) {
    const hit = groups.get(row.lab_region);
    if (hit) hit.rows.push(row);
    else groups.set(row.lab_region, { region: row.lab_region, rows: [row] });
  }
  const rank = (r: string): number => {
    const i = DISPLAY_ORDER.indexOf(r);
    return i === -1 ? DISPLAY_ORDER.length : i;
  };
  // Array.prototype.sort is stable, so unlisted regions keep first-appearance order.
  return [...groups.values()].sort((a, b) => rank(a.region) - rank(b.region));
}
