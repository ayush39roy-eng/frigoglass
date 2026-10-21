import * as React from 'react';

import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { PriorityLoadSplit } from '../api/types';
import { BUCKET_BG, BUCKET_SHORT, PRIORITY_BUCKETS } from '../lib/priority-split';

/**
 * P13-T11: "Design / Lab load vs capacity" as one stacked column per hub (or lab
 * region): the served per-priority load segments (P1 → Queue, bottom to top)
 * inside a dashed outline at the served capacity. Hand-built with CSS heights,
 * like `components/ui/bar-chart.tsx` — no charting library, chart tokens only.
 *
 * Every segment is one served `*_load_by_priority` value; the label on top of a
 * column is the served `*_load_weeks` (which the buckets sum to, server-side).
 * The only arithmetic here is the pixel scale (value / axis max), which is
 * presentation, not a figure. The visible figures are also exposed as a table
 * to assistive tech, so colour is never the only carrier.
 */
export interface PriorityLoadBar {
  key: string;
  label: string;
  /** Optional second line under the label, e.g. the hubs of a lab region. */
  sublabel?: string;
  split: PriorityLoadSplit;
  /** The served total load (`design_load_weeks` / `lab_load_weeks`). */
  load: number;
  /** The served capacity for the selected horizon. */
  capacity: number;
}

export interface PriorityLoadChartProps {
  bars: PriorityLoadBar[];
  /** Accessible name for the chart, e.g. "Design load vs capacity by hub". */
  ariaLabel: string;
  unit: string;
  capacityLabel: string;
}

function pct(value: number, max: number): string {
  if (max <= 0 || value <= 0) return '0%';
  return `${String(Math.min(100, (value / max) * 100))}%`;
}

/** Display scale only (not a figure): a round axis step so gridlines land on nice values. */
function axisScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / 4;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * exp).find((c) => c >= raw) ?? 10 * exp);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { top, ticks };
}

const PLOT_INSET = 'absolute inset-x-0 bottom-0 top-5';

export function PriorityLoadChart({ bars, ariaLabel, unit, capacityLabel }: PriorityLoadChartProps): React.JSX.Element {
  // Display scale only: the tallest load or capacity outline sets the axis.
  const { top: max, ticks } = axisScale(bars.reduce((m, b) => Math.max(m, b.load, b.capacity), 0));
  const captionId = React.useId();

  return (
    <figure className="flex flex-col gap-s3" aria-labelledby={captionId} data-testid="priority-load-chart">
      <figcaption id={captionId} className="sr-only">
        {ariaLabel}, in {unit}
      </figcaption>

      <ul className="flex flex-wrap items-center justify-center gap-x-s3 gap-y-1 text-2xs text-text-muted" aria-hidden="true">
        <li className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm border-[1.5px] border-text-muted" />
          {capacityLabel}
        </li>
        {PRIORITY_BUCKETS.map((b) => (
          <li key={b} className="flex items-center gap-1">
            <span className={cn('inline-block size-2.5 rounded-sm', BUCKET_BG[b])} />
            {b === 'Queue' ? 'Queue' : b}
          </li>
        ))}
      </ul>

      {/* Narrow screens: the columns keep a readable width and the plot scrolls
          sideways inside a focusable, named region instead of squeezing or clipping. */}
      <div
        className="overflow-x-auto"
        role="region"
        tabIndex={0}
        aria-label={`${ariaLabel}, scrollable`}
      >
        <div className="flex flex-col gap-s3" aria-hidden="true" style={{ minWidth: `${String(bars.length * 3.5 + 3)}rem` }}>
      <div className="flex gap-s2">
        <div className="relative h-56 w-10 shrink-0">
          <div className={PLOT_INSET}>
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute right-0 translate-y-1/2 font-mono text-[0.625rem] tabular-nums text-text-subtle"
                style={{ bottom: pct(t, max) }}
              >
                {formatDecimal(t)}
              </span>
            ))}
          </div>
        </div>
        <div className="relative h-56 min-w-0 flex-1 border-b border-l border-dash-hairline">
          <div className={PLOT_INSET}>
            {ticks.slice(1).map((t) => (
              <div key={t} className="absolute inset-x-0 border-t border-dashed border-dash-hairline" style={{ bottom: pct(t, max) }} />
            ))}
          </div>
          <div className={cn(PLOT_INSET, 'flex items-end gap-s3')}>
            {bars.map((bar) => (
              <div key={bar.key} className="relative flex h-full min-w-[2.5rem] flex-1 flex-col justify-end" data-testid={`load-bar-${bar.key}`}>
                {/* Capacity outline, behind the stack. */}
                <div
                  className="absolute inset-x-[8%] bottom-0 rounded-t-sm border-2 border-b-0 border-text-muted/80"
                  style={{ height: pct(bar.capacity, max) }}
                  title={`${capacityLabel} ${formatDecimal(bar.capacity)}`}
                />
                <div className="relative mx-[18%] flex flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: pct(bar.load, max) }}>
                  {PRIORITY_BUCKETS.map((b) =>
                    bar.split[b] > 0 ? (
                      <div
                        key={b}
                        className={cn('w-full shrink-0', BUCKET_BG[b])}
                        style={{ height: pct(bar.split[b], bar.load) }}
                        title={`${BUCKET_SHORT[b]} ${formatDecimal(bar.split[b])}`}
                      />
                    ) : null,
                  )}
                </div>
                <span
                  className="absolute inset-x-0 pb-0.5 text-center font-mono text-2xs font-semibold tabular-nums text-text"
                  style={{ bottom: pct(bar.load, max) }}
                >
                  {formatDecimal(bar.load)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-s2">
        <div className="w-10 shrink-0" />
        <div className="flex min-w-0 flex-1 gap-s3">
          {bars.map((bar) => (
            <div key={bar.key} className="min-w-[2.5rem] flex-1 text-center">
              <p className="truncate text-2xs font-semibold text-text" title={bar.label}>
                {bar.label}
              </p>
              {bar.sublabel ? (
                <p className="truncate text-[0.625rem] text-text-subtle" title={bar.sublabel}>
                  {bar.sublabel}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
        </div>
      </div>

      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {PRIORITY_BUCKETS.map((b) => (
              <th key={b} scope="col">
                {b}
              </th>
            ))}
            <th scope="col">Load</th>
            <th scope="col">{capacityLabel}</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.key}>
              <th scope="row">{bar.label}</th>
              {PRIORITY_BUCKETS.map((b) => (
                <td key={b}>{formatDecimal(bar.split[b])}</td>
              ))}
              <td>{formatDecimal(bar.load)}</td>
              <td>{formatDecimal(bar.capacity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
