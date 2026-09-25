/**
 * Flat visual-row model for row virtualization (`dataviz-gantt` SKILL: "expanded
 * step rows count as additional virtual rows inserted at the expansion point").
 *
 * One project = one `project` row when collapsed; one `project` row + 14 `step`
 * rows when expanded. Row heights are fixed and known ahead of layout.
 */

import { PROJECT_ROW_HEIGHT, STEP_ROW_HEIGHT } from './gantt-coordinates';
import type { GanttProjectRow, GanttStepRow } from '../api/types';

export type GanttVisualRow =
  | { kind: 'project'; key: string; project: GanttProjectRow }
  | { kind: 'step'; key: string; project: GanttProjectRow; step: GanttStepRow; stepIndex: number };

export function buildVisualRows(
  rows: readonly GanttProjectRow[],
  expandedIds: ReadonlySet<string>,
): GanttVisualRow[] {
  const out: GanttVisualRow[] = [];
  for (const project of rows) {
    out.push({ kind: 'project', key: project.project_id, project });
    if (expandedIds.has(project.project_id)) {
      const steps = [...project.steps].sort((a, b) => a.sequence_order - b.sequence_order);
      steps.forEach((step, stepIndex) => {
        out.push({
          kind: 'step',
          key: `${project.project_id}:${step.step_id}:${String(step.sequence_order)}`,
          project,
          step,
          stepIndex,
        });
      });
    }
  }
  return out;
}

export function visualRowHeight(row: GanttVisualRow): number {
  return row.kind === 'project' ? PROJECT_ROW_HEIGHT : STEP_ROW_HEIGHT;
}

/**
 * View-derived scan aid for the activity-load bottleneck strip: for each week in
 * the horizon, how many scheduled workflow-step bars (across the currently shown
 * projects) intersect that week.
 *
 * This is a histogram of what is already rendered — the same class of operation as
 * `rows.length` — NOT a resource/capacity figure and NOT a recomputation of the
 * schedule. The authoritative load-vs-capacity numbers live on the RPD Capacity
 * surface (Invariants I6 / I7), server-sourced. The strip only helps the eye find
 * a dense week before scrolling the rows.
 */
export function weeklyStepDensity(
  rows: readonly GanttProjectRow[],
  horizonWeeks: number,
): number[] {
  const counts = new Array<number>(horizonWeeks + 1).fill(0);
  for (const project of rows) {
    for (const step of project.steps) {
      const start = step.planned_start_week;
      const end = step.planned_end_week;
      if (start == null || end == null) continue;
      const lo = Math.max(1, Math.min(start, end));
      const hi = Math.min(horizonWeeks, Math.max(start, end));
      for (let w = lo; w <= hi; w += 1) counts[w] = (counts[w] ?? 0) + 1;
    }
  }
  return counts;
}
