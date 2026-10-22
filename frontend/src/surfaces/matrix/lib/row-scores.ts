/**
 * P21 read helpers over one served Matrix row. Each returns a served field.
 * Nothing is computed: no score, point, share or band is derived in the
 * browser (I9).
 */

import type { DimensionKey, DimensionScore, DistributionBand, PriorityMatrixRow } from '../api/types';

/** The row's served normalized score 0..100 (`normalized_pct`, API_CONTRACT_P21 §0). */
export function rowNormalizedScore(row: PriorityMatrixRow): number | null {
  return row.normalized_pct;
}

/** The row's served band (`suggested_band`); an unscored row reads "Unscored",
 *  the same bucket `GET /priorities/distribution` counts it in. */
export function rowBand(row: PriorityMatrixRow): DistributionBand | null {
  if (row.suggested_band !== null) return row.suggested_band;
  return row.has_score ? null : 'Unscored';
}

export interface ServedDimensionCell {
  score: number | null;
  points: number | null;
  maxPoints: number | null;
}

/** One dimension's served score and points (`dimension_scores`, P21 §3 / P26).
 *  A key the row does not carry (e.g. an older row) reads as not scored. */
export function rowDimension(row: { dimension_scores: readonly DimensionScore[] }, key: DimensionKey): ServedDimensionCell {
  const served = row.dimension_scores.find((d) => d.key === key);
  if (!served) return { score: null, points: null, maxPoints: null };
  return { score: served.score, points: served.points, maxPoints: served.max_points };
}

/**
 * P26 (ADR 0037): the labels of the active dimensions a scored project has no
 * score on (`missing_dimension_keys`, served), in display order. Empty for an
 * unscored or complete row. Labels come from the row's own `dimension_scores`;
 * a key it does not describe is shown as the key itself.
 */
export function rowMissingLabels(row: {
  has_score: boolean;
  missing_dimension_keys?: readonly DimensionKey[] | undefined;
  dimension_scores: readonly DimensionScore[];
}): string[] {
  const missing = row.missing_dimension_keys ?? [];
  if (!row.has_score || missing.length === 0) return [];
  const labelOf = new Map(row.dimension_scores.map((d) => [d.key, d.label]));
  const ordered = row.dimension_scores.filter((d) => missing.includes(d.key)).map((d) => d.label);
  const unknown = missing.filter((k) => !labelOf.has(k));
  return [...ordered, ...unknown];
}

/** "91/100" — every score reads out of 100 (owner request, P21). */
export function formatOutOf100(value: number): string {
  return `${String(value)}/100`;
}

/** "20/25 pts" style points text from served figures. */
export function formatPoints(points: number, max: number): string {
  return `${formatNum(points)}/${formatNum(max)} pts`;
}

function formatNum(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
