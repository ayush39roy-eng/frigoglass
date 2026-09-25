// PLACEHOLDER — replace with OpenAPI-generated types in P3 (P3-T07 / P4 surface work).
// Hand-authored because P3 does not exist yet. Tracked as debt in the P4-T01 docs/MEMORY.md entry.

import type { Id, WeekNumber } from './common';
import type { SolverType, WorkflowStepKind } from './enums';

/** One of the 14 PDD workflow steps as scheduled for a project. */
export interface ScheduledStep {
  step_id: string; // "PDD-A" .. "PDD-N"
  name: string;
  kind: WorkflowStepKind;
  sequence_order: number;
  duration_weeks: number;
  planned_start_week: WeekNumber | null;
  planned_end_week: WeekNumber | null;
  actual_start_week: WeekNumber | null;
  actual_end_week: WeekNumber | null;
  assigned_engineer_id: Id | null;
  assigned_chamber_id: Id | null;
  eng_conflict: boolean;
  overlap: boolean;
}

/** Per-project outcome from a schedule run. `within_year` here is THE source for the
 *  Dashboard's within-year count — Invariant I9 forbids recomputing it in the frontend. */
export interface ProjectScheduleOutcome {
  project_id: Id;
  left_out: boolean;
  cat_not_allowed: boolean;
  spillover: boolean;
  within_year: boolean;
  delay_weeks_applied: number;
  last_step_end_week: WeekNumber | null;
  steps: ScheduledStep[];
}

export interface ScheduleRunSummary {
  id: Id;
  label: string;
  solver_type: SolverType;
  created_at: string;
  is_active: boolean;
  within_year_count: number;
  spillover_count: number;
  left_out_count: number;
}
