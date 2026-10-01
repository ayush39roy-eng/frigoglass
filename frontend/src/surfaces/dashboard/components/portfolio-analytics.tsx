import * as React from 'react';
import { motion } from 'framer-motion';
import { BarChart3, Layers, Target } from 'lucide-react';
import {
  Bar,
  BarChart as RechartsBarChart,
  Cell,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { HORIZON_WEEKS, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatInteger, formatWeek } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import type { CompletingWithinYearRow } from '../api/types';
import { outcomeOf, type OutcomeBucket } from '../lib/outcome';
import { CardInfo } from './card-info';

/**
 * Portfolio analytics (2026-10-01, client ask: "lots of graphs, fascinating").
 * Three views of the SAME `completing-within-year` rows the outcome table
 * lists. Every figure is a COUNT of those rows (grouped by finish week, hub or
 * priority); no schedule figure is recomputed (Invariant I9). The per-project
 * outcome flags and finish weeks are the run's own.
 */

export interface PortfolioAnalyticsProps {
  rows: CompletingWithinYearRow[];
}

export function PortfolioAnalytics({ rows }: PortfolioAnalyticsProps): React.JSX.Element {
  return (
    <section className="space-y-s4" aria-labelledby="portfolio-analytics-heading">
      <div>
        <h2
          id="portfolio-analytics-heading"
          className="font-display text-h1 font-extrabold tracking-tight text-text"
        >
          Portfolio analytics
        </h2>
        <p className="text-sm font-medium text-text-muted">
          The active run&apos;s project outcomes, sliced by finish week, hub and priority
        </p>
      </div>
      <div className="grid gap-gutter xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-7">
          <FinishWeekHistogram rows={rows} />
        </div>
        <div className="min-w-0 xl:col-span-5">
          <PriorityDeliveryRings rows={rows} />
        </div>
        <div className="min-w-0 xl:col-span-12">
          <HubOutcomeStack rows={rows} />
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function CardHead({
  icon: Icon,
  title,
  subtitle,
  info,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  info: React.ReactNode;
  right?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-s3">
      <div className="flex items-center gap-s3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-subtle text-primary-subtle-fg">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="font-display text-h2 font-bold tracking-tight text-text">{title}</h3>
          <p className="text-xs font-medium text-text-subtle">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-s2">
        {right}
        <CardInfo label={`About ${title}`}>{info}</CardInfo>
      </div>
    </div>
  );
}

/* ---------------------------- finish-week histogram ------------------------ */

const BUCKET = 4;

interface Bucket {
  label: string;
  from: number;
  to: number;
  count: number;
  afterCutoff: boolean;
}

function buildBuckets(rows: CompletingWithinYearRow[]): Bucket[] {
  const weeks = rows
    .map((r) => r.last_step_end_week)
    .filter((w): w is number => w !== null);
  if (weeks.length === 0) return [];
  const first = Math.floor((Math.min(...weeks) - 1) / BUCKET) * BUCKET + 1;
  const buckets: Bucket[] = [];
  for (let from = first; from <= HORIZON_WEEKS; from += BUCKET) {
    const to = Math.min(from + BUCKET - 1, HORIZON_WEEKS);
    buckets.push({
      label: `W${String(from)}`,
      from,
      to,
      count: weeks.filter((w) => w >= from && w <= to).length,
      afterCutoff: from > WITHIN_YEAR_WEEK,
    });
  }
  return buckets;
}

function HistogramTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Bucket }>;
}): React.JSX.Element | null {
  const b = payload?.[0]?.payload;
  if (!active || !b) return null;
  return (
    <div className="rounded-xl border-[1.5px] border-border bg-surface px-s3 py-s2 text-xs shadow-pop">
      <p className="font-bold text-text">
        {formatWeek(b.from)} – {formatWeek(b.to)}
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-text-muted">
        <span
          className={cn('size-2 rounded-full', b.afterCutoff ? 'bg-warning' : 'bg-primary')}
          aria-hidden="true"
        />
        {formatInteger(b.count)} {b.count === 1 ? 'project finishes' : 'projects finish'}
      </p>
    </div>
  );
}

function FinishWeekHistogram({ rows }: { rows: CompletingWithinYearRow[] }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const buckets = React.useMemo(() => buildBuckets(rows), [rows]);
  const peak = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  const peakIndex = buckets.findIndex((b) => b.count === peak);
  const [hover, setHover] = React.useState<number | null>(null);
  const highlight = hover ?? peakIndex;

  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card">
      <CardHead
        icon={BarChart3}
        title="Finish-week distribution"
        subtitle="When projects' last steps end, in 4-week buckets"
        info={
          <p>
            Each bar counts the projects whose last scheduled step ends in that 4-week window
            (the run&apos;s own end week). Blue bars finish by {formatWeek(WITHIN_YEAR_WEEK)}; amber
            bars spill into next year.
          </p>
        }
        right={
          <span className="hidden items-center gap-s3 text-2xs font-semibold text-text-muted sm:flex">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-primary" aria-hidden="true" />
              By {formatWeek(WITHIN_YEAR_WEEK)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-warning" aria-hidden="true" />
              After
            </span>
          </span>
        }
      />
      {buckets.length === 0 ? (
        <p className="text-sm text-text-muted">No scheduled finish weeks in this run.</p>
      ) : (
        <figure aria-label="Projects by finish week" className="min-h-64 w-full flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <RechartsBarChart
              data={buckets}
              margin={{ top: 24, right: 4, bottom: 0, left: -24 }}
              onMouseMove={(state) => {
                const idx = state.activeTooltipIndex;
                setHover(typeof idx === 'number' ? idx : null);
              }}
              onMouseLeave={() => setHover(null)}
            >
              <defs>
                <pattern
                  id="finish-hatch"
                  patternUnits="userSpaceOnUse"
                  width="7"
                  height="7"
                  patternTransform="rotate(45)"
                >
                  <rect width="7" height="7" fill="hsl(var(--color-primary))" />
                  <line x1="0" y1="0" x2="0" y2="7" stroke="hsl(0 0% 100% / 0.35)" strokeWidth="3" />
                </pattern>
                <pattern
                  id="finish-hatch-warn"
                  patternUnits="userSpaceOnUse"
                  width="7"
                  height="7"
                  patternTransform="rotate(45)"
                >
                  <rect width="7" height="7" fill="hsl(var(--color-warning))" />
                  <line x1="0" y1="0" x2="0" y2="7" stroke="hsl(0 0% 100% / 0.35)" strokeWidth="3" />
                </pattern>
              </defs>
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={0}
                tick={{ fontSize: 10, fontWeight: 600, fill: 'hsl(var(--color-text-subtle))' }}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'hsl(var(--color-text-subtle))' }}
              />
              <Tooltip content={<HistogramTooltip />} cursor={false} />
              <Bar
                dataKey="count"
                radius={[10, 10, 10, 10]}
                maxBarSize={34}
                background={{ fill: 'hsl(var(--color-surface-sunken))', radius: 10 }}
                isAnimationActive={!reduced}
                animationDuration={900}
                label={(props: { x?: string | number | undefined; y?: string | number | undefined; width?: string | number | undefined; index?: number | undefined }) => {
                  const x = Number(props.x);
                  const y = Number(props.y);
                  const width = Number(props.width);
                  const index = props.index;
                  return index === highlight && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) ? (
                    <g>
                      <rect x={x + width / 2 - 14} y={y - 22} width={28} height={17} rx={8.5} fill="hsl(var(--color-text))" />
                      <text
                        x={x + width / 2}
                        y={y - 13.5}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={10}
                        fontWeight={700}
                        fill="hsl(var(--color-text-inverse))"
                      >
                        {index === undefined ? '' : (buckets[index]?.count ?? '')}
                      </text>
                    </g>
                  ) : (
                    <g />
                  );
                }}
              >
                {buckets.map((b, i) => (
                  <Cell
                    key={b.label}
                    fill={
                      i === highlight
                        ? `url(#${b.afterCutoff ? 'finish-hatch-warn' : 'finish-hatch'})`
                        : b.afterCutoff
                          ? 'hsl(var(--color-warning) / 0.55)'
                          : 'hsl(var(--color-primary) / 0.6)'
                    }
                  />
                ))}
              </Bar>
            </RechartsBarChart>
          </ResponsiveContainer>
        </figure>
      )}
    </BoltCard>
  );
}

/* ---------------------------- priority delivery rings ---------------------- */

const PRIORITY_COLOR: Record<ProjectPriority, string> = {
  P1: 'hsl(var(--color-band-p1))',
  P2: 'hsl(var(--color-band-p2))',
  P3: 'hsl(var(--color-band-p3))',
  P4: 'hsl(var(--color-band-p4))',
  Q: 'hsl(var(--color-band-q))',
};

interface PriorityDatum {
  priority: ProjectPriority;
  total: number;
  within: number;
  pct: number;
  fill: string;
}

function PriorityDeliveryRings({ rows }: { rows: CompletingWithinYearRow[] }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const data = React.useMemo<PriorityDatum[]>(
    () =>
      PROJECT_PRIORITIES.map((priority) => {
        const ofP = rows.filter((r) => r.priority === priority);
        const within = ofP.filter((r) => r.within_year).length;
        return {
          priority,
          total: ofP.length,
          within,
          pct: ofP.length === 0 ? 0 : Math.round((within / ofP.length) * 100),
          fill: PRIORITY_COLOR[priority],
        };
      }).filter((d) => d.total > 0),
    [rows],
  );

  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card">
      <CardHead
        icon={Target}
        title="Delivery by priority"
        subtitle="Share of each priority band finishing within the year"
        info={
          <p>
            Each ring is one priority band: the filled arc is the share of that band&apos;s projects
            the active run flags as within-year. Counts come from the run&apos;s per-project outcome
            flags.
          </p>
        }
      />
      {data.length === 0 ? (
        <p className="text-sm text-text-muted">No prioritised projects in this run.</p>
      ) : (
        <div className="grid flex-1 items-center gap-s4 sm:grid-cols-[1fr_auto]">
          <figure aria-label="Within-year share by priority band" className="mx-auto h-56 w-full max-w-[16rem]">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                data={[...data].reverse()}
                innerRadius="28%"
                outerRadius="100%"
                startAngle={90}
                endAngle={-270}
                barSize={12}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                <RadialBar
                  dataKey="pct"
                  cornerRadius={8}
                  background={{ fill: 'hsl(var(--color-surface-sunken))' }}
                  isAnimationActive={!reduced}
                  animationDuration={1100}
                />
              </RadialBarChart>
            </ResponsiveContainer>
          </figure>
          <ul className="space-y-s2">
            {data.map((d) => (
              <li
                key={d.priority}
                className="flex items-center gap-s3 rounded-xl border-[1.5px] border-dash-hairline bg-dash-alt px-s3 py-s2"
              >
                <span className="size-3 rounded-full" style={{ background: d.fill }} aria-hidden="true" />
                <span className="w-7 text-sm font-bold text-text">{d.priority}</span>
                <span className="ml-auto text-right">
                  <span className="block font-display text-base font-extrabold tabular-nums text-text" data-numeric="">
                    {d.pct}%
                  </span>
                  <span className="block text-2xs font-medium text-text-subtle" data-numeric="">
                    {d.within} of {d.total}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </BoltCard>
  );
}

/* ---------------------------- outcomes by hub ------------------------------ */

const STACK_ORDER: { bucket: OutcomeBucket; label: string; fill: string; dot: string }[] = [
  { bucket: 'within_year', label: 'Within year', fill: 'bg-success', dot: 'bg-success' },
  { bucket: 'spillover', label: 'Spillover', fill: 'bg-warning', dot: 'bg-warning' },
  { bucket: 'left_out', label: 'Left out', fill: 'bg-danger', dot: 'bg-danger' },
  { bucket: 'blocked', label: 'Blocked', fill: 'bg-text-muted', dot: 'bg-text-muted' },
];

function HubOutcomeStack({ rows }: { rows: CompletingWithinYearRow[] }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const hubs = React.useMemo(() => {
    const map = new Map<string, Record<OutcomeBucket, number>>();
    for (const row of rows) {
      const entry =
        map.get(row.hub) ??
        ({ within_year: 0, spillover: 0, left_out: 0, blocked: 0, unresolved: 0 } as Record<OutcomeBucket, number>);
      entry[outcomeOf(row)] += 1;
      map.set(row.hub, entry);
    }
    return [...map.entries()]
      .map(([hub, counts]) => ({
        hub,
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);
  const max = hubs.reduce((m, h) => Math.max(m, h.total), 0);

  return (
    <BoltCard className="flex flex-col gap-s4 p-card">
      <CardHead
        icon={Layers}
        title="Outcomes by hub"
        subtitle="Every project in the run, stacked by its outcome"
        info={
          <p>
            One bar per hub, sized by how many of its projects are in the active run, split by each
            project&apos;s outcome flag. A project appears in exactly one segment.
          </p>
        }
        right={
          <span className="hidden flex-wrap items-center gap-s3 text-2xs font-semibold text-text-muted md:flex">
            {STACK_ORDER.map((s) => (
              <span key={s.bucket} className="flex items-center gap-1.5">
                <span className={cn('size-2.5 rounded-full', s.dot)} aria-hidden="true" />
                {s.label}
              </span>
            ))}
          </span>
        }
      />
      <ul className="space-y-s3" aria-label="Outcome counts per hub">
        {hubs.map((h, i) => (
          <li key={h.hub} className="grid items-center gap-s3 sm:grid-cols-[9rem_1fr_3rem]">
            <span className="truncate text-sm font-bold text-text">{h.hub}</span>
            <div className="h-7 overflow-hidden rounded-full bg-surface-sunken">
              <motion.div
                className="flex h-full overflow-hidden rounded-full"
                style={{ width: `${String(max === 0 ? 0 : (h.total / max) * 100)}%`, transformOrigin: 'left' }}
                {...(reduced
                  ? {}
                  : {
                      initial: { scaleX: 0 },
                      whileInView: { scaleX: 1 },
                      viewport: { once: true, margin: '-40px' },
                      transition: { duration: 0.9, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] },
                    })}
              >
                {STACK_ORDER.map((s) => {
                  const n = h.counts[s.bucket];
                  if (n === 0) return null;
                  return (
                    <span
                      key={s.bucket}
                      className={cn(
                        'grid h-full place-items-center border-r-2 border-surface text-2xs font-bold text-white last:border-r-0',
                        s.fill,
                      )}
                      style={{ width: `${String((n / h.total) * 100)}%` }}
                      title={`${h.hub}: ${String(n)} ${s.label.toLowerCase()}`}
                    >
                      {n}
                    </span>
                  );
                })}
              </motion.div>
            </div>
            <span className="text-right font-display text-base font-extrabold tabular-nums text-text" data-numeric="">
              {h.total}
            </span>
          </li>
        ))}
      </ul>
    </BoltCard>
  );
}
