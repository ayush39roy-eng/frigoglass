import type { CapacityArea, HubCapacityRow, HubCapacitySummary } from './api/types';

/** Shared P9 fixture: PD-India from `docs/CLIENT_FORMULAS.md` §2 (values as the
 *  server would serve them; nothing here is computed by the tests). */
export function hubRow(overrides: Partial<HubCapacityRow> = {}): HubCapacityRow {
  return {
    hub: 'PD-India',
    lab_region: 'India',
    design_load_weeks: 587,
    design_load_estimated_weeks: 451.5,
    lab_load_weeks: 496.5,
    lab_load_estimated_weeks: 2521,
    engineer_fte_total: 5.75,
    working_weeks_per_engineer: 43.93,
    design_capacity_year: 252.62,
    design_capacity_remaining: 179.75,
    lab_capacity_year: 186.22,
    lab_capacity_remaining: 132.5,
    design_gap_year: 334.38,
    design_completion_pct_year: 0.43,
    design_gap_remaining: 407.25,
    design_completion_pct_remaining: 0.31,
    lab_gap_year: 310.28,
    lab_completion_pct_year: 0.38,
    lab_gap_remaining: 364,
    lab_completion_pct_remaining: 0.27,
    remaining_fraction: 0.4038,
    chambers: [
      { chamber_id: 'ch-2', code: 'IN-CH-2', platforms: 4, efficiency: 0.6, working_weeks_per_chamber: 35.4, efficient_lab_weeks: 84.96 },
      { chamber_id: 'ch-1', code: 'IN-CH-1', platforms: 1, efficiency: 0.7, working_weeks_per_chamber: 45.4, efficient_lab_weeks: 31.78 },
    ],
    // P11 (ADR 0016): booked % = load / capacity × 100, as the server serves it.
    design_booked_pct_year: 232.36,
    design_booked_pct_remaining: 326.56,
    lab_booked_pct_year: 266.62,
    lab_booked_pct_remaining: 374.72,
    design_booking_status_year: 'full',
    design_booking_status_remaining: 'full',
    lab_booking_status_year: 'full',
    lab_booking_status_remaining: 'full',
    area: 'India',
    ...overrides,
  };
}

/** P11 (ADR 0016): one served area roll-up. Figures are illustrative, as the
 *  server would serve them; nothing here is computed by the tests. */
export function areaRow(overrides: Partial<CapacityArea> = {}): CapacityArea {
  return {
    area: 'Europe',
    hubs: ['R&D-Greece', 'PD-Romania'],
    lab_regions: ['Greece', 'Romania'],
    design_load_weeks: 210,
    design_capacity_year: 289.9,
    design_capacity_remaining: 193.2,
    lab_load_weeks: 140,
    lab_capacity_year: 289.26,
    lab_capacity_remaining: 205.82,
    design_booked_pct_year: 72.44,
    design_booked_pct_remaining: 108.7,
    lab_booked_pct_year: 48.4,
    lab_booked_pct_remaining: 68.02,
    design_booking_status_year: 'available',
    design_booking_status_remaining: 'full',
    lab_booking_status_year: 'available',
    lab_booking_status_remaining: 'available',
    ...overrides,
  };
}

/** P11 contract §4 summary fields, for tests that build a `HubCapacitySummary`. */
export const SUMMARY_P11: Pick<HubCapacitySummary, 'near_full_threshold_pct' | 'full_threshold_pct' | 'areas'> = {
  near_full_threshold_pct: 85,
  full_threshold_pct: 100,
  areas: [],
};
