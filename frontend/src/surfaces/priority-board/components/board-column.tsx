import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { PRIORITY_BAND_STYLES, PRIORITY_BAND_TITLE } from '@/components/shared/priority-band-meta';
import { formatDecimal, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

import type { DisplayCard, DisplayColumn } from '../lib/board-model';
import type { BoardLayout } from '../lib/board-layout';
import { BoardCard, type BoardCardProps } from './board-card';
import { BoardListRow } from './board-list-row';

/** Above this many cards a column is virtualized (CLAUDE.md: any list over 100). */
export const VIRTUALIZE_OVER = 100;
const ESTIMATED_CARD_HEIGHT = 150;
const CARD_GAP = 8;
/** P21-T05 list layout: fixed 46 px two-line rows, 2 px apart (fixed, so the virtualizer's
 *  estimate is exact and nothing is measured). */
const LIST_ROW_HEIGHT = 46;
const LIST_GAP = 2;

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
  /** P21-T05: cards (default) or the compact name list. */
  layout?: BoardLayout;
  /** The board has a fixed height (inside the Matrix): the column fills it and its body scrolls. */
  fit?: boolean;
}

function CardSlot({
  item,
  props,
  position,
}: {
  item: DisplayCard;
  props: BoardColumnProps;
  position: number;
}): React.JSX.Element {
  if (props.layout === 'list') {
    return (
      <BoardListRow
        item={item}
        position={position}
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
  const list = props.layout === 'list';
  const gap = list ? LIST_GAP : CARD_GAP;
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (list ? LIST_ROW_HEIGHT : ESTIMATED_CARD_HEIGHT) + gap,
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
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${String(v.start)}px)`, paddingBottom: gap }}
          >
            <CardSlot item={item} props={props} position={v.index + 1} />
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
        props.fit && 'h-full min-h-0',
        isDropTarget ? 'border-primary bg-primary-subtle/40' : acceptsDrop ? 'border-dashed border-primary/50' : 'border-dash-hairline',
      )}
      data-testid="board-column"
      data-priority={column.priority}
      data-drop-target={isDropTarget ? 'true' : undefined}
      onDragOver={(e) => props.onColumnDragOver(column.priority, e)}
      onDragLeave={(e) => props.onColumnDragLeave(column.priority, e)}
      onDrop={(e) => props.onColumnDrop(column.priority, e)}
    >
      {/* The header sits outside the scrolling body, so it stays visible while the column scrolls. */}
      <header
        className="sticky top-0 z-[1] flex shrink-0 items-start justify-between gap-2 rounded-t-dash border-b border-dash-hairline bg-surface-sunken px-3 py-2"
        data-testid="board-column-header"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-bold text-text" title={PRIORITY_BAND_TITLE[column.priority]}>
            <span className={cn('size-2 rounded-full', style.dot)} aria-hidden="true" />
            {column.priority === 'Q' ? 'Q — queue' : column.priority}
          </h2>
          {/* P13-T12: the served REMAINING design / lab work of this column from
              the current week (not the total planned load, so it is not the
              Capacity surface's load figure). Never summed from the cards (I9). */}
          <p
            className="font-mono text-2xs tabular-nums text-text-muted"
            data-numeric=""
            data-testid="board-column-weeks"
            title="Remaining design and lab work from the current week, in weeks"
          >
            Remaining <abbr title="design">D</abbr> {formatDecimal(column.design_weeks)} w
            <span aria-hidden="true"> · </span>
            <abbr title="lab">L</abbr> {formatDecimal(column.lab_weeks)} w
          </p>
        </div>
        <span
          className="rounded-pill bg-surface px-2 py-0.5 font-mono text-2xs font-semibold tabular-nums text-text-muted"
          data-numeric=""
          data-testid="board-column-count"
          aria-label={`${formatInteger(column.count)} projects`}
        >
          {formatInteger(column.count)}
        </span>
      </header>
      <div ref={scrollRef} className={cn(
          'flex-1 overflow-y-auto scrollbar-thin',
          props.fit ? 'min-h-0' : 'max-h-[calc(100vh-15rem)] min-h-[8rem]',
          props.layout === 'list' ? 'p-1' : 'p-2',
        )}
        data-testid="board-column-body">
        {column.cards.length === 0 ? (
          <p className="px-1 py-6 text-center text-2xs text-text-subtle">No projects</p>
        ) : column.cards.length > VIRTUALIZE_OVER ? (
          <VirtualCards props={props} scrollRef={scrollRef} />
        ) : (
          <ul
            aria-label={`${column.priority} projects`}
            className={cn('flex flex-col', props.layout === 'list' ? 'gap-0.5' : 'gap-2')}
            data-virtualized="false"
          >
            {column.cards.map((item, i) => (
              <li key={item.card.project_id}>
                <CardSlot item={item} props={props} position={i + 1} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
