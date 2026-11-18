import * as React from 'react';
import { Info } from 'lucide-react';

import { BOOKING_STATUS_META } from '@/components/shared/booking-status-meta';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBookedPct, formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { HubSelection } from '@/stores/hub-filter';
import type { BookingStatus } from '@/types/enums';

import type { HubCapacityRow, PriorityLoadSplit } from '@/surfaces/capacity/api/types';
import { useHubLoadVsCapacity } from '@/surfaces/capacity/hooks/use-capacity';

/**
 * P13-T12: the mock-up's per-hub "Design load / Lab load" bars above the
 * Kanban. Each bar is the hub's served full-year DEMAND (P30, ADR 0041: every
 * project not Cancelled / Draft), yearly capacity and booked %
 * from `GET /capacity/hub-load` (ADR 0016, I19) — the same query and cache entry
 * as the Capacity surface. The bar width is the served booked % capped at 100;
 * the browser computes no figure. Lab figures are the hub's lab region's.
 *
 * P45-T02 (D45-1..D45-4):
 *  - each bar is drawn as stacked segments from the served
 *    `*_demand_by_priority` split: P1 darkest, P2 mid, P3 / P4 / Queue lightest,
 *    all in the bar's booking-status hue. Every segment's width is the bar width
 *    times its served share of the served total (drawing, not a figure). The
 *    P3, P4 and Queue segments are drawn one by one in the same light tone, so
 *    no served bucket is ever added up in the browser;
 *  - under the bars, the served "To finish" need figures
 *    (`*_need_p1_weeks`, `*_need_p1_p2_weeks`) per D45-3;
 *  - reusable: the Priority board renders it bare (aria-label only), the
 *    Executive dashboard with a visible heading and a grid layout.
 *
 * Rendered only for a caller who can read Capacity; otherwise nothing.
 */

const BAR_TONE: Record<BookingStatus, { p1: string; p2: string; other: string }> = {
  available: { p1: 'bg-success', p2: 'bg-success/55', other: 'bg-success/25' },
  near_full: { p1: 'bg-warning', p2: 'bg-warning/55', other: 'bg-warning/25' },
  full: { p1: 'bg-danger', p2: 'bg-danger/55', other: 'bg-danger/25' },
};

/** Draw order and shade of the served split keys (D45-1). */
const SEGMENTS: readonly { key: keyof PriorityLoadSplit; shade: 'p1' | 'p2' | 'other' }[] = [
  { key: 'P1', shade: 'p1' },
  { key: 'P2', shade: 'p2' },
  { key: 'P3', shade: 'other' },
  { key: 'P4', shade: 'other' },
  { key: 'Queue', shade: 'other' },
];

export const TO_FINISH_TOOLTIP =
  "Remaining P1/P2 demand vs the hub's remaining capacity this year. The schedule can still leave a project out because of sequencing or engineer eligibility.";

/** A served need figure in whole weeks (owner rule 2026-11-13); a positive
 *  figure under half a week reads "<1" rather than a misleading "+0". */
function formatNeed(value: number): string {
  const printed = formatDecimal(value);
  return printed === '0' ? '<1' : printed;
}

function LoadBar({
  label,
  load,
  capacity,
  bookedPct,
  status,
  split,
  testId,
}: {
  label: string;
  load: number;
  capacity: number;
  bookedPct: number | null;
  status: BookingStatus;
  split: PriorityLoadSplit;
  testId: string;
}): React.JSX.Element {
  const width = bookedPct === null ? 0 : Math.min(100, Math.max(0, bookedPct));
  const tone = BAR_TONE[status];
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono tabular-nums text-text" data-numeric="">
          {formatDecimal(load)} / {formatDecimal(capacity)} wks ({formatBookedPct(bookedPct)})
          <span className="sr-only">
            , {BOOKING_STATUS_META[status].label}; P1 {formatDecimal(split.P1)} wks, P2 {formatDecimal(split.P2)} wks
          </span>
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        {SEGMENTS.map(({ key, shade }) => {
          // Drawing only: the segment's share of the served total, scaled to the bar.
          const segment = load > 0 ? (width * Math.max(0, split[key])) / load : 0;
          return (
            <div
              key={key}
              className={cn('h-full', tone[shade])}
              style={{ width: `${String(segment)}%` }}
              data-testid={`${testId}-seg-${key}`}
            />
          );
        })}
      </div>
    </div>
  );
}

function ToFinishLines({ row }: { row: HubCapacityRow }): React.JSX.Element {
  const lines: { key: string; text: string }[] = [];
  if (row.design_need_p1_weeks > 0) {
    lines.push({ key: 'design-p1', text: `To finish P1: +${formatNeed(row.design_need_p1_weeks)} wks design` });
  }
  if (row.design_need_p1_p2_weeks > 0) {
    lines.push({ key: 'design-p1p2', text: `To finish P1 + P2: +${formatNeed(row.design_need_p1_p2_weeks)} wks design` });
  }
  if (row.lab_need_p1_weeks > 0) {
    lines.push({ key: 'lab-p1', text: `To finish P1: +${formatNeed(row.lab_need_p1_weeks)} wks lab` });
  }
  if (row.lab_need_p1_p2_weeks > 0) {
    lines.push({ key: 'lab-p1p2', text: `To finish P1 + P2: +${formatNeed(row.lab_need_p1_p2_weeks)} wks lab` });
  }
  return (
    <ul className="flex flex-col gap-0.5 border-t border-dash-hairline pt-1 text-2xs" data-testid={`hub-load-${row.hub}-need`}>
      {lines.length === 0 ? (
        <li className="text-text-muted" data-testid={`hub-load-${row.hub}-need-fits`}>
          P1 and P2 fit in the remaining capacity
        </li>
      ) : (
        lines.map((line) => (
          <li key={line.key} className="font-medium text-text" data-testid={`hub-load-${row.hub}-need-${line.key}`}>
            {line.text}
          </li>
        ))
      )}
    </ul>
  );
}

function HubLoadCard({ row }: { row: HubCapacityRow }): React.JSX.Element {
  return (
    <li className="flex min-w-[13rem] flex-1 flex-col gap-1.5 rounded-dash border border-dash-hairline bg-surface px-3 py-2" data-testid={`hub-load-${row.hub}`}>
      <span className="text-xs font-bold text-text">{row.hub}</span>
      <LoadBar
        label="Design demand"
        load={row.design_load_weeks}
        capacity={row.design_capacity_year}
        bookedPct={row.design_booked_pct_year}
        status={row.design_booking_status_year}
        split={row.design_demand_by_priority}
        testId={`hub-load-${row.hub}-design`}
      />
      <LoadBar
        label={`Lab demand (${row.lab_region})`}
        load={row.lab_load_weeks}
        capacity={row.lab_capacity_year}
        bookedPct={row.lab_booked_pct_year}
        status={row.lab_booking_status_year}
        split={row.lab_demand_by_priority}
        testId={`hub-load-${row.hub}-lab`}
      />
      <ToFinishLines row={row} />
    </li>
  );
}

function Legend(): React.JSX.Element {
  const swatch = 'inline-block size-2 rounded-sm';
  return (
    <span className="flex items-center gap-1.5 text-2xs text-text-muted" data-testid="hub-load-legend">
      <span className="sr-only">Bar shading: </span>
      <span className={cn(swatch, 'bg-text-muted')} aria-hidden="true" />
      P1
      <span aria-hidden="true">·</span>
      <span className={cn(swatch, 'bg-text-muted/55')} aria-hidden="true" />
      P2
      <span aria-hidden="true">·</span>
      <span className={cn(swatch, 'bg-text-muted/25')} aria-hidden="true" />
      other
    </span>
  );
}

function ToFinishInfo(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="About the To finish figures"
          className="inline-flex size-6 items-center justify-center rounded-full text-text-subtle hover:bg-dash-alt hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="hub-load-need-info"
        >
          <Info className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{TO_FINISH_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}

export interface HubLoadStripProps {
  hub: HubSelection;
  enabled: boolean;
  /** Visible heading. Without one the section is named by its aria-label only. */
  heading?: string;
  /** `wrap` (Priority board): cards flow in a row; `grid`: a responsive grid. */
  layout?: 'wrap' | 'grid';
  className?: string;
  testId?: string;
}

export function HubLoadStrip({
  hub,
  enabled,
  heading,
  layout = 'wrap',
  className,
  testId,
}: HubLoadStripProps): React.JSX.Element | null {
  const headingId = React.useId();
  const query = useHubLoadVsCapacity({ enabled, hub });
  if (!enabled || !query.data?.has_active_schedule_run || query.data.rows.length === 0) return null;
  return (
    <section
      aria-label={heading === undefined ? 'Design and lab demand per hub, full year' : undefined}
      aria-labelledby={heading === undefined ? undefined : headingId}
      className={cn('mb-3 flex flex-col gap-1.5', className)}
      data-testid={testId}
    >
      <div className={cn('flex flex-wrap items-center gap-2', heading === undefined ? 'justify-end' : 'justify-between')}>
        {heading === undefined ? null : (
          <h2 id={headingId} className="text-sm font-semibold text-text">
            {heading}
          </h2>
        )}
        <div className="flex items-center gap-2">
          <Legend />
          <ToFinishInfo />
        </div>
      </div>
      <ul
        className={layout === 'grid' ? 'grid gap-2 sm:grid-cols-2 xl:grid-cols-4' : 'flex flex-wrap gap-2'}
      >
        {query.data.rows.map((row) => (
          <HubLoadCard key={row.hub} row={row} />
        ))}
      </ul>
    </section>
  );
}
