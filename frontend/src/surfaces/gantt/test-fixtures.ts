import type { GanttProjectRow } from './api/types';

/** P13-T13 (API_CONTRACT_P13 §7) fields for test row builders. */
export const P13_GANTT_ROW_DEFAULTS: Pick<
  GanttProjectRow,
  'external_code' | 'type' | 'leader_name' | 'leader_engineer_id' | 'design_weeks' | 'lab_weeks' | 'total_weeks'
> = {
  external_code: null,
  type: null,
  leader_name: null,
  leader_engineer_id: null,
  design_weeks: null,
  lab_weeks: null,
  total_weeks: null,
};
