import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { apiErrorMessage, checkInRateLimitedMessage } from '@/lib/api/error-messages';
import { checkInEntryErrors, submitCheckIns, type CheckInEntry, type CheckInEntryError } from '@/lib/api/check-ins';
import { fetchScheduleRunChanges } from '@/lib/api/priority-move';
import { queryKeys } from '@/lib/query-keys';
import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';

/**
 * Submit one week's check-in batch (`POST /check-ins`) and follow what the
 * server did with it (ADR 0023):
 *
 *   queued     → follow the run's SSE progress → GET …/changes → "Timeline updated"
 *   deferred   → "Saved — the timeline updates automatically after the current
 *                 recalculation" + the shared follow-up run watcher
 *   not_needed → a plain success message
 *   422 CHECKIN_INVALID → per-entry errors (nothing was saved: the batch is atomic)
 *
 * The server decides every branch; the browser only reports it.
 */

export const CHECK_IN_COPY = {
  deferred: 'Saved — the timeline updates automatically after the current recalculation',
  notNeeded: 'Saved. No schedulable progress changed, so the timeline did not need recalculating.',
  noBaseline: 'There was no earlier schedule to compare against, so no list of moves is available.',
  dispatchFailed: 'The recalculation could not be started, so the projects are marked stale. Press Recalculate on a project.',
  failedRun: 'Your check-in is saved and the projects are marked stale. Press Recalculate on a project to try again.',
  invalid: 'Nothing was saved. Fix the highlighted stages and submit again.',
} as const;

export type CheckInFlow =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'running'; accepted: number; runId: string; baselineRunId: string | null }
  | { kind: 'updated'; accepted: number; runId: string; baselineRunId: string | null }
  | { kind: 'notice'; tone: 'success' | 'warning' | 'danger'; title: string; body: string; followUp: boolean };

export interface SubmitResult {
  ok: boolean;
  /** Per-entry server errors, by index into the submitted entries. */
  entryErrors: CheckInEntryError[];
  /** A non-entry error message (403, 429, network…). */
  message: string | null;
}

/** A check-in changes progress, tracking status and (after a run) every run-derived view. */
function invalidateCheckInWrite(queryClient: QueryClient): void {
  for (const key of [['check-ins'], ['gantt'], ['dashboard'], ['projects'], ['priority-board'], ['vip-board']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function useCheckInSubmit() {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const watcher = useFollowUpRunWatcher();
  const { start: startWatcher } = watcher;
  const [flow, setFlow] = React.useState<CheckInFlow>({ kind: 'idle' });

  const submit = React.useCallback(
    async (entries: CheckInEntry[]): Promise<SubmitResult> => {
      setFlow({ kind: 'submitting' });
      let res;
      try {
        res = await submitCheckIns(entries);
      } catch (err) {
        const entryErrors = checkInEntryErrors(err);
        const message =
          entryErrors.length > 0
            ? null
            : err instanceof ApiError && err.status === 429
              ? checkInRateLimitedMessage(err.retryAfterSeconds)
              : apiErrorMessage(err, 'The check-in could not be saved.');
        setFlow({
          kind: 'notice',
          tone: 'danger',
          title: 'Check-in not saved',
          body: entryErrors.length > 0 ? CHECK_IN_COPY.invalid : (message ?? ''),
          followUp: false,
        });
        return { ok: false, entryErrors, message };
      }

      invalidateCheckInWrite(queryClient);
      const saved = `${plural(res.accepted, 'stage', 'stages')} checked in for week ${String(res.week)}.`;

      if (res.recalc_status === 'not_needed') {
        setFlow({ kind: 'notice', tone: 'success', title: 'Check-in saved', body: `${saved} ${CHECK_IN_COPY.notNeeded}`, followUp: false });
        return { ok: true, entryErrors: [], message: null };
      }
      if (res.recalc_status === 'dispatch_failed') {
        setFlow({ kind: 'notice', tone: 'danger', title: 'Check-in saved', body: `${saved} ${CHECK_IN_COPY.dispatchFailed}`, followUp: false });
        return { ok: true, entryErrors: [], message: null };
      }
      if (res.recalc_status === 'deferred') {
        startWatcher();
        setFlow({ kind: 'notice', tone: 'success', title: 'Check-in saved', body: `${saved} ${CHECK_IN_COPY.deferred}`, followUp: true });
        return { ok: true, entryErrors: [], message: null };
      }
      const runId = res.schedule_run_id;
      if (!runId) {
        setFlow({ kind: 'notice', tone: 'warning', title: 'Check-in saved', body: `${saved} ${CHECK_IN_COPY.failedRun}`, followUp: false });
        return { ok: true, entryErrors: [], message: null };
      }
      const baselineRunId = res.baseline_run_id;
      setFlow({ kind: 'running', accepted: res.accepted, runId, baselineRunId });
      const abort = begin('Queuing the solver…');
      // Not awaited: the form is free again while the run is followed.
      void follow(runId, abort, { completedMessage: 'Timeline recalculated.' }).then((result) => {
        if (result.outcome === 'aborted') return;
        if (result.outcome === 'completed') {
          invalidateRunDerivedQueries(queryClient);
          setFlow({ kind: 'updated', accepted: res.accepted, runId, baselineRunId });
          return;
        }
        setFlow({
          kind: 'notice',
          tone: 'danger',
          title: 'Check-in saved — timeline not recalculated',
          body: `${result.message ?? 'The recalculation did not complete.'} ${CHECK_IN_COPY.failedRun}`,
          followUp: false,
        });
      });
      return { ok: true, entryErrors: [], message: null };
    },
    [begin, follow, queryClient, startWatcher],
  );

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
    // Both runs are immutable (I14).
    staleTime: Infinity,
    retry: 1,
  });

  return {
    flow,
    runState: run.state,
    changes,
    watchingFollowUp: watcher.watching,
    submitting: flow.kind === 'submitting',
    submit,
    close,
  };
}
