import * as React from 'react';
import { PanelRightOpen } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
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
import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import type { HubCapacityRow, HubCapacitySummary, ScheduleRunSummary } from '../api/types';
import {
  pickFigures,
  pickTotalUnitFigures,
  pickUnitFigures,
  UNIT_SHORT,
  type CapacityView,
} from '../lib/pick-figures';
import { groupRowsByLabRegion } from '../lib/region-groups';
import { HubSupplyDetail } from './hub-supply-breakdown';
import { formatFigure, formatPctCompact } from '../lib/status-format';
import { StatusLegend, StatusMark } from './status-mark';

/**
 * "Load vs. capacity per hub" as ONE compact table (P19-T01, tightened in P19-T02).
 *
 * Columns sit under two header bands, Design and Lab, each with Load / Cap. /
 * Booked / Gap. Rows are grouped by LAB REGION (a `<tbody>` per region with a
 * region sub-header row): the design figures are per hub, while the lab figures
 * are region-level (I7, ADR 0016), so they are shown ONCE per region in cells
 * that span the region's hub rows instead of repeating on every hub.
 *
 * Every cell is one served field (I9/I19): `pickFigures` selects the year or
 * remaining field, the lab cells read the group's first served row (every row of
 * a region carries the same served lab figures), and the footer is the served
 * `totals` (each lab region counted once, server-side). Nothing is summed here.
 *
 * The status is a small icon (a distinct shape per status, toned) with its label
 * as screen-reader text and a `title`; a legend under the table names the icons,
 * so status never rests on colour alone. Each row's Details icon button
 * ("Details for <hub>") opens the full per-hub figures in a dialog.
 *
 * P19-T05 (Weeks | Days): load and capacity (rows, lab cells per region, Total)
 * follow the page's unit, reading the SERVED day fields in Days. Booked % is
 * unit-free. The gap is served in weeks only, so in Days mode its column says
 * "Gap (wks)" and keeps the served weeks.
 */
const NUM = 'px-2 text-right font-mono tabular-nums whitespace-nowrap';
const HEAD = 'h-auto px-2 py-1.5';
/** Left rule that separates the Lab band from the Design band. */
const LAB_EDGE = 'border-l border-border';

function BookedCell({
  pct,
  status,
  className,
  rowSpan,
  testId,
}: {
  pct: number | null;
  status: BookingStatus;
  className?: string;
  rowSpan?: number;
  testId?: string;
}): React.JSX.Element {
  return (
    <TableCell className={cn(NUM, className)} rowSpan={rowSpan} data-testid={testId}>
      <span className="inline-flex items-center justify-end gap-1">
        <span>{formatPctCompact(pct)}</span>
        <StatusMark status={status} />
      </span>
    </TableCell>
  );
}

function GapCell({ value, className, rowSpan }: { value: number; className?: string; rowSpan?: number }): React.JSX.Element {
  return (
    <TableCell className={cn(NUM, value > 0 ? 'text-warning-subtle-fg' : 'text-text', className)} rowSpan={rowSpan}>
      {value > 0 ? '+' : ''}
      {formatDecimal(value)}
    </TableCell>
  );
}

function SubHead({ short, full, className }: { short: string; full: string; className?: string }): React.JSX.Element {
  return (
    <TableHead scope="col" className={cn(HEAD, 'text-right', className)}>
      {short === full ? (
        short
      ) : (
        <>
          <span aria-hidden="true" title={full}>
            {short}
          </span>
          <span className="sr-only">{full}</span>
        </>
      )}
    </TableHead>
  );
}

/** Why booked % sits near 100 % (checked against the served definitions, P19-T02). */
export const BOOKED_NEAR_100_NOTE =
  'Load counts every scheduled week, including work that spills past W52, and is not capped at capacity. Most full-year figures sit near 100% because the demo data’s engineer FTE and chamber efficiency were set to fit the scheduled load (ADR 0024); real rosters will move them.';

export interface HubSummaryTableProps {
  data: HubCapacitySummary;
  activeRun: ScheduleRunSummary | null | undefined;
  view: CapacityView;
}

export function HubSummaryTable({ data, activeRun, view }: HubSummaryTableProps): React.JSX.Element {
  const { horizon, unit } = view;
  const days = unit === 'days';
  const [detailHub, setDetailHub] = React.useState<string | null>(null);
  // The dialog is controlled (one dialog for all rows), so Radix has no trigger to
  // return focus to; remember the opening button and restore it on close.
  const openerRef = React.useRef<HTMLElement | null>(null);
  const detailRow = data.rows.find((r) => r.hub === detailHub) ?? null;
  const totalD = pickTotalUnitFigures(data.totals, 'design', view);
  const totalL = pickTotalUnitFigures(data.totals, 'lab', view);
  const capFull = horizon === 'year' ? 'Capacity, full year' : 'Capacity, remaining year';
  // Accessible unit suffix for the load / capacity headers; the gap is served in weeks only.
  const inUnit = `, in ${unit}`;
  const gapShort = days ? `Gap (${UNIT_SHORT.weeks})` : 'Gap';
  const groups = groupRowsByLabRegion(data.rows);

  const openDetails = (e: React.MouseEvent<HTMLElement>, row: HubCapacityRow): void => {
    openerRef.current = e.currentTarget;
    setDetailHub(row.hub);
  };

  return (
    <BoltCard className="min-w-0">
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
              week) / 52. Booked = load / capacity; gap = load &minus; capacity.
            </p>
            <p>
              <strong className="text-text">Why booked % sits near 100&nbsp;%.</strong> {BOOKED_NEAR_100_NOTE}
            </p>
            <p>
              Lab figures belong to a lab region, so the table groups hubs by region and shows each
              region&rsquo;s lab figures once; the Total counts each lab region once. All of it is
              computed server-side and shown to two decimals (Invariant I17); none of it is
              recalculated in your browser.
            </p>
          </CardInfo>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 space-y-s3">
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
            <p className="text-xs text-text-muted" data-testid="hub-summary-booked-note">
              {BOOKED_NEAR_100_NOTE}
            </p>
            <Table scrollLabel="Hub load versus capacity" data-testid="hub-summary-table">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" rowSpan={2} className={cn(HEAD, 'first:ps-3')}>
                    Hub
                  </TableHead>
                  <TableHead scope="colgroup" colSpan={4} className={cn(HEAD, 'text-center')}>
                    Design
                  </TableHead>
                  <TableHead scope="colgroup" colSpan={4} className={cn(HEAD, LAB_EDGE, 'text-center')}>
                    Lab <span className="font-medium normal-case tracking-normal">(per lab region)</span>
                  </TableHead>
                  <TableHead scope="col" rowSpan={2} className={cn(HEAD, 'last:pe-3')}>
                    <span className="sr-only">Details</span>
                  </TableHead>
                </TableRow>
                <TableRow>
                  <SubHead short="Load" full={`Design load${inUnit}`} />
                  <SubHead short="Cap." full={`Design ${capFull.toLowerCase()}${inUnit}`} />
                  <SubHead short="Booked" full="Design booked" />
                  <SubHead short={gapShort} full="Design gap, in weeks" />
                  <SubHead short="Load" full={`Lab load${inUnit}`} className={LAB_EDGE} />
                  <SubHead short="Cap." full={`Lab ${capFull.toLowerCase()}${inUnit}`} />
                  <SubHead short="Booked" full="Lab booked" />
                  <SubHead short={gapShort} full="Lab gap, in weeks" />
                </TableRow>
              </TableHeader>
              {groups.map((group) => {
                const first = group.rows[0] as HubCapacityRow;
                const lab = pickUnitFigures(first, 'lab', view);
                const labGap = pickFigures(first, 'lab', horizon).gap;
                const span = group.rows.length;
                return (
                  <TableBody key={group.region} data-testid={`hub-summary-region-${group.region}`}>
                    <TableRow className="bg-surface-sunken/60 hover:bg-surface-sunken/60">
                      <TableHead
                        scope="rowgroup"
                        colSpan={10}
                        className={cn(HEAD, 'first:ps-3 text-2xs normal-case tracking-normal text-text-muted')}
                      >
                        <span className="font-bold text-text">{group.region} lab region</span>
                        <span>
                          {' '}
                          · {span === 1 ? 'lab figures for its one hub' : `lab figures shown once for its ${String(span)} hubs`}
                        </span>
                      </TableHead>
                    </TableRow>
                    {group.rows.map((row, i) => {
                      const d = pickUnitFigures(row, 'design', view);
                      const dGap = pickFigures(row, 'design', horizon).gap;
                      return (
                        <TableRow key={row.hub} data-testid={`hub-summary-row-${row.hub}`}>
                          <TableHead
                            scope="row"
                            className="h-auto whitespace-nowrap px-2 py-2 text-sm font-semibold normal-case tracking-normal text-text first:ps-3"
                          >
                            {row.hub}
                          </TableHead>
                          <TableCell className={NUM} data-testid="design-load">{formatFigure(d.load)}</TableCell>
                          <TableCell className={NUM} data-testid="design-capacity">{formatFigure(d.capacity)}</TableCell>
                          <BookedCell pct={d.bookedPct} status={d.bookingStatus} testId="design-booked" />
                          <GapCell value={dGap} />
                          {i === 0 ? (
                            <>
                              <TableCell
                                rowSpan={span}
                                className={cn(NUM, LAB_EDGE, 'bg-surface-sunken/40')}
                                data-testid="lab-load"
                              >
                                {formatFigure(lab.load)}
                              </TableCell>
                              <TableCell rowSpan={span} className={cn(NUM, 'bg-surface-sunken/40')} data-testid="lab-capacity">
                                {formatFigure(lab.capacity)}
                              </TableCell>
                              <BookedCell
                                pct={lab.bookedPct}
                                status={lab.bookingStatus}
                                rowSpan={span}
                                className="bg-surface-sunken/40"
                                testId="lab-booked"
                              />
                              <GapCell value={labGap} rowSpan={span} className="bg-surface-sunken/40" />
                            </>
                          ) : null}
                          <TableCell className="px-2 py-1 text-right last:pe-3">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              onClick={(e) => {
                                openDetails(e, row);
                              }}
                              aria-label={`Details for ${row.hub}`}
                              aria-haspopup="dialog"
                              title={`Details for ${row.hub}`}
                            >
                              <PanelRightOpen aria-hidden="true" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                );
              })}
              <TableFooter>
                <TableRow data-testid="hub-summary-total">
                  <TableHead
                    scope="row"
                    className="h-auto px-2 py-2 text-sm font-bold normal-case tracking-normal text-text first:ps-3"
                  >
                    Total
                  </TableHead>
                  <TableCell className={NUM} data-testid="total-design-load">{formatFigure(totalD.load)}</TableCell>
                  <TableCell className={NUM} data-testid="total-design-capacity">{formatFigure(totalD.capacity)}</TableCell>
                  <BookedCell pct={totalD.bookedPct} status={totalD.bookingStatus} />
                  <TableCell className={NUM}>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">not shown</span>
                  </TableCell>
                  <TableCell className={cn(NUM, LAB_EDGE)} data-testid="total-lab-load">{formatFigure(totalL.load)}</TableCell>
                  <TableCell className={NUM} data-testid="total-lab-capacity">{formatFigure(totalL.capacity)}</TableCell>
                  <BookedCell pct={totalL.bookedPct} status={totalL.bookingStatus} />
                  <TableCell className={NUM}>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">not shown</span>
                  </TableCell>
                  <TableCell className="last:pe-3" />
                </TableRow>
              </TableFooter>
            </Table>
            <div data-testid="hub-summary-legend">
              <StatusLegend fullPct={data.full_threshold_pct} nearFullPct={data.near_full_threshold_pct}>
                <span data-testid="hub-summary-unit-note">
                  {days
                    ? 'Load and capacity in working days (served: weeks × the hub’s working days per week; lab uses its region’s). Gap in weeks (no served day gap). Total counts each lab region once.'
                    : 'Weeks. Total counts each lab region once.'}
                </span>
              </StatusLegend>
            </div>
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
                  Full figures for this hub ({horizon === 'year' ? 'full year' : 'YTD 2026, remaining year'}, in {unit}),
                  exactly as served.
                </DialogDescription>
              </DialogHeader>
              <HubSupplyDetail row={detailRow} view={view} />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </BoltCard>
  );
}
