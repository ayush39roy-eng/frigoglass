import * as React from 'react';

import type { PatchRecalcSignal } from '@/lib/api/priority-move';
import type { ProjectPriority } from '@/types/enums';

/** The project a move acts on. Everything here is display data the caller
 *  already has from its own served payload. */
export interface PriorityMoveTarget {
  projectId: string;
  projectName: string;
  /** The priority the caller currently shows. */
  priority: ProjectPriority | null;
  /** Project status, used only in the `not_needed` copy. The Gantt row does not
   *  carry it, so it is optional. */
  status?: string | null | undefined;
}

/**
 * How a requested move ended, for callers that show it optimistically (the
 * P12 Priority board, ADR 0018): `accepted` once the POST returned 200 (any
 * `recalc_status`), `rejected` on any error (incl. 409 `HARD_GATE_FORCES_P1`),
 * `cancelled` when the confirm step was dismissed or the request was ignored.
 */
export type PriorityMoveOutcome = 'accepted' | 'rejected' | 'cancelled';

export interface PriorityMoveRequestOptions {
  onSettled?: (outcome: PriorityMoveOutcome) => void;
}

export interface PriorityMoveApi {
  /** Open the confirm step for a move to `next` (no-op if busy or unchanged;
   *  `options.onSettled` then reports `cancelled`). */
  requestMove: (target: PriorityMoveTarget, next: ProjectPriority, options?: PriorityMoveRequestOptions) => void;
  /**
   * Report a `PATCH /projects/{id}` that changed priority (contract §2). The
   * caller read the `X-Schedule-*` headers; this shows the same progress and
   * "Timeline updated" panel as a move from the dropdown.
   */
  followPatch: (
    target: PriorityMoveTarget,
    signal: PatchRecalcSignal,
    priorityBefore: ProjectPriority | null,
    priorityAfter: ProjectPriority | null,
  ) => void;
  /** A move is being submitted or its run is being followed. */
  busy: boolean;
}

export const PriorityMoveContext = React.createContext<PriorityMoveApi | null>(null);

/** The surrounding priority-move host, or `null` when none is mounted. */
export function usePriorityMoveHost(): PriorityMoveApi | null {
  return React.useContext(PriorityMoveContext);
}
