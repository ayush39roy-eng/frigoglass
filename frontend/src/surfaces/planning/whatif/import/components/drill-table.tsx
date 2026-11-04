import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

const ROW_H = 40;
const VIRTUALIZE_OVER = 100;

/**
 * The drill-down sheet's compact sortable table (P32-R07): TanStack Table for sorting,
 * TanStack Virtual above 100 rows (a figure can stand for every project of the run). Display
 * order only; the rows are the selection's served projects / rows as they are.
 */
export function DrillTable<T>({
  data,
  columns,
  rowId,
  label,
  rowTestId,
  minWidth = 900,
}: {
  data: readonly T[];
  columns: ColumnDef<T>[];
  rowId: (row: T) => string;
  label: string;
  rowTestId: string;
  minWidth?: number;
}): React.JSX.Element {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table + Virtual are the mandated table stack.
  const table = useReactTable({
    data: data as T[],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    sortDescFirst: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: rowId,
  });
  const rows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_OVER;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    initialRect: { width: 1000, height: 600 },
  });
  const items = virtual ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index, start: 0, end: 0 }));
  const top = virtual ? (items[0]?.start ?? 0) : 0;
  const bottom = virtual ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
      role="region"
      aria-label={`${label} (scrollable)`}
      tabIndex={0}
    >
      <table className="w-full border-collapse text-left text-xs" style={{ minWidth }} aria-label={label}>
        <thead className="sticky top-0 z-10 bg-surface-raised">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const sortable = h.column.getCanSort();
                const dir = h.column.getIsSorted();
                const header = flexRender(h.column.columnDef.header, h.getContext());
                return (
                  <th
                    key={h.id}
                    scope="col"
                    aria-sort={sortable ? (dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none') : undefined}
                    className="whitespace-nowrap border-b border-border px-s2 py-1.5"
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        {header}
                        {dir === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        ) : dir === 'desc' ? (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowUpDown className="size-3" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      <span className="text-2xs font-semibold uppercase tracking-wide text-text-muted">{header}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody data-virtualized={virtual || undefined}>
          {top > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: top, padding: 0 }} />
            </tr>
          ) : null}
          {items.map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            return (
              <tr key={row.id} style={{ height: ROW_H }} className="border-b border-border" data-testid={rowTestId} data-id={row.id}>
                {row.getVisibleCells().map((c) => (
                  <td key={c.id} className="px-s2 py-1 align-middle">
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
          {bottom > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: bottom, padding: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
