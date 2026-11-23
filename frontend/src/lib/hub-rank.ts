/**
 * P60 (ADR 0068): the rank display rule, shared by every surface that shows a
 * rank (Priority board, Projects register, Registration form / Workspace).
 *
 * - Primary: the SERVED `hub_rank` ("#3"), titled "#3 of 12 in PD-India · P1".
 * - Hub / country filter active on the screen: the hub rank only.
 * - No hub filter: the hub rank, plus the served global `band_rank` on hover
 *   ("Global: #16 of 40 in P1, all hubs") and a small muted "G16" marker.
 *
 * Copy only: every number is a served field printed verbatim (I9). Nothing here
 * derives a rank, a size or an order.
 */

export interface RankFacts {
  /** The band (the project's set priority). */
  priority: string | null;
  /** The hub name, e.g. "PD-India"; null when the caller does not know it. */
  hub: string | null;
  hub_rank?: number | null | undefined;
  hub_band_size?: number | null | undefined;
  band_rank?: number | null | undefined;
  band_size?: number | null | undefined;
}

/** "PD-India · P1" (or the band alone without a hub name). */
export function hubRankScope(hub: string | null, band: string): string {
  return hub ? `${hub} · ${band}` : band;
}

function ofSize(size: number | null | undefined): string {
  return typeof size === 'number' ? ` of ${String(size)}` : '';
}

/** "#3 of 12 in PD-India · P1"; null without a served hub rank or band. */
export function hubRankText(facts: RankFacts): string | null {
  if (facts.priority === null || typeof facts.hub_rank !== 'number') return null;
  return `#${String(facts.hub_rank)}${ofSize(facts.hub_band_size)} in ${hubRankScope(facts.hub, facts.priority)}`;
}

/** "Global: #16 of 40 in P1, all hubs"; null without a served band rank. */
export function globalRankText(facts: RankFacts): string | null {
  if (facts.priority === null || typeof facts.band_rank !== 'number') return null;
  return `Global: #${String(facts.band_rank)}${ofSize(facts.band_size)} in ${facts.priority}, all hubs`;
}

/** The tooltip: the hub line, plus the global line only when no hub filter is active. */
export function rankTooltip(facts: RankFacts, hubFiltered: boolean): string | null {
  const hub = hubRankText(facts);
  if (hub === null) return null;
  const global = hubFiltered ? null : globalRankText(facts);
  return global ? `${hub}\n${global}` : hub;
}

/** True when the hub ↓ step is known to be last in its hub from served data. */
export function isLastInHub(facts: Pick<RankFacts, 'hub_rank' | 'hub_band_size'>): boolean {
  return typeof facts.hub_rank === 'number' && typeof facts.hub_band_size === 'number' && facts.hub_rank >= facts.hub_band_size;
}
