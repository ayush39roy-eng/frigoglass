import * as React from 'react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { Badge } from '@/components/ui/badge';
import { CardInfo } from '@/components/ui/card-info';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatDecimal } from '@/lib/format';
import { useSessionStore } from '@/stores/session';

import type { HubCapacityRow } from '../api/types';
import { pickFigures, type CapacityHorizon, type ResourceFigures } from '../lib/pick-figures';
import { formatPctCompact } from '../lib/status-format';

/**
 * "Capacity booked" (P19-T02, owner ruling 2026-10-21): HUBS ONLY. One tile per
 * served hub row with the hub's design booked % and the booked % of its lab
 * region, labelled "Lab (Greece region)". The Europe / India AREA summary was
 * removed at the owner's request; the served `areas[]` field is no longer read.
 *
 * Every figure is one served field (I9/I19), selected by `pickFigures` for the
 * page's horizon. The lab figure is region-level (ADR 0016), so hubs of the same
 * region show the same lab figure; the label names the region to make that clear.
 */

const HORIZON_CAPTION: Record<CapacityHorizon, string> = {
  year: 'Full year',
  remaining: `Remaining year (W${String(CURRENT_WEEK)}–W${String(WITHIN_YEAR_WEEK)})`,
};

function BookedLine({
  label,
  figures,
  unit,
  testId,
}: {
  label: string;
  figures: Pick<ResourceFigures, 'load' | 'capacity' | 'bookedPct' | 'bookingStatus'>;
  unit: string;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid={testId}>
      <span className="text-2xs font-semibold text-text-subtle">{label}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-sm font-bold tabular-nums text-text" data-numeric="">
          {formatPctCompact(figures.bookedPct)}
        </span>
        <BookingStatusChip status={figures.bookingStatus} />
      </span>
      <span className="text-2xs text-text-muted" data-numeric="">
        {figures.bookedPct === null ? 'No capacity in scope · ' : null}
        {formatDecimal(figures.load)} of {formatDecimal(figures.capacity)} {unit}
      </span>
    </div>
  );
}

export function HubBookingStrip({
  rows,
  horizon,
}: {
  rows: HubCapacityRow[];
  horizon: CapacityHorizon;
}): React.JSX.Element | null {
  const scopedToHubs = useSessionStore((s) => (s.me ? !s.me.hub_scope_all : false));
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="capacity-booked-heading" className="space-y-s2" data-testid="hub-booking-strip">
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <h2 id="capacity-booked-heading" className="text-h2 text-text">
          Capacity booked
        </h2>
        <div className="flex flex-wrap items-center gap-s2">
          {scopedToHubs ? (
            <Badge tone="warning" className="rounded-pill" title="Only the hubs in your scope are shown">
              Your hubs only
            </Badge>
          ) : null}
          <Badge tone="outline" className="rounded-pill" data-testid="booked-strip-horizon">
            {HORIZON_CAPTION[horizon]}
          </Badge>
          <CardInfo label="How booked % is defined">
            <p>
              <strong className="text-text">Booked %</strong> = load / capacity &times; 100, computed on the
              server to two decimals (ADR&nbsp;0016, Invariant I19). Over 100&nbsp;% means more work is
              planned than the capacity can deliver.
            </p>
            <p>
              <strong className="text-text">Full</strong> from 100&nbsp;%, <strong className="text-text">Near full</strong>{' '}
              from 85&nbsp;%, otherwise <strong className="text-text">Available</strong>. These are reporting
              figures: they never stop the scheduler booking work.
            </p>
            <p>
              Design is per hub. Lab capacity belongs to a lab region (its chambers), so the lab figure is the
              region&rsquo;s and is the same on every hub of that region. The YTD 2026 / Full year toggle in the
              page header picks which figures are shown here.
            </p>
          </CardInfo>
        </div>
      </div>
      <ul className="grid gap-s3 sm:grid-cols-2 xl:grid-cols-3" data-testid="booked-tiles">
        {rows.map((r) => (
          <li
            key={r.hub}
            className="flex min-w-0 flex-col gap-s2 rounded-dash border border-dash-hairline bg-surface p-card-tight shadow-dashCard"
            data-testid={`booked-hub-${r.hub}`}
          >
            <h3 className="truncate text-sm font-bold text-text">{r.hub}</h3>
            <div className="grid grid-cols-2 gap-s3">
              <BookedLine
                label="Design"
                figures={pickFigures(r, 'design', horizon)}
                unit="engineer-wks"
                testId={`booked-design-${r.hub}`}
              />
              <BookedLine
                label={`Lab (${r.lab_region} region)`}
                figures={pickFigures(r, 'lab', horizon)}
                unit="chamber-wks"
                testId={`booked-lab-${r.hub}`}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
