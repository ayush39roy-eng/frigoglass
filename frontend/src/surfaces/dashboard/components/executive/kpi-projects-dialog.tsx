import * as React from 'react';
import { Link } from 'react-router-dom';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatInteger, formatPlanWeek } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { CompletingWithinYearRow } from '../../api/types';
import { KPI_BUCKET_META, selectOutcomeRows, type KpiBucket } from '../../lib/executive';
import { outcomeLabel, outcomeOf, OUTCOME_STYLE } from '../../lib/outcome';
import { VirtualDataTable, type VirtualColumn } from '../virtual-data-table';

/**
 * The data behind an Executive KPI tile (P28 addendum): a dialog listing
 * exactly the already-fetched `completing-within-year` rows whose served flags
 * put them in the tile's bucket (`lib/executive.ts::selectOutcomeRows` — pure
 * selection, I9). Rows render through the shared `VirtualDataTable` (TanStack
 * Virtual), so even the largest bucket (left out, 100+) scrolls virtualized.
 * Each project links to its Workspace — the same target as the register and
 * risks rows. Radix returns focus to the opening tile on close.
 */
export function KpiProjectsDialog({
  bucket,
  rows,
  onClose,
  returnFocusTo,
}: {
  bucket: KpiBucket | null;
  rows: readonly CompletingWithinYearRow[];
  onClose: () => void;
  /** The tile that opened the dialog — focus goes back to it on close,
   *  explicitly (deterministic across browsers and jsdom). */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const selected = React.useMemo(
    () => (bucket === null ? [] : selectOutcomeRows(rows, bucket)),
    [rows, bucket],
  );

  const columns = React.useMemo<VirtualColumn<CompletingWithinYearRow>[]>(
    () => [
      {
        id: 'project',
        header: 'Project',
        width: 'minmax(10rem, 2fr)',
        cell: (row) => (
          <Link
            to={`/projects/${row.project_id}`}
            className="min-w-0 truncate text-xs font-semibold text-text underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={row.project_name}
          >
            {row.project_name}
          </Link>
        ),
      },
      {
        id: 'hub',
        header: 'Hub',
        width: 'minmax(6rem, 1fr)',
        cell: (row) => <span className="text-xs text-text-muted">{row.hub}</span>,
      },
      {
        id: 'priority',
        header: 'Priority',
        width: '5rem',
        cell: (row) =>
          row.priority ? <PriorityBandPill priority={row.priority} /> : <span className="text-xs text-text-muted">—</span>,
      },
      {
        id: 'end-week',
        header: 'End week',
        width: '6rem',
        align: 'right',
        cell: (row) => (
          <span className="text-xs tabular-nums text-text" data-numeric="">
            {row.last_step_end_week === null ? '—' : formatPlanWeek(row.last_step_end_week)}
          </span>
        ),
      },
      {
        id: 'outcome',
        header: 'Outcome',
        width: '10rem',
        cell: (row) => {
          const b = outcomeOf(row);
          return (
            <span className={cn('inline-flex items-center rounded-pill px-2 py-0.5 text-2xs font-semibold', OUTCOME_STYLE[b].chip)}>
              {outcomeLabel(b)}
            </span>
          );
        },
      },
    ],
    [],
  );

  const meta = bucket === null ? null : KPI_BUCKET_META[bucket];

  return (
    <Dialog open={bucket !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="flex max-h-[calc(100vh-4rem)] max-w-3xl flex-col motion-reduce:animate-none"
        data-testid="exec-kpi-dialog"
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.current;
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        {meta ? (
          <>
            <DialogHeader>
              <DialogTitle data-testid="exec-kpi-dialog-title">
                {meta.title} — {formatInteger(selected.length)} {selected.length === 1 ? 'project' : 'projects'}
              </DialogTitle>
              <DialogDescription>
                The active run&apos;s rows behind this figure, selected by their served outcome flags. Click a
                project to open its workspace.
              </DialogDescription>
            </DialogHeader>
            {selected.length === 0 ? (
              <p className="text-sm text-text-muted">No projects in this bucket.</p>
            ) : (
              <VirtualDataTable
                rows={selected}
                columns={columns}
                rowKey={(row) => row.project_id}
                caption={meta.title}
                maxHeight={420}
              />
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
