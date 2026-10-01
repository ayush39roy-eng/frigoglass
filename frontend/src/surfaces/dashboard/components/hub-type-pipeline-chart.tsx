import * as React from 'react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { HubTypePipelineRow } from '../api/types';
import { assignDashSeriesColors } from '../lib/dash-chart-theme';

/**
 * Custom-skinned Recharts view of the SAME `GET /dashboard/hub-type-pipeline`
 * rows `<HubTypePipelineTable>` pivots into its table — the "Top Products"
 * reference-dashboard panel repurposed onto real data ("top project categories
 * by count per hub"), per this task's explicit mapping. No number here is
 * computed independently of that response: `perHubByType` is the same
 * (hub, type) → count grouping the table already performs for its own cells.
 *
 * RESTYLED 2026-10-01 to the Boltshift "hatch-highlight bar chart" pattern
 * (spec §5): inactive bars render a soft gradient fill of the Dashboard's own
 * 10-hue ramp (`assignDashSeriesColors`, Dashboard-only — see that file's doc
 * comment for why it does not touch the sitewide `--chart-1..6` ramp); the
 * hovered bar swaps to a 45° diagonal SVG hatch of the same hue plus a small
 * floating dot on top (Recharts' `activeBar` shape, triggered on hover with no
 * extra state management); the tooltip is a floating WHITE card (not the
 * sitewide dark-navy `rechartsTheme()` tooltip Capacity/Matrix's own charts
 * still use, out of scope this task); gridlines are faint and DASHED, no axis
 * lines, per spec §5.
 */

const UNTYPED = '—' as const;

interface ChartDatum {
  hub: string;
  [type: string]: string | number;
}

export interface HubTypePipelineChartProps {
  rows: HubTypePipelineRow[];
}

function hatchId(type: string): string {
  return `dash-hatch-${type.replace(/[^a-zA-Z0-9]/g, '')}`;
}

function gradientId(type: string): string {
  return `dash-grad-${type.replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** The hovered bar: a 45° diagonal hatch of the series colour + a floating dot.
 *  Rendered as a ReactElement (not a function) passed to Recharts' `activeBar` —
 *  Recharts clones it with the bar's own computed `x`/`y`/`width`/`height`, which
 *  keeps this component's own props simply optional rather than fighting
 *  Recharts' `BarShapeProps` type (which has no index signature) under this
 *  project's `exactOptionalPropertyTypes`. */
function ActiveHatchBar(
  props: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    type: string;
    color: string;
  },
): React.JSX.Element | null {
  const { x, y, width, height, type, color } = props;
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return null;
  }
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={10} ry={10} fill={`url(#${hatchId(type)})`} />
      <circle cx={x + width / 2} cy={y} r={4} fill={color} />
    </g>
  );
}

export function HubTypePipelineChart({ rows }: HubTypePipelineChartProps): React.JSX.Element | null {
  const reducedMotion = usePrefersReducedMotion();

  const { data, types, colorByType } = React.useMemo(() => {
    const hubOrder: string[] = [];
    const typeTotals = new Map<string, number>();
    const byHub = new Map<string, ChartDatum>();

    for (const row of rows) {
      const typeKey = row.type ? (PROJECT_TYPE_LABELS[row.type] ?? row.type) : UNTYPED;
      if (!hubOrder.includes(row.hub)) hubOrder.push(row.hub);
      typeTotals.set(typeKey, (typeTotals.get(typeKey) ?? 0) + row.count);

      const datum = byHub.get(row.hub) ?? { hub: row.hub };
      datum[typeKey] = (Number(datum[typeKey]) || 0) + row.count;
      byHub.set(row.hub, datum);
    }

    const typeKeys = [...typeTotals.keys()];
    // Colour assigned BY VALUE (each type's total across every hub), never by
    // array position — same rule as the sitewide ramp, so the largest category
    // is always the most saturated regardless of which hub lists it first.
    const colors = assignDashSeriesColors(typeKeys.map((t) => typeTotals.get(t) ?? 0));
    const colorMap = new Map(typeKeys.map((t, i) => [t, colors[i] ?? colors[colors.length - 1]]));

    return {
      data: hubOrder.map((hub) => byHub.get(hub)).filter((d): d is ChartDatum => d !== undefined),
      types: typeKeys,
      colorByType: colorMap,
    };
  }, [rows]);

  const totalByHub = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const datum of data) {
      let sum = 0;
      for (const type of types) sum += Number(datum[type]) || 0;
      totals.set(datum.hub, sum);
    }
    return totals;
  }, [data, types]);

  if (data.length === 0) return null;

  return (
    <figure aria-label="Project count per hub, split by project type" className="w-full">
      <ResponsiveContainer width="100%" height={220}>
        <RechartsBarChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
          <defs>
            {types.map((type) => {
              const color = colorByType.get(type) ?? 'currentColor';
              return (
                <React.Fragment key={type}>
                  <linearGradient id={gradientId(type)} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.55} />
                  </linearGradient>
                  <pattern
                    id={hatchId(type)}
                    patternUnits="userSpaceOnUse"
                    width="6"
                    height="6"
                    patternTransform="rotate(45)"
                  >
                    <rect width="6" height="6" fill={color} />
                    <line x1="0" y1="0" x2="0" y2="6" stroke="white" strokeOpacity={0.4} strokeWidth={2.5} />
                  </pattern>
                </React.Fragment>
              );
            })}
          </defs>
          <CartesianGrid
            stroke="hsl(var(--color-dash-hairline))"
            strokeDasharray="4 4"
            horizontal
            vertical={false}
          />
          <XAxis
            dataKey="hub"
            stroke="hsl(var(--color-dash-hairline))"
            tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            stroke="hsl(var(--color-dash-hairline))"
            tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--color-dash-alt))' }}
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
          {types.map((type, index) => (
            <Bar
              key={type}
              dataKey={type}
              name={type}
              fill={`url(#${gradientId(type)})`}
              radius={[10, 10, 2, 2]}
              isAnimationActive={!reducedMotion}
              animationBegin={index * 40}
              animationDuration={700}
              animationEasing="ease-out"
              activeBar={<ActiveHatchBar type={type} color={colorByType.get(type) ?? 'currentColor'} />}
            />
          ))}
        </RechartsBarChart>
      </ResponsiveContainer>

      {/* Accessible fallback — the SAME grouping the bars draw, as real text.
          A `<dl>`, not a `<table>`: `HubTypePipelineTable` already renders a
          REAL, visible `<table>` with `role="row"`/`role="columnheader"`
          semantics right next to this chart (same card) — a second,
          sr-only `<table>` with rows named after the same hubs would collide
          with it under an unscoped `getByRole('row', ...)` query. A
          definition list is also this codebase's own established pattern for
          an accessible chart summary (see `bar-chart.tsx`/`donut-chart.tsx`'s
          doc comments). */}
      <dl className="sr-only">
        <dt>Project count per hub, split by project type</dt>
        {data.map((datum) => (
          <dd key={datum.hub}>
            {datum.hub}:{' '}
            {types
              .map((type) => `${type} ${String(Number(datum[type]) || 0)}`)
              .join(', ')}
            , total {totalByHub.get(datum.hub) ?? 0}
          </dd>
        ))}
      </dl>
    </figure>
  );
}
