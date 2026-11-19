import * as React from 'react';
import { Link } from 'react-router-dom';

import { DeliveryByYearTable, type DeliveryCellRef } from '@/components/shared/delivery-by-year/delivery-by-year-table';
import { WeekText } from '@/components/shared/week-text';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatInteger } from '@/lib/format';
import { farFinishText, leftOutReasonText } from '@/lib/left-out-reason';
import type { HubSelection } from '@/stores/hub-filter';
import type { DeliveryDrillRow } from '@/types/delivery-by-year';

import type { DashboardSelection, DeliveryDrillQuery } from '../api/dashboard-api';
import type { CompletingWithinYear } from '../api/types';
import { useDeliveryByYearProjects } from '../hooks/use-delivery-by-year';
import { VirtualDataTable, type VirtualColumn } from './virtual-data-table';

/**
 * P53 (ADR 0063, R53-3): the Dashboard / Executive "Delivered by year" card.
 * The table is the served `delivery_by_year` of `GET
 * /dashboard/completing-within-year` (its first row equals the Within-year
 * KPI, I59). Clicking a figure lists the projects behind it from the served
 * drill-in (`GET /dashboard/delivery-by-year/projects`), hub-scoped and with
 * the Dashboard filters. Nothing is counted in the browser. Far-finish
 * warnings are counts only here (no leader names, OQ #8).
 */
export function DeliveryByYearCard({
  data,
  hub,
  selection,
}: {
  data: CompletingWithinYear;
  hub: HubSelection;
  selection: DashboardSelection;
}): React.JSX.Element {
  const [open, setOpen] = React.useState<{ query: DeliveryDrillQuery; title: string; expected: number } | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const onOpen = React.useCallback((cell: DeliveryCellRef, opener: HTMLElement) => {
    openerRef.current = opener;
    const v =
      cell.band === 'P1' ? cell.row.p1 : cell.band === 'P2' ? cell.row.p2 : cell.band === 'P3' ? cell.row.p3 : cell.row.total;
    setOpen({
      query: { kind: cell.row.kind, year: cell.row.year, band: cell.band },
      title: `${cell.row.label}${cell.band ? ` · ${cell.band}` : ''}`,
      expected: v,
    });
  }, []);

  return (
    <Card data-testid="delivery-by-year-card">
      <CardContent className="pt-s4">
        <DeliveryByYearTable
          data={data.delivery_by_year ?? null}
          unavailable={data.delivery_by_year_unavailable ?? null}
          rulesLabel={data.rules_label ?? null}
          tailWarnings={data.tail_warnings ?? null}
          onOpen={onOpen}
        />
      </CardContent>
      <DeliveryDrillDialog
        request={open}
        hub={hub}
        selection={selection}
        onClose={() => setOpen(null)}
        returnFocusTo={openerRef}
        horizonYears={data.delivery_by_year?.horizon_years ?? null}
      />
    </Card>
  );
}

function columns(horizonYears: number | null): VirtualColumn<DeliveryDrillRow>[] {
  return [
    {
      id: 'project',
      header: 'Project',
      width: 'minmax(12rem, 2.4fr)',
      cell: (row) => (
        <Link
          to={`/projects/${row.project_id}`}
          className="truncate text-xs font-semibold text-text underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={row.project_name}
        >
          {row.project_name}
        </Link>
      ),
    },
    { id: 'hub', header: 'Hub', width: 'minmax(6rem, 1fr)', cell: (row) => <span className="truncate text-xs">{row.hub}</span> },
    { id: 'band', header: 'Band', width: '4rem', cell: (row) => <span className="text-xs font-semibold">{row.band ?? '—'}</span> },
    {
      id: 'finish',
      header: 'Finish',
      width: '6rem',
      align: 'right',
      cell: (row) => (
        <span className="text-xs tabular-nums" data-numeric="">
          {row.completion_week === null ? '—' : <WeekText week={row.completion_week} />}
        </span>
      ),
    },
    {
      id: 'note',
      header: 'Note',
      width: 'minmax(10rem, 1.6fr)',
      cell: (row) => (
        <span className="truncate text-2xs text-text-muted">
          {row.left_out_reason
            ? leftOutReasonText(row.left_out_reason, horizonYears)
            : row.far_finish
              ? farFinishText(row.delivery_year)
              : ''}
        </span>
      ),
    },
  ];
}

function DeliveryDrillDialog({
  request,
  hub,
  selection,
  onClose,
  returnFocusTo,
  horizonYears,
}: {
  request: { query: DeliveryDrillQuery; title: string; expected: number } | null;
  hub: HubSelection;
  selection: DashboardSelection;
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLElement | null>;
  horizonYears: number | null;
}): React.JSX.Element {
  const query = useDeliveryByYearProjects(request?.query ?? null, hub, selection);
  const rows = query.data?.rows ?? [];
  const mismatch = request !== null && query.data !== undefined && rows.length !== request.expected;
  const cols = React.useMemo(() => columns(horizonYears), [horizonYears]);
  return (
    <Dialog open={request !== null} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="flex max-h-[calc(100vh-4rem)] max-w-4xl flex-col motion-reduce:animate-none"
        data-testid="delivery-drill-dialog"
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo.current;
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        {request ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {request.title} — {formatInteger(request.expected)} {request.expected === 1 ? 'project' : 'projects'}
              </DialogTitle>
              <DialogDescription>
                The projects behind this figure in the active schedule run, with the Dashboard&apos;s current
                filters.
              </DialogDescription>
            </DialogHeader>
            {query.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : query.isError ? (
              <p className="text-xs text-danger">The project list could not be loaded.</p>
            ) : (
              <>
                {mismatch ? (
                  <p className="text-2xs text-warning-subtle-fg" data-testid="delivery-drill-mismatch">
                    The data changed since the table loaded: {formatInteger(rows.length)} listed now.
                  </p>
                ) : null}
                <VirtualDataTable
                  rows={rows}
                  columns={cols}
                  rowKey={(r) => r.project_id}
                  caption={`Projects: ${request.title}`}
                />
              </>
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
