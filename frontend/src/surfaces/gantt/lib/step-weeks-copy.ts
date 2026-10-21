import type { WorkflowStepKind } from '@/types/enums';
import { formatPlanWeek, formatWeek } from '@/lib/format';

/**
 * P20 (ADR 0032): every step-timing label says which number is CALENDAR weeks
 * (the bar, `planned_start_week..planned_end_week`) and which is WORK weeks
 * (`duration_weeks` / `duration_override_weeks`). Only a design step is
 * stretched by its leader's FTE; lab and elapsed steps take as many calendar
 * weeks as their duration. Pure strings from served values — no scheduling
 * maths here.
 */

/** "0.5", "0.63", "1" — the served FTE as written. */
export function fteLabel(fte: number): string {
  return String(fte);
}

/** "4 wks of work at 0.5 FTE" (design) · "4 wks of work" (FTE not served) ·
 *  "4 wks" (lab / elapsed: not stretched). */
export function workWeeksPhrase(kind: WorkflowStepKind, workWeeks: number, fte: number | null): string {
  if (kind !== 'design') return `${String(workWeeks)} wks`;
  return fte === null ? `${String(workWeeks)} wks of work` : `${String(workWeeks)} wks of work at ${fteLabel(fte)} FTE`;
}

/** "W10–W17 on the calendar" — the served bar, verbatim. */
export function calendarRangePhrase(startWeek: number, endWeek: number): string {
  return `${formatPlanWeek(startWeek)}–${formatPlanWeek(endWeek)} on the calendar`;
}

/**
 * The right-edge drag label, e.g. "8 wks on the calendar · 4 wks of work at
 * 0.5 FTE". `calendarWeeks` is the ghost bar's own width. A design step with no
 * served FTE cannot say how long it will be on the calendar, so it says so.
 */
export function resizeDragLabel(
  kind: WorkflowStepKind,
  calendarWeeks: number,
  workWeeks: number,
  fte: number | null,
): string {
  if (kind !== 'design') return `${String(calendarWeeks)} wks on the calendar · not stretched by FTE`;
  if (fte === null) return `${workWeeksPhrase(kind, workWeeks, null)} · calendar weeks follow the leader's FTE`;
  return `${String(calendarWeeks)} wks on the calendar · ${workWeeksPhrase(kind, workWeeks, fte)}`;
}

/** The live drag label. Move: "Start ≥ W13 · W13–W16". Resize: see `resizeDragLabel`. */
export function stepDragLabel(
  mode: 'move' | 'resize',
  ghost: { startWeek: number; endWeek: number },
  step: { kind: WorkflowStepKind; workWeeks: number | null; fte: number | null },
): string {
  const span = `${formatWeek(ghost.startWeek)}–${formatWeek(ghost.endWeek)}`;
  if (mode === 'move' || step.workWeeks === null) return `Start ≥ ${formatWeek(ghost.startWeek)} · ${span}`;
  return resizeDragLabel(step.kind, ghost.endWeek - ghost.startWeek + 1, step.workWeeks, step.fte);
}

/** Help text for the work-weeks field and the drag handle. */
export const WORK_WEEKS_HELP =
  'Weeks of work at full speed. A leader below 1.0 FTE takes longer on the calendar: at 0.5 FTE, 4 weeks of work take 8 calendar weeks (ADR 0032).';
