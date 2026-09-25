import * as React from 'react';

import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

import { weekToX, weekEndToX, type WeekScale } from '../lib/gantt-coordinates';

/**
 * Week ruler + the two fixed marker lines. The markers are drawn at DOMAIN_RULES
 * constants (`CURRENT_WEEK`, `WITHIN_YEAR_WEEK`) — a fixed position, not a
 * calculation. The per-project "completing within year" verdict is still the
 * server's `row.spillover` / `row.left_out` flag.
 */

export const AXIS_HEIGHT = 34;

/** Label every Nth week so the header does not crowd at the weeks zoom level. */
function labelStride(weekWidthPx: number): number {
  if (weekWidthPx >= 40) return 1;
  if (weekWidthPx >= 20) return 2;
  return 4;
}

export interface GanttWeekAxisProps {
  scale: WeekScale;
}

export function GanttWeekAxis({ scale }: GanttWeekAxisProps): React.JSX.Element {
  const stride = labelStride(scale.weekWidthPx);
  const weeks: number[] = [];
  for (let w = 1; w <= scale.horizonWeeks; w += 1) weeks.push(w);

  const nowX = weekToX(CURRENT_WEEK, scale);
  const yearX = weekEndToX(WITHIN_YEAR_WEEK, scale);

  return (
    <svg
      width={scale.totalWidthPx}
      height={AXIS_HEIGHT}
      role="img"
      aria-label={`Week axis, week 1 to week ${String(scale.horizonWeeks)}`}
      className="block"
    >
      {weeks.map((w) => {
        const x = weekToX(w, scale);
        const showLabel = (w - 1) % stride === 0;
        return (
          <g key={w}>
            <line
              x1={x}
              y1={AXIS_HEIGHT - 6}
              x2={x}
              y2={AXIS_HEIGHT}
              stroke="hsl(var(--color-gantt-grid-strong))"
              strokeWidth={1}
            />
            {showLabel ? (
              <text
                x={x + 2}
                y={12}
                fontSize={9}
                fill="hsl(var(--color-text-muted))"
                className="tabular-nums"
              >
                {w}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* current-week marker */}
      <line
        x1={nowX}
        y1={0}
        x2={nowX}
        y2={AXIS_HEIGHT}
        stroke="hsl(var(--color-gantt-marker-now))"
        strokeWidth={1.5}
      />
      <text
        x={nowX + 3}
        y={26}
        fontSize={9}
        fill="hsl(var(--color-gantt-marker-now))"
        fontWeight={600}
      >
        W{CURRENT_WEEK} now
      </text>

      {/* year-end marker */}
      <line
        x1={yearX}
        y1={0}
        x2={yearX}
        y2={AXIS_HEIGHT}
        stroke="hsl(var(--color-gantt-marker-year))"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      <text
        x={yearX + 3}
        y={26}
        fontSize={9}
        fill="hsl(var(--color-gantt-marker-year))"
        fontWeight={600}
      >
        W{WITHIN_YEAR_WEEK} year-end
      </text>
    </svg>
  );
}

export interface GanttGridLinesProps {
  scale: WeekScale;
  height: number;
}

/** Background vertical gridlines + the two marker lines, sized to the full
 *  virtualized content height so they stay aligned during scroll. */
export function GanttGridLines({ scale, height }: GanttGridLinesProps): React.JSX.Element {
  const stride = labelStride(scale.weekWidthPx);
  const lines: number[] = [];
  for (let w = 1; w <= scale.horizonWeeks + 1; w += 1) lines.push(w);

  const nowX = weekToX(CURRENT_WEEK, scale);
  const yearX = weekEndToX(WITHIN_YEAR_WEEK, scale);

  return (
    <svg
      width={scale.totalWidthPx}
      height={height}
      aria-hidden="true"
      className="absolute inset-0 block"
    >
      {/* shaded region after year-end so spillover is visible at a glance */}
      <rect
        x={yearX}
        y={0}
        width={Math.max(0, scale.totalWidthPx - yearX)}
        height={height}
        fill="hsl(var(--color-gantt-marker-year) / 0.05)"
      />
      {lines.map((w) => {
        const x = weekToX(w, scale);
        const strong = (w - 1) % stride === 0;
        return (
          <line
            key={w}
            x1={x}
            y1={0}
            x2={x}
            y2={height}
            stroke={
              strong
                ? 'hsl(var(--color-gantt-grid-strong))'
                : 'hsl(var(--color-gantt-grid))'
            }
            strokeWidth={1}
          />
        );
      })}
      <line
        x1={nowX}
        y1={0}
        x2={nowX}
        y2={height}
        stroke="hsl(var(--color-gantt-marker-now))"
        strokeWidth={1.5}
      />
      <line
        x1={yearX}
        y1={0}
        x2={yearX}
        y2={height}
        stroke="hsl(var(--color-gantt-marker-year))"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
    </svg>
  );
}
