// PLACEHOLDER — hand-authored mirror of `backend/schemas/engineer.py`,
// `backend/schemas/chamber.py`, and the `ScheduleRunSummary`/`GreedyRecalcResponse`
// slice of `backend/schemas/schedule_run.py`. Hand-authored because P3's OpenAPI
// schema is not generated into this repo yet (see src/lib/api/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test must catch
// drift between these shapes and the real schema.
//
// Scope note (P4-T07): this is the CRUD surface for Engineer/Chamber resource
// *configuration*. It is deliberately distinct from
// `surfaces/registration/api/engineers-api.ts::EngineerOption`, a minimal
// read-only id/name/hub_id lookup for the Project Registration leader picker —
// see that file's own module docstring for why the two are not merged.

import type { EngineerAllowedCategory, HubName, LabRegion, ScheduleRunStatus, SolverType } from '@/types/enums';
import type { Id } from '@/types/common';

/** P19-T03: one figure on the two bases the page toggles between. `year` is
 *  weeks 1-52, `remaining` is the current week to W52 (shown as "YTD 2026"). */
export interface BasisPair {
  year: number;
  remaining: number;
}

// --- P19-T03: GET /planning/capacity-summary -------------------------------

export interface DesignHubSummary {
  hub: HubName;
  engineer_count: number;
  fte_total: number;
  weekdays_per_week: number;
  capacity_weeks: BasisPair;
  capacity_days: BasisPair;
  /** This hub's share of the design total, 0-100, per basis. */
  share_pct: BasisPair;
}

export interface DesignTotalSummary {
  engineer_count: number;
  fte_total: number;
  capacity_weeks: BasisPair;
  capacity_days: BasisPair;
}

export interface LabRegionSummary {
  lab_region: LabRegion;
  chamber_count: number;
  weekdays_per_week: number;
  capacity_weeks: BasisPair;
  capacity_days: BasisPair;
  share_pct: BasisPair;
}

export interface LabTotalSummary {
  chamber_count: number;
  capacity_weeks: BasisPair;
  capacity_days: BasisPair;
}

export interface CapacitySummary {
  current_week: number;
  design: { hubs: DesignHubSummary[]; total: DesignTotalSummary };
  lab: { regions: LabRegionSummary[]; total: LabTotalSummary };
}

// --- P19-T03: GET /planning/resource-load ----------------------------------

export type CapacityBasis = 'year' | 'remaining';

export interface EngineerLoadRow {
  engineer_id: Id;
  name: string;
  hub: HubName;
  weekdays_per_week: number;
  capacity_weeks: number;
  load_weeks: number;
  /** load / capacity × 100, served; null when capacity is 0. */
  utilization_pct: number | null;
  capacity_days: number;
  load_days: number;
}

export interface ChamberLoadRow {
  chamber_id: Id;
  code: string;
  lab_region: LabRegion;
  weekdays_per_week: number;
  capacity_weeks: number;
  load_weeks: number;
  utilization_pct: number | null;
  capacity_days: number;
  load_days: number;
}

export interface LoadTotals {
  capacity_weeks: number;
  load_weeks: number;
  utilization_pct: number | null;
  capacity_days: number;
  load_days: number;
}

/** The filters the server applied, echoed back (`schemas/planning.py`). */
export interface ResourceLoadFiltersApplied {
  hub_id: Id | null;
  region: LabRegion | null;
  project_type: string[];
  project_status: string[];
  requesting_department: string[];
  category: string[];
  engineer_id: Id[];
  basis: CapacityBasis;
}

export interface ResourceLoadResponse {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  current_week: number;
  basis: CapacityBasis;
  engineers: EngineerLoadRow[];
  chambers: ChamberLoadRow[];
  totals: { engineers: LoadTotals; chambers: LoadTotals };
  filters_applied: ResourceLoadFiltersApplied;
}

/** `GET /planning/resource-load/options` as served (`schemas/planning.py`). */
export interface ResourceLoadOptionsResponse {
  hubs: HubName[];
  lab_regions: LabRegion[];
  project_types: string[];
  project_statuses: string[];
  categories: string[];
  /** Always empty today: projects carry no requesting department (OQ #34). */
  requesting_departments: string[];
  requesting_department_available: boolean;
  engineers: { engineer_id: Id; name: string; hub: HubName }[];
}

/** One option of a filter combobox. */
export interface FilterOption {
  value: string;
  label: string;
}

/** The six analytics filters; an empty list / null means "All". `hub_id` is
 *  single-valued on the server, so the hub filter is a single choice. */
export interface ResourceLoadFilters {
  hubId: string | null;
  types: string[];
  statuses: string[];
  departments: string[];
  categories: string[];
  engineerIds: string[];
}

/**
 * `GET /engineers` / `GET /engineers/{id}` row (`backend/schemas/engineer.py::EngineerRead`).
 *
 * `fte` is stored and shown here verbatim. Since ADR 0032 (2026-10-21,
 * superseding ADR 0002; answers `docs/OPEN_QUESTIONS.md` #2) it gates the
 * scheduler's SPEED: a design step this engineer leads spans
 * `ceil(work / fte)` calendar weeks (0.5 FTE = half speed). It also scales the
 * RPD Capacity surface's design capacity (`working_weeks × Σ fte`, ADR 0008).
 * The browser never applies it: spans come from the run.
 */
export interface EngineerRead {
  id: Id;
  name: string;
  hub_id: Id;
  fte: number;
  allowed_categories: EngineerAllowedCategory[];
  user_id: Id | null;
  created_at: string;
  updated_at: string;
  /** P19-T03 (API_CONTRACT_P19 §2): the hub calendar's working days per week. */
  weekdays_per_week: number;
  /** P19-T03: the engineer's own ADR 0008 design capacity (their FTE on their
   *  hub's calendar), full year and remaining. */
  capacity_weeks: BasisPair;
  /** P19-T03: served `capacity_weeks × weekdays_per_week`. */
  capacity_days: BasisPair;
}

/** `POST /engineers` body (`EngineerCreateRequest`). `fte` defaults server-side
 *  to `1.0` if omitted; `gt=0`, no upper bound (see backend schema's own note —
 *  not DB-constrained to `<= 1` in case a future client answer allows
 *  multi-role `fte > 1.0`). */
export interface EngineerCreateRequest {
  name: string;
  hub_id: Id;
  fte?: number;
  allowed_categories?: EngineerAllowedCategory[];
  user_id?: Id | null;
}

/** `PATCH /engineers/{id}` body — every field optional (partial update). */
export type EngineerUpdateRequest = Partial<EngineerCreateRequest>;

/**
 * `GET /chambers` / `GET /chambers/{id}` row (`backend/schemas/chamber.py::ChamberRead`).
 *
 * Only `max_concurrent` gates lab-step booking (Invariant I2). `platforms`,
 * `efficiency` and the three downtime fields feed the ADR 0008 supply
 * formula shown on RPD Capacity; they do NOT constrain the scheduler.
 */
export interface ChamberRead {
  id: Id;
  code: string;
  lab_region: LabRegion;
  max_concurrent: number;
  platforms: number;
  efficiency: number;
  // PLACEHOLDER (P9 contract §3 addendum, orchestrator 2026-09-27): ADR 0008
  // downtime inputs replace the retired `weeks_per_chamber`.
  maintenance_weeks: number;
  breakdown_weeks: number;
  calibration_weeks: number;
  /** Derived server-side: 52 − region holidays − maintenance − breakdown − calibration. */
  working_weeks_per_chamber: number;
  /** Derived server-side: working weeks × efficiency × platforms. */
  efficient_lab_weeks: number;
  allowed_stages: string[];
  created_at: string;
  updated_at: string;
  /** P19-T03 (API_CONTRACT_P19 §3): the region calendar's working days per week. */
  weekdays_per_week: number;
  /** P19-T03: working weeks of this chamber (the "Wks/ch" column). */
  working_weeks: number;
  /** P19-T03: efficient lab weeks, full year and remaining (ADR 0008). */
  capacity_weeks: BasisPair;
  /** P19-T03: served `capacity_weeks × weekdays_per_week`. */
  capacity_days: BasisPair;
}

/** `POST /chambers` body (`ChamberCreateRequest`). `allowed_stages` must be
 *  lab-kind step ids only — `backend/api/routers/chambers.py::_validate_allowed_stages`
 *  422s otherwise; this is the authority, not this surface's picker. */
export interface ChamberCreateRequest {
  code: string;
  lab_region: LabRegion;
  max_concurrent: number;
  platforms?: number;
  efficiency?: number;
  /** ≥ 0; the server defaults 2 / 0 / 1 on create when omitted. */
  maintenance_weeks?: number;
  breakdown_weeks?: number;
  calibration_weeks?: number;
  allowed_stages?: string[];
}

/** `PATCH /chambers/{id}` body — every field optional (partial update). */
export type ChamberUpdateRequest = Partial<ChamberCreateRequest>;

/** `GET /schedule-runs/active` (→ `ScheduleRunSummary`) — provenance display
 *  only for the Apply Logic panel; the run's own fields, never recomputed. */
export interface ScheduleRunSummary {
  id: Id;
  version: number;
  solver_type: SolverType;
  status: ScheduleRunStatus;
  is_active: boolean;
  horizon_weeks: number;
  current_week: number;
  trigger_reason: string | null;
  /** P9-R02 (ruling 6): "OPTIMAL" / "FEASIBLE" for CP-SAT; null for greedy. */
  solver_status: string | null;
  created_at: string;
}

/**
 * `POST /schedule-runs/greedy-recalc` response (`GreedyRecalcResponse`) — see
 * `components/apply-logic-panel.tsx`'s module docstring for why this endpoint,
 * not a bespoke "apply logic" endpoint, is what "Apply Logic" calls. Every
 * count here is the backend's own aggregate over `schedule_output.project_outcomes`
 * — never recomputed client-side (Invariant I9).
 */
export interface GreedyRecalcResponse {
  schedule_run: ScheduleRunSummary;
  project_count: number;
  left_out_count: number;
  within_year_count: number;
  spillover_count: number;
}
