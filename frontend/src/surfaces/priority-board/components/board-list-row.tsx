import * as React from 'react';
import { Link } from 'react-router-dom';
import { GripVertical, Loader2, Snowflake } from 'lucide-react';

import { PRIORITY_BAND_TITLE } from '@/components/shared/priority-band-meta';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { calculatedBandText } from '@/components/shared/suggested-band-chip';
import { cn } from '@/lib/utils';

import { BoardScenarioContext } from '../lib/board-scenario';
import { handleLabel, type DisplayCard } from '../lib/board-model';
import type { BoardCardProps } from './board-card';
import { HardGateLock } from './board-badges';
import { BandRankInput, BandRankStepButtons } from './band-rank-controls';
import { BoardSelectCheckbox } from './board-bulk-move';

export interface BoardListRowProps extends Omit<BoardCardProps, 'item'> {
  item: DisplayCard;
  /** 1-based visible index in the column — shown only when no `band_rank` is served (P36). */
  position: number;
}

/**
 * P21-T05 list layout: one fixed 46 px row per project, the name over up to two lines
 * (`line-clamp-2`), rank and handle top-aligned. The same drag
 * handle (pointer and keyboard) and the same handlers as the card, so a move
 * from a row goes through the same preview → confirm flow. The name links to
 * the Project Workspace, like the card; the full name is the link text (the
 * clamp is visual only) and the tooltip. P25-T03: the served `external_code` (when
 * present) is the second line. P59: the set priority sits on the right; the score's
 * calculated band is its tooltip.
 */
export const BoardListRow = React.memo(function BoardListRow({
  item,
  position,
  draggable,
  lifted,
  instructionsId,
  onPointerDragStart,
  onPointerDragEnd,
  onHandleKeyDown,
  onHandleBlur,
  rankable = false,
  rankInert = false,
  knownLast = false,
  onRankTo,
}: BoardListRowProps): React.JSX.Element {
  const { card, servedPriority, pending } = item;
  const locked = card.hard_gated && servedPriority === 'P1';
  const staged = React.useContext(BoardScenarioContext).has(card.project_id);
  // P25-T03: with a served external code, the name takes one line and the code the second (it
  // tells apart names with a shared prefix); without one, the name keeps two lines.
  const code = card.external_code ?? null;
  const calculated = calculatedBandText(card.suggested_band ?? card.band, {
    capacityFill: card.capacity_fill,
    scoreBand: card.score_band,
  });
  const rank = card.band_rank ?? null;
  const rankControls = rankable && rank !== null && onRankTo !== undefined;
  const rankTo = React.useCallback((toRank: number) => onRankTo?.(item, toRank), [item, onRankTo]);
  return (
    <div
      className={cn(
        'flex h-[46px] items-start gap-1 rounded border border-transparent bg-surface px-1 py-1 text-xs',
        draggable && 'cursor-grab active:cursor-grabbing',
        lifted && 'ring-2 ring-primary',
        pending && 'border-dashed border-primary',
        staged && 'border-l-2 border-l-warning',
      )}
      draggable={draggable}
      onDragStart={draggable ? (e) => onPointerDragStart(item, e) : undefined}
      onDragEnd={draggable ? onPointerDragEnd : undefined}
      data-testid="board-list-row"
      data-project-id={card.project_id}
      data-pending={pending ? 'true' : undefined}
      data-staged={staged ? 'true' : undefined}
    >
      <BoardSelectCheckbox projectId={card.project_id} projectName={card.name} className="mt-1.5" />
      {rankControls ? (
        // Owner request 2026-11-17: the position as an input in place, with ↑ / ↓ beside it.
        <>
          <BandRankInput
            name={card.name}
            band={servedPriority}
            rank={rank}
            inert={rankInert}
            pending={pending}
            onSubmit={rankTo}
            dense
            className="mt-0.5"
          />
          <BandRankStepButtons
            name={card.name}
            band={servedPriority}
            rank={rank}
            inert={rankInert || pending}
            knownLast={knownLast}
            onMove={rankTo}
            orientation="stack"
          />
        </>
      ) : (
        <>
          {/* P36 (ADR 0050): the served band_rank — the position in the whole band, which
              filters never change. While a move is pending the served rank is stale: "…". */}
          <span
            className="mt-1 w-6 shrink-0 text-right font-mono text-2xs tabular-nums text-text-muted"
            aria-hidden="true"
            data-numeric=""
            data-testid="board-list-rank"
            title={rank !== null ? `Position ${String(rank)} in ${servedPriority}: its scheduling order inside the band` : undefined}
          >
            {pending ? '…' : (rank ?? position)}
          </span>
          {rank !== null && !pending ? <span className="sr-only">{`Position ${String(rank)} in ${servedPriority}.`}</span> : null}
        </>
      )}
      {draggable ? (
        <button
          type="button"
          className="grid size-6 shrink-0 place-items-center rounded-sm text-text-muted hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={handleLabel(card.name, locked)}
          aria-describedby={instructionsId}
          aria-pressed={lifted}
          data-testid="board-drag-handle"
          onKeyDown={(e) => onHandleKeyDown(item, e)}
          onBlur={() => onHandleBlur(item)}
        >
          <GripVertical className="size-3.5" aria-hidden="true" />
        </button>
      ) : locked ? (
        <span className="grid size-6 shrink-0 place-items-center">
          <HardGateLock size="size-3" />
        </span>
      ) : (
        <span className="size-6 shrink-0" aria-hidden="true" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to={`/projects/${card.project_id}`}
          className={cn(
            'min-w-0 break-words rounded-sm text-left leading-[1.25rem] text-text underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            code ? 'line-clamp-1' : 'line-clamp-2',
          )}
          title={code ? `${card.name} (${code})` : card.name}
        >
          {card.name}
        </Link>
        {code ? (
          <span className="truncate font-mono text-2xs leading-4 text-text-muted" data-testid="board-list-code" title={code}>
            {code}
          </span>
        ) : null}
      </div>
      {card.frozen ? (
        <span className="mt-1 shrink-0 text-primary-subtle-fg" title="Frozen: dates locked; scheduled first whatever its position in the column" data-testid="board-frozen-badge">
          <Snowflake className="size-3" aria-hidden="true" />
          <span className="sr-only">Frozen</span>
        </span>
      ) : null}
      {/* P59 (owner 2026-11-23): the row shows the SET priority only; the score's
          calculated band is its hover text. */}
      <span className="mt-0.5 shrink-0" data-testid="board-list-priority">
        <PriorityBandPill
          priority={servedPriority}
          {...(calculated ? { title: `${PRIORITY_BAND_TITLE[servedPriority]}. ${calculated}` } : {})}
        />
      </span>
      {pending ? (
        <span className="inline-flex shrink-0 items-center" role="status">
          <Loader2 className="size-3 animate-spin text-text-muted motion-reduce:animate-none" aria-hidden="true" />
          <span className="sr-only">Moving from {servedPriority}</span>
        </span>
      ) : null}
      {staged ? <span className="sr-only">Score change staged in scenario</span> : null}
    </div>
  );
});
