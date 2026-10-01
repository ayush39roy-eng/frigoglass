import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { formatInteger, formatWeek } from '@/lib/format';
import { useCountUp } from '@/lib/use-count-up';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';

import type { CompletingWithinYear } from '../api/types';
import { OUTCOME_STYLE, outcomeOf, type OutcomeBucket } from '../lib/outcome';
import { useRevealOnce } from '../lib/use-reveal-once';
import { CardInfo } from './card-info';

/**
 * COMPLETION PROFILE — the client's "Incident Report" reference card (multi-series
 * smooth area chart + legend + metric rows), rebuilt on real RPD data.
 *
 * TWO DELIBERATE DEPARTURES FROM THE REFERENCE, both recorded in docs/MEMORY.md:
 *
 * 1. RECHARTS, NOT `reaviz`. The reference was built on `reaviz`. This app
 *    already standardises on Recharts (CLAUDE.md stack), already skins it
 *    (`hub-type-pipeline-chart.tsx` draws its gradients, dashed gridlines and
 *    floating white tooltip from the same tokens this card uses), and a second
 *    charting library would mean two visual grammars for the same job plus a
 *    new dependency. Recharts' `<AreaChart type="monotone">` produces the same
 *    smooth multi-series area the reference shows. No new dependency added.
 *
 * 2. THE SERIES IS REAL, AND IT IS NOT A HISTORY. The reference charts a metric
 *    over calendar time. This application has NO such series to draw and the
 *    temptation to invent one is exactly what Invariant I9 exists to stop, so
 *    the question was checked before anything was built:
 *      - `GET /schedule-runs` returns a list of past runs, but `ScheduleRunSummary`
 *        carries only run metadata (version, solver, status, horizon, timestamps).
 *        It has NO per-run `within_year_count` / `spillover_count`, so a
 *        "within-year count across runs v1…vN" trend cannot be sourced from the
 *        API as it stands.
 *      - `GET /dashboard/*` is, by design, a single active-run snapshot.
 *    What DOES exist, and is genuinely week-indexed, is
 *    `CompletingWithinYear.rows[].last_step_end_week` — the week each project's
 *    last scheduled step ends in the active run. So this card charts the
 *    CUMULATIVE COMPLETION PROFILE across the run's own 78-week horizon: how many
 *    projects have finished by week W. That is real data, drawn from fields the
 *    schedule run stored, and it answers a question a portfolio review actually
 *    asks ("where does the work land relative to year end?"). It is explicitly
 *    NOT labelled as a trend over time, and no sample/illustrative data is used
 *    anywhere on this card.
 *
 * Bucketing uses `lib/outcome.ts`'s shared precedence so the two series can never
 * disagree with the KPI tiles above (a `blocked` row is excluded from the chart
 * exactly as it is excluded from `within_year_count`). The four metric rows below
 * the chart are server fields rendered verbatim — none is derived from the chart.
 *
 * NO TREND ARROWS. The reference's rows carry up/down deltas. A delta needs a
 * comparison basis, and with one active-run snapshot there is none; an arrow
 * drawn anyway would be a fabricated claim about direction on a surface a client
 * uses to decide an annual R&D portfolio. The rows carry the outcome's own icon
 * and a share bar instead.
 */

const DEFAULT_HORIZON_WEEKS = 78;
const YEAR_END_WEEK = 52;

export interface CompletionProfileCardProps {
  data: CompletingWithinYear;
  /** `ScheduleRunSummary.horizon_weeks` from the active run, when loaded. */
  horizonWeeks: number | null | undefined;
}

interface ProfilePoint {
  week: number;
  within_year: number;
  spillover: number;
}

const SERIES: { key: 'within_year' | 'spillover'; bucket: OutcomeBucket }[] = [
  { key: 'within_year', bucket: 'within_year' },
  { key: 'spillover', bucket: 'spillover' },
];

const METRIC_ROWS: { bucket: OutcomeBucket; field: keyof CompletingWithinYear }[] = [
  { bucket: 'within_year', field: 'within_year_count' },
  { bucket: 'spillover', field: 'spillover_count' },
  { bucket: 'left_out', field: 'left_out_count' },
  { bucket: 'blocked', field: 'blocked_count' },
];

function MetricRow({
  bucket,
  value,
  max,
}: {
  bucket: OutcomeBucket;
  value: number;
  max: number;
}): React.JSX.Element {
  const style = OUTCOME_STYLE[bucket];
  const counted = useCountUp(value);
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;

  return (
    <li className="flex items-center gap-s3 py-s2">
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-full', style.chip)}>
        <style.Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-s2">
          <span className="truncate text-2xs font-medium text-text">{style.label}</span>
          <span className="tnum text-body font-semibold tabular-nums text-text" data-numeric="">
            {formatInteger(counted)}
          </span>
        </span>
        <span className="mt-1 block h-1.5 overflow-hidden rounded-pill bg-dash-alt">
          <span
            className={cn('block h-full rounded-pill transition-[width] duration-slow ease-ease-out-expo', style.track)}
            style={{ width: `${String(pct)}%` }}
          />
        </span>
      </span>
    </li>
  );
}

export function CompletionProfileCard({
  data,
  horizonWeeks,
}: CompletionProfileCardProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const [chartRef, revealed] = useRevealOnce<HTMLDivElement>();
  const horizon = horizonWeeks ?? DEFAULT_HORIZON_WEEKS;

  const { points, hasSeries } = React.useMemo(() => {
    const perWeek = { within_year: new Map<number, number>(), spillover: new Map<number, number>() };
    for (const row of data.rows) {
      const bucket = outcomeOf(row);
      if (bucket !== 'within_year' && bucket !== 'spillover') continue;
      const week = row.last_step_end_week;
      if (week === null) continue;
      const clamped = Math.min(Math.max(week, 1), horizon);
      const map = perWeek[bucket];
      map.set(clamped, (map.get(clamped) ?? 0) + 1);
    }

    let cumulativeWithin = 0;
    let cumulativeSpill = 0;
    const out: ProfilePoint[] = [];
    for (let week = 1; week <= horizon; week += 1) {
      cumulativeWithin += perWeek.within_year.get(week) ?? 0;
      cumulativeSpill += perWeek.spillover.get(week) ?? 0;
      out.push({ week, within_year: cumulativeWithin, spillover: cumulativeSpill });
    }
    return { points: out, hasSeries: cumulativeWithin + cumulativeSpill > 0 };
  }, [data.rows, horizon]);

  const metricMax = METRIC_ROWS.reduce(
    (max, row) => Math.max(max, Number(data[row.field]) || 0),
    0,
  );

  const ticks = React.useMemo(() => {
    const step = 13;
    const out: number[] = [];
    for (let week = step; week < horizon; week += step) out.push(week);
    out.push(horizon);
    return [1, ...out];
  }, [horizon]);

  const finalPoint = points.at(-1);

  return (
    <BoltCard>
      <CardHeader className="flex-wrap">
        <CardTitle>Completion profile</CardTitle>
        <span className="inline-flex items-center rounded-pill bg-dash-alt px-2.5 py-1 text-2xs font-medium text-text-muted">
          Active run · {formatInteger(horizon)}-week horizon
        </span>
        <CardInfo label="Completion profile source">
          <p>
            Cumulative count of projects whose last scheduled step ends on or before each week of
            the active run&apos;s horizon, split by schedule outcome. Every point is counted from
            the <code>last_step_end_week</code> and outcome flags on the run&apos;s own project
            rows (<code>GET /dashboard/completing-within-year</code>).
          </p>
          <p>
            This is a profile ACROSS ONE RUN&apos;S HORIZON, not a history across runs. The API
            exposes no per-run outcome counts, so no cross-run trend is available and none is
            drawn. No sample or illustrative data appears on this card.
          </p>
          <p>
            Blocked and left-out projects have no scheduled finish week, so they do not appear in
            the chart; their counts are listed beside it.
          </p>
        </CardInfo>
      </CardHeader>

      <CardContent className="grid gap-s5 lg:grid-cols-[1.6fr_1fr]">
        <div>
          {/* Legend as chips, not Recharts' own <Legend> — same pill vocabulary as
              the rest of the Boltshift surface, and it stays legible at this size. */}
          <ul className="mb-s3 flex flex-wrap items-center gap-s3">
            {SERIES.map((series) => (
              <li key={series.key} className="flex items-center gap-1.5 text-2xs text-text-muted">
                <span
                  className={cn('size-2.5 rounded-full', OUTCOME_STYLE[series.bucket].track)}
                  aria-hidden="true"
                />
                {OUTCOME_STYLE[series.bucket].label}
              </li>
            ))}
            <li className="flex items-center gap-1.5 text-2xs text-text-subtle">
              <span className="h-0 w-4 border-t border-dashed border-border-strong" aria-hidden="true" />
              Year end ({formatWeek(YEAR_END_WEEK)})
            </li>
          </ul>

          <div ref={chartRef} className="h-[240px] w-full">
            {!hasSeries ? (
              <EmptyState
                title="No scheduled finish weeks"
                description="No project in this run has a scheduled last step."
              />
            ) : revealed ? (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    {SERIES.map((series) => (
                      <linearGradient
                        key={series.key}
                        id={`dash-profile-${series.key}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor={`hsl(var(${OUTCOME_STYLE[series.bucket].colorToken}))`}
                          stopOpacity={0.45}
                        />
                        <stop
                          offset="100%"
                          stopColor={`hsl(var(${OUTCOME_STYLE[series.bucket].colorToken}))`}
                          stopOpacity={0.04}
                        />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid
                    stroke="hsl(var(--color-dash-hairline))"
                    strokeDasharray="4 4"
                    horizontal
                    vertical={false}
                  />
                  <XAxis
                    dataKey="week"
                    ticks={ticks}
                    tickFormatter={(week: number) => formatWeek(week)}
                    tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    width={34}
                    tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <ReferenceLine
                    x={YEAR_END_WEEK}
                    stroke="hsl(var(--color-border-strong))"
                    strokeDasharray="4 4"
                  />
                  <Tooltip
                    cursor={{ stroke: 'hsl(var(--color-dash-hairline))', strokeWidth: 2 }}
                    // Recharts types `label`/`value`/`name` as the widest possible
                    // unions (ReactNode / ValueType / NameType); narrow at the
                    // boundary rather than widening our own formatters.
                    labelFormatter={(label: React.ReactNode) =>
                      typeof label === 'number' ? formatWeek(label) : String(label ?? '')
                    }
                    formatter={(value: unknown, name: unknown) =>
                      [
                        typeof value === 'number' ? formatInteger(value) : String(value ?? ''),
                        name === 'within_year'
                          ? OUTCOME_STYLE.within_year.label
                          : OUTCOME_STYLE.spillover.label,
                      ] as [string, string]
                    }
                    contentStyle={{
                      background: 'hsl(var(--color-surface))',
                      color: 'hsl(var(--color-text))',
                      border: '1px solid hsl(var(--color-dash-hairline))',
                      borderRadius: '1rem',
                      fontSize: 12,
                      boxShadow: 'var(--shadow-pop)',
                    }}
                    isAnimationActive={!reducedMotion}
                  />
                  {SERIES.map((series, index) => (
                    <Area
                      key={series.key}
                      type="monotone"
                      dataKey={series.key}
                      stackId="profile"
                      stroke={`hsl(var(${OUTCOME_STYLE[series.bucket].colorToken}))`}
                      strokeWidth={2}
                      fill={`url(#dash-profile-${series.key})`}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0 }}
                      isAnimationActive={!reducedMotion}
                      animationBegin={index * 120}
                      animationDuration={900}
                      animationEasing="ease-out"
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : null}
          </div>

          {/* Accessible fallback — a `<dl>`, this surface's established pattern for
              a chart summary (see `hub-type-pipeline-chart.tsx`). Quarter marks
              only: 78 weekly entries would be unreadable as speech. */}
          {hasSeries ? (
            <dl className="sr-only">
              <dt>
                Cumulative projects completing by week, from the active schedule run, split by
                outcome
              </dt>
              {ticks.map((week) => {
                const point = points[week - 1];
                if (!point) return null;
                return (
                  <dd key={week}>
                    By {formatWeek(week)}: within year {point.within_year}, spillover{' '}
                    {point.spillover}
                  </dd>
                );
              })}
              {finalPoint ? (
                <dd>
                  End of horizon {formatWeek(horizon)}: within year {finalPoint.within_year},
                  spillover {finalPoint.spillover}
                </dd>
              ) : null}
            </dl>
          ) : null}
        </div>

        <div className="lg:border-l lg:border-dash-hairline lg:pl-s5">
          <p className="label-caps mb-s2 text-text-subtle">Outcome totals</p>
          <ul className="divide-y divide-dash-hairline">
            {METRIC_ROWS.map((row) => (
              <MetricRow
                key={row.bucket}
                bucket={row.bucket}
                value={Number(data[row.field]) || 0}
                max={metricMax}
              />
            ))}
          </ul>
        </div>
      </CardContent>
    </BoltCard>
  );
}
