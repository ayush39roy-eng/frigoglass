// PLACEHOLDER — hand-authored mirror of `backend/schemas/gantt.py`. P3's OpenAPI
// schema is not generated into this repo yet (see `src/types/README.md` and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test must catch
// drift between these shapes and the real schema.

import type { EditBase } from '@/lib/api/edit-conflict';
import type {
  HubName,
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
  ScheduleOutcome,
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
  /** P12 contract §3; P33 (contract Part G): the project's copy of the
   *  category template length — the same value as `plan_weeks`, served under
   *  both names. `duration_weeks` above is the effective duration the active
   *  run booked. */
  lead_time_weeks: number;
  /** P30 (API_CONTRACT_P30 §3, ADR 0041): the step's share of the project's
   *  client effort figure, server-derived (0..104; 0 = skipped by the split);
   *  null = no effort split. */
  effort_weeks: number | null;
  /** P33 (contract Part G, ADR 0046 §B): the project's copied template
   *  length (0..104). Read-only — per-project timing editing is retired
   *  (ADR 0048). */
  plan_weeks: number;
  /** P33 (Part G): the signed copied gap (`plan_gap_weeks`, −104..104):
   *  negative = runs in parallel with the work it waits for by that many
   *  weeks ("parallel N wk"), positive = waits that many weeks after it
   *  ("wait N wk"), 0 = neither. Rendered verbatim, never interpreted. */
  gap_weeks: number;
  /** P33 (Part G, OR-1): the step's kind follows the project's own effort
   *  figure, so its duration is `effort_weeks`, not `plan_weeks`. */
  own_effort: boolean;
  /** P20-T02 (ADR 0032, reconciled with `backend/schemas/gantt.py`): the leader
   *  FTE the active run stretched this step's calendar span by
   *  (`ceil(work / fte)`). `null` for lab, elapsed, skipped and Done steps,
   *  frozen projects, steps with no leader, runs persisted before P20-T02, and
   *  (OQ #8, part-time status is personal data) for every caller without
   *  GANTT write on the project's hub. Only the bar's hover text reads it. */
  span_fte: number | null;
  /** P32 (A3): the template's predecessor step ids, sorted. Served; not read
   *  by the read-only Timeline (P33-T15). */
  predecessor_ids: string[];
  /** P40 (ADR 0054, docs/API_CONTRACT_P40.md §2): the LIVE manual pin, end
   *  inclusive; both null when none. While it differs from this row's run
   *  window the step reads "Pin applies on the next run". */
  manual_start_week: number | null;
  manual_end_week: number | null;
  /** P40: the active run placed this step on a pin. */
  pinned: boolean;
  /** P40 (R40-7): the pinned row starts before its release allows. Warning only. */
  manual_overlap: boolean;
  /** P40 (R40-2): served current length; typing a Start gives
   *  `End = Start + current_length_weeks − 1`. Never derived here. */
  current_length_weeks: number;
  /** P40: the caller may set a pin on this step now. */
  pin_editable: boolean;
  /** P40: why not, when `pin_editable` is false. */
  pin_block_reason: PinBlockReason | null;
  /** P40-R02 (docs/API_CONTRACT_P40.md §2): this step's own lapse, served.
   *  True iff the active run's row is `pinned` and its window differs from the
   *  pin recorded in that run's snapshot. Never derived here. */
  pin_lapsed: boolean;
  /** P40-R02: the caller may Clear this step's pin now (Admin / Super Admin,
   *  in scope, live step, project not frozen). Same rules as the save. */
  pin_clearable: boolean;
}

/** P40 (R40-2): served reason a step's pin cannot be set. */
export type PinBlockReason =
  | 'NOT_ALLOWED'
  | 'PROJECT_FROZEN'
  | 'PROJECT_CLOSED'
  | 'STEP_STARTED'
  | 'STEP_SKIPPED';

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
  /** P57 (ADR 0067): served project status and `priority_applicable` (false
   *  for Commercialized / Cancelled: the row reads "Not applicable"). */
  status: ProjectStatus;
  priority_applicable: boolean;
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
  /** P40 (R40-5): some pin's start had passed; placed from the run's week. */
  pin_lapsed: boolean;
  /** P40 (R40-7): OR of the steps' `manual_overlap`. */
  manual_overlap: boolean;
  /** P42 (API_CONTRACT_P42 §4, R42-1): the band label; null with no band. */
  priority_label?: string | null;
  /** P42: the stored flags (defaults true / false with no outcome row). A
   *  not-scheduled project has no step rows, so its weeks are null (I23). */
  counts_toward_year?: boolean;
  not_scheduled_priority?: boolean;
  /** P42: the served exclusive bucket; null with no outcome row. */
  outcome?: ScheduleOutcome | null;
  /** P42: the served non-counting text ("Queued — fits by W40", "Not
   *  scheduled (P4)"); null for a counting project. */
  outcome_label?: string | null;
  /** P53 (R53-9, API_CONTRACT_P53 §4.3): scheduled and finishing after the
   *  year after the plan year — "Finishes {year} — check leader load".
   *  Display only; never a scheduler input (I63). */
  far_finish?: boolean;
  steps: GanttStepRow[];
}

/** P13 contract §7: active steps per week for the filtered set, per workflow,
 *  counted server-side. */
export interface GanttWeeklyActiveCount {
  week: number;
  pdd: number;
  oem: number;
  /** P40-T01 (docs/API_CONTRACT_P40.md §3): the same active steps per step
   *  code (e.g. `"PDD-A"`), zero counts omitted; sums to `pdd + oem`. */
  by_step: Record<string, number>;
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
  /** P40-T01: projects of the filtered set with an active run step covering
   *  `current_week`, per step code. `{}` without an active run. */
  current_step_counts: Record<string, number>;
  /** P40-T01: the plan week `current_step_counts` was taken at; null without
   *  an active run. */
  current_week: number | null;
  /** P53 (R53-6, API_CONTRACT_P53 §7): the run's plan-year window and the
   *  largest end week of a non-skipped row (never below the plan-year end;
   *  null without a run). The axis runs to `last_finish_week`, never to the
   *  search limit. Optional only for pre-P53 fixtures. */
  plan_year_start_week?: number | null;
  plan_year_end_week?: number | null;
  last_finish_week?: number | null;
}

/** P40 (docs/API_CONTRACT_P40.md §1): one item of `PUT /gantt/step-pins`.
 *  Both weeks null = Clear. End inclusive. */
export interface StepPinItem {
  project_id: Id;
  step_template_id: string;
  manual_start_week: number | null;
  manual_end_week: number | null;
  /** P47 (ADR 0059 C1): the stored pair as read when the step was first edited. */
  base?: EditBase;
}

/** `PUT /gantt/step-pins` body (`StepPinsRequest`, 1..500 items). */
export interface StepPinsRequest {
  items: StepPinItem[];
}

/** One changed stored pair in `StepPinsResponse.changes`. */
export interface StepPinChange {
  project_id: Id;
  step_template_id: string;
  action: 'pinned' | 'cleared';
  before_start_week: number | null;
  before_end_week: number | null;
  manual_start_week: number | null;
  manual_end_week: number | null;
}

/** `PUT /gantt/step-pins` 200 body. Recalc fields as the priority move. */
export interface StepPinsResponse {
  changes: StepPinChange[];
  unchanged_count: number;
  projects_marked_stale: Id[];
  current_week: number;
  recalc_status: 'queued' | 'deferred' | 'not_needed' | 'unchanged' | 'applied' | 'dispatch_failed';
  schedule_run_id: Id | null;
  baseline_run_id: Id | null;
  task_id: string | null;
}

/** One element of `detail.errors` on a refused `PUT /gantt/step-pins`. */
export interface StepPinError {
  index: number;
  project_id: Id;
  step_template_id: string;
  code:
    | 'DUPLICATE_STEP'
    | 'PIN_INVALID'
    | 'PIN_OUT_OF_RANGE'
    | 'PROJECT_NOT_FOUND'
    | 'UNKNOWN_STEP'
    | 'PROJECT_FROZEN'
    | 'PROJECT_CLOSED'
    | 'STEP_STARTED'
    | 'STEP_SKIPPED';
  message: string;
}

/** `POST /gantt/projects/{project_id}/freeze` body (`FreezeToggleRequest`,
 *  `extra="forbid"`). `actual_start_week` is required by the API whenever
 *  `frozen` is `true`. */
export interface FreezeToggleRequest {
  frozen: boolean;
  actual_start_week?: number;
  /** P47 (ADR 0059 C1): the value as read of each field sent; `{}` = no check. */
  base?: EditBase;
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
