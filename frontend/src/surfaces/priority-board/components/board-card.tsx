import * as React from 'react';
import { Link } from 'react-router-dom';
import { GripVertical, Hourglass, Loader2 } from 'lucide-react';

import { HealthChip, ProjectedFinishChip } from '@/components/shared/project-outcome-chips';
import { servedNonCountingOutcome } from '@/components/shared/schedule-outcome-meta';
import { PriorityMoveControl } from '@/components/shared/priority-move/priority-move-control';
import { TrackingStatusChip } from '@/components/shared/tracking-status-chip';
import { VipBadge } from '@/components/shared/vip-badge';
import { Badge } from '@/components/ui/badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { calculatedBandText } from '@/components/shared/suggested-band-chip';
import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

import { handleLabel, type DisplayCard } from '../lib/board-model';
import { BoardScenarioContext } from '../lib/board-scenario';
import { BandRankChip, FrozenBadge, HardGateLock } from './board-badges';
import { BandRankInput, BandRankStepButtons } from './band-rank-controls';
import { BoardSelectCheckbox } from './board-bulk-move';

export interface BoardCardProps {
  item: DisplayCard;
  /** The session may drag this card (Registration write, not busy, a target exists). */
  draggable: boolean;
  /** Keyboard "picked up" state for this card. */
  lifted: boolean;
  /** id of the shared keyboard-drag instructions, for `aria-describedby`. */
  instructionsId: string;
  onPointerDragStart: (item: DisplayCard, event: React.DragEvent<HTMLElement>) => void;
  onPointerDragEnd: () => void;
  onHandleKeyDown: (item: DisplayCard, event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onHandleBlur: (item: DisplayCard) => void;
  /** Owner request 2026-11-17: the session may re-rank this card (same permission as drag; a served `band_rank`). */
  rankable?: boolean;
  /** A move is in flight: the rank controls stay focusable but do nothing. */
  rankInert?: boolean;
  /** The board knows from served data the card is last in its full band (↓ disabled). */
  knownLast?: boolean;
  /** ↑ / ↓ / typed position → the shared preview with `to_rank`. */
  onRankTo?: ((item: DisplayCard, toRank: number) => void) | undefined;
}

/**
 * One project on the Priority board (ADR 0018). Every figure is served by
 * `GET /priority-board` from the active run (I9, I13). The card itself is not
 * interactive; it holds a drag handle (pointer and keyboard), a link to the
 * Workspace, and the shared P11 priority move control, so dragging is never
 * the only way to move a project (ADR 0018 §5). For a session that may
 * re-rank, the position chip is an input and ↑ / ↓ sit in the footer
 * (owner request 2026-11-17), both through the same preview side panel.
 */
export const BoardCard = React.memo(function BoardCard({
  item,
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
}: BoardCardProps): React.JSX.Element {
  const { card, servedPriority, pending } = item;
  const rank = card.band_rank ?? null;
  const rankControls = rankable && rank !== null && onRankTo !== undefined;
  const rankTo = React.useCallback((toRank: number) => onRankTo?.(item, toRank), [item, onRankTo]);
  const locked = card.hard_gated && servedPriority === 'P1';
  const staged = React.useContext(BoardScenarioContext).has(card.project_id);
  // P25-T03: the served suggested (promoted) band; a pre-P25-T03 API only serves `band`.
  // P59 (owner 2026-11-23): only the SET priority is drawn; the calculated band
  // is the priority control's hover text.
  const calculated = calculatedBandText(card.suggested_band ?? card.band, {
    capacityFill: card.capacity_fill,
    scoreBand: card.score_band,
  });

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-dash border-[1.5px] border-dash-hairline bg-surface p-3 shadow-dashCard',
        draggable && 'cursor-grab active:cursor-grabbing',
        lifted && 'ring-2 ring-primary ring-offset-1 ring-offset-surface',
        pending && 'border-dashed border-primary',
      )}
      draggable={draggable}
      onDragStart={draggable ? (e) => onPointerDragStart(item, e) : undefined}
      onDragEnd={draggable ? onPointerDragEnd : undefined}
      data-testid="board-card"
      data-project-id={card.project_id}
      data-pending={pending ? 'true' : undefined}
    >
      <div className="flex items-start gap-1.5">
        <BoardSelectCheckbox projectId={card.project_id} projectName={card.name} />
        {draggable ? (
          <button
            type="button"
            className="-ml-1 mt-px grid size-6 shrink-0 place-items-center rounded-sm text-text-muted transition-colors hover:bg-primary-subtle hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={handleLabel(card.name, locked)}
            aria-describedby={instructionsId}
            aria-pressed={lifted}
            data-testid="board-drag-handle"
            data-drag-handle={card.project_id}
            onKeyDown={(e) => onHandleKeyDown(item, e)}
            onBlur={() => onHandleBlur(item)}
          >
            <GripVertical className="size-4" aria-hidden="true" />
          </button>
        ) : null}
        {locked ? (
          draggable ? (
            <span className="mt-1">
              <HardGateLock size="size-3" testId="board-lock" />
            </span>
          ) : (
            <span className="-ml-1 mt-px grid size-6 shrink-0 place-items-center">
              <HardGateLock testId="board-lock" />
            </span>
          )
        ) : null}
        {rankControls ? (
          <BandRankInput
            name={card.name}
            band={servedPriority}
            rank={rank}
            inert={rankInert}
            pending={pending}
            onSubmit={rankTo}
            className="mt-0.5"
          />
        ) : rank !== null && !pending ? (
          <BandRankChip rank={rank} band={servedPriority} className="mt-0.5" />
        ) : null}
        <h3 className="min-w-0 flex-1 text-xs font-semibold leading-snug text-text">
          <Link
            to={`/projects/${card.project_id}`}
            className="line-clamp-2 rounded-sm underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`${card.name} — open in Project Workspace`}
          >
            {card.name}
          </Link>
        </h3>
        {card.frozen ? <FrozenBadge /> : null}
        {card.queued ? <QueuedBadge /> : null}
        {card.is_vip ? <VipBadge /> : null}
      </div>

      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-text-muted">
        <span>{card.hub}</span>
        {card.category ? <CategoryTag category={card.category} /> : null}
        <span aria-hidden="true">·</span>
        <span title="Weighted score: raw points out of the total weight, as the Matrix serves it. The scoring grid shows the same score out of 100.">
          Weighted score{' '}
          <span className="font-mono font-semibold tabular-nums text-text" data-numeric="" data-testid="board-card-score">
            {card.score === null ? '—' : formatDecimal(card.score)}
          </span>
        </span>
      </p>
      {staged ? (
        <p className="text-2xs font-medium text-warning-subtle-fg" data-testid="board-card-staged">
          <span className="rounded-sm bg-warning-subtle px-1.5 py-0.5">Score change staged in scenario — not applied</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        <ProjectedFinishChip
          projectedEndWeek={card.projected_end_week}
          withinYear={card.within_year}
          outcome={servedNonCountingOutcome(card)}
          outcomeLabel={card.outcome_label ?? null}
        />
        <HealthChip health={card.health} />
        <TrackingStatusChip status={card.tracking_status} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-dash-hairline pt-2">
        {pending ? (
          <span className="inline-flex items-center gap-1 text-2xs font-medium text-text-muted" role="status">
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Moving from {servedPriority}…
          </span>
        ) : (
          <span className="text-2xs text-text-subtle">{card.status}</span>
        )}
        <span className="flex items-center gap-1">
          {rankControls ? (
            <BandRankStepButtons
              name={card.name}
              band={servedPriority}
              rank={rank}
              inert={rankInert || pending}
              knownLast={knownLast}
              onMove={rankTo}
            />
          ) : null}
          {/* P58 (owner bug 2026-11-23): the set priority is labelled, next to its control. */}
          <span className="text-2xs text-text-subtle" aria-hidden="true" data-testid="board-card-priority-label">
            Priority
          </span>
          <PriorityMoveControl
            projectId={card.project_id}
            projectName={card.name}
            priority={servedPriority}
            status={card.status}
            hint={calculated}
          />
        </span>
      </div>
    </div>
  );
});

/**
 * P42 (R42-7): a P3 still in queue. The board keeps rank order, but the
 * scheduler places every started P3 before every queued one, with spare
 * capacity only — this badge is what tells them apart. Served (`card.queued`).
 */
function QueuedBadge(): React.JSX.Element {
  return (
    <Badge
      tone="primary"
      className="shrink-0"
      title="Queued: planned only with spare capacity, after every started project. Not counted this year."
      data-testid="board-card-queued"
    >
      <Hourglass aria-hidden="true" />
      Queued
    </Badge>
  );
}
