import * as React from 'react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardInfo } from '@/components/ui/card-info';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBookedPct, formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { CapacityTotals, HubCapacityRow } from '../api/types';
import { pickAreaFigures, pickFigures, type CapacityHorizon } from '../lib/pick-figures';
import { BUCKET_SHORT, PRIORITY_BUCKETS } from '../lib/priority-split';

/**
 * P13-T11: the mock-up's "Global Resource Utilization Matrix" — one row per hub
 * with design capacity, load, utilization (the served booked %) and the served
 * per-priority design load, then the same for lab.
 *
 * Built from `GET /capacity/hub-load` rows (API_CONTRACT_P13 §6: our
 * `/capacity/utilization-matrix` is the chamber/week grid, not a hub table, so
 * the hub rows' fields are reused). "Util." is the served
 * `*_booked_pct_{year,remaining}` (ADR 0016, I19) — never load / capacity here.
 *
 * Lab figures are region-level and repeat on every hub of the region, as in the
 * per-hub cards. The TOTAL row is the served `totals` (P13-T11 addendum: design
 * per hub, lab once per region, with its served booked % and status) for the
 * selected horizon — the browser adds nothing up.
 */
export interface HubUtilizationMatrixProps {
  rows: HubCapacityRow[];
  /** The served `HubCapacitySummary.totals`. */
  totals: CapacityTotals;
  horizon: CapacityHorizon;
}

const NUM = 'text-right font-mono tabular-nums';

function UtilCell({
  pct,
  status,
  onInk = false,
}: {
  pct: number | null;
  status: HubCapacityRow['design_booking_status_year'];
  /** On the ink total row the figure keeps the ink foreground (contrast); the chip carries the status. */
  onInk?: boolean;
}): React.JSX.Element {
  return (
    <TableCell className={cn(NUM, 'whitespace-nowrap')}>
      <span className="inline-flex items-center justify-end gap-1.5">
        <span
          className={cn(
            onInk ? 'font-bold' : status === 'full' ? 'text-danger-subtle-fg' : status === 'near_full' ? 'text-warning-subtle-fg' : 'text-text',
          )}
        >
          {formatBookedPct(pct)}
        </span>
        <BookingStatusChip status={status} className="hidden xl:inline-flex" />
      </span>
    </TableCell>
  );
}

export function HubUtilizationMatrix({ rows, totals, horizon }: HubUtilizationMatrixProps): React.JSX.Element {
  const totalD = pickAreaFigures(totals, 'design', horizon);
  const totalL = pickAreaFigures(totals, 'lab', horizon);
  const capHead = horizon === 'year' ? 'cap (yr)' : 'cap (rem.)';

  return (
    <BoltCard>
      <CardHeader className="flex-wrap gap-y-s2">
        <CardTitle>Global resource utilization matrix</CardTitle>
        <div className="flex flex-wrap items-center gap-s2">
          <span className="text-2xs text-text-muted">All values in weeks</span>
          <CardInfo label="How the utilization matrix is built">
            <p>
              One row per hub from the active run. <strong className="text-text">Util.</strong> is the served booked %
              (load / capacity, ADR&nbsp;0016) for the selected horizon. <strong className="text-text">P1-D … Q-D</strong>{' '}
              and <strong className="text-text">P1-L … Q-L</strong> are the served design and lab load per priority
              bucket; &ldquo;Q&rdquo; is a project whose priority is Q or not set.
            </p>
            <p>
              Lab figures belong to the hub&rsquo;s lab region and repeat on every hub of that region. The total row
              counts each lab region once; every total figure, including its booked %, is served.
            </p>
          </CardInfo>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-dash border border-dash-hairline">
          <Table
            className="min-w-[72rem] text-xs"
            data-testid="hub-utilization-matrix"
            scrollLabel="Hub utilization matrix"
          >
            <TableHeader className="bg-ink text-ink-fg [&_th]:text-ink-fg">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Hub</TableHead>
                <TableHead scope="col" className="text-right">Design {capHead}</TableHead>
                <TableHead scope="col" className="text-right">Design load</TableHead>
                <TableHead scope="col" className="text-right">D. util.</TableHead>
                {PRIORITY_BUCKETS.map((b) => (
                  <TableHead key={`d-${b}`} scope="col" className="text-right">
                    {BUCKET_SHORT[b]}-D
                  </TableHead>
                ))}
                <TableHead scope="col" className="border-l border-ink-fg/20 text-right">
                  Lab {capHead}
                </TableHead>
                <TableHead scope="col" className="text-right">Lab load</TableHead>
                <TableHead scope="col" className="text-right">L. util.</TableHead>
                {PRIORITY_BUCKETS.map((b) => (
                  <TableHead key={`l-${b}`} scope="col" className="text-right">
                    {BUCKET_SHORT[b]}-L
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const d = pickFigures(row, 'design', horizon);
                const l = pickFigures(row, 'lab', horizon);
                return (
                  <TableRow key={row.hub} data-testid={`util-row-${row.hub}`}>
                    <TableCell className="whitespace-nowrap font-semibold text-text">
                      {row.hub}
                      <span className="ml-1 text-2xs font-normal text-text-subtle">({row.lab_region} lab)</span>
                    </TableCell>
                    <TableCell className={NUM}>{formatDecimal(d.capacity)}</TableCell>
                    <TableCell className={NUM}>{formatDecimal(d.load)}</TableCell>
                    <UtilCell pct={d.bookedPct} status={d.bookingStatus} />
                    {PRIORITY_BUCKETS.map((b) => (
                      <TableCell key={`d-${b}`} className={NUM} data-testid={`util-${row.hub}-${b}-D`}>
                        {formatDecimal(row.design_load_by_priority[b])}
                      </TableCell>
                    ))}
                    <TableCell className={cn(NUM, 'border-l border-dash-hairline')}>{formatDecimal(l.capacity)}</TableCell>
                    <TableCell className={NUM}>{formatDecimal(l.load)}</TableCell>
                    <UtilCell pct={l.bookedPct} status={l.bookingStatus} />
                    {PRIORITY_BUCKETS.map((b) => (
                      <TableCell key={`l-${b}`} className={NUM} data-testid={`util-${row.hub}-${b}-L`}>
                        {formatDecimal(row.lab_load_by_priority[b])}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter className="bg-ink text-ink-fg [&_td]:text-ink-fg">
              <TableRow className="hover:bg-transparent" data-testid="util-row-total">
                <TableCell className="font-bold">Total</TableCell>
                <TableCell className={NUM}>{formatDecimal(totalD.capacity)}</TableCell>
                <TableCell className={NUM}>{formatDecimal(totalD.load)}</TableCell>
                <UtilCell pct={totalD.bookedPct} status={totalD.bookingStatus} onInk />
                {PRIORITY_BUCKETS.map((b) => (
                  <TableCell key={`d-${b}`} className={NUM}>
                    {formatDecimal(totals.design_load_by_priority[b])}
                  </TableCell>
                ))}
                <TableCell className={cn(NUM, 'border-l border-ink-fg/20')}>{formatDecimal(totalL.capacity)}</TableCell>
                <TableCell className={NUM}>{formatDecimal(totalL.load)}</TableCell>
                <UtilCell pct={totalL.bookedPct} status={totalL.bookingStatus} onInk />
                {PRIORITY_BUCKETS.map((b) => (
                  <TableCell key={`l-${b}`} className={NUM}>
                    {formatDecimal(totals.lab_load_by_priority[b])}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </BoltCard>
  );
}
