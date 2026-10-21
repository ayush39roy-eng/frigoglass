import * as React from 'react';
import { ChevronDown, PanelRightOpen } from 'lucide-react';

import { BOOKING_STATUS_META } from '@/components/shared/booking-status-meta';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import type { HubCapacityRow, HubCapacitySummary, PriorityLoadSplit, ScheduleRunSummary } from '../api/types';
import { firstHubPerLabRegion, groupByHubFamily } from '../lib/hub-families';
import {
  pickFigures,
  pickTotalUnitFigures,
  pickUnitFigures,
  UNIT_SHORT,
  type CapacityView,
  type ResourceKind,
} from '../lib/pick-figures';
import { BUCKET_BG, BUCKET_SHORT, PRIORITY_BUCKETS } from '../lib/priority-split';
import { formatFigure, formatPctCompact } from '../lib/status-format';
import { HubSupplyDetail } from './hub-supply-breakdown';
import { StatusLegend } from './status-mark';

/**
 * "Load vs. capacity by hub" (P19-T06): ONE table that merges the P19-T01/T02
 * summary table and the P13-T11 "Global resource utilization matrix" (they
 * showed the same load, capacity and booked data).
 *
 * Rows are grouped by hub FAMILY (R&D, PD, OEM; `lib/hub-families.ts`), each
 * with a group header row. No family subtotal is served, so none is shown.
 * Columns: Hub | Design band (Capacity, Load, Booked %, Gap) | Lab band (Lab
 * region, Capacity, Load, Booked %, Gap) | Details. "Show priority split" adds
 * the served P1..Q columns to each band; the Load cell always carries a stacked
 * mini-bar of the same served split (segments sized by `flex-grow` = served
 * value; no division here).
 *
 * Lab figures belong to the lab REGION (I7, ADR 0016). They are shown in full
 * on the region's first row (in display order); later rows of the same region
 * show the region tag and a muted "Same as <hub> above" note instead of
 * repeating them. The Total row is the served `totals`, each lab region once.
 *
 * Every number is one served field (I9/I19): `pickUnitFigures` /
 * `pickTotalUnitFigures` select the horizon and unit; gaps and the priority
 * split are served in weeks only and are labelled so in Days mode. Booked %
 * cells are tinted by the SERVED status, carry the status icon and its label,
 * and a thin bar (capped visually at 100, with an overflow marker above it).
 */
const NUM = 'px-2 text-right font-mono tabular-nums whitespace-nowrap';
const HEAD = 'h-auto px-2 py-1.5';
/** Left rule that separates the Lab band from the Design band. */
const LAB_EDGE = 'border-l border-border';
/** Sticky first column (horizontal scroll at narrow widths). */
const STICKY = 'sticky left-0 z-[1]';

const STATUS_TINT: Record<BookingStatus, string> = {
  full: 'bg-danger-subtle text-danger-subtle-fg',
  near_full: 'bg-warning-subtle text-warning-subtle-fg',
  available: 'bg-success-subtle text-success-subtle-fg',
};

const STATUS_BAR: Record<BookingStatus, string> = {
  full: 'bg-danger',
  near_full: 'bg-warning',
  available: 'bg-success',
};

const KIND_LABEL: Record<ResourceKind, string> = { design: 'Design', lab: 'Lab' };

/** Served booked % with a tint by the served status, the status icon + label and a thin bar. */
function BookedCell({
  pct,
  status,
  testId,
  className,
}: {
  pct: number | null;
  status: BookingStatus;
  testId?: string;
  className?: string;
}): React.JSX.Element {
  const meta = BOOKING_STATUS_META[status];
  // Presentation only: the served % is the bar width, capped at the track's end.
  const width = pct === null ? 0 : Math.max(0, Math.min(pct, 100));
  const over = pct !== null && pct > 100;
  return (
    <TableCell
      className={cn('px-2 py-1.5 align-middle', STATUS_TINT[status], className)}
      data-testid={testId}
      data-booking-status={status}
    >
      <span className="flex items-center justify-end gap-1 font-mono text-sm font-bold tabular-nums">
        <meta.Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {formatPctCompact(pct)}
      </span>
      <span className="mt-0.5 flex items-center justify-end gap-1.5">
        <span className="text-2xs font-semibold" data-testid={testId ? `${testId}-label` : undefined}>
          {meta.label}
        </span>
        <span className="relative h-1.5 w-12 shrink-0 rounded-full bg-text/10" aria-hidden="true">
          <span className={cn('absolute inset-y-0 left-0 rounded-full', STATUS_BAR[status])} style={{ width: `${String(width)}%` }} />
          {over ? (
            <span
              className="absolute -right-1 -top-0.5 h-2.5 w-1 rounded-sm bg-danger-subtle-fg"
              title="Over 100%"
              data-testid="booked-overflow"
            />
          ) : null}
        </span>
      </span>
    </TableCell>
  );
}

/** Served gap (weeks): over capacity in red with "+", spare in green with "−". */
function GapCell({ value, testId, className }: { value: number; testId?: string; className?: string }): React.JSX.Element {
  const tone = value > 0 ? 'text-danger-subtle-fg' : value < 0 ? 'text-success-subtle-fg' : 'text-text';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return (
    <TableCell className={cn(NUM, 'font-semibold', tone, className)} data-testid={testId} data-gap-sign={value > 0 ? 'over' : value < 0 ? 'under' : 'zero'}>
      {sign}
      {formatDecimal(Math.abs(value))}
      <span className="sr-only">{value > 0 ? ' over capacity' : value < 0 ? ' spare' : ''}</span>
    </TableCell>
  );
}

function splitText(split: PriorityLoadSplit): string {
  return PRIORITY_BUCKETS.map((b) => `${BUCKET_SHORT[b]} ${formatDecimal(split[b])}`).join(', ');
}

/** Load figure with a stacked mini-bar of the served priority split (tooltip gives the figures). */
function LoadCell({
  load,
  split,
  kind,
  testId,
  className,
}: {
  load: number | null;
  split: PriorityLoadSplit;
  kind: ResourceKind;
  testId?: string;
  className?: string;
}): React.JSX.Element {
  const label = `${KIND_LABEL[kind]} load by priority (${UNIT_SHORT.weeks}): ${splitText(split)}`;
  const nonZero = PRIORITY_BUCKETS.filter((b) => split[b] > 0);
  return (
    <TableCell className={cn(NUM, 'py-1.5', className)}>
      <span className="block" data-testid={testId}>
        {formatFigure(load)}
      </span>
      {nonZero.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={label}
              className="ml-auto mt-1 flex h-1.5 w-16 overflow-hidden rounded-full bg-text/10"
              data-testid={testId ? `${testId}-split-bar` : undefined}
            >
              {nonZero.map((b) => (
                <span key={b} className={cn('h-full', BUCKET_BG[b])} style={{ flexGrow: split[b], flexBasis: 0 }} />
              ))}
            </span>
          </TooltipTrigger>
          <TooltipContent className="font-sans">
            <span className="block font-semibold">{KIND_LABEL[kind]} load by priority ({UNIT_SHORT.weeks})</span>
            {PRIORITY_BUCKETS.map((b) => (
              <span key={b} className="flex items-center gap-1.5">
                <span className={cn('inline-block size-2 rounded-sm', BUCKET_BG[b])} aria-hidden="true" />
                {BUCKET_SHORT[b]}: {formatDecimal(split[b])}
              </span>
            ))}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </TableCell>
  );
}

function SubHead({ short, full, className }: { short: string; full: string; className?: string }): React.JSX.Element {
  return (
    <TableHead scope="col" className={cn(HEAD, 'whitespace-nowrap text-right', className)}>
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

function SplitCells({
  split,
  kind,
  hub,
  className,
}: {
  split: PriorityLoadSplit;
  kind: ResourceKind;
  hub: string;
  className?: string;
}): React.JSX.Element {
  const k = kind === 'design' ? 'D' : 'L';
  return (
    <>
      {PRIORITY_BUCKETS.map((b, i) => (
        <TableCell
          key={b}
          className={cn(NUM, 'bg-surface-sunken/30 text-text-muted', i === 0 ? 'border-l border-border/60' : undefined, className)}
          data-testid={`split-${hub}-${b}-${k}`}
        >
          {formatDecimal(split[b])}
        </TableCell>
      ))}
    </>
  );
}

/** How to read load against capacity (P19-T02; rewritten P19-T06 for ADR 0032, matching `capacity-reporting-notice.tsx`). */
export const BOOKED_NOTE =
  'Load counts work weeks, including work scheduled past W52, and is not capped at capacity. Part-time leaders stretch the calendar, not the load. The demo engineer FTE and chamber efficiency values are tuned (ADR 0024), so these figures will move with real rosters.';

export interface HubSummaryTableProps {
  data: HubCapacitySummary;
  activeRun: ScheduleRunSummary | null | undefined;
  view: CapacityView;
}

export function HubSummaryTable({ data, activeRun, view }: HubSummaryTableProps): React.JSX.Element {
  const { horizon, unit } = view;
  const days = unit === 'days';
  const [detailHub, setDetailHub] = React.useState<string | null>(null);
  const [showSplit, setShowSplit] = React.useState(false);
  const tableId = React.useId();
  // The dialog is controlled (one dialog for all rows), so Radix has no trigger to
  // return focus to; remember the opening button and restore it on close.
  const openerRef = React.useRef<HTMLElement | null>(null);
  const detailRow = data.rows.find((r) => r.hub === detailHub) ?? null;
  const totalD = pickTotalUnitFigures(data.totals, 'design', view);
  const totalL = pickTotalUnitFigures(data.totals, 'lab', view);
  const capFull = horizon === 'year' ? 'capacity, full year' : 'capacity, remaining year';
  // Accessible unit suffix for the load / capacity headers; gap and split are served in weeks only.
  const inUnit = `, in ${unit}`;
  const gapShort = days ? `Gap (${UNIT_SHORT.weeks})` : 'Gap';
  const groups = groupByHubFamily(data.rows);
  const firstOfRegion = firstHubPerLabRegion(groups.flatMap((g) => g.rows));
  const splitCols = showSplit ? PRIORITY_BUCKETS.length : 0;
  const designCols = 4 + splitCols;
  const labCols = 5 + splitCols;
  const allCols = 1 + designCols + labCols + 1;

  const openDetails = (e: React.MouseEvent<HTMLElement>, row: HubCapacityRow): void => {
    openerRef.current = e.currentTarget;
    setDetailHub(row.hub);
  };

  const splitHeads = (kind: ResourceKind): React.JSX.Element[] =>
    PRIORITY_BUCKETS.map((b, i) => (
      <SubHead
        key={`${kind}-${b}`}
        short={`${BUCKET_SHORT[b]}-${kind === 'design' ? 'D' : 'L'}`}
        full={`${KIND_LABEL[kind]} load, priority ${BUCKET_SHORT[b]}, in weeks`}
        className={cn('bg-surface-sunken', i === 0 ? 'border-l border-border/60' : undefined)}
      />
    ));

  return (
    <BoltCard className="min-w-0">
      <CardHeader className="flex-wrap gap-y-s2">
        <CardTitle>Load vs. capacity by hub</CardTitle>
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
              <strong className="text-text">Reading booked %.</strong> {BOOKED_NOTE}
            </p>
            <p>
              <strong className="text-text">Priority split.</strong> The bar under each load, and the
              P1&nbsp;&hellip;&nbsp;Q columns behind &ldquo;Show priority split&rdquo;, are the served load per
              priority bucket in weeks; &ldquo;Q&rdquo; is a project whose priority is Q or not set.
            </p>
            <p>
              Hubs are grouped by family (R&amp;D, PD, OEM). Lab figures belong to a lab region, so they are
              shown once, on the region&rsquo;s first hub; the Total counts each lab region once. All of it
              is computed server-side and shown to two decimals (Invariant I17); none of it is recalculated
              in your browser.
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
            <div className="flex flex-wrap items-start justify-between gap-s2">
              <p className="max-w-prose text-xs text-text-muted" data-testid="hub-summary-booked-note">
                {BOOKED_NOTE}
              </p>
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={showSplit}
                aria-controls={tableId}
                onClick={() => {
                  setShowSplit((v) => !v);
                }}
                data-testid="toggle-priority-split"
              >
                <ChevronDown className={cn('transition-transform', showSplit ? 'rotate-180' : undefined)} aria-hidden="true" />
                {showSplit ? 'Hide priority split' : 'Show priority split'}
              </Button>
            </div>
            <Table
              id={tableId}
              stickyHeader
              scrollLabel="Load versus capacity by hub"
              data-testid="hub-summary-table"
              className="text-xs"
            >
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" rowSpan={2} className={cn(HEAD, STICKY, 'bg-surface-sunken first:ps-3')}>
                    Hub
                  </TableHead>
                  <TableHead scope="colgroup" colSpan={designCols} className={cn(HEAD, 'text-center text-primary-subtle-fg')}>
                    Design <span className="font-medium normal-case tracking-normal text-text-muted">(per hub)</span>
                  </TableHead>
                  <TableHead scope="colgroup" colSpan={labCols} className={cn(HEAD, LAB_EDGE, 'text-center text-primary-subtle-fg')}>
                    Lab <span className="font-medium normal-case tracking-normal text-text-muted">(per lab region)</span>
                  </TableHead>
                  <TableHead scope="col" rowSpan={2} className={cn(HEAD, 'last:pe-3')}>
                    <span className="sr-only">Details</span>
                  </TableHead>
                </TableRow>
                <TableRow className="hover:bg-transparent">
                  <SubHead short="Capacity" full={`Design ${capFull}${inUnit}`} />
                  <SubHead short="Load" full={`Design load${inUnit}`} />
                  <SubHead short="Booked %" full="Design booked %" />
                  <SubHead short={gapShort} full="Design gap, load minus capacity, in weeks" />
                  {showSplit ? splitHeads('design') : null}
                  <TableHead scope="col" className={cn(HEAD, LAB_EDGE)}>
                    Lab region
                  </TableHead>
                  <SubHead short="Capacity" full={`Lab ${capFull}${inUnit}`} />
                  <SubHead short="Load" full={`Lab load${inUnit}`} />
                  <SubHead short="Booked %" full="Lab booked %" />
                  <SubHead short={gapShort} full="Lab gap, load minus capacity, in weeks" />
                  {showSplit ? splitHeads('lab') : null}
                </TableRow>
              </TableHeader>
              {groups.map(({ family, rows }) => (
                <TableBody key={family.key} data-testid={`hub-summary-family-${family.key}`}>
                  <TableRow className="bg-surface-sunken/60 hover:bg-surface-sunken/60">
                    <TableHead
                      scope="rowgroup"
                      colSpan={allCols}
                      className={cn(HEAD, 'first:ps-3 text-2xs tracking-wider text-text')}
                    >
                      {/* No family subtotal is served (P19-T06), so the header is the name only. */}
                      <span className="sticky left-3">{family.label}</span>
                    </TableHead>
                  </TableRow>
                  {rows.map((row) => {
                    const d = pickUnitFigures(row, 'design', view);
                    const l = pickUnitFigures(row, 'lab', view);
                    const dGap = pickFigures(row, 'design', horizon).gap;
                    const lGap = pickFigures(row, 'lab', horizon).gap;
                    const owner = firstOfRegion.get(row.lab_region);
                    const labHere = owner === row.hub;
                    return (
                      <TableRow key={row.hub} data-testid={`hub-summary-row-${row.hub}`}>
                        <TableHead
                          scope="row"
                          className={cn(
                            STICKY,
                            'h-auto whitespace-nowrap bg-surface px-2 py-2 text-sm font-semibold normal-case tracking-normal text-text first:ps-3',
                          )}
                        >
                          {row.hub}
                        </TableHead>
                        <TableCell className={NUM} data-testid="design-capacity">
                          {formatFigure(d.capacity)}
                        </TableCell>
                        <LoadCell load={d.load} split={row.design_load_by_priority} kind="design" testId="design-load" />
                        <BookedCell pct={d.bookedPct} status={d.bookingStatus} testId="design-booked" />
                        <GapCell value={dGap} testId="design-gap" />
                        {showSplit ? <SplitCells split={row.design_load_by_priority} kind="design" hub={row.hub} /> : null}
                        <TableCell className={cn('px-2 py-1.5', LAB_EDGE)} data-testid="lab-region">
                          <span className="inline-flex rounded-pill border border-border bg-surface-sunken px-1.5 py-0.5 text-2xs font-semibold text-text">
                            {row.lab_region}
                          </span>
                        </TableCell>
                        {labHere ? (
                          <>
                            <TableCell className={NUM} data-testid="lab-capacity">
                              {formatFigure(l.capacity)}
                            </TableCell>
                            <LoadCell load={l.load} split={row.lab_load_by_priority} kind="lab" testId="lab-load" />
                            <BookedCell pct={l.bookedPct} status={l.bookingStatus} testId="lab-booked" />
                            <GapCell value={lGap} testId="lab-gap" />
                            {showSplit ? <SplitCells split={row.lab_load_by_priority} kind="lab" hub={row.hub} /> : null}
                          </>
                        ) : (
                          <TableCell
                            colSpan={4 + splitCols}
                            className="px-2 py-1.5 text-2xs italic text-text-muted"
                            data-testid="lab-shared"
                          >
                            Same as {owner} above (shared {row.lab_region} lab region)
                          </TableCell>
                        )}
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
              ))}
              <TableFooter>
                <TableRow data-testid="hub-summary-total" className="hover:bg-transparent">
                  <TableHead
                    scope="row"
                    className={cn(STICKY, 'h-auto bg-surface-sunken px-2 py-2 text-sm font-bold normal-case tracking-normal text-text first:ps-3')}
                  >
                    Total
                  </TableHead>
                  <TableCell className={cn(NUM, 'font-bold')} data-testid="total-design-capacity">
                    {formatFigure(totalD.capacity)}
                  </TableCell>
                  <LoadCell
                    load={totalD.load}
                    split={data.totals.design_load_by_priority}
                    kind="design"
                    testId="total-design-load"
                    className="font-bold"
                  />
                  <BookedCell pct={totalD.bookedPct} status={totalD.bookingStatus} testId="total-design-booked" />
                  <TableCell className={NUM}>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">not served</span>
                  </TableCell>
                  {showSplit ? <SplitCells split={data.totals.design_load_by_priority} kind="design" hub="total" /> : null}
                  <TableCell className={cn('px-2 py-1.5 text-2xs text-text-muted', LAB_EDGE)} data-testid="total-lab-regions">
                    <span className="block whitespace-nowrap">{data.totals.lab_regions.join(', ')}</span>
                    <span className="block">each once</span>
                  </TableCell>
                  <TableCell className={cn(NUM, 'font-bold')} data-testid="total-lab-capacity">
                    {formatFigure(totalL.capacity)}
                  </TableCell>
                  <LoadCell
                    load={totalL.load}
                    split={data.totals.lab_load_by_priority}
                    kind="lab"
                    testId="total-lab-load"
                    className="font-bold"
                  />
                  <BookedCell pct={totalL.bookedPct} status={totalL.bookingStatus} testId="total-lab-booked" />
                  <TableCell className={NUM}>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">not served</span>
                  </TableCell>
                  {showSplit ? <SplitCells split={data.totals.lab_load_by_priority} kind="lab" hub="total" /> : null}
                  <TableCell className="last:pe-3" />
                </TableRow>
              </TableFooter>
            </Table>
            <div className="space-y-1" data-testid="hub-summary-legend">
              <StatusLegend fullPct={data.full_threshold_pct} nearFullPct={data.near_full_threshold_pct}>
                <span data-testid="hub-summary-unit-note">
                  {days
                    ? 'Load and capacity in working days (served: weeks × the hub’s working days per week; lab uses its region’s). Gap and priority split in weeks (no served day figure). Total counts each lab region once.'
                    : 'Weeks. Total counts each lab region once.'}
                </span>
              </StatusLegend>
              <div className="flex flex-wrap items-center gap-x-s4 gap-y-1 text-2xs text-text-muted">
                <span>
                  Gap = load − capacity:{' '}
                  <span className="font-semibold text-danger-subtle-fg">+ over capacity</span>,{' '}
                  <span className="font-semibold text-success-subtle-fg">− spare</span>
                </span>
                <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="priority-legend">
                  Load bar by priority ({UNIT_SHORT.weeks}):
                  {PRIORITY_BUCKETS.map((b) => (
                    <span key={b} className="inline-flex items-center gap-1">
                      <span className={cn('inline-block size-2.5 rounded-sm', BUCKET_BG[b])} aria-hidden="true" />
                      {BUCKET_SHORT[b]}
                    </span>
                  ))}
                </span>
              </div>
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

