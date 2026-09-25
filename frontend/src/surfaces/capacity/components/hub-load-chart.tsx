import * as React from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { HubCapacityRow } from '../api/types';

/**
 * Load vs. reporting-capacity per hub — one grouped bar chart per resource kind
 * (`design` = engineer-weeks, `lab` = chamber-units), since the two use
 * different units and scales.
 *
 * Visual aid only. The authoritative, verbatim figures live in the table in
 * `<HubLoadPanel>`; this just makes the load/capacity gap scannable. The load
 * bar turns amber when it exceeds the reporting-capacity estimate — that is a
 * planning signal, NOT a statement that the scheduler overbooked (ADR 0002 /
 * 0003; see `<CapacityReportingNotice>`).
 */

const COLOR = {
  loadOk: 'hsl(var(--color-primary))',
  loadOver: 'hsl(var(--color-warning))',
  capacity: 'hsl(var(--color-text-subtle))',
  grid: 'hsl(var(--color-border))',
  axis: 'hsl(var(--color-text-muted))',
};

export interface HubLoadChartProps {
  rows: HubCapacityRow[];
  metric: 'design' | 'lab';
}

interface Datum {
  hub: string;
  load: number;
  capacity: number;
  over: boolean;
}

export function HubLoadChart({ rows, metric }: HubLoadChartProps): React.JSX.Element {
  const unit = metric === 'design' ? 'engineer-weeks' : 'chamber-units';
  const data: Datum[] = rows.map((r) => {
    const load = metric === 'design' ? r.design_load_weeks : r.lab_load_units;
    const capacity = metric === 'design' ? r.design_capacity_weeks : r.lab_capacity_units;
    return { hub: r.hub, load, capacity, over: load > capacity };
  });

  return (
    <figure
      className="w-full"
      aria-label={`${metric === 'design' ? 'Design' : 'Lab'} load versus reporting capacity per hub, in ${unit}`}
    >
      <ResponsiveContainer width="100%" height={Math.max(160, data.length * 44 + 48)}>
        <BarChart layout="vertical" data={data} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <XAxis
            type="number"
            tick={{ fill: COLOR.axis, fontSize: 11 }}
            stroke={COLOR.grid}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="hub"
            width={92}
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
          <Bar dataKey="capacity" name="Reporting capacity" fill={COLOR.capacity} radius={2} />
          <Bar dataKey="load" name="Scheduled load" radius={2}>
            {data.map((d) => (
              <Cell key={d.hub} fill={d.over ? COLOR.loadOver : COLOR.loadOk} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
