import type { HubCapacityRow } from '../api/types';

/**
 * One lab region's served lab figures, read from the first hub row of that
 * region (every hub row of a region carries the same region figure, ADR 0016),
 * with the in-scope hubs that share it. Selection only: nothing is added, so a
 * region's figure is never drawn or listed once per hub.
 *
 * (P13-T11 addendum: replaces `portfolio-totals.ts`. The portfolio totals are now
 * served as `HubCapacitySummary.totals`, so the browser sums no rows.)
 */
export interface LabRegionRow {
  region: HubCapacityRow['lab_region'];
  hubs: HubCapacityRow['hub'][];
  row: HubCapacityRow;
}

export function labRegionRows(rows: readonly HubCapacityRow[]): LabRegionRow[] {
  const byRegion = new Map<string, LabRegionRow>();
  for (const row of rows) {
    const hit = byRegion.get(row.lab_region);
    if (hit) hit.hubs.push(row.hub);
    else byRegion.set(row.lab_region, { region: row.lab_region, hubs: [row.hub], row });
  }
  return [...byRegion.values()];
}
