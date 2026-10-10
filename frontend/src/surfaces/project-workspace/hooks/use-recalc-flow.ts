import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { useScheduleRunFollow, type RunFollowPhase, type RunFollowState } from '@/lib/use-schedule-run-follow';

import { invalidateAfterRecalc, useRecalculate } from './use-workspace';

export type RecalcPhase = RunFollowPhase;
export type RecalcState = RunFollowState;

/**
 * "Recalculate schedule": POST /projects/{id}/recalculate (202; dispatches the
 * fast greedy scheduler — OQ #10; 409 RUN_IN_PROGRESS if a run is already
 * queued or running), then follow the solver over the P3-T05 progress stream
 * through the shared `useScheduleRunFollow` (P11 generalised it so the
 * priority move reuses the same watcher). Writes a new immutable ScheduleRun
 * (I14); on completion every run-derived cache is invalidated. One flow per
 * page — the header button and the stale banner share it.
 */
export function useRecalcFlow(projectId: string) {
  const queryClient = useQueryClient();
  const dispatch = useRecalculate(projectId);
  const run = useScheduleRunFollow();
  const { begin, follow, fail } = run;

  const start = React.useCallback(async () => {
    const signal = begin('Queuing the solver…');
    try {
      const { schedule_run_id } = await dispatch.mutateAsync();
      const { outcome } = await follow(schedule_run_id, signal, {
        completedMessage: 'Schedule recalculated — a new schedule version is active.',
        streamErrorFallback: 'The recalculation could not be started.',
      });
      if (outcome === 'completed') invalidateAfterRecalc(queryClient, projectId);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // 409 RUN_IN_PROGRESS → "A recalculation is already running."
      const message =
        err instanceof ApiError && err.isForbidden && !err.code
          ? 'Your role cannot recalculate the schedule.'
          : apiErrorMessage(err, 'The recalculation could not be started.');
      fail(message);
    }
  }, [begin, dispatch, fail, follow, projectId, queryClient]);

  return { state: run.state, start, busy: run.busy };
}
