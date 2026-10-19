import type { ProjectPriority } from '@/types/enums';

import { MOVE_COPY } from './move-copy';
import type { PriorityMoveApi, PriorityMoveOutcome, PriorityMoveTarget } from './priority-move-context';

/**
 * Thrown by `applyFormPriorityMove` when the user said No to the preview, or
 * the move was refused. The form keeps its edits open and shows `message`;
 * nothing was saved (ADR 0026 §5: nothing is written until Yes).
 */
export class PriorityMoveNotAppliedError extends Error {
  readonly outcome: Exclude<PriorityMoveOutcome, 'accepted'>;

  constructor(outcome: Exclude<PriorityMoveOutcome, 'accepted'>) {
    super(MOVE_COPY.formNotApplied);
    this.name = 'PriorityMoveNotAppliedError';
    this.outcome = outcome;
  }
}

/**
 * P14 (ADR 0026): an edit form whose priority changed moves it through the
 * shared preview dialog FIRST — preview, then Yes confirms through
 * `POST /projects/{id}/priority` with the preview token. The rest of the form
 * is then saved by the caller's PATCH as before, without `priority` (already
 * applied), so the PATCH never moves it a second time.
 *
 * Returns the body to PATCH. A body whose priority is unchanged, or cleared
 * (the preview needs a target band; clearing keeps the ADR 0015 PATCH path),
 * or a page with no move host, is returned untouched.
 */
export async function applyFormPriorityMove<B extends { priority?: ProjectPriority | null }>(
  host: PriorityMoveApi | null,
  target: PriorityMoveTarget,
  body: B,
): Promise<B> {
  const next = body.priority;
  if (!host || !next || next === target.priority) return body;
  const outcome = await new Promise<PriorityMoveOutcome>((resolve) => {
    host.requestMove(target, next, { onSettled: resolve });
  });
  if (outcome !== 'accepted') throw new PriorityMoveNotAppliedError(outcome);
  const rest = { ...body };
  delete rest.priority;
  return rest;
}
