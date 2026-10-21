import * as React from 'react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { formatBookedPct, formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import type { CapacityTotals, HubCapacityRow } from '../api/types';
import { labRegionRows } from '../lib/lab-region-rows';
import { pickAreaFigures, pickFigures, type CapacityHorizon } from '../lib/pick-figures';
import { KpiCaptions } from './kpi-captions';

/**
 * The four headline cards of the client's Capacity page (P19-T01, mock-up
 * parity): Design capacity, Design load, Lab capacity, Lab load. Each has a
 * coloured top border, one big figure with its unit, and a per-hub (design) or
 * per-lab-region (lab) breakdown line. The two load cards add the served
 * per-priority split and the served booked % (with its status chip) at the
 * right.
 *
 * Every number is one served field (I9/I19): the headline is `totals`
 * (design per hub, lab once per lab region, computed server-side); the
 * breakdown lines are the hub rows' own figures; `pickFigures` /
 * `pickAreaFigures` only SELECT the year or remaining field. Nothing here sums.
 */
type Accent = 'ink' | 'primary' | 'success';

const TOP_EDGE: Record<Accent, string> = {
  ink: 'border-t-text',
  primary: 'border-t-primary',
  success: 'border-t-success',
};

const STATUS_TEXT: Record<BookingStatus, string> = {
  full: 'text-danger-subtle-fg',
  near_full: 'text-warning-subtle-fg',
  available: 'text-success-subtle-fg',
};

interface KpiCardProps {
  label: string;
  value: number;
  unit: string;
  accent: Accent;
  testId: string;
  footer: React.ReactNode;
  booked?: { pct: number | null; status: BookingStatus };
}

function KpiCard({ label, value, unit, accent, testId, footer, booked }: KpiCardProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex min-w-0 flex-col gap-s2 rounded-dash border border-dash-hairline border-t-4 bg-surface p-card-tight shadow-dashCard',
        TOP_EDGE[accent],
      )}
      data-testid={testId}
    >
      <p className="label-caps text-text-subtle">{label}</p>
      <p className="flex items-baseline gap-1.5" data-numeric="">
        <span className="font-display text-3xl font-extrabold tabular-nums text-text" data-testid={`${testId}-value`}>
          {formatDecimal(value)}
        </span>
        <span className="text-xs font-semibold text-text-muted">{unit}</span>
      </p>
      <div className="flex flex-wrap items-end justify-between gap-x-s2 gap-y-1">
        <div className="min-w-0 flex-1">{footer}</div>
        {booked ? (
          <span className="flex shrink-0 flex-col items-end gap-1" data-testid={`${testId}-booked`}>
            <span className={cn('font-mono text-sm font-bold tabular-nums', STATUS_TEXT[booked.status])} data-numeric="">
              {formatBookedPct(booked.pct)}
            </span>
            <BookingStatusChip status={booked.status} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface CapacityKpiRowProps {
  totals: CapacityTotals;
  rows: HubCapacityRow[];
  horizon: CapacityHorizon;
}

export function CapacityKpiRow({ totals, rows, horizon }: CapacityKpiRowProps): React.JSX.Element {
  const design = pickAreaFigures(totals, 'design', horizon);
  const lab = pickAreaFigures(totals, 'lab', horizon);
  const regions = labRegionRows(rows);

  return (
    <section aria-label="Capacity headline figures" className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-4" data-testid="capacity-kpi-row">
      <KpiCard
        label="Design capacity"
        value={design.capacity}
        unit="wks"
        accent="ink"
        testId="kpi-design-capacity"
        footer={
          <KpiCaptions
            label="Design capacity"
            partsLabel="By hub"
            parts={rows.map((r) => ({ key: r.hub, label: r.hub, value: pickFigures(r, 'design', horizon).capacity }))}
          />
        }
      />
      <KpiCard
        label="Design load"
        value={design.load}
        unit="wks"
        accent="primary"
        testId="kpi-design-load"
        booked={{ pct: design.bookedPct, status: design.bookingStatus }}
        footer={
          <KpiCaptions
            label="Design load"
            split={totals.design_load_by_priority}
            partsLabel="By hub"
            parts={rows.map((r) => ({ key: r.hub, label: r.hub, value: r.design_load_weeks }))}
          />
        }
      />
      <KpiCard
        label="Lab capacity"
        value={lab.capacity}
        unit="wks"
        accent="ink"
        testId="kpi-lab-capacity"
        footer={
          <KpiCaptions
            label="Lab capacity"
            partsLabel="By lab region"
            parts={regions.map((l) => ({ key: l.region, label: l.region, value: pickFigures(l.row, 'lab', horizon).capacity }))}
          />
        }
      />
      <KpiCard
        label="Lab load"
        value={lab.load}
        unit="wks"
        accent="success"
        testId="kpi-lab-load"
        booked={{ pct: lab.bookedPct, status: lab.bookingStatus }}
        footer={
          <KpiCaptions
            label="Lab load"
            split={totals.lab_load_by_priority}
            partsLabel="By lab region"
            parts={regions.map((l) => ({ key: l.region, label: l.region, value: l.row.lab_load_weeks }))}
          />
        }
      />
    </section>
  );
}
