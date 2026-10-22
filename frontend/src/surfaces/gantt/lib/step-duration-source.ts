import type { GanttStepRow } from '../api/types';

/**
 * P30 (ADR 0041 R4, API_CONTRACT_P30 §3): where a step's served effective
 * duration comes from. The server resolves `user ?? effort ?? lead` and serves
 * the result as `duration_weeks`; this only NAMES the source from the served
 * fields, for labels. It never computes a duration.
 *
 * - `user`: the planner's own timing edit (`duration_override_weeks`), the only
 *   thing "Reset timing" clears and the only duration that counts as a
 *   "timing edit" (`hasTimingEdit`).
 * - `effort`: the step's share of the project's client effort figure
 *   (`effort_weeks`, server-derived, never a timing edit).
 * - `table`: the lead-time table (`lead_time_weeks`).
 */
export type StepDurationSource = 'user' | 'effort' | 'table';

type SourceFields = Pick<GanttStepRow, 'duration_override_weeks' | 'effort_weeks'>;

export function stepDurationSource(step: SourceFields): StepDurationSource {
  if (step.duration_override_weeks !== null) return 'user';
  // An older API (before P30) omits `effort_weeks`: read it as "no effort".
  return (step.effort_weeks ?? null) !== null ? 'effort' : 'table';
}

/**
 * What a user's edit replaced, for the "edited" hint: "client effort 4, table
 * 10" when the project carries an effort figure for the step, else "table 10".
 * Served values only.
 */
export function editBaselineText(step: SourceFields & Pick<GanttStepRow, 'lead_time_weeks'>): string {
  const effort = step.effort_weeks ?? null;
  const table = `table ${String(step.lead_time_weeks)}`;
  return effort !== null ? `client effort ${String(effort)}, ${table}` : table;
}

/** True when the effort split gave this step 0 weeks (so it is skipped by the split). */
export function isEffortZeroed(step: SourceFields & Pick<GanttStepRow, 'lead_time_weeks'>): boolean {
  return step.duration_override_weeks === null && step.effort_weeks === 0 && step.lead_time_weeks > 0;
}

/** Short suffix for the bar's hover text: " (client effort)" / " (timing edit)" / "". */
export function durationSourceSuffix(step: SourceFields): string {
  const source = stepDurationSource(step);
  return source === 'effort' ? ' (client effort)' : source === 'user' ? ' (timing edit)' : '';
}
