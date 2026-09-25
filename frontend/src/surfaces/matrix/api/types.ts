// PLACEHOLDER — hand-authored mirror of backend/schemas/priority.py. P3's
// OpenAPI schema is not generated into this repo yet (see src/types/README.md
// and the P4-T01 docs/MEMORY.md carry-forward note (a)). P3-T07's contract test
// must catch drift between these shapes and the real schema.

import type {
  CurrencyCode,
  HardGateReason,
  HubName,
  ProjectCategory,
  ProjectPriority,
  ProjectType,
} from '@/types/enums';
import type { Id } from '@/types/common';

/** The 13 scoring-dimension field names, in `docs/DOMAIN_RULES.md` table order
 *  (mirrors `backend/models/priority.py::DIMENSION_FIELD_NAMES`). */
export const DIMENSION_FIELDS = [
  'strategic_project',
  'new_customer',
  'new_options',
  'regulatory_compliance',
  'quality_improvements',
  'rm_savings',
  'total_rm_savings',
  'gross_margins',
  'profitability',
  'annual_volume',
  'three_year_volume',
  'new_models',
  'capex_investment',
] as const;

export type DimensionField = (typeof DIMENSION_FIELDS)[number];

export interface DimensionMeta {
  field: DimensionField;
  /** Column header (short). */
  short: string;
  /** Full display name from `docs/DOMAIN_RULES.md`. */
  label: string;
  pillar: string;
  /** Weight from `docs/DOMAIN_RULES.md` — display / documentation only, never
   *  used in a client-side calculation (weighted_score comes from the API). */
  weight: number;
}

/** `docs/DOMAIN_RULES.md` "Prioritization scoring — 13 dimensions". */
export const DIMENSIONS: readonly DimensionMeta[] = [
  { field: 'strategic_project', short: 'Strat.', label: 'Strategic Project', pillar: 'Strategic Alignment', weight: 25 },
  { field: 'new_customer', short: 'New cust.', label: 'New Customer', pillar: 'Strategic Alignment', weight: 25 },
  { field: 'new_options', short: 'New opt.', label: 'New Options', pillar: 'Strategic Alignment', weight: 25 },
  { field: 'regulatory_compliance', short: 'Reg.', label: 'Regulatory Compliance', pillar: 'Regulatory & Quality', weight: 25 },
  { field: 'quality_improvements', short: 'Quality', label: 'Quality Improvements', pillar: 'Regulatory & Quality', weight: 25 },
  { field: 'rm_savings', short: 'RM sav.', label: 'RM Savings', pillar: 'Financial Return', weight: 25 },
  { field: 'total_rm_savings', short: 'Tot. RM', label: 'Total RM Savings', pillar: 'Financial Return', weight: 25 },
  { field: 'gross_margins', short: 'GM', label: 'Gross Margins', pillar: 'Financial Return', weight: 25 },
  { field: 'profitability', short: 'Profit.', label: 'Profitability', pillar: 'Financial Return', weight: 25 },
  { field: 'annual_volume', short: 'Ann. vol.', label: 'Annual Volume', pillar: 'Market & Volume', weight: 15 },
  { field: 'three_year_volume', short: '3yr vol.', label: '3-Year Volume', pillar: 'Market & Volume', weight: 15 },
  { field: 'new_models', short: 'New mdl.', label: 'New Models', pillar: 'Market & Volume', weight: 15 },
  { field: 'capex_investment', short: 'CAPEX', label: 'CAPEX Investment (inverted)', pillar: 'Investment & Feasibility', weight: 10 },
] as const;

/** `docs/DOMAIN_RULES.md` band thresholds — display copy of a fixed rule, used
 *  only to make the API's `suggested_band` legible. Not used to derive a band
 *  client-side (that stays server-side; Invariant I9). */
export const BAND_THRESHOLDS: readonly { min: number; band: ProjectPriority }[] = [
  { min: 70, band: 'P1' },
  { min: 55, band: 'P2' },
  { min: 40, band: 'P3' },
  { min: 0, band: 'P4' },
] as const;

/** One row of the scoring grid — `GET /priorities` (→ `PriorityMatrixRow`).
 *  `has_score=false` rows have null dimension + score fields. Financial columns
 *  are ALREADY converted server-side to the requested `currency`;
 *  `gross_margin_pct` is never converted. */
export interface PriorityMatrixRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
  category: ProjectCategory | null;
  type: ProjectType | null;
  /** Currently committed `Project.priority` — may be null / differ from `suggested_band`. */
  set_priority: ProjectPriority | null;

  has_score: boolean;
  strategic_project: number | null;
  new_customer: number | null;
  new_options: number | null;
  regulatory_compliance: number | null;
  quality_improvements: number | null;
  rm_savings: number | null;
  total_rm_savings: number | null;
  gross_margins: number | null;
  profitability: number | null;
  annual_volume: number | null;
  three_year_volume: number | null;
  new_models: number | null;
  capex_investment: number | null;
  hard_gates: HardGateReason[];
  /** Backend-computed: Σ(dimension_score × weight). Displayed verbatim. */
  weighted_score: number | null;
  /** Backend-computed: round(weighted_score / (280 × 5) × 100). Displayed verbatim. */
  normalized_pct: number | null;
  /** Backend-computed band from `normalized_pct`. Does NOT itself reflect the
   *  hard-gate → P1 override (that is applied by "Apply Priorities", deferred) —
   *  the UI annotates hard-gated rows separately. */
  suggested_band: ProjectPriority | null;

  is_new_model: boolean;
  is_rm_saving_project: boolean;

  /** The currency these financial columns were converted to, server-side. */
  currency: CurrencyCode;
  capex_keur: number | null;
  rm_savings_keur: number | null;
  tcogs_eur: number | null;
  selling_price_eur: number | null;
  gross_margin_pct: number | null;
}

/** `GET /priorities/summary` (→ `PriorityPortfolioSummary`). Implicitly scoped
 *  to the caller's hub(s) — NOT parameterised by the grid's hub filter. */
export interface PriorityPortfolioSummary {
  total_projects: number;
  scored_projects: number;
  unscored_projects: number;
  hard_gate_forced_count: number;
  /** keyed by ProjectPriority value ("P1".."P4"). */
  suggested_band_counts: Record<string, number>;
  /** keyed by ProjectPriority value ("P1".."Q"). */
  set_priority_counts: Record<string, number>;
}

/** `PUT /priorities/{project_id}` request body (→ `PriorityScoreUpdateRequest`).
 *  `extra="forbid"` server-side — send exactly these keys. */
export interface PriorityScoreUpdateRequest {
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
  hard_gates: HardGateReason[];
}

/** `PUT /priorities/{project_id}` response (→ `PriorityScoreRead`). */
export interface PriorityScoreRead extends PriorityScoreUpdateRequest {
  id: Id;
  project_id: Id;
  weighted_score: number | null;
  normalized_pct: number | null;
  suggested_band: ProjectPriority | null;
}

// --- Scenario Apply (P5-T01/P5-T02) ---------------------------------------
// Hand-authored mirror of `backend/schemas/scenario.py`. **Scope boundary**:
// `POST /scenarios/apply` only accepts `priority_scores` today — `Project`/
// `Engineer`/`Chamber` diffs are deferred (see that file's module docstring
// and `docs/MEMORY.md`'s "P5-T02 — backend-builder" entry). Do not add
// speculative fields here for entity types the backend does not accept yet.

/** One project's proposed new 13-dimension score + hard gates, as part of a
 *  scenario diff (→ `ScenarioPriorityScoreChange`). Same field shape as
 *  `PriorityScoreUpdateRequest` — this is a FULL row replacement per project,
 *  not a sparse per-field diff (confirmed by reading the backend schema: every
 *  dimension field is required, `ge=1 le=5`, none nullable/optional) — plus
 *  `project_id` to address it in a batch. `extra="forbid"` server-side. */
export interface ScenarioPriorityScoreChange extends PriorityScoreUpdateRequest {
  project_id: Id;
}

/** `POST /scenarios/apply` request body (→ `ScenarioApplyRequest`).
 *  `extra="forbid"` server-side — send exactly these two keys. An empty
 *  `priority_scores` array is rejected by the backend (400), not here. */
export interface ScenarioApplyRequest {
  notes?: string | null;
  priority_scores: ScenarioPriorityScoreChange[];
}

/** One `ScenarioApplyRun` summary, embedded in `ScenarioApplyResponse.run`
 *  (→ `ScenarioApplyRunSummary`). */
export interface ScenarioApplyRunSummary {
  id: Id;
  version: number;
  applied_by_user_id: Id | null;
  notes: string | null;
  entity_types_touched: string[];
  change_count: number;
  created_at: string;
}

/** `POST /scenarios/apply` response (→ `ScenarioApplyResponse`). */
export interface ScenarioApplyResponse {
  run: ScenarioApplyRunSummary;
  /** `PriorityScore.id` values written by this Apply, in request order. */
  updated_priority_scores: Id[];
  /** `project_id` (string) -> newly computed `suggested_band`, one entry per
   *  `priority_scores` item in the request. Displayed verbatim — never
   *  recomputed client-side (Invariant I9). */
  suggested_bands: Record<string, ProjectPriority>;
}

// --- Versions & History (P5-T03) -------------------------------------------
// Hand-authored mirror of `backend/schemas/scenario.py`'s
// `ScenarioApplyChangeSummary` / `ScenarioApplyChangeDetail` /
// `ScenarioApplyRunDetail` (the two read endpoints' response shapes),
// confirmed against that file directly, not assumed. **Scope boundary** (see
// `docs/MEMORY.md`'s P5-T02/P5-T03 entries): today `entity_type` is only ever
// `'priority_score'` in practice — this browses applied scenario
// priority-score changes, NOT "every schedule run". Do not build UI copy that
// implies broader coverage than that.

/** `backend/models/enums.py::ScenarioEntityType` values. Only `'priority_score'`
 *  has a real write path today; the other three exist in the schema for a
 *  future extension and will never appear in a real row yet. */
export type ScenarioEntityType = 'priority_score' | 'project' | 'engineer' | 'chamber';

/** One changed row within a version (→ `ScenarioApplyChangeSummary`). */
export interface ScenarioApplyChangeSummary {
  id: Id;
  entity_type: ScenarioEntityType;
  /** The changed row's own primary key, as a string (`str(row.id)` server-side). */
  entity_id: string;
  project_id: Id | null;
  hub_id: Id | null;
}

/** Adds the full before/after snapshots (→ `ScenarioApplyChangeDetail`).
 *  `before_state` is `null` for a first-time score (nothing existed to
 *  snapshot); `after_state` is always present. Both are the exact JSONB
 *  written by `services.audit_helpers.priority_score_audit_state(...)` for
 *  the only entity type this ever contains today (`priority_score`): `id`,
 *  `project_id`, the 13 dimension fields, `hard_gates`, `weighted_score`,
 *  `normalized_pct`, `suggested_band`. Typed as a raw JSON record (not the
 *  named dimension interface) because the schema is intentionally generic
 *  across the four `ScenarioEntityType` values — read fields defensively. */
export interface ScenarioApplyChangeDetail extends ScenarioApplyChangeSummary {
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown>;
}

/** One version's full detail (→ `ScenarioApplyRunDetail`), `GET
 *  /scenarios/versions/{version}`. 404s (not a 200 with empty `changes`) when
 *  every change in this version is outside the caller's hub scope. */
export interface ScenarioApplyRunDetail extends ScenarioApplyRunSummary {
  changes: ScenarioApplyChangeDetail[];
}
