import * as React from 'react';

import { WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatWeekTitle, weekOfYear } from '@/lib/format';
import { useCurrentWeek } from '@/lib/plan-clock';

import { lastScaleWeek, weekToX, weekEndToX, yearBands, type WeekScale } from '../lib/gantt-coordinates';

/**
 * Week ruler + the two marker lines. "Now" is the SERVED calendar week
 * (`/me.current_week`, P37 / ADR 0052 §4: "now" markers use the calendar
 * week); year-end is the DOMAIN_RULES constant `WITHIN_YEAR_WEEK`. Positions,
 * not calculations. The per-project "completing within year" verdict is still the
 * server's `row.spillover` / `row.left_out` flag.
 *
 * P51 (ADR 0062): the Timeline axis runs past W52 (to the scheduler horizon,
 * W26 of the next year). Tick labels are the week OF ITS YEAR — absolute week 53
 * reads "1", never "53" — with "Week 1 of 2027" on hover, and `GanttYearRow`
 * above the ruler names each year. The year-end marker stays at the end of W52;
 * its label is anchored to the left of the line.
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
/** P51 (ADR 0062): the year header row above the week ruler. */
export const YEAR_ROW_HEIGHT = 18;

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
  /** P32-R04: tick text for an absolute week (default since P51: the week of its
   *  year, e.g. "47", and "5" for absolute week 57 — never ≥ 53). */
  weekLabel?: ((week: number) => string) | undefined;
  /** P32-R04: the axis' accessible name (default: "Week axis, Week 1 of 2026 to Week 26 of 2027"). */
  ariaLabel?: string;
}

export function GanttWeekAxis({ scale, weekLabel, ariaLabel }: GanttWeekAxisProps): React.JSX.Element {
  const stride = labelStride(scale.weekWidthPx);
  const first = scale.originWeek;
  const last = lastScaleWeek(scale);
  const weeks: number[] = [];
  for (let w = first; w <= last; w += 1) weeks.push(w);

  const currentWeek = useCurrentWeek();
  // Off-axis (not drawn) until `/me` has resolved.
  const nowX = currentWeek === null ? -1 : weekToX(currentWeek, scale);
  const yearX = weekEndToX(WITHIN_YEAR_WEEK, scale);

  return (
    <svg
      width={scale.totalWidthPx}
      height={AXIS_HEIGHT}
      role="img"
      aria-label={ariaLabel ?? `Week axis, ${formatWeekTitle(first)} to ${formatWeekTitle(last)}`}
      className="block"
    >
      {weeks.map((w) => {
        const x = weekToX(w, scale);
        // P32-R04: a label that would run past the axis end is skipped, not clipped.
        const text = weekLabel ? weekLabel(w) : String(weekOfYear(w).week);
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
                data-testid="gantt-week-tick"
                data-week={w}
              >
                <title>{formatWeekTitle(w)}</title>
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
            W{currentWeek} now
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

  const currentWeek = useCurrentWeek();
  // Off-axis (not drawn) until `/me` has resolved.
  const nowX = currentWeek === null ? -1 : weekToX(currentWeek, scale);
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

export interface GanttYearRowProps {
  scale: WeekScale;
  /** The calendar year of absolute weeks 1..52: the served `/me.plan_year` on
   *  the Timeline, the served `base_year` on the What-if import. `null` before
   *  `/me` resolves — the bands then read "Plan year" / "Next year". */
  baseYear: number | null;
  /** Bands with a year offset above this are shaded as "after the plan year"
   *  (default 0: every year after the base year). */
  planYearOffset?: number;
  /** Where the label sticks while the timeline scrolls (the sticky left
   *  column's width), so a long band keeps its year in view. */
  stickyLeft?: number;
  height?: number;
  testId?: string;
}

function bandLabel(baseYear: number | null, yearOffset: number): string {
  if (baseYear !== null) return String(baseYear + yearOffset);
  if (yearOffset === 0) return 'Plan year';
  return yearOffset === 1 ? 'Next year' : `Year +${String(yearOffset)}`;
}

/**
 * P51 (ADR 0062): the year header row — one band per calendar year spanning its
 * weeks on the axis ("2026", "2027", "2028"). The year is the served one, never
 * a client clock. Geometry from `yearBands`; nothing is computed but pixels.
 */
export function GanttYearRow({
  scale,
  baseYear,
  planYearOffset = 0,
  stickyLeft = 0,
  height = YEAR_ROW_HEIGHT,
  testId = 'gantt-year-row',
}: GanttYearRowProps): React.JSX.Element {
  const bands = yearBands(scale);
  return (
    <div
      className="relative flex"
      style={{ width: scale.totalWidthPx, height }}
      role="list"
      aria-label="Years on the timeline"
      data-testid={testId}
    >
      {bands.map((b) => {
        const label = bandLabel(baseYear, b.yearOffset);
        const later = b.yearOffset > planYearOffset;
        const first = weekOfYear(b.startWeek).week;
        const last = weekOfYear(b.endWeek).week;
        return (
          <div
            key={b.yearOffset}
            role="listitem"
            className="relative shrink-0 border-l border-border first:border-l-0"
            style={{
              width: b.width,
              height,
              background: later ? 'hsl(var(--color-gantt-marker-year) / 0.1)' : undefined,
            }}
            title={`${label}: week ${String(first)} to week ${String(last)}`}
            data-testid="gantt-year-band"
            data-year={label}
            data-start-week={b.startWeek}
            data-end-week={b.endWeek}
          >
            <span
              className="sticky inline-block whitespace-nowrap px-1.5 text-2xs font-bold text-text tabular-nums"
              style={{ left: stickyLeft, lineHeight: `${String(height)}px` }}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
