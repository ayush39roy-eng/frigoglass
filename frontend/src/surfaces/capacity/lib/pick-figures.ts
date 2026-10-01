import type { HubCapacityRow } from '../api/types';

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
        }
      : {
          load: row.design_load_weeks,
          loadEstimated: row.design_load_estimated_weeks,
          capacity: row.design_capacity_remaining,
          gap: row.design_gap_remaining,
          completionPct: row.design_completion_pct_remaining,
        };
  }
  return horizon === 'year'
    ? {
        load: row.lab_load_weeks,
        loadEstimated: row.lab_load_estimated_weeks,
        capacity: row.lab_capacity_year,
        gap: row.lab_gap_year,
        completionPct: row.lab_completion_pct_year,
      }
    : {
        load: row.lab_load_weeks,
        loadEstimated: row.lab_load_estimated_weeks,
        capacity: row.lab_capacity_remaining,
        gap: row.lab_gap_remaining,
        completionPct: row.lab_completion_pct_remaining,
      };
}

