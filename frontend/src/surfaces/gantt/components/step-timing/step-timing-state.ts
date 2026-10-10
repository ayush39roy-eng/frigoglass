import { formatWeek } from '@/lib/format';

import type { PendingGhost, StepTimingTarget } from './step-timing-context';

/** The step-timing flow's states (see `use-step-timing-flow.tsx`). */
export interface TimingChange {
  stepName: string;
  /** Served after-values, for the summary line. */
  effectiveDurationWeeks: number;
  durationOverrideWeeks: number | null;
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

/** "6 wks (lead-time table) · earliest start W40" — served values only. */
export function timingChangeSummary(change: TimingChange): string {
  const duration = `${String(change.effectiveDurationWeeks)} wks${change.durationOverrideWeeks === null ? ' (lead-time table)' : ''}`;
  const floor = change.startNotBeforeWeek === null ? 'no start floor' : `earliest start ${formatWeek(change.startNotBeforeWeek)}`;
  return `${change.stepName}: ${duration} · ${floor}`;
}

