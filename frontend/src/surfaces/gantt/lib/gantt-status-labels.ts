import { SCHEDULE_OUTCOME_META } from '@/components/shared/schedule-outcome-meta';

import type { GanttProjectRow, GanttStepRow } from '../api/types';

/**
 * P19-R02: the same served flags as words, for the narrow (phone) layout where
 * the status column is folded into a compact row icon and the details dialog.
 * Order matches the chips above. Empty = nothing to flag.
 */
export function projectStatusLabels(project: GanttProjectRow): string[] {
  const out: string[] = [];
  if (project.frozen) out.push('Frozen');
  if (project.delay_weeks > 0) out.push(`Delay +${String(project.delay_weeks)}w`);
  if (project.left_out) out.push(SCHEDULE_OUTCOME_META.LEFT_OUT.label);
  if (project.spillover) out.push(SCHEDULE_OUTCOME_META.SPILLOVER.label);
  if (project.cat_not_allowed) out.push(SCHEDULE_OUTCOME_META.CAT_NOT_ALLOWED.label);
  if (project.blocked) out.push('On Hold');
  if (project.schedule_stale) out.push('Stale');
  return out;
}

export function stepStatusLabels(step: GanttStepRow): string[] {
  if (step.skipped) return ['Skipped (n/a)'];
  const out: string[] = [];
  if (step.status === 'Blocked') out.push('On Hold');
  if (step.eng_conflict) out.push(SCHEDULE_OUTCOME_META.ENG_CONFLICT.label);
  if (step.chamber_overlap) out.push(SCHEDULE_OUTCOME_META.OVERLAP.label);
  return out;
}
