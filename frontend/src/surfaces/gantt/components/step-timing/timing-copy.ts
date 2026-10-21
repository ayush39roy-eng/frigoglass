import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { MOVE_COPY } from '@/components/shared/priority-move/move-copy';

/**
 * Honest copy for every Gantt step-timing outcome (ADR 0019, P12 contract §3).
 * The server decides each branch; the Gantt only says what it was told.
 */
export const TIMING_COPY = {
  savedTitle: 'Timing saved',
  notChangedTitle: 'Timing not changed',
  failedTitle: 'Timing saved — timeline not recalculated',
  /** ADR 0023: the same follow-up behaviour (and words) as a priority move. */
  deferred: MOVE_COPY.deferred,
  notNeeded:
    "Saved. This lab step is skipped while the project needs no certification testing, so the timeline doesn't change. The timing is kept for when testing is turned back on.",
  unchanged: 'Nothing changed — the step already has this timing.',
  dispatchFailed: 'The timing is saved, but the recalculation could not be started. Press Recalculate on the project.',
  queuedWithoutRun:
    'Saved. The recalculation was queued but no run was reported back — press Recalculate on the project.',
  staleAfterFailure:
    'The timing is saved and the timeline is marked stale. Press Recalculate on the project to try again.',
  floorNote:
    'Dragging the bar sets an earliest start. Precedence and capacity still apply, so the step may land later than where you dropped it, never earlier.',
  startedNote: 'This step has started, so its start is fixed. Only its duration can change.',
} as const;

/** 409 codes of `PATCH /projects/{id}/steps/{step_id}/timing`. Nothing is
 *  saved on any of them. */
export const TIMING_ERROR_COPY: Record<string, string> = {
  PROJECT_FROZEN: 'This project is frozen, so its step timing cannot change. Unfreeze it on the timeline first. Nothing was saved.',
  NOT_SCHEDULABLE:
    "This project's status is not scheduled (for example On Hold, Commercialized or Cancelled), so its step timing cannot change. Nothing was saved.",
  STEP_DONE: 'This step is Done. Its timing is history and cannot change. Nothing was saved.',
  STEP_STARTED: `${TIMING_COPY.startedNote} Nothing was saved.`,
  STEP_SKIPPED: 'This step is skipped for the project (0 weeks), so it has no timing to change. Nothing was saved.',
};

export function timingErrorCopy(err: unknown): string {
  if (err instanceof ApiError && err.code && err.code in TIMING_ERROR_COPY) {
    return TIMING_ERROR_COPY[err.code] ?? '';
  }
  if (err instanceof ApiError && err.isForbidden) {
    return 'Your role cannot change step timing on this project (Hub Planner of its hub, Admin or Super Admin).';
  }
  return apiErrorMessage(err, 'The step timing could not be changed. Nothing was saved.');
}
