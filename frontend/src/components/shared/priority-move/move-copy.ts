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
  dispatchFailed: 'The priority is saved, but the recalculation could not be started. Press Recalculate on the project to update the timeline.',
  noBaseline: 'There was no earlier schedule to compare against, so no list of moves is available.',
  unchangedOwn: "This project's finish week did not change.",
  noOtherMoves: 'No other project you can see moved.',
  formHint: 'Changing priority recalculates the timeline.',
  // P14 (ADR 0026): the preview dialog.
  previewIntro: 'Nothing is saved until you choose Yes.',
  previewLoading: 'Calculating what this move would change…',
  previewRateLimited: 'Too many previews in a row — wait a few seconds and try again. Nothing was changed.',
  previewFailed: 'The preview could not be calculated. Nothing was changed.',
  previewRefreshed: 'The plan changed since the first preview, so it was recalculated. Review it and confirm again.',
  previewNoBaseline: 'There is no active schedule yet, so there is nothing to compare against.',
  previewNoOthers: 'No other project you can see would change.',
  appliedNoOthers: 'No other project you can see changed.',
  formNotApplied: 'The priority move was not applied, so nothing was saved. Change the priority back or save again.',
} as const;

/** P36 (ADR 0050): copy that differs for a move inside a priority band. */
export const RANK_COPY = {
  staleAfterFailure: 'The new position is saved and the timeline is marked stale. Press Recalculate on the project to try again.',
  dispatchFailed: 'The new position is saved, but the recalculation could not be started. Press Recalculate on the project to update the timeline.',
  notRankable: "This project can't be reordered: it has no priority or its status isn't in the plan. Nothing was changed.",
  notSameBand: 'The board changed since you moved the card, so that position is no longer available. Nothing was changed.',
  applied: 'Position changed and the timeline recalculated.',
} as const;

/**
 * "position 2 in P1". Display copy only. Never "of M" (P36-R02, W36-1): the
 * served column count is narrowed by filters, the hub / country selection and a
 * Hub Planner's server scope, while `band_rank` is the full-band position, so
 * no count the browser holds is the band's size.
 */
export function rankPositionCopy(position: number | null, band: string): string {
  if (position === null) return `a new position in ${band}`;
  return `position ${position} in ${band}`;
}

/** Preview `not_needed`: nothing is computed, but Yes still saves the priority. */
export function previewNotNeededCopy(status: string | null | undefined): string {
  return status
    ? `This project isn't in the plan (status ${status}), so moving it changes no timeline. Yes saves the new priority.`
    : "This project isn't in the plan, so moving it changes no timeline. Yes saves the new priority.";
}

/** `not_needed`: the project status is not schedulable (Draft, On Hold,
 *  Commercialized, Cancelled), so no run was started. */
export function notNeededCopy(status: string | null | undefined): string {
  return status
    ? `Saved. This project isn't in the plan (status ${status}), so no timeline change.`
    : "Saved. This project isn't in the plan, so no timeline change.";
}
