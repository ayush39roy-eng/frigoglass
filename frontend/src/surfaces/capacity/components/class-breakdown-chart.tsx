import * as React from 'react';
import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { ClassBreakdownRow } from '../api/types';

/**
 * A+/A/B/C deliverable vs. left-out counts from the active schedule run's
 * outcomes, as a stacked bar per category. Visual aid only — the verbatim
 * counts are in the table in `<ClassBreakdownPanel>`.
 */

const COLOR = {
  deliverable: 'hsl(var(--color-success))',
  leftOut: 'hsl(var(--color-warning))',
  grid: 'hsl(var(--color-border))',
  axis: 'hsl(var(--color-text-muted))',
};

export interface ClassBreakdownChartProps {
  rows: ClassBreakdownRow[];
}

export function ClassBreakdownChart({ rows }: ClassBreakdownChartProps): React.JSX.Element {
  const data = rows.map((r) => ({
    category: r.category,
    Deliverable: r.deliverable_count,
    'Left out': r.left_out_count,
  }));

  return (
    <figure className="w-full" aria-label="Deliverable versus left-out project counts by category">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <XAxis
            dataKey="category"
            tick={{ fill: COLOR.axis, fontSize: 11 }}
            stroke={COLOR.grid}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: COLOR.axis, fontSize: 11 }}
            stroke={COLOR.grid}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--color-surface-sunken))' }}
            contentStyle={{
              background: 'hsl(var(--color-surface))',
              border: '1px solid hsl(var(--color-border))',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Deliverable" stackId="c" fill={COLOR.deliverable} radius={[0, 0, 0, 0]} />
          <Bar dataKey="Left out" stackId="c" fill={COLOR.leftOut} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
