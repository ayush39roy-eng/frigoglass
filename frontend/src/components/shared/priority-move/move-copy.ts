/**
 * Honest copy for every priority-move outcome (ADR 0015, P11-T02). One place,
 * so the dropdown and the Registration form say exactly the same thing.
 */

export const MOVE_COPY = {
  confirmBody: 'The timeline will be recalculated.',
  // ADR 0023: a deferred auto-recalc gets one coalesced follow-up run; the
  // browser watches for it (`lib/use-follow-up-run.ts`) and refreshes.
  deferred: 'Saved — the timeline updates automatically after the current recalculation',
  followUpWatching: 'Waiting for the follow-up recalculation…',
  hardGate: 'This project has a hard gate (regulatory / certification / safety), so it must stay P1.',
  queuedWithoutRun: 'Saved. The recalculation was queued but no run was reported back — press Recalculate on the project.',
  staleAfterFailure: 'The priority is saved and the timeline is marked stale. Press Recalculate on the project to try again.',
  noBaseline: 'There was no earlier schedule to compare against, so no list of moves is available.',
  unchangedOwn: "This project's finish week did not change.",
  noOtherMoves: 'No other project you can see moved.',
  formHint: 'Changing priority recalculates the timeline.',
} as const;

/** `not_needed`: the project status is not schedulable (Draft, On Hold,
 *  Commercialized, Cancelled), so no run was started. */
export function notNeededCopy(status: string | null | undefined): string {
  return status
    ? `Saved. This project isn't in the plan (status ${status}), so no timeline change.`
    : "Saved. This project isn't in the plan, so no timeline change.";
}
