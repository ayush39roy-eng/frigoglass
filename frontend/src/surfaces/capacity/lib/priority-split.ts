import type { PriorityCountSplit, PriorityLoadSplit } from '../api/types';

/**
 * P13-T11 (API_CONTRACT_P13 §6): the served priority buckets, in display order.
 * Every value is read from the served split; nothing here re-buckets a project.
 */
export const PRIORITY_BUCKETS = ['P1', 'P2', 'P3', 'P4', 'Queue'] as const;
export type PriorityBucket = (typeof PRIORITY_BUCKETS)[number];

/** Short labels, e.g. for "P1-D" matrix headers and "Q: 5" captions. */
export const BUCKET_SHORT: Record<PriorityBucket, string> = {
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  Queue: 'Q',
};

/** Band tokens (same as the priority pill) — colour always paired with a text label. */
export const BUCKET_BG: Record<PriorityBucket, string> = {
  P1: 'bg-band-p1',
  P2: 'bg-band-p2',
  P3: 'bg-band-p3',
  P4: 'bg-band-p4',
  Queue: 'bg-band-q',
};

/** The buckets with a non-zero served value, in display order (for compact
 *  captions such as "P1: 32 · Q: 5"). */
export function nonZeroBuckets(
  split: PriorityLoadSplit | PriorityCountSplit,
): { bucket: PriorityBucket; value: number }[] {
  return PRIORITY_BUCKETS.filter((b) => split[b] !== 0).map((bucket) => ({ bucket, value: split[bucket] }));
}
