import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { cn } from '@/lib/utils';

/**
 * Row-virtualized, horizontally-scrolling data grid for the Prioritization
 * Matrix (TanStack Virtual — CLAUDE.md: "Virtualize any list over 100 rows …
 * 236 projects × 14 steps is the baseline"). The Matrix is wide (identity +
 * score + 13 dimension columns + 5 financial columns), so header and body share
 * a single `overflow-x:auto` scroll container with a sticky header row — the
 * page body never scrolls horizontally.
 *
 * Pattern adapted from `src/surfaces/dashboard/components/virtual-data-table.tsx`
 * (kept dashboard-local by that task); this variant adds the shared horizontal
 * scroll + fixed pixel column widths the wide grid needs.
 */

export interface MatrixColumn<Row> {
  id: string;
  header: React.ReactNode;
  /** Fixed column width in px. */
  width: number;
  cell: (row: Row) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Extra classes for the header cell. */
  headerClassName?: string;
  /** Sticky to the left edge (identity columns). */
  sticky?: boolean;
  /** P13-T14: an optional per-column filter control (the mock-up's "Filter…"
   *  inputs), rendered in a second sticky header row. */
  filter?: React.ReactNode;
}

export interface VirtualMatrixGridProps<Row> {
  rows: Row[];
  columns: MatrixColumn<Row>[];
  rowKey: (row: Row) => string;
  caption: string;
  estimateRowHeight?: number;
  maxHeight?: number;
  className?: string;
}

const ALIGN: Record<NonNullable<MatrixColumn<unknown>['align']>, string> = {
  left: 'justify-start text-left',
  right: 'justify-end text-right',
  center: 'justify-center text-center',
};

export function VirtualMatrixGrid<Row>({
  rows,
  columns,
  rowKey,
  caption,
  estimateRowHeight = 44,
  maxHeight = 560,
  className,
}: VirtualMatrixGridProps<Row>): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const stickyOffsets = React.useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const col of columns) {
      offsets.push(acc);
      if (col.sticky) acc += col.width;
    }
    return offsets;
  }, [columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();
  const hasFilters = columns.some((c) => c.filter !== undefined);

  function cellStyle(col: MatrixColumn<Row>, index: number): React.CSSProperties {
    const base: React.CSSProperties = { width: col.width, flex: `0 0 ${String(col.width)}px` };
    if (col.sticky) {
      return {
        ...base,
        position: 'sticky',
        left: stickyOffsets[index] ?? 0,
        zIndex: 1,
      };
    }
    return base;
  }

  return (
    <div
      className={cn('overflow-hidden rounded-dash border-[1.5px] border-border bg-surface', className)}
    >
      <div
        ref={scrollRef}
        className="overflow-auto scrollbar-thin"
        style={{ maxHeight }}
        data-testid="matrix-grid-scroll"
      >
        <div role="table" aria-label={caption} aria-rowcount={rows.length} style={{ minWidth: totalWidth }}>
          <div className="sticky top-0 z-10">
          <div
            role="row"
            className="flex border-b-[1.5px] border-border bg-surface-sunken text-2xs font-bold uppercase tracking-wider text-text-subtle"
          >
            {columns.map((col, i) => (
              <div
                key={col.id}
                role="columnheader"
                className={cn(
                  'flex items-center px-3 py-3',
                  ALIGN[col.align ?? 'left'],
                  col.sticky && 'bg-surface-sunken',
                  col.headerClassName,
                )}
                style={cellStyle(col, i)}
              >
                {col.header}
              </div>
            ))}
          </div>
          {hasFilters ? (
            <div
              role="row"
              className="flex border-b border-border bg-surface-sunken"
              data-testid="matrix-filter-row"
            >
              {columns.map((col, i) => (
                <div
                  key={col.id}
                  role="cell"
                  className={cn('flex items-center px-2 py-1.5', col.sticky && 'bg-surface-sunken')}
                  style={cellStyle(col, i)}
                >
                  {col.filter ?? null}
                </div>
              ))}
            </div>
          ) : null}
          </div>

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              return (
                <div
                  key={rowKey(row)}
                  role="row"
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 flex w-full border-b border-border/70 text-xs transition-colors last:border-0 hover:bg-primary-subtle/40"
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                >
                  {columns.map((col, i) => (
                    <div
                      key={col.id}
                      role="cell"
                      className={cn(
                        'flex min-w-0 items-center px-3 py-2.5',
                        ALIGN[col.align ?? 'left'],
                        col.sticky && 'bg-surface',
                      )}
                      style={cellStyle(col, i)}
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
    </div>
  );
}
