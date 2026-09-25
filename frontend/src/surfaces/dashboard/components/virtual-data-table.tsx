import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { cn } from '@/lib/utils';

/**
 * Row-virtualized table (TanStack Virtual) — mandatory for any list over 100 rows
 * (CLAUDE.md: 236 projects is the baseline volume). Sticky header, zebra-free,
 * 1px row borders (ui-ux-pro-max).
 *
 * Deliberately small: the Dashboard's two lists are flat projections. The Matrix
 * and Capacity Planning get the full TanStack Table + Virtual treatment in their
 * own tasks.
 */

export interface VirtualColumn<Row> {
  id: string;
  header: React.ReactNode;
  /** Grid track width, e.g. `minmax(12rem, 1fr)` or `5rem`. */
  width: string;
  cell: (row: Row) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  headerClassName?: string;
}

export interface VirtualDataTableProps<Row> {
  rows: Row[];
  columns: VirtualColumn<Row>[];
  rowKey: (row: Row) => string;
  /** Accessible caption for the table region. */
  caption: string;
  estimateRowHeight?: number;
  /** Max viewport height for the scroll area. */
  maxHeight?: number;
  className?: string;
}

const ALIGN: Record<NonNullable<VirtualColumn<unknown>['align']>, string> = {
  left: 'justify-start text-left',
  right: 'justify-end text-right',
  center: 'justify-center text-center',
};

export function VirtualDataTable<Row>({
  rows,
  columns,
  rowKey,
  caption,
  estimateRowHeight = 40,
  maxHeight = 440,
  className,
}: VirtualDataTableProps<Row>): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const gridTemplate = columns.map((c) => c.width).join(' ');

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();

  return (
    // P4-T11: `role="table"` must wrap only `row`/`rowgroup` children (axe
    // `aria-required-children`) — the focusable, `overflow-auto` scroll viewport
    // therefore has to be the OUTER element (matching
    // `virtual-matrix-grid.tsx`'s already-clean pattern), with `role="table"`
    // nested inside it, rather than the reverse. The header row moves inside
    // the scroll viewport too, and picks up `sticky top-0` (previously
    // redundant — the header lived outside the scrollable box entirely) so it
    // keeps behaving like a fixed header now that it shares a scroll ancestor
    // with the body rows.
    <div
      ref={scrollRef}
      className={cn('overflow-auto scrollbar-thin rounded-lg border border-border', className)}
      style={{ maxHeight }}
      data-testid="virtual-table-scroll"
      tabIndex={0}
    >
      <div role="table" aria-label={caption} aria-rowcount={rows.length}>
        <div
          role="row"
          className="sticky top-0 z-10 grid items-center gap-3 border-b border-border bg-surface-sunken px-3 py-2 text-xs font-semibold text-text-muted"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {columns.map((col) => (
            <div
              key={col.id}
              role="columnheader"
              className={cn('flex items-center', ALIGN[col.align ?? 'left'], col.headerClassName)}
            >
              {col.header}
            </div>
          ))}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            return (
              <div
                key={rowKey(row)}
                role="row"
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="grid items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-0 hover:bg-surface-raised"
                style={{
                  gridTemplateColumns: gridTemplate,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${String(item.start)}px)`,
                }}
              >
                {columns.map((col) => (
                  <div
                    key={col.id}
                    role="cell"
                    className={cn('flex min-w-0 items-center', ALIGN[col.align ?? 'left'])}
                  >
                    {col.cell(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
