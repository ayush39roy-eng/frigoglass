import * as React from 'react';
import { MapPin } from 'lucide-react';

import { BookedFigure, BookingStatusChip } from '@/components/shared/booking-status-chip';
import { Badge } from '@/components/ui/badge';
import { CardInfo } from '@/components/ui/card-info';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatBookedPct, formatDecimal } from '@/lib/format';
import { useSessionStore } from '@/stores/session';

import type { CapacityArea, HubCapacityRow } from '../api/types';
import { labRegionRows } from '../lib/lab-region-rows';
import { pickAreaFigures, pickFigures, type CapacityHorizon, type ResourceFigures, type ResourceKind } from '../lib/pick-figures';

/**
 * Europe / India "booked %" strip at the top of the Capacity surface
 * (ADR 0016, P11 contract §4). One card per SERVED `areas[]` entry. Each
 * figure is one served field: the area sums (each lab region counted once,
 * server-side), the booked % and the status (I19). The page's Full year /
 * Remaining year toggle picks which served pair is shown.
 *
 * Each card says which hubs and lab regions it covers, and a hub-scoped user
 * sees "Your hubs only", so a partial area is never read as all of Europe.
 */

const HORIZON_CAPTION: Record<CapacityHorizon, string> = {
  year: 'Full year',
  remaining: `Remaining year (W${String(CURRENT_WEEK)}–W${String(WITHIN_YEAR_WEEK)})`,
};

const UNIT: Record<ResourceKind, string> = { design: 'engineer-wks', lab: 'chamber-wks' };

function AreaResource({
  area,
  kind,
  horizon,
}: {
  area: CapacityArea;
  kind: ResourceKind;
  horizon: CapacityHorizon;
}): React.JSX.Element {
  const f = pickAreaFigures(area, kind, horizon);
  const title = kind === 'design' ? 'Design booked' : 'Lab booked';
  return (
    <div className="flex flex-col gap-1 rounded-dash border border-dash-hairline bg-dash-alt px-s3 py-s2">
      <BookedFigure
        label={title}
        bookedPct={f.bookedPct}
        status={f.bookingStatus}
        data-testid={`area-${area.area}-${kind}`}
      />
      <span className="text-2xs text-text-muted" data-numeric="">
        {formatDecimal(f.load)} of {formatDecimal(f.capacity)} {UNIT[kind]}
      </span>
    </div>
  );
}

/** One compact tile: the served booked % + status chip and "load of capacity". */
function BookedTile({
  name,
  sub,
  figures,
  unit,
  testId,
}: {
  name: string;
  sub?: string;
  figures: Pick<ResourceFigures, 'load' | 'capacity' | 'bookedPct' | 'bookingStatus'>;
  unit: string;
  testId: string;
}): React.JSX.Element {
  return (
    <li
      className="flex min-w-0 flex-col gap-1 rounded-dash border border-dash-hairline bg-dash-alt px-s3 py-s2"
      data-testid={testId}
    >
      <span className="truncate text-xs font-bold text-text" title={sub ? `${name} (${sub})` : name}>
        {name}
        {sub ? <span className="font-medium text-text-subtle"> · {sub}</span> : null}
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-sm font-bold tabular-nums text-text" data-numeric="">
          {formatBookedPct(figures.bookedPct)}
        </span>
        <BookingStatusChip status={figures.bookingStatus} />
      </span>
      {figures.bookedPct === null ? <span className="text-2xs text-text-muted">No capacity in scope</span> : null}
      <span className="text-2xs text-text-muted" data-numeric="">
        {formatDecimal(figures.load)} of {formatDecimal(figures.capacity)} {unit}
      </span>
    </li>
  );
}

/** Every in-scope hub (design) and lab region (lab): served rows only, never summed here. */
function PerResourceTiles({ rows, horizon }: { rows: HubCapacityRow[]; horizon: CapacityHorizon }): React.JSX.Element {
  const regions = labRegionRows(rows);
  return (
    <div className="grid gap-s3 lg:grid-cols-2" data-testid="booked-tiles">
      <div className="space-y-s2">
        <h3 className="label-caps text-text-muted">Design booked, per hub</h3>
        <ul className="grid gap-s2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <BookedTile
              key={r.hub}
              name={r.hub}
              figures={pickFigures(r, 'design', horizon)}
              unit="engineer-wks"
              testId={`booked-design-${r.hub}`}
            />
          ))}
        </ul>
      </div>
      <div className="space-y-s2">
        <h3 className="label-caps text-text-muted">Lab booked, per lab region</h3>
        <ul className="grid gap-s2 sm:grid-cols-2 xl:grid-cols-3">
          {regions.map((l) => (
            <BookedTile
              key={l.region}
              name={l.region}
              sub={l.hubs.join(', ')}
              figures={pickFigures(l.row, 'lab', horizon)}
              unit="chamber-wks"
              testId={`booked-lab-${l.region}`}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

export function AreaBookingStrip({
  areas,
  horizon,
  rows,
}: {
  areas: CapacityArea[];
  horizon: CapacityHorizon;
  /** P19: the served hub rows; when given, a tile per hub and per lab region is shown too. */
  rows?: HubCapacityRow[];
}): React.JSX.Element | null {
  const scopedToHubs = useSessionStore((s) => (s.me ? !s.me.hub_scope_all : false));
  if (areas.length === 0) return null;
  return (
    <section aria-labelledby="capacity-area-strip-heading" className="space-y-s2" data-testid="area-booking-strip">
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <h2 id="capacity-area-strip-heading" className="text-h2 text-text">
          Capacity booked
        </h2>
        <div className="flex items-center gap-s2">
          <Badge tone="outline" className="rounded-pill" data-testid="area-strip-horizon">
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
              Europe = the Greece and Romania lab regions, including the OEM hubs (OEM-HCK and
              OEM-Seltek use the Greece lab region); India = the India lab region (R&amp;D-India and
              PD-India). Each lab region is counted once per area. The YTD 2026 / Full year toggle in the page header picks which figures are shown here.
            </p>
          </CardInfo>
        </div>
      </div>
      <div className="grid gap-gutter md:grid-cols-2">
        {areas.map((area) => (
          <article
            key={area.area}
            aria-labelledby={`capacity-area-${area.area}`}
            className="space-y-s3 rounded-dash border border-dash-hairline bg-surface p-card shadow-dashCard"
            data-testid="capacity-area-card"
          >
            <header className="space-y-1">
              <div className="flex flex-wrap items-center gap-s2">
                <h3 id={`capacity-area-${area.area}`} className="flex items-center gap-1.5 text-h2 text-text">
                  <MapPin className="size-4 text-text-muted" aria-hidden="true" />
                  {area.area}
                </h3>
                {scopedToHubs ? (
                  <Badge tone="warning" className="rounded-pill" title="Only the hubs in your scope are counted">
                    Your hubs only
                  </Badge>
                ) : null}
              </div>
              <p className="text-2xs text-text-muted" data-testid={`area-${area.area}-coverage`}>
                Hubs: <span className="font-semibold text-text">{area.hubs.join(', ')}</span>
                <span aria-hidden="true"> · </span>
                Lab regions: <span className="font-semibold text-text">{area.lab_regions.join(', ')}</span>
              </p>
            </header>
            <div className="grid gap-s2 sm:grid-cols-2">
              <AreaResource area={area} kind="design" horizon={horizon} />
              <AreaResource area={area} kind="lab" horizon={horizon} />
            </div>
          </article>
        ))}
      </div>
      {rows && rows.length > 0 ? <PerResourceTiles rows={rows} horizon={horizon} /> : null}
    </section>
  );
}
