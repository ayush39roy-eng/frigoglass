import type { DimensionKey, DimensionScore, ScoringDimensionTable } from '../api/types';

/**
 * The SERVED scoring model (P16, ADR 0029; P26, ADR 0037): the ACTIVE
 * dimensions of the current rubric in `display_order`, with their served
 * weights, scaled weights and `total_weight`. The browser only displays them
 * (I9). There is no static fallback list any more: the rubric is data an
 * Admin edits. Until the table is served the model is empty (`loaded: false`)
 * and callers fall back to the dimensions a served row carries
 * (`modelFromDimensionScores`), never to a hard-coded list.
 */
export interface ScoringModelEntry {
  key: DimensionKey;
  label: string;
  pillar: string;
  weight: number;
  /** Served `weight × 100 / total_weight`; null when not served (row fallback). */
  scaled_weight: number | null;
}

export interface ScoringModel {
  dimensions: readonly ScoringModelEntry[];
  total_weight: number | null;
  rubric_version: number | null;
  /** The served table has arrived. */
  loaded: boolean;
}

export const EMPTY_SCORING_MODEL: ScoringModel = { dimensions: [], total_weight: null, rubric_version: null, loaded: false };

export function buildScoringModel(table: ScoringDimensionTable | null | undefined): ScoringModel {
  if (!table) return EMPTY_SCORING_MODEL;
  return {
    loaded: true,
    total_weight: table.total_weight,
    // `rubric_version` is a P26 field; tolerate an API that predates it.
    rubric_version: (table.rubric_version as number | undefined) ?? null,
    dimensions: table.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      pillar: d.pillar,
      weight: d.weight,
      scaled_weight: d.scaled_weight,
    })),
  };
}

/** Model entries read from a served `dimension_scores` list (same order, no scaled weight). */
export function modelFromDimensionScores(scores: readonly DimensionScore[]): ScoringModelEntry[] {
  return scores.map((d) => ({ key: d.key, label: d.label, pillar: d.pillar, weight: d.weight, scaled_weight: null }));
}

/**
 * The dimensions to lay out: the served table when it has arrived, else the
 * first served row's `dimension_scores` (every row carries the active
 * dimensions in display order). Never a constant.
 */
export function layoutDimensions(
  model: ScoringModel,
  rows: readonly { dimension_scores: readonly DimensionScore[] }[],
): readonly ScoringModelEntry[] {
  if (model.loaded && model.dimensions.length > 0) return model.dimensions;
  const first = rows.find((r) => r.dimension_scores.length > 0);
  return first ? modelFromDimensionScores(first.dimension_scores) : [];
}

/** "25 (8.5 of 100)" style text from served figures; scaled omitted when not served. */
export function formatWeight(weight: number, scaled: number | null): string {
  return scaled === null ? String(weight) : `${String(weight)} (${scaled.toFixed(1)} of 100)`;
}

