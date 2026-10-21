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
  ProjectStatus,
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
  /** Weight from `docs/DOMAIN_RULES.md` (ADR 0029) — display fallback only, never
   *  used in a client-side calculation. Prefer the served `ScoringDimension`. */
  weight: number;
}

/** One entry of the SERVED dimension table (P16, ADR 0029): `dimensions[]`.
 *  `scaled_weight` = weight x 100 / total_weight, computed by the server (I9). */
export interface ScoringDimension {
  key: DimensionField;
  label: string;
  pillar: string;
  weight: number;
  scaled_weight: number;
}

/** The served table plus `total_weight` (295 today; derived server-side). */
export interface ScoringDimensionTable {
  dimensions: ScoringDimension[];
  total_weight: number;
}

/** Per-row, per-dimension served points: `points` out of `weight`,
 *  `scaled_points` out of `scaled_weight` (the scaled-to-100 view). */
export interface DimensionPoints {
  points: number;
  scaled_points: number;
}

/** Display copy for the points rule (ADR 0029). Static text, no arithmetic. */
export const POINTS_RULE_COPY =
  'Score 1 gives 1/5 of the weight, score 5 the full weight; the total is scaled to 100.';

/** P21-T02: help text for the 0..5 score inputs (0 = no contribution). */
export const SCORE_RANGE_HELP_COPY = '0 gives no points; 1 gives 1/5 of the weight; 5 the full weight';

// --- P21 (owner requests 2026-10-21; docs/API_CONTRACT_P21.md) -------------

/** Display currencies offered on the Matrix (P21). Wider than the shared
 *  `CurrencyCode` (EUR / USD / INR): the served list decides which are usable. */
export const MATRIX_CURRENCY_CODES = ['EUR', 'USD', 'INR', 'EGP', 'ZAR', 'IDR'] as const;
export type MatrixCurrencyCode = (typeof MATRIX_CURRENCY_CODES)[number];

/** Static display names, used only when the served list has no `name`. */
export const CURRENCY_NAMES: Record<MatrixCurrencyCode, string> = {
  EUR: 'Euro',
  USD: 'US dollar',
  INR: 'Indian rupee',
  EGP: 'Egyptian pound',
  ZAR: 'South African rand',
  IDR: 'Indonesian rupiah',
};

/** One `GET /currency-rates` row as the Matrix picker reads it (P21 contract §1,
 *  a subset of `CurrencyRateRead`). `rate_to_eur` is shown verbatim; it is never
 *  applied in the browser. `configured=false` (null rate) disables the option. */
export interface CurrencyOption {
  currency_code: MatrixCurrencyCode;
  name: string;
  rate_to_eur: number | null;
  configured: boolean;
}

/** One served per-dimension score on a Matrix row / compare entry (P21 §3).
 *  `points` out of `max_points` (= weight), raw scale, both served (I9). */
export interface DimensionScore {
  key: DimensionField;
  label: string;
  pillar: string;
  score: number | null;
  weight: number;
  points: number | null;
  max_points: number;
}

/** Band keys of the served distribution: the four score bands, Q and Unscored. */
export const DISTRIBUTION_BANDS = ['P1', 'P2', 'P3', 'P4', 'Q', 'Unscored'] as const;
export type DistributionBand = (typeof DISTRIBUTION_BANDS)[number];

/** `band_distribution[]` (P21): `share_pct` is served, never computed here. */
export interface BandDistributionEntry {
  band: DistributionBand;
  count: number;
  share_pct: number;
}

/** `score_histogram[]` (P21): normalized score in 10-point buckets. */
export interface ScoreHistogramBucket {
  bucket_from: number;
  bucket_to: number;
  count: number;
}

/** `GET /priorities/distribution` (P21 §4), same filters as `GET /priorities`. */
export interface PriorityDistribution {
  total_projects: number;
  scored_projects: number;
  band_distribution: BandDistributionEntry[];
  score_histogram: ScoreHistogramBucket[];
  /** P25: rows of this filtered set promoted by capacity fill (they are inside the P1 bucket). */
  capacity_fill_count: number;
}

/** One project of `GET /priorities/compare` (P21 §5, `PriorityCompareItem`). No financial field. */
export interface PriorityCompareProject {
  project_id: Id;
  project_name: string;
  hub: HubName;
  set_priority: ProjectPriority | null;
  has_score: boolean;
  weighted_score: number | null;
  /** Served normalized score, 0..100, shown "91/100". */
  normalized_pct: number | null;
  suggested_band: ProjectPriority | null;
  /** P25 (ADR 0036): the pure score band (≥ 70 P1, ≥ 55 P2, ≥ 40 P3, else P4); null when unscored.
   *  `suggested_band` is now the band AFTER the hub's P1 capacity fill. */
  score_band: ProjectPriority | null;
  /** P25: promoted to P1 by the hub's capacity fill (label "P1 · capacity fill"). */
  capacity_fill: boolean;
  /** P25: the served reason for a walk decision (promoted / not promoted); shown verbatim, never parsed. */
  capacity_fill_reason: string | null;
  dimension_scores: DimensionScore[];
}

export interface PriorityCompareResponse {
  projects: PriorityCompareProject[];
}

/** Compare holds 2..5 projects (owner request, P21). */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 5;

/** `docs/DOMAIN_RULES.md` "Prioritization scoring — 13 dimensions". */
export const DIMENSIONS: readonly DimensionMeta[] = [
  { field: 'strategic_project', short: 'Strat.', label: 'Strategic Project', pillar: 'Strategic Alignment', weight: 25 },
  { field: 'new_customer', short: 'New cust.', label: 'New Customer', pillar: 'Strategic Alignment', weight: 25 },
  { field: 'new_options', short: 'New opt.', label: 'New Options', pillar: 'Strategic Alignment', weight: 25 },
  { field: 'regulatory_compliance', short: 'Reg.', label: 'Regulatory Compliance', pillar: 'Regulatory & Quality', weight: 25 },
  { field: 'quality_improvements', short: 'Quality', label: 'Quality Improvements', pillar: 'Regulatory & Quality', weight: 25 },
  { field: 'rm_savings', short: 'RM sav.', label: 'RM Savings', pillar: 'Financial Return', weight: 25 },
  { field: 'total_rm_savings', short: 'Tot. RM', label: 'Total RM Savings', pillar: 'Financial Return', weight: 25 },
  { field: 'gross_margins', short: 'Gross prof.', label: 'Gross Profitability', pillar: 'Financial Return', weight: 25 },
  { field: 'profitability', short: 'ROI', label: 'ROI', pillar: 'Investment & Feasibility', weight: 25 },
  { field: 'annual_volume', short: 'Ann. vol.', label: 'Annual Volume', pillar: 'Market & Volume', weight: 15 },
  { field: 'three_year_volume', short: '3yr vol.', label: '3-Year Volume', pillar: 'Market & Volume', weight: 25 },
  { field: 'new_models', short: 'New mdl.', label: 'New Models', pillar: 'Market & Volume', weight: 15 },
  { field: 'capex_investment', short: 'CAPEX', label: 'CAPEX Investment (inverted)', pillar: 'Investment & Feasibility', weight: 15 },
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
  /** P13-T14 (API_CONTRACT_P13 §7). */
  status: ProjectStatus;
  /** P13-T14, GDPR (OQ #8): null unless the leader is the caller. With a
   *  `leader_engineer_id` the grid shows "Withheld" — never resolved here. */
  leader_name: string | null;
  leader_engineer_id: Id | null;
  /** P13-T14: 1-based rank by score within the filtered set, served; null when unscored. */
  rank: number | null;

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
  /** Backend-computed: Σ points (score/5 × weight), out of `total_weight`. Displayed verbatim. */
  weighted_score: number | null;
  /** Served per-dimension points (P16, ADR 0029); absent/null when unscored. */
  dimension_points?: Partial<Record<DimensionField, DimensionPoints>> | null;
  /** Backend-computed: round(weighted_score / total_weight × 100). Displayed verbatim. */
  normalized_pct: number | null;
  /** Backend-computed band from `normalized_pct`. Does NOT itself reflect the
   *  hard-gate → P1 override (that is applied by "Apply Priorities", deferred) —
   *  the UI annotates hard-gated rows separately. */
  suggested_band: ProjectPriority | null;
  /** P25 (ADR 0036): the pure score band (≥ 70 P1, ≥ 55 P2, ≥ 40 P3, else P4); null when unscored.
   *  `suggested_band` is now the band AFTER the hub's P1 capacity fill. */
  score_band: ProjectPriority | null;
  /** P25: promoted to P1 by the hub's capacity fill (label "P1 · capacity fill"). */
  capacity_fill: boolean;
  /** P25: the served reason for a walk decision (promoted / not promoted); shown verbatim, never parsed. */
  capacity_fill_reason: string | null;
  /** P21 §3: the 13 served per-dimension scores, points and max points, in
   *  positional order. (`normalized_pct` / `suggested_band` above are the
   *  row's score out of 100 and its band.) */
  dimension_scores: DimensionScore[];

  is_new_model: boolean;
  is_rm_saving_project: boolean;

  /** The currency these financial columns were converted to, server-side. */
  currency: CurrencyCode | MatrixCurrencyCode;
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
  /** P25: counts of the pure score band (`suggested_band_counts` now follows the promoted band). */
  score_band_counts: Record<string, number>;
  /** P25: projects in scope promoted to P1 by capacity fill. */
  capacity_fill_count: number;
}

/** P25 (ADR 0036): one hub's P1 capacity fill, effort weeks (2 dp), served. */
export interface HubP1Fill {
  hub: HubName;
  /** Remaining-year design capacity (= `/capacity/hub-load` `design_capacity_remaining`). */
  capacity_weeks: number;
  /** Remaining design weeks of the hub's score-band-P1 projects. */
  base_load_weeks: number;
  /** Base load plus the promoted projects' weeks (= base when nothing is promoted). */
  filled_load_weeks: number;
  promoted_count: number;
}

/** `GET /priorities/capacity-fill` (P25). */
export interface PriorityCapacityFill {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  hubs: HubP1Fill[];
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
