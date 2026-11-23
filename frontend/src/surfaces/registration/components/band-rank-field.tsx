import * as React from 'react';

import type { PriorityMoveApi } from '@/components/shared/priority-move/priority-move-context';
import { BandRankInput } from '@/surfaces/priority-board/components/band-rank-controls';
import { GlobalRankMarker } from '@/components/shared/global-rank-marker';
import { hubRankScope, rankTooltip } from '@/lib/hub-rank';
import type { ProjectPriority } from '@/types/enums';

import { RANK_WHEN_SAVED, useRequestBandRank } from './band-rank-request';

/**
 * P54 (ADR 0064): change a project's rank inside its priority band from
 * Project Registration — the register's Rank column and the edit form's
 * "Rank in P1: n of m". The same typed input as the Priority board
 * (`BandRankInput`) and the same request. P60 (ADR 0068): the rank shown and
 * edited is the HUB rank, sent as `{ hub_rank }` (the global rank is on hover), through the page's shared priority-move host, which opens the
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
  scope,
  tooltip = null,
}: {
  host: PriorityMoveApi | null;
  canMove: boolean;
  projectId: string;
  projectName: string;
  status: string | null;
  band: ProjectPriority;
  /** P60 (ADR 0068): the served HUB rank. */
  rank: number;
  dense?: boolean;
  /** P60: "PD-India · P1" — where the hub rank counts. */
  scope?: string;
  /** P60: the served rank tooltip (hub line, plus the global line without a hub filter). */
  tooltip?: string | null;
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
      <span
        className="font-mono text-2xs font-semibold tabular-nums text-text"
        data-numeric=""
        data-testid="band-rank-readonly"
        title={tooltip ?? undefined}
      >
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
      {...(scope ? { scope } : {})}
      tooltip={tooltip}
      onSubmit={(toRank) => {
        setPending(true);
        request(
          { projectId, projectName, priority: band, status },
          rank,
          toRank,
          () => {
            if (mounted.current) setPending(false);
          },
          scope,
        );
      }}
    />
  );
}

/**
 * ADR 0064 R3: the form's line next to Priority. Edit mode with the saved band
 * unchanged: "Rank in P1: 3 of 42" with the input. P60 (ADR 0068): the hub
 * rank, "Rank in PD-India · P1: 3 of 12", the global rank on hover and "G16". A new project, or a band
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
  hub = null,
  globalRank = null,
  globalSize = null,
  hubFiltered = false,
}: {
  mode: 'create' | 'edit';
  savedPriority: ProjectPriority | null;
  chosenPriority: ProjectPriority | null;
  projectId: string | null;
  projectName: string;
  status: string | null;
  /** P60 (ADR 0068): the served `hub_rank` / `hub_band_size`. */
  rank: number | null;
  size: number | null;
  host: PriorityMoveApi | null;
  canMove: boolean;
  /** P60: the hub name, for "PD-India · P1". */
  hub?: string | null;
  /** P60: the served global `band_rank` / `band_size` (hover + "G16"). */
  globalRank?: number | null;
  globalSize?: number | null;
  /** P60: a hub filter is active on the screen — the hub rank only. */
  hubFiltered?: boolean;
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
  const scope = hubRankScope(hub, chosenPriority);
  const tooltip = rankTooltip(
    { priority: chosenPriority, hub, hub_rank: rank, hub_band_size: size, band_rank: globalRank, band_size: globalSize },
    hubFiltered,
  );
  return (
    <div className="flex items-center gap-2 text-2xs text-text-muted" data-testid="reg-band-rank" title={tooltip ?? undefined}>
      <span>Rank in {scope}:</span>
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
            scope={scope}
            tooltip={tooltip}
          />
          {size !== null ? (
            <span className="tabular-nums" data-numeric="">
              of {size}
            </span>
          ) : null}
          <GlobalRankMarker bandRank={globalRank} hidden={hubFiltered} />
        </>
      )}
    </div>
  );
}
