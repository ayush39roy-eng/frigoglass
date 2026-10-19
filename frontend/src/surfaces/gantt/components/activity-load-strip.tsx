import * as React from 'react';

import { formatWeek } from '@/lib/format';

import { lastScaleWeek, weekToX, type WeekScale } from '../lib/gantt-coordinates';
import type { GanttWeeklyActiveCount } from '../api/types';

/**
 * Activity-load bottleneck strip (`dataviz-gantt` SKILL) and the weekly PDD /
 * OEM count rows (P13-T13, API_CONTRACT_P13 §7). Same week-bucket x-axis as the
 * bars, so they stay pixel-aligned while the timeline scrolls.
 *
 * Since P13-T13 both read the SERVED `weekly_active_counts` — active steps per
 * week for the filtered set, counted server-side. The browser no longer builds
 * its own histogram from the bars (Invariant I9: no independent calculation).
 * The bar height is only a visual scale of the served number; each bar's
 * `<title>` prints the served figures verbatim. These are step counts, not
 * capacity: load vs capacity lives on the RPD Capacity surface (I6 / I7).
 */

export const LOAD_STRIP_HEIGHT = 26;
export const COUNT_ROW_HEIGHT = 18;

function inAxis(counts: readonly GanttWeeklyActiveCount[], scale: WeekScale): GanttWeeklyActiveCount[] {
  const last = lastScaleWeek(scale);
  return counts.filter((c) => c.week >= scale.originWeek && c.week <= last);
}

export interface ActivityLoadStripProps {
  scale: WeekScale;
  counts: readonly GanttWeeklyActiveCount[];
}

export function ActivityLoadStrip({ scale, counts }: ActivityLoadStripProps): React.JSX.Element {
  const shown = React.useMemo(() => inAxis(counts, scale), [counts, scale]);
  // Visual scale only: the tallest served week fills the strip.
  const max = Math.max(1, ...shown.map((c) => c.pdd + c.oem));
  const inner = LOAD_STRIP_HEIGHT - 4;

  return (
    <svg
      width={scale.totalWidthPx}
      height={LOAD_STRIP_HEIGHT}
      role="img"
      aria-label="Active workflow steps per week, PDD and OEM, for the projects in this view (served counts, not a capacity figure)"
      className="block"
      data-testid="gantt-activity-strip"
    >
      {shown.map((c) => {
        if (c.pdd + c.oem <= 0) return null;
        const x = weekToX(c.week, scale);
        const w = Math.max(1, scale.weekWidthPx - 1);
        const pddH = (c.pdd / max) * inner;
        const oemH = (c.oem / max) * inner;
        return (
          <g key={c.week}>
            <title>{`${formatWeek(c.week)}: ${String(c.pdd)} PDD · ${String(c.oem)} OEM active steps`}</title>
            {c.pdd > 0 ? (
              <rect
                x={x}
                y={LOAD_STRIP_HEIGHT - pddH}
                width={w}
                height={pddH}
                fill="hsl(var(--color-gantt-planned) / 0.75)"
              />
            ) : null}
            {c.oem > 0 ? (
              <rect
                x={x}
                y={LOAD_STRIP_HEIGHT - pddH - oemH}
                width={w}
                height={oemH}
                fill="hsl(var(--color-warning) / 0.8)"
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export interface WeeklyCountRowProps {
  scale: WeekScale;
  counts: readonly GanttWeeklyActiveCount[];
  workflow: 'pdd' | 'oem';
}

/**
 * One row of served per-week counts (the mock-up's "• PDD 0 · 2 · 2 …" band).
 * A zero week renders a muted dot rather than a "0" so a busy week stands out.
 */
export function WeeklyCountRow({ scale, counts, workflow }: WeeklyCountRowProps): React.JSX.Element {
  const shown = React.useMemo(() => inAxis(counts, scale), [counts, scale]);
  const label = workflow === 'pdd' ? 'PDD' : 'OEM';
  return (
    <div
      className="relative"
      style={{ width: scale.totalWidthPx, height: COUNT_ROW_HEIGHT }}
      role="list"
      aria-label={`${label} active steps per week`}
      data-testid={`gantt-count-row-${workflow}`}
    >
      {shown.map((c) => {
        const value = c[workflow];
        return (
          <span
            key={c.week}
            role="listitem"
            className={
              value > 0
                ? 'tnum absolute top-0 flex items-center justify-center text-[0.625rem] font-semibold text-text'
                : 'tnum absolute top-0 flex items-center justify-center text-[0.625rem] text-text-subtle/60'
            }
            style={{ left: weekToX(c.week, scale), width: scale.weekWidthPx, height: COUNT_ROW_HEIGHT }}
            title={`${formatWeek(c.week)}: ${String(value)} ${label} active step${value === 1 ? '' : 's'}`}
            data-week={c.week}
          >
            <span aria-hidden="true">{value > 0 ? value : '·'}</span>
            <span className="sr-only">{` ${formatWeek(c.week)}: ${String(value)}`}</span>
          </span>
        );
      })}
    </div>
  );
}
