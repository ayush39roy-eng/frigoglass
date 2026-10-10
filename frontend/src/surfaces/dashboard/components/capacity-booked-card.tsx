import * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { BoltCard } from '@/components/ui/bolt-card';
import { Badge } from '@/components/ui/badge';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardInfo } from '@/components/ui/card-info';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { formatBookedPct } from '@/lib/format';
import { useHubLoadVsCapacity } from '@/surfaces/capacity/hooks/use-capacity';
import type { CapacityArea } from '@/surfaces/capacity/api/types';
import type { BookingStatus } from '@/types/enums';

/**
 * Dashboard "Capacity booked" (ADR 0016, P11-T02): "Europe — Design 90 % ·
 * Lab 50 %" with Full / Near full / Available chips. Same endpoint, hook and
 * cache entry as the Capacity surface (`GET /capacity/hub-load`). Full-year
 * figures, the workbook's own comparison. Every figure and status is served
 * (I19). The page renders this only when the session can read Capacity.
 */

function Figure({
  label,
  pct,
  status,
  testId,
}: {
  label: string;
  pct: number | null;
  status: BookingStatus;
  testId: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={testId}>
      <span className="text-2xs font-semibold text-text-muted">{label}</span>
      <span className="font-mono text-sm font-bold tabular-nums text-text" data-numeric="">
        {formatBookedPct(pct)}
      </span>
      <BookingStatusChip status={status} />
    </span>
  );
}

function AreaLine({ area }: { area: CapacityArea }): React.JSX.Element {
  return (
    <li className="space-y-1.5 border-b border-dash-hairline py-2.5 last:border-b-0" data-testid="capacity-booked-area">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-16 text-sm font-extrabold text-text">{area.area}</span>
        <Figure
          label="Design"
          pct={area.design_booked_pct_year}
          status={area.design_booking_status_year}
          testId={`dash-booked-${area.area}-design`}
        />
        <span aria-hidden="true" className="text-text-subtle">
          ·
        </span>
        <Figure
          label="Lab"
          pct={area.lab_booked_pct_year}
          status={area.lab_booking_status_year}
          testId={`dash-booked-${area.area}-lab`}
        />
      </div>
      <p className="truncate text-2xs text-text-muted" title={area.hubs.join(', ')}>
        Covers {area.hubs.join(', ')}
      </p>
    </li>
  );
}

export function CapacityBookedCard(): React.JSX.Element | null {
  const query = useHubLoadVsCapacity();
  if (query.isPending) return <PanelSkeleton height="h-40" />;
  const data = query.data;
  // A read error (e.g. a stale permission table) or no run / no area in scope:
  // this compact card stays out of the way. The Capacity surface explains more.
  if (!data || !data.has_active_schedule_run || data.areas.length === 0) return null;

  return (
    <BoltCard data-testid="capacity-booked-card">
      <CardHeader className="flex-wrap gap-y-2">
        <CardTitle>Capacity booked</CardTitle>
        <div className="flex items-center gap-2">
          <Badge tone="outline" className="rounded-pill">
            Full year
          </Badge>
          <CardInfo label="Capacity booked source">
            <p>
              Booked % = load / capacity &times; 100 for each area, computed on the server to two decimals
              (ADR&nbsp;0016). Full from 100&nbsp;%, Near full from 85&nbsp;%. Over 100&nbsp;% means more work
              is planned than the capacity can deliver.
            </p>
            <p>
              Europe = the Greece and Romania lab regions; India = the India lab region, including the OEM
              hubs. Only the hubs in your scope are counted. Reporting figures only: they never stop the
              scheduler booking work.
            </p>
          </CardInfo>
          <Link
            to="/capacity"
            className="inline-flex items-center gap-0.5 rounded-pill px-2 py-1 text-2xs font-semibold text-primary hover:bg-primary-subtle"
          >
            Open capacity
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <ul aria-label="Capacity booked by area">
          {data.areas.map((area) => (
            <AreaLine key={area.area} area={area} />
          ))}
        </ul>
      </CardContent>
    </BoltCard>
  );
}
