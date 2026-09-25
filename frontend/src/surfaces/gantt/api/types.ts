// PLACEHOLDER — hand-authored mirror of `backend/schemas/gantt.py`. P3's OpenAPI
// schema is not generated into this repo yet (see `src/types/README.md` and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test must catch
// drift between these shapes and the real schema.

import type { HubName, ProjectCategory, ProjectPriority, WorkflowStepKind } from '@/types/enums';
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
  kind: WorkflowStepKind;
  sequence_order: number;
  duration_weeks: number | null;
  planned_start_week: number | null;
  planned_end_week: number | null;
  actual_start_week: number | null;
  actual_end_week: number | null;
  assigned_engineer_name: string | null;
  assigned_chamber_code: string | null;
  eng_conflict: boolean;
  chamber_overlap: boolean;
}

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
  steps: GanttStepRow[];
}

/** `GET /gantt` (`GanttResponse`). */
export interface GanttResponse {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  total_count: number;
  rows: GanttProjectRow[];
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
