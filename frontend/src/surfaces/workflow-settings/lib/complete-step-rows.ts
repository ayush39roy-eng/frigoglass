import { SCHEDULABLE_STATUSES, type ProjectStatus } from '@/types/enums';
import type { GanttProjectRow, GanttStepRow, TimingEditable } from '@/surfaces/gantt/api/types';
import type { WorkspaceStage } from '@/surfaces/project-workspace/api/types';

/**
 * P32-R04 follow-up: `GET /gantt` builds a project's step rows from the
 * steps the active run PLACED (`ScheduleRunProjectStep`). A project the run
 * left out has none (`steps: []`), and a partly placed one only some. The
 * Workflow page still lists all of its steps, so the planner can fix exactly
 * these projects. A missing step is taken from the Workspace stage row
 * (`GET /projects/{id}/workspace`), which has the step id the PATCH needs.
 *
 * That row does NOT serve `timing_editable`, `start_not_before_week`,
 * `overlap_weeks` or `span_fte`, so for such a step:
 * - planned weeks are null (no bar, no drag; the keyboard dialog only);
 * - floor and overlap are shown as unset (unknown);
 * - `timing_editable` mirrors ADR 0019 §4 (`services/step_timing.timing_editable`)
 *   from served facts only — GANTT write, frozen, schedulable status, skipped,
 *   stage status — to decide whether to OFFER the dialog. The server decides
 *   on the PATCH (409 `PROJECT_FROZEN` / `NOT_SCHEDULABLE` / `STEP_*` copy).
 *
 * Gantt rows always win; nothing here touches a placed step.
 */

export const STEPS_PER_WORKFLOW = 14;

export function unplacedTimingEditable(args: {
  canWriteGantt: boolean;
  frozen: boolean;
  status: ProjectStatus;
  stage: Pick<WorkspaceStage, 'skipped' | 'status'>;
}): TimingEditable {
  const schedulable = (SCHEDULABLE_STATUSES as readonly string[]).includes(args.status);
  if (!args.canWriteGantt || args.frozen || !schedulable || args.stage.skipped) return 'none';
  if (args.stage.status === 'Done') return 'none';
  if (args.stage.status === 'In Progress' || args.stage.status === 'Blocked') return 'resize';
  return 'move_resize';
}

export function stageAsStepRow(stage: WorkspaceStage, timingEditable: TimingEditable): GanttStepRow {
  return {
    step_id: stage.step_id,
    step_name: stage.name,
    kind: stage.kind,
    sequence_order: stage.sequence_order,
    skipped: stage.skipped,
    status: stage.status,
    percent_complete: stage.percent_complete,
    duration_weeks: stage.duration_weeks,
    // Not placed by the active run: no planned weeks, whatever the stage says.
    planned_start_week: null,
    planned_end_week: null,
    actual_start_week: stage.actual_start_week,
    actual_end_week: stage.actual_end_week,
    assigned_engineer_name: stage.assigned_engineer_name,
    assigned_chamber_code: stage.assigned_chamber_code,
    eng_conflict: false,
    chamber_overlap: false,
    lead_time_weeks: stage.lead_time_weeks,
    duration_override_weeks: stage.duration_override_weeks,
    effort_weeks: stage.effort_weeks,
    start_not_before_week: null,
    overlap_weeks: null,
    predecessor_ids: [...stage.predecessor_ids].sort(),
    timing_editable: timingEditable,
    span_fte: null,
  };
}

/** The Gantt row with every workflow step: served rows as they are, the rest
 *  from the Workspace stages. Returns the ids of the steps added. */
export function completeStepRows(
  row: GanttProjectRow,
  stages: readonly WorkspaceStage[] | null,
  facts: { canWriteGantt: boolean; frozen: boolean; status: ProjectStatus } | null,
): { row: GanttProjectRow; addedStepIds: string[] } {
  if (!stages || !facts) return { row, addedStepIds: [] };
  const served = new Set(row.steps.map((s) => s.step_id));
  const added = stages
    .filter((st) => !served.has(st.step_id))
    .map((st) => stageAsStepRow(st, unplacedTimingEditable({ ...facts, stage: st })));
  if (added.length === 0) return { row, addedStepIds: [] };
  const steps = [...row.steps, ...added].sort((a, b) => a.sequence_order - b.sequence_order);
  return { row: { ...row, steps }, addedStepIds: added.map((s) => s.step_id) };
}
