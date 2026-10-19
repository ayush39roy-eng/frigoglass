import * as React from 'react';
import { CalendarRange, PieChart as PieIcon, Shapes, Split, Tags } from 'lucide-react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { categoryRank } from '@/lib/categorical-palette';
import { formatInteger } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { HUB_NAMES, PROJECT_TYPES, type ProjectType } from '@/types/enums';

import type { AnalyticsBucket, CompletingByTypeRow, DashboardAnalytics } from '../api/types';
import { formatServedPct, typeCode, typeLabel } from '../lib/analytics';
import { CompletingHubTypeTable } from './completing-hub-type-table';

/**
 * "Analytics & breakdown" (P13-T10, API_CONTRACT_P13 §5; mock-up images 7–8).
 *
 * Lazy-loaded from `DashboardPage` (it is a Recharts consumer, see the note
 * there). Renders `GET /dashboard/analytics` verbatim: every bar height, slice,
 * label and percentage is one served field. Bar widths and slice angles are
 * the chart library's drawing of those served counts; no figure is derived in
 * the browser (I9). Plant and Requested-by charts are not built (OQ #34).
 */

export interface AnalyticsBreakdownProps {
  data: DashboardAnalytics;
  /** Served `PipelineTotals.total_count` (same basis), shown in each donut's
   *  centre. Omitted while that query is unresolved. */
  pipelineTotal?: number | undefined;
}

export function AnalyticsBreakdown({ data, pipelineTotal }: AnalyticsBreakdownProps): React.JSX.Element {
  return (
    <section className="space-y-s4" aria-labelledby="analytics-breakdown-heading">
      <div>
        <h2 id="analytics-breakdown-heading" className="font-display text-h1 font-extrabold tracking-tight text-text">
          Analytics &amp; breakdown
        </h2>
        <p className="text-sm font-medium text-text-muted">
          The pipeline by type, registration year, hub and category, and what completes within the year
        </p>
      </div>

      {data.has_active_schedule_run ? (
        <div className="grid gap-gutter xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-7">
            <CompletingHubTypeTable
              cells={data.completing_hub_type}
              byType={data.completing_by_type}
              byHub={data.completing_by_hub}
            />
          </div>
          <div className="min-w-0 xl:col-span-5">
            <PipelineVsCompletingChart rows={data.completing_by_type} />
          </div>
        </div>
      ) : (
        <BoltCard className="p-card">
          <p className="text-sm text-text-muted">
            No active schedule run yet: the within-year completion breakdown appears after the first run.
          </p>
        </BoltCard>
      )}

      <div className="grid gap-gutter lg:grid-cols-2">
        <ChartCard
          icon={Tags}
          title="By project type"
          subtitle="Pipeline projects per type"
          info="Pipeline projects of each type, with each type's served share of the pipeline."
        >
          <BucketBars
            buckets={data.by_type}
            ariaLabel="Pipeline projects by project type"
            codeOf={(k) => typeCode(k)}
            nameOf={(k) => typeLabel(k)}
            colorOf={(k, i) => typeColorRank(k, i)}
          />
        </ChartCard>
        <ChartCard
          icon={CalendarRange}
          title="Registered by year"
          subtitle="Pipeline projects by registration year"
          info="Pipeline projects grouped by the year they were registered. Projects without a registration year are counted under Unknown."
        >
          <BucketBars
            buckets={data.by_reg_year}
            ariaLabel="Pipeline projects by registration year"
            codeOf={(k) => k}
            nameOf={(k) => k}
            colorOf={(_k, i) => i + 4}
          />
        </ChartCard>
        <ChartCard
          icon={PieIcon}
          title="By hub"
          subtitle="Share of the pipeline per hub"
          info="Pipeline projects per hub and each hub's served share of the pipeline."
        >
          <BucketDonut
            buckets={data.by_hub}
            ariaLabel="Pipeline projects by hub"
            colorOf={(k, i) => hubColorRank(k, i)}
            total={pipelineTotal}
          />
        </ChartCard>
        <ChartCard
          icon={Shapes}
          title="By category"
          subtitle="Share of the pipeline per category"
          info="Pipeline projects per category and each category's served share of the pipeline."
        >
          <BucketDonut
            buckets={data.by_category}
            ariaLabel="Pipeline projects by category"
            colorOf={(k) => categoryRank(k)}
            total={pipelineTotal}
          />
        </ChartCard>
      </div>
    </section>
  );
}

/* --------------------------------- colours --------------------------------- */

/** `--dash-cat-1..10` by a deterministic rank (theme-reactive CSS variable). */
function catFill(rank: number): string {
  return `hsl(var(--dash-cat-${String((((rank % 10) + 10) % 10) + 1)}))`;
}

function typeColorRank(key: string, index: number): number {
  const i = (PROJECT_TYPES as readonly string[]).indexOf(key as ProjectType);
  return i === -1 ? PROJECT_TYPES.length + index : i;
}

function hubColorRank(key: string, index: number): number {
  const i = (HUB_NAMES as readonly string[]).indexOf(key);
  return i === -1 ? HUB_NAMES.length + index : i;
}

/* --------------------------------- chrome ---------------------------------- */

function ChartCard({
  icon: Icon,
  title,
  subtitle,
  info,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  info: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingId = React.useId();
  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card" role="group" aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-s3">
        <div className="flex items-center gap-s3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-subtle text-primary-subtle-fg">
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 id={headingId} className="font-display text-h2 font-bold tracking-tight text-text">
              {title}
            </h3>
            <p className="text-xs font-medium text-text-subtle">{subtitle}</p>
          </div>
        </div>
        <CardInfo label={`About ${title}`}>
          <p>{info}</p>
          <p>Served by the API for the current hub / country filter.</p>
        </CardInfo>
      </div>
      {children}
    </BoltCard>
  );
}

function Empty(): React.JSX.Element {
  return <p className="py-s6 text-center text-sm text-text-muted">No pipeline projects in view.</p>;
}

/* ------------------------------- bucket bars ------------------------------- */

interface BucketDatum {
  key: string;
  code: string;
  name: string;
  count: number;
  share_pct: number;
  fill: string;
}

function BucketTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: BucketDatum }>;
}): React.JSX.Element | null {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="rounded-xl border-[1.5px] border-border bg-surface px-s3 py-s2 text-xs shadow-pop">
      <p className="font-bold text-text">{d.name}</p>
      <p className="mt-0.5 text-text-muted" data-numeric="">
        {formatInteger(d.count)} projects · {formatServedPct(d.share_pct)}
      </p>
    </div>
  );
}

function BucketBars({
  buckets,
  ariaLabel,
  codeOf,
  nameOf,
  colorOf,
}: {
  buckets: AnalyticsBucket[];
  ariaLabel: string;
  codeOf: (key: string) => string;
  nameOf: (key: string) => string;
  colorOf: (key: string, index: number) => number;
}): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const data = React.useMemo<BucketDatum[]>(
    () =>
      buckets.map((b, i) => ({
        key: b.key,
        code: codeOf(b.key),
        name: nameOf(b.key),
        count: b.count,
        share_pct: b.share_pct,
        fill: catFill(colorOf(b.key, i)),
      })),
    [buckets, codeOf, nameOf, colorOf],
  );
  if (data.length === 0) return <Empty />;
  return (
    <>
      {/* Decorative: the sr-only list below carries the data. Recharts 3 makes its surface (and a
          Pie layer) tabbable, so accessibilityLayer/rootTabIndex are switched off here and on the
          other aria-hidden charts in this file (P13-R01, axe aria-hidden-focus). */}
      <figure aria-hidden="true" className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart accessibilityLayer={false} data={data} margin={{ top: 28, right: 4, bottom: 0, left: -20 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="hsl(var(--color-border))" />
            <XAxis
              dataKey="code"
              tickLine={false}
              axisLine={false}
              interval={0}
              tick={{ fontSize: 11, fontWeight: 600, fill: 'hsl(var(--color-text-subtle))' }}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: 'hsl(var(--color-text-subtle))' }}
            />
            <Tooltip content={<BucketTooltip />} cursor={{ fill: 'hsl(var(--color-surface-sunken))' }} />
            <Bar
              dataKey="count"
              radius={[8, 8, 0, 0]}
              maxBarSize={64}
              isAnimationActive={!reduced}
              label={(props: { x?: string | number | undefined; y?: string | number | undefined; width?: string | number | undefined; index?: number | undefined }) => {
                const d = props.index === undefined ? undefined : data[props.index];
                const x = Number(props.x);
                const y = Number(props.y);
                const w = Number(props.width);
                if (!d || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w)) return <g />;
                return (
                  <text
                    x={x + w / 2}
                    y={y - 8}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={700}
                    fill="hsl(var(--color-text))"
                  >
                    {`${formatInteger(d.count)} (${formatServedPct(d.share_pct)})`}
                  </text>
                );
              }}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={d.fill} />
              ))}
            </Bar>
          </RechartsBarChart>
        </ResponsiveContainer>
      </figure>
      <ul aria-label={ariaLabel} className="sr-only">
        {data.map((d) => (
          <li key={d.key}>
            {d.name}: {formatInteger(d.count)} ({formatServedPct(d.share_pct)})
          </li>
        ))}
      </ul>
    </>
  );
}

/* ------------------------------- bucket donut ------------------------------ */

function BucketDonut({
  buckets,
  ariaLabel,
  colorOf,
  total,
}: {
  buckets: AnalyticsBucket[];
  ariaLabel: string;
  colorOf: (key: string, index: number) => number;
  total?: number | undefined;
}): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const data = React.useMemo(
    () => buckets.map((b, i) => ({ ...b, fill: catFill(colorOf(b.key, i)) })),
    [buckets, colorOf],
  );
  if (data.length === 0) return <Empty />;
  return (
    <div className="flex flex-col items-center gap-s4 sm:flex-row sm:items-center">
      <figure aria-hidden="true" className="relative size-48 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer={false}>
            <Pie
              rootTabIndex={-1}
              data={data}
              dataKey="count"
              nameKey="key"
              innerRadius="58%"
              outerRadius="92%"
              paddingAngle={1}
              stroke="hsl(var(--color-surface))"
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
              isAnimationActive={!reduced}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={d.fill} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {total !== undefined ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="text-center">
              <span className="block font-display text-h1 font-extrabold leading-none tabular-nums text-text" data-numeric="">
                {formatInteger(total)}
              </span>
              <span className="label-caps mt-1 block text-text-subtle">projects</span>
            </span>
          </div>
        ) : null}
      </figure>
      <dl aria-label={ariaLabel} className="w-full min-w-0 flex-1 space-y-s2">
        {data.map((d) => (
          <div
            key={d.key}
            className="flex items-center gap-s3 rounded-lg border border-dash-hairline bg-dash-alt px-s3 py-1.5"
          >
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: d.fill }} />
            <dt className="min-w-0 flex-1 truncate text-sm font-medium text-text">{d.key}</dt>
            <dd className="font-mono text-sm font-semibold tabular-nums text-text" data-numeric="">
              {formatInteger(d.count)}
            </dd>
            <dd className="w-16 text-right text-2xs tabular-nums text-text-muted" data-numeric="">
              {formatServedPct(d.share_pct)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ------------------------- pipeline vs completing -------------------------- */

interface PvcDatum {
  key: string;
  code: string;
  name: string;
  pipeline: number;
  completing: number;
  pct: number;
}

function PvcTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PvcDatum }>;
}): React.JSX.Element | null {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="rounded-xl border-[1.5px] border-border bg-surface px-s3 py-s2 text-xs shadow-pop">
      <p className="font-bold text-text">{d.name}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-text-muted" data-numeric="">
        <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
        Pipeline {formatInteger(d.pipeline)}
      </p>
      <p className="flex items-center gap-1.5 text-text-muted" data-numeric="">
        <span className="size-2 rounded-full bg-success" aria-hidden="true" />
        Completing {formatInteger(d.completing)} ({formatServedPct(d.pct)})
      </p>
    </div>
  );
}

function barLabel(
  data: PvcDatum[],
  text: (d: PvcDatum) => string,
): (props: { x?: string | number | undefined; y?: string | number | undefined; width?: string | number | undefined; index?: number | undefined }) => React.JSX.Element {
  return function PvcLabel(props) {
    const d = props.index === undefined ? undefined : data[props.index];
    const x = Number(props.x);
    const y = Number(props.y);
    const w = Number(props.width);
    if (!d || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w)) return <g />;
    return (
      <text x={x + w / 2} y={y - 6} textAnchor="middle" fontSize={9} fontWeight={700} fill="hsl(var(--color-text-muted))">
        {text(d)}
      </text>
    );
  };
}

export function PipelineVsCompletingChart({ rows }: { rows: CompletingByTypeRow[] }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const data = React.useMemo<PvcDatum[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        code: typeCode(r.key),
        name: typeLabel(r.key),
        pipeline: r.pipeline_count,
        completing: r.completing_count,
        pct: r.completing_pct,
      })),
    [rows],
  );
  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card">
      <div className="flex items-start justify-between gap-s3">
        <div className="flex items-center gap-s3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-subtle text-primary-subtle-fg">
            <Split className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-display text-h2 font-bold tracking-tight text-text">Pipeline vs completing</h3>
            <p className="text-xs font-medium text-text-subtle">Per project type, in the active run</p>
          </div>
        </div>
        <div className="flex items-center gap-s3">
          <span className="hidden items-center gap-s3 text-2xs font-semibold text-text-muted sm:flex">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-primary" aria-hidden="true" />
              Pipeline
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-success" aria-hidden="true" />
              Completing
            </span>
          </span>
          <CardInfo label="About pipeline vs completing">
            <p>
              For each project type: the pipeline count and how many of those projects the active
              schedule run completes within the year, with the served completing share.
            </p>
          </CardInfo>
        </div>
      </div>
      {data.length === 0 ? (
        <Empty />
      ) : (
        <>
          <figure aria-hidden="true" className="h-72 w-full flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <RechartsBarChart accessibilityLayer={false} data={data} barGap={3} margin={{ top: 24, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="hsl(var(--color-border))" />
                <XAxis
                  dataKey="code"
                  tickLine={false}
                  axisLine={false}
                  interval={0}
                  tick={{ fontSize: 11, fontWeight: 600, fill: 'hsl(var(--color-text-subtle))' }}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: 'hsl(var(--color-text-subtle))' }}
                />
                <Tooltip content={<PvcTooltip />} cursor={{ fill: 'hsl(var(--color-surface-sunken))' }} />
                <Bar
                  dataKey="pipeline"
                  fill="hsl(var(--color-primary))"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={30}
                  isAnimationActive={!reduced}
                  label={barLabel(data, (d) => formatInteger(d.pipeline))}
                />
                <Bar
                  dataKey="completing"
                  fill="hsl(var(--color-success))"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={30}
                  isAnimationActive={!reduced}
                  label={barLabel(data, (d) => `${formatInteger(d.completing)} (${formatServedPct(d.pct)})`)}
                />
              </RechartsBarChart>
            </ResponsiveContainer>
          </figure>
          <ul aria-label="Pipeline vs completing by project type" className="sr-only">
            {data.map((d) => (
              <li key={d.key}>
                {d.name}: pipeline {formatInteger(d.pipeline)}, completing {formatInteger(d.completing)} (
                {formatServedPct(d.pct)})
              </li>
            ))}
          </ul>
        </>
      )}
    </BoltCard>
  );
}

