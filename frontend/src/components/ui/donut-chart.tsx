import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatInteger } from '@/lib/format';

/**
 * Donut, for PART-TO-WHOLE only.
 *
 * The rules from the chart theme, enforced here rather than left to the caller:
 *
 *  - Six segments maximum. Beyond that the arcs get too small to compare and the
 *    chart becomes a legend with decoration attached. Anything past the sixth is
 *    folded into an explicit "Other" slice, which is honest; silently dropping it
 *    is not, and neither is inventing a seventh colour.
 *  - A centre total, always. It is the number people actually read, and without it
 *    a donut asks the viewer to mentally sum the arcs.
 *  - Segments are ordered by value, largest first, so the ramp runs dark→light
 *    clockwise from 12 o'clock and the ranking is visible before the legend is read.
 *  - Never colour alone: the legend pairs every swatch with a label AND its figure,
 *    and the whole chart is exposed to assistive tech as a definition list.
 *
 * Drawn with `stroke-dasharray` on a single circle per segment rather than SVG path
 * arcs — no trigonometry, no arc-flag edge case at 50%, and no charting dependency.
 */

const SEGMENT_FILL = [
  'stroke-chart-1',
  'stroke-chart-2',
  'stroke-chart-3',
  'stroke-chart-4',
  'stroke-chart-5',
  'stroke-chart-6',
];

const SWATCH_FILL = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
];

const MAX_SEGMENTS = 6;

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
}

export interface DonutChartProps {
  data: readonly DonutSlice[];
  /** Word under the centre figure, e.g. "projects". */
  totalLabel: string;
  /** Accessible name for the chart. */
  ariaLabel: string;
  className?: string;
}

export function DonutChart({
  data,
  totalLabel,
  ariaLabel,
  className,
}: DonutChartProps): React.JSX.Element {
  const { slices, total } = React.useMemo(() => {
    const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
    const sum = sorted.reduce((acc, d) => acc + d.value, 0);

    if (sorted.length <= MAX_SEGMENTS) return { slices: sorted, total: sum };

    // Fold the tail into an explicit "Other" rather than dropping it or inventing
    // a seventh ramp step. The total stays correct either way, which is the point.
    const head = sorted.slice(0, MAX_SEGMENTS - 1);
    const tail = sorted.slice(MAX_SEGMENTS - 1);
    return {
      slices: [
        ...head,
        {
          key: '__other__',
          label: `Other (${String(tail.length)})`,
          value: tail.reduce((acc, d) => acc + d.value, 0),
        },
      ],
      total: sum,
    };
  }, [data]);

  // Geometry. Every offset below is a fraction of the circumference, so the maths
  // stays in one place.
  const R = 42;
  const CIRC = 2 * Math.PI * R;

  /**
   * Cumulative arc offsets, precomputed.
   *
   * The obvious implementation accumulates a `let offset` inside the JSX map. React
   * Compiler rejects that — and is right to: a variable mutated while rendering is
   * not safe to memoize, and the arcs would silently stack wrong if the component
   * ever re-rendered partially. Building the array up front is both correct and
   * memoizable.
   */
  const arcs = React.useMemo(() => {
    const fractions = slices.map((slice) => (total === 0 ? 0 : slice.value / total));
    return slices.map((slice, i) => {
      // Cumulative sum of everything before this slice. O(n^2), which is irrelevant
      // at n <= 6 and buys a genuinely pure expression — no accumulator to reassign.
      const before = fractions.slice(0, i).reduce((acc, f) => acc + f, 0);
      return {
        slice,
        dash: fractions[i] * CIRC,
        dashOffset: -before * CIRC,
      };
    });
  }, [slices, total, CIRC]);

  if (total === 0) {
    return (
      <div
        className={cn('grid place-items-center py-s6 text-body text-text-subtle', className)}
        role="img"
        aria-label={`${ariaLabel}: no data`}
      >
        No data to chart
      </div>
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-s6', className)}>
      <div className="relative shrink-0">
        <svg viewBox="0 0 100 100" className="size-40 -rotate-90" role="img" aria-label={ariaLabel}>
          {/* Track, so a donut of one small slice still reads as a ring. */}
          <circle cx="50" cy="50" r={R} fill="none" className="stroke-surface-sunken" strokeWidth={14} />
          {arcs.map(({ slice, dash, dashOffset }, i) => {
            return (
              <circle
                key={slice.key}
                cx="50"
                cy="50"
                r={R}
                fill="none"
                strokeWidth={14}
                // A round cap on a segment overlaps its neighbour and misreports the
                // proportion; butt is the only honest cap on a stacked ring.
                strokeLinecap="butt"
                strokeDasharray={`${dash.toFixed(3)} ${(CIRC - dash).toFixed(3)}`}
                strokeDashoffset={dashOffset.toFixed(3)}
                className={cn(SEGMENT_FILL[Math.min(i, SEGMENT_FILL.length - 1)])}
              />
            );
          })}
        </svg>

        {/* The centre total. `pointer-events-none` so it never eats a hover meant for
            a segment. */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="text-center">
            <span
              className="block font-display text-h1 leading-none tabular-nums text-text"
              data-numeric=""
            >
              {formatInteger(total)}
            </span>
            <span className="label-caps mt-1 block text-text-subtle">{totalLabel}</span>
          </span>
        </div>
      </div>

      <dl className="min-w-0 flex-1 space-y-s2">
        {slices.map((slice, i) => (
          <div key={slice.key} className="flex items-center gap-s3">
            <span
              aria-hidden="true"
              className={cn(
                'size-2.5 shrink-0 rounded-sm',
                SWATCH_FILL[Math.min(i, SWATCH_FILL.length - 1)],
              )}
            />
            <dt className="min-w-0 flex-1 truncate text-body text-text-muted">{slice.label}</dt>
            <dd className="font-mono text-figure font-semibold tabular-nums text-text" data-numeric="">
              {formatInteger(slice.value)}
            </dd>
            <dd className="w-10 text-right text-2xs tabular-nums text-text-subtle">
              {Math.round((slice.value / total) * 100)}%
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
