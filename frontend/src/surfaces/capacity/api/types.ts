// PLACEHOLDER — mirror of backend/schemas/capacity.py + the ScheduleRunSummary
// slice of backend/schemas/schedule_run.py. Hand-authored because P3's OpenAPI
// schema is not generated into this repo yet (see src/types/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note (a)). P3-T07's contract test must
// catch drift between these shapes and the real schema.

import type { BookingStatus, HubName, LabRegion, ProjectCategory, ScheduleRunStatus, SolverType } from '@/types/enums';
import type { Id } from '@/types/common';

/** P19-T03 (API_CONTRACT_P19): one figure on both bases, 2 dp. A LOAD pair
 *  carries the same value twice (load has no basis). */
export interface YearRemaining {
  year: number;
  remaining: number;
}

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
 * P29 (ADR 0042, API_CONTRACT_P29 §2.2): one hub of a capacity hub's row.
 * Display only: there is no per-member capacity, so no per-member booked % or
 * status exists anywhere (I19).
 */
export interface CapacityHubMember {
  /** "R&D-Greece" | "OEM-HCK" | "OEM-Seltek". */
  hub: HubName;
  /** True for the capacity hub itself (listed first when in scope). */
  own: boolean;
  /** Projects of this hub with at least one non-skipped design step in the active run. */
  project_count: number;
  /** Integer effort weeks of those projects (I6 per hub); 0 with no run. */
  design_load_weeks: number;
}

/**
 * One CAPACITY hub's load vs. supply, from `GET /capacity/hub-load` (→ HubCapacitySummary
 * row). P29 (ADR 0042): rows are the four capacity hubs only; R&D-Greece's row
 * aggregates OEM-HCK and OEM-Seltek (load) and serves `members` for display.
 * (PLACEHOLDER — P9 contract §4 *extended*, ADR 0008.)
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
  // PLACEHOLDER (P11 contract §4, ADR 0016): booked % = load / capacity × 100
  // (2 dp, null when capacity == 0) and its status, both SERVER-derived (I19).
  design_booked_pct_year: number | null;
  design_booked_pct_remaining: number | null;
  lab_booked_pct_year: number | null;
  lab_booked_pct_remaining: number | null;
  design_booking_status_year: BookingStatus;
  design_booking_status_remaining: BookingStatus;
  lab_booking_status_year: BookingStatus;
  lab_booking_status_remaining: BookingStatus;
  /** From the hub's lab region: Greece/Romania → Europe, India → India. */
  area: CapacityAreaName;
  /** P13-T11 (API_CONTRACT_P13 §6): `design_load_weeks` split by priority
   *  bucket, weeks, 2 dp, server-side. The buckets sum to `design_load_weeks`. */
  design_load_by_priority: PriorityLoadSplit;
  /** P13-T11: `lab_load_weeks` split by priority bucket, summing to it. Region-level
   *  like `lab_load_weeks`, so it repeats on every hub row of the same lab region
   *  and must never be added across hubs of one region. */
  lab_load_by_priority: PriorityLoadSplit;
  // P19-T03 (API_CONTRACT_P19 §1): served day figures (weeks × the served
  // weekdays; never multiplied in the browser).
  weekdays_per_week: number;
  capacity_days: YearRemaining;
  load_days: YearRemaining;
  lab_weekdays_per_week: number;
  lab_capacity_days: YearRemaining;
  lab_load_days: YearRemaining;
  /** P29 (ADR 0042, API_CONTRACT_P29 §2.2): the hubs this capacity hub's row
   *  covers, for display only. `[]` on a capacity hub with no member hubs; on
   *  R&D-Greece: own first, then OEM-HCK / OEM-Seltek, only the hubs in the
   *  caller's scope. Never summed in the browser: the row's own
   *  `design_load_weeks` is the total (a scoped caller sees a partial list). */
  members: CapacityHubMember[];
  /** P29: the request's `hub_id` when it is one of this row's hubs (own or
   *  member), else null. Highlight that member. */
  selected_member: HubName | null;
  /** @deprecated P3-era alias of `design_capacity_remaining`; kept one release, not read. */
  design_capacity_weeks?: number;
  /** @deprecated P3-era alias of `lab_capacity_remaining`; kept one release, not read. */
  lab_capacity_units?: number;
  /** @deprecated P3-era lab load (× 0.5); superseded by `lab_load_weeks` (ADR 0007). */
  lab_load_units?: number;
}

/** PLACEHOLDER (P11 contract §4, ADR 0016 §2). `full` ≥ 100 % (or capacity 0
 *  with load), `near_full` 85–<100 %, else `available`. Never re-derived here.
 *  Declared in `types/enums.ts` so the shared chip can use it. */
export type { BookingStatus } from '@/types/enums';

/** PLACEHOLDER (P11 contract §4, ADR 0016 §3). */
export type CapacityAreaName = 'Europe' | 'India';

/**
 * PLACEHOLDER (P11 contract §4): one area's roll-up over the caller's IN-SCOPE
 * hubs and lab regions (each lab region counted once, server-side). `hubs` and
 * `lab_regions` say exactly what the figures cover, so a hub-scoped user's
 * partial area is never presented as the whole area.
 */
export interface CapacityArea {
  area: CapacityAreaName;
  hubs: HubName[];
  lab_regions: LabRegion[];
  design_load_weeks: number;
  design_capacity_year: number;
  design_capacity_remaining: number;
  lab_load_weeks: number;
  lab_capacity_year: number;
  lab_capacity_remaining: number;
  design_booked_pct_year: number | null;
  design_booked_pct_remaining: number | null;
  lab_booked_pct_year: number | null;
  lab_booked_pct_remaining: number | null;
  design_booking_status_year: BookingStatus;
  design_booking_status_remaining: BookingStatus;
  lab_booking_status_year: BookingStatus;
  lab_booking_status_remaining: BookingStatus;
}

export interface HubCapacitySummary {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  /** `horizon_weeks - current_week` from the active run's snapshotted horizon. */
  remaining_weeks: number;
  rows: HubCapacityRow[];
  /** PLACEHOLDER (P11 contract §4): `BOOKING_NEAR_FULL_PCT` (85). */
  near_full_threshold_pct: number;
  /** PLACEHOLDER (P11 contract §4): `BOOKING_FULL_PCT` (100). */
  full_threshold_pct: number;
  /** PLACEHOLDER (P11 contract §4): Europe then India; an area with no
   *  in-scope hub is omitted. */
  areas: CapacityArea[];
  /** P13-T11 addendum: served portfolio totals over `rows` (design per hub,
   *  lab per lab region once). Render verbatim; never sum rows client-side. */
  totals: CapacityTotals;
  /** P19-T03 (API_CONTRACT_P19 §1): one row per lab region, served once
   *  (Greece, India, Romania; only regions of the served rows). */
  lab_regions: LabRegionCapacityRow[];
}

/** P19-T03 (API_CONTRACT_P19 §1). */
export interface LabRegionCapacityRow {
  lab_region: LabRegion;
  weekdays_per_week: number;
  chamber_count: number;
  capacity_weeks: YearRemaining;
  load_weeks: number;
  capacity_days: YearRemaining;
  load_days: YearRemaining;
}

/** P13-T11 addendum: the total over the served hub rows (I9/I19). */
export interface CapacityTotals {
  hubs: HubName[];
  lab_regions: LabRegion[];
  design_load_weeks: number;
  design_capacity_year: number;
  design_capacity_remaining: number;
  design_booked_pct_year: number | null;
  design_booked_pct_remaining: number | null;
  design_booking_status_year: BookingStatus;
  design_booking_status_remaining: BookingStatus;
  design_load_by_priority: PriorityLoadSplit;
  lab_load_weeks: number;
  lab_capacity_year: number;
  lab_capacity_remaining: number;
  lab_booked_pct_year: number | null;
  lab_booked_pct_remaining: number | null;
  lab_booking_status_year: BookingStatus;
  lab_booking_status_remaining: BookingStatus;
  lab_load_by_priority: PriorityLoadSplit;
  // P19-T03: day totals = Σ the rows' served days (design per hub, lab per region once).
  design_capacity_days: YearRemaining;
  design_load_days: YearRemaining;
  lab_capacity_days: YearRemaining;
  lab_load_days: YearRemaining;
}

/**
 * P13-T11 (API_CONTRACT_P13 §6): one figure per priority bucket. "Queue" is a
 * project whose priority is Q or null (P13-T11 backend decision, accepted by
 * the orchestrator 2026-10-18 — status does not enter it). Served verbatim; the
 * browser never re-buckets a project.
 */
export interface PriorityLoadSplit {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  Queue: number;
}

/** P13-T11: project counts per priority bucket (same keys as `PriorityLoadSplit`). */
export interface PriorityCountSplit {
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  Queue: number;
}

/** P13-T11: one hub's deliverable / left-out counts within a category (backend
 *  `ClassBreakdownHubRow`). Only hubs with at least one project; `[]` without a run. */
export interface ClassHubSplit {
  hub: HubName;
  deliverable: number;
  left_out: number;
}

/** One category's deliverable vs. left-out counts, from `GET /capacity/class-breakdown`. */
export interface ClassBreakdownRow {
  category: ProjectCategory;
  deliverable_count: number;
  left_out_count: number;
  /** P13-T11 addendum: `deliverable_count + left_out_count`, served. */
  total_count: number;
  /** P13-T11: `deliverable_count` split by priority bucket (counts). */
  deliverable_by_priority: PriorityCountSplit;
  /** P13-T11: `left_out_count` split by priority bucket (counts). */
  left_out_by_priority: PriorityCountSplit;
  /** P13-T11: per-hub deliverable / left-out counts for this category. */
  by_hub: ClassHubSplit[];
}

export interface ClassBreakdown {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  rows: ClassBreakdownRow[];
}

/**
 * Per-engineer weekly load from `GET /capacity/utilization-matrix`.
 *
 * P3-T09: the backend `EngineerWeekLoad` schema has NO `name` field. Named
 * per-engineer utilization is served by `GET /capacity/engineer-utilization`
 * instead (ADR 0028, P15). `engineer_id`/`hub`/
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

/** One engineer-week of `GET /capacity/engineer-utilization` (P15, ADR 0028). All
 *  figures server-computed (I9); `utilization_pct` is a 0-100 percentage. */
export interface EngineerWeekUtilization {
  week: number;
  booked: number;
  capacity: number;
  utilization_pct: number;
}

export interface EngineerUtilizationRow {
  id: Id;
  name: string;
  /** P29: always a capacity hub. */
  hub: HubName;
  role: string;
  /** P29 (ADR 0042 §5): false for a leader who is booked but not on the
   *  client's capacity roster (no supply). Show "Not in capacity roster". */
  counts_in_capacity: boolean;
  total_booked: number;
  total_capacity: number;
  utilization_pct: number;
  weeks: EngineerWeekUtilization[];
}

/** GET /capacity/engineer-utilization?hub_id=&region= (P15-T01, ADR 0028). */
export interface EngineerUtilizationResponse {
  week_range: [number, number];
  current_week: number;
  engineers: EngineerUtilizationRow[];
}

/**
 * One chamber's per-week concurrent-project count from `GET
 * /capacity/utilization-matrix`. `week_counts` keys are week numbers; JSON
 * object keys are strings. `count` vs `max_concurrent` shows over/under
 * utilization (only `max_concurrent` gates booking — ADR 0003).
 *
 * P19-T07: the Capacity page no longer renders or fetches this endpoint (owner
 * removal of the chamber matrix). The shape stays declared because the backend
 * contract test (`test_openapi_frontend_contract.py`) mirrors it.
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
