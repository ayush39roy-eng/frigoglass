import * as React from 'react';

import type {
  PriorityMoveApi,
  PriorityMoveOutcome,
  PriorityMoveTarget,
} from '@/components/shared/priority-move/priority-move-context';
import type { ProjectPriority } from '@/types/enums';

/** P54 (ADR 0064 R3 / ADR 0050 §5): the form's copy for an unsaved band. */
export const RANK_WHEN_SAVED = 'Ranked last in its band when saved';

/**
 * One request: the same guards and options as the board's `rankTo`. P60 (ADR
 * 0068): `from` / `toRank` are HUB ranks and the body is `{ hub_rank }`;
 * `scope` ("PD-India · P1") is the dialog's copy.
 */
export function useRequestBandRank(host: PriorityMoveApi | null): (
  target: PriorityMoveTarget & { priority: ProjectPriority },
  from: number,
  toRank: number,
  onSettled?: (outcome: PriorityMoveOutcome) => void,
  scope?: string,
) => void {
  return React.useCallback(
    (target, from, toRank, onSettled, scope) => {
      if (!host || !Number.isSafeInteger(toRank) || toRank < 1 || toRank === from) {
        onSettled?.('cancelled');
        return;
      }
      host.requestRankMove(
        target,
        { hub_rank: toRank },
        { position: toRank, fromPosition: from, ...(scope ? { scope } : {}), ...(onSettled ? { onSettled } : {}) },
      );
    },
    [host],
  );
}
