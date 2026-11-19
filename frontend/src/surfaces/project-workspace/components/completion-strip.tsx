import * as React from 'react';

import { WeekText } from '@/components/shared/week-text';
import { useCurrentWeek, usePlanYearWindow } from '@/lib/plan-clock';
import { formatWeek } from '@/lib/format';
import { GanttCompletionMarkers } from '@/surfaces/gantt/components/gantt-completion-markers';
import { expectedLabel, slipLabel } from '@/surfaces/gantt/lib/completion-labels';
import { weekEndToX, weekToX, type WeekScale } from '@/surfaces/gantt/lib/gantt-coordinates';

import type { WorkspaceSchedule } from '../api/types';

/**
 * Mini completion strip — the Gantt's expected / will-be-completed / slip
 * language at a glance, drawn by the SAME `<GanttCompletionMarkers>` (same
 * tokens, dash patterns and caps) on a compact plan-year scale (ADR 0024; P53:
 * the served `[plan_year_start_week, plan_year_end_week]`). A completion week
 * past the year end is not drawn on the strip. Every week is a server field (I16).
 */
const WEEK_PX = 5;
const HEIGHT = 34;

export function CompletionStrip({
  schedule,
  targetEndWeek,
  projectName,
}: {
  schedule: WorkspaceSchedule;
  targetEndWeek: number | null;
  projectName: string;
}): React.JSX.Element {
  const window = usePlanYearWindow();
  const originWeek = window?.start ?? 1;
  const horizonWeeks = window ? window.end - window.start + 1 : 52;
  const scale: WeekScale = {
    originWeek,
    horizonWeeks,
    weekWidthPx: WEEK_PX,
    totalWidthPx: horizonWeeks * WEEK_PX,
  };
  // P37: "now" is the served calendar week (ADR 0052 §4).
  const currentWeek = useCurrentWeek();
  const nowX = currentWeek === null ? null : weekToX(currentWeek, scale);
  const yearEndWeek = window?.end ?? null;
  const yearX = yearEndWeek === null ? scale.totalWidthPx : weekEndToX(yearEndWeek, scale);

  return (
    <div className="space-y-1" data-testid="completion-strip">
      <svg viewBox={`0 0 ${String(scale.totalWidthPx)} ${String(HEIGHT)}`} className="block h-9 w-full" preserveAspectRatio="none">
        <rect x={0} y={HEIGHT / 2 - 1} width={scale.totalWidthPx} height={2} fill="hsl(var(--color-gantt-grid-strong))" />
        <rect x={yearX} y={0} width={scale.totalWidthPx - yearX} height={HEIGHT} fill="hsl(var(--color-gantt-marker-year) / 0.06)" />
        {nowX !== null ? (
          <line x1={nowX} y1={0} x2={nowX} y2={HEIGHT} stroke="hsl(var(--color-gantt-marker-now))" strokeWidth={1} />
        ) : null}
        <line x1={yearX} y1={0} x2={yearX} y2={HEIGHT} stroke="hsl(var(--color-gantt-marker-year))" strokeWidth={1} strokeDasharray="3 2" />
        <GanttCompletionMarkers
          scale={scale}
          rowHeight={HEIGHT}
          projectName={projectName}
          targetEndWeek={targetEndWeek}
          expectedEndWeek={schedule.expected_end_week}
          projectedEndWeek={schedule.projected_end_week}
          slipWeeks={schedule.slip_weeks}
        />
      </svg>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-2xs text-text-muted">
        <div className="flex items-center gap-1">
          <span className="inline-block h-3 w-0.5 bg-gantt-expected" aria-hidden="true" />
          <dt>{expectedLabel(targetEndWeek)}</dt>
          <dd className="font-mono font-semibold text-text" data-testid="strip-expected">
            {schedule.expected_end_week === null ? '—' : <WeekText week={schedule.expected_end_week} />}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-3 w-0.5 border-l-2 border-dashed border-gantt-projected" aria-hidden="true" />
          <dt>Will be completed</dt>
          <dd className="font-mono font-semibold text-text" data-testid="strip-projected">
            {/* P42: a queued / not-scheduled project reads the served outcome text. */}
            {schedule.projected_end_week === null
              ? (schedule.outcome_label ?? (schedule.left_out ? 'Spillover · unplaced' : '—'))
              : <WeekText week={schedule.projected_end_week} />}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>Slip</dt>
          <dd
            className={
              schedule.slip_weeks === null || schedule.slip_weeks === 0
                ? 'font-mono font-semibold text-text'
                : schedule.slip_weeks > 0
                  ? 'font-mono font-semibold text-danger'
                  : 'font-mono font-semibold text-success'
            }
            data-testid="strip-slip"
          >
            {schedule.slip_weeks === null ? '—' : slipLabel(schedule.slip_weeks)}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>Now</dt>
          <dd className="font-mono">{currentWeek === null ? '—' : formatWeek(currentWeek)}</dd>
          <dt className="ml-2">Year-end</dt>
          <dd className="font-mono">{yearEndWeek === null ? '—' : formatWeek(yearEndWeek)}</dd>
        </div>
      </dl>
    </div>
  );
}
