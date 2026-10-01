import type { HubCapacityRow } from './api/types';

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
    ...overrides,
  };
}
