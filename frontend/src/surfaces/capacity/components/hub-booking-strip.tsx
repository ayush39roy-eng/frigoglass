import * as React from 'react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { Badge } from '@/components/ui/badge';
import { CardInfo } from '@/components/ui/card-info';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session';

import type { HubCapacityRow } from '../api/types';
import {
  pickUnitFigures,
  resourceUnit,
  type CapacityHorizon,
  type CapacityView,
  type UnitFigures,
} from '../lib/pick-figures';
import { groupByHubFamily } from '../lib/hub-families';
import { hasMemberBreakdown, membersCaption } from '../lib/members';
import { formatFigure, formatPctCompact } from '../lib/status-format';

/**
 * "Capacity booked" (P19-T02, owner ruling 2026-10-21): HUBS ONLY. One tile per
 * served hub row with the hub's design booked % and the booked % of its lab
 * region, labelled "Lab (Greece region)". The Europe / India AREA summary was
 * removed at the owner's request; the served `areas[]` field is no longer read.
 *
 * Every figure is one served field (I9/I19), selected by `pickFigures` for the
 * page's horizon. The lab figure is region-level (ADR 0016), so hubs of the same
 * region show the same lab figure; the label names the region to make that clear.
 *
 * P19-T06: the tiles sit in one labelled box per hub FAMILY (R&D, PD, OEM;
 * `lib/hub-families.ts`): three boxes side by side at xl, two per row at md, one
 * per row below. Only families with a served row get a box, so a Hub Planner
 * sees no empty box. No family total is shown: the API serves none (I19).
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
  figures: UnitFigures;
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
        {/* P30: the demand the horizon pairs with (I19 rev.). */}
        <span className="sr-only">Demand </span>
        {formatFigure(figures.load)} of {formatFigure(figures.capacity)} {unit}
      </span>
    </div>
  );
}

export function HubBookingStrip({
  rows,
  view,
}: {
  rows: HubCapacityRow[];
  view: CapacityView;
}): React.JSX.Element | null {
  const { horizon } = view;
  const scopedToHubs = useSessionStore((s) => (s.me ? !s.me.hub_scope_all : false));
  if (rows.length === 0) return null;
  const groups = groupByHubFamily(rows);
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
              <strong className="text-text">Booked %</strong> = demand / capacity &times; 100, computed on the
              server to two decimals (ADR&nbsp;0016, Invariant I19). Full year: the full-year demand of every
              project (On Hold and Commercialized included) against the yearly capacity. YTD 2026: the
              remaining demand of open projects against the remaining capacity (ADR&nbsp;0041). Over 100&nbsp;%
              means more work is asked of the hub than its capacity can deliver.
            </p>
            <p>
              <strong className="text-text">Full</strong> from 100&nbsp;%, <strong className="text-text">Near full</strong>{' '}
              from 85&nbsp;%, otherwise <strong className="text-text">Available</strong>. These are reporting
              figures: they never stop the scheduler booking work.
            </p>
            <p>
              Design is per hub. Lab capacity belongs to a lab region (its chambers), so the lab figure is the
              region&rsquo;s and is the same on every hub of that region. The YTD 2026 / Full year and Weeks /
              Days toggles in the page header pick which figures are shown here; booked % is the same in weeks
              and days.
            </p>
            <p>
              Hubs are grouped by family (R&amp;D, PD). The boxes carry no family total because the server
              does not serve one, and the browser does not add hubs up. OEM-HCK and OEM-Seitek share
              R&amp;D-Greece&rsquo;s capacity, so their demand is in R&amp;D-Greece&rsquo;s booked % (ADR&nbsp;0042).
            </p>
          </CardInfo>
        </div>
      </div>
      {/* P29: with the four capacity hubs only R&D and PD boxes are served, so the
          grid takes as many columns as there are boxes (no empty third column). */}
      <div
        className={cn('grid gap-s3', groups.length >= 3 ? 'md:grid-cols-2 xl:grid-cols-3' : groups.length === 2 ? 'md:grid-cols-2' : undefined)}
        data-testid="booked-families"
      >
        {groups.map(({ family, rows: familyRows }) => {
          const headingId = `booked-family-${family.key}-heading`;
          return (
            <section
              key={family.key}
              aria-labelledby={headingId}
              className="flex min-w-0 flex-col gap-s2 rounded-dash border border-dash-hairline bg-surface-sunken/50 p-s2"
              data-testid={`booked-family-${family.key}`}
            >
              {/* No family aggregate is served (P19-T06), so the header carries the name only. */}
              <h3 id={headingId} className="px-1 text-xs font-bold uppercase tracking-wider text-text-muted">
                {family.label}
              </h3>
              <ul className="grid gap-s2 sm:grid-cols-2 md:grid-cols-1" data-testid="booked-tiles">
                {familyRows.map((r) => (
                  <li
                    key={r.hub}
                    className="flex min-w-0 flex-col gap-s2 rounded-dash border border-dash-hairline bg-surface p-s3 shadow-dashCard"
                    data-testid={`booked-hub-${r.hub}`}
                  >
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-text">{r.hub}</h4>
                      {/* P29 (ADR 0042): one capacity for the capacity hub and its member hubs. */}
                      {hasMemberBreakdown(r) ? (
                        <p className="text-2xs text-text-muted" data-testid={`booked-members-${r.hub}`}>
                          {membersCaption(r)}
                          {r.selected_member !== null && r.selected_member !== r.hub ? (
                            <>
                              {' · '}
                              <span className="font-semibold text-primary-subtle-fg" data-testid={`booked-selected-${r.hub}`}>
                                Filtered on {r.selected_member}
                              </span>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-2 gap-s3">
                      <BookedLine
                        label="Design"
                        figures={pickUnitFigures(r, 'design', view)}
                        unit={resourceUnit('design', view.unit)}
                        testId={`booked-design-${r.hub}`}
                      />
                      <BookedLine
                        label={`Lab (${r.lab_region} region)`}
                        figures={pickUnitFigures(r, 'lab', view)}
                        unit={resourceUnit('lab', view.unit)}
                        testId={`booked-lab-${r.hub}`}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
