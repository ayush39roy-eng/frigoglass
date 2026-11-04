/**
 * Plain text for a Timeline step row (moved out of `gantt-chart.tsx` in
 * P32-R02 so the step-row components can share it). Served fields only.
 */

import { formatPlanWeek } from '@/lib/format';

import type { GanttStepRow } from '../api/types';
import { durationSourceSuffix } from './step-duration-source';
import { calendarRangePhrase, workWeeksPhrase } from './step-weeks-copy';

/**
 * P20 (ADR 0032): the step bar's hover text names both figures — the bar is
 * CALENDAR weeks (served planned weeks, verbatim) and `duration_weeks` is WORK
 * weeks — e.g. "Prototype build · planned W10–W17 on the calendar · 4 wks of
 * work at 0.5 FTE". The suffix needs the served `span_fte`, which is null
 * for unstretched steps and for callers who may not edit the step (OQ #8).
 */
export function stepBarTitle(
  s: GanttStepRow,
  planned: { startWeek: number; endWeek: number } | null,
  actual: { startWeek: number; endWeek: number } | null,
  /** P32-R04: week text (default `formatPlanWeek`; the Workflow waterfall names next year's weeks). */
  fmt: (week: number) => string = formatPlanWeek,
): string {
  const parts = [s.step_name];
  if (planned) parts.push(`planned ${calendarRangePhrase(planned.startWeek, planned.endWeek, fmt)}`);
  // P32 (ADR 0043): a stored overlap — the step runs in parallel with the previous one.
  if ((s.overlap_weeks ?? null) !== null) parts.push(`runs in parallel (${String(s.overlap_weeks)} wk overlap)`);
  // P30 (ADR 0041 R4): name where the served duration comes from (client effort / timing edit).
  if (s.duration_weeks !== null && !s.skipped) {
    parts.push(`${workWeeksPhrase(s.kind, s.duration_weeks, s.span_fte ?? null)}${durationSourceSuffix(s)}`);
  }
  if (actual) parts.push(`actual ${fmt(actual.startWeek)}–${fmt(actual.endWeek)}`);
  return parts.join(' · ');
}
