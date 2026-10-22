import * as React from 'react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { formatBookedPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import type { CapacityTotals, HubCapacityRow } from '../api/types';
import { labRegionRows } from '../lib/lab-region-rows';
import {
  BOOKED_IN_PLAN_LABEL,
  pickAreaFigures,
  pickTotalUnitFigures,
  pickUnitFigures,
  UNIT_SHORT,
  type CapacityView,
} from '../lib/pick-figures';
import { formatFigure } from '../lib/status-format';
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
 * breakdown lines are the hub rows' own figures; `pickUnitFigures` /
 * `pickTotalUnitFigures` only SELECT the year or remaining field in weeks or
 * the SERVED days (P19-T05). Nothing here sums or multiplies. The per-priority
 * split is served in weeks only, so in Days mode it is labelled "(wks)".
 *
 * P30 (ADR 0041, I19 rev.): the load cards are DEMAND cards. Full year: the
 * full-year demand (booked % against the yearly capacity) with its served
 * priority split; remaining year: the remaining demand (booked % against the
 * remaining capacity), without the split (it splits the full-year demand only).
 * Each adds "Booked in plan" (the run-booked weeks, served; no % of its kind).
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
  value: number | null;
  unit: string;
  accent: Accent;
  testId: string;
  footer: React.ReactNode;
  booked?: { pct: number | null; status: BookingStatus };
  /** P30: a short qualifier after the label, e.g. "full year". */
  qualifier?: string;
}

function KpiCard({ label, value, unit, accent, testId, footer, booked, qualifier }: KpiCardProps): React.JSX.Element {
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
      <p className="label-caps text-text-subtle">
        {label}
        {qualifier ? (
          <span className="ml-1 font-medium normal-case tracking-normal text-text-muted" data-testid={`${testId}-qualifier`}>
            · {qualifier}
          </span>
        ) : null}
      </p>
      <p className="flex items-baseline gap-1.5" data-numeric="">
        <span className="font-display text-3xl font-extrabold tabular-nums text-text" data-testid={`${testId}-value`}>
          {formatFigure(value)}
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
  view: CapacityView;
}

export function CapacityKpiRow({ totals, rows, view }: CapacityKpiRowProps): React.JSX.Element {
  const design = pickTotalUnitFigures(totals, 'design', view);
  const lab = pickTotalUnitFigures(totals, 'lab', view);
  const regions = labRegionRows(rows);
  const unit = UNIT_SHORT[view.unit];
  // The priority split is served in weeks only: name its unit when the card is in days.
  const splitUnit = view.unit === 'days' ? UNIT_SHORT.weeks : undefined;
  const year = view.horizon === 'year';
  const qualifier = year ? 'full year' : 'remaining';
  // P30: run-booked weeks (served, weeks only).
  const designInPlan = pickAreaFigures(totals, 'design', view.horizon).booked;
  const labInPlan = pickAreaFigures(totals, 'lab', view.horizon).booked;

  return (
    <section aria-label="Capacity headline figures" className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-4" data-testid="capacity-kpi-row">
      <KpiCard
        label="Design capacity"
        value={design.capacity}
        unit={unit}
        accent="ink"
        testId="kpi-design-capacity"
        footer={
          <KpiCaptions
            label="Design capacity"
            partsLabel="By hub"
            parts={rows.map((r) => ({ key: r.hub, label: r.hub, value: pickUnitFigures(r, 'design', view).capacity }))}
          />
        }
      />
      <KpiCard
        label="Design demand"
        qualifier={qualifier}
        value={design.load}
        unit={unit}
        accent="primary"
        testId="kpi-design-load"
        booked={{ pct: design.bookedPct, status: design.bookingStatus }}
        footer={
          <KpiCaptions
            label="Design demand"
            {...(year ? { split: totals.design_load_by_priority } : {})}
            {...(splitUnit ? { splitUnit } : {})}
            partsLabel="By hub"
            parts={rows.map((r) => ({ key: r.hub, label: r.hub, value: pickUnitFigures(r, 'design', view).load }))}
            inPlan={{ label: BOOKED_IN_PLAN_LABEL, weeks: designInPlan, unit: UNIT_SHORT.weeks }}
          />
        }
      />
      <KpiCard
        label="Lab capacity"
        value={lab.capacity}
        unit={unit}
        accent="ink"
        testId="kpi-lab-capacity"
        footer={
          <KpiCaptions
            label="Lab capacity"
            partsLabel="By lab region"
            parts={regions.map((l) => ({ key: l.region, label: l.region, value: pickUnitFigures(l.row, 'lab', view).capacity }))}
          />
        }
      />
      <KpiCard
        label="Lab demand"
        qualifier={qualifier}
        value={lab.load}
        unit={unit}
        accent="success"
        testId="kpi-lab-load"
        booked={{ pct: lab.bookedPct, status: lab.bookingStatus }}
        footer={
          <KpiCaptions
            label="Lab demand"
            {...(year ? { split: totals.lab_load_by_priority } : {})}
            {...(splitUnit ? { splitUnit } : {})}
            partsLabel="By lab region"
            parts={regions.map((l) => ({ key: l.region, label: l.region, value: pickUnitFigures(l.row, 'lab', view).load }))}
            inPlan={{ label: BOOKED_IN_PLAN_LABEL, weeks: labInPlan, unit: UNIT_SHORT.weeks }}
          />
        }
      />
    </section>
  );
}
