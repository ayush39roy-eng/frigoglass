/**
 * Plain text for a Timeline step row (moved out of `gantt-chart.tsx` in
 * P32-R02 so the step-row components can share it). Served fields only.
 */

import { formatPlanWeek } from '@/lib/format';

import type { GanttStepRow } from '../api/types';
import { durationSourceSuffix } from './step-duration-source';
import { gapChipText } from './step-gap';
import { calendarRangePhrase, workWeeksPhrase } from './step-weeks-copy';

/**
 * P20 (ADR 0032): the step bar's hover text names both figures — the bar is
 * CALENDAR weeks (served planned weeks, verbatim) and `duration_weeks` is WORK
 * weeks — e.g. "Prototype build · planned W10–W17 on the calendar · 4 wks of
 * work at 0.5 FTE". The suffix needs the served `span_fte`, which is null
 * for unstretched steps and for callers without GANTT write on the hub (OQ #8).
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
  // P33 (ADR 0048): the template gap copied to the project, served signed.
  const gap = gapChipText(s.gap_weeks);
  if (gap !== null && !s.skipped) parts.push(`template gap: ${gap}`);
  // P30 (ADR 0041) / P33: name where the served duration comes from (own client effort figure).
  if (s.duration_weeks !== null && !s.skipped) {
    parts.push(`${workWeeksPhrase(s.kind, s.duration_weeks, s.span_fte ?? null)}${durationSourceSuffix(s)}`);
  }
  if (actual) parts.push(`actual ${fmt(actual.startWeek)}–${fmt(actual.endWeek)}`);
  return parts.join(' · ');
}
