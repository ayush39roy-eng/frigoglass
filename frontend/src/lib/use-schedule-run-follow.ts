import * as React from 'react';
import type { QueryClient } from '@tanstack/react-query';

import { apiErrorMessage } from '@/lib/api/error-messages';
import { streamSolverProgress, type SolverProgressEvent } from '@/lib/api/sse';

/**
 * Follow one schedule run over the P3-T05 progress stream
 * (`GET /schedule-runs/{id}/progress`, `fetch()`-streamed, never EventSource).
 *
 * Generalised from the Project Workspace's `use-recalc-flow.ts` (P9-T04b) so
 * the Workspace "Recalculate schedule" button and the P11 priority move
 * (ADR 0015) share one progress state machine instead of two copies. The
 * caller dispatches the run; this hook only watches it.
 */

export type RunFollowPhase = 'idle' | 'dispatching' | 'running' | 'completed' | 'failed';

export interface RunFollowState {
  phase: RunFollowPhase;
  percent: number | null;
  message: string | null;
}

export type RunFollowOutcome = 'completed' | 'failed' | 'aborted';

export interface RunFollowResult {
  outcome: RunFollowOutcome;
  /** The status text shown for the terminal state (the failure reason on `failed`). */
  message: string | null;
}

export interface RunFollowOptions {
  /** Status text once the run completes. */
  completedMessage?: string;
  /** Fallback text when the stream itself fails (network / non-2xx). */
  streamErrorFallback?: string;
}

export const IDLE_RUN_FOLLOW: RunFollowState = { phase: 'idle', percent: null, message: null };

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Invalidate everything a newly active run changes: Gantt, Dashboard,
 * Capacity, run lists, notifications, the projects list and every Project
 * Workspace (`['projects', 'workspace', id]` sits under `['projects']`), and
 * the Matrix's committed-priority column.
 */
export function invalidateRunDerivedQueries(queryClient: QueryClient): void {
  for (const key of [
    ['gantt'],
    ['dashboard'],
    ['capacity'],
    ['schedule-runs'],
    ['notifications'],
    ['projects'],
    ['priority-matrix'],
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function useScheduleRunFollow() {
  const [state, setState] = React.useState<RunFollowState>(IDLE_RUN_FOLLOW);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  /** Abort any run being watched and enter `dispatching`. Returns the signal
   *  the caller passes to its dispatch request and to `follow`. */
  const begin = React.useCallback((message: string): AbortSignal => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: 'dispatching', percent: null, message });
    return controller.signal;
  }, []);

  /** Watch `runId` until it reaches a terminal status. Never throws. */
  const follow = React.useCallback(
    async (runId: string, signal: AbortSignal, options: RunFollowOptions = {}): Promise<RunFollowResult> => {
      setState({ phase: 'running', percent: null, message: 'Solver queued.' });
      try {
        const terminal = await streamSolverProgress(
          runId,
          (e: SolverProgressEvent) => {
            if (e.status === 'queued' || e.status === 'running') {
              setState({
                phase: 'running',
                percent: e.percent ?? null,
                message: e.message ?? (e.status === 'queued' ? 'Solver queued.' : 'Solver running…'),
              });
            }
          },
          signal,
        );
        if (terminal?.status === 'completed') {
          const message = options.completedMessage ?? 'Schedule recalculated — a new schedule version is active.';
          setState({ phase: 'completed', percent: 100, message });
          return { outcome: 'completed', message };
        }
        const message = terminal?.error ?? terminal?.message ?? 'The recalculation did not complete.';
        setState({ phase: 'failed', percent: null, message });
        return { outcome: 'failed', message };
      } catch (err) {
        if (isAbort(err)) return { outcome: 'aborted', message: null };
        const message = apiErrorMessage(err, options.streamErrorFallback ?? 'Lost contact with the solver progress stream.');
        setState({ phase: 'failed', percent: null, message });
        return { outcome: 'failed', message };
      }
    },
    [],
  );

  const fail = React.useCallback((message: string) => {
    setState({ phase: 'failed', percent: null, message });
  }, []);

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE_RUN_FOLLOW);
  }, []);

  const busy = state.phase === 'dispatching' || state.phase === 'running';
  return { state, begin, follow, fail, reset, busy };
}
