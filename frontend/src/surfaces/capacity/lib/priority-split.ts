import type { PriorityCountSplit, PriorityLoadSplit } from '../api/types';

/**
 * P13-T11 (API_CONTRACT_P13 §6): the served priority buckets, in display order.
 * Every value is read from the served split; nothing here re-buckets a project.
 */
/** P57 (ADR 0067): `NA` = Commercialized / Cancelled (served label "Not applicable"), neutral colour. */
export const PRIORITY_BUCKETS = ['P1', 'P2', 'P3', 'P4', 'Queue', 'NA'] as const;
export type PriorityBucket = (typeof PRIORITY_BUCKETS)[number];

/** Short labels, e.g. for "P1-D" matrix headers and "Q: 5" captions. The
 *  same values as the served `priority_bucket_labels` (P42, R42-1: the
 *  `Queue` key is shown as "Q", never "Queue", so it cannot be confused with
 *  P3 "In queue"); `bucketLabel` prefers the served map. */
export const BUCKET_SHORT: Record<PriorityBucket, string> = {
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  Queue: 'Q',
  NA: 'N/A',
};

/** P42: the display label of a split key — the served map first, else `BUCKET_SHORT`. */
export function bucketLabel(bucket: PriorityBucket, served?: Partial<Record<string, string>> | null): string {
  return served?.[bucket] ?? BUCKET_SHORT[bucket];
}

/** Band tokens (same as the priority pill) — colour always paired with a text label. */
export const BUCKET_BG: Record<PriorityBucket, string> = {
  P1: 'bg-band-p1',
  P2: 'bg-band-p2',
  P3: 'bg-band-p3',
  P4: 'bg-band-p4',
  Queue: 'bg-band-q',
  NA: 'bg-text-subtle/60',
};

/** The buckets with a non-zero served value, in display order (for compact
 *  captions such as "P1: 32 · Q: 5"). */
export function nonZeroBuckets(
  split: PriorityLoadSplit | PriorityCountSplit,
): { bucket: PriorityBucket; value: number }[] {
  return PRIORITY_BUCKETS.filter((b) => split[b] !== 0).map((bucket) => ({ bucket, value: split[bucket] }));
}
