import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { cn } from '@/lib/utils';

import { columnLines, type MatrixBox } from '../lib/grid-boxes';

import './virtual-matrix-grid.css';

/**
 * Row-virtualized, horizontally-scrolling data grid for the Prioritization
 * Matrix (TanStack Virtual — CLAUDE.md: "Virtualize any list over 100 rows …
 * 236 projects × 14 steps is the baseline"). The Matrix is wide (identity +
 * info + 13 rubric columns in 5 pillar boxes + Score /100), so header and body share
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
  headerClassName?: string | undefined;
  /** Sticky to the left edge (identity columns). */
  sticky?: boolean;
  /** P13-T14: an optional per-column filter control (the mock-up's "Filter…"
   *  inputs), rendered in a second sticky header row. */
  filter?: React.ReactNode;
  /** P21: header band label (the pillar). Consecutive columns with the same
   *  group share one band cell above their headers. */
  group?: string;
  /** Extra classes for every body cell of this column. */
  cellClassName?: string | undefined;
  /** P21-T03: the visual box this column belongs to. Consecutive columns with
   *  the same `box.id` form one box; a box boundary draws a separator (3 px
   *  between blocks, 2 px between pillars), cells inside a pillar get a 1 px
   *  inner line, and `tint` washes the whole box (header to last row). */
  box?: MatrixBox;
}

export type { MatrixBox, MatrixBoxKind, MatrixLine } from '../lib/grid-boxes';

export interface VirtualMatrixGridProps<Row> {
  rows: Row[];
  columns: MatrixColumn<Row>[];
  rowKey: (row: Row) => string;
  caption: string;
  estimateRowHeight?: number;
  /** Max height of the scroll region (px or any CSS length). */
  maxHeight?: number | string | undefined;
  className?: string;
  /** P21: the scroll region's accessible name (it is a focusable, labelled region). */
  regionLabel?: string;
  /** P21-T03: a checked (selected) row is highlighted across every cell. */
  isRowSelected?: ((row: Row) => boolean) | undefined;
}

interface BandCell {
  key: string;
  label: string | null;
  width: number;
  span: number;
  /** Index of the first column, for sticky offsets. */
  first: number;
  sticky: boolean;
}

function bandCells<Row>(columns: MatrixColumn<Row>[]): BandCell[] {
  const out: BandCell[] = [];
  columns.forEach((col, i) => {
    const prev = out[out.length - 1];
    if (col.group !== undefined && prev && prev.label === col.group && !col.sticky) {
      prev.width += col.width;
      prev.span += 1;
      return;
    }
    out.push({
      key: col.group !== undefined ? `g-${col.group}-${String(i)}` : `c-${col.id}`,
      label: col.group ?? null,
      width: col.width,
      span: 1,
      first: i,
      sticky: col.sticky === true,
    });
  });
  return out;
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
  maxHeight,
  className,
  regionLabel,
  isRowSelected,
}: VirtualMatrixGridProps<Row>): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // The frozen block casts its shadow only once the grid is scrolled sideways.
  // A DOM attribute (not React state) so scrolling never re-renders the rows.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const sync = () => {
      const next = el.scrollLeft > 0 ? 'true' : 'false';
      if (el.dataset.scrolledX !== next) el.dataset.scrolledX = next;
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    return () => el.removeEventListener('scroll', sync);
  }, []);

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
  const bands = columns.some((c) => c.group !== undefined) ? bandCells(columns) : null;
  const lines = React.useMemo(() => columnLines(columns), [columns]);
  const lastSticky = columns.reduce((last, c, i) => (c.sticky ? i : last), -1);

  /** Box markers shared by the header, filter and body cells of column `i`. */
  function boxAttrs(i: number, last = i): Record<string, string | undefined> {
    const box = columns[i]?.box;
    const isStart = box !== undefined && (i === 0 || columns[i - 1]?.box?.id !== box.id);
    const isEnd = box !== undefined && columns[last + 1]?.box?.id !== box.id;
    return {
      'data-line': lines[i] ?? 'none',
      'data-box-kind': box?.kind,
      'data-tint': box?.tint ? 'true' : undefined,
      'data-pillar-start': box?.kind === 'pillar' && isStart ? box.id : undefined,
      'data-pillar-end': box?.kind === 'pillar' && isEnd ? box.id : undefined,
    };
  }

  function cellClasses(col: MatrixColumn<Row>, i: number): string {
    return cn('mg-cell', col.sticky && 'mg-cell-sticky', i === lastSticky && 'mg-frozen-edge');
  }

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
        className="mg-scroll overflow-auto scrollbar-thin focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ maxHeight: maxHeight ?? 560 }}
        data-testid="matrix-grid-scroll"
        // A scrollable region must be keyboard reachable (axe scrollable-region-focusable).
        role={regionLabel ? 'region' : undefined}
        aria-label={regionLabel}
        tabIndex={regionLabel ? 0 : undefined}
      >
        <div role="table" aria-label={caption} aria-rowcount={rows.length} style={{ minWidth: totalWidth }}>
          <div className="mg-head sticky top-0 z-10">
          {bands ? (
            <div
              role="row"
              className="flex border-b border-border-strong bg-surface-sunken text-2xs font-bold uppercase tracking-wider text-text-muted"
              data-testid="matrix-pillar-row"
            >
              {bands.map((b) => (
                <div
                  key={b.key}
                  role="columnheader"
                  aria-colspan={b.span > 1 ? b.span : undefined}
                  {...boxAttrs(b.first, b.first + b.span - 1)}
                  className={cn(
                    cellClasses(columns[b.first] as MatrixColumn<Row>, b.first),
                    'mg-band flex items-center px-2 py-1.5 leading-tight',
                    b.label !== null && 'justify-center text-center text-text',
                  )}
                  style={
                    b.sticky
                      ? { width: b.width, flex: `0 0 ${String(b.width)}px`, position: 'sticky', left: stickyOffsets[b.first] ?? 0, zIndex: 1 }
                      : { width: b.width, flex: `0 0 ${String(b.width)}px` }
                  }
                  title={b.label ?? undefined}
                >
                  {b.label}
                </div>
              ))}
            </div>
          ) : null}
          <div
            role="row"
            className="flex border-b-2 border-border-strong bg-surface-sunken text-2xs font-bold uppercase tracking-wider text-text-subtle"
            data-testid="matrix-header-row"
          >
            {columns.map((col, i) => (
              <div
                key={col.id}
                role="columnheader"
                {...boxAttrs(i)}
                className={cn(
                  cellClasses(col, i),
                  'flex items-center px-3 py-2 leading-tight',
                  ALIGN[col.align ?? 'left'],
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
                  {...boxAttrs(i)}
                  className={cn(cellClasses(col, i), 'flex items-center px-2 py-1.5')}
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
              const selected = isRowSelected?.(row) === true;
              return (
                <div
                  key={rowKey(row)}
                  role="row"
                  data-index={item.index}
                  data-zebra={item.index % 2 === 1 ? 'odd' : 'even'}
                  data-selected={selected ? 'true' : undefined}
                  ref={virtualizer.measureElement}
                  className="mg-row absolute left-0 top-0 flex w-full text-xs"
                  style={{ transform: `translateY(${String(item.start)}px)` }}
                >
                  {columns.map((col, i) => (
                    <div
                      key={col.id}
                      role="cell"
                      {...boxAttrs(i)}
                      className={cn(
                        cellClasses(col, i),
                        'flex min-w-0 items-center px-3 py-2',
                        ALIGN[col.align ?? 'left'],
                        col.cellClassName,
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
