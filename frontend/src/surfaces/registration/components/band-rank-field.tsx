import * as React from 'react';

import type { PriorityMoveApi } from '@/components/shared/priority-move/priority-move-context';
import { BandRankInput } from '@/surfaces/priority-board/components/band-rank-controls';
import type { ProjectPriority } from '@/types/enums';

import { RANK_WHEN_SAVED, useRequestBandRank } from './band-rank-request';

/**
 * P54 (ADR 0064): change a project's rank inside its priority band from
 * Project Registration — the register's Rank column and the edit form's
 * "Rank in P1: n of m". The same typed input as the Priority board
 * (`BandRankInput`) and the same request: `{ to_rank }` (the target position in
 * the FULL band) through the page's shared priority-move host, which opens the
 * preview side panel; Confirm applies and recalculates, exactly as on the
 * board (P47 conflicts and the P49 reload hold live in that shared flow). The
 * server resolves the position and answers 422 `BAD_RANK` past the end.
 */

/**
 * The served rank as the board's input; `pending` from the request until the
 * flow settles. Read-only text when the caller may not move priorities.
 */
export function EditableBandRank({
  host,
  canMove,
  projectId,
  projectName,
  status,
  band,
  rank,
  dense = false,
}: {
  host: PriorityMoveApi | null;
  canMove: boolean;
  projectId: string;
  projectName: string;
  status: string | null;
  band: ProjectPriority;
  rank: number;
  dense?: boolean;
}): React.JSX.Element {
  const request = useRequestBandRank(host);
  const [pending, setPending] = React.useState(false);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (!canMove || host === null) {
    return (
      <span className="font-mono text-2xs font-semibold tabular-nums text-text" data-numeric="" data-testid="band-rank-readonly">
        {rank}
      </span>
    );
  }
  return (
    <BandRankInput
      name={projectName}
      band={band}
      rank={rank}
      inert={host.busy}
      pending={pending}
      dense={dense}
      onSubmit={(toRank) => {
        setPending(true);
        request({ projectId, projectName, priority: band, status }, rank, toRank, () => {
          if (mounted.current) setPending(false);
        });
      }}
    />
  );
}

/**
 * ADR 0064 R3: the form's line next to Priority. Edit mode with the saved band
 * unchanged: "Rank in P1: 3 of 42" with the input. A new project, or a band
 * changed in the unsaved form: "Ranked last in its band when saved", input
 * disabled. Nothing without a chosen band.
 */
export function BandRankField({
  mode,
  savedPriority,
  chosenPriority,
  projectId,
  projectName,
  status,
  rank,
  size,
  host,
  canMove,
}: {
  mode: 'create' | 'edit';
  savedPriority: ProjectPriority | null;
  chosenPriority: ProjectPriority | null;
  projectId: string | null;
  projectName: string;
  status: string | null;
  rank: number | null;
  size: number | null;
  host: PriorityMoveApi | null;
  canMove: boolean;
}): React.JSX.Element | null {
  if (chosenPriority === null) return null;
  const unsaved = mode === 'create' || projectId === null || chosenPriority !== savedPriority;
  if (unsaved) {
    return (
      <div className="flex items-center gap-2 text-2xs text-text-muted" data-testid="reg-band-rank">
        <input
          type="text"
          disabled
          value="—"
          aria-label={`Position in ${chosenPriority} (set when saved)`}
          className="h-5 w-10 cursor-not-allowed rounded-sm bg-surface-sunken pr-1 text-right font-mono text-2xs text-text-subtle opacity-60 ring-1 ring-inset ring-border-strong/50"
          data-testid="reg-band-rank-disabled"
        />
        <span>{RANK_WHEN_SAVED}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-2xs text-text-muted" data-testid="reg-band-rank">
      <span>Rank in {chosenPriority}:</span>
      {rank === null ? (
        <span className="text-text-subtle">—</span>
      ) : (
        <>
          <EditableBandRank
            host={host}
            canMove={canMove}
            projectId={projectId}
            projectName={projectName}
            status={status}
            band={chosenPriority}
            rank={rank}
          />
          {size !== null ? (
            <span className="tabular-nums" data-numeric="">
              of {size}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}
