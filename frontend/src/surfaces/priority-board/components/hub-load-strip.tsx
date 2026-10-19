import * as React from 'react';

import { BOOKING_STATUS_META } from '@/components/shared/booking-status-meta';
import { formatBookedPct, formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus, LabRegion } from '@/types/enums';

import type { HubCapacityRow } from '@/surfaces/capacity/api/types';
import { useHubLoadVsCapacity } from '@/surfaces/capacity/hooks/use-capacity';

/**
 * P13-T12: the mock-up's per-hub "Design load / Lab load" bars above the
 * Kanban. Each bar is the hub's served full-year load, capacity and booked %
 * from `GET /capacity/hub-load` (ADR 0016, I19) — the same query and cache entry
 * as the Capacity surface. The bar width is the served booked % capped at 100;
 * the browser computes no figure. Lab figures are the hub's lab region's.
 *
 * Rendered only for a caller who can read Capacity; otherwise nothing.
 */

const BAR_TONE: Record<BookingStatus, string> = {
  available: 'bg-success',
  near_full: 'bg-warning',
  full: 'bg-danger',
};

function LoadBar({
  label,
  load,
  capacity,
  bookedPct,
  status,
  testId,
}: {
  label: string;
  load: number;
  capacity: number;
  bookedPct: number | null;
  status: BookingStatus;
  testId: string;
}): React.JSX.Element {
  const width = bookedPct === null ? 0 : Math.min(100, Math.max(0, bookedPct));
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="text-text-muted">{label}</span>
        <span className="font-mono tabular-nums text-text" data-numeric="">
          {formatDecimal(load)} / {formatDecimal(capacity)} wks ({formatBookedPct(bookedPct)})
          <span className="sr-only">, {BOOKING_STATUS_META[status].label}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        <div className={cn('h-full rounded-full', BAR_TONE[status])} style={{ width: `${String(width)}%` }} />
      </div>
    </div>
  );
}

function HubLoadCard({ row }: { row: HubCapacityRow }): React.JSX.Element {
  return (
    <li className="flex min-w-[13rem] flex-1 flex-col gap-1.5 rounded-dash border border-dash-hairline bg-surface px-3 py-2" data-testid={`hub-load-${row.hub}`}>
      <span className="text-xs font-bold text-text">{row.hub}</span>
      <LoadBar
        label="Design load"
        load={row.design_load_weeks}
        capacity={row.design_capacity_year}
        bookedPct={row.design_booked_pct_year}
        status={row.design_booking_status_year}
        testId={`hub-load-${row.hub}-design`}
      />
      <LoadBar
        label={`Lab load (${row.lab_region})`}
        load={row.lab_load_weeks}
        capacity={row.lab_capacity_year}
        bookedPct={row.lab_booked_pct_year}
        status={row.lab_booking_status_year}
        testId={`hub-load-${row.hub}-lab`}
      />
    </li>
  );
}

export function HubLoadStrip({
  hubId,
  region,
  enabled,
}: {
  hubId: string | null;
  region: LabRegion | null;
  enabled: boolean;
}): React.JSX.Element | null {
  const query = useHubLoadVsCapacity({ enabled, hubId, region });
  if (!enabled || !query.data?.has_active_schedule_run || query.data.rows.length === 0) return null;
  return (
    <section aria-label="Design and lab load per hub, full year" className="mb-3">
      <ul className="flex flex-wrap gap-2">
        {query.data.rows.map((row) => (
          <HubLoadCard key={row.hub} row={row} />
        ))}
      </ul>
    </section>
  );
}
