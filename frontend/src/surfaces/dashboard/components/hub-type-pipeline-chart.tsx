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

import { assignSeriesColors, rechartsTheme } from '@/lib/chart-theme';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { HubTypePipelineRow } from '../api/types';

/**
 * Custom-skinned Recharts view of the SAME `GET /dashboard/hub-type-pipeline`
 * rows `<HubTypePipelineTable>` pivots into its table — the "Top Products"
 * reference-dashboard panel repurposed onto real data ("top project categories
 * by count per hub"), per this task's explicit mapping. No number here is
 * computed independently of that response: `perHubByType` is the same
 * (hub, type) → count grouping the table already performs for its own cells.
 *
 * "Custom-skinned, not default styling": gradient fills (not flat Recharts
 * defaults), pill-radius bar caps matching `BarChart`'s hand-rolled sibling,
 * and the shared `rechartsTheme()`/`chart-theme.ts` tokens — the same theme
 * every other Recharts chart in the app (Capacity's `ClassBreakdownChart`,
 * Matrix's `BandDistributionChart`) already draws from, so this is one more
 * consumer of the existing theme, not a new one.
 */

const UNTYPED = '—' as const;

interface ChartDatum {
  hub: string;
  [type: string]: string | number;
}

export interface HubTypePipelineChartProps {
  rows: HubTypePipelineRow[];
}

export function HubTypePipelineChart({ rows }: HubTypePipelineChartProps): React.JSX.Element | null {
  const reducedMotion = usePrefersReducedMotion();

  const { data, types, colorByType, totalByHub } = React.useMemo(() => {
    const hubOrder: string[] = [];
    const typeTotals = new Map<string, number>();
    const byHub = new Map<string, ChartDatum>();
    const hubTotals = new Map<string, number>();

    for (const row of rows) {
      const typeKey = row.type ? (PROJECT_TYPE_LABELS[row.type] ?? row.type) : UNTYPED;
      if (!hubOrder.includes(row.hub)) hubOrder.push(row.hub);
      typeTotals.set(typeKey, (typeTotals.get(typeKey) ?? 0) + row.count);
      hubTotals.set(row.hub, (hubTotals.get(row.hub) ?? 0) + row.count);

      const datum = byHub.get(row.hub) ?? { hub: row.hub };
      datum[typeKey] = (Number(datum[typeKey]) || 0) + row.count;
      byHub.set(row.hub, datum);
    }

    const typeKeys = [...typeTotals.keys()];
    // Colour assigned BY VALUE (each type's total across every hub), never by
    // array position — chart-theme.ts's rule, so the largest category is
    // always the darkest regardless of which hub happens to list it first.
    const colors = assignSeriesColors(typeKeys.map((t) => typeTotals.get(t) ?? 0));
    const colorMap = new Map(typeKeys.map((t, i) => [t, colors[i] ?? colors[colors.length - 1]]));

    return {
      data: hubOrder.map((hub) => byHub.get(hub)).filter((d): d is ChartDatum => d !== undefined),
      types: typeKeys,
      colorByType: colorMap,
      totalByHub: hubTotals,
    };
  }, [rows]);

  if (data.length === 0) return null;

  const theme = rechartsTheme();

  return (
    <figure aria-label="Project count per hub, split by project type" className="w-full">
      <ResponsiveContainer width="100%" height={220}>
        <RechartsBarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <defs>
            {types.map((type) => {
              const color = colorByType.get(type) ?? 'currentColor';
              const id = `hub-type-gradient-${type.replace(/[^a-zA-Z0-9]/g, '')}`;
              return (
                <linearGradient key={type} id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.45} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid {...theme.cartesianGrid} />
          <XAxis dataKey="hub" {...theme.xAxis} />
          <YAxis allowDecimals={false} {...theme.yAxis} />
          <Tooltip
            cursor={theme.tooltip.cursor}
            contentStyle={theme.tooltip.contentStyle}
            isAnimationActive={!reducedMotion}
          />
          {types.map((type) => {
            const id = `hub-type-gradient-${type.replace(/[^a-zA-Z0-9]/g, '')}`;
            return (
              <Bar
                key={type}
                dataKey={type}
                name={type}
                fill={`url(#${id})`}
                radius={[6, 6, 2, 2]}
                isAnimationActive={!reducedMotion}
                animationDuration={700}
                animationEasing="ease-out"
              />
            );
          })}
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
