import * as React from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBookedPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import type { ScopeInfo } from '../../api/whatif-types';

/** What the figures cover, exactly as the server scoped them. */
export function ScopeNote({ scope }: { scope: ScopeInfo }): React.JSX.Element {
  return (
    <p className="text-2xs text-text-muted" data-testid="whatif-scope">
      {scope.all_hubs
        ? 'Showing all hubs.'
        : `Showing your hubs only (${scope.hubs.join(', ') || 'none'}). Lab regions (${scope.lab_regions.join(', ') || 'none'}) include load from every hub that uses them.`}
    </p>
  );
}

/** "How this was calculated": the engine's own arithmetic lines, verbatim. */
export function WorkingsDisclosure({
  lines,
  title = 'How this was calculated',
}: {
  lines: readonly string[];
  title?: string;
}): React.JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <details className="group rounded-md border border-border bg-surface-sunken/40" data-testid="whatif-workings">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-s3 py-s2 text-xs font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
        {title}
      </summary>
      <ol className="list-decimal space-y-1 px-s6 pb-s3 pt-1 text-xs text-text-muted">
        {lines.map((line, i) => (
          <li key={`${String(i)}-${line}`} className="break-words font-mono text-2xs leading-relaxed">
            {line}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function FigureTile({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface px-s3 py-s3" data-testid={testId}>
      <span className="label-caps text-text-subtle">{label}</span>
      <span className="font-mono text-figure font-bold tabular-nums text-text" data-numeric="">
        {value}
      </span>
      {hint ? <span className="text-2xs text-text-muted">{hint}</span> : null}
    </div>
  );
}

/** A served booked % before and after, each with its served status. */
export function BookedShift({
  before,
  after,
  statusBefore,
  statusAfter,
}: {
  before: number | null;
  after: number | null;
  statusBefore: BookingStatus;
  statusAfter: BookingStatus;
}): React.JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-mono tabular-nums">{formatBookedPct(before)}</span>
      <BookingStatusChip status={statusBefore} />
      <ArrowRight className="size-3.5 text-text-subtle" aria-hidden="true" />
      <span className="sr-only">after</span>
      <span className="font-mono font-semibold tabular-nums">{formatBookedPct(after)}</span>
      <BookingStatusChip status={statusAfter} />
    </span>
  );
}

export function SectionHeading({ children, id }: { children: React.ReactNode; id?: string }): React.JSX.Element {
  return (
    <h4 id={id} className="text-sm font-semibold text-text">
      {children}
    </h4>
  );
}

/** A tone-coloured callout (icon text + words, never colour alone). */
export function Callout({
  tone,
  title,
  children,
  testId,
  role,
}: {
  tone: 'success' | 'warning' | 'primary' | 'neutral';
  title: string;
  children?: React.ReactNode;
  testId?: string;
  role?: 'status' | 'alert';
}): React.JSX.Element {
  const toneClass = {
    success: 'border-success/40 bg-success-subtle text-success-subtle-fg',
    warning: 'border-warning/50 bg-warning-subtle text-warning-subtle-fg',
    primary: 'border-primary/30 bg-primary-subtle text-primary-subtle-fg',
    neutral: 'border-border-strong bg-surface-sunken text-text',
  }[tone];
  return (
    <div className={cn('rounded-md border px-s4 py-s3', toneClass)} data-testid={testId} role={role}>
      <p className="text-sm font-semibold">{title}</p>
      {children ? <div className="mt-1 space-y-1 text-xs">{children}</div> : null}
    </div>
  );
}

// --- project rows (virtualized over 100) -----------------------------------------------------

export interface RowColumn<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
  className?: string;
}

const VIRTUALIZE_OVER = 100;
const ROW_HEIGHT = 40;

export function ProjectRowsTable<T>({
  rows,
  columns,
  rowKey,
  label,
}: {
  rows: readonly T[];
  columns: readonly RowColumn<T>[];
  rowKey: (row: T) => string;
  label: string;
}): React.JSX.Element {
  const tableRef = React.useRef<HTMLTableElement>(null);
  const scrollElement = React.useCallback(() => tableRef.current?.parentElement ?? null, []);
  const virtual = rows.length > VIRTUALIZE_OVER;
  return (
    <div className="rounded-md border border-border [&>div]:max-h-72" data-testid="whatif-rows">
      <Table ref={tableRef} stickyHeader scrollLabel={label} aria-label={label}>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.header} className={c.className}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        {virtual ? (
          <VirtualBody rows={rows} columns={columns} rowKey={rowKey} scrollElement={scrollElement} />
        ) : (
          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)} data-testid="whatif-row">
                {columns.map((c) => (
                  <TableCell key={c.header} className={c.className}>
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        )}
      </Table>
    </div>
  );
}

function VirtualBody<T>({
  rows,
  columns,
  rowKey,
  scrollElement,
}: {
  rows: readonly T[];
  columns: readonly RowColumn<T>[];
  rowKey: (row: T) => string;
  scrollElement: () => HTMLElement | null;
}): React.JSX.Element {
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 720, height: 288 },
  });
  const items = virtualizer.getVirtualItems();
  const top = items[0]?.start ?? 0;
  const bottom = virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0);
  return (
    <TableBody data-virtualized="true">
      {top > 0 ? (
        <tr aria-hidden="true">
          <td colSpan={columns.length} style={{ height: top, padding: 0 }} />
        </tr>
      ) : null}
      {items.map((item) => {
        const row = rows[item.index];
        if (row === undefined) return null;
        return (
          <TableRow key={rowKey(row)} style={{ height: ROW_HEIGHT }} data-testid="whatif-row">
            {columns.map((c) => (
              <TableCell key={c.header} className={c.className}>
                {c.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        );
      })}
      {bottom > 0 ? (
        <tr aria-hidden="true">
          <td colSpan={columns.length} style={{ height: bottom, padding: 0 }} />
        </tr>
      ) : null}
    </TableBody>
  );
}
