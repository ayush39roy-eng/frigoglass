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
};
