import type { GanttStepRow } from '../api/types';

/**
 * P30 (ADR 0041) / P33 (contract Part G): where a step's served effective
 * duration comes from, named from the served `own_effort` flag for labels
 * only. It never computes a duration.
 *
 * - `effort`: the step's kind follows the project's own client effort figure
 *   (`own_effort`), so the duration is its share (`effort_weeks`).
 * - `template`: the project's copy of the category template (`plan_weeks`).
 *
 * Per-project timing edits are retired (ADR 0048), so there is no third source.
 */
export type StepDurationSource = 'effort' | 'template';

type SourceFields = Pick<GanttStepRow, 'own_effort'>;

export function stepDurationSource(step: SourceFields): StepDurationSource {
  return step.own_effort ? 'effort' : 'template';
}

/** True when the effort split gave this own-effort step 0 weeks (so it is skipped by the split). */
export function isEffortZeroed(step: SourceFields & Pick<GanttStepRow, 'effort_weeks' | 'plan_weeks'>): boolean {
  return step.own_effort && step.effort_weeks === 0 && step.plan_weeks > 0;
}

/** Short suffix for the bar's hover text: " (client effort)" / "". */
export function durationSourceSuffix(step: SourceFields): string {
  return stepDurationSource(step) === 'effort' ? ' (client effort)' : '';
}
