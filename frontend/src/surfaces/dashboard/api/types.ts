// PLACEHOLDER — mirror of backend/schemas/dashboard.py + the ScheduleRunSummary
// slice of backend/schemas/schedule_run.py. Hand-authored because P3's OpenAPI
// schema is not generated into this repo yet (see src/types/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test must catch
// drift between these shapes and the real schema.

import type {
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
  HubName,
  SolverType,
  ScheduleRunStatus,
} from '@/types/enums';
import type { Id, WeekNumber } from '@/types/common';

/** GET /dashboard/pipeline-totals — portfolio *composition* (carry_over vs new),
 *  NOT the scheduling SPILLOVER flag. See the backend PipelineTotals docstring. */
export interface PipelineTotals {
  spillover_count: number;
  new_count: number;
  total_count: number;
}

/** GET /dashboard/status-overview */
export interface StatusOverview {
  in_buyoff: number;
  under_industrialization: number;
  in_development: number;
  in_queue: number;
  other_counts: Record<string, number>;
}

/** GET /dashboard/hub-type-pipeline — one row per (hub, type) with a project count. */
export interface HubTypePipelineRow {
  hub: HubName;
  type: ProjectType | null;
  count: number;
}

/** One project's outcome in the active schedule run (I9 source rows). */
export interface CompletingWithinYearRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
  category: ProjectCategory | null;
  priority: ProjectPriority | null;
  within_year: boolean;
  spillover: boolean;
  left_out: boolean;
  cat_not_allowed: boolean;
  last_step_end_week: WeekNumber | null;
}

/** GET /dashboard/completing-within-year — the Invariant I9 endpoint. Every
 *  headline count on the Dashboard traces to a field on THIS response. */
export interface CompletingWithinYear {
  has_active_schedule_run: boolean;
  schedule_run_version: number | null;
  within_year_count: number;
  spillover_count: number;
  left_out_count: number;
  rows: CompletingWithinYearRow[];
}

/** One row of GET /dashboard/projects (the "analytics breakdown with filters"). */
export interface ProjectFilterRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
  category: ProjectCategory | null;
  status: ProjectStatus;
  priority: ProjectPriority | null;
}

export interface ProjectFilterResult {
  total_count: number;
  rows: ProjectFilterRow[];
}

export interface ProjectFilterParams {
  hub_id?: Id | undefined;
  category?: ProjectCategory | undefined;
  status_?: ProjectStatus | undefined;
  priority?: ProjectPriority | undefined;
}

/** GET /schedule-runs/active — used only to enrich the provenance caption
 *  (solver type, when it was computed). The headline numbers do NOT come from
 *  here; they come from CompletingWithinYear. 404 when nothing has been run. */
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
