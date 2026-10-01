import * as React from 'react';

import { CURRENT_WEEK, HORIZON_WEEKS, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';
import { GanttCompletionMarkers } from '@/surfaces/gantt/components/gantt-completion-markers';
import { expectedLabel, slipLabel } from '@/surfaces/gantt/lib/completion-labels';
import { weekEndToX, weekToX, type WeekScale } from '@/surfaces/gantt/lib/gantt-coordinates';

import type { WorkspaceSchedule } from '../api/types';

/**
 * Mini completion strip — the Gantt's expected / will-be-completed / slip
 * language at a glance, drawn by the SAME `<GanttCompletionMarkers>` (same
 * tokens, dash patterns and caps) on a compact 1..78 week scale. Every week is
 * a server field (I16).
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
  const scale: WeekScale = { originWeek: 1, horizonWeeks: HORIZON_WEEKS, weekWidthPx: WEEK_PX, totalWidthPx: HORIZON_WEEKS * WEEK_PX };
  const nowX = weekToX(CURRENT_WEEK, scale);
  const yearX = weekEndToX(WITHIN_YEAR_WEEK, scale);

  return (
    <div className="space-y-1" data-testid="completion-strip">
      <svg viewBox={`0 0 ${String(scale.totalWidthPx)} ${String(HEIGHT)}`} className="block h-9 w-full" preserveAspectRatio="none">
        <rect x={0} y={HEIGHT / 2 - 1} width={scale.totalWidthPx} height={2} fill="hsl(var(--color-gantt-grid-strong))" />
        <rect x={yearX} y={0} width={scale.totalWidthPx - yearX} height={HEIGHT} fill="hsl(var(--color-gantt-marker-year) / 0.06)" />
        <line x1={nowX} y1={0} x2={nowX} y2={HEIGHT} stroke="hsl(var(--color-gantt-marker-now))" strokeWidth={1} />
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
            {schedule.expected_end_week === null ? '—' : formatWeek(schedule.expected_end_week)}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-3 w-0.5 border-l-2 border-dashed border-gantt-projected" aria-hidden="true" />
          <dt>Will be completed</dt>
          <dd className="font-mono font-semibold text-text" data-testid="strip-projected">
            {schedule.projected_end_week === null ? (schedule.left_out ? 'Left out' : '—') : formatWeek(schedule.projected_end_week)}
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
          <dd className="font-mono">{formatWeek(CURRENT_WEEK)}</dd>
          <dt className="ml-2">Year-end</dt>
          <dd className="font-mono">{formatWeek(WITHIN_YEAR_WEEK)}</dd>
        </div>
      </dl>
    </div>
  );
}
