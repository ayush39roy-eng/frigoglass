import * as React from 'react';

import type { BandRankPlacement, PatchRecalcSignal } from '@/lib/api/priority-move';
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

/**
 * P36 (ADR 0050): options of a move inside the band. `position` / `fromPosition`
 * are display copy only ("Move X to position 2 in P1?"), derived by the caller
 * from the served `band_rank` of the card and its anchor; the server decides
 * the rank that is written. There is no band size: the copy never says "of M"
 * (P36-R02).
 */
export interface RankMoveRequestOptions extends PriorityMoveRequestOptions {
  position?: number | null;
  fromPosition?: number | null;
  /** P60 (ADR 0068): where `position` counts when it is a hub rank, e.g.
   *  "PD-India · P1" ("Move X to position 3 in PD-India · P1?"). Copy only. */
  scope?: string | null;
}

export interface PriorityMoveApi {
  /** Open the confirm step for a move to `next` (no-op if busy or unchanged;
   *  `options.onSettled` then reports `cancelled`). */
  requestMove: (target: PriorityMoveTarget, next: ProjectPriority, options?: PriorityMoveRequestOptions) => void;
  /**
   * P36 (ADR 0050): open the same preview dialog for a move inside the
   * project's band (`target.priority`), placed directly before / after one
   * project of the band. Same Yes / No, PREVIEW_STALE re-preview and run
   * follow as `requestMove`. No-op (`cancelled`) if busy or no band.
   */
  requestRankMove: (target: PriorityMoveTarget, placement: BandRankPlacement, options?: RankMoveRequestOptions) => void;
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
