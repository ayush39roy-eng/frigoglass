/**
 * P21-T04: a PROVISIONAL preview of unsaved Compare edits. It is shown only
 * while a project has edits that the server has not accepted yet, and is always
 * labelled "preview". It is never presented as final: after a save the Compare
 * dialog, the grid and the charts re-read the authoritative figures from the
 * server (I9). The rule mirrors DOMAIN_RULES "Prioritization scoring"
 * (points = score / 5 × weight; out of 100 = round(Σ points / total × 100)),
 * on the SERVED weights and the served total weight. No band is previewed.
 * P26 (ADR 0037): a dimension with no score counts 0 points (the score is then
 * "incomplete"); with no dimension scored at all there is no score (Unscored).
 */

export interface PreviewInput {
  /** The score shown in the cell (edited or served); null = not chosen yet. */
  score: number | null;
  /** The served weight (`DimensionScore.weight`). */
  weight: number;
}

export interface ScorePreview {
  /** Provisional raw points per dimension, null when the score is not chosen. */
  points: (number | null)[];
  /** Provisional score out of 100; null when no dimension has a score. */
  outOf100: number | null;
}

export function previewScore(dims: readonly PreviewInput[], totalWeight: number | null): ScorePreview {
  const points = dims.map((d) => (d.score === null ? null : (d.score / 5) * d.weight));
  const total = totalWeight ?? dims.reduce((s, d) => s + d.weight, 0);
  if (total <= 0 || points.every((p) => p === null)) return { points, outOf100: null };
  const raw = points.reduce<number>((s, p) => s + (p ?? 0), 0);
  return { points, outOf100: Math.round((raw / total) * 100) };
}
