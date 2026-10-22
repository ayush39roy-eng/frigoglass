import * as React from 'react';
import { ChevronDown, ChevronRight, PanelRightOpen } from 'lucide-react';

import { BOOKING_STATUS_META } from '@/components/shared/booking-status-meta';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDecimal, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import type { HubCapacityRow, HubCapacitySummary, PriorityLoadSplit, ScheduleRunSummary } from '../api/types';
import { firstHubPerLabRegion, groupByHubFamily } from '../lib/hub-families';
import {
  DEMAND_LABEL,
  pickAreaFigures,
  pickFigures,
  pickTotalUnitFigures,
  pickUnitFigures,
  UNIT_SHORT,
  type CapacityView,
  type ResourceKind,
} from '../lib/pick-figures';
import { BUCKET_BG, BUCKET_SHORT, PRIORITY_BUCKETS } from '../lib/priority-split';
import { formatFigure, formatPctCompact } from '../lib/status-format';
import {
  hasMemberBreakdown,
  memberBooked,
  memberDemand,
  otherMembers,
  projectsText,
  SELECTED_MEMBER_SR,
} from '../lib/members';
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
 *
 * P30 (ADR 0041, I19 rev.): the load column is DEMAND. The full-year view shows
 * the full-year demand (`*_load_weeks`) against the yearly capacity; the
 * remaining view shows the remaining demand (`*_load_remaining_weeks`) against
 * the remaining capacity. Booked % and gap follow the same served pairs. An
 * "In plan" column per band shows what the active run booked
 * (`*_load_booked_weeks`, weeks in both units; no booked %, gap or status of
 * this kind is served, so none is shown). The priority split splits the
 * full-year demand only, so its mini-bar is shown in the full-year view only.
 *
 * P29 (ADR 0042): rows are the four CAPACITY hubs. R&D-Greece's row carries
 * OEM-HCK and OEM-Seitek (one capacity, one load, one booked %). Its hub cell
 * has a compact disclosure ("Includes OEM-HCK and OEM-Seitek") that opens one
 * indented sub-row per served member: hub, served project count and served
 * design load (weeks). Sub-rows carry no capacity, booked % or gap (none is
 * served per member, I19) and are never summed. The disclosure starts open
 * when the hub filter selected one of the row's hubs (`selected_member`), and
 * that member is highlighted.
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
  /** The served full-year split; omitted in the remaining view (it splits the full-year demand). */
  split?: PriorityLoadSplit | undefined;
  kind: ResourceKind;
  testId?: string;
  className?: string;
}): React.JSX.Element {
  const label = split ? `${KIND_LABEL[kind]} full-year demand by priority (${UNIT_SHORT.weeks}): ${splitText(split)}` : '';
  const nonZero = split ? PRIORITY_BUCKETS.filter((b) => split[b] > 0) : [];
  return (
    <TableCell className={cn(NUM, 'py-1.5', className)}>
      <span className="block" data-testid={testId}>
        {formatFigure(load)}
      </span>
      {split && nonZero.length > 0 ? (
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
            <span className="block font-semibold">{KIND_LABEL[kind]} full-year demand by priority ({UNIT_SHORT.weeks})</span>
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

/** "Includes OEM-HCK and OEM-Seitek": wraps between words only, never inside a hub name. */
function MembersCaptionText({ row }: { row: HubCapacityRow }): React.JSX.Element {
  const names = otherMembers(row).map((m) => m.hub);
  return (
    <span>
      Includes{' '}
      {names.map((n, i) => (
        <React.Fragment key={n}>
          {i === 0 ? '' : i === names.length - 1 ? ' and ' : ', '}
          <span className="whitespace-nowrap">{n}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

function SubHead({
  short,
  full,
  sub,
  className,
}: {
  short: string;
  full: string;
  /** P30: a small second line (e.g. "full year"), part of the visible header only. */
  sub?: string | undefined;
  className?: string;
}): React.JSX.Element {
  return (
    <TableHead scope="col" className={cn(HEAD, 'whitespace-nowrap text-right', className)}>
      {short === full && sub === undefined ? (
        short
      ) : (
        <>
          <span aria-hidden="true" title={full} className="block">
            {short}
            {sub !== undefined ? (
              <span className="block text-2xs font-medium normal-case tracking-normal text-text-muted">{sub}</span>
            ) : null}
          </span>
          <span className="sr-only">{full}</span>
        </>
      )}
    </TableHead>
  );
}

/**
 * P30: the run-booked weeks (`*_load_booked_weeks`). Served in weeks only, so
 * the Days view keeps weeks and says so; no %, gap or status is served for it.
 */
function InPlanCell({
  weeks,
  days,
  testId,
  className,
}: {
  weeks: number;
  days: boolean;
  testId?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <TableCell className={cn(NUM, 'text-text-muted', className)} data-testid={testId}>
      {formatDecimal(weeks)}
      {days ? <span className="ml-1 text-2xs">{UNIT_SHORT.weeks}</span> : null}
    </TableCell>
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
  'Demand counts the effort weeks of every project of the hub, On Hold and Commercialized included (not Cancelled or Draft), and is not capped at capacity. The remaining view counts open projects’ work still to do. “In plan” is what the active schedule booked; it has no booked %.';

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
  // P29: per-row members disclosure. Unset = open when the filter selected one of the row's hubs.
  const [membersOpen, setMembersOpen] = React.useState<Record<string, boolean>>({});
  const tableId = React.useId();
  // The dialog is controlled (one dialog for all rows), so Radix has no trigger to
  // return focus to; remember the opening button and restore it on close.
  const openerRef = React.useRef<HTMLElement | null>(null);
  const detailRow = data.rows.find((r) => r.hub === detailHub) ?? null;
  const totalD = pickTotalUnitFigures(data.totals, 'design', view);
  const totalL = pickTotalUnitFigures(data.totals, 'lab', view);
  const totalDWeeks = pickAreaFigures(data.totals, 'design', horizon);
  const totalLWeeks = pickAreaFigures(data.totals, 'lab', horizon);
  const capFull = horizon === 'year' ? 'capacity, full year' : 'capacity, remaining year';
  const demandFull = DEMAND_LABEL[horizon].toLowerCase();
  const demandSub = horizon === 'year' ? 'full year' : 'remaining';
  const yearView = horizon === 'year';
  // Accessible unit suffix for the load / capacity headers; gap and split are served in weeks only.
  const inUnit = `, in ${unit}`;
  const gapShort = days ? `Gap (${UNIT_SHORT.weeks})` : 'Gap';
  const groups = groupByHubFamily(data.rows);
  const firstOfRegion = firstHubPerLabRegion(groups.flatMap((g) => g.rows));
  const splitCols = showSplit ? PRIORITY_BUCKETS.length : 0;
  // P30: Capacity | Demand | Booked % | Gap | In plan (+ split); lab adds its region column.
  const designCols = 5 + splitCols;
  const labCols = 6 + splitCols;
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
        full={`${KIND_LABEL[kind]} full-year demand, priority ${BUCKET_SHORT[b]}, in weeks`}
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
              leadIn="“In plan” figures in this card are read directly from"
              srTail="Computed server-side and shown to two decimals (Invariant I17); none of it is recalculated in your browser."
            />
          ) : null}
          <CardInfo label="How load and capacity are defined">
            <p>
              <strong className="text-text">Full-year demand</strong> = Σ the effective design-step
              weeks (lab: lab-step weeks, per lab region) of every project of the hub, On Hold and
              Commercialized included, Cancelled and Draft excluded. A step&rsquo;s weeks are the
              user&rsquo;s timing edit, else the client&rsquo;s effort figure split over the steps,
              else the lead-time table (ADR&nbsp;0041).{' '}
              <strong className="text-text">Remaining demand</strong> counts open projects only, and
              only the work still to do. Both come from the projects themselves, not from a schedule
              run (Invariant I25).
            </p>
            <p>
              <strong className="text-text">In plan</strong> = the weeks the active schedule run
              booked (Invariants I6 / I7); it matches the timeline. No booked % is computed for it.
            </p>
            <p>
              <strong className="text-text">Capacity</strong> is the client&rsquo;s own supply
              formula (ADR&nbsp;0008): working weeks per engineer &times; Σ FTE for design;
              Σ (working weeks &times; efficiency &times; platforms) over the region&rsquo;s
              chambers for lab. &ldquo;Remaining year&rdquo; (YTD 2026) scales by (52 &minus; current
              week) / 52. Full year: booked = full-year demand / yearly capacity. Remaining year:
              booked = remaining demand / remaining capacity. Gap = demand &minus; capacity.
            </p>
            <p>
              <strong className="text-text">Reading booked %.</strong> {BOOKED_NOTE}
            </p>
            <p>
              <strong className="text-text">Priority split.</strong> The bar under the full-year demand,
              and the P1&nbsp;&hellip;&nbsp;Q columns behind &ldquo;Show priority split&rdquo;, are the served
              full-year demand per priority bucket in weeks; &ldquo;Q&rdquo; is a project whose priority is Q
              or not set.
            </p>
            <p>
              <strong className="text-text">OEM hubs.</strong> OEM-HCK and OEM-Seitek have no capacity row of
              their own: R&amp;D-Greece&rsquo;s engineers do their design work, so their projects&rsquo; design
              demand is counted in R&amp;D-Greece&rsquo;s row against one capacity (ADR&nbsp;0042). &ldquo;Includes
              &hellip;&rdquo; under the hub opens each hub&rsquo;s projects, design demand and weeks in plan, as served.
            </p>
            <p>
              Hubs are grouped by family (R&amp;D, PD). Lab figures belong to a lab region, so they are
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
                  <SubHead short="Demand" sub={demandSub} full={`Design ${demandFull}${inUnit}`} />
                  <SubHead short="Booked %" full={`Design booked %, ${demandFull} over capacity`} />
                  <SubHead short={gapShort} full="Design gap, demand minus capacity, in weeks" />
                  <SubHead short="In plan" sub={days ? UNIT_SHORT.weeks : undefined} full="Design weeks booked by the active plan, in weeks" />
                  {showSplit ? splitHeads('design') : null}
                  <TableHead scope="col" className={cn(HEAD, LAB_EDGE)}>
                    Lab region
                  </TableHead>
                  <SubHead short="Capacity" full={`Lab ${capFull}${inUnit}`} />
                  <SubHead short="Demand" sub={demandSub} full={`Lab ${demandFull}${inUnit}`} />
                  <SubHead short="Booked %" full={`Lab booked %, ${demandFull} over capacity`} />
                  <SubHead short={gapShort} full="Lab gap, demand minus capacity, in weeks" />
                  <SubHead short="In plan" sub={days ? UNIT_SHORT.weeks : undefined} full="Lab weeks booked by the active plan, in weeks" />
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
                    const dWeeks = pickFigures(row, 'design', horizon);
                    const lWeeks = pickFigures(row, 'lab', horizon);
                    const dGap = dWeeks.gap;
                    const lGap = lWeeks.gap;
                    const owner = firstOfRegion.get(row.lab_region);
                    const labHere = owner === row.hub;
                    const breakdown = hasMemberBreakdown(row);
                    const open = breakdown && (membersOpen[row.hub] ?? row.selected_member !== null);
                    const subRowsId = `${tableId}-members-${row.hub}`;
                    return (
                      <React.Fragment key={row.hub}>
                        <TableRow data-testid={`hub-summary-row-${row.hub}`}>
                          <TableHead
                            scope="row"
                            className={cn(
                              STICKY,
                              'h-auto whitespace-nowrap bg-surface px-2 py-2 text-sm font-semibold normal-case tracking-normal text-text first:ps-3',
                            )}
                          >
                            {row.hub}
                            {breakdown ? (
                              <button
                                type="button"
                                className="mt-0.5 flex max-w-[11rem] items-start gap-0.5 whitespace-normal rounded-sm text-left text-2xs font-medium text-primary-subtle-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                aria-expanded={open}
                                aria-controls={open ? subRowsId : undefined}
                                onClick={() => {
                                  setMembersOpen((prev) => ({ ...prev, [row.hub]: !open }));
                                }}
                                data-testid={`members-toggle-${row.hub}`}
                              >
                                <ChevronRight
                                  className={cn('mt-px size-3 shrink-0 transition-transform', open && 'rotate-90')}
                                  aria-hidden="true"
                                />
                                <MembersCaptionText row={row} />
                              </button>
                            ) : null}
                          </TableHead>
                          <TableCell className={NUM} data-testid="design-capacity">
                            {formatFigure(d.capacity)}
                          </TableCell>
                          <LoadCell load={d.load} split={yearView ? row.design_load_by_priority : undefined} kind="design" testId="design-load" />
                          <BookedCell pct={d.bookedPct} status={d.bookingStatus} testId="design-booked" />
                          <GapCell value={dGap} testId="design-gap" />
                          <InPlanCell weeks={dWeeks.booked} days={days} testId="design-in-plan" />
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
                              <LoadCell load={l.load} split={yearView ? row.lab_load_by_priority : undefined} kind="lab" testId="lab-load" />
                              <BookedCell pct={l.bookedPct} status={l.bookingStatus} testId="lab-booked" />
                              <GapCell value={lGap} testId="lab-gap" />
                              <InPlanCell weeks={lWeeks.booked} days={days} testId="lab-in-plan" />
                              {showSplit ? <SplitCells split={row.lab_load_by_priority} kind="lab" hub={row.hub} /> : null}
                            </>
                          ) : (
                            <TableCell
                              colSpan={5 + splitCols}
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
                        {open
                          ? row.members.map((m, i) => {
                              const selected = row.selected_member === m.hub;
                              return (
                                <TableRow
                                  key={`${row.hub}-member-${m.hub}`}
                                  id={i === 0 ? subRowsId : undefined}
                                  className={cn(
                                    'text-text-muted',
                                    i < row.members.length - 1 && 'border-b-0',
                                    selected ? 'bg-primary-subtle hover:bg-primary-subtle' : 'bg-surface hover:bg-surface',
                                  )}
                                  data-testid={`hub-summary-member-${m.hub}`}
                                  data-member-of={row.hub}
                                  data-selected={selected ? 'true' : undefined}
                                >
                                  <TableHead
                                    scope="row"
                                    className={cn(
                                      STICKY,
                                      'h-auto whitespace-nowrap py-1 pl-5 pr-2 text-xs font-medium normal-case tracking-normal text-text',
                                      selected ? 'bg-primary-subtle' : 'bg-surface',
                                    )}
                                  >
                                    <span className="block border-l-2 border-border-strong pl-2">
                                    <span className="flex items-center gap-1.5">
                                      {m.hub}
                                      {m.own ? <span className="text-2xs font-normal text-text-muted">(own)</span> : null}
                                      {selected ? (
                                        <Badge tone="primary" className="rounded-pill">
                                          <span aria-hidden="true">Selected</span>
                                          <span className="sr-only">{SELECTED_MEMBER_SR}</span>
                                        </Badge>
                                      ) : null}
                                    </span>
                                    <span className="block text-2xs font-normal text-text-muted" data-testid="member-projects">
                                      {projectsText(m.project_count)}
                                      {typeof m.booked_project_count === 'number' ? (
                                        <span className="whitespace-nowrap">, {formatInteger(m.booked_project_count)} in plan</span>
                                      ) : null}
                                    </span>
                                    </span>
                                  </TableHead>
                                  <TableCell className={NUM}>
                                    <span className="sr-only">No separate capacity</span>
                                  </TableCell>
                                  <TableCell className={cn(NUM, 'py-1 text-text')} data-testid="member-design-load">
                                    {formatFigure(memberDemand(m, horizon))}
                                    {days ? <span className="ml-1 text-2xs text-text-muted">{UNIT_SHORT.weeks}</span> : null}
                                    <span className="sr-only"> design {demandFull} weeks</span>
                                  </TableCell>
                                  <TableCell colSpan={2} className="px-2 py-1" />
                                  <TableCell className={cn(NUM, 'py-1 text-text-muted')} data-testid="member-in-plan">
                                    {formatFigure(memberBooked(m))}
                                    {days ? <span className="ml-1 text-2xs">{UNIT_SHORT.weeks}</span> : null}
                                    <span className="sr-only"> design weeks in plan</span>
                                  </TableCell>
                                  {splitCols > 0 ? <TableCell colSpan={splitCols} className="px-2 py-1" /> : null}
                                  <TableCell colSpan={labCols} className={cn('px-2 py-1', LAB_EDGE)} />
                                  <TableCell className="last:pe-3" />
                                </TableRow>
                              );
                            })
                          : null}
                      </React.Fragment>
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
                    split={yearView ? data.totals.design_load_by_priority : undefined}
                    kind="design"
                    testId="total-design-load"
                    className="font-bold"
                  />
                  <BookedCell pct={totalD.bookedPct} status={totalD.bookingStatus} testId="total-design-booked" />
                  <TableCell className={NUM}>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">not served</span>
                  </TableCell>
                  <InPlanCell weeks={totalDWeeks.booked} days={days} testId="total-design-in-plan" className="font-bold" />
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
                    split={yearView ? data.totals.lab_load_by_priority : undefined}
                    kind="lab"
                    testId="total-lab-load"
                    className="font-bold"
                  />
                  <BookedCell pct={totalL.bookedPct} status={totalL.bookingStatus} testId="total-lab-booked" />
                  <TableCell className={NUM}>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">not served</span>
                  </TableCell>
                  <InPlanCell weeks={totalLWeeks.booked} days={days} testId="total-lab-in-plan" className="font-bold" />
                  {showSplit ? <SplitCells split={data.totals.lab_load_by_priority} kind="lab" hub="total" /> : null}
                  <TableCell className="last:pe-3" />
                </TableRow>
              </TableFooter>
            </Table>
            <div className="space-y-1" data-testid="hub-summary-legend">
              <StatusLegend fullPct={data.full_threshold_pct} nearFullPct={data.near_full_threshold_pct}>
                <span data-testid="hub-summary-unit-note">
                  {days
                    ? 'Demand and capacity in working days (served: weeks × the hub’s working days per week; lab uses its region’s). Gap, In plan and priority split in weeks (no served day figure). Total counts each lab region once.'
                    : 'Weeks. Total counts each lab region once.'}
                </span>
              </StatusLegend>
              <div className="flex flex-wrap items-center gap-x-s4 gap-y-1 text-2xs text-text-muted">
                <span>
                  Gap = demand − capacity:{' '}
                  <span className="font-semibold text-danger-subtle-fg">+ over capacity</span>,{' '}
                  <span className="font-semibold text-success-subtle-fg">− spare</span>
                </span>
                {/* P30: the bars split the full-year demand, so they (and this key) show in the full-year view only. */}
                {yearView ? (
                  <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="priority-legend">
                    Full-year demand bar by priority ({UNIT_SHORT.weeks}):
                    {PRIORITY_BUCKETS.map((b) => (
                      <span key={b} className="inline-flex items-center gap-1">
                        <span className={cn('inline-block size-2.5 rounded-sm', BUCKET_BG[b])} aria-hidden="true" />
                        {BUCKET_SHORT[b]}
                      </span>
                    ))}
                  </span>
                ) : null}
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

