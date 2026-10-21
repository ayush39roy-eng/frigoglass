import type { PriorityMatrixRow } from './api/types';

/** P13-T14 (API_CONTRACT_P13 §7) fields for test row builders. */
export const P13_MATRIX_ROW_DEFAULTS: Pick<
  PriorityMatrixRow,
  'status' | 'leader_name' | 'leader_engineer_id' | 'rank' | 'dimension_scores' | 'score_band' | 'capacity_fill' | 'capacity_fill_reason'
> = {
  status: 'In Development',
  leader_name: null,
  leader_engineer_id: null,
  rank: null,
  // P21 §3: required on the wire; the grid falls back to the flat scores when empty.
  dimension_scores: [],
  // P25 (ADR 0036): no capacity fill unless a test says so.
  score_band: null,
  capacity_fill: false,
  capacity_fill_reason: null,
};

/** P25 fields of a compare item, for test builders. */
export const P25_FILL_DEFAULTS = { score_band: null, capacity_fill: false, capacity_fill_reason: null } as const;
