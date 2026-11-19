import { PLAN_YEAR_WEEKS, roundUpToYearEnd } from '@/lib/week-line';
import { snapWeekDelta, type WeekScale } from '@/surfaces/gantt/lib/gantt-coordinates';
import { overlapForDrop, type OverlapStep } from '@/surfaces/gantt/lib/step-overlap';

import type { ImportResultStep, ImportSimulateResponse } from './import-types';
import { shortWeekLabel } from './week-labels';

/**
 * Geometry and gesture interpretation for the import Gantt (P32-T06). Pixels and the two
 * planner inputs only (ADR 0043 / ADR 0019); the schedule itself is always the server's.
 */

export const IMPORT_WEEK_PX = 16;

/**
 * The week scale of the import Gantt. P53 (R53-6, amends ADR 0062): from the first week
 * of the year of the served `current_week` (`year_start(Y0)`) to the run's last finish —
 * the served `last_finish_week`, else the largest served step / finish week (a max over
 * served weeks, geometry only) — never below the plan cut-off, rounded up to a year end.
 * Never to the search limit `horizon_weeks`. Under a data-driven year header row.
 */
export function importScale(
  result: Pick<ImportSimulateResponse, 'current_week' | 'plan_year_end_week'> &
    Partial<Pick<ImportSimulateResponse, 'projects' | 'plan_until_week' | 'last_finish_week'>>,
  weekPx = IMPORT_WEEK_PX,
): WeekScale {
  const origin = roundUpToYearEnd(result.current_week) - PLAN_YEAR_WEEKS + 1;
  let last = Math.max(result.current_week, result.plan_until_week ?? result.plan_year_end_week);
  if (result.last_finish_week != null) {
    last = Math.max(last, result.last_finish_week);
  } else {
    for (const p of result.projects ?? []) {
      if (p.finish_week != null) last = Math.max(last, p.finish_week);
      for (const st of p.steps) if (!st.skipped && st.end_week != null) last = Math.max(last, st.end_week);
    }
  }
  const end = roundUpToYearEnd(last);
  const horizonWeeks = end - origin + 1;
  return { originWeek: origin, horizonWeeks, weekWidthPx: weekPx, totalWidthPx: horizonWeeks * weekPx };
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
