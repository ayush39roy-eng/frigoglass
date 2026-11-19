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
 * The week scale of the import Gantt (P51, ADR 0062): from the served `current_week` to the
 * served `horizon_weeks` (the import's search horizon, `plan_until_week` + 26 — up to W130,
 * W26 of the year after next), under a year header row. Pixels only; every week is a served
 * field.
 */
export function importScale(
  result: Pick<ImportSimulateResponse, 'current_week' | 'horizon_weeks'>,
  weekPx = IMPORT_WEEK_PX,
): WeekScale {
  const last = Math.max(result.current_week, result.horizon_weeks);
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
