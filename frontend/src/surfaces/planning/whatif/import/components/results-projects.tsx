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

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { OUTCOME_LABEL, OUTCOME_TONE } from '../../components/outcome-meta';
import type { ImportResultProject } from '../import-types';
import { weekOrDash } from '../week-labels';

const ROW_H = 40;
const VIRTUALIZE_OVER = 100;

function columns(base: number): ColumnDef<ImportResultProject>[] {
  return [
    {
      id: 'name',
      header: 'Project',
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      id: 'source',
      header: 'Source',
      accessorKey: 'source',
      cell: ({ row }) =>
        row.original.source === 'file' ? <Badge tone="primary">file</Badge> : <Badge tone="neutral">plan</Badge>,
    },
    { id: 'hub', header: 'Hub', accessorKey: 'hub' },
    { id: 'category', header: 'Category', accessorKey: 'category' },
    { id: 'priority', header: 'Priority', accessorKey: 'priority' },
    { id: 'status', header: 'Status', accessorKey: 'status' },
    {
      id: 'leader',
      header: 'Leader',
      accessorFn: (p) => p.leader_name ?? '',
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1">
          {row.original.leader_name ?? <span className="text-text-muted">none</span>}
          {row.original.leader_auto_assigned ? <Badge tone="warning">auto</Badge> : null}
          {row.original.no_leader ? <Badge tone="danger">no leader</Badge> : null}
        </span>
      ),
    },
    {
      id: 'finish',
      header: 'Finish',
      accessorFn: (p) => p.finish_week ?? Number.POSITIVE_INFINITY,
      cell: ({ row }) => (
        <span className="whitespace-nowrap tabular-nums">{weekOrDash(row.original.finish_week, base)}</span>
      ),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      accessorKey: 'outcome',
      cell: ({ row }) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge tone={OUTCOME_TONE[row.original.outcome]}>{OUTCOME_LABEL[row.original.outcome]}</Badge>
          {row.original.eng_conflict ? <Badge tone="warning">designer conflict</Badge> : null}
          {row.original.lab_overlap ? <Badge tone="warning">lab overlap</Badge> : null}
        </span>
      ),
    },
    {
      id: 'before_after',
      header: 'Before → after',
      accessorFn: (p) => p.before_finish_week ?? Number.POSITIVE_INFINITY,
      cell: ({ row }) => {
        const p = row.original;
        if (p.before_outcome === null && p.before_finish_week === null)
          return <span className="text-text-muted">new</span>;
        return (
          <span className="whitespace-nowrap tabular-nums">
            {weekOrDash(p.before_finish_week, base)} <span aria-hidden="true">→</span>
            <span className="sr-only"> to </span> {weekOrDash(p.finish_week, base)}
          </span>
        );
      },
    },
  ];
}

/** Every project of the result, sortable by any column (display order only). */
export function ResultsProjects({
  projects,
  baseYear,
}: {
  projects: readonly ImportResultProject[];
  baseYear: number;
}): React.JSX.Element {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const cols = React.useMemo(() => columns(baseYear), [baseYear]);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table + Virtual are the mandated table stack.
  const table = useReactTable({
    data: projects as ImportResultProject[],
    columns: cols,
    state: { sorting },
    onSortingChange: setSorting,
    sortDescFirst: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (p) => p.ref,
  });
  const rows = table.getRowModel().rows;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUALIZE_OVER;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
    initialRect: { width: 1100, height: 480 },
  });
  const items = virtual ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index, start: 0, end: 0 }));
  const top = virtual ? (items[0]?.start ?? 0) : 0;
  const bottom = virtual ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;

  return (
    <div
      ref={scrollRef}
      className="max-h-[30rem] overflow-auto rounded-md border border-border"
      role="region"
      aria-label="Projects of the What-if (scrollable)"
      tabIndex={0}
      data-testid="import-projects"
    >
      <table className="w-full min-w-[960px] border-collapse text-left text-xs" aria-label="Projects of the What-if">
        <thead className="sticky top-0 z-10 bg-surface-raised">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const dir = h.column.getIsSorted();
                return (
                  <th
                    key={h.id}
                    scope="col"
                    aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                    className="border-b border-border px-s2 py-1.5"
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={h.column.getToggleSortingHandler()}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {dir === 'asc' ? (
                        <ArrowUp className="size-3" aria-hidden="true" />
                      ) : dir === 'desc' ? (
                        <ArrowDown className="size-3" aria-hidden="true" />
                      ) : (
                        <ArrowUpDown className="size-3" aria-hidden="true" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody data-virtualized={virtual || undefined}>
          {top > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={cols.length} style={{ height: top, padding: 0 }} />
            </tr>
          ) : null}
          {items.map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            return (
              <tr
                key={row.id}
                style={{ height: ROW_H }}
                className={cn('border-b border-border')}
                data-testid="import-project-row"
              >
                {row.getVisibleCells().map((c) => (
                  <td key={c.id} className="px-s2 py-1">
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
          {bottom > 0 ? (
            <tr aria-hidden="true">
              <td colSpan={cols.length} style={{ height: bottom, padding: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
