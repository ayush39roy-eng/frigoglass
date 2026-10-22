import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * P29 (ADR 0042 §5, API_CONTRACT_P29 §3.3): the marker on an engineer row whose
 * served `counts_in_capacity` is false. The scheduler still books them (they
 * lead projects), but they are not on the client's capacity roster, so their
 * FTE is never counted as supply (OQ #52: Theoni, Dipak, Antonis, Sailesh).
 * Full words, no ellipsis; the title and sr text say what it means.
 */
export const NOT_IN_ROSTER_TEXT = 'Not in capacity roster';
export const NOT_IN_ROSTER_HINT =
  'Booked for the projects they lead, but not on the capacity roster: their FTE is not counted as capacity.';

export function NotInCapacityRosterBadge({ className }: { className?: string }): React.JSX.Element {
  return (
    <Badge
      tone="warning"
      className={cn('shrink-0 whitespace-nowrap rounded-pill', className)}
      title={NOT_IN_ROSTER_HINT}
      data-testid="not-in-capacity-roster"
    >
      {NOT_IN_ROSTER_TEXT}
      <span className="sr-only">: booked as a leader, FTE not counted as capacity</span>
    </Badge>
  );
}

/**
 * P29 (ADR 0042 §7, API_CONTRACT_P29 §6): next to a leader whose served
 * `leader_is_provisional` is true. The seed / migration picked them (the
 * least-loaded eligible counted R&D-Greece engineer), not a person; the client
 * is asked who should lead (OQ #52). Choosing another leader clears it
 * server-side.
 */
export const PROVISIONAL_LEADER_TEXT = 'Provisional';
export const PROVISIONAL_LEADER_HINT =
  'Provisional leader: assigned by the data load, not by a person. Choose a leader to confirm one.';

export function ProvisionalLeaderBadge({ className }: { className?: string }): React.JSX.Element {
  return (
    <Badge
      tone="warning"
      className={cn('shrink-0 whitespace-nowrap rounded-pill', className)}
      title={PROVISIONAL_LEADER_HINT}
      data-testid="provisional-leader"
    >
      {PROVISIONAL_LEADER_TEXT}
      <span className="sr-only"> leader, assigned by the data load, not by a person</span>
    </Badge>
  );
}
