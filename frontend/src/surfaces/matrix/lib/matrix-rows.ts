/**
 * P34-T02 (D34-2, D34-3): the scoring grid's row pipeline over the SERVED rows,
 * in one place so the page can memoise it and sort exactly once.
 *
 * - Search (name or external / project code), Hub and Leader text, VIP, the
 *   capacity-fill chip and the band pick narrow the served rows in view only.
 *   Ranks, scores and bands stay as served (rank is within the server-filtered
 *   set: Category / Type / Status / hub scope).
 * - The band distribution counts the served `suggested_band` (`rowBand`) of the
 *   rows the grid shows under every filter except the band pick itself. That is
 *   a count of served values, not a recomputed score (I9, D34-2).
 */

import {
  DISTRIBUTION_BANDS,
  type DistributionBand,
  type LastScoreVersion,
  type PriorityDistribution,
  type PriorityMatrixRow,
} from '../api/types';
import { rowBand } from './row-scores';
import { isVipRow } from './vip-row';

export interface RowViewFilters {
  /** Project search: name or code, case-insensitive substring. */
  q: string;
  hubText: string;
  leaderText: string;
  band: DistributionBand | null;
  capacityFill: boolean;
  vipOnly: boolean;
}

/** Name or project code (P34-T03 serves `external_code`). Read as optional so a
 *  pre-P34-T03 API (field absent) still searches by name. */
function matchesSearch(row: PriorityMatrixRow, q: string): boolean {
  if (row.project_name.toLowerCase().includes(q)) return true;
  const code = (row as Partial<PriorityMatrixRow>).external_code;
  return typeof code === 'string' && code.toLowerCase().includes(q);
}

/** Every view filter except the band pick (the distribution counts these rows). */
export function narrowExceptBand(rows: readonly PriorityMatrixRow[], f: Omit<RowViewFilters, 'band'>): PriorityMatrixRow[] {
  const q = f.q.trim().toLowerCase();
  const hub = f.hubText.trim().toLowerCase();
  const leader = f.leaderText.trim().toLowerCase();
  if (q === '' && hub === '' && leader === '' && !f.capacityFill && !f.vipOnly) return [...rows];
  return rows.filter((r) => {
    if (f.vipOnly && !isVipRow(r)) return false;
    if (f.capacityFill && r.capacity_fill !== true) return false;
    if (hub !== '' && !r.hub.toLowerCase().includes(hub)) return false;
    if (leader !== '') {
      // An id with no name reads "unavailable" (GDPR, OQ #8), as the cell shows it.
      const shown = r.leader_name ?? (r.leader_engineer_id ? 'unavailable' : '');
      if (!shown.toLowerCase().includes(leader)) return false;
    }
    if (q !== '' && !matchesSearch(r, q)) return false;
    return true;
  });
}

/** The band pick on top of `narrowExceptBand`. */
export function narrowByBand(rows: readonly PriorityMatrixRow[], band: DistributionBand | null): PriorityMatrixRow[] {
  if (band === null) return [...rows];
  return rows.filter((r) => rowBand(r) === band);
}

/** Grid order: VIP projects first (owner ask 2026-10-22), each group by served rank,
 *  then served weighted score, then name. Sorting is the page's only re-order. */
export function sortMatrixRows(rows: readonly PriorityMatrixRow[]): PriorityMatrixRow[] {
  return [...rows].sort((a, b) => {
    if (isVipRow(a) !== isVipRow(b)) return isVipRow(a) ? -1 : 1;
    if (a.rank !== null && b.rank !== null) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.project_name.localeCompare(b.project_name);
    }
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    if (a.weighted_score !== null && b.weighted_score !== null) {
      if (b.weighted_score !== a.weighted_score) return b.weighted_score - a.weighted_score;
      return a.project_name.localeCompare(b.project_name);
    }
    if (a.weighted_score !== null) return -1;
    if (b.weighted_score !== null) return 1;
    return a.project_name.localeCompare(b.project_name);
  });
}

/**
 * D34-2: the distribution of the shown rows. Each count is the number of rows
 * whose served band is that band; the share is that count over the rows counted
 * (one decimal), used for the segment length and the "(n%)" text. Q is a
 * committed priority, never a score band, so it stays 0 as served. The fill
 * count is the rows the server promoted (`capacity_fill`).
 */
export function distributionFromRows(rows: readonly PriorityMatrixRow[]): PriorityDistribution {
  const counts = new Map<DistributionBand, number>(DISTRIBUTION_BANDS.map((b) => [b, 0]));
  let scored = 0;
  let fill = 0;
  for (const r of rows) {
    const band = rowBand(r);
    if (band !== null) counts.set(band, (counts.get(band) ?? 0) + 1);
    if (r.has_score) scored += 1;
    if (r.capacity_fill === true) fill += 1;
  }
  const total = rows.length;
  return {
    total_projects: total,
    scored_projects: scored,
    band_distribution: DISTRIBUTION_BANDS.map((band) => {
      const count = counts.get(band) ?? 0;
      return { band, count, share_pct: total === 0 ? 0 : Math.round((count / total) * 1000) / 10 };
    }),
    score_histogram: [],
    capacity_fill_count: fill,
  };
}

/** P34 (D34-4): the served `last_score_version`; absent from a pre-P34 API reads as null. */
export function rowLastScoreVersion(row: PriorityMatrixRow): LastScoreVersion | null {
  return (row as Partial<PriorityMatrixRow>).last_score_version ?? null;
}
