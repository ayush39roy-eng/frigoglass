import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';

import type { DeactivateResponse } from '../api/types';
import { DEACTIVATION_COPY } from '../lib/deactivation';

/**
 * P38-T06: what happens after a deactivation, reported from the served
 * `run.status` (ADR 0023 lifecycle, contract §2) with the shared recalculation
 * status (the same follow / follow-up machinery as the check-in and the
 * register Save):
 *
 *   queued     → follow the run's progress (`RunProgressStatus`), then refresh
 *                every run-derived view
 *   deferred   → the coalesced follow-up run is watched
 *   not_needed → nothing runs
 *
 * The server decides every branch; the browser only reports it.
 */
export type DeactivationRunPhase = 'following' | 'completed' | 'failed' | 'deferred' | 'not_needed' | 'no_run';

export interface DeactivationResultState {
  engineerName: string;
  result: DeactivateResponse;
  phase: DeactivationRunPhase;
  /** The status line under the counts. */
  runMessage: string | null;
}

export function useDeactivationResult() {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const watcher = useFollowUpRunWatcher();
  const { start: startWatcher } = watcher;
  const [state, setState] = React.useState<DeactivationResultState | null>(null);

  const show = React.useCallback(
    (result: DeactivateResponse, engineerName: string) => {
      const base = { engineerName, result };
      const status = result.run.status;
      if (status === 'not_needed') {
        setState({ ...base, phase: 'not_needed', runMessage: DEACTIVATION_COPY.notNeeded });
        return;
      }
      if (status === 'deferred') {
        startWatcher();
        setState({ ...base, phase: 'deferred', runMessage: DEACTIVATION_COPY.deferred });
        return;
      }
      const runId = result.run.run_id;
      if (!runId) {
        setState({ ...base, phase: 'no_run', runMessage: DEACTIVATION_COPY.queuedWithoutRun });
        return;
      }
      setState({ ...base, phase: 'following', runMessage: null });
      const abort = begin('Queuing the recalculation…');
      void follow(runId, abort, { completedMessage: 'Timeline recalculated.' }).then((outcome) => {
        if (outcome.outcome === 'aborted') return;
        if (outcome.outcome === 'completed') {
          invalidateRunDerivedQueries(queryClient);
          setState((prev) => (prev ? { ...prev, phase: 'completed', runMessage: null } : prev));
          return;
        }
        // The failure reason itself is in the shared run status line.
        setState((prev) => (prev ? { ...prev, phase: 'failed', runMessage: DEACTIVATION_COPY.failedRun } : prev));
      });
    },
    [begin, follow, queryClient, startWatcher],
  );

  const close = React.useCallback(() => {
    reset();
    setState(null);
  }, [reset]);

  return { state, runState: run.state, watchingFollowUp: watcher.watching, show, close };
}
