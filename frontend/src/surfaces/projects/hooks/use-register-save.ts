import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { CONFLICT_COPY, editConflicts, keepMineBase, type EditConflict } from '@/lib/api/edit-conflict';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { fetchScheduleRunChanges } from '@/lib/api/priority-move';
import { queryKeys } from '@/lib/query-keys';
import { useEditSession } from '@/stores/edit-session';
import { isDeferringRecalc } from '@/stores/recalc-mode';
import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import { useEditConflict } from '@/lib/use-edit-conflict';
import { useProjectConflictFormat } from '@/lib/use-project-conflict-format';
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
  type RegisterEditsResponse,
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
  /** A 5xx / gateway error or no answer: the server may or may not have
   *  stored the batch (e.g. a worker restarted mid-request), so the list is
   *  reloaded and the edits are kept rather than claiming nothing changed. */
  serverError: (status: number) =>
    `The server did not confirm the save (error ${String(status)}). The list was reloaded to show what is stored: check the rows, then save again if your change is missing.`,
  unreachable:
    'The server could not be reached, so the save was not confirmed. The list was reloaded to show what is stored: check the rows, then save again if your change is missing.',
  fallback: 'The edits could not be saved. Nothing was changed.',
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
  /** P47 (ADR 0059): the 409 `EDIT_CONFLICT` fields, when the user chose
   *  "Use theirs" (the caller drops these fields from its edit buffer and
   *  keeps every other edit) or closed the dialog. Empty otherwise. */
  conflicts: EditConflict[];
  conflictChoice: 'theirs' | 'dismissed' | null;
}

/** "Keep mine" on a batch: each row's `base` takes the values stored now for
 *  its conflicting fields; the other rows are resent unchanged. */
export function keepMineEdits(body: RegisterEditsRequest, conflicts: readonly EditConflict[]): RegisterEditsRequest {
  return {
    edits: body.edits.map((edit) => {
      const mine = conflicts.filter((c) => c.id === edit.project_id);
      if (mine.length === 0 || !edit.base) return edit;
      // `step_exclusions.<code>` lands in the `{code: bool}` base (keepMineBase).
      return { ...edit, base: keepMineBase(edit.base, mine) };
    }),
  };
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

/** No readable refusal: a network failure (status 0) or a 5xx without a
 *  served `detail` / `code` (an HTML gateway page, a crashed worker). The
 *  batch may have been committed, so the caller reloads the stored values. */
export function isUnconfirmedSave(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.status === 0 || err.status >= 500) && !err.detail && !err.code;
}

/** A refused save (not a conflict): per-row errors, 403, 429, network… */
export function refusedResult(err: unknown): RegisterSaveResult {
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
  } else if (isUnconfirmedSave(err)) {
    message = err.status === 0 ? REGISTER_SAVE_COPY.unreachable : REGISTER_SAVE_COPY.serverError(err.status);
  } else {
    message = apiErrorMessage(err, REGISTER_SAVE_COPY.fallback);
  }
  return { ok: false, rowErrors, message, forbidden, conflicts: [], conflictChoice: null };
}

export function useRegisterSave() {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const watcher = useFollowUpRunWatcher();
  const { start: startWatcher } = watcher;
  const [flow, setFlow] = React.useState<RegisterSaveFlow>({ kind: 'idle' });
  // P49-R01 (ADR 0060 R1, W49-1b): saving and following the recalculation
  // hold an auto reload until the result is shown.
  useEditSession(flow.kind === 'saving' || flow.kind === 'running');
  /** Register popup contract §2.5: the served per-step duration changes of
   *  the last successful Save (shown by the panel, never recomputed). */
  const [effChanges, setEffChanges] = React.useState<readonly RegisterEditEffChange[]>([]);
  const conflict = useEditConflict(useProjectConflictFormat());
  const { ask } = conflict;

  const save = React.useCallback(
    async (body: RegisterEditsRequest): Promise<RegisterSaveResult> => {
      setFlow({ kind: 'saving' });
      setEffChanges([]);
      let res: RegisterEditsResponse;
      let sent = body;
      for (;;) {
        try {
          res = await saveRegisterEdits(sent);
          break;
        } catch (err) {
          const conflicts = editConflicts(err);
          if (conflicts === null) {
            // The edit bar shows the message; no floating panel for a refused save.
            setFlow({ kind: 'idle' });
            // Not confirmed either way: show what the server stored now.
            if (isUnconfirmedSave(err)) invalidateRegisterWrite(queryClient);
            return refusedResult(err);
          }
          // P47 (ADR 0059 C2): nothing was written. Ask whose value to keep.
          const choice = await ask(conflicts, body.edits.length > 1 ? CONFLICT_COPY.batchNote : undefined);
          if (choice === 'mine') {
            sent = keepMineEdits(sent, conflicts);
            continue;
          }
          setFlow({ kind: 'idle' });
          if (choice === 'theirs') {
            // Reload, so the grid shows the values stored now.
            invalidateRegisterWrite(queryClient);
            for (const id of new Set(conflicts.map((c) => c.id))) {
              void queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
              void queryClient.invalidateQueries({ queryKey: queryKeys.projectRegisterSteps(id) });
            }
          }
          return {
            ok: false,
            rowErrors: [],
            message: choice === 'theirs' ? CONFLICT_COPY.batchTheirs : CONFLICT_COPY.dismissed,
            forbidden: false,
            conflicts,
            conflictChoice: choice === 'theirs' ? 'theirs' : 'dismissed',
          };
        }
      }

      invalidateRegisterWrite(queryClient);
      setEffChanges(res.eff_changes ?? []);
      const saved = savedText(res.project_ids.length);
      const ok: RegisterSaveResult = { ok: true, rowErrors: [], message: null, forbidden: false, conflicts: [], conflictChoice: null };

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
          if (isDeferringRecalc()) {
            // P61 (ADR 0069): Auto-recalculate is Off — the server ran nothing; no follow-up to wait for.
            setFlow({ kind: 'notice', tone: 'success', title: MOVE_COPY.manualDeferredTitle, body: `${saved} ${MOVE_COPY.manualDeferred}`, followUp: false });
            return ok;
          }
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
    [begin, follow, queryClient, startWatcher, ask],
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
    /** P47: the 409 dialog; render once next to the save panel. */
    conflictDialog: conflict.dialog,
    /** The conflict dialog is open (an edit is still in progress). */
    conflictOpen: conflict.open,
  };
}
