import * as React from 'react';

import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { PriorityLoadSplit } from '../api/types';
import { BUCKET_BG, BUCKET_SHORT, PRIORITY_BUCKETS } from '../lib/priority-split';
import { formatFigure } from '../lib/status-format';

/**
 * P13-T11: "Design / Lab load vs capacity" as one stacked column per hub (or lab
 * region): the served per-priority load segments (P1 → Queue, bottom to top)
 * inside a dashed outline at the served capacity. Hand-built with CSS heights,
 * like `components/ui/bar-chart.tsx` — no charting library, chart tokens only.
 *
 * Every segment is one served `*_load_by_priority` value; the label on top of a
 * column is the served `*_load_weeks` (which the buckets sum to, server-side).
 * The only arithmetic here is the pixel scale (value / axis max), which is
 * presentation, not a figure.
 *
 * P19-T05 (Weeks | Days): `load` and `capacity` are the served figures in the
 * page's unit (served day fields in Days). The per-priority split is served in
 * weeks only, so each segment's height is its share of the served weeks total
 * (`splitTotal`, a pixel proportion) applied to the column, and every split
 * VALUE shown (tooltips, the screen-reader table) is labelled in weeks. A day
 * figure absent from an older API is `null`: no column, "—" as its label. The visible figures are also exposed as a table
 * to assistive tech, so colour is never the only carrier.
 */
export interface PriorityLoadBar {
  key: string;
  label: string;
  /** Optional second line under the label, e.g. the hubs of a lab region. */
  sublabel?: string;
  /** P30: the served split of the FULL-YEAR demand; null in the remaining view
   *  (no split of the remaining demand is served), which draws one plain column. */
  split: PriorityLoadSplit | null;
  /** The served weeks total the split sums to (`design_load_weeks` / `lab_load_weeks`);
   *  used only as the denominator of each segment's pixel share. */
  splitTotal: number;
  /** The served demand in the page's unit (P30: full-year or remaining); null when absent. */
  load: number | null;
  /** The served capacity for the selected horizon in the page's unit; null when absent. */
  capacity: number | null;
}

export interface PriorityLoadChartProps {
  bars: PriorityLoadBar[];
  /** Accessible name for the chart, e.g. "Design load vs capacity by hub". */
  ariaLabel: string;
  /** Long unit of `load` / `capacity`, e.g. "engineer-days" (accessible names, axis title). */
  unit: string;
  /** Short unit printed under each column's value label, e.g. "days". */
  unitShort: string;
  /** Unit of the per-priority split values (served in weeks only), e.g. "wks". */
  splitUnit: string;
  capacityLabel: string;
  /** P30: what the column is, e.g. "Full-year demand" / "Remaining demand". */
  loadLabel?: string;
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
/** Plot height in px: `h-56` (224) less the `top-5` (20) inset. Display only. */
const PLOT_PX = 204;
/** A segment at least this tall carries its served value inside it; a slimmer
 *  one is read from the column's hover card (owner ask 2026-10-22). */
const MIN_LABEL_PX = 14;

export function PriorityLoadChart({
  bars,
  ariaLabel,
  unit,
  unitShort,
  splitUnit,
  capacityLabel,
  loadLabel = 'Load',
}: PriorityLoadChartProps): React.JSX.Element {
  const hasSplit = bars.some((b) => b.split !== null);
  // Display scale only: the tallest load or capacity outline sets the axis.
  const { top: max, ticks } = axisScale(bars.reduce((m, b) => Math.max(m, b.load ?? 0, b.capacity ?? 0), 0));
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
        {hasSplit ? (
          PRIORITY_BUCKETS.map((b) => (
            <li key={b} className="flex items-center gap-1">
              <span className={cn('inline-block size-2.5 rounded-sm', BUCKET_BG[b])} />
              {b === 'Queue' ? 'Queue' : b}
            </li>
          ))
        ) : (
          <li className="flex items-center gap-1">
            <span className="inline-block size-2.5 rounded-sm bg-primary/70" />
            {loadLabel}
          </li>
        )}
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
      <p className="text-2xs font-semibold text-text-muted first-letter:uppercase" data-testid="priority-load-chart-axis">
        {unit}
      </p>
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
              <div key={bar.key} className="group relative flex h-full min-w-[2.5rem] flex-1 flex-col justify-end" data-testid={`load-bar-${bar.key}`}>
                {/* Capacity outline, behind the stack. */}
                <div
                  className="absolute inset-x-[8%] bottom-0 rounded-t-sm border-2 border-b-0 border-text-muted/80"
                  style={{ height: pct(bar.capacity ?? 0, max) }}
                  title={`${capacityLabel} ${formatFigure(bar.capacity)} ${unitShort}`}
                />
                <div className="relative mx-[18%] flex flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: pct(bar.load ?? 0, max) }}>
                  {bar.split === null ? (
                    <div className="h-full w-full bg-primary/70" data-testid={`load-plain-${bar.key}`} />
                  ) : null}
                  {PRIORITY_BUCKETS.map((b) => {
                    const split = bar.split;
                    if (split === null || split[b] <= 0) return null;
                    // Pixel estimate for the label decision only (presentation).
                    const px =
                      max > 0 && bar.splitTotal > 0
                        ? PLOT_PX * Math.min(1, (bar.load ?? 0) / max) * (split[b] / bar.splitTotal)
                        : 0;
                    return (
                      <div
                        key={b}
                        className={cn('grid w-full shrink-0 place-items-center overflow-hidden', BUCKET_BG[b])}
                        style={{ height: pct(split[b], bar.splitTotal) }}
                        title={`${BUCKET_SHORT[b]} ${formatDecimal(split[b])} ${splitUnit}`}
                      >
                        {px >= MIN_LABEL_PX ? (
                          <span
                            className="font-mono text-[0.625rem] font-bold leading-none tabular-nums text-white [text-shadow:0_1px_1px_rgb(0_0_0/0.35)]"
                            data-testid={`load-seg-${bar.key}-${b}`}
                          >
                            {formatDecimal(split[b])}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {/* Hover card: every served figure of the column, so a segment too
                    slim to carry its number can still be read. */}
                <div
                  className="pointer-events-none absolute bottom-1/2 left-1/2 z-20 hidden w-max min-w-[8rem] -translate-x-1/2 rounded-xl border-[1.5px] border-dash-hairline bg-surface px-s3 py-s2 text-2xs shadow-pop group-hover:block"
                  data-testid={`load-bar-hover-${bar.key}`}
                >
                  <p className="mb-1 font-bold text-text">{bar.label}</p>
                  {bar.split !== null
                    ? PRIORITY_BUCKETS.map((b) => (
                        <p key={b} className="flex items-center justify-between gap-s3 tabular-nums text-text-muted">
                          <span className="flex items-center gap-1">
                            <span className={cn('inline-block size-2 rounded-sm', BUCKET_BG[b])} />
                            {b}
                          </span>
                          <span className="font-mono font-semibold text-text">
                            {formatDecimal(bar.split?.[b] ?? 0)} {splitUnit}
                          </span>
                        </p>
                      ))
                    : null}
                  <p className="mt-1 flex justify-between gap-s3 border-t border-dash-hairline pt-1 tabular-nums text-text-muted">
                    {loadLabel} <span className="font-mono font-semibold text-text">{formatFigure(bar.load)} {unitShort}</span>
                  </p>
                  <p className="flex justify-between gap-s3 tabular-nums text-text-muted">
                    {capacityLabel}{' '}
                    <span className="font-mono font-semibold text-text">
                      {formatFigure(bar.capacity)} {unitShort}
                    </span>
                  </p>
                </div>
                <span
                  className="absolute inset-x-0 pb-0.5 text-center font-mono text-2xs font-semibold tabular-nums text-text"
                  style={{ bottom: pct(bar.load ?? 0, max) }}
                  data-testid={`load-bar-value-${bar.key}`}
                >
                  {formatFigure(bar.load)}
                  <span className="block text-[0.625rem] font-medium text-text-subtle">{unitShort}</span>
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
        <caption>
          {ariaLabel}; {loadLabel.toLowerCase()} and capacity in {unit}
          {hasSplit ? `, priority split in ${splitUnit}` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {hasSplit
              ? PRIORITY_BUCKETS.map((b) => (
                  <th key={b} scope="col">
                    {b} ({splitUnit})
                  </th>
                ))
              : null}
            <th scope="col">
              {loadLabel} ({unitShort})
            </th>
            <th scope="col">
              {capacityLabel} ({unitShort})
            </th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.key}>
              <th scope="row">{bar.label}</th>
              {hasSplit ? PRIORITY_BUCKETS.map((b) => <td key={b}>{formatDecimal(bar.split?.[b] ?? 0)}</td>) : null}
              <td>{formatFigure(bar.load)}</td>
              <td>{formatFigure(bar.capacity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
