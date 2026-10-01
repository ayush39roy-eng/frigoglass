// PLACEHOLDER — mirror of backend/schemas/capacity.py + the ScheduleRunSummary
// slice of backend/schemas/schedule_run.py. Hand-authored because P3's OpenAPI
// schema is not generated into this repo yet (see src/types/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note (a)). P3-T07's contract test must
// catch drift between these shapes and the real schema.

import type { HubName, LabRegion, ProjectCategory, ScheduleRunStatus, SolverType } from '@/types/enums';
import type { Id } from '@/types/common';

/**
 * One chamber's supply inputs and derived figures (PLACEHOLDER — P9 contract §4,
 * ADR 0008): `working_weeks_per_chamber = 52 − holidays − maintenance − breakdown −
 * calibration`, `efficient_lab_weeks = working_weeks × efficiency × platforms`.
 * Both derived SERVER-side; shown so the client sees the same breakdown their
 * workbook has (Invariant I17).
 */
export interface CapacityChamberRow {
  chamber_id: Id;
  code: string;
  platforms: number;
  efficiency: number;
  working_weeks_per_chamber: number;
  efficient_lab_weeks: number;
}

/**
 * One hub's load vs. supply, from `GET /capacity/hub-load` (→ HubCapacitySummary
 * row; PLACEHOLDER — P9 contract §4 *extended*, ADR 0008).
 *
 * LOAD (primary figures, Invariants I6 / I7): `design_load_weeks` = Σ design-kind
 * step durations over the active run for the hub's projects; `lab_load_weeks` =
 * Σ lab-kind durations × 1.0 for the hub's LAB REGION (repeated on every hub of
 * that region). `*_estimated_weeks` = Σ the projects' hand-entered estimates —
 * a secondary figure (OQ #12), never a schedule input.
 *
 * SUPPLY (the client's formulas, computed server-side to 2 dp):
 *   design_capacity_year      = working_weeks_per_engineer × engineer_fte_total
 *   design_capacity_remaining = ((52 − CURRENT_WEEK) − deductions × remaining_fraction) × Σ fte
 *   lab_capacity_year         = Σ chambers.efficient_lab_weeks   (region-level)
 *   lab_capacity_remaining    = lab_capacity_year × remaining_fraction
 *   gap = load − capacity;  completion_pct = capacity / load (null when load == 0)
 * Every figure is displayed verbatim; nothing is recomputed here (I17).
 */
export interface HubCapacityRow {
  hub: HubName;
  lab_region: LabRegion;
  design_load_weeks: number;
  design_load_estimated_weeks: number;
  lab_load_weeks: number;
  lab_load_estimated_weeks: number;
  engineer_fte_total: number;
  working_weeks_per_engineer: number;
  design_capacity_year: number;
  design_capacity_remaining: number;
  lab_capacity_year: number;
  lab_capacity_remaining: number;
  design_gap_year: number;
  design_completion_pct_year: number | null;
  design_gap_remaining: number;
  design_completion_pct_remaining: number | null;
  lab_gap_year: number;
  lab_completion_pct_year: number | null;
  lab_gap_remaining: number;
  lab_completion_pct_remaining: number | null;
  /** `(52 − CURRENT_WEEK) / 52`. */
  remaining_fraction: number;
  chambers: CapacityChamberRow[];
  /** @deprecated P3-era alias of `design_capacity_remaining`; kept one release, not read. */
  design_capacity_weeks?: number;
  /** @deprecated P3-era alias of `lab_capacity_remaining`; kept one release, not read. */
  lab_capacity_units?: number;
  /** @deprecated P3-era lab load (× 0.5); superseded by `lab_load_weeks` (ADR 0007). */
  lab_load_units?: number;
}

export interface HubCapacitySummary {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  /** `horizon_weeks - current_week` from the active run's snapshotted horizon. */
  remaining_weeks: number;
  rows: HubCapacityRow[];
}

/** One category's deliverable vs. left-out counts, from `GET /capacity/class-breakdown`. */
export interface ClassBreakdownRow {
  category: ProjectCategory;
  deliverable_count: number;
  left_out_count: number;
}

export interface ClassBreakdown {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  rows: ClassBreakdownRow[];
}

/**
 * Per-engineer weekly load from `GET /capacity/utilization-matrix`.
 *
 * P3-T09 (GDPR remediation, finding #1 / OPEN_QUESTIONS #8): the backend
 * `EngineerWeekLoad` schema has NO `name` field at all — it is withheld at the
 * API layer, not merely hidden by the frontend. `engineer_id`/`hub`/
 * `busy_weeks` are not personal data on their own and remain reportable. This
 * shape is declared only so the P3-T07 contract test covers the full endpoint
 * payload; the Capacity surface renders the CHAMBER side of the matrix
 * (equipment, not personal data) plus a visible "pending GDPR sign-off"
 * placeholder where a named-engineer view will go once OQ#8 is resolved.
 * P3-T07 contract-test fix: this type previously declared a required
 * `name: string` field that the backend removed in P3-T09 — removed here to
 * match; nothing in this surface ever read `.name` into a rendered value.
 */
export interface EngineerWeekLoad {
  engineer_id: Id;
  hub: HubName;
  busy_weeks: number[];
}

/**
 * One chamber's per-week concurrent-project count from `GET
 * /capacity/utilization-matrix`. `week_counts` keys are week numbers; JSON
 * object keys are strings. `count` vs `max_concurrent` shows over/under
 * utilization (only `max_concurrent` gates booking — ADR 0003).
 */
export interface ChamberWeekLoad {
  chamber_id: Id;
  code: string;
  lab_region: string;
  max_concurrent: number;
  week_counts: Record<string, number>;
}

export interface UtilizationMatrix {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  /** Present in the payload; intentionally NOT rendered — see EngineerWeekLoad. */
  engineers: EngineerWeekLoad[];
  chambers: ChamberWeekLoad[];
}

/** GET /schedule-runs/active — provenance enrichment only (solver + timestamp +
 *  horizon). The load/capacity figures do NOT come from here. 404 → no run yet. */
export interface ScheduleRunSummary {
  id: Id;
  version: number;
  solver_type: SolverType;
  status: ScheduleRunStatus;
  is_active: boolean;
  horizon_weeks: number;
  current_week: number;
  trigger_reason: string | null;
  /** P9-R02 (ruling 6): the solver's verdict, "OPTIMAL" / "FEASIBLE" for CP-SAT;
   *  null for greedy runs and older runs. Always present in the payload. */
  solver_status: string | null;
  created_at: string;
}
