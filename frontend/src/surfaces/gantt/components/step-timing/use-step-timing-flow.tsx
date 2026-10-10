import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { fetchScheduleRunChanges } from '@/lib/api/priority-move';
import { queryKeys } from '@/lib/query-keys';
import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';

import { setStepTiming } from '../../api/gantt-api';
import type { StepTimingResponse } from '../../api/types';
import type { PendingGhost, StepTimingApi, StepTimingTarget } from './step-timing-context';
import type { StepTimingFlowState, TimingChange } from './step-timing-state';
import { TIMING_COPY, timingErrorCopy } from './timing-copy';
import { StepTimingDialog } from './step-timing-dialog';
import { StepTimingPanel } from './step-timing-panel';

/**
 * The Gantt step-timing flow (ADR 0019, P12 contract §3). Same lifecycle as
 * the P11 priority move (ADR 0015), sharing its pieces:
 *
 *   drop / dialog → PATCH …/steps/{step}/timing → recalc_status
 *     queued     → follow the run's SSE (`useScheduleRunFollow`) → GET …/changes
 *                  → "Timeline updated" (`TimelineUpdatedPanel`)
 *     deferred   → "updates automatically" + watch for the follow-up run (ADR 0023)
 *     not_needed → honest "skipped lab step" copy
 *     unchanged  → honest "nothing changed" copy
 *     409 PROJECT_FROZEN / NOT_SCHEDULABLE / STEP_DONE / STEP_STARTED / STEP_SKIPPED
 *                → the coded copy, ghost rolled back, nothing saved
 *
 * The state lives with the page, not the (virtualized) row, so scrolling a row
 * away never cancels a run being followed.
 */

/** The step's fields and stale flag changed: every view showing them refetches. */
function invalidateTimingWrite(queryClient: QueryClient): void {
  for (const key of [['gantt'], ['projects'], ['dashboard']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function useStepTimingFlow(): { api: StepTimingApi; element: React.JSX.Element } {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const followUp = useFollowUpRunWatcher();
  const [flow, setFlow] = React.useState<StepTimingFlowState>({ kind: 'idle' });
  const [dialogTarget, setDialogTarget] = React.useState<StepTimingTarget | null>(null);
  const busyRef = React.useRef(false);
  React.useEffect(() => {
    busyRef.current = flow.kind === 'submitting' || flow.kind === 'running';
  }, [flow.kind]);

  const handleResponse = React.useCallback(
    async (target: StepTimingTarget, res: StepTimingResponse): Promise<void> => {
      const change: TimingChange = {
        stepName: target.stepName,
        effectiveDurationWeeks: res.effective_duration_weeks,
        durationOverrideWeeks: res.duration_override_weeks,
        startNotBeforeWeek: res.start_not_before_week,
      };
      if (res.recalc_status === 'unchanged') {
        setFlow({ kind: 'notice', target, tone: 'success', title: TIMING_COPY.notChangedTitle, body: TIMING_COPY.unchanged });
        return;
      }
      invalidateTimingWrite(queryClient);
      if (res.recalc_status === 'deferred') {
        setFlow({ kind: 'notice', target, tone: 'success', title: TIMING_COPY.savedTitle, body: TIMING_COPY.deferred });
        followUp.start();
        return;
      }
      if (res.recalc_status === 'not_needed') {
        setFlow({ kind: 'notice', target, tone: 'success', title: TIMING_COPY.savedTitle, body: TIMING_COPY.notNeeded });
        return;
      }
      const runId = res.schedule_run_id;
      if (!runId) {
        setFlow({ kind: 'notice', target, tone: 'warning', title: TIMING_COPY.savedTitle, body: TIMING_COPY.queuedWithoutRun });
        return;
      }
      const baselineRunId = res.baseline_run_id;
      setFlow({ kind: 'running', target, change, runId, baselineRunId });
      const abort = begin('Queuing the solver…');
      const result = await follow(runId, abort, { completedMessage: 'Timeline recalculated.' });
      if (result.outcome === 'aborted') return;
      if (result.outcome === 'completed') {
        invalidateRunDerivedQueries(queryClient);
        setFlow({ kind: 'updated', target, change, runId, baselineRunId });
        return;
      }
      setFlow({
        kind: 'notice',
        target,
        tone: 'danger',
        title: TIMING_COPY.failedTitle,
        body: `${result.message ?? 'The recalculation did not complete.'} ${TIMING_COPY.staleAfterFailure}`,
      });
    },
    [begin, follow, followUp, queryClient],
  );

  const submit = React.useCallback<StepTimingApi['submit']>(
    (target, body, ghost) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const pending: PendingGhost | null = ghost
        ? { projectId: target.projectId, stepId: target.stepId, startWeek: ghost.startWeek, endWeek: ghost.endWeek }
        : null;
      setFlow({ kind: 'submitting', target, ghost: pending });
      void (async () => {
        let res: StepTimingResponse;
        try {
          res = await setStepTiming(target.projectId, target.stepId, body);
        } catch (err) {
          // Roll back: the ghost goes, the served bar stays, nothing was saved.
          setFlow({ kind: 'notice', target, tone: 'danger', title: TIMING_COPY.notChangedTitle, body: timingErrorCopy(err) });
          return;
        }
        await handleResponse(target, res);
      })();
    },
    [handleResponse],
  );

  const openDialog = React.useCallback((target: StepTimingTarget) => setDialogTarget(target), []);

  const close = React.useCallback(() => {
    reset();
    setFlow({ kind: 'idle' });
  }, [reset]);

  const changesRunId = flow.kind === 'updated' ? flow.runId : null;
  const changesAgainst = flow.kind === 'updated' ? flow.baselineRunId : null;
  const changes = useQuery({
    queryKey: queryKeys.scheduleRunChanges(changesRunId ?? '', changesAgainst ?? ''),
    queryFn: ({ signal }) => fetchScheduleRunChanges(changesRunId ?? '', changesAgainst ?? '', { signal }),
    enabled: changesRunId !== null && changesAgainst !== null,
    // Both runs are immutable (I14): the list never changes once fetched.
    staleTime: Infinity,
    retry: 1,
  });

  const busy = flow.kind === 'submitting' || flow.kind === 'running';
  const pending = flow.kind === 'submitting' ? flow.ghost : null;
  const api = React.useMemo<StepTimingApi>(() => ({ submit, openDialog, pending, busy }), [submit, openDialog, pending, busy]);

  const element = (
    <>
      <StepTimingDialog
        target={dialogTarget}
        busy={busy}
        onOpenChange={(open) => {
          if (!open) setDialogTarget(null);
        }}
        onSubmit={(target, body) => {
          setDialogTarget(null);
          submit(target, body);
        }}
      />
      <StepTimingPanel flow={flow} runState={run.state} changes={changes} onClose={close} followUpWatching={followUp.watching} />
    </>
  );

  return { api, element };
}
