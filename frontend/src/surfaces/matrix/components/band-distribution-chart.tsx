import * as React from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { ProjectPriority } from '@/types/enums';

/**
 * Computed-band distribution across scored projects — a scannability aid only.
 * The authoritative counts live in the adjacent table in
 * `<PortfolioSummaryPanel>`; this chart plots the exact same
 * `summary.suggested_band_counts` values (no derivation). Recharts (stack lib),
 * loaded in the lazy `/matrix` route chunk.
 */

const BAND_COLOR: Record<ProjectPriority, string> = {
  P1: 'hsl(var(--color-band-p1))',
  P2: 'hsl(var(--color-band-p2))',
  P3: 'hsl(var(--color-band-p3))',
  P4: 'hsl(var(--color-band-p4))',
  Q: 'hsl(var(--color-band-q))',
};

export interface BandDatum {
  band: string;
  count: number;
}

export function BandDistributionChart({ data }: { data: BandDatum[] }): React.JSX.Element {
  return (
    <figure className="w-full" aria-label="Number of scored projects in each computed priority band">
      <ResponsiveContainer width="100%" height={Math.max(140, data.length * 40 + 32)}>
        <BarChart layout="vertical" data={data} margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fill: 'hsl(var(--color-text-muted))', fontSize: 11 }}
            stroke="hsl(var(--color-border))"
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="band"
            width={40}
            tick={{ fill: 'hsl(var(--color-text-muted))', fontSize: 11 }}
            stroke="hsl(var(--color-border))"
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
          <Bar dataKey="count" name="Scored projects" radius={2}>
            {data.map((d) => (
              <Cell key={d.band} fill={BAND_COLOR[d.band as ProjectPriority] ?? 'hsl(var(--color-band-q))'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
