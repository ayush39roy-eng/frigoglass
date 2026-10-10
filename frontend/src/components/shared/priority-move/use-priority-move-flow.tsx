import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import {
  fetchScheduleRunChanges,
  HARD_GATE_FORCES_P1,
  moveProjectPriority,
  type RecalcStatus,
} from '@/lib/api/priority-move';
import { queryKeys } from '@/lib/query-keys';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';
import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import type { ProjectPriority } from '@/types/enums';

import { MOVE_COPY, notNeededCopy } from './move-copy';
import { MoveConfirmDialog, MoveFlowPanel } from './move-flow-panel';
import type {
  PriorityMoveApi,
  PriorityMoveOutcome,
  PriorityMoveRequestOptions,
  PriorityMoveTarget,
} from './priority-move-context';

/**
 * The priority-move flow (ADR 0015, P11-T02), shared by the Gantt, the Project
 * Workspace header and the Registration / Workspace edit form.
 *
 *   confirm → POST /projects/{id}/priority → recalc_status
 *     queued     → follow the run's SSE progress → GET …/changes → "Timeline updated"
 *     deferred   → "updates automatically" copy + watch for the follow-up run (ADR 0023)
 *     not_needed → honest "not in the plan" copy
 *     unchanged  → nothing
 *     409 HARD_GATE_FORCES_P1 → the hard-gate copy
 *
 * The server decides every branch. The browser only shows what it was told.
 * The state lives with the page, not with the control, so a virtualized Gantt
 * row scrolling out of view never cancels a run being followed.
 */

interface RunMoveFields {
  target: PriorityMoveTarget;
  before: ProjectPriority | null;
  after: ProjectPriority | null;
  runId: string;
  baselineRunId: string | null;
}

export type MoveFlowState =
  | { kind: 'idle' }
  | { kind: 'confirm'; target: PriorityMoveTarget; next: ProjectPriority }
  | { kind: 'submitting'; target: PriorityMoveTarget; next: ProjectPriority }
  | ({ kind: 'running' } & RunMoveFields)
  | ({ kind: 'updated' } & RunMoveFields)
  | { kind: 'notice'; target: PriorityMoveTarget; tone: 'success' | 'warning' | 'danger'; title: string; body: string };

interface RecalcSignal {
  recalc_status: RecalcStatus;
  schedule_run_id: string | null;
  baseline_run_id: string | null;
}

/** The priority itself changed and the project is now `schedule_stale`, so
 *  every view showing priority or the stale flag refetches. */
function invalidatePriorityWrite(queryClient: QueryClient): void {
  for (const key of [['projects'], ['gantt'], ['dashboard'], ['priority-matrix'], ['priority-board'], ['vip-projects']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function usePriorityMoveFlow(): { api: PriorityMoveApi; element: React.JSX.Element } {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const [flow, setFlow] = React.useState<MoveFlowState>({ kind: 'idle' });
  const followUp = useFollowUpRunWatcher();

  const handleSignal = React.useCallback(
    async (
      target: PriorityMoveTarget,
      signal: RecalcSignal,
      before: ProjectPriority | null,
      after: ProjectPriority | null,
    ): Promise<void> => {
      if (signal.recalc_status === 'unchanged') {
        setFlow({ kind: 'idle' });
        return;
      }
      if (signal.recalc_status === 'deferred') {
        invalidatePriorityWrite(queryClient);
        setFlow({ kind: 'notice', target, tone: 'success', title: 'Priority saved', body: MOVE_COPY.deferred });
        // ADR 0023: the server runs one follow-up after the current run; refresh when it lands.
        followUp.start();
        return;
      }
      if (signal.recalc_status === 'not_needed') {
        invalidatePriorityWrite(queryClient);
        setFlow({ kind: 'notice', target, tone: 'success', title: 'Priority saved', body: notNeededCopy(target.status) });
        return;
      }
      const runId = signal.schedule_run_id;
      if (!runId) {
        invalidatePriorityWrite(queryClient);
        setFlow({ kind: 'notice', target, tone: 'warning', title: 'Priority saved', body: MOVE_COPY.queuedWithoutRun });
        return;
      }
      const baselineRunId = signal.baseline_run_id;
      setFlow({ kind: 'running', target, before, after, runId, baselineRunId });
      const abort = begin('Queuing the solver…');
      const result = await follow(runId, abort, { completedMessage: 'Timeline recalculated.' });
      if (result.outcome === 'aborted') return;
      if (result.outcome === 'completed') {
        invalidateRunDerivedQueries(queryClient);
        setFlow({ kind: 'updated', target, before, after, runId, baselineRunId });
        return;
      }
      // SSE or run failure: say so. The project stays schedule_stale, so the
      // stale banner/chip stays on screen after this refetch.
      invalidatePriorityWrite(queryClient);
      setFlow({
        kind: 'notice',
        target,
        tone: 'danger',
        title: 'Priority saved — timeline not recalculated',
        body: `${result.message ?? 'The recalculation did not complete.'} ${MOVE_COPY.staleAfterFailure}`,
      });
    },
    [begin, follow, followUp, queryClient],
  );

  // P12 (ADR 0018): the Priority board shows a drop optimistically and needs to
  // know how the move ended so it can roll back. One pending callback at most:
  // only one move is ever being confirmed or submitted.
  const settleRef = React.useRef<((outcome: PriorityMoveOutcome) => void) | null>(null);
  const settle = React.useCallback((outcome: PriorityMoveOutcome) => {
    const cb = settleRef.current;
    settleRef.current = null;
    cb?.(outcome);
  }, []);
  const busyRef = React.useRef(false);
  React.useEffect(() => {
    busyRef.current = flow.kind === 'submitting' || flow.kind === 'running';
  }, [flow.kind]);

  const requestMove = React.useCallback(
    (target: PriorityMoveTarget, next: ProjectPriority, options?: PriorityMoveRequestOptions) => {
      if (next === target.priority || busyRef.current) {
        options?.onSettled?.('cancelled');
        return;
      }
      settle('cancelled'); // an earlier, unconfirmed request is superseded
      settleRef.current = options?.onSettled ?? null;
      setFlow((cur) => (cur.kind === 'submitting' || cur.kind === 'running' ? cur : { kind: 'confirm', target, next }));
    },
    [settle],
  );

  const confirm = React.useCallback(async () => {
    if (flow.kind !== 'confirm') return;
    const { target, next } = flow;
    setFlow({ kind: 'submitting', target, next });
    try {
      const res = await moveProjectPriority(target.projectId, next);
      settle('accepted');
      await handleSignal(target, res, res.priority_before, res.priority_after);
    } catch (err) {
      settle('rejected');
      const body =
        err instanceof ApiError && err.code === HARD_GATE_FORCES_P1
          ? MOVE_COPY.hardGate
          : apiErrorMessage(err, 'The priority could not be changed.');
      setFlow({ kind: 'notice', target, tone: 'danger', title: 'Priority not changed', body });
    }
  }, [flow, handleSignal, settle]);

  const followPatch = React.useCallback<PriorityMoveApi['followPatch']>(
    (target, signal, before, after) => {
      void handleSignal(target, signal, before, after);
    },
    [handleSignal],
  );

  const close = React.useCallback(() => {
    settle('cancelled'); // no-op unless a request was never confirmed
    reset();
    setFlow({ kind: 'idle' });
  }, [reset, settle]);

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
  const api = React.useMemo<PriorityMoveApi>(() => ({ requestMove, followPatch, busy }), [requestMove, followPatch, busy]);

  const element = (
    <>
      <MoveConfirmDialog flow={flow} onConfirm={() => void confirm()} onCancel={close} />
      <MoveFlowPanel flow={flow} runState={run.state} changes={changes} onClose={close} followUpWatching={followUp.watching} />
    </>
  );

  return { api, element };
}
