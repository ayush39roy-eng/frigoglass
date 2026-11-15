import type { GanttProjectRow, GanttStepRow } from '@/surfaces/gantt/api/types';
import type { WorkspaceStage } from '@/surfaces/project-workspace/api/types';

/**
 * P32-R04 follow-up: `GET /gantt` builds a project's step rows from the
 * steps the active run PLACED (`ScheduleRunProjectStep`). A project the run
 * left out has none (`steps: []`), and a partly placed one only some. The
 * Workflow page still lists all of its steps, so a missing step is taken from
 * the Workspace stage row (`GET /projects/{id}/workspace`), which serves the
 * same template copy (`plan_weeks`, `gap_weeks`, `own_effort`, P33 Part G).
 * Planned weeks are null (no bar); `span_fte` is not served there, so null.
 * Read-only since P33-T15 (ADR 0048). Gantt rows always win; nothing here
 * touches a placed step.
 */

export const STEPS_PER_WORKFLOW = 14;

export function stageAsStepRow(stage: WorkspaceStage): GanttStepRow {
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
    effort_weeks: stage.effort_weeks,
    plan_weeks: stage.plan_weeks,
    gap_weeks: stage.gap_weeks,
    own_effort: stage.own_effort,
    span_fte: null,
    predecessor_ids: [...stage.predecessor_ids].sort(),
  };
}

/** The Gantt row with every workflow step: served rows as they are, the rest
 *  from the Workspace stages. Returns the ids of the steps added. */
export function completeStepRows(
  row: GanttProjectRow,
  stages: readonly WorkspaceStage[] | null,
): { row: GanttProjectRow; addedStepIds: string[] } {
  if (!stages) return { row, addedStepIds: [] };
  const served = new Set(row.steps.map((s) => s.step_id));
  const added = stages.filter((st) => !served.has(st.step_id)).map(stageAsStepRow);
  if (added.length === 0) return { row, addedStepIds: [] };
  const steps = [...row.steps, ...added].sort((a, b) => a.sequence_order - b.sequence_order);
  return { row: { ...row, steps }, addedStepIds: added.map((s) => s.step_id) };
}
