import * as React from 'react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { BoltCard } from '@/components/ui/bolt-card';
import { Button } from '@/components/ui/button';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardInfo } from '@/components/ui/card-info';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RunProvenanceChips } from '@/components/ui/run-provenance-chips';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBookedPct, formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { HubCapacityRow, HubCapacitySummary, ScheduleRunSummary } from '../api/types';
import { pickAreaFigures, pickFigures, type CapacityHorizon } from '../lib/pick-figures';
import { HubSupplyDetail } from './hub-supply-breakdown';

/**
 * "Load vs. capacity per hub" as ONE compact table (P19-T01): a row per hub with
 * design load / capacity / booked %, lab load / capacity / booked %, and the two
 * served gaps. It replaces the long list of big per-hub cards; each row's
 * "Details" button opens a dialog with today's full figures, the two bars and
 * "How this is calculated" (`HubSupplyDetail`), rendered only while open.
 *
 * Every cell is one served field (I9/I19): `pickFigures` selects the year or
 * remaining field; the footer is the served `totals`. Nothing is summed here.
 * Lab figures are region-level and repeat on every hub of the region (noted in
 * the card's info popover and under each hub's region).
 */
const NUM = 'text-right font-mono tabular-nums whitespace-nowrap';

function Booked({ pct, status }: { pct: number | null; status: HubCapacityRow['design_booking_status_year'] }): React.JSX.Element {
  return (
    <TableCell className={NUM}>
      <span className="inline-flex items-center justify-end gap-1.5">
        <span>{formatBookedPct(pct)}</span>
        <BookingStatusChip status={status} />
      </span>
    </TableCell>
  );
}

function Gap({ value }: { value: number }): React.JSX.Element {
  return (
    <TableCell className={cn(NUM, value > 0 ? 'text-warning-subtle-fg' : 'text-text')}>
      {value > 0 ? '+' : ''}
      {formatDecimal(value)}
    </TableCell>
  );
}

export interface HubSummaryTableProps {
  data: HubCapacitySummary;
  activeRun: ScheduleRunSummary | null | undefined;
  horizon: CapacityHorizon;
}

export function HubSummaryTable({ data, activeRun, horizon }: HubSummaryTableProps): React.JSX.Element {
  const [detailHub, setDetailHub] = React.useState<string | null>(null);
  // The dialog is controlled (one dialog for all rows), so Radix has no trigger to
  // return focus to; remember the opening button and restore it on close.
  const openerRef = React.useRef<HTMLElement | null>(null);
  const detailRow = data.rows.find((r) => r.hub === detailHub) ?? null;
  const totalD = pickAreaFigures(data.totals, 'design', horizon);
  const totalL = pickAreaFigures(data.totals, 'lab', horizon);
  const capWord = horizon === 'year' ? 'cap (yr)' : 'cap (rem.)';

  return (
    <BoltCard>
      <CardHeader className="flex-wrap gap-y-s2">
        <CardTitle>Load vs. capacity per hub</CardTitle>
        <div className="flex flex-wrap items-center gap-s2">
          {data.has_active_schedule_run ? (
            <RunProvenanceChips
              scheduleRunVersion={data.schedule_run_version}
              activeRun={activeRun}
              leadIn="Load figures in this card are read directly from"
              srTail="Computed server-side and shown to two decimals (Invariant I17); none of it is recalculated in your browser."
            />
          ) : null}
          <CardInfo label="How load and capacity are defined">
            <p>
              <strong className="text-text">Design load</strong> = Σ design-step lead times for
              the hub&rsquo;s projects; <strong className="text-text">lab load</strong> = Σ
              lab-step lead times (&times;&nbsp;1.0) for the hub&rsquo;s lab region &mdash; both
              taken verbatim from the active run&rsquo;s booked steps (Invariants I6 / I7,
              ADR&nbsp;0007). The <strong className="text-text">estimated</strong> load is the
              projects&rsquo; hand-entered design / lab weeks, shown for comparison only.
            </p>
            <p>
              <strong className="text-text">Capacity</strong> is the client&rsquo;s own supply
              formula (ADR&nbsp;0008): working weeks per engineer &times; Σ FTE for design;
              Σ (working weeks &times; efficiency &times; platforms) over the region&rsquo;s
              chambers for lab. &ldquo;Remaining year&rdquo; (YTD 2026) scales by (52 &minus; current
              week) / 52. Gap = load &minus; capacity; completion = capacity / load.
            </p>
            <p>
              Lab figures are for the hub&rsquo;s lab region and repeat on every hub of that region.
              All of it is computed server-side and shown to two decimals (Invariant I17); none of
              it is recalculated in your browser.
            </p>
          </CardInfo>
        </div>
      </CardHeader>
      <CardContent className="space-y-s3">
        {!data.has_active_schedule_run ? (
          <EmptyState
            title="No schedule computed yet"
            description="No active schedule run exists. Once the schedule is calculated, per-hub design and lab load will appear here — sourced directly from that run (Invariants I6 / I7)."
            className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
          />
        ) : data.rows.length === 0 ? (
          <EmptyState
            title="No hubs in scope"
            description="The active schedule run produced no per-hub load in your hub scope."
            className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
          />
        ) : (
          <>
            <Table scrollLabel="Hub load versus capacity" data-testid="hub-summary-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Hub</TableHead>
                  <TableHead className="text-right">Design load</TableHead>
                  <TableHead className="text-right">Design {capWord}</TableHead>
                  <TableHead className="text-right">Design booked</TableHead>
                  <TableHead className="text-right">Design gap</TableHead>
                  <TableHead className="text-right">Lab load</TableHead>
                  <TableHead className="text-right">Lab {capWord}</TableHead>
                  <TableHead className="text-right">Lab booked</TableHead>
                  <TableHead className="text-right">Lab gap</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => {
                  const d = pickFigures(row, 'design', horizon);
                  const l = pickFigures(row, 'lab', horizon);
                  return (
                    <TableRow key={row.hub} data-testid={`hub-summary-row-${row.hub}`}>
                      <TableCell className="font-semibold text-text">
                        {row.hub}
                        <Badge tone="outline" className="ml-2 rounded-pill align-middle">
                          {row.lab_region}
                        </Badge>
                      </TableCell>
                      <TableCell className={NUM} data-testid="design-load">{formatDecimal(d.load)}</TableCell>
                      <TableCell className={NUM} data-testid="design-capacity">{formatDecimal(d.capacity)}</TableCell>
                      <Booked pct={d.bookedPct} status={d.bookingStatus} />
                      <Gap value={d.gap} />
                      <TableCell className={NUM} data-testid="lab-load">{formatDecimal(l.load)}</TableCell>
                      <TableCell className={NUM} data-testid="lab-capacity">{formatDecimal(l.capacity)}</TableCell>
                      <Booked pct={l.bookedPct} status={l.bookingStatus} />
                      <Gap value={l.gap} />
                      <TableCell className="text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={(e) => {
                            openerRef.current = e.currentTarget;
                            setDetailHub(row.hub);
                          }}
                          aria-label={`Details for ${row.hub}`}
                          aria-haspopup="dialog"
                        >
                          Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter>
                <TableRow data-testid="hub-summary-total">
                  <TableCell className="font-bold text-text">Total</TableCell>
                  <TableCell className={NUM}>{formatDecimal(totalD.load)}</TableCell>
                  <TableCell className={NUM}>{formatDecimal(totalD.capacity)}</TableCell>
                  <Booked pct={totalD.bookedPct} status={totalD.bookingStatus} />
                  <TableCell className={NUM}>—</TableCell>
                  <TableCell className={NUM}>{formatDecimal(totalL.load)}</TableCell>
                  <TableCell className={NUM}>{formatDecimal(totalL.capacity)}</TableCell>
                  <Booked pct={totalL.bookedPct} status={totalL.bookingStatus} />
                  <TableCell className={NUM}>—</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
            <p className="text-2xs text-text-muted">
              Weeks. Lab figures are for the hub&rsquo;s lab region and repeat on every hub of that region; the Total
              counts each lab region once.
            </p>
          </>
        )}
      </CardContent>

      <Dialog
        open={detailRow !== null}
        onOpenChange={(open) => {
          if (!open) setDetailHub(null);
        }}
      >
        <DialogContent
          className="max-h-[90vh] max-w-4xl overflow-y-auto"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            openerRef.current?.focus();
          }}
        >
          {detailRow ? (
            <>
              <DialogHeader>
                <DialogTitle>{detailRow.hub}: load vs. capacity</DialogTitle>
                <DialogDescription>
                  Full figures for this hub ({horizon === 'year' ? 'full year' : 'YTD 2026, remaining year'}), exactly as served.
                </DialogDescription>
              </DialogHeader>
              <HubSupplyDetail row={detailRow} horizon={horizon} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </BoltCard>
  );
}
