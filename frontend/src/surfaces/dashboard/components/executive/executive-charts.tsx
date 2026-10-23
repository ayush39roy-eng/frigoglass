import * as React from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { CARRY_OVER_YEAR, PLAN_YEAR } from '@/lib/domain-constants';
import { formatInteger } from '@/lib/format';
import { categoryRank } from '@/lib/categorical-palette';
import {
  CATEGORY_FILTER_VALUES,
  toggleSelection,
  TYPE_FILTER_VALUES,
  type MultiChipOption,
} from '@/lib/multi-select-filter';
import { MultiChipFilter } from '@/components/shared/multi-chip-filter';

import type { AnalyticsBucket, PipelineTotals, PriorityDeliveryBand, StatusOverview } from '../../api/types';
import { formatServedPct, typeLabel } from '../../lib/analytics';

/**
 * The Executive view's Recharts panels (P28, ADR 0039 §3 + owner addenda,
 * 2026-10-22), in ONE module so `React.lazy` keeps Recharts out of the
 * Dashboard route chunk (the same deferral as `analytics-breakdown.tsx` — see
 * the note in DashboardPage).
 *
 * Every count and share is a served field printed verbatim (I9/I19): slice
 * angles and bar widths are the chart library's drawing of served counts /
 * served `*_share_pct` fields, legends print the served figures, donut centres
 * are the served totals. Each figure element is `aria-hidden` (Recharts SVG);
 * the legend rows / sr-only lists carry the data for assistive tech
 * (`analytics-breakdown.tsx` pattern, P13-R01: nothing tabbable inside an
 * aria-hidden figure).
 *
 * Owner corrections folded in: legend entries are TWO LINES — the full name on
 * top (never ellipsized; wraps if needed) and count + served share underneath —
 * and every bar carries its counts, not a percentage alone.
 */

/* --------------------------------- chrome ---------------------------------- */

function ChartCard({
  title,
  info,
  testId,
  children,
}: {
  title: string;
  info: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingId = React.useId();
  return (
    <BoltCard className="flex h-full flex-col gap-s3 p-s5" role="group" aria-labelledby={headingId} data-testid={testId}>
      <div className="flex items-center justify-between gap-s2">
        <h3 id={headingId} className="label-caps text-text-subtle">
          {title}
        </h3>
        <CardInfo label={`About ${title}`}>{info}</CardInfo>
      </div>
      {children}
    </BoltCard>
  );
}

/* --------------------------------- donuts ---------------------------------- */

interface Slice {
  key: string;
  label: string;
  count: number;
  share_pct: number;
  fill: string;
  /** P31 cross-filter: another slice is selected and this one is not. */
  dim?: boolean;
}

/** Theme-reactive categorical palette (`--dash-cat-1..10`, tokens.css). */
function catFill(rank: number): string {
  return `hsl(var(--dash-cat-${String((((rank % 10) + 10) % 10) + 1)}))`;
}

/** Word-level line wrapping for an in-chart label — NEVER inside a word
 *  (owner correction: "In Develop ment" style mid-word breaks are banned). */
function wrapWords(label: string, max = 14): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of label.split(' ')) {
    if (current !== '' && `${current} ${word}`.length > max) {
      lines.push(current);
      current = word;
    } else {
      current = current === '' ? word : `${current} ${word}`;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

interface SliceLabelProps {
  cx?: number | string;
  cy?: number | string;
  midAngle?: number;
  outerRadius?: number | string;
  payload?: unknown;
}

/** The slice's callout: a leader line from the slice edge to a short
 *  horizontal tail, then "Name" (word-wrapped) with "count · served %" under
 *  it. Drawn by us (not recharts' labelLine) so line and text always agree. */
function renderLeaderLabel(props: SliceLabelProps): React.ReactElement {
  const cx = Number(props.cx ?? 0);
  const cy = Number(props.cy ?? 0);
  const midAngle = props.midAngle ?? 0;
  const outer = Number(props.outerRadius ?? 0);
  const raw = props.payload as (Slice & { payload?: Slice }) | undefined;
  const datum: Slice | undefined = raw && 'label' in raw && typeof raw.label === 'string' ? raw : raw?.payload;
  if (!datum) return <g />;
  const RAD = Math.PI / 180;
  const cos = Math.cos(-RAD * midAngle);
  const sin = Math.sin(-RAD * midAngle);
  const sx = cx + outer * cos;
  const sy = cy + outer * sin;
  const mx = cx + (outer + 10) * cos;
  let my = cy + (outer + 10) * sin;
  const right = cos >= 0;
  const ex = mx + (right ? 9 : -9);
  let tx = ex + (right ? 3 : -3);
  const lines = wrapWords(datum.label);
  const rows = [...lines, `${formatInteger(datum.count)} · ${formatServedPct(datum.share_pct)}`];
  const lineHeight = 11;
  // CLAMP the callout inside the SVG (the pie is centred, so the viewport is
  // ~2·cx wide and ~2·cy tall): a label may tuck back over the ring's edge on
  // a narrow column, but it can never clip at the container edge (owner round
  // 3 — "In Developme…" / "ustrialization" screenshots).
  const estWidth = Math.max(...rows.map((r) => r.length)) * 5.2;
  if (right) tx = Math.min(tx, cx * 2 - 2 - estWidth);
  else tx = Math.max(tx, 2 + estWidth);
  const halfBlock = (rows.length * lineHeight) / 2 + 2;
  my = Math.min(Math.max(my, halfBlock), cy * 2 - halfBlock);
  return (
    <g opacity={datum.dim ? 0.5 : 1}>
      <polyline
        points={`${String(sx)},${String(sy)} ${String(mx)},${String(my)} ${String(ex)},${String(my)}`}
        fill="none"
        stroke="hsl(var(--color-border-strong))"
        strokeWidth={1}
      />
      <text x={tx} y={my} textAnchor={right ? 'start' : 'end'} dominantBaseline="central" fontSize={9.5}>
        {rows.map((row, i) => (
          <tspan
            key={row}
            x={tx}
            dy={i === 0 ? (-(rows.length - 1) * lineHeight) / 2 : lineHeight}
            fontWeight={i < lines.length ? 700 : 500}
            fill={i < lines.length ? 'hsl(var(--color-text))' : 'hsl(var(--color-text-muted))'}
          >
            {row}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/**
 * A HERO donut (owner round 3, 2026-10-22: "no need for a card, remove it out
 * of the card and make it bigger"): no card chrome — an eyebrow title + info
 * popover over a large donut sitting directly on the page background, with the
 * slice labels drawn IN the chart on leader lines. The PieChart reserves
 * MARGINS for the callout text (recharts sizes the pie from the plot area
 * inside the margins, while labels may draw into them), so a label can never
 * clip at the container edge — the fix for the owner's "In Developme…" /
 * "ustrialization" screenshots. Zero slices have no arc to point at and are
 * named in one muted line under the chart. The sr-only list carries the data
 * for assistive tech (the chart SVG is aria-hidden, P13-R01).
 */
/** P31: a donut whose slices drive the Dashboard selection. */
interface DonutSelect {
  /** The values this donut can select, in option order (slices outside it are not clickable). */
  allowed: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Accessible name of the legend toggles ("Filter the Dashboard by type"). */
  legendLabel: string;
}

function HeroDonut({
  title,
  info,
  slices,
  total,
  totalLabel,
  testId,
  select,
}: {
  title: string;
  info: React.ReactNode;
  slices: Slice[];
  /** Served total shown in the donut centre. */
  total: number;
  totalLabel: string;
  testId: string;
  select?: DonutSelect | undefined;
}): React.JSX.Element {
  const headingId = React.useId();
  const anySelected = (select?.selected.length ?? 0) > 0;
  const isOn = (key: string): boolean => select?.selected.includes(key) ?? false;
  const drawn = slices
    .filter((s) => s.count > 0)
    .map((s) => (anySelected && !isOn(s.key) ? { ...s, dim: true } : s));
  const zero = slices.filter((s) => s.count === 0);
  const toggle = (key: string): void => {
    if (!select || !select.allowed.includes(key)) return;
    select.onChange(toggleSelection(select.selected, key, select.allowed));
  };
  // The legend: every served bucket of this dimension, plus a selected value the
  // served distribution no longer lists, so it can always be switched off.
  const legend: MultiChipOption<string>[] = select
    ? [
        ...slices.filter((s) => select.allowed.includes(s.key)).map((s) => ({ value: s.key, label: s.label, swatch: s.fill })),
        ...select.selected
          .filter((v) => !slices.some((s) => s.key === v))
          .map((v) => ({ value: v, label: v, swatch: undefined })),
      ].sort((a, b) => select.allowed.indexOf(a.value) - select.allowed.indexOf(b.value))
    : [];

  return (
    <section className="flex h-full min-h-0 flex-col" role="group" aria-labelledby={headingId} data-testid={testId}>
      <div className="flex items-center justify-between gap-s2 px-s2">
        <h3 id={headingId} className="label-caps text-text-subtle">
          {title}
        </h3>
        <CardInfo label={`About ${title}`}>{info}</CardInfo>
      </div>
      {/* FIXED height and FIXED pie radii (owner rounds 4–5: "just make it
          smaller", both donuts the same size): ~200 px outer diameter, capped
          in px so it is identical on both charts and cannot balloon on a wide
          screen; the whole hero row stays ≈300 px tall so the KPI strip is
          visible without scrolling at 1440×900. The leader labels live in the
          remaining horizontal room and are clamped inside the SVG. */}
      <figure aria-hidden="true" className="relative h-[15rem] w-full" data-selected={select ? select.selected.join(',') : undefined}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Recharts 3 makes its surface tabbable; switched off inside the
              aria-hidden figure (P13-R01, axe aria-hidden-focus). */}
          <PieChart accessibilityLayer={false}>
            <Pie
              rootTabIndex={-1}
              data={drawn}
              dataKey="count"
              nameKey="label"
              innerRadius={64}
              outerRadius={100}
              paddingAngle={1}
              stroke="hsl(var(--color-canvas))"
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
              // No slice sweep: recharts suppresses labels while a pie
              // animates, and the leader-line callouts ARE the content. The
              // page-level mount stagger provides the (reduced-motion-gated)
              // entrance; the chart itself is static.
              isAnimationActive={false}
              label={renderLeaderLabel}
              labelLine={false}
              {...(select
                ? { onClick: (_: unknown, index: number) => toggle(drawn[index]?.key ?? '') }
                : {})}
            >
              {drawn.map((s) => (
                <Cell
                  key={s.key}
                  fill={s.fill}
                  fillOpacity={s.dim ? 0.28 : 1}
                  className={select && select.allowed.includes(s.key) ? 'cursor-pointer outline-none' : undefined}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="text-center">
            <span className="block font-display text-2xl font-extrabold leading-none tabular-nums text-text" data-numeric="">
              {formatInteger(total)}
            </span>
            <span className="label-caps mt-0.5 block text-[0.55rem] text-text-subtle">{totalLabel}</span>
          </span>
        </div>
      </figure>
      {select ? (
        // The keyboard (and visible) path to the same toggles as the slices.
        <MultiChipFilter
          label={select.legendLabel}
          hideLabel
          options={legend}
          value={select.selected}
          onChange={(next) => select.onChange(next)}
          dimUnselected
          className="px-s2"
          data-testid={`${testId}-legend`}
        />
      ) : null}
      {zero.length > 0 && !select ? (
        <p className="px-s2 text-2xs text-text-muted" data-testid={`${testId}-zero`}>
          No projects: {zero.map((s) => s.label).join(', ')}
        </p>
      ) : null}
      {/* The data, readable (and what the tests assert). */}
      <dl aria-label={title} className="sr-only">
        {slices.map((s) => (
          <div key={s.key} data-testid={`${testId}-slice-${s.key}`}>
            <dt>{s.label}</dt>
            <dd data-numeric="">
              {formatInteger(s.count)} · {formatServedPct(s.share_pct)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Donut 1 — the portfolio COMPOSITION (carry-over vs new, ADR 0030), from
 *  `GET /dashboard/pipeline-totals`. Not the schedule "Spillover (past W52)". */
export function PipelineDonut({ totals }: { totals: PipelineTotals }): React.JSX.Element {
  const slices: Slice[] = [
    {
      key: 'spillover',
      label: 'Spillover',
      count: totals.spillover_count,
      share_pct: totals.spillover_share_pct,
      fill: 'hsl(var(--color-warning))',
    },
    {
      key: 'new',
      label: 'New',
      count: totals.new_count,
      share_pct: totals.new_share_pct,
      fill: 'hsl(var(--color-primary))',
    },
    {
      key: 'unregistered',
      label: 'Unregistered',
      count: totals.unregistered_count,
      share_pct: totals.unregistered_share_pct,
      fill: 'hsl(var(--color-border-strong))',
    },
  ];
  return (
    <HeroDonut
      title="Project pipeline"
      testId="exec-pipeline-donut"
      slices={slices}
      total={totals.total_count}
      totalLabel="projects"
      info={
        <p>
          The portfolio&apos;s composition: projects carried over from {String(CARRY_OVER_YEAR)}{' '}
          (&quot;Spillover&quot;), projects registered for {String(PLAN_YEAR)} (&quot;New&quot;), and projects
          with no registration year. Counts, shares and the total are served by the API for the current hub /
          country filter; nothing is derived in the browser.
        </p>
      }
    />
  );
}

/** Donut 2 — the served status overview (five card statuses + Other). */
export function StatusDonut({ data }: { data: StatusOverview }): React.JSX.Element {
  const slices: Slice[] = [
    { key: 'in-development', label: 'In Development', count: data.in_development, share_pct: data.in_development_share_pct, fill: catFill(0) },
    { key: 'in-queue', label: 'In Queue', count: data.in_queue, share_pct: data.in_queue_share_pct, fill: catFill(1) },
    { key: 'under-industrialization', label: 'Under Industrialization', count: data.under_industrialization, share_pct: data.under_industrialization_share_pct, fill: catFill(2) },
    { key: 'commercialized', label: 'Commercialized', count: data.commercialized_count, share_pct: data.commercialized_share_pct, fill: catFill(3) },
    { key: 'on-hold', label: 'On Hold', count: data.on_hold_count, share_pct: data.on_hold_share_pct, fill: catFill(4) },
    { key: 'other', label: 'Other', count: data.other_statuses_count, share_pct: data.other_statuses_share_pct, fill: catFill(5) },
  ];
  return (
    <HeroDonut
      title="Status overview"
      testId="exec-status-donut"
      slices={slices}
      total={data.total_count}
      totalLabel="projects"
      info={
        <p>
          Every project in the current hub / country filter, by its project status. &quot;Other&quot; is the
          served remainder (every status without its own slice), so the slices add up to the served total.
          All counts and shares come from the API verbatim.
        </p>
      }
    />
  );
}

/** Stable colour per type (its place in the option order), so a slice keeps its
 *  colour whatever else is filtered. */
function typeFill(key: string): string {
  const i = (TYPE_FILTER_VALUES as readonly string[]).indexOf(key);
  return catFill(i === -1 ? TYPE_FILTER_VALUES.length : i);
}

export interface CrossFilterDonutProps {
  /** The served buckets of THIS dimension, fetched WITHOUT this dimension's own
   *  selection (cross-filter: the full distribution within the other filters). */
  buckets: AnalyticsBucket[];
  /** The served pipeline total for the same request basis (donut centre). */
  total: number;
  selected: readonly string[];
  onChange: (next: string[]) => void;
}

/**
 * P31 "Projects by type" (owner: "can this be done in pie chart instead and should
 * be dynamic based on different filterings"): the served `by_type` buckets as a
 * hero donut. Clicking a slice — or its legend toggle — adds or removes that type
 * from the Dashboard selection; selected slices stay full colour, the others dim.
 * The buckets are served for the hub / country and the CATEGORY selection only,
 * so the donut always shows every type to pick from (I9: counts and shares verbatim).
 */
export function TypeDonut({ buckets, total, selected, onChange }: CrossFilterDonutProps): React.JSX.Element {
  const slices: Slice[] = buckets.map((b) => ({
    key: b.key,
    label: typeLabel(b.key),
    count: b.count,
    share_pct: b.share_pct,
    fill: typeFill(b.key),
  }));
  return (
    <HeroDonut
      title="Projects by type"
      testId="exec-type-donut"
      slices={slices}
      total={total}
      totalLabel="projects"
      select={{ allowed: TYPE_FILTER_VALUES, selected, onChange, legendLabel: 'Filter the Dashboard by project type' }}
      info={
        <>
          <p>
            Pipeline projects of each type, with each type&apos;s served share. Click a slice or a type below
            to filter the whole Dashboard by it; pick several to combine them, and &quot;All&quot; to clear.
          </p>
          <p>
            This chart honours the hub / country and category filters but not the type filter itself, so every
            type stays visible. Counts, shares and the total are served by the API.
          </p>
        </>
      }
    />
  );
}

/** P31 "Projects by category": the served `by_category` buckets, the same way. */
export function CategoryDonut({ buckets, total, selected, onChange }: CrossFilterDonutProps): React.JSX.Element {
  const slices: Slice[] = buckets.map((b) => ({
    key: b.key,
    label: b.key,
    count: b.count,
    share_pct: b.share_pct,
    fill: catFill(categoryRank(b.key)),
  }));
  return (
    <HeroDonut
      title="Projects by category"
      testId="exec-category-donut"
      slices={slices}
      total={total}
      totalLabel="projects"
      select={{ allowed: CATEGORY_FILTER_VALUES, selected, onChange, legendLabel: 'Filter the Dashboard by category' }}
      info={
        <>
          <p>
            Pipeline projects of each category, with each category&apos;s served share. Click a slice or a
            category below to filter the whole Dashboard by it; pick several to combine them.
          </p>
          <p>
            This chart honours the hub / country and type filters but not the category filter itself. Counts,
            shares and the total are served by the API.
          </p>
        </>
      }
    />
  );
}

/* ------------------------- delivery by priority ---------------------------- */

/** Stack segments: each width is the band's SERVED `*_share_pct` field. */
const DELIVERY_SEGMENTS = [
  { key: 'in_flight', label: 'In flight', fill: 'hsl(var(--color-success))' },
  { key: 'not_started', label: 'Not started', fill: 'hsl(var(--color-success) / 0.35)' },
  { key: 'delivered', label: 'Delivered', fill: 'hsl(var(--color-primary))' },
  { key: 'other', label: 'Not in plan', fill: 'hsl(var(--color-border-strong))' },
] as const;

/**
 * One band's stacked bar: four segments whose CSS widths ARE the band's served
 * composition shares (`*_share_pct`, 2 dp, never a browser ratio). Plain
 * layout, not a measured chart surface, ON PURPOSE: the per-row Recharts
 * version intermittently skipped rows at narrow widths (its ResizeObserver
 * raced the grid), and the owner's 2026-10-22 correction #3 made layout
 * robustness the priority — every band must always draw, with its numbers in
 * a fixed column beside it.
 */
function BandBar({ band }: { band: PriorityDeliveryBand }): React.JSX.Element {
  const shares: Record<(typeof DELIVERY_SEGMENTS)[number]['key'], number> = {
    in_flight: band.in_flight_share_pct,
    not_started: band.not_started_share_pct,
    delivered: band.delivered_share_pct,
    other: band.other_share_pct,
  };
  return (
    <span className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken">
      {DELIVERY_SEGMENTS.map((seg) => {
        const pct = shares[seg.key];
        if (pct <= 0) return null;
        return (
          <span
            key={seg.key}
            className="block h-full"
            style={{ width: `${String(Math.min(100, pct))}%`, background: seg.fill }}
            data-segment={seg.key}
            data-served-share={pct}
          />
        );
      })}
    </span>
  );
}

/**
 * Executive "Delivery by priority" (ADR 0039 §3, owner corrections 2 + 3):
 * one row per served band, laid out as a grid — `[band] [stacked bar 1fr]
 * [numbers auto]` — so every band ALWAYS shows its numbers in its own
 * right-hand column. The stacked bar is Recharts; its segment widths are the
 * band's served composition shares (`in_flight_share_pct`,
 * `not_started_share_pct`, `delivered_share_pct`, `other_share_pct` — served
 * 2 dp figures, never a browser ratio), and the numbers column prints the
 * served counts verbatim: `within_year/total · within_year_share_pct`.
 */
export function PriorityDeliveryChart({ bands }: { bands: PriorityDeliveryBand[] }): React.JSX.Element {
  const shown = bands.filter((b) => b.total > 0);
  return (
    <ChartCard
      title="Delivery by priority"
      testId="exec-priority-delivery"
      info={
        <p>
          One bar per priority band. Segment widths are the band&apos;s served composition shares — solid
          green in flight, light green not started, blue already delivered, grey not in plan — and the
          numbers beside each bar are the served count finishing within the year out of the band&apos;s
          served total, with the served within-year share. Nothing is recomputed in the browser; the full
          six-way split is on the Detailed view.
        </p>
      }
    >
      {shown.length === 0 ? (
        <p className="text-xs text-text-muted">No prioritised projects in this run.</p>
      ) : (
        <>
          <div className="my-auto flex flex-col gap-s2" aria-hidden="true">
            {shown.map((b) => (
              <div
                key={b.priority}
                className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-s2"
                data-testid={`exec-priority-band-${b.priority}`}
              >
                <span className="text-xs font-bold text-text">{b.priority}</span>
                <span className="min-w-0">
                  <BandBar band={b} />
                </span>
                <span className="whitespace-nowrap text-right text-2xs font-semibold tabular-nums text-text" data-numeric="">
                  {formatInteger(b.within_year)}/{formatInteger(b.total)} · {formatServedPct(b.within_year_share_pct)}
                </span>
              </div>
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-s3 gap-y-0.5 text-[0.6rem] font-semibold text-text-muted" aria-hidden="true">
            {DELIVERY_SEGMENTS.map((seg) => (
              <li key={seg.key} className="flex items-center gap-1">
                <span className="size-2 rounded-sm" style={{ background: seg.fill }} />
                {seg.label}
              </li>
            ))}
          </ul>
          {/* The data, readable: one line per band with the served counts/shares. */}
          <ul className="sr-only" aria-label="Delivery by priority band">
            {shown.map((b) => (
              <li key={b.priority}>
                {b.priority}: {formatInteger(b.within_year)} of {formatInteger(b.total)} within the year (
                {formatServedPct(b.within_year_share_pct)}); in flight {formatServedPct(b.in_flight_share_pct)},
                not started {formatServedPct(b.not_started_share_pct)}, delivered{' '}
                {formatServedPct(b.delivered_share_pct)}, not in plan {formatServedPct(b.other_share_pct)}.
              </li>
            ))}
          </ul>
        </>
      )}
    </ChartCard>
  );
}
