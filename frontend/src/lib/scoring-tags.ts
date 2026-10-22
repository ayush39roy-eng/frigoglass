import { SCORING_TAGS, SCORING_TAG_LABELS, type ScoringTag } from '@/types/enums';

/** P27 (ADR 0038): helpers for the Registration "project nature" tags. Display
 *  only; which dimension a tag pre-fills is the server's (`tag_dimension_keys`). */

/** Canonical order (the server's), no duplicates. */
export function canonicalScoringTags(tags: readonly ScoringTag[]): ScoringTag[] {
  return SCORING_TAGS.filter((t) => tags.includes(t));
}

/** Read view: "New Models, Improvement", or "—" when none. */
export function scoringTagsText(tags: readonly ScoringTag[] | undefined): string {
  const list = canonicalScoringTags(tags ?? []);
  return list.length === 0 ? '—' : list.map((t) => SCORING_TAG_LABELS[t]).join(', ');
}

export const SCORING_TAGS_HELP =
  'Ticking one gives that dimension full score (5); it can still be changed in the Matrix.';
