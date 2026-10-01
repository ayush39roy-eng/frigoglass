import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatInteger } from '@/lib/format';

/**
 * Tiny presentational horizontal bar chart — CSS widths only, no charting
 * library (keeps the Dashboard route inside the 400 KB initial budget). Built for
 * the Dashboard (P4-T02); promoted to `components/ui` in P9-T04 so the Capacity
 * surface's client breakdown (ADR 0008) draws with the same primitive and the
 * same chart tokens (`src/lib/chart-theme.ts` ramp) instead of Recharts.
 *
 * Accessibility: every bar carries its numeric value as visible text next to a
 * text label — colour is a secondary cue, never the only one. The whole chart is
 * also exposed as a plain definition list to assistive tech.
 */

export type BarTone = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

const TONE_BAR: Record<BarTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-text-subtle',
};

/**
 * Rank-ordered ramp for the default (untoned) case. The largest bar is the darkest,
 * so the ranking is readable before the labels are — see assignSeriesColors() in
 * src/lib/chart-theme.ts for the reasoning. A bar with an explicit `tone` opts out,
 * because there the colour is carrying a STATUS and must not be reassigned by size.
 */
const RANK_BAR = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5', 'bg-chart-6'];

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  tone?: BarTone;
  /** Optional extra context shown under the label. */
  hint?: string;
}

export interface BarChartProps {
  data: BarDatum[];
  /** Fixed max for the axis; defaults to the largest value in `data`. */
  max?: number;
  className?: string;
  /** Accessible name for the chart region. */
  ariaLabel: string;
  /** Value formatter — defaults to an integer. Pass `formatDecimal` for
   *  fractional figures so the label matches the figure shown elsewhere. */
  formatValue?: (value: number) => string;
}

export function BarChart({
  data,
  max,
  className,
  ariaLabel,
  formatValue = formatInteger,
}: BarChartProps): React.JSX.Element {
  const axisMax = Math.max(max ?? 0, ...data.map((d) => d.value), 1);

  // Rank by value once, so an untoned bar can pick its ramp step from its position
  // in the ranking rather than from its position in the array.
  const rankByKey = new Map(
    [...data]
      .sort((a, b) => b.value - a.value)
      .map((datum, rank) => [datum.key, Math.min(rank, RANK_BAR.length - 1)] as const),
  );

  return (
    <dl className={cn('flex flex-col gap-s2', className)} aria-label={ariaLabel}>
      {data.map((datum, index) => {
        const pct = Math.round((datum.value / axisMax) * 100);
        const fill = datum.tone
          ? TONE_BAR[datum.tone]
          : RANK_BAR[rankByKey.get(datum.key) ?? RANK_BAR.length - 1];

        return (
          <div
            key={datum.key}
            className="group grid grid-cols-[10rem_1fr_auto] items-center gap-s3 rounded-xl px-s3 py-1.5 transition-colors duration-fast hover:bg-primary-subtle/40"
          >
            <dt className="min-w-0">
              <span className="block truncate text-body font-semibold text-text">{datum.label}</span>
              {datum.hint ? (
                <span className="block truncate text-2xs text-text-subtle">{datum.hint}</span>
              ) : null}
            </dt>
            {/* Track + fill are both pill-radius and the track is always visible, so a
                near-zero bar still reads as "measured and small" rather than as
                missing data — the failure mode of a track-less bar chart. */}
            <dd className="h-3.5 overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
              <div
                className={cn(
                  'relative h-full origin-left animate-grow-x rounded-pill transition-[width] duration-slow ease-ease-out-expo',
                  'after:absolute after:inset-x-0 after:top-0 after:h-1/2 after:rounded-pill after:bg-white/20',
                  fill,
                )}
                style={{ width: `${String(pct)}%`, animationDelay: `${String(index * 70)}ms` }}
              />
            </dd>
            <dd
              className="w-14 text-right font-display text-base font-extrabold tabular-nums text-text"
              data-numeric=""
            >
              {formatValue(datum.value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
