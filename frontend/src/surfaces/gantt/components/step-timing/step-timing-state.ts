import { formatPlanWeek } from '@/lib/format';

import type { PendingGhost, StepTimingTarget } from './step-timing-context';

/** The step-timing flow's states (see `use-step-timing-flow.tsx`). */
export interface TimingChange {
  stepName: string;
  /** Served after-values, for the summary line. */
  effectiveDurationWeeks: number;
  durationOverrideWeeks: number | null;
  /** P30: served `effort_weeks` (what a cleared user value falls back to). */
  effortWeeks: number | null;
  startNotBeforeWeek: number | null;
}

interface RunFields {
  target: StepTimingTarget;
  change: TimingChange;
  runId: string;
  baselineRunId: string | null;
}

export type StepTimingFlowState =
  | { kind: 'idle' }
  | { kind: 'submitting'; target: StepTimingTarget; ghost: PendingGhost | null }
  | ({ kind: 'running' } & RunFields)
  | ({ kind: 'updated' } & RunFields)
  | { kind: 'notice'; target: StepTimingTarget; tone: 'success' | 'warning' | 'danger'; title: string; body: string };

/** "6 wks (lead-time table) · earliest start W40" — served values only.
 *  P30 (ADR 0041 R4): with no user value the duration is the client effort
 *  figure when the step has one, else the table. */
export function timingChangeSummary(change: TimingChange): string {
  const source =
    change.durationOverrideWeeks !== null ? '' : change.effortWeeks !== null ? ' (client effort)' : ' (lead-time table)';
  const duration = `${String(change.effectiveDurationWeeks)} wks${source}`;
  const floor = change.startNotBeforeWeek === null ? 'no start floor' : `earliest start ${formatPlanWeek(change.startNotBeforeWeek)}`;
  return `${change.stepName}: ${duration} · ${floor}`;
}

