import type { PriorityMatrixRow } from './api/types';

/** P13-T14 (API_CONTRACT_P13 §7) fields for test row builders. */
export const P13_MATRIX_ROW_DEFAULTS: Pick<
  PriorityMatrixRow,
  'status' | 'leader_name' | 'leader_engineer_id' | 'rank' | 'dimension_scores'
> = {
  status: 'In Development',
  leader_name: null,
  leader_engineer_id: null,
  rank: null,
  // P21 §3: required on the wire; the grid falls back to the flat scores when empty.
  dimension_scores: [],
};
