import * as React from 'react';

import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

import { lastScaleWeek, weekToX, weekEndToX, type WeekScale } from '../lib/gantt-coordinates';

/**
 * Week ruler + the two fixed marker lines. The markers are drawn at DOMAIN_RULES
 * constants (`CURRENT_WEEK`, `WITHIN_YEAR_WEEK`) — a fixed position, not a
 * calculation. The per-project "completing within year" verdict is still the
 * server's `row.spillover` / `row.left_out` flag.
 *
 * The axis is the 52-week plan year (ADR 0024): W1–W52, no W53+ columns. The
 * year-end marker therefore sits on the axis' right edge; its label is anchored
 * to the left of the line so it stays on-canvas.
 *
 * P32-R04: both components honour `scale.originWeek` (the Workflow page's
 * per-project waterfall starts near the current week and may run past W52 to
 * W78). A marker outside the axis is not drawn. With origin 1 and 52 weeks
 * (the Timeline) the output is unchanged.
 */

/** A marker x is drawn only when it lies on the axis (both edges inclusive). */
function onAxis(x: number, scale: WeekScale): boolean {
  return x >= 0 && x <= scale.totalWidthPx;
}

export const AXIS_HEIGHT = 34;

/** Approximate width of one tick-label character at 10 px / 600 (fit check only). */
const LABEL_CHAR_PX = 6;

/** Label every Nth week so the header does not crowd at the weeks zoom level. */
function labelStride(weekWidthPx: number): number {
  if (weekWidthPx >= 40) return 1;
  if (weekWidthPx >= 20) return 2;
  return 4;
}

export interface GanttWeekAxisProps {
  scale: WeekScale;
  /** P32-R04: tick text for an absolute week (default: the number, e.g. "47"). */
  weekLabel?: (week: number) => string;
  /** P32-R04: the axis' accessible name (default: "Week axis, week 1 to week 52"). */
  ariaLabel?: string;
}

export function GanttWeekAxis({ scale, weekLabel, ariaLabel }: GanttWeekAxisProps): React.JSX.Element {
  const stride = labelStride(scale.weekWidthPx);
  const first = scale.originWeek;
  const last = lastScaleWeek(scale);
  const weeks: number[] = [];
  for (let w = first; w <= last; w += 1) weeks.push(w);

  const nowX = weekToX(CURRENT_WEEK, scale);
  const yearX = weekEndToX(WITHIN_YEAR_WEEK, scale);

  return (
    <svg
      width={scale.totalWidthPx}
      height={AXIS_HEIGHT}
      role="img"
      aria-label={ariaLabel ?? `Week axis, week ${String(first)} to week ${String(last)}`}
      className="block"
    >
      {weeks.map((w) => {
        const x = weekToX(w, scale);
        // P32-R04: a label that would run past the axis end is skipped, not clipped.
        const text = weekLabel ? weekLabel(w) : String(w);
        const showLabel = (w - first) % stride === 0 && x + 2 + text.length * LABEL_CHAR_PX <= scale.totalWidthPx;
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
                fontSize={10}
                fontWeight={600}
                fill="hsl(var(--color-text-muted))"
                className="tabular-nums"
              >
                {text}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* current-week marker */}
      {onAxis(nowX, scale) ? (
        <>
          <line
            x1={nowX}
            y1={0}
            x2={nowX}
            y2={AXIS_HEIGHT}
            stroke="hsl(var(--color-gantt-marker-now))"
            strokeWidth={1.5}
          />
          <rect x={nowX - 26} y={17} width={52} height={15} rx={7.5} fill="hsl(var(--color-gantt-marker-now))" />
          <text
            x={nowX}
            y={24.5}
            fontSize={9}
            fill="white"
            fontWeight={700}
            textAnchor="middle"
            dominantBaseline="central"
          >
            W{CURRENT_WEEK} now
          </text>
        </>
      ) : null}

      {/* year-end marker */}
      {onAxis(yearX, scale) ? (
        <>
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
            x={yearX - 3}
            y={26}
            fontSize={9}
            fill="hsl(var(--color-gantt-marker-year))"
            fontWeight={600}
            textAnchor="end"
            data-testid="gantt-year-end-label"
          >
            W{WITHIN_YEAR_WEEK} year-end
          </text>
        </>
      ) : null}
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
  const first = scale.originWeek;
  const lines: number[] = [];
  for (let w = first; w <= lastScaleWeek(scale) + 1; w += 1) lines.push(w);

  const nowX = weekToX(CURRENT_WEEK, scale);
  const yearX = weekEndToX(WITHIN_YEAR_WEEK, scale);

  return (
    <svg
      width={scale.totalWidthPx}
      height={height}
      aria-hidden="true"
      className="absolute inset-0 block"
    >
      {/* elapsed weeks (before "now") sit on a faint wash so the eye reads the
          live part of the plan first */}
      <rect
        x={0}
        y={0}
        width={Math.min(scale.totalWidthPx, Math.max(0, nowX))}
        height={height}
        fill="hsl(var(--color-surface-sunken) / 0.6)"
      />
      {/* shaded region after year-end so spillover is visible at a glance */}
      <rect
        x={Math.max(0, yearX)}
        y={0}
        width={Math.max(0, scale.totalWidthPx - Math.max(0, yearX))}
        height={height}
        fill="hsl(var(--color-gantt-marker-year) / 0.07)"
      />
      {lines.map((w) => {
        const x = weekToX(w, scale);
        const strong = (w - first) % stride === 0;
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
      {onAxis(nowX, scale) ? (
        <line
          x1={nowX}
          y1={0}
          x2={nowX}
          y2={height}
          stroke="hsl(var(--color-gantt-marker-now))"
          strokeWidth={2}
        />
      ) : null}
      {onAxis(yearX, scale) ? (
        <line
          x1={yearX}
          y1={0}
          x2={yearX}
          y2={height}
          stroke="hsl(var(--color-gantt-marker-year))"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      ) : null}
    </svg>
  );
}
