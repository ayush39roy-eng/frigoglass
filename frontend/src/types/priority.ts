// PLACEHOLDER — replace with OpenAPI-generated types in P3 (P3-T07 / P4 surface work).
// Hand-authored because P3 does not exist yet. Tracked as debt in the P4-T01 docs/MEMORY.md entry.

import type { Id } from './common';
import type { HardGateReason, PriorityBand, ProjectPriority } from './enums';

/** The 13 scoring dimensions (DOMAIN_RULES.md "Prioritization scoring"). Names/order
 *  mirror backend/models/priority.py. Each score is an integer 1..5. */
export interface PriorityScoreInput {
  strategic_project: number;
  new_customer: number;
  new_options: number;
  regulatory_compliance: number;
  quality_improvements: number;
  rm_savings: number;
  total_rm_savings: number;
  gross_margins: number;
  profitability: number;
  annual_volume: number;
  three_year_volume: number;
  new_models: number;
  capex_investment: number;
}

/** Computed by the backend — the frontend only displays these (Invariant I9). */
export interface PriorityScoreResult {
  project_id: Id;
  weighted_score: number;
  normalised_pct: number;
  suggested_band: PriorityBand;
  hard_gates: HardGateReason[];
  /** Effective priority after hard-gate override (forces P1) — what the scheduler uses. */
  effective_priority: ProjectPriority;
}
