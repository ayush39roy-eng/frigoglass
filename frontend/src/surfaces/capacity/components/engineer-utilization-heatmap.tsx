import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { NotInCapacityRosterBadge } from '@/components/shared/capacity-roster-markers';
import { cn } from '@/lib/utils';
import { formatDecimal, formatPercent, formatWeek } from '@/lib/format';

import type { EngineerUtilizationResponse, EngineerUtilizationRow } from '../api/types';

/**
 * Engineers x weeks heatmap (P4-T08 / P15, ADR 0028). Every number (booked,
 * capacity, utilization %) is served; the browser only picks a colour band for
 * a served `utilization_pct` (presentation, not a derived figure).
 *
 * Bands (also spelled out in the legend and in every cell's text/aria-label, so
 * colour is never the sole signal): under < 70 %, well-utilized 70-100 %, over > 100 %.
 * All pairs use the `*-subtle` / `*-subtle-fg` tokens (AA).
 *
 * Rows are grouped by hub (hub header rows). Above 100 flat rows the body is
 * windowed with TanStack Virtual (CLAUDE.md); below that it renders in full.
 */

export type UtilBand = 'none' | 'under' | 'well' | 'over';

export const UNDER_BELOW_PCT = 70;
export const OVER_ABOVE_PCT = 100;

export function utilBand(capacity: number, pct: number): UtilBand {
  if (capacity <= 0) return 'none';
  if (pct > OVER_ABOVE_PCT) return 'over';
  if (pct >= UNDER_BELOW_PCT) return 'well';
  return 'under';
}

const BAND_CLASS: Record<UtilBand, string> = {
  none: 'bg-surface-sunken text-text-subtle',
  under: 'bg-primary/15 text-text',
  well: 'bg-success-subtle text-success-subtle-fg font-semibold',
  over: 'bg-danger-subtle text-danger-subtle-fg font-semibold ring-1 ring-inset ring-danger',
};
const BAND_LABEL: Record<UtilBand, string> = {
  none: 'no capacity',
  under: 'under-utilized',
  well: 'well-utilized',
  over: 'over-utilized',
};

type FlatRow = { kind: 'hub'; hub: string; count: number } | { kind: 'eng'; eng: EngineerUtilizationRow };

function flatten(engineers: EngineerUtilizationRow[]): FlatRow[] {
  const byHub = new Map<string, EngineerUtilizationRow[]>();
  for (const e of engineers) {
    const list = byHub.get(e.hub);
    if (list) list.push(e);
    else byHub.set(e.hub, [e]);
  }
  const out: FlatRow[] = [];
  for (const hub of [...byHub.keys()].sort()) {
    const list = byHub.get(hub) ?? [];
    out.push({ kind: 'hub', hub, count: list.length });
    for (const eng of list) out.push({ kind: 'eng', eng });
  }
  return out;
}

const ROW_H = 28;
const VIRTUALIZE_ABOVE = 100;

export function EngineerUtilizationHeatmap({ data }: { data: EngineerUtilizationResponse }): React.JSX.Element {
  const [first, last] = data.week_range;
  const weeks = React.useMemo(() => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i), [first, last]);
  const rows = React.useMemo(() => flatten(data.engineers), [data.engineers]);
  const gridTemplate = `minmax(11rem, max-content) repeat(${String(weeks.length)}, 2.25rem) 7.5rem`;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const windowed = rows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: windowed ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  const renderRow = (row: FlatRow, style?: React.CSSProperties): React.JSX.Element => {
    if (row.kind === 'hub') {
      return (
        <div
          key={`hub-${row.hub}`}
          role="row"
          className="sticky left-0 border-b border-dash-hairline bg-dash-alt px-2 py-1 font-semibold text-text"
          style={{ ...style, height: ROW_H }}
        >
          <span role="rowheader">{row.hub}</span>{' '}
          <span className="font-normal text-text-muted">({String(row.count)} engineers)</span>
        </div>
      );
    }
    const e = row.eng;
    const byWeek = new Map(e.weeks.map((w) => [w.week, w]));
    const totalBand = utilBand(e.total_capacity, e.utilization_pct);
    return (
      <div
        key={e.id}
        role="row"
        className="grid border-b border-dash-hairline"
        style={{ ...style, gridTemplateColumns: gridTemplate, height: ROW_H }}
        data-testid="engineer-row"
      >
        <div role="rowheader" className="sticky left-0 z-10 flex items-center gap-1.5 bg-surface px-2 py-1">
          <span className="font-medium text-text">{e.name}</span>
          <span className="text-text-subtle">{e.role}</span>
          {/* P29 (API_CONTRACT_P29 §3.3): served flag; an older API omits it (no marker). */}
          {e.counts_in_capacity === false ? <NotInCapacityRosterBadge /> : null}
        </div>
        {weeks.map((w) => {
          const cell = byWeek.get(w);
          const band = cell ? utilBand(cell.capacity, cell.utilization_pct) : 'none';
          const pct = cell && cell.capacity > 0 ? formatPercent(cell.utilization_pct) : '';
          return (
            <div
              key={w}
              role="cell"
              aria-label={
                cell
                  ? `${e.name}, ${formatWeek(w)}: ${formatPercent(cell.utilization_pct)} (${formatDecimal(cell.booked)} of ${formatDecimal(cell.capacity)}), ${BAND_LABEL[band]}`
                  : `${e.name}, ${formatWeek(w)}: no data`
              }
              title={cell ? `${e.name} · ${formatWeek(w)} · ${pct || '0%'} · ${BAND_LABEL[band]}` : undefined}
              className={cn(
                'flex items-center justify-center border-l border-dash-hairline/60 text-[0.6rem] tabular-nums',
                BAND_CLASS[band],
                w === data.current_week && 'outline outline-2 -outline-offset-2 outline-primary',
              )}
              data-band={band}
            >
              {pct.replace('%', '')}
            </div>
          );
        })}
        <div
          role="cell"
          className={cn('flex items-center justify-center gap-1 border-l border-dash-hairline px-1 tabular-nums', BAND_CLASS[totalBand])}
          data-testid="engineer-total"
          aria-label={`${e.name} total: ${formatPercent(e.utilization_pct)}, ${formatDecimal(e.total_booked)} of ${formatDecimal(e.total_capacity)} weeks, ${BAND_LABEL[totalBand]}`}
        >
          <span>{formatPercent(e.utilization_pct)}</span>
          <span className="font-normal text-text-muted">
            {formatDecimal(e.total_booked)}/{formatDecimal(e.total_capacity)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div
        ref={scrollRef}
        className={cn('overflow-auto rounded-dash border border-dash-hairline', windowed && 'max-h-[32rem]')}
        tabIndex={0}
        role="region"
        aria-label="Engineer utilization by week, scrollable"
      >
        <div role="table" aria-label="Engineer utilization by week" className="min-w-max text-2xs">
          <div
            role="row"
            className="sticky top-0 z-20 grid border-b border-dash-hairline bg-dash-alt"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div role="columnheader" className="sticky left-0 z-10 bg-dash-alt px-2 py-1.5 font-semibold text-text-muted">
              Engineer
            </div>
            {weeks.map((w) => (
              <div
                key={w}
                role="columnheader"
                className={cn(
                  'py-1.5 text-center font-medium tabular-nums text-text-muted',
                  w === data.current_week && 'font-bold text-primary underline',
                )}
                title={w === data.current_week ? `${formatWeek(w)} (current week)` : formatWeek(w)}
                aria-current={w === data.current_week ? 'date' : undefined}
              >
                {w}
              </div>
            ))}
            <div role="columnheader" className="px-1 py-1.5 text-center font-semibold text-text-muted">
              Total
            </div>
          </div>
          {windowed ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((v) => {
                const row = rows[v.index];
                return row
                  ? renderRow(row, { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${String(v.start)}px)` })
                  : null;
              })}
            </div>
          ) : (
            rows.map((r) => renderRow(r))
          )}
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1.5 text-2xs text-text-muted" data-testid="engineer-util-legend">
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-full bg-primary/15" aria-hidden="true" />
          <dt>Under-utilized (&lt; {String(UNDER_BELOW_PCT)} %)</dt>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-full bg-success-subtle" aria-hidden="true" />
          <dt>Well-utilized ({String(UNDER_BELOW_PCT)}-{String(OVER_ABOVE_PCT)} %)</dt>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-full bg-danger-subtle ring-1 ring-inset ring-danger" aria-hidden="true" />
          <dt>Over-utilized (&gt; {String(OVER_ABOVE_PCT)} %)</dt>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-full bg-surface-sunken ring-1 ring-inset ring-dash-hairline" aria-hidden="true" />
          <dt>No capacity</dt>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-full outline outline-2 outline-primary" aria-hidden="true" />
          <dt>Current week (W{String(data.current_week)})</dt>
        </div>
      </dl>
    </div>
  );
}
