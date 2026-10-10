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

export interface PriorityMoveApi {
  /** Open the confirm step for a move to `next` (no-op if busy or unchanged). */
  requestMove: (target: PriorityMoveTarget, next: ProjectPriority) => void;
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
