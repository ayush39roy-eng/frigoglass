import type { BookingStatus, CapacityArea, CapacityTotals, HubCapacityRow, YearRemaining } from '../api/types';

/** Selects which SERVED fields to show for a resource kind and horizon (ADR
 *  0008). Never combines them — every figure is one API field (I17). */
export type CapacityHorizon = 'year' | 'remaining';
export type ResourceKind = 'design' | 'lab';

/**
 * P30 (ADR 0041, I19 rev.): `load` is the DEMAND paired with the horizon's
 * capacity: full-year demand (`*_load_weeks`) for "year", remaining demand
 * (`*_load_remaining_weeks`) for "remaining". `booked` is what the active run
 * booked (`*_load_booked_weeks`, I6/I7), the same on both horizons; nothing
 * (no %, gap or status) is served against it.
 */
export interface ResourceFigures {
  load: number;
  booked: number;
  capacity: number;
  gap: number;
  completionPct: number | null;
  /** P11 (ADR 0016): served `*_booked_pct_*` — load / capacity × 100, null when capacity is 0. */
  bookedPct: number | null;
  /** P11 (ADR 0016): served `*_booking_status_*`. */
  bookingStatus: BookingStatus;
}

export function pickFigures(
  row: HubCapacityRow,
  kind: ResourceKind,
  horizon: CapacityHorizon,
): ResourceFigures {
  if (kind === 'design') {
    return horizon === 'year'
      ? {
          load: row.design_load_weeks,
          booked: row.design_load_booked_weeks,
          capacity: row.design_capacity_year,
          gap: row.design_gap_year,
          completionPct: row.design_completion_pct_year,
          bookedPct: row.design_booked_pct_year,
          bookingStatus: row.design_booking_status_year,
        }
      : {
          load: row.design_load_remaining_weeks,
          booked: row.design_load_booked_weeks,
          capacity: row.design_capacity_remaining,
          gap: row.design_gap_remaining,
          completionPct: row.design_completion_pct_remaining,
          bookedPct: row.design_booked_pct_remaining,
          bookingStatus: row.design_booking_status_remaining,
        };
  }
  return horizon === 'year'
    ? {
        load: row.lab_load_weeks,
        booked: row.lab_load_booked_weeks,
        capacity: row.lab_capacity_year,
        gap: row.lab_gap_year,
        completionPct: row.lab_completion_pct_year,
        bookedPct: row.lab_booked_pct_year,
        bookingStatus: row.lab_booking_status_year,
      }
    : {
        load: row.lab_load_remaining_weeks,
        booked: row.lab_load_booked_weeks,
        capacity: row.lab_capacity_remaining,
        gap: row.lab_gap_remaining,
        completionPct: row.lab_completion_pct_remaining,
        bookedPct: row.lab_booked_pct_remaining,
        bookingStatus: row.lab_booking_status_remaining,
      };
}


export interface AreaBookingFigures {
  /** P30: full-year demand ("year") or remaining demand ("remaining"). */
  load: number;
  /** P30: booked by the active run (no % served). */
  booked: number;
  capacity: number;
  bookedPct: number | null;
  bookingStatus: BookingStatus;
}

/** The served roll-up fields shared by an area (`CapacityArea`) and the
 *  portfolio totals (`CapacityTotals`, P13-T11 addendum). */
export type RollupFigures = Pick<
  CapacityArea,
  | 'design_load_weeks'
  | 'design_load_remaining_weeks'
  | 'design_load_booked_weeks'
  | 'design_capacity_year'
  | 'design_capacity_remaining'
  | 'design_booked_pct_year'
  | 'design_booked_pct_remaining'
  | 'design_booking_status_year'
  | 'design_booking_status_remaining'
  | 'lab_load_weeks'
  | 'lab_load_remaining_weeks'
  | 'lab_load_booked_weeks'
  | 'lab_capacity_year'
  | 'lab_capacity_remaining'
  | 'lab_booked_pct_year'
  | 'lab_booked_pct_remaining'
  | 'lab_booking_status_year'
  | 'lab_booking_status_remaining'
>;

/** Selects one served area (or portfolio-total) figure set (P11 contract §4,
 *  ADR 0016). Selection only: the sums, the booked % and the status all come
 *  from the server (I19), with each lab region counted once there. */
export function pickAreaFigures(
  area: RollupFigures,
  kind: ResourceKind,
  horizon: CapacityHorizon,
): AreaBookingFigures {
  if (kind === 'design') {
    return horizon === 'year'
      ? {
          load: area.design_load_weeks,
          booked: area.design_load_booked_weeks,
          capacity: area.design_capacity_year,
          bookedPct: area.design_booked_pct_year,
          bookingStatus: area.design_booking_status_year,
        }
      : {
          load: area.design_load_remaining_weeks,
          booked: area.design_load_booked_weeks,
          capacity: area.design_capacity_remaining,
          bookedPct: area.design_booked_pct_remaining,
          bookingStatus: area.design_booking_status_remaining,
        };
  }
  return horizon === 'year'
    ? {
        load: area.lab_load_weeks,
        booked: area.lab_load_booked_weeks,
        capacity: area.lab_capacity_year,
        bookedPct: area.lab_booked_pct_year,
        bookingStatus: area.lab_booking_status_year,
      }
    : {
        load: area.lab_load_remaining_weeks,
        booked: area.lab_load_booked_weeks,
        capacity: area.lab_capacity_remaining,
        bookedPct: area.lab_booked_pct_remaining,
        bookingStatus: area.lab_booking_status_remaining,
      };
}

/* ------------------------------------------------------------------------ *
 * P19-T05: the Weeks | Days unit (API_CONTRACT_P19 §1).
 *
 * Days figures are SERVED (`capacity_days`, `load_days`, `lab_capacity_days`,
 * `lab_load_days` on each hub row; `design_/lab_ capacity_days / load_days` on
 * `totals`): the server multiplies served weeks by the hub's (or lab region's)
 * served `weekdays_per_week`. The browser never multiplies (I19). These
 * helpers only SELECT the served field for the unit and horizon. A day field
 * missing from an older API is `null`, which renders "—".
 *
 * Booked % and its status are unit-free (load / capacity), so they are the
 * same served fields in both units.
 * ------------------------------------------------------------------------ */
export type CapacityUnit = 'weeks' | 'days';

/** The page's ONE view state: both header toggles (P19-T05). */
export interface CapacityView {
  horizon: CapacityHorizon;
  unit: CapacityUnit;
}

export const DEFAULT_CAPACITY_VIEW: CapacityView = { horizon: 'year', unit: 'weeks' };

/** Short unit, e.g. after a KPI figure. */
export const UNIT_SHORT: Record<CapacityUnit, string> = { weeks: 'wks', days: 'days' };

/** Resource unit, e.g. "engineer-days". */
export function resourceUnit(kind: ResourceKind, unit: CapacityUnit): string {
  return `${kind === 'design' ? 'engineer' : 'chamber'}-${UNIT_SHORT[unit]}`;
}

/** Long resource unit for prose and accessible names, e.g. "chamber-weeks". */
export function resourceUnitLong(kind: ResourceKind, unit: CapacityUnit): string {
  return `${kind === 'design' ? 'engineer' : 'chamber'}-${unit}`;
}

export interface UnitFigures {
  /** Served demand for the horizon in the unit (P30: full-year or remaining
   *  demand; `load_days.remaining` is served from the remaining demand); null
   *  when the served day field is absent. */
  load: number | null;
  /** Served capacity for the horizon in the unit; null when absent. */
  capacity: number | null;
  bookedPct: number | null;
  bookingStatus: BookingStatus;
}

function servedPair(pair: YearRemaining | undefined, horizon: CapacityHorizon): number | null {
  if (pair === undefined) return null;
  const v = pair[horizon];
  return typeof v === 'number' ? v : null;
}

/** A hub row's design or lab load / capacity in the unit (served fields only). */
export function pickUnitFigures(
  row: HubCapacityRow,
  kind: ResourceKind,
  view: CapacityView,
): UnitFigures {
  const weeks = pickFigures(row, kind, view.horizon);
  const base = { bookedPct: weeks.bookedPct, bookingStatus: weeks.bookingStatus };
  if (view.unit === 'weeks') return { ...base, load: weeks.load, capacity: weeks.capacity };
  // An older API may not serve the day fields: read them as optional.
  const served: Partial<HubCapacityRow> = row;
  return kind === 'design'
    ? { ...base, load: servedPair(served.load_days, view.horizon), capacity: servedPair(served.capacity_days, view.horizon) }
    : {
        ...base,
        load: servedPair(served.lab_load_days, view.horizon),
        capacity: servedPair(served.lab_capacity_days, view.horizon),
      };
}

/** The served portfolio totals' design or lab figures in the unit. */
export function pickTotalUnitFigures(
  totals: CapacityTotals,
  kind: ResourceKind,
  view: CapacityView,
): UnitFigures {
  const weeks = pickAreaFigures(totals, kind, view.horizon);
  const base = { bookedPct: weeks.bookedPct, bookingStatus: weeks.bookingStatus };
  if (view.unit === 'weeks') return { ...base, load: weeks.load, capacity: weeks.capacity };
  const served: Partial<CapacityTotals> = totals;
  return kind === 'design'
    ? {
        ...base,
        load: servedPair(served.design_load_days, view.horizon),
        capacity: servedPair(served.design_capacity_days, view.horizon),
      }
    : {
        ...base,
        load: servedPair(served.lab_load_days, view.horizon),
        capacity: servedPair(served.lab_capacity_days, view.horizon),
      };
}

/* ------------------------------------------------------------------------ *
 * P30 (ADR 0041, API_CONTRACT_P30 §4): wording for the load columns. The
 * demand a horizon pairs with (I19 rev.) and the run-booked figure, which has
 * no served day value, booked % or gap.
 * ------------------------------------------------------------------------ */

/** Column / stat label of the demand the horizon pairs with. */
export const DEMAND_LABEL: Record<CapacityHorizon, string> = {
  year: 'Full-year demand',
  remaining: 'Remaining demand',
};

/** Short label of the run-booked figure. */
export const BOOKED_IN_PLAN_LABEL = 'Booked in plan';

/** The served weekdays per week behind a row's day figures, or null if absent. */
export function servedWeekdays(row: HubCapacityRow, kind: ResourceKind): number | null {
  const served: Partial<HubCapacityRow> = row;
  const v = kind === 'design' ? served.weekdays_per_week : served.lab_weekdays_per_week;
  return typeof v === 'number' ? v : null;
}
