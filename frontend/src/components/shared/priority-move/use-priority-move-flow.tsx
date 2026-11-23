import * as React from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import {
  BAD_RANK,
  BOTH_ANCHORS,
  fetchScheduleRunChanges,
  HARD_GATE_FORCES_P1,
  placementBody,
  placementTargetRank,
  moveProjectBandRank,
  moveProjectPriority,
  NOT_RANKABLE,
  NOT_SAME_BAND,
  PREVIEW_STALE,
  previewProjectBandRank,
  previewProjectPriority,
  type BandRankPlacement,
  type PriorityMoveResponse,
  type PriorityPreviewResponse,
  type RecalcStatus,
} from '@/lib/api/priority-move';
import { isPriorityNotApplicable } from '@/lib/priority-applicability';
import { queryKeys } from '@/lib/query-keys';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';
import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import type { ProjectPriority } from '@/types/enums';

import { badRankCopy, MOVE_COPY, notNeededCopy, RANK_COPY } from './move-copy';
import { MoveFlowPanel } from './move-flow-panel';
import { PriorityPreviewDialog } from './priority-preview-dialog';
import type {
  PriorityMoveApi,
  PriorityMoveOutcome,
  PriorityMoveRequestOptions,
  PriorityMoveTarget,
  RankMoveRequestOptions,
} from './priority-move-context';

/**
 * The priority-move flow (ADR 0015, P11-T02; preview first since P14, ADR 0026),
 * shared by the Priority board, the Gantt, the Project Workspace header and the
 * Registration / Workspace edit form.
 *
 *   POST …/priority/preview → the preview dialog (nothing written yet)
 *     unchanged  → nothing
 *     not_needed → "not in the plan" note, Yes still saves the priority
 *     409 HARD_GATE_FORCES_P1 → the hard-gate copy
 *   Yes → POST /projects/{id}/priority {preview_token} → recalc_status
 *     applied    → the applied result in the dialog (run already active)
 *     409 PREVIEW_STALE → re-preview automatically, once
 *   No → nothing is written (a board drop snaps back)
 *
 * The confirm (and the form's PATCH path) can still answer:
 *     queued     → follow the run's SSE progress → GET …/changes → "Timeline updated"
 *     deferred   → "updates automatically" copy + watch for the follow-up run (ADR 0023)
 *     not_needed → honest "not in the plan" copy
 *     unchanged  → nothing
 *     409 HARD_GATE_FORCES_P1 → the hard-gate copy
 *
 * P36 (ADR 0050): `requestRankMove` runs the same flow for a move inside the
 * band (`POST …/band-rank/preview`, then `POST …/band-rank` with the token);
 * every state then carries `rank` (the placement and its display position).
 * The placement is anchors (drag and drop) or, since 2026-11-17, `{ to_rank }`
 * (the board's ↑ / ↓ buttons and typed position); 422 `BAD_RANK` gets its own copy.
 *
 * The server decides every branch. The browser only shows what it was told.
 * The state lives with the page, not with the control, so a virtualized Gantt
 * row scrolling out of view never cancels a run being followed.
 */

/** P36: a move inside the band. `position` etc. are display copy only. */
export interface RankMoveSpec {
  placement: BandRankPlacement;
  position: number | null;
  fromPosition: number | null;
  /** P60 (ADR 0068): where the position counts, e.g. "PD-India · P1" for a hub rank; null = the band. */
  scope: string | null;
}

interface RunMoveFields {
  target: PriorityMoveTarget;
  rank: RankMoveSpec | null;
  before: ProjectPriority | null;
  after: ProjectPriority | null;
  runId: string;
  baselineRunId: string | null;
}

export type MoveFlowState =
  | { kind: 'idle' }
  // P14 (ADR 0026): the modal preview dialog.
  // P36: `rank` set = a move inside the band `next` (= the current priority).
  | { kind: 'previewing'; target: PriorityMoveTarget; next: ProjectPriority; rank: RankMoveSpec | null; refreshed: boolean }
  | {
      kind: 'preview' | 'applying';
      target: PriorityMoveTarget;
      next: ProjectPriority;
      rank: RankMoveSpec | null;
      preview: PriorityPreviewResponse;
      /** This preview replaced one that went stale before Yes (PREVIEW_STALE). */
      refreshed: boolean;
    }
  | { kind: 'applied'; target: PriorityMoveTarget; next: ProjectPriority; rank: RankMoveSpec | null; result: PriorityMoveResponse }
  | { kind: 'previewError'; target: PriorityMoveTarget; next: ProjectPriority; rank: RankMoveSpec | null; body: string }
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
  for (const key of [['projects'], ['gantt'], ['dashboard'], ['priority-matrix'], ['priority-board'], ['vip-board']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/** P36: honest copy for the re-rank refusals (contract §2); null for any other error. */
function rankErrorCopy(err: unknown, target: PriorityMoveTarget, band: ProjectPriority, rank: RankMoveSpec | null): string | null {
  if (!(err instanceof ApiError) || !rank) return null;
  if (err.code === BAD_RANK) {
    const to = placementTargetRank(rank.placement) ?? rank.position;
    return badRankCopy(target.projectName, rank.scope ?? band, to, rank.fromPosition);
  }
  if (err.code === NOT_RANKABLE) return RANK_COPY.notRankable;
  if (err.code === NOT_SAME_BAND || err.code === BOTH_ANCHORS) return RANK_COPY.notSameBand;
  return null;
}

/** A request is in flight (preview, confirm) or a queued run is being followed. */
function isBusy(kind: MoveFlowState['kind']): boolean {
  return kind === 'previewing' || kind === 'applying' || kind === 'running';
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
      rank: RankMoveSpec | null = null,
    ): Promise<void> => {
      const copy = rank ? RANK_COPY : MOVE_COPY;
      const saved = rank ? 'Position saved' : 'Priority saved';
      if (signal.recalc_status === 'unchanged' || signal.recalc_status === 'applied') {
        // `applied` is handled by `confirm` (it carries the change list); a
        // PATCH never reports it.
        setFlow({ kind: 'idle' });
        return;
      }
      if (signal.recalc_status === 'dispatch_failed') {
        invalidatePriorityWrite(queryClient);
        setFlow({ kind: 'notice', target, tone: 'danger', title: `${saved} — timeline not recalculated`, body: copy.dispatchFailed });
        return;
      }
      if (signal.recalc_status === 'deferred') {
        invalidatePriorityWrite(queryClient);
        setFlow({ kind: 'notice', target, tone: 'success', title: saved, body: MOVE_COPY.deferred });
        // ADR 0023: the server runs one follow-up after the current run; refresh when it lands.
        followUp.start();
        return;
      }
      if (signal.recalc_status === 'not_needed') {
        invalidatePriorityWrite(queryClient);
        setFlow({ kind: 'notice', target, tone: 'success', title: saved, body: notNeededCopy(target.status) });
        return;
      }
      const runId = signal.schedule_run_id;
      if (!runId) {
        invalidatePriorityWrite(queryClient);
        setFlow({ kind: 'notice', target, tone: 'warning', title: saved, body: MOVE_COPY.queuedWithoutRun });
        return;
      }
      const baselineRunId = signal.baseline_run_id;
      setFlow({ kind: 'running', target, rank, before, after, runId, baselineRunId });
      const abort = begin('Queuing the solver…');
      const result = await follow(runId, abort, { completedMessage: 'Timeline recalculated.' });
      if (result.outcome === 'aborted') return;
      if (result.outcome === 'completed') {
        invalidateRunDerivedQueries(queryClient);
        setFlow({ kind: 'updated', target, rank, before, after, runId, baselineRunId });
        return;
      }
      // SSE or run failure: say so. The project stays schedule_stale, so the
      // stale banner/chip stays on screen after this refetch.
      invalidatePriorityWrite(queryClient);
      setFlow({
        kind: 'notice',
        target,
        tone: 'danger',
        title: `${saved} — timeline not recalculated`,
        body: `${result.message ?? 'The recalculation did not complete.'} ${copy.staleAfterFailure}`,
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
    busyRef.current = isBusy(flow.kind);
  }, [flow.kind]);

  // One preview request at a time; a newer one (or No) aborts the older.
  const previewAbortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => previewAbortRef.current?.abort(), []);

  const runPreview = React.useCallback(
    async (target: PriorityMoveTarget, next: ProjectPriority, rank: RankMoveSpec | null, refreshed: boolean): Promise<void> => {
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      setFlow({ kind: 'previewing', target, next, rank, refreshed });
      try {
        const preview = rank
          ? await previewProjectBandRank(target.projectId, rank.placement, { signal: controller.signal })
          : await previewProjectPriority(target.projectId, next, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (preview.result === 'unchanged') {
          settle('cancelled');
          setFlow({ kind: 'idle' });
          return;
        }
        setFlow({ kind: 'preview', target, next, rank, preview, refreshed });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        settle('rejected');
        // 429 gets move-specific copy: the shared 429 text talks about comments.
        const body =
          err instanceof ApiError && err.code === HARD_GATE_FORCES_P1
            ? MOVE_COPY.hardGate
            : err instanceof ApiError && err.status === 429
              ? MOVE_COPY.previewRateLimited
              : (rankErrorCopy(err, target, next, rank) ?? apiErrorMessage(err, MOVE_COPY.previewFailed));
        setFlow({ kind: 'previewError', target, next, rank, body });
      }
    },
    [settle],
  );

  const requestMove = React.useCallback(
    (target: PriorityMoveTarget, next: ProjectPriority, options?: PriorityMoveRequestOptions) => {
      // P57 (ADR 0067): no move for a Commercialized / Cancelled project.
      if (next === target.priority || busyRef.current || isPriorityNotApplicable(target.status)) {
        options?.onSettled?.('cancelled');
        return;
      }
      settle('cancelled'); // an earlier, unconfirmed request is superseded
      settleRef.current = options?.onSettled ?? null;
      void runPreview(target, next, null, false);
    },
    [runPreview, settle],
  );

  const requestRankMove = React.useCallback(
    (target: PriorityMoveTarget, placement: BandRankPlacement, options?: RankMoveRequestOptions) => {
      const band = target.priority;
      if (band === null || busyRef.current || isPriorityNotApplicable(target.status)) {
        options?.onSettled?.('cancelled');
        return;
      }
      settle('cancelled'); // an earlier, unconfirmed request is superseded
      settleRef.current = options?.onSettled ?? null;
      const rank: RankMoveSpec = {
        placement: placementBody(placement),
        position: options?.position ?? null,
        fromPosition: options?.fromPosition ?? null,
        scope: options?.scope ?? null,
      };
      void runPreview(target, band, rank, false);
    },
    [runPreview, settle],
  );

  /** "Yes, apply": confirm the previewed move with its token (ADR 0026 §2). */
  const confirm = React.useCallback(async () => {
    if (flow.kind !== 'preview') return;
    const { target, next, rank, preview, refreshed } = flow;
    setFlow({ kind: 'applying', target, next, rank, preview, refreshed });
    try {
      const res = rank
        ? await moveProjectBandRank(target.projectId, rank.placement, preview.preview_token ?? '')
        : await moveProjectPriority(target.projectId, next, preview.preview_token);
      settle('accepted');
      if (res.recalc_status === 'applied') {
        // The new run is already active: every view reading it refetches.
        invalidateRunDerivedQueries(queryClient);
        if (rank) invalidatePriorityWrite(queryClient); // the board order changed
        setFlow({ kind: 'applied', target, next, rank, result: res });
        return;
      }
      await handleSignal(target, res, res.priority_before, res.priority_after, rank);
    } catch (err) {
      if (err instanceof ApiError && err.code === PREVIEW_STALE && !refreshed) {
        // Something changed since the preview; nothing was written. Show the
        // fresh preview once — the user decides again on what will happen now.
        await runPreview(target, next, rank, true);
        return;
      }
      settle('rejected');
      const body =
        err instanceof ApiError && err.code === HARD_GATE_FORCES_P1
          ? MOVE_COPY.hardGate
          : (rankErrorCopy(err, target, next, rank) ??
            apiErrorMessage(err, rank ? 'The position could not be changed.' : 'The priority could not be changed.'));
      setFlow({ kind: 'previewError', target, next, rank, body });
    }
  }, [flow, handleSignal, queryClient, runPreview, settle]);

  const followPatch = React.useCallback<PriorityMoveApi['followPatch']>(
    (target, signal, before, after) => {
      void handleSignal(target, signal, before, after);
    },
    [handleSignal],
  );

  const close = React.useCallback(() => {
    previewAbortRef.current?.abort();
    settle('cancelled'); // no-op unless a request was never confirmed
    reset();
    setFlow({ kind: 'idle' });
  }, [reset, settle]);

  /** "No, cancel" (or Escape) on the preview dialog. Never while applying. */
  const cancelPreview = React.useCallback(() => {
    if (flow.kind === 'applying') return;
    previewAbortRef.current?.abort();
    settle('cancelled'); // no-op once the move was accepted or rejected
    setFlow({ kind: 'idle' });
  }, [flow.kind, settle]);

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

  const busy = isBusy(flow.kind);
  const api = React.useMemo<PriorityMoveApi>(
    () => ({ requestMove, requestRankMove, followPatch, busy }),
    [requestMove, requestRankMove, followPatch, busy],
  );

  const element = (
    <>
      <PriorityPreviewDialog flow={flow} onConfirm={() => void confirm()} onCancel={cancelPreview} />
      <MoveFlowPanel flow={flow} runState={run.state} changes={changes} onClose={close} followUpWatching={followUp.watching} />
    </>
  );

  return { api, element };
}
