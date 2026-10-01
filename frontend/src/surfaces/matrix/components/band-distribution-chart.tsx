import * as React from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { ProjectPriority } from '@/types/enums';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';

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

export function BandDistributionChart({
  data,
  ariaLabel = 'Number of scored projects in each computed priority band',
  name = 'Scored projects',
}: {
  data: BandDatum[];
  ariaLabel?: string;
  name?: string;
}): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  return (
    <figure className="w-full" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height={Math.max(150, data.length * 42 + 24)}>
        <BarChart layout="vertical" data={data} margin={{ top: 4, right: 36, bottom: 4, left: 0 }}>
          <defs>
            {data.map((d) => {
              const color = BAND_COLOR[d.band as ProjectPriority] ?? 'hsl(var(--color-band-q))';
              return (
                <linearGradient key={d.band} id={`band-grad-${d.band}`} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={color} stopOpacity={0.7} />
                  <stop offset="100%" stopColor={color} stopOpacity={1} />
                </linearGradient>
              );
            })}
          </defs>
          <XAxis type="number" allowDecimals={false} hide />
          <YAxis
            type="category"
            dataKey="band"
            width={36}
            tick={{ fill: 'hsl(var(--color-text))', fontSize: 12, fontWeight: 700 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--color-primary) / 0.06)' }}
            contentStyle={{
              background: 'hsl(var(--color-surface))',
              border: '1.5px solid hsl(var(--color-border))',
              borderRadius: 12,
              fontSize: 12,
              fontWeight: 600,
              boxShadow: 'var(--shadow-pop)',
            }}
          />
          <Bar
            dataKey="count"
            name={name}
            radius={[0, 999, 999, 0]}
            barSize={18}
            background={{ fill: 'hsl(var(--color-surface-sunken))', radius: 999 }}
            isAnimationActive={!reduced}
            animationDuration={900}
            label={{ position: 'right', fill: 'hsl(var(--color-text))', fontSize: 12, fontWeight: 800 }}
          >
            {data.map((d) => (
              <Cell key={d.band} fill={`url(#band-grad-${d.band})`} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
