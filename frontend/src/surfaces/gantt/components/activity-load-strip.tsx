import * as React from 'react';

import { formatWeek } from '@/lib/format';

import { weekToX, type WeekScale } from '../lib/gantt-coordinates';
import { weeklyStepDensity } from '../lib/gantt-rows';
import type { GanttProjectRow } from '../api/types';

/**
 * Activity-load bottleneck strip (`dataviz-gantt` SKILL): a compact heat strip
 * beneath the timeline, same week-bucket x-axis, showing where scheduled work
 * piles up across the projects currently shown.
 *
 * IMPORTANT (Invariant I9): this is a histogram of the step bars already on
 * screen — a visual scan aid, the same class of operation as "N projects". It is
 * NOT a resource/capacity figure and does not recompute the schedule. The
 * authoritative design/lab load-vs-capacity numbers live on the RPD Capacity
 * surface (Invariants I6 / I7), server-sourced. Hand-drawn SVG (no chart lib).
 */

export const LOAD_STRIP_HEIGHT = 26;

export interface ActivityLoadStripProps {
  scale: WeekScale;
  rows: readonly GanttProjectRow[];
}

export function ActivityLoadStrip({ scale, rows }: ActivityLoadStripProps): React.JSX.Element {
  const density = React.useMemo(
    () => weeklyStepDensity(rows, scale.horizonWeeks),
    [rows, scale.horizonWeeks],
  );
  const max = Math.max(1, ...density);

  return (
    <svg
      width={scale.totalWidthPx}
      height={LOAD_STRIP_HEIGHT}
      role="img"
      aria-label="Scheduled workflow-step density per week across the projects shown (a visual scan aid, not a capacity figure)"
      className="block"
    >
      {density.map((count, week) => {
        if (week < 1 || count <= 0) return null;
        const x = weekToX(week, scale);
        const intensity = 0.12 + (count / max) * 0.78;
        const barH = 4 + (count / max) * (LOAD_STRIP_HEIGHT - 8);
        return (
          <rect
            key={week}
            x={x}
            y={LOAD_STRIP_HEIGHT - barH}
            width={Math.max(1, scale.weekWidthPx - 1)}
            height={barH}
            fill={`hsl(var(--color-gantt-planned) / ${intensity.toFixed(2)})`}
          >
            <title>{`${formatWeek(week)}: ${String(count)} scheduled step${
              count === 1 ? '' : 's'
            } in view`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
