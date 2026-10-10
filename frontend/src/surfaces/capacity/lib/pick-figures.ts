import type { BookingStatus, CapacityArea, HubCapacityRow } from '../api/types';

/** Selects which SERVED fields to show for a resource kind and horizon (ADR
 *  0008). Never combines them — every figure is one API field (I17). */
export type CapacityHorizon = 'year' | 'remaining';
export type ResourceKind = 'design' | 'lab';

export interface ResourceFigures {
  load: number;
  loadEstimated: number;
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
          loadEstimated: row.design_load_estimated_weeks,
          capacity: row.design_capacity_year,
          gap: row.design_gap_year,
          completionPct: row.design_completion_pct_year,
          bookedPct: row.design_booked_pct_year,
          bookingStatus: row.design_booking_status_year,
        }
      : {
          load: row.design_load_weeks,
          loadEstimated: row.design_load_estimated_weeks,
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
        loadEstimated: row.lab_load_estimated_weeks,
        capacity: row.lab_capacity_year,
        gap: row.lab_gap_year,
        completionPct: row.lab_completion_pct_year,
        bookedPct: row.lab_booked_pct_year,
        bookingStatus: row.lab_booking_status_year,
      }
    : {
        load: row.lab_load_weeks,
        loadEstimated: row.lab_load_estimated_weeks,
        capacity: row.lab_capacity_remaining,
        gap: row.lab_gap_remaining,
        completionPct: row.lab_completion_pct_remaining,
        bookedPct: row.lab_booked_pct_remaining,
        bookingStatus: row.lab_booking_status_remaining,
      };
}


export interface AreaBookingFigures {
  load: number;
  capacity: number;
  bookedPct: number | null;
  bookingStatus: BookingStatus;
}

/** Selects one served area figure set (P11 contract §4, ADR 0016). Selection
 *  only: the area sums, the booked % and the status all come from the server
 *  (I19), with each lab region counted once there. */
export function pickAreaFigures(
  area: CapacityArea,
  kind: ResourceKind,
  horizon: CapacityHorizon,
): AreaBookingFigures {
  if (kind === 'design') {
    return horizon === 'year'
      ? {
          load: area.design_load_weeks,
          capacity: area.design_capacity_year,
          bookedPct: area.design_booked_pct_year,
          bookingStatus: area.design_booking_status_year,
        }
      : {
          load: area.design_load_weeks,
          capacity: area.design_capacity_remaining,
          bookedPct: area.design_booked_pct_remaining,
          bookingStatus: area.design_booking_status_remaining,
        };
  }
  return horizon === 'year'
    ? {
        load: area.lab_load_weeks,
        capacity: area.lab_capacity_year,
        bookedPct: area.lab_booked_pct_year,
        bookingStatus: area.lab_booking_status_year,
      }
    : {
        load: area.lab_load_weeks,
        capacity: area.lab_capacity_remaining,
        bookedPct: area.lab_booked_pct_remaining,
        bookingStatus: area.lab_booking_status_remaining,
      };
}
