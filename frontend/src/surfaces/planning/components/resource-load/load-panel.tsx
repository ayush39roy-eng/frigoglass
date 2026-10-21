import * as React from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

import type { LoadTotals } from '../../api/types';
import { formatAmount, formatPct, unitShort, type CapacityUnit } from '../../lib/figures';

/**
 * One "load vs capacity" column of Resource load analytics (P19-T04): a
 * grouped horizontal bar chart (capacity and load per resource, value labels
 * on every bar) above a sortable table. Every figure is a served field of
 * `GET /planning/resource-load` for the page's unit; the chart's bar lengths
 * are only a drawing scale.
 *
 * Horizontal bars (one row per resource, the chart growing in height) were
 * picked over a vertical chart with sideways scroll: with ~20 engineers every
 * "<name> (<hub>)" label stays readable at 390 px and nothing scrolls.
 */
export interface LoadRow {
  id: string;
  name: string;
  group: string;
  capacity: number;
  load: number;
  utilization: number | null;
}

type SortKey = 'name' | 'group' | 'capacity' | 'load' | 'utilization';

export interface LoadPanelProps {
  title: string;
  tone: 'primary' | 'success';
  nameHeader: string;
  groupHeader: string;
  rows: LoadRow[];
  totals: LoadTotals | undefined;
  unit: CapacityUnit;
  emptyText: string;
}

const OVER = 100;

export function LoadPanel({ title, tone, nameHeader, groupHeader, rows, totals, unit, emptyText }: LoadPanelProps): React.JSX.Element {
  const headingId = React.useId();
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * factor;
      return ((va as number) - (vb as number)) * factor;
    });
  }, [rows, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'group' ? 'asc' : 'desc' }));

  const u = unitShort(unit);
  const totalCapacity = totals ? (unit === 'weeks' ? totals.capacity_weeks : totals.capacity_days) : undefined;
  const totalLoad = totals ? (unit === 'weeks' ? totals.load_weeks : totals.load_days) : undefined;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-3 shadow-sm">
      <h3 id={headingId} className={cn('text-sm font-bold', tone === 'primary' ? 'text-primary-subtle-fg' : 'text-success-subtle-fg')}>
        {title} ({u})
      </h3>
      {rows.length === 0 ? (
        <p className="text-2xs text-text-subtle">{emptyText}</p>
      ) : (
        <>
          <LoadBars rows={sorted} unit={unit} tone={tone} label={`${title}, chart`} />
          <Table className="text-xs" scrollLabel={`${title}, table`}>
            <TableHeader>
              <TableRow>
                <SortHead label={nameHeader} k="name" sort={sort} onSort={toggleSort} />
                <SortHead label={groupHeader} k="group" sort={sort} onSort={toggleSort} />
                <SortHead label={`Capacity (${u})`} k="capacity" sort={sort} onSort={toggleSort} numeric />
                <SortHead label={`Load (${u})`} k="load" sort={sort} onSort={toggleSort} numeric />
                <SortHead label="Util %" k="utilization" sort={sort} onSort={toggleSort} numeric />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => {
                const over = r.utilization !== null && r.utilization > OVER;
                return (
                  <TableRow key={r.id} data-testid={`load-row-${r.id}`}>
                    <TableCell className="px-2 py-1.5 font-semibold text-text">{r.name}</TableCell>
                    <TableCell className="px-2 py-1.5 text-text-muted">{r.group}</TableCell>
                    <TableCell className="px-2 py-1.5 text-right font-mono tnum" data-numeric="">
                      {formatAmount(r.capacity, unit)}
                    </TableCell>
                    <TableCell className={cn('px-2 py-1.5 text-right font-mono tnum', r.load > r.capacity && 'text-danger')} data-numeric="">
                      {formatAmount(r.load, unit)}
                    </TableCell>
                    <TableCell
                      className={cn('whitespace-nowrap px-2 py-1.5 text-right font-mono font-bold tnum', over ? 'text-danger' : 'text-text')}
                      data-numeric=""
                      data-over={over ? '' : undefined}
                    >
                      {over ? <AlertTriangle aria-hidden="true" className="mr-1 inline size-3 align-[-2px]" /> : null}
                      {formatPct(r.utilization)}
                      {over ? <span className="sr-only"> (over capacity)</span> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="px-2 py-1.5 font-bold" colSpan={2}>
                  Total
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right font-mono font-bold tnum" data-numeric="">
                  {formatAmount(totalCapacity, unit)}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-right font-mono font-bold tnum" data-numeric="">
                  {formatAmount(totalLoad, unit)}
                </TableCell>
                <TableCell
                  className={cn(
                    'px-2 py-1.5 text-right font-mono font-bold tnum',
                    totals?.utilization_pct != null && totals.utilization_pct > OVER && 'text-danger',
                  )}
                  data-numeric=""
                >
                  {formatPct(totals?.utilization_pct)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </>
      )}
    </section>
  );
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  numeric,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' } | null;
  onSort: (k: SortKey) => void;
  numeric?: boolean;
}): React.JSX.Element {
  const active = sort?.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn('h-8 px-1 text-2xs', numeric && 'text-right')}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex items-center gap-1 rounded px-1 py-0.5 font-semibold hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          numeric && 'flex-row-reverse',
        )}
      >
        {label}
        <Icon aria-hidden="true" className={cn('size-3', !active && 'opacity-50')} />
      </button>
    </TableHead>
  );
}

function LoadBars({ rows, unit, tone, label }: { rows: LoadRow[]; unit: CapacityUnit; tone: 'primary' | 'success'; label: string }): React.JSX.Element {
  // Drawing scale only (bar length, at most 85% so the value label fits), not a displayed figure.
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.capacity, r.load)));
  const width = (v: number) => `${String(Math.max(0, Math.min(85, (v / scale) * 85)))}%`;
  return (
    <figure className="m-0" aria-label={label}>
      <div className="mb-1 flex items-center gap-3 text-2xs text-text-muted" aria-hidden="true">
        <span className="flex items-center gap-1">
          <span className={cn('inline-block size-2.5 rounded-sm border', tone === 'primary' ? 'border-primary bg-primary/20' : 'border-success bg-success/20')} />
          Capacity
        </span>
        <span className="flex items-center gap-1">
          <span className={cn('inline-block size-2.5 rounded-sm', tone === 'primary' ? 'bg-primary' : 'bg-success')} />
          Load
        </span>
      </div>
      {/* The same figures are in the table below, so the bars are hidden from
          assistive technology to avoid reading every number twice. */}
      <ul className="flex flex-col gap-1.5" aria-hidden="true" data-testid="load-bars">
        {rows.map((r) => (
          <li key={r.id} className="grid grid-cols-1 items-center gap-x-2 gap-y-0.5 sm:grid-cols-[minmax(6rem,11rem)_1fr]">
            <span className="truncate text-2xs font-medium text-text" title={`${r.name} (${r.group})`}>
              {r.name} ({r.group})
            </span>
            <span className="flex flex-col gap-0.5">
              <Bar width={width(r.capacity)} value={formatAmount(r.capacity, unit)} className={tone === 'primary' ? 'border border-primary bg-primary/20' : 'border border-success bg-success/20'} />
              <Bar
                width={width(r.load)}
                value={formatAmount(r.load, unit)}
                className={r.load > r.capacity ? 'bg-danger' : tone === 'primary' ? 'bg-primary' : 'bg-success'}
              />
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Bar({ width, value, className }: { width: string; value: string; className: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('h-2 min-w-[2px] rounded-sm', className)} style={{ width }} />
      <span className="shrink-0 font-mono text-[0.625rem] text-text-muted tnum">{value}</span>
    </span>
  );
}
