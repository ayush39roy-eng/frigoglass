import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { CONFLICT_COPY, conflictFieldPrefix, editConflicts, keepMineBase, type EditConflict } from '@/lib/api/edit-conflict';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { useEditConflict } from '@/lib/use-edit-conflict';
import { fetchScheduleRunChanges } from '@/lib/api/priority-move';
import { queryKeys } from '@/lib/query-keys';
import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';
import { MOVE_COPY } from '@/components/shared/priority-move/move-copy';

import { saveStepPins, stepPinErrors } from '../api/step-pins-api';
import type { StepPinError, StepPinItem, StepPinsRequest, StepPinsResponse } from '../api/types';

/**
 * P40-T03c (ADR 0054 R40-11, docs/API_CONTRACT_P40.md §1): save the drafted
 * Start / End weeks (`PUT /gantt/step-pins`, one all-or-nothing batch) and
 * follow what the server did — the priority move's lifecycle, through the
 * same shared hooks as the register save (`useScheduleRunFollow`,
 * `useFollowUpRunWatcher`, `invalidateRunDerivedQueries`):
 *
 *   queued          → follow the run → GET …/changes → "Timeline updated"
 *   deferred        → saved; the coalesced follow-up run is watched
 *   not_needed      → saved; no schedulable project changed
 *   unchanged       → every item equalled its stored pair; nothing written
 *   dispatch_failed → saved, projects stale, Recalculate by hand
 *   409 / 422 with `detail.errors` → per-step errors, nothing saved
 *
 * The server decides every branch; the browser only reports it.
 */

export const STEP_PIN_SAVE_COPY = {
  notNeeded: 'No schedulable project changed, so the timeline did not need recalculating.',
  unchanged: 'Every step already had these weeks. Nothing was changed.',
  deferred: MOVE_COPY.deferred,
  dispatchFailed:
    'The recalculation could not be started, so the projects are marked stale. Press Recalculate on a project to update the timeline.',
  failedRun: 'Your step weeks are saved and the projects are marked stale. Press Recalculate on a project to try again.',
  queuedWithoutRun: 'The recalculation was queued but no run was reported back. Press Recalculate on a project.',
  refused: 'Nothing was saved. Fix the highlighted steps and save again.',
  forbidden: 'Nothing was saved. Only Admin and Super Admin can set step weeks.',
  rateLimited: 'Too many saves in a row. Wait a few seconds and save again. Nothing was saved.',
} as const;

export type StepPinSaveFlow =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'running'; saved: number; runId: string; baselineRunId: string | null }
  | { kind: 'updated'; saved: number; runId: string; baselineRunId: string | null }
  | {
      kind: 'notice';
      status: 'not_needed' | 'unchanged' | 'deferred' | 'dispatch_failed' | 'queued' | 'failed';
      tone: 'success' | 'warning' | 'danger';
      title: string;
      body: string;
      followUp: boolean;
    };

export interface StepPinSaveResult {
  ok: boolean;
  /** Per-step refusals (`detail.errors`). */
  itemErrors: StepPinError[];
  /** A batch-level message for the edit bar. */
  message: string | null;
  /** P47 (ADR 0059): the 409 `EDIT_CONFLICT` fields after "Use theirs" (the
   *  page drops those steps' drafts only) or a closed dialog. */
  conflicts?: EditConflict[];
  conflictChoice?: 'theirs' | 'dismissed';
}

/** The batch item a conflict names: `entity: project_step`, `id` = the
 *  project, `field` = `<step>.manual_start_week` / `.manual_end_week`. */
export function conflictMatchesPin(conflict: EditConflict, item: StepPinItem): boolean {
  const step = conflictFieldPrefix(conflict.field);
  return conflict.id === item.project_id && (step === null || step === item.step_template_id);
}

function keepMinePins(body: StepPinsRequest, conflicts: readonly EditConflict[]): StepPinsRequest {
  return {
    items: body.items.map((item) => {
      const mine = conflicts.filter((c) => conflictMatchesPin(c, item));
      if (mine.length === 0 || !item.base) return item;
      return { ...item, base: keepMineBase(item.base, mine) };
    }),
  };
}

function invalidatePinWrite(queryClient: QueryClient): void {
  for (const key of [['gantt'], ['dashboard'], ['projects']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

function savedText(n: number): string {
  return `Saved ${String(n)} ${n === 1 ? 'step' : 'steps'}.`;
}

export function useStepPinSave() {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const watcher = useFollowUpRunWatcher();
  const { start: startWatcher } = watcher;
  const [flow, setFlow] = React.useState<StepPinSaveFlow>({ kind: 'idle' });
  const conflict = useEditConflict();
  const { ask } = conflict;

  const save = React.useCallback(
    async (body: StepPinsRequest): Promise<StepPinSaveResult> => {
      setFlow({ kind: 'saving' });
      let res: StepPinsResponse;
      let sent = body;
      try {
        for (;;) {
          try {
            res = await saveStepPins(sent);
            break;
          } catch (err) {
            const conflicts = editConflicts(err);
            if (conflicts === null) throw err;
            // P47 (ADR 0059 C2): nothing was written; ask whose weeks to keep.
            const choice = await ask(conflicts, sent.items.length > 1 ? CONFLICT_COPY.batchNote : undefined);
            if (choice === 'mine') {
              sent = keepMinePins(sent, conflicts);
              continue;
            }
            if (choice === 'theirs') invalidatePinWrite(queryClient);
            setFlow({ kind: 'idle' });
            return {
              ok: false,
              itemErrors: [],
              message: choice === 'theirs' ? CONFLICT_COPY.batchTheirs : CONFLICT_COPY.dismissed,
              conflicts,
              conflictChoice: choice === 'theirs' ? 'theirs' : 'dismissed',
            };
          }
        }
      } catch (err) {
        const itemErrors = stepPinErrors(err);
        const isApi = err instanceof ApiError;
        let message: string;
        if (itemErrors.length > 0) message = STEP_PIN_SAVE_COPY.refused;
        else if (isApi && err.status === 403) message = STEP_PIN_SAVE_COPY.forbidden;
        else if (isApi && err.status === 429) {
          message =
            err.retryAfterSeconds === undefined
              ? STEP_PIN_SAVE_COPY.rateLimited
              : `Too many saves in a row. Wait ${String(Math.max(1, err.retryAfterSeconds))} s and save again. Nothing was saved.`;
        } else message = apiErrorMessage(err, 'The step weeks could not be saved. Nothing was changed.');
        setFlow({ kind: 'idle' });
        return { ok: false, itemErrors, message };
      }

      invalidatePinWrite(queryClient);
      const changed = res.changes.length;
      const saved = savedText(changed);
      const ok: StepPinSaveResult = { ok: true, itemErrors: [], message: null };

      switch (res.recalc_status) {
        case 'unchanged':
          setFlow({ kind: 'notice', status: 'unchanged', tone: 'success', title: 'Nothing to save', body: STEP_PIN_SAVE_COPY.unchanged, followUp: false });
          return ok;
        case 'not_needed':
        case 'applied':
          setFlow({ kind: 'notice', status: 'not_needed', tone: 'success', title: 'Step weeks saved', body: `${saved} ${STEP_PIN_SAVE_COPY.notNeeded}`, followUp: false });
          return ok;
        case 'dispatch_failed':
          setFlow({
            kind: 'notice',
            status: 'dispatch_failed',
            tone: 'danger',
            title: 'Step weeks saved — timeline not recalculated',
            body: `${saved} ${STEP_PIN_SAVE_COPY.dispatchFailed}`,
            followUp: false,
          });
          return ok;
        case 'deferred':
          startWatcher();
          setFlow({ kind: 'notice', status: 'deferred', tone: 'success', title: 'Step weeks saved', body: `${saved} ${STEP_PIN_SAVE_COPY.deferred}`, followUp: true });
          return ok;
        case 'queued':
          break;
      }
      const runId = res.schedule_run_id;
      if (!runId) {
        setFlow({ kind: 'notice', status: 'queued', tone: 'warning', title: 'Step weeks saved', body: `${saved} ${STEP_PIN_SAVE_COPY.queuedWithoutRun}`, followUp: false });
        return ok;
      }
      const baselineRunId = res.baseline_run_id;
      setFlow({ kind: 'running', saved: changed, runId, baselineRunId });
      const abort = begin('Queuing the solver…');
      void follow(runId, abort, { completedMessage: 'Timeline recalculated.' }).then((result) => {
        if (result.outcome === 'aborted') return;
        if (result.outcome === 'completed') {
          invalidateRunDerivedQueries(queryClient);
          setFlow({ kind: 'updated', saved: changed, runId, baselineRunId });
          return;
        }
        invalidatePinWrite(queryClient);
        setFlow({
          kind: 'notice',
          status: 'failed',
          tone: 'danger',
          title: 'Step weeks saved — timeline not recalculated',
          body: `${result.message ?? 'The recalculation did not complete.'} ${STEP_PIN_SAVE_COPY.failedRun}`,
          followUp: false,
        });
      });
      return ok;
    },
    [begin, follow, queryClient, startWatcher, ask],
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
    staleTime: Infinity,
    retry: 1,
  });

  return {
    flow,
    runState: run.state,
    changes,
    watchingFollowUp: watcher.watching,
    saving: flow.kind === 'saving',
    save,
    close,
    /** P47: the 409 dialog; render once on the page. */
    conflictDialog: conflict.dialog,
  };
}
