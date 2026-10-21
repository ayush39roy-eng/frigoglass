import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * P24-T02 (ADR 0035): what a leader slot shows when the served
 * `leader_engineer_id` is null — "No leader" (accessible name "No leader
 * assigned") instead of a bare dash. The real seed keeps the client
 * workbook's blank leaders blank, so this is a common, meaningful state.
 *
 * `leftOut` is the served Left Out verdict of the same project (an outcome
 * field, never derived here). When both served facts hold, the hint "Left
 * out: no leader assigned" is added. The scheduler's `no_leader` reason
 * itself is not served, so no other reason is ever claimed here (I9).
 */
export interface NoLeaderLabelProps {
  /** The project's served outcome is Left Out. */
  leftOut?: boolean;
  /** Put the Left Out hint beside the label instead of below it. */
  inline?: boolean;
  className?: string;
}

export const NO_LEADER_TEXT = 'No leader';
export const NO_LEADER_ACCESSIBLE = 'No leader assigned';
export const NO_LEADER_LEFT_OUT_HINT = 'Left out: no leader assigned';

export function NoLeaderLabel({ leftOut = false, inline = false, className }: NoLeaderLabelProps): React.JSX.Element {
  return (
    <span
      className={cn('flex min-w-0', inline ? 'flex-row items-center gap-x-1.5' : 'flex-col', className)}
      data-testid="no-leader"
    >
      <span className={cn('truncate italic text-text-muted', inline && 'shrink-0')} title={NO_LEADER_ACCESSIBLE}>
        <span aria-hidden="true">{NO_LEADER_TEXT}</span>
        <span className="sr-only">{NO_LEADER_ACCESSIBLE}</span>
      </span>
      {leftOut ? (
        <span
          className="truncate text-2xs font-semibold text-warning-subtle-fg"
          title={NO_LEADER_LEFT_OUT_HINT}
          data-testid="no-leader-left-out"
        >
          {NO_LEADER_LEFT_OUT_HINT}
        </span>
      ) : null}
    </span>
  );
}
