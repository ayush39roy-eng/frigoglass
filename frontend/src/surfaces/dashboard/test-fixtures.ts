import type { ProjectFilterRow } from './api/types';

/** P13 (API_CONTRACT_P13 §3): the register fields every `/dashboard/projects`
 *  row now carries, with neutral values, for test row builders. */
export const P13_ROW_DEFAULTS: Pick<
  ProjectFilterRow,
  | 'external_code'
  | 'type'
  | 'region'
  | 'leader_name'
  | 'leader_engineer_id'
  | 'current_step_code'
  | 'current_step_name'
  | 'end_week'
  | 'outcome'
  | 'reg_year'
  | 'carry_over'
  | 'priority_rank'
  | 'plant'
  | 'requesting_department'
  | 'product_type'
  | 'actual_start_week'
  | 'actual_end_week'
  | 'design_effort_weeks'
  | 'lab_effort_weeks'
  | 'design_weeks_calculated'
  | 'lab_weeks_calculated'
  | 'expected_status'
  | 'status_mismatch'
> = {
  external_code: null,
  type: null,
  region: 'Greece',
  leader_name: null,
  leader_engineer_id: null,
  current_step_code: null,
  current_step_name: null,
  end_week: null,
  outcome: null,
  reg_year: 2026,
  carry_over: false,
  priority_rank: null,
  plant: null,
  requesting_department: null,
  product_type: null,
  // P35-T01
  actual_start_week: null,
  actual_end_week: null,
  design_effort_weeks: null,
  lab_effort_weeks: null,
  design_weeks_calculated: 0,
  lab_weeks_calculated: 0,
  // P35-T08b
  expected_status: null,
  status_mismatch: false,
};
