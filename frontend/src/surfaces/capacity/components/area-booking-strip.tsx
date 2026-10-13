import * as React from 'react';
import { MapPin } from 'lucide-react';

import { BookedFigure } from '@/components/shared/booking-status-chip';
import { Badge } from '@/components/ui/badge';
import { CardInfo } from '@/components/ui/card-info';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatDecimal } from '@/lib/format';
import { useSessionStore } from '@/stores/session';

import type { CapacityArea } from '../api/types';
import { pickAreaFigures, type CapacityHorizon, type ResourceKind } from '../lib/pick-figures';

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

export function AreaBookingStrip({
  areas,
  horizon,
}: {
  areas: CapacityArea[];
  horizon: CapacityHorizon;
}): React.JSX.Element | null {
  const scopedToHubs = useSessionStore((s) => (s.me ? !s.me.hub_scope_all : false));
  if (areas.length === 0) return null;
  return (
    <section aria-labelledby="capacity-area-strip-heading" className="space-y-s2" data-testid="area-booking-strip">
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <h2 id="capacity-area-strip-heading" className="text-h2 text-text">
          Capacity booked by area
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
              PD-India). Each lab region is counted once per area. The Full year / Remaining year toggle
              on the per-hub card below picks which figures are shown here.
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
    </section>
  );
}
