import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';

import type { ClassBreakdownRow } from '../api/types';

/**
 * A+/A/B/C deliverable vs. left-out counts from the active schedule run's
 * outcomes, as a stacked bar per category. Visual aid only — the verbatim
 * counts are in the table in `<ClassBreakdownPanel>`, right above this chart,
 * which is also why this chart carries no second accessible-fallback
 * structure of its own (a `<dl>` here would duplicate the real, visible
 * `<table>` it sits beside — same reasoning the Dashboard's hatch chart gives
 * for the cases where it DOES need one and this one does not).
 *
 * RESTYLED 2026-10-01 (Capacity Boltshift reskin) to the same custom-skinned-
 * Recharts language as the Dashboard's hatch-highlight chart: dashed Y
 * gridlines only, no axis lines, a floating white tooltip card, gradient
 * fills, rounded bar tops. Colour stays SEMANTIC (success = deliverable,
 * warning = left out) rather than switching to the categorical palette —
 * deliverable/left-out is a status pair, not a ranked category series, the
 * same distinction `StatCard`'s `tone` prop preserves elsewhere on this
 * surface's restyle.
 */

const COLOR = {
  deliverable: 'hsl(var(--color-success))',
  leftOut: 'hsl(var(--color-warning))',
};

export interface ClassBreakdownChartProps {
  rows: ClassBreakdownRow[];
}

export function ClassBreakdownChart({ rows }: ClassBreakdownChartProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const data = rows.map((r) => ({
    category: r.category,
    Deliverable: r.deliverable_count,
    'Left out': r.left_out_count,
  }));

  return (
    <figure className="w-full" aria-label="Deliverable versus left-out project counts by category">
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <defs>
            <linearGradient id="class-breakdown-deliverable" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR.deliverable} stopOpacity={0.95} />
              <stop offset="100%" stopColor={COLOR.deliverable} stopOpacity={0.6} />
            </linearGradient>
            <linearGradient id="class-breakdown-left-out" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOR.leftOut} stopOpacity={0.95} />
              <stop offset="100%" stopColor={COLOR.leftOut} stopOpacity={0.6} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="hsl(var(--color-dash-hairline))"
            strokeDasharray="4 4"
            horizontal
            vertical={false}
          />
          <XAxis
            dataKey="category"
            tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11, fontWeight: 600 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11, fontWeight: 600 }}
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
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="Deliverable"
            stackId="c"
            fill="url(#class-breakdown-deliverable)"
            radius={[0, 0, 0, 0]}
            isAnimationActive={!reducedMotion}
          />
          <Bar
            dataKey="Left out"
            stackId="c"
            fill="url(#class-breakdown-left-out)"
            radius={[8, 8, 0, 0]}
            isAnimationActive={!reducedMotion}
          />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
