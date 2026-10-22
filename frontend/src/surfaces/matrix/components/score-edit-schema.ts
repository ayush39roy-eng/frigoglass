import { z } from 'zod';

import { HARD_GATE_REASONS, type HardGateReason } from '@/types/enums';

import type {
  DimensionKey,
  DimensionScore,
  DimensionScoreMap,
  PriorityMatrixRow,
  PriorityScoreUpdateRequest,
} from '../api/types';

/**
 * P26 (ADR 0037, docs/API_CONTRACT_P26.md §5): the score body is
 * `{scores: {key: 0..5 | null}, hard_gates}`. `scores` holds only ACTIVE
 * dimension keys (the served `dimension_scores` of the row); a key left out
 * keeps its stored value and null clears a score. There is no fixed list of
 * dimensions and no invented default: an unscored dimension stays null until
 * someone scores it.
 *
 * Client validation is for responsiveness only; the backend (strict ints 0..5
 * or null, 422 `UNKNOWN_DIMENSION_KEY` for a non-active key) is the authority.
 */

export const dimensionScoreValueSchema = z.union([z.number().int().min(0).max(5), z.null()]);
export const scoresMapSchema = z.record(z.string().min(1).max(64), dimensionScoreValueSchema);

const hardGate = z.enum([...HARD_GATE_REASONS] as [HardGateReason, ...HardGateReason[]]);
export const hardGatesSchema = z.array(hardGate);

/** Every active dimension's served score of a row (`dimension_scores`), null = not scored. */
export function scoresFromDimensionScores(scores: readonly DimensionScore[]): DimensionScoreMap {
  return Object.fromEntries(scores.map((d) => [d.key, d.score]));
}

/** The row's current live values as a full request (every active key) — a scenario edit's baseline. */
export function liveRequestValuesFromRow(row: PriorityMatrixRow): PriorityScoreUpdateRequest {
  return { scores: scoresFromDimensionScores(row.dimension_scores), hard_gates: [...row.hard_gates] };
}

/**
 * The keys of `next` whose value differs from `base` (a key missing from `base`
 * counts as null). Only ACTIVE keys are sent: `activeKeys` filters out anything
 * else (e.g. a dimension deactivated since a scenario edit was staged).
 */
export function changedScores(
  base: DimensionScoreMap,
  next: DimensionScoreMap,
  activeKeys?: ReadonlySet<DimensionKey>,
): DimensionScoreMap {
  const out: DimensionScoreMap = {};
  for (const [key, value] of Object.entries(next)) {
    if (activeKeys && !activeKeys.has(key)) continue;
    if ((base[key] ?? null) !== value) out[key] = value;
  }
  return out;
}

/** A validated PUT body: the score map (only what should change) and the full hard-gate list. */
export function toRequestBody(scores: DimensionScoreMap, hardGates: readonly HardGateReason[]): PriorityScoreUpdateRequest {
  return { scores: scoresMapSchema.parse(scores), hard_gates: hardGatesSchema.parse([...hardGates]) };
}

/** The row with a staged scenario request applied (scores and hard gates), for display only. */
export function rowWithStaged(row: PriorityMatrixRow, next: PriorityScoreUpdateRequest): PriorityMatrixRow {
  return {
    ...row,
    hard_gates: [...next.hard_gates],
    dimension_scores: row.dimension_scores.map((d) =>
      Object.prototype.hasOwnProperty.call(next.scores, d.key) ? { ...d, score: next.scores[d.key] ?? null } : d,
    ),
  };
}
