import type { HubName } from '@/types/enums';

import type { HubTypePipelineRow } from '../api/types';

/**
 * Approximate, illustrative coordinates for the hub globe panel.
 *
 * `Hub` has no latitude/longitude column (`backend/models/hub.py`) — there is no
 * real per-facility geocode in the data model, only the country each hub sits in
 * (docs/PROJECT_AND_STACK.md: "R&D and production hubs in Greece, India and
 * Romania"; docs/DOMAIN_RULES.md "Hubs and lab-region mapping"). These anchors
 * are therefore NOT fabricated business data (no schedule/score/capacity number
 * is invented) — they are geographic reference points for a real country, used
 * only to place a marker on a globe:
 *
 *   - R&D-Greece  → Athens (the confirmed HQ, PROJECT_AND_STACK.md §"Frigoglass
 *     is a commercial refrigeration manufacturer headquartered in Athens").
 *   - PD-Romania  → Bucharest (Romania's principal city; no more specific
 *     production-site address exists anywhere in this codebase).
 *   - R&D-India / PD-India / OEM-HCK / OEM-Seltek → all four map to the same
 *     "India" lab region (DOMAIN_RULES.md's hub→lab-region table) and there is
 *     no per-hub Indian city in the data model to tell them apart — so rather
 *     than inventing four distinct fake cities, all four share ONE real anchor
 *     (Mumbai, a generic, commonly-used India business-map reference point)
 *     with a small FIXED pixel-style lat/lng jitter whose only job is to keep
 *     four markers from painting on top of each other. The jitter carries no
 *     geographic claim — each hub's real name, and its real project count, are
 *     what the marker and its legend row actually assert.
 */
export const HUB_COUNTRY: Record<HubName, string> = {
  'R&D-Greece': 'Greece',
  'R&D-India': 'India',
  'PD-India': 'India',
  'PD-Romania': 'Romania',
  'OEM-HCK': 'India',
  'OEM-Seltek': 'India',
};

const MUMBAI = { lat: 19.076, lng: 72.8777 };

export const HUB_ANCHORS: Record<HubName, { lat: number; lng: number }> = {
  'R&D-Greece': { lat: 37.9838, lng: 23.7275 },
  'PD-Romania': { lat: 44.4268, lng: 26.1025 },
  'R&D-India': { lat: MUMBAI.lat, lng: MUMBAI.lng },
  'PD-India': { lat: MUMBAI.lat + 1.6, lng: MUMBAI.lng + 1.2 },
  'OEM-HCK': { lat: MUMBAI.lat - 1.6, lng: MUMBAI.lng + 1.2 },
  'OEM-Seltek': { lat: MUMBAI.lat, lng: MUMBAI.lng - 2.0 },
};

export interface HubMarker {
  hub: HubName;
  country: string;
  lat: number;
  lng: number;
  /** Real Σ project count for this hub, from GET /dashboard/hub-type-pipeline. */
  count: number;
}

/**
 * Sums the real per-(hub, type) counts down to one figure per hub — the exact
 * same client-side aggregation `HubTypePipelineTable`'s row-total column already
 * performs on this same response (portfolio composition, not a schedule/score
 * number derived by this frontend). Hubs absent from `rows` (zero projects in
 * scope, e.g. a Hub Planner's narrowed view) are omitted rather than shown as a
 * fabricated zero-count marker.
 */
export function buildHubMarkers(rows: HubTypePipelineRow[]): HubMarker[] {
  const totals = new Map<HubName, number>();
  for (const row of rows) {
    totals.set(row.hub, (totals.get(row.hub) ?? 0) + row.count);
  }

  return (Object.keys(HUB_ANCHORS) as HubName[])
    .filter((hub) => (totals.get(hub) ?? 0) > 0)
    .map((hub) => ({
      hub,
      country: HUB_COUNTRY[hub],
      ...HUB_ANCHORS[hub],
      count: totals.get(hub) ?? 0,
    }))
    .sort((a, b) => b.count - a.count);
}
