import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { PRIORITY_BAND_STYLES, PRIORITY_BAND_TITLE } from '@/components/shared/priority-band-meta';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

import type { DisplayCard, DisplayColumn } from '../lib/board-model';
import { BoardCard, type BoardCardProps } from './board-card';

/** Above this many cards a column is virtualized (CLAUDE.md: any list over 100). */
export const VIRTUALIZE_OVER = 100;
const ESTIMATED_CARD_HEIGHT = 150;
const CARD_GAP = 8;

type CardHandlers = Pick<
  BoardCardProps,
  'instructionsId' | 'onPointerDragStart' | 'onPointerDragEnd' | 'onHandleKeyDown' | 'onHandleBlur'
>;

export interface BoardColumnProps extends CardHandlers {
  column: DisplayColumn;
  /** Whether a given card may be dragged right now. */
  canDragCard: (item: DisplayCard) => boolean;
  /** The project id lifted by the keyboard, if any. */
  liftedId: string | null;
  /** This column is the current drop target (pointer hover or keyboard target). */
  isDropTarget: boolean;
  /** A drag is in progress and this column accepts it. */
  acceptsDrop: boolean;
  onColumnDragOver: (priority: ProjectPriority, event: React.DragEvent<HTMLElement>) => void;
  onColumnDragLeave: (priority: ProjectPriority, event: React.DragEvent<HTMLElement>) => void;
  onColumnDrop: (priority: ProjectPriority, event: React.DragEvent<HTMLElement>) => void;
}

function CardSlot({
  item,
  props,
}: {
  item: DisplayCard;
  props: BoardColumnProps;
}): React.JSX.Element {
  return (
    <BoardCard
      item={item}
      draggable={props.canDragCard(item)}
      lifted={props.liftedId === item.card.project_id}
      instructionsId={props.instructionsId}
      onPointerDragStart={props.onPointerDragStart}
      onPointerDragEnd={props.onPointerDragEnd}
      onHandleKeyDown={props.onHandleKeyDown}
      onHandleBlur={props.onHandleBlur}
    />
  );
}

function VirtualCards({ props, scrollRef }: { props: BoardColumnProps; scrollRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const cards = props.column.cards;
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT + CARD_GAP,
    getItemKey: (index) => cards[index]?.card.project_id ?? index,
    overscan: 6,
  });
  return (
    <ul
      aria-label={`${props.column.priority} projects`}
      style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      data-virtualized="true"
    >
      {virtualizer.getVirtualItems().map((v) => {
        const item = cards[v.index];
        if (!item) return null;
        return (
          <li
            key={item.card.project_id}
            data-index={v.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${String(v.start)}px)`, paddingBottom: CARD_GAP }}
          >
            <CardSlot item={item} props={props} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One priority column. The header count is the served `count` (I9); during an
 * optimistic move it can differ from the cards shown by one until the board is
 * refetched, which is honest: the server has not counted the move yet.
 */
export function BoardColumn(props: BoardColumnProps): React.JSX.Element {
  const { column, isDropTarget, acceptsDrop } = props;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const headingId = React.useId();
  const style = PRIORITY_BAND_STYLES[column.priority];

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'flex min-w-[15rem] flex-col rounded-dash border-[1.5px] bg-surface-sunken/60 transition-colors',
        isDropTarget ? 'border-primary bg-primary-subtle/40' : acceptsDrop ? 'border-dashed border-primary/50' : 'border-dash-hairline',
      )}
      data-testid="board-column"
      data-priority={column.priority}
      data-drop-target={isDropTarget ? 'true' : undefined}
      onDragOver={(e) => props.onColumnDragOver(column.priority, e)}
      onDragLeave={(e) => props.onColumnDragLeave(column.priority, e)}
      onDrop={(e) => props.onColumnDrop(column.priority, e)}
    >
      <header className="flex items-center justify-between gap-2 border-b border-dash-hairline px-3 py-2">
        <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-bold text-text" title={PRIORITY_BAND_TITLE[column.priority]}>
          <span className={cn('size-2 rounded-full', style.dot)} aria-hidden="true" />
          {column.priority === 'Q' ? 'Q — queue' : column.priority}
        </h2>
        <span
          className="rounded-pill bg-surface px-2 py-0.5 font-mono text-2xs font-semibold tabular-nums text-text-muted"
          data-numeric=""
          data-testid="board-column-count"
          aria-label={`${formatInteger(column.count)} projects`}
        >
          {formatInteger(column.count)}
        </span>
      </header>
      <div ref={scrollRef} className="max-h-[calc(100vh-15rem)] min-h-[8rem] flex-1 overflow-y-auto p-2 scrollbar-thin">
        {column.cards.length === 0 ? (
          <p className="px-1 py-6 text-center text-2xs text-text-subtle">No projects</p>
        ) : column.cards.length > VIRTUALIZE_OVER ? (
          <VirtualCards props={props} scrollRef={scrollRef} />
        ) : (
          <ul aria-label={`${column.priority} projects`} className="flex flex-col gap-2" data-virtualized="false">
            {column.cards.map((item) => (
              <li key={item.card.project_id}>
                <CardSlot item={item} props={props} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
