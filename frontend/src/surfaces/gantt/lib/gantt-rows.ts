/**
 * Flat visual-row model for row virtualization (`dataviz-gantt` SKILL: "expanded
 * step rows count as additional virtual rows inserted at the expansion point").
 *
 * One project = one `project` row when collapsed; one `project` row + 14 `step`
 * rows when expanded. Row heights are fixed and known ahead of layout.
 */

import { PROJECT_ROW_HEIGHT, ROW_HEIGHTS, STEP_ROW_HEIGHT, type GanttDensity } from './gantt-coordinates';
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

/** Without a density, the original fixed heights (40 / 28). With one (P13-T13),
 *  the toolbar's comfortable / forest heights. Still fixed and known ahead of
 *  layout, which keeps row virtualization tractable. */
export function visualRowHeight(row: GanttVisualRow | undefined, density?: GanttDensity): number {
  const kind = row?.kind ?? 'project';
  if (density === undefined) return kind === 'project' ? PROJECT_ROW_HEIGHT : STEP_ROW_HEIGHT;
  return ROW_HEIGHTS[density][kind];
}
