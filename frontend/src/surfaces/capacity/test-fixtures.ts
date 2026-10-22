import type { CapacityArea, CapacityTotals, ClassBreakdownRow, HubCapacityRow, HubCapacitySummary } from './api/types';

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
    // P13-T11 (API_CONTRACT_P13 §6): served priority buckets; they sum to the loads above.
    design_load_by_priority: { P1: 400, P2: 100, P3: 50, P4: 0, Queue: 37 },
    lab_load_by_priority: { P1: 300, P2: 96.5, P3: 0, P4: 0, Queue: 100 },
    // P19-T03 (API_CONTRACT_P19 §1): served days (PD-India and the India region work 6 days).
    weekdays_per_week: 6,
    capacity_days: { year: 1515.72, remaining: 1078.5 },
    load_days: { year: 3522, remaining: 3522 },
    lab_weekdays_per_week: 6,
    lab_capacity_days: { year: 1117.32, remaining: 795 },
    lab_load_days: { year: 2979, remaining: 2979 },
    // P29 (API_CONTRACT_P29 §2.2): PD-India has no member hubs.
    members: [],
    selected_member: null,
    ...overrides,
  };
}

/**
 * P29 (API_CONTRACT_P29 §11): the Greece capacity row as served after the
 * client_2026 reseed: own 32 wk / 3 projects, OEM-HCK 55 / 11, OEM-Seltek 44 / 8,
 * row load 131 against 124.88 capacity (104.90 % booked). Values as the server
 * serves them; nothing here is computed by the tests.
 */
export function greeceRow(overrides: Partial<HubCapacityRow> = {}): HubCapacityRow {
  return hubRow({
    hub: 'R&D-Greece',
    lab_region: 'Greece',
    area: 'Europe',
    design_load_weeks: 131,
    design_load_estimated_weeks: 120,
    engineer_fte_total: 2.8,
    working_weeks_per_engineer: 44.6,
    design_capacity_year: 124.88,
    design_capacity_remaining: 23.61,
    design_gap_year: 6.12,
    design_gap_remaining: 107.39,
    design_completion_pct_year: 0.95,
    design_completion_pct_remaining: 0.18,
    design_booked_pct_year: 104.9,
    design_booked_pct_remaining: 554.85,
    design_booking_status_year: 'full',
    design_booking_status_remaining: 'full',
    design_load_by_priority: { P1: 60, P2: 40, P3: 20, P4: 0, Queue: 11 },
    weekdays_per_week: 5,
    capacity_days: { year: 624.4, remaining: 118.05 },
    load_days: { year: 655, remaining: 655 },
    members: [
      { hub: 'R&D-Greece', own: true, project_count: 3, design_load_weeks: 32 },
      { hub: 'OEM-HCK', own: false, project_count: 11, design_load_weeks: 55 },
      { hub: 'OEM-Seltek', own: false, project_count: 8, design_load_weeks: 44 },
    ],
    selected_member: null,
    ...overrides,
  });
}

/** P13-T11: one served class-breakdown row (counts as the server would serve them). */
export function classRow(overrides: Partial<ClassBreakdownRow> = {}): ClassBreakdownRow {
  return {
    category: 'B',
    deliverable_count: 37,
    left_out_count: 125,
    total_count: 162,
    deliverable_by_priority: { P1: 32, P2: 0, P3: 0, P4: 0, Queue: 5 },
    left_out_by_priority: { P1: 87, P2: 1, P3: 0, P4: 0, Queue: 37 },
    by_hub: [
      { hub: 'R&D-Greece', deliverable: 0, left_out: 2 },
      { hub: 'PD-Romania', deliverable: 16, left_out: 3 },
      { hub: 'PD-India', deliverable: 21, left_out: 120 },
    ],
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

/** P13-T11 addendum: the served portfolio totals (as the server would serve
 *  them for the single `hubRow()` PD-India row; nothing is computed by tests). */
export function totalsRow(overrides: Partial<CapacityTotals> = {}): CapacityTotals {
  return {
    hubs: ['PD-India'],
    lab_regions: ['India'],
    design_load_weeks: 587,
    design_capacity_year: 252.62,
    design_capacity_remaining: 179.75,
    design_booked_pct_year: 232.36,
    design_booked_pct_remaining: 326.56,
    design_booking_status_year: 'full',
    design_booking_status_remaining: 'full',
    design_load_by_priority: { P1: 400, P2: 100, P3: 50, P4: 0, Queue: 37 },
    lab_load_weeks: 496.5,
    lab_capacity_year: 186.22,
    lab_capacity_remaining: 132.5,
    lab_booked_pct_year: 266.62,
    lab_booked_pct_remaining: 374.72,
    lab_booking_status_year: 'full',
    lab_booking_status_remaining: 'full',
    lab_load_by_priority: { P1: 300, P2: 96.5, P3: 0, P4: 0, Queue: 100 },
    // P19-T03: served day totals for the single PD-India row.
    design_capacity_days: { year: 1515.72, remaining: 1078.5 },
    design_load_days: { year: 3522, remaining: 3522 },
    lab_capacity_days: { year: 1117.32, remaining: 795 },
    lab_load_days: { year: 2979, remaining: 2979 },
    ...overrides,
  };
}

/** P11 contract §4 summary fields (+ the P13-T11 served `totals`), for tests
 *  that build a `HubCapacitySummary`. */
export const SUMMARY_P11: Pick<
  HubCapacitySummary,
  'near_full_threshold_pct' | 'full_threshold_pct' | 'areas' | 'totals' | 'lab_regions'
> = {
  near_full_threshold_pct: 85,
  full_threshold_pct: 100,
  areas: [],
  totals: totalsRow(),
  // P19-T03: the India region row, served once.
  lab_regions: [
    {
      lab_region: 'India',
      weekdays_per_week: 6,
      chamber_count: 2,
      capacity_weeks: { year: 186.22, remaining: 132.5 },
      load_weeks: 496.5,
      capacity_days: { year: 1117.32, remaining: 795 },
      load_days: { year: 2979, remaining: 2979 },
    },
  ],
};
