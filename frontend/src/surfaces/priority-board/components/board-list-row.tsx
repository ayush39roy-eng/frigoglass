import * as React from 'react';
import { Link } from 'react-router-dom';
import { GripVertical, Loader2, Lock } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { DisplayCard } from '../lib/board-model';
import { BoardScenarioContext } from '../lib/board-scenario';
import type { BoardCardProps } from './board-card';

export interface BoardListRowProps extends Omit<BoardCardProps, 'item'> {
  item: DisplayCard;
  /** 1-based position in the column, in the served order. */
  position: number;
}

/**
 * P21-T05 list layout: one fixed 46 px row per project, the name over up to two lines
 * (`line-clamp-2`), rank and handle top-aligned. The same drag
 * handle (pointer and keyboard) and the same handlers as the card, so a move
 * from a row goes through the same preview → confirm flow. The name links to
 * the Project Workspace, like the card; the full name is the link text (the
 * clamp is visual only) and the tooltip. The board card serves no project code,
 * so there is no second identifier to show.
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
}: BoardListRowProps): React.JSX.Element {
  const { card, servedPriority, pending } = item;
  const locked = card.hard_gated && servedPriority === 'P1';
  const staged = React.useContext(BoardScenarioContext).has(card.project_id);
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
      <span className="mt-1 w-6 shrink-0 text-right font-mono text-2xs tabular-nums text-text-muted" aria-hidden="true">
        {position}
      </span>
      {draggable ? (
        <button
          type="button"
          className="grid size-6 shrink-0 place-items-center rounded-sm text-text-muted hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Move ${card.name} to another priority column`}
          aria-describedby={instructionsId}
          aria-pressed={lifted}
          data-testid="board-drag-handle"
          onKeyDown={(e) => onHandleKeyDown(item, e)}
          onBlur={() => onHandleBlur(item)}
        >
          <GripVertical className="size-3.5" aria-hidden="true" />
        </button>
      ) : locked ? (
        <span className="grid size-6 shrink-0 place-items-center text-text-muted" title="Hard gate: this project must stay P1">
          <Lock className="size-3" aria-hidden="true" />
          <span className="sr-only">Hard gate: stays P1</span>
        </span>
      ) : (
        <span className="size-6 shrink-0" aria-hidden="true" />
      )}
      <Link
        to={`/projects/${card.project_id}`}
        className="line-clamp-2 min-w-0 flex-1 break-words rounded-sm text-left leading-[1.25rem] text-text underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={card.name}
      >
        {card.name}
      </Link>
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
