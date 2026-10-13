import * as React from 'react';

import { useHubs } from '@/lib/api/reference';
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
/**
 * FALLBACK only — used until `GET /hubs` resolves (or when it is unavailable).
 * The label shown is the hub's SERVED `lab_region` (`useHubCountry`). Client
 * correction 2026-10-13: the OEM hubs (OEM-HCK, OEM-Seltek) are Europe — lab
 * region Greece — not India, so this fallback agrees with the served value.
 */
export const HUB_COUNTRY: Record<HubName, string> = {
  'R&D-Greece': 'Greece',
  'R&D-India': 'India',
  'PD-India': 'India',
  'PD-Romania': 'Romania',
  'OEM-HCK': 'Greece',
  'OEM-Seltek': 'Greece',
};

/** hub name → served `lab_region` from `GET /hubs`, falling back to
 *  `HUB_COUNTRY` for any hub the response does not (yet) carry. */
export function hubCountryMap(
  served: readonly { name: string; lab_region?: string | null }[] | undefined,
): Record<HubName, string> {
  const out: Record<HubName, string> = { ...HUB_COUNTRY };
  for (const hub of served ?? []) {
    if (hub.lab_region && hub.name in out) out[hub.name as HubName] = hub.lab_region;
  }
  return out;
}

/** The hub → country/region label the Dashboard shows, read from the API. */
export function useHubCountry(): Record<HubName, string> {
  const hubs = useHubs();
  return React.useMemo(() => hubCountryMap(hubs.data), [hubs.data]);
}

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
export function buildHubTotals(
  rows: HubTypePipelineRow[],
  country: Record<HubName, string> = HUB_COUNTRY,
): HubTotal[] {
  const totals = new Map<HubName, number>();
  for (const row of rows) {
    totals.set(row.hub, (totals.get(row.hub) ?? 0) + row.count);
  }

  return [...totals.entries()]
    .map(([hub, count]) => ({ hub, country: country[hub], count }))
    .sort((a, b) => b.count - a.count);
}
