import type { HubName } from '@/types/enums';

import type { HubTypePipelineRow } from '../api/types';

/**
 * Real country for each hub (`docs/DOMAIN_RULES.md` "Hubs and lab-region mapping";
 * `docs/PROJECT_AND_STACK.md`: "R&D and production hubs in Greece, India and
 * Romania"). Kept as a small, honest label next to each hub's rank row — not a
 * fabricated business number, just the hub's real home country.
 *
 * 2026-10-01 (Boltshift): the hub GLOBE this file originally fed (`hub-globe.tsx`,
 * `hub-globe-panel.tsx`, deleted in this change) is replaced by the ranked-list-
 * with-coloured-progress-track pattern (spec §5) — which needs only a rank and a
 * country label, not a lat/lng anchor. `HUB_ANCHORS` (approximate, illustrative
 * country-level coordinates, including the shared-Mumbai-anchor-with-jitter
 * decision for the four India-mapped hubs) is retired along with the globe; see
 * docs/MEMORY.md "[2026-10-01] Boltshift shell + Dashboard rebuild" for the
 * superseded entry this one documents.
 */
export const HUB_COUNTRY: Record<HubName, string> = {
  'R&D-Greece': 'Greece',
  'R&D-India': 'India',
  'PD-India': 'India',
  'PD-Romania': 'Romania',
  'OEM-HCK': 'India',
  'OEM-Seltek': 'India',
};

export interface HubTotal {
  hub: HubName;
  country: string;
  /** Real Σ project count for this hub, from GET /dashboard/hub-type-pipeline. */
  count: number;
}

/**
 * Sums the real per-(hub, type) counts down to one figure per hub — the exact
 * same client-side aggregation `HubTypePipelineTable`'s row-total column already
 * performs on this same response (portfolio composition, not a schedule/score
 * number derived by this frontend). Hubs absent from `rows` (zero projects in
 * scope, e.g. a Hub Planner's narrowed view) are omitted rather than shown as a
 * fabricated zero-count row. Ranked largest-first, same discipline as
 * `assignSeriesColors`/`assignDashSeriesColors`.
 */
export function buildHubTotals(rows: HubTypePipelineRow[]): HubTotal[] {
  const totals = new Map<HubName, number>();
  for (const row of rows) {
    totals.set(row.hub, (totals.get(row.hub) ?? 0) + row.count);
  }

  return [...totals.entries()]
    .map(([hub, count]) => ({ hub, country: HUB_COUNTRY[hub], count }))
    .sort((a, b) => b.count - a.count);
}
