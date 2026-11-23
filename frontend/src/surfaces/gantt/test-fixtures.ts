import type { GanttProjectRow, GanttStepRow } from './api/types';

/** P13-T13 (API_CONTRACT_P13 §7) fields for test row builders. */
export const P13_GANTT_ROW_DEFAULTS: Pick<
  GanttProjectRow,
  | 'external_code'
  | 'type'
  | 'leader_name'
  | 'leader_engineer_id'
  | 'design_weeks'
  | 'lab_weeks'
  | 'total_weeks'
  | 'pin_lapsed'
  | 'manual_overlap'
  | 'status'
  | 'priority_applicable'
> = {
  // P57 (ADR 0067): served on every Gantt row.
  status: 'In Development',
  priority_applicable: true,
  external_code: null,
  type: null,
  leader_name: null,
  leader_engineer_id: null,
  design_weeks: null,
  lab_weeks: null,
  total_weeks: null,
  // P40 (API_CONTRACT_P40 §2): run outcome pin flags.
  pin_lapsed: false,
  manual_overlap: false,
};

/** P40 (API_CONTRACT_P40 §2) pin fields for test step builders: no pin, not
 *  editable (a reader without the Admin role). */
export const P40_GANTT_STEP_PIN_DEFAULTS: Pick<
  GanttStepRow,
  | 'manual_start_week'
  | 'manual_end_week'
  | 'pinned'
  | 'manual_overlap'
  | 'current_length_weeks'
  | 'pin_editable'
  | 'pin_block_reason'
  | 'pin_lapsed'
  | 'pin_clearable'
> = {
  manual_start_week: null,
  manual_end_week: null,
  pinned: false,
  manual_overlap: false,
  current_length_weeks: 0,
  pin_editable: false,
  pin_block_reason: 'NOT_ALLOWED',
  // P40-R02: served per-step lapse and Clear permission.
  pin_lapsed: false,
  pin_clearable: false,
};
