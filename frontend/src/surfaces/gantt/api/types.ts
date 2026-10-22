// PLACEHOLDER — hand-authored mirror of `backend/schemas/gantt.py`. P3's OpenAPI
// schema is not generated into this repo yet (see `src/types/README.md` and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test must catch
// drift between these shapes and the real schema.

import type {
  HubName,
  ProjectCategory,
  ProjectPriority,
  ProjectType,
  WorkflowId,
  WorkflowStepKind,
  WorkflowStepStatus,
} from '@/types/enums';
import type { Id } from '@/types/common';

/**
 * One scheduled workflow step (`GanttStepRow`). Planned weeks + `eng_conflict` /
 * `chamber_overlap` come from the active `ScheduleRun` snapshot; actual weeks from
 * the live `ProjectWorkflowStep`. All server-sourced — never recomputed here.
 *
 * `assigned_engineer_name` is currently withheld by the API for non-self readers
 * pending `docs/OPEN_QUESTIONS.md` #8 (GDPR) — treat it as usually `null`.
 */
export interface GanttStepRow {
  step_id: string;
  step_name: string;
  /** PLACEHOLDER (P9 contract §5): `design` | `lab` | `elapsed` (ADR 0007). */
  kind: WorkflowStepKind;
  sequence_order: number;
  /** PLACEHOLDER (P9 contract §5): 0-week lead time, or a lab step on a project
   *  without certification testing — occupies nothing; omitted from the bar area. */
  skipped: boolean;
  /** PLACEHOLDER (P9 contract §5): per-stage progress status (ADR 0006). */
  status: WorkflowStepStatus;
  /** PLACEHOLDER (P9 contract §5). */
  percent_complete: number;
  duration_weeks: number | null;
  planned_start_week: number | null;
  planned_end_week: number | null;
  actual_start_week: number | null;
  actual_end_week: number | null;
  assigned_engineer_name: string | null;
  assigned_chamber_code: string | null;
  eng_conflict: boolean;
  chamber_overlap: boolean;
  /** P12 contract §3 (reconciled with `backend/schemas/gantt.py`): the lead-time table value. */
  lead_time_weeks: number;
  /** P12 contract §3, ADR 0019 (reconciled); P30 (ADR 0041 R4): the USER's
   *  duration for the step (Gantt / Workspace) only; null = none. `duration_weeks`
   *  above is the effective duration (user ?? effort ?? lead). */
  duration_override_weeks: number | null;
  /** P30 (API_CONTRACT_P30 §3, ADR 0041 R4): the step's share of the project's
   *  client effort figure, server-derived (0..104; 0 = skipped by the split);
   *  null = no effort split. Never a "timing edit". */
  effort_weeks: number | null;
  /** P12 contract §3, ADR 0019 (reconciled): earliest start floor; null = none. */
  start_not_before_week: number | null;
  /** P12 contract §3 (reconciled): what the Gantt may do with this bar for the
   *  caller, decided server-side (ADR 0019 §4 + GANTT write on the project). */
  timing_editable: TimingEditable;
  /** P20-T02 (ADR 0032, reconciled with `backend/schemas/gantt.py`): the leader
   *  FTE the active run stretched this step's calendar span by
   *  (`ceil(work / fte)`). `null` for lab, elapsed, skipped and Done steps,
   *  frozen projects, steps with no leader, runs persisted before P20-T02, and
   *  (OQ #8, part-time status is personal data) for every caller who may not
   *  edit this step's timing. Only the right-edge drag and its labels read it. */
  span_fte: number | null;
}

/** ADR 0019 §4: `move_resize` (Not Started), `resize` (In Progress / On Hold),
 *  `none` (Done, skipped, frozen / non-schedulable project, or no write). */
export type TimingEditable = 'move_resize' | 'resize' | 'none';

/** ADR 0021: per-project live tracking status, served. */
export type TrackingStatus = 'live' | 'due' | 'overdue' | 'idle';

/** One project row (`GanttProjectRow`). Project-level flags are from the active
 *  run's outcome snapshot — `left_out` / `spillover` / `cat_not_allowed` are the
 *  server's verdict, never a client comparison (Invariant I9). */
export interface GanttProjectRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
  category: ProjectCategory | null;
  priority: ProjectPriority | null;
  frozen: boolean;
  delay_weeks: number;
  left_out: boolean;
  spillover: boolean;
  cat_not_allowed: boolean;
  /** PLACEHOLDER (P9 contract §5): the four completion weeks + slip, ALL
   *  server-stored on the active run's outcome row / the project record
   *  (Invariant I16 — the browser draws them, never derives them). */
  target_end_week: number | null;
  /** `target_end_week` if set, else `unconstrained_end_week` — decided server-side. */
  expected_end_week: number | null;
  /** `end_week + delay_weeks`; null when left out / excluded. */
  projected_end_week: number | null;
  unconstrained_end_week: number | null;
  /** `projected − expected`, may be negative; null when either is null. */
  slip_weeks: number | null;
  /** PLACEHOLDER (P9 contract §5): a stage is Blocked (ADR 0006). */
  blocked: boolean;
  /** PLACEHOLDER (P9 contract §5): progress or settings changed since this run. */
  schedule_stale: boolean;
  /** PLACEHOLDER (P9 contract §5). */
  workflow_id: WorkflowId;
  /** P12 contract §3, ADR 0022 (reconciled): pinned VIP project. */
  is_vip: boolean;
  /** P12 contract §3, ADR 0021 (reconciled): served by `services.tracking`. */
  tracking_status: TrackingStatus;
  /** P13 contract §7 (T13): the project's external code, e.g. `24-00221_1`; null if absent. */
  external_code: string | null;
  /** P13 contract §7: null if unmapped. */
  type: ProjectType | null;
  /** P13 contract §7, GDPR rule as in §3 (OQ #8): null unless the leader is the
   *  caller. With a `leader_engineer_id` it is rendered "Withheld" — never
   *  resolved here. */
  leader_name: string | null;
  /** Always served (reconciled with `backend/schemas/gantt.py`); null = no leader. */
  leader_engineer_id: Id | null;
  /** P13 contract §7: served effective design / lab / total weeks (the
   *  mock-up's "Total 17W · 5 DW / 0 LW"). Displayed verbatim, never summed
   *  here. All null when the project has no step in the active run. */
  design_weeks: number | null;
  lab_weeks: number | null;
  total_weeks: number | null;
  steps: GanttStepRow[];
}

/** P13 contract §7: active steps per week for the filtered set, per workflow,
 *  counted server-side. */
export interface GanttWeeklyActiveCount {
  week: number;
  pdd: number;
  oem: number;
}

/** `GET /dashboard/projects/facets` (P13 contract §3), reused for the Gantt's
 *  Leader / Step filter options. GDPR (OQ #8): `name` is null unless the
 *  leader is the caller. */
export interface GanttFacets {
  leaders: { id: Id; name: string | null }[];
  steps: { code: string; name: string }[];
}

/** P13 contract §7: `GET /gantt?sort=`. */
export type GanttSort = 'priority' | 'name' | 'start' | 'end';
export const GANTT_SORTS: readonly GanttSort[] = ['priority', 'name', 'start', 'end'];

/** `GET /gantt` (`GanttResponse`). */
export interface GanttResponse {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  total_count: number;
  rows: GanttProjectRow[];
  /** P13 contract §7 (T13): one entry per week; drives the PDD / OEM count row. */
  weekly_active_counts: GanttWeeklyActiveCount[];
}

/** `POST /gantt/projects/{project_id}/freeze` body (`FreezeToggleRequest`,
 *  `extra="forbid"`). `actual_start_week` is required by the API whenever
 *  `frozen` is `true`. */
export interface FreezeToggleRequest {
  frozen: boolean;
  actual_start_week?: number;
}

/** `POST /gantt/projects/{project_id}/freeze` response — the updated project
 *  (`ProjectRead`). Only the fields the surface reads are typed. */
export interface FreezeToggleResponse {
  id: Id;
  name: string;
  frozen: boolean;
  actual_start_week: number | null;
}

/** Minimal `GET /schedule-runs/active` slice for the provenance caption. */
export interface GanttActiveRun {
  version: number;
  solver_type: 'greedy' | 'cp_sat';
  created_at: string;
}

/** P12 contract §3 (reconciled with `backend/schemas/step_timing.py`, pinned
 *  `exact` by `test_openapi_frontend_contract.py`): `PATCH …/steps/{step_id}/timing`
 *  body (`extra="forbid"`). Send either field or both; an absent field is left
 *  as it is and an explicit `null` clears it. */
export interface StepTimingRequest {
  duration_override_weeks?: number | null;
  start_not_before_week?: number | null;
}

/** P12 contract §3 (reconciled, pinned `exact`): the 200 response. */
export interface StepTimingResponse {
  project_id: Id;
  step_id: string;
  duration_override_weeks: number | null;
  start_not_before_week: number | null;
  /** P30: `user ?? effort ?? lead`, served; 0 when skipped. */
  effective_duration_weeks: number;
  /** P30 (API_CONTRACT_P30 §3): what "Reset timing" falls back to. */
  effort_weeks: number | null;
  /** P30: the lead-time table value. */
  lead_time_weeks: number;
  recalc_status: 'queued' | 'deferred' | 'not_needed' | 'unchanged' | 'applied' | 'dispatch_failed';
  schedule_run_id: Id | null;
  baseline_run_id: Id | null;
  task_id: string | null;
}
