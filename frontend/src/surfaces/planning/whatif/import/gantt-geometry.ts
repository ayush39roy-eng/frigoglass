import { snapWeekDelta, type WeekScale } from '@/surfaces/gantt/lib/gantt-coordinates';
import { overlapForDrop, type OverlapStep } from '@/surfaces/gantt/lib/step-overlap';

import type { ImportResultStep, ImportSimulateResponse } from './import-types';
import { shortWeekLabel } from './week-labels';

/**
 * Geometry and gesture interpretation for the import Gantt (P32-T06). Pixels and the two
 * planner inputs only (ADR 0043 / ADR 0019); the schedule itself is always the server's.
 */

export const IMPORT_WEEK_PX = 16;

/** Weeks drawn after the plan-year end when nothing spills over, so its marker label fits. */
export const AXIS_TAIL_WEEKS = 4;

/**
 * The week scale of the import Gantt: from the served `current_week` to the latest served
 * end week (project or step), at least a few weeks past the plan-year end and at most the
 * served `horizon_weeks`. Pixels only; every week is a served field.
 */
export function importScale(
  result: Pick<ImportSimulateResponse, 'current_week' | 'horizon_weeks' | 'plan_year_end_week' | 'projects'>,
  weekPx = IMPORT_WEEK_PX,
): WeekScale {
  let latest = result.plan_year_end_week + AXIS_TAIL_WEEKS;
  for (const p of result.projects) {
    if (p.end_week !== null) latest = Math.max(latest, p.end_week);
    for (const st of p.steps) if (st.end_week !== null) latest = Math.max(latest, st.end_week);
  }
  const last = Math.max(result.current_week, Math.min(result.horizon_weeks, latest));
  const horizonWeeks = last - result.current_week + 1;
  return { originWeek: result.current_week, horizonWeeks, weekWidthPx: weekPx, totalWidthPx: horizonWeeks * weekPx };
}

export interface DropEdit {
  start_not_before_week?: number | null;
  overlap_weeks?: number | null;
  duration_weeks?: number | null;
}

/** What a move drop of `dx` px would send, and the label shown while dragging. */
export function moveDrop(
  step: ImportResultStep,
  siblings: readonly OverlapStep[],
  dxPx: number,
  scale: WeekScale,
  frontier: number,
  baseYear: number,
): { edit: DropEdit | null; label: string; ghostStart: number } {
  const start = step.start_week ?? frontier;
  const drop = start + snapWeekDelta(dxPx, scale);
  const r = overlapForDrop(siblings, step.step_id, drop, frontier);
  const unchanged = r.clampedWeek === start && (r.overlapWeeks ?? null) === (step.overlap_weeks ?? null);
  let label = `Earliest start ${shortWeekLabel(r.clampedWeek, baseYear)}`;
  if (r.overlapWeeks !== null && r.parallelWith.length > 0) {
    const pred = r.parallelWith[0];
    const self = siblings.find((s) => s.stepId === step.step_id);
    label = `Parallel with ${pred?.name ?? pred?.stepId ?? 'the previous step'} · ${String(r.overlapWeeks)} wk overlap`;
    if (pred?.kind === 'design' && self?.kind === 'design') label += ' · same designer — will start when they are free';
  } else if (r.overlapWeeks !== null) {
    label = `${String(r.overlapWeeks)} wk overlap · from ${shortWeekLabel(r.clampedWeek, baseYear)}`;
  }
  return {
    edit: unchanged
      ? null
      : {
          start_not_before_week: r.startNotBeforeWeek,
          overlap_weeks: r.overlapWeeks,
        },
    label,
    ghostStart: r.clampedWeek,
  };
}
