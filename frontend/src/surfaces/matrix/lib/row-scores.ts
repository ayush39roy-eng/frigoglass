/**
 * P21 read helpers over one served Matrix row. Each returns a served field.
 * Nothing is computed: no score, point, share or band is derived in the
 * browser (I9).
 */

import type { DimensionField, DistributionBand, PriorityMatrixRow } from '../api/types';

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

/** One dimension's served score and points (`dimension_scores`; a pre-P21
 *  API without it falls back to the flat score and `dimension_points`). */
export function rowDimension(
  row: PriorityMatrixRow,
  key: DimensionField,
  fallbackWeight: number,
): ServedDimensionCell {
  // `dimension_scores` is required by the contract; tolerate an API that predates it.
  const list = row.dimension_scores as PriorityMatrixRow['dimension_scores'] | undefined;
  const served = list?.find((d) => d.key === key);
  if (served) return { score: served.score, points: served.points, maxPoints: served.max_points };
  const legacy = row.dimension_points?.[key];
  return {
    score: row[key],
    points: legacy ? legacy.points : null,
    maxPoints: legacy ? fallbackWeight : null,
  };
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
