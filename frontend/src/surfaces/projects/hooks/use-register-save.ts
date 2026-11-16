import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { fetchScheduleRunChanges } from '@/lib/api/priority-move';
import { queryKeys } from '@/lib/query-keys';
import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';

import { MOVE_COPY } from '@/components/shared/priority-move/move-copy';

import {
  REGISTER_EDITS_FORBIDDEN,
  REGISTER_EDITS_INVALID,
  registerEditErrors,
  saveRegisterEdits,
  type RegisterEditEffChange,
  type RegisterEditError,
  type RegisterEditsRequest,
} from '../api/register-edits';

/**
 * P35-T02: save the register's edit session (`POST /projects/register-edits`,
 * one batch, all-or-nothing) and follow what the server did with it — the
 * same `recalc_status` lifecycle as a priority move (ADR 0015 / 0023, D35-5),
 * through the same shared hooks (`useScheduleRunFollow`,
 * `useFollowUpRunWatcher`, `invalidateRunDerivedQueries`):
 *
 *   queued          → follow the run's SSE progress → GET …/changes → "Timeline updated"
 *   deferred        → "updates automatically" + the follow-up run watcher
 *   not_needed      → saved, no timeline change
 *   dispatch_failed → saved, marked stale, Recalculate by hand
 *   422 REGISTER_EDITS_INVALID / 403 REGISTER_EDITS_FORBIDDEN → per-row errors, nothing saved
 *   429             → wait and save again, nothing saved
 *
 * The server decides every branch; the browser only reports it.
 */

export const REGISTER_SAVE_COPY = {
  notNeeded: 'No schedulable project changed a scheduling input, so the timeline did not need recalculating.',
  deferred: MOVE_COPY.deferred,
  dispatchFailed:
    'The recalculation could not be started, so the projects are marked stale. Press Recalculate on a project to update the timeline.',
  failedRun: 'Your edits are saved and the projects are marked stale. Press Recalculate on a project to try again.',
  queuedWithoutRun: 'The recalculation was queued but no run was reported back — press Recalculate on a project.',
  invalid: 'Nothing was saved. Fix the highlighted rows and save again.',
  forbiddenRows: 'Nothing was saved. You cannot edit the highlighted rows; undo their changes and save again.',
  rateLimited: 'Too many saves in a row — wait a few seconds and save again. Nothing was saved.',
} as const;

export type RegisterSaveFlow =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'running'; saved: number; runId: string; baselineRunId: string | null }
  | { kind: 'updated'; saved: number; runId: string; baselineRunId: string | null }
  | { kind: 'notice'; tone: 'success' | 'warning' | 'danger'; title: string; body: string; followUp: boolean };

export interface RegisterSaveResult {
  ok: boolean;
  /** Per-row server errors (422 / 403 with `detail.errors`). */
  rowErrors: RegisterEditError[];
  /** A batch-level message (403 without rows, 429, network…). */
  message: string | null;
  /** A 403 that names no row: the caller's role cannot write here at all. */
  forbidden: boolean;
}

/** A register save changes the register, the Dashboard and (after a run)
 *  every run-derived view. */
function invalidateRegisterWrite(queryClient: QueryClient): void {
  for (const key of [['dashboard'], ['projects'], ['gantt'], ['priority-matrix'], ['priority-board'], ['vip-board']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

function savedText(n: number): string {
  return `Saved ${String(n)} ${n === 1 ? 'project' : 'projects'}.`;
}

export function useRegisterSave() {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const watcher = useFollowUpRunWatcher();
  const { start: startWatcher } = watcher;
  const [flow, setFlow] = React.useState<RegisterSaveFlow>({ kind: 'idle' });
  /** Register popup contract §2.5: the served per-step duration changes of
   *  the last successful Save (shown by the panel, never recomputed). */
  const [effChanges, setEffChanges] = React.useState<readonly RegisterEditEffChange[]>([]);

  const save = React.useCallback(
    async (body: RegisterEditsRequest): Promise<RegisterSaveResult> => {
      setFlow({ kind: 'saving' });
      setEffChanges([]);
      let res;
      try {
        res = await saveRegisterEdits(body);
      } catch (err) {
        const rowErrors = registerEditErrors(err);
        const isApi = err instanceof ApiError;
        const forbidden = isApi && err.status === 403 && rowErrors.length === 0;
        let message: string | null;
        if (rowErrors.length > 0) {
          message = isApi && err.code === REGISTER_EDITS_FORBIDDEN ? REGISTER_SAVE_COPY.forbiddenRows : REGISTER_SAVE_COPY.invalid;
        } else if (isApi && err.status === 429) {
          message =
            err.retryAfterSeconds === undefined
              ? REGISTER_SAVE_COPY.rateLimited
              : `Too many saves in a row — wait ${String(Math.max(1, err.retryAfterSeconds))} s and save again. Nothing was saved.`;
        } else if (isApi && err.code === REGISTER_EDITS_INVALID) {
          message = REGISTER_SAVE_COPY.invalid;
        } else {
          message = apiErrorMessage(err, 'The edits could not be saved. Nothing was changed.');
        }
        // The edit bar shows the message; no floating panel for a refused save.
        setFlow({ kind: 'idle' });
        return { ok: false, rowErrors, message, forbidden };
      }

      invalidateRegisterWrite(queryClient);
      setEffChanges(res.eff_changes ?? []);
      const saved = savedText(res.project_ids.length);
      const ok: RegisterSaveResult = { ok: true, rowErrors: [], message: null, forbidden: false };

      switch (res.recalc_status) {
        case 'not_needed':
        case 'unchanged':
        case 'applied':
          setFlow({ kind: 'notice', tone: 'success', title: 'Edits saved', body: `${saved} ${REGISTER_SAVE_COPY.notNeeded}`, followUp: false });
          return ok;
        case 'dispatch_failed':
          setFlow({ kind: 'notice', tone: 'danger', title: 'Edits saved — timeline not recalculated', body: `${saved} ${REGISTER_SAVE_COPY.dispatchFailed}`, followUp: false });
          return ok;
        case 'deferred':
          startWatcher();
          setFlow({ kind: 'notice', tone: 'success', title: 'Edits saved', body: `${saved} ${REGISTER_SAVE_COPY.deferred}`, followUp: true });
          return ok;
        case 'queued':
          break;
      }
      const runId = res.schedule_run_id;
      if (!runId) {
        setFlow({ kind: 'notice', tone: 'warning', title: 'Edits saved', body: `${saved} ${REGISTER_SAVE_COPY.queuedWithoutRun}`, followUp: false });
        return ok;
      }
      const baselineRunId = res.baseline_run_id;
      const count = res.project_ids.length;
      setFlow({ kind: 'running', saved: count, runId, baselineRunId });
      const abort = begin('Queuing the solver…');
      // Not awaited: the grid is free again while the run is followed.
      void follow(runId, abort, { completedMessage: 'Timeline recalculated.' }).then((result) => {
        if (result.outcome === 'aborted') return;
        if (result.outcome === 'completed') {
          invalidateRunDerivedQueries(queryClient);
          setFlow({ kind: 'updated', saved: count, runId, baselineRunId });
          return;
        }
        invalidateRegisterWrite(queryClient);
        setFlow({
          kind: 'notice',
          tone: 'danger',
          title: 'Edits saved — timeline not recalculated',
          body: `${result.message ?? 'The recalculation did not complete.'} ${REGISTER_SAVE_COPY.failedRun}`,
          followUp: false,
        });
      });
      return ok;
    },
    [begin, follow, queryClient, startWatcher],
  );

  const close = React.useCallback(() => {
    reset();
    setFlow({ kind: 'idle' });
    setEffChanges([]);
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
    effChanges,
    saving: flow.kind === 'saving',
    save,
    close,
  };
}
