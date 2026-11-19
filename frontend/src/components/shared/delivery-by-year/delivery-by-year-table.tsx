import * as React from 'react';
import { CalendarRange, Hourglass, UserRoundX } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { formatInteger } from '@/lib/format';
import { beyondHorizonText, LEFT_OUT_REASON_SHORT, LEFT_OUT_REASONS } from '@/lib/left-out-reason';
import { cn } from '@/lib/utils';
import type {
  DeliveryBand,
  DeliveryByYear,
  DeliveryByYearRow,
  DeliveryUnavailable,
  TailWarnings,
} from '@/types/delivery-by-year';

/**
 * P53 (ADR 0063, R53-3): "Delivered by year". Rows: by end of the plan year,
 * each later year from the data, "not placed within N years", blocked.
 * Columns P1 / P2 / P3 / Total and the cumulative columns. Years after plan
 * year + 1 are labelled "indicative".
 *
 * Every figure is ONE served field of `DeliveryByYear` (I9 / I59): the browser
 * adds, subtracts and compares nothing — the cumulative columns, the totals,
 * the reason split and the "indicative" flag are all served. With `onOpen`,
 * each figure is a button that lists the projects behind it (the caller
 * fetches the served drill-in list).
 */

export interface DeliveryCellRef {
  row: DeliveryByYearRow;
  /** null = the Total column. */
  band: DeliveryBand | null;
}

export interface DeliveryByYearTableProps {
  data: DeliveryByYear | null | undefined;
  /** Why the table is not served (`pre_p53_run`, `no_active_run`). */
  unavailable?: DeliveryUnavailable | null | undefined;
  /** The served pre-P53 label ("Computed under the earlier rules …"). */
  rulesLabel?: string | null | undefined;
  /** R53-9: served aggregate counts (no names). */
  tailWarnings?: TailWarnings | null | undefined;
  /** Opens the project list behind a figure; omitted = plain numbers. */
  onOpen?: ((cell: DeliveryCellRef, opener: HTMLElement) => void) | undefined;
  /** Shown when `data` is an import run whose u is not the year end. */
  caption?: React.ReactNode;
  className?: string;
  testId?: string;
}

const BANDS: readonly DeliveryBand[] = ['P1', 'P2', 'P3'];

/** The served "Other" column (a Commercialized project with no P1–P3 band). */
function OtherCell({ value, cum = false }: { value: number | null | undefined; cum?: boolean }): React.JSX.Element {
  return (
    <td className={cn('px-2 py-2 text-right tabular-nums', cum ? 'text-text-muted' : 'font-semibold text-text')} data-numeric="">
      {value == null ? '—' : formatInteger(value)}
    </td>
  );
}

function bandValue(row: DeliveryByYearRow, band: DeliveryBand | null): number {
  if (band === 'P1') return row.p1;
  if (band === 'P2') return row.p2;
  if (band === 'P3') return row.p3;
  return row.total;
}

function cumValue(row: DeliveryByYearRow, band: DeliveryBand | null): number | null {
  if (band === 'P1') return row.cum_p1;
  if (band === 'P2') return row.cum_p2;
  if (band === 'P3') return row.cum_p3;
  return row.cum_total;
}

function rowLabel(row: DeliveryByYearRow, horizonYears: number | null): string {
  // The server labels every row; the "not placed" label is the served one, with
  // the R53-2 copy as the hover text.
  if (row.kind === 'not_placed' && row.label.trim() === '') return beyondHorizonText(horizonYears);
  return row.label;
}

function Figure({
  value,
  cell,
  onOpen,
  label,
  strong = false,
}: {
  value: number;
  cell: DeliveryCellRef;
  onOpen?: DeliveryByYearTableProps['onOpen'];
  label: string;
  strong?: boolean;
}): React.JSX.Element {
  const text = formatInteger(value);
  const cls = cn('tabular-nums', strong ? 'font-bold text-text' : 'font-semibold text-text', value === 0 && 'text-text-subtle');
  if (!onOpen || value === 0) {
    return (
      <span className={cls} data-numeric="">
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        cls,
        'rounded px-1 underline decoration-dotted underline-offset-2 hover:bg-surface-raised hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      aria-label={`${label}: ${text} ${value === 1 ? 'project' : 'projects'} — list them`}
      onClick={(e) => onOpen(cell, e.currentTarget)}
      data-numeric=""
      data-testid="delivery-figure"
    >
      {text}
    </button>
  );
}

export function DeliveryByYearTable({
  data,
  unavailable,
  rulesLabel,
  tailWarnings,
  onOpen,
  caption,
  className,
  testId = 'delivery-by-year',
}: DeliveryByYearTableProps): React.JSX.Element {
  if (!data) {
    return (
      <div className={cn('rounded-card border border-dashed border-border px-s3 py-s3 text-xs text-text-muted', className)} data-testid={testId}>
        <p className="font-semibold text-text">Delivered by year</p>
        <p className="mt-1" data-testid="delivery-by-year-unavailable">
          {unavailable === 'pre_p53_run'
            ? (rulesLabel ?? 'Computed under the earlier rules (78-week search; queued P3 not counted)') +
              '. The delivery-by-year table appears after the next recalculation.'
            : unavailable === 'no_active_run'
              ? 'No schedule computed yet.'
              : 'Not available for this run.'}
        </p>
      </div>
    );
  }

  const horizonYears = data.horizon_years;
  // The "Other" column shows only when the server serves a non-zero value in it.
  const showOther = data.rows.some((r) => (r.other ?? 0) > 0);
  return (
    <section className={cn('space-y-s2', className)} data-testid={testId} aria-label="Delivered by year">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarRange className="size-4 text-text-subtle" aria-hidden="true" />
        <h3 className="text-sm font-bold text-text">Delivered by year</h3>
        <span className="text-2xs text-text-muted">
          P1, P2 and P3 are scheduled to completion; P4 is not scheduled. Later years are a forecast.
        </span>
      </div>
      {rulesLabel ? (
        <p className="text-2xs font-medium text-text-muted" data-testid="delivery-rules-label">
          {rulesLabel}
        </p>
      ) : null}
      {caption ? <div className="text-2xs text-text-muted">{caption}</div> : null}
      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full min-w-[40rem] border-collapse text-xs" data-testid="delivery-by-year-table">
          <caption className="sr-only">
            Projects delivered by year, per priority band, with cumulative totals
          </caption>
          <thead className="bg-surface-sunken text-2xs uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-semibold">
                Delivered
              </th>
              {BANDS.map((b) => (
                <th key={b} scope="col" className="px-2 py-2 text-right font-semibold">
                  {b}
                </th>
              ))}
              {showOther ? (
                <th scope="col" className="px-2 py-2 text-right font-semibold" title="Commercialized, no P1–P3 band">
                  Other
                </th>
              ) : null}
              <th scope="col" className="px-2 py-2 text-right font-semibold">
                Total
              </th>
              {BANDS.map((b) => (
                <th key={`cum-${b}`} scope="col" className="border-l border-border px-2 py-2 text-right font-semibold">
                  Cum. {b}
                </th>
              ))}
              {showOther ? (
                <th scope="col" className="px-2 py-2 text-right font-semibold">
                  Cum. other
                </th>
              ) : null}
              <th scope="col" className="px-2 py-2 text-right font-semibold">
                Cum. total
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => {
              const label = rowLabel(row, horizonYears);
              const separate = row.kind === 'not_placed' || row.kind === 'blocked';
              return (
                <tr
                  key={`${row.kind}-${String(row.year ?? i)}`}
                  className={cn('border-t border-border', separate && 'bg-surface-sunken/50', row.indicative && 'text-text-muted')}
                  data-testid="delivery-row"
                  data-kind={row.kind}
                  data-year={row.year ?? undefined}
                  data-indicative={row.indicative || undefined}
                >
                  <th scope="row" className="px-3 py-2 text-left font-semibold text-text">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {row.kind === 'not_placed' ? (
                        <UserRoundX className="size-3.5 text-warning-subtle-fg" aria-hidden="true" />
                      ) : null}
                      <span title={row.kind === 'not_placed' ? beyondHorizonText(horizonYears) : undefined}>{label}</span>
                      {row.indicative ? (
                        <Badge tone="outline" className="text-2xs" data-testid="delivery-indicative">
                          indicative
                        </Badge>
                      ) : null}
                    </span>
                    {row.kind === 'not_placed' && row.left_out_reasons ? (
                      <span className="mt-0.5 block text-2xs font-normal text-text-muted" data-testid="delivery-reasons">
                        {LEFT_OUT_REASONS.filter((r) => (row.left_out_reasons?.[r] ?? 0) > 0)
                          .map((r) =>
                            r === 'beyond_horizon'
                              ? `${beyondHorizonText(horizonYears)}: ${formatInteger(row.left_out_reasons?.[r] ?? 0)}`
                              : `${LEFT_OUT_REASON_SHORT[r]}: ${formatInteger(row.left_out_reasons?.[r] ?? 0)}`,
                          )
                          .join(' · ') || 'None'}
                      </span>
                    ) : null}
                  </th>
                  {BANDS.map((b) => (
                    <td key={b} className="px-2 py-2 text-right">
                      <Figure value={bandValue(row, b)} cell={{ row, band: b }} onOpen={onOpen} label={`${label}, ${b}`} />
                    </td>
                  ))}
                  {showOther ? <OtherCell value={row.other ?? 0} /> : null}
                  <td className="px-2 py-2 text-right">
                    <Figure value={row.total} cell={{ row, band: null }} onOpen={onOpen} label={`${label}, all bands`} strong />
                  </td>
                  {BANDS.map((b) => {
                    const v = cumValue(row, b);
                    return (
                      <td
                        key={`cum-${b ?? 'total'}`}
                        className={cn('px-2 py-2 text-right tabular-nums text-text-muted', b === 'P1' && 'border-l border-border')}
                        data-numeric=""
                      >
                        {v === null ? '—' : formatInteger(v)}
                      </td>
                    );
                  })}
                  {showOther ? <OtherCell value={row.cum_other ?? null} cum /> : null}
                  <td className="px-2 py-2 text-right font-bold tabular-nums" data-numeric="">
                    {row.cum_total === null ? '—' : formatInteger(row.cum_total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {tailWarnings && (tailWarnings.far_finish_count > 0 || tailWarnings.leader_overloaded_count > 0) ? (
        <p className="flex items-center gap-1.5 text-2xs text-warning-subtle-fg" data-testid="delivery-tail-warnings">
          <Hourglass className="size-3.5" aria-hidden="true" />
          {formatInteger(tailWarnings.far_finish_count)}{' '}
          {tailWarnings.far_finish_count === 1 ? 'project finishes' : 'projects finish'} after next year ·{' '}
          {formatInteger(tailWarnings.leader_overloaded_count)}{' '}
          {tailWarnings.leader_overloaded_count === 1 ? 'leader is' : 'leaders are'} booked past next year — check
          leader load on Capacity.
        </p>
      ) : null}
    </section>
  );
}
