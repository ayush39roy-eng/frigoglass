import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { streamSolverProgress, type SolverProgressEvent } from '@/lib/api/sse';

import { invalidateAfterRecalc, useRecalculate } from './use-workspace';

export type RecalcPhase = 'idle' | 'dispatching' | 'running' | 'completed' | 'failed';

export interface RecalcState {
  phase: RecalcPhase;
  percent: number | null;
  message: string | null;
}

/**
 * "Recalculate schedule": POST /projects/{id}/recalculate (202; dispatches the
 * fast greedy scheduler — OQ #10; 409 RUN_IN_PROGRESS if a run is already
 * queued or running), then follow the
 * solver over the P3-T05 progress stream (`fetch()`-streamed, never
 * EventSource). Writes a new immutable ScheduleRun (I14); on completion every
 * run-derived cache is invalidated. One flow per page — the header button and
 * the stale banner share it.
 */
export function useRecalcFlow(projectId: string) {
  const queryClient = useQueryClient();
  const dispatch = useRecalculate(projectId);
  const [state, setState] = React.useState<RecalcState>({ phase: 'idle', percent: null, message: null });
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const start = React.useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: 'dispatching', percent: null, message: 'Queuing the solver…' });
    try {
      const { schedule_run_id } = await dispatch.mutateAsync();
      setState({ phase: 'running', percent: null, message: 'Solver queued.' });
      const terminal = await streamSolverProgress(
        schedule_run_id,
        (e: SolverProgressEvent) => {
          if (e.status === 'queued' || e.status === 'running') {
            setState({ phase: 'running', percent: e.percent ?? null, message: e.message ?? (e.status === 'queued' ? 'Solver queued.' : 'Solver running…') });
          }
        },
        controller.signal,
      );
      if (terminal?.status === 'completed') {
        setState({ phase: 'completed', percent: 100, message: 'Schedule recalculated — a new schedule version is active.' });
        invalidateAfterRecalc(queryClient, projectId);
      } else {
        setState({ phase: 'failed', percent: null, message: terminal?.error ?? terminal?.message ?? 'The recalculation did not complete.' });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // 409 RUN_IN_PROGRESS → "A recalculation is already running."
      const message =
        err instanceof ApiError && err.isForbidden && !err.code
          ? 'Your role cannot recalculate the schedule.'
          : apiErrorMessage(err, 'The recalculation could not be started.');
      setState({ phase: 'failed', percent: null, message });
    }
  }, [dispatch, projectId, queryClient]);

  const busy = state.phase === 'dispatching' || state.phase === 'running';
  return { state, start, busy };
}
