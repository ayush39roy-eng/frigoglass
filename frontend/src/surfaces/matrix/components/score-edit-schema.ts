import { z } from 'zod';

import { HARD_GATE_REASONS, type HardGateReason } from '@/types/enums';

import {
  DIMENSION_FIELDS,
  type DimensionField,
  type PriorityMatrixRow,
  type PriorityScoreUpdateRequest,
} from '../api/types';

/**
 * Client-side mirror of `backend/schemas/priority.py::PriorityScoreUpdateRequest`
 * (`extra="forbid"`; 13 int dims each `ge=1 le=5`; `hard_gates` an enum array).
 *
 * Client validation is for responsiveness only — the backend is the authority
 * (`frontend-builder` SKILL). Kept deliberately close to the Pydantic
 * constraints so a bad value is caught before the request, not after.
 *
 * Only the 13 numeric dimensions go through `react-hook-form`. `hard_gates` is a
 * 3-checkbox set held in component state (its values are always valid enum
 * members by construction) and merged in at submit time — this also keeps the
 * form off the `watch()` API.
 */

const dimensionScore = z.coerce
  .number({ invalid_type_error: 'Enter a whole number from 1 to 5' })
  .int('Must be a whole number')
  .min(1, 'Minimum score is 1')
  .max(5, 'Maximum score is 5');

export const scoreDimensionsSchema = z.object({
  strategic_project: dimensionScore,
  new_customer: dimensionScore,
  new_options: dimensionScore,
  regulatory_compliance: dimensionScore,
  quality_improvements: dimensionScore,
  rm_savings: dimensionScore,
  total_rm_savings: dimensionScore,
  gross_margins: dimensionScore,
  profitability: dimensionScore,
  annual_volume: dimensionScore,
  three_year_volume: dimensionScore,
  new_models: dimensionScore,
  capex_investment: dimensionScore,
});

const hardGate = z.enum([...HARD_GATE_REASONS] as [HardGateReason, ...HardGateReason[]]);
export const hardGatesSchema = z.array(hardGate);

/** Input type (pre-coercion) — what the RHF fields hold. */
export type ScoreDimensionsInput = z.input<typeof scoreDimensionsSchema>;
/** Output type (post-coercion) — validated numbers. */
export type ScoreDimensionsValues = z.output<typeof scoreDimensionsSchema>;

const DEFAULT_DIMENSION = 3;

/** Build RHF default values from an existing row, or a neutral 3/5 for an
 *  unscored project (`has_score=false`). */
export function dimensionDefaultsFromRow(row: PriorityMatrixRow): ScoreDimensionsInput {
  return Object.fromEntries(
    DIMENSION_FIELDS.map((field) => [field, row[field] ?? DEFAULT_DIMENSION]),
  ) as unknown as ScoreDimensionsInput;
}

/**
 * The row's current live values in full `PriorityScoreUpdateRequest` shape —
 * used as a scenario edit's "baseline" (P5-T01, `docs/PROJECT_AND_STACK.md`
 * §4's "diffed against last committed version"). Nulls (`has_score=false`,
 * an unscored project) default to the same neutral 3/5 used to pre-fill the
 * form (`dimensionDefaultsFromRow`) — the caller pairs this with
 * `row.has_score` (`useScenarioStore`'s `liveHasScore`) so a first-time score
 * for a previously-unscored project is never treated as a no-op merely
 * because every dimension happened to stay at the default.
 */
export function liveRequestValuesFromRow(row: PriorityMatrixRow): PriorityScoreUpdateRequest {
  const dims = Object.fromEntries(
    DIMENSION_FIELDS.map((field) => [field, row[field] ?? DEFAULT_DIMENSION]),
  ) as Record<DimensionField, number>;
  return { ...dims, hard_gates: [...row.hard_gates] };
}

export function toRequestBody(
  dims: ScoreDimensionsValues,
  hardGates: HardGateReason[],
): PriorityScoreUpdateRequest {
  return {
    strategic_project: dims.strategic_project,
    new_customer: dims.new_customer,
    new_options: dims.new_options,
    regulatory_compliance: dims.regulatory_compliance,
    quality_improvements: dims.quality_improvements,
    rm_savings: dims.rm_savings,
    total_rm_savings: dims.total_rm_savings,
    gross_margins: dims.gross_margins,
    profitability: dims.profitability,
    annual_volume: dims.annual_volume,
    three_year_volume: dims.three_year_volume,
    new_models: dims.new_models,
    capex_investment: dims.capex_investment,
    hard_gates: hardGatesSchema.parse(hardGates),
  };
}
