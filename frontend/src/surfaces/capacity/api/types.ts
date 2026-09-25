// PLACEHOLDER — mirror of backend/schemas/capacity.py + the ScheduleRunSummary
// slice of backend/schemas/schedule_run.py. Hand-authored because P3's OpenAPI
// schema is not generated into this repo yet (see src/types/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note (a)). P3-T07's contract test must
// catch drift between these shapes and the real schema.

import type { HubName, ProjectCategory, ScheduleRunStatus, SolverType } from '@/types/enums';
import type { Id } from '@/types/common';

/**
 * One hub's load vs. capacity, from `GET /capacity/hub-load` (→ HubCapacitySummary).
 *
 * `design_load_weeks` / `lab_load_units` are the Invariant I6 / I7 figures — Σ of
 * the active schedule run's booked design-step / (lab-step × 0.5) durations for
 * this hub. Displayed verbatim; never recomputed here.
 *
 * `design_capacity_weeks` / `lab_capacity_units` are the backend router's own
 * REPORTING formula: `Σ engineer.fte × remaining_weeks` and
 * `Σ chamber.max_concurrent × remaining_weeks × chamber.efficiency`. Per ADR
 * 0002 / ADR 0003 the scheduler itself applies NEITHER FTE nor efficiency
 * scaling — these are report-only supply estimates, not a statement about what
 * the scheduler did. Also displayed verbatim.
 */
export interface HubCapacityRow {
  hub: HubName;
  design_load_weeks: number;
  design_capacity_weeks: number;
  lab_load_units: number;
  lab_capacity_units: number;
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
  created_at: string;
}
