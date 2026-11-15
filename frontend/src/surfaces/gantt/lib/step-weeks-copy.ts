import type { WorkflowStepKind } from '@/types/enums';
import { formatPlanWeek } from '@/lib/format';

/**
 * P20 (ADR 0032): every step label says which number is CALENDAR weeks
 * (the bar, `planned_start_week..planned_end_week`) and which is WORK weeks
 * (`duration_weeks`). Only a design step is
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
export function calendarRangePhrase(
  startWeek: number,
  endWeek: number,
  fmt: (week: number) => string = formatPlanWeek,
): string {
  return `${fmt(startWeek)}–${fmt(endWeek)} on the calendar`;
}
