import { rowPriorityNotApplicable } from '@/lib/priority-applicability';
import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

/**
 * P54 (ADR 0064 R2): the register's "Rank" column — display and ordering of
 * the SERVED `priority` + `band_rank` only. Nothing is derived: the rank, the
 * band size and the scheduling order are the server's (I9). Sorting by
 * priority then rank lists the rows in the scheduling order inside each band
 * (ADR 0050 key 4); unranked rows always go last.
 */

export type RankSort = 'none' | 'asc' | 'desc';

export interface BandRanked {
  priority: ProjectPriority | null;
  band_rank?: number | null | undefined;
  /** P57 (ADR 0067): a Commercialized / Cancelled row has no band, so it is unranked. */
  status?: string | null | undefined;
  priority_applicable?: boolean | null | undefined;
}

/** `P1 · 3`, or null when the row has no served rank (shown as "—"). */
export function formatBandRank(priority: ProjectPriority | null, rank: number | null | undefined): string | null {
  if (priority === null || rank === null || rank === undefined) return null;
  return `${priority} · ${String(rank)}`;
}

const BAND_ORDER = new Map<ProjectPriority, number>(PROJECT_PRIORITIES.map((p, i) => [p, i]));

function isRanked(row: BandRanked): row is BandRanked & { priority: ProjectPriority; band_rank: number } {
  return row.priority !== null && typeof row.band_rank === 'number' && !rowPriorityNotApplicable(row);
}

/** Ascending: band (P1, P2, …), then served rank. Unranked rows last, in their given order. */
export function compareBandRank(a: BandRanked, b: BandRanked): number {
  const ra = isRanked(a);
  const rb = isRanked(b);
  if (!ra || !rb) return ra === rb ? 0 : ra ? -1 : 1;
  const band = (BAND_ORDER.get(a.priority) ?? 99) - (BAND_ORDER.get(b.priority) ?? 99);
  return band !== 0 ? band : a.band_rank - b.band_rank;
}

/** A sorted copy (stable); `none` returns the rows as given (the server's sort). */
export function sortByBandRank<T extends BandRanked>(rows: readonly T[], sort: RankSort): readonly T[] {
  if (sort === 'none') return rows;
  const ranked = rows.filter(isRanked);
  const rest = rows.filter((r) => !isRanked(r));
  const ordered = [...ranked].sort(compareBandRank);
  if (sort === 'desc') ordered.reverse();
  return [...ordered, ...rest];
}

export function nextRankSort(sort: RankSort): RankSort {
  return sort === 'none' ? 'asc' : sort === 'asc' ? 'desc' : 'none';
}
