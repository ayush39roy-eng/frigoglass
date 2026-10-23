import * as React from 'react';
import { CalendarRange, PieChart as PieIcon, Shapes, Tags } from 'lucide-react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { HubFilterSelect } from '@/components/shared/hub-filter/hub-filter-select';
import { CardInfo } from '@/components/ui/card-info';
import { categoryRank } from '@/lib/categorical-palette';
import { formatInteger } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import {
  CATEGORY_FILTER_VALUES,
  toggleSelection,
  TYPE_FILTER_VALUES,
  type MultiChipOption,
} from '@/lib/multi-select-filter';
import { cn } from '@/lib/utils';
import { HUB_NAMES, PROJECT_TYPES, type ProjectType } from '@/types/enums';

import type { AnalyticsBucket, DashboardAnalytics } from '../api/types';
import { formatServedPct, typeCode, typeLabel } from '../lib/analytics';
import type { DashboardSelectionState } from '../lib/selection';

/**
 * "Analytics & breakdown" (P13-T10, API_CONTRACT_P13 §5; mock-up images 7–8).
 *
 * Lazy-loaded from `DashboardPage` (it is a Recharts consumer, see the note
 * there). Renders `GET /dashboard/analytics` verbatim: every bar height, slice,
 * label and percentage is one served field. Bar widths and slice angles are
 * the chart library's drawing of those served counts; no figure is derived in
 * the browser (I9). Plant and Requested-by charts are not built (OQ #34).
 *
 * P17-R08: the "Completing within year: Hub × Type" table and the "Pipeline vs
 * completing" chart moved up the page, beside the pipeline summary table
 * (`hub-type-section.tsx`); this section keeps the four composition charts.
 */

export interface AnalyticsBreakdownProps {
  data: DashboardAnalytics;
  /** Served `PipelineTotals.total_count` (same basis), shown in each donut's
   *  centre. Omitted while that query is unresolved. */
  pipelineTotal?: number | undefined;
  /** P31 cross-filter: `by_type` served WITHOUT the type selection (falls back to `data`). */
  typeBuckets?: AnalyticsBucket[] | undefined;
  /** P31 cross-filter: `by_category` served WITHOUT the category selection. */
  categoryBuckets?: AnalyticsBucket[] | undefined;
  /** Served pipeline total on the category chart's own basis (its centre). */
  categoryTotal?: number | undefined;
  /** P31: the Dashboard selection the type / category charts drive. */
  selection?: DashboardSelectionState | undefined;
}

export function AnalyticsBreakdown({
  data,
  pipelineTotal,
  typeBuckets,
  categoryBuckets,
  categoryTotal,
  selection,
}: AnalyticsBreakdownProps): React.JSX.Element {
  const typeSelect: BucketSelect | undefined = selection
    ? {
        allowed: TYPE_FILTER_VALUES,
        selected: selection.types,
        onChange: (next) => selection.setTypes(next as typeof selection.types),
        legendLabel: 'Filter the Dashboard by project type',
      }
    : undefined;
  const categorySelect: BucketSelect | undefined = selection
    ? {
        allowed: CATEGORY_FILTER_VALUES,
        selected: selection.categories,
        onChange: (next) => selection.setCategories(next as typeof selection.categories),
        legendLabel: 'Filter the Dashboard by category',
      }
    : undefined;
  return (
    <section className="space-y-s4" aria-labelledby="analytics-breakdown-heading">
      <div className="flex flex-wrap items-end justify-between gap-s3">
        <div>
          <h2 id="analytics-breakdown-heading" className="font-display text-h1 font-extrabold tracking-tight text-text">
            Analytics &amp; breakdown
          </h2>
          <p className="text-sm font-medium text-text-muted">
            The pipeline by type, registration year, hub and category
          </p>
        </div>
        {/* Owner ask 2026-10-22: the same hub / country filter as the header,
            here too, so the charts can be re-cut without scrolling up. It sets
            the one page-wide filter (`useHubFilter`); the page keeps its
            scroll position while the new figures load. */}
        <HubFilterSelect className="rounded-pill border-[1.5px] border-dash-hairline bg-surface p-0.5 shadow-dashCard" />
      </div>

      <div className="grid gap-gutter lg:grid-cols-2">
        <ChartCard
          icon={Tags}
          title="By project type"
          subtitle="Pipeline projects per type"
          info="Pipeline projects of each type, with each type's served share of the pipeline. Click a bar or a type under the chart to filter the whole Dashboard by it (several combine). This chart ignores the type filter itself, so every type stays visible."
        >
          <BucketBars
            buckets={typeBuckets ?? data.by_type}
            ariaLabel="Pipeline projects by project type"
            codeOf={(k) => typeCode(k)}
            nameOf={(k) => typeLabel(k)}
            colorOf={(k, i) => typeColorRank(k, i)}
            select={typeSelect}
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
          info="Pipeline projects per category and each category's served share of the pipeline. Click a slice or a category in the list to filter the whole Dashboard by it (several combine). This chart ignores the category filter itself, so every category stays visible."
        >
          <BucketDonut
            buckets={categoryBuckets ?? data.by_category}
            ariaLabel="Pipeline projects by category"
            colorOf={(k) => categoryRank(k)}
            total={categoryBuckets !== undefined ? categoryTotal : pipelineTotal}
            select={categorySelect}
          />
        </ChartCard>
      </div>
    </section>
  );
}

/** P31: a chart whose bars / slices drive the Dashboard selection. */
interface BucketSelect {
  allowed: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  legendLabel: string;
}

function selectState(select: BucketSelect | undefined, key: string): { clickable: boolean; dim: boolean } {
  if (!select) return { clickable: false, dim: false };
  const clickable = select.allowed.includes(key);
  return { clickable, dim: select.selected.length > 0 && !select.selected.includes(key) };
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
  label: string;
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
  select,
}: {
  buckets: AnalyticsBucket[];
  ariaLabel: string;
  codeOf: (key: string) => string;
  nameOf: (key: string) => string;
  colorOf: (key: string, index: number) => number;
  select?: BucketSelect | undefined;
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
        label: `${formatInteger(b.count)} (${formatServedPct(b.share_pct)})`,
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
              {...(select
                ? {
                    onClick: (_: unknown, index: number) => {
                      const key = data[index]?.key;
                      if (key !== undefined && select.allowed.includes(key)) {
                        select.onChange(toggleSelection(select.selected, key, select.allowed));
                      }
                    },
                  }
                : {})}
            >
              {data.map((d) => {
                const st = selectState(select, d.key);
                return (
                  <Cell
                    key={d.key}
                    fill={d.fill}
                    fillOpacity={st.dim ? 0.28 : 1}
                    className={st.clickable ? 'cursor-pointer' : undefined}
                  />
                );
              })}
              {/* P17-R08: LabelList reads each bar's own datum; the old label
                  callback used Recharts' `index`, which skips zero bars. */}
              <LabelList dataKey="label" position="top" offset={8} fontSize={10} fontWeight={700} fill="hsl(var(--color-text))" />
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
      {select ? (
        <MultiChipFilter
          label={select.legendLabel}
          hideLabel
          options={legendOptions(data, select)}
          value={select.selected}
          onChange={select.onChange}
          dimUnselected
          data-testid="analytics-type-legend"
        />
      ) : null}
    </>
  );
}

/** The toggles under a selectable chart: every served bucket it may select,
 *  plus a selected value no longer served, so it can always be switched off. */
function legendOptions(
  data: readonly { key: string; name: string; fill: string }[],
  select: BucketSelect,
): MultiChipOption<string>[] {
  const opts: MultiChipOption<string>[] = data
    .filter((d) => select.allowed.includes(d.key))
    .map((d) => ({ value: d.key, label: d.name, swatch: d.fill }));
  for (const v of select.selected) if (!opts.some((o) => o.value === v)) opts.push({ value: v, label: v });
  return opts.sort((a, b) => select.allowed.indexOf(a.value) - select.allowed.indexOf(b.value));
}

/* ------------------------------- bucket donut ------------------------------ */

function BucketDonut({
  buckets,
  ariaLabel,
  colorOf,
  total,
  select,
}: {
  buckets: AnalyticsBucket[];
  ariaLabel: string;
  colorOf: (key: string, index: number) => number;
  total?: number | undefined;
  select?: BucketSelect | undefined;
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
              {...(select
                ? {
                    onClick: (_: unknown, index: number) => {
                      const key = data[index]?.key;
                      if (key !== undefined && select.allowed.includes(key)) {
                        select.onChange(toggleSelection(select.selected, key, select.allowed));
                      }
                    },
                  }
                : {})}
            >
              {data.map((d) => {
                const st = selectState(select, d.key);
                return (
                  <Cell
                    key={d.key}
                    fill={d.fill}
                    fillOpacity={st.dim ? 0.28 : 1}
                    className={st.clickable ? 'cursor-pointer' : undefined}
                  />
                );
              })}
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
      {select ? (
        // P31: each legend row is a toggle of the Dashboard selection (the
        // keyboard path to the same action as clicking the slice).
        <ul aria-label={select.legendLabel} className="w-full min-w-0 flex-1 space-y-s2" data-testid="analytics-category-legend">
          {data.map((d) => {
            const st = selectState(select, d.key);
            const on = select.selected.includes(d.key);
            return (
              <li key={d.key}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={!st.clickable}
                  aria-label={`${d.key}: ${formatInteger(d.count)} projects (${formatServedPct(d.share_pct)})`}
                  onClick={() => select.onChange(toggleSelection(select.selected, d.key, select.allowed))}
                  className={cn(
                    'flex w-full items-center gap-s3 rounded-lg border px-s3 py-1.5 text-left transition-colors motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on
                      ? 'border-primary bg-primary-subtle'
                      : 'border-dash-hairline bg-dash-alt hover:border-border-strong',
                    st.dim && 'opacity-60 hover:opacity-100',
                  )}
                >
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: d.fill }} />
                  <span className="min-w-0 flex-1 text-sm font-medium text-text">{d.key}</span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-text" data-numeric="">
                    {formatInteger(d.count)}
                  </span>
                  <span className="w-16 text-right text-2xs tabular-nums text-text-muted" data-numeric="">
                    {formatServedPct(d.share_pct)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
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
      )}
    </div>
  );
}
