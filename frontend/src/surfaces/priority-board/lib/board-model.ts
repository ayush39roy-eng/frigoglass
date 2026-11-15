import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import type { BandRankPlacement, PriorityBoardCard, PriorityBoardColumn } from '../api';

/**
 * Presentation-only helpers for the Priority board (ADR 0018, ADR 0050). Grouping,
 * order, counts and `band_rank` are served; these only place a card the user just
 * dropped (optimistically, until the server answers), say which columns a card
 * may be dropped on, and turn a drop slot into the relative placement the server
 * takes. Nothing here scores, ranks or schedules: the server decides the rank.
 */

/**
 * A card shown somewhere other than its served place, while its move is
 * confirmed / submitted / refetched: in another column (a priority move, shown
 * last there, R36-8) or, with `placement`, at a new place in its own column
 * (a P36 re-rank).
 */
export interface BoardOverride {
  priority: ProjectPriority;
  placement?: BandRankPlacement;
}

export type BoardOverrides = Readonly<Record<string, BoardOverride>>;

export interface DisplayCard {
  card: PriorityBoardCard;
  /** The column the server put the card in. */
  servedPriority: ProjectPriority;
  /** True while the card sits where the server has not confirmed yet. */
  pending: boolean;
}

export interface DisplayColumn {
  priority: ProjectPriority;
  /** The served count — never recounted in the browser (I9). */
  count: number;
  /** P13-T12: served remaining design / lab weeks — never summed from cards. */
  design_weeks: number;
  lab_weeks: number;
  cards: DisplayCard[];
}

/** Insert `item` before / after its anchor among `cards`; at the end when the anchor is not shown. */
function place(cards: DisplayCard[], item: DisplayCard, placement: BandRankPlacement): DisplayCard[] {
  const anchorId = placement.before_project_id ?? placement.after_project_id;
  const index = anchorId === null ? -1 : cards.findIndex((c) => c.card.project_id === anchorId);
  if (index < 0) return [...cards, item];
  const at = placement.before_project_id !== null ? index : index + 1;
  return [...cards.slice(0, at), item, ...cards.slice(at)];
}

/**
 * The served columns with any optimistic moves applied. A card moved to another
 * column leaves its served column and is shown LAST in the target, as the server
 * will place it (R36-8); a re-ranked card is shown at its new place in its own
 * column. Both are marked pending. The served order of every other card is untouched.
 */
export function applyOverrides(columns: readonly PriorityBoardColumn[], overrides: BoardOverrides): DisplayColumn[] {
  const moved: Partial<Record<ProjectPriority, DisplayCard[]>> = {};
  for (const column of columns) {
    for (const card of column.cards) {
      const o = overrides[card.project_id];
      if (o && o.priority !== column.priority) {
        (moved[o.priority] ??= []).push({ card, servedPriority: column.priority, pending: true });
      }
    }
  }
  return columns.map((column) => {
    let kept: DisplayCard[] = [];
    const reranked: { item: DisplayCard; placement: BandRankPlacement }[] = [];
    for (const card of column.cards) {
      const o = overrides[card.project_id];
      if (o && o.priority !== column.priority) continue;
      if (o?.placement) {
        reranked.push({ item: { card, servedPriority: column.priority, pending: true }, placement: o.placement });
        continue;
      }
      kept.push({ card, servedPriority: column.priority, pending: false });
    }
    for (const { item, placement } of reranked) kept = place(kept, item, placement);
    return {
      priority: column.priority,
      count: column.count,
      design_weeks: column.design_weeks,
      lab_weeks: column.lab_weeks,
      cards: [...kept, ...(moved[column.priority] ?? [])],
    };
  });
}

/**
 * The columns a card may be dropped on. A hard-gated project is pinned to P1
 * (ADR 0018 §4, 409 `HARD_GATE_FORCES_P1`): from P1 it cannot move at all,
 * and from anywhere else it may only go to P1.
 */
export function allowedTargets(card: Pick<PriorityBoardCard, 'hard_gated'>, from: ProjectPriority): ProjectPriority[] {
  if (card.hard_gated) return from === 'P1' ? [] : ['P1'];
  return PROJECT_PRIORITIES.filter((p) => p !== from);
}

/**
 * P36 (ADR 0050): the card may be reordered inside its column — it carries a
 * served `band_rank` (every schedulable project with a priority does). A
 * hard-gated P1 project may be re-ranked within P1 (R36-10).
 */
export function canRerank(card: Pick<PriorityBoardCard, 'band_rank'>): boolean {
  return typeof card.band_rank === 'number';
}

/** The next column left (-1) or right (+1) of `current` among `from` and its allowed targets, for the keyboard drag. */
export function stepTarget(
  current: ProjectPriority,
  from: ProjectPriority,
  allowed: readonly ProjectPriority[],
  direction: -1 | 1,
): ProjectPriority {
  const options = PROJECT_PRIORITIES.filter((p) => p === from || allowed.includes(p));
  const index = options.indexOf(current);
  const next = options[index + direction];
  return next ?? current;
}

// ---- P36: drop slots inside a column -------------------------------------------------------

/**
 * A drop slot is a gap in the column as shown (the dragged card included):
 * slot `s` is just above the card at index `s`; slot `cards.length` is below
 * the last card. A slot right above or right below the dragged card is no move.
 */
export function isNoopSlot(slot: number, draggedIndex: number): boolean {
  return slot === draggedIndex || slot === draggedIndex + 1;
}

/**
 * The relative placement for a slot (D36-2, R36-8): above card X → `before X`;
 * below the last visible card → `after` it, so a drop on a filtered board lands
 * right after that card instead of jumping past hidden ones. `null` = no move.
 */
export function placementForSlot(cards: readonly DisplayCard[], slot: number, draggedId: string): BandRankPlacement | null {
  const draggedIndex = cards.findIndex((c) => c.card.project_id === draggedId);
  if (draggedIndex < 0 || slot < 0 || slot > cards.length || isNoopSlot(slot, draggedIndex)) return null;
  const below = cards[slot];
  if (below) return { before_project_id: below.card.project_id, after_project_id: null };
  const last = cards[cards.length - 1];
  return last ? { before_project_id: null, after_project_id: last.card.project_id } : null;
}

/**
 * The keyboard's position (the index the card would hold among the visible
 * cards, 0-based) as a slot of the column as shown.
 */
export function slotForIndex(index: number, draggedIndex: number): number {
  return index > draggedIndex ? index + 1 : index;
}

/**
 * The 1-based position the placement means in the FULL band, for the dialog and
 * announcement copy only: read off the served `band_rank` of the card and its
 * anchor (the band closes the gap the card leaves). The server decides the rank
 * written; this never feeds anything back. Null when a rank is not served.
 */
export function positionForPlacement(cards: readonly DisplayCard[], draggedId: string, placement: BandRankPlacement): number | null {
  const own = cards.find((c) => c.card.project_id === draggedId)?.card.band_rank ?? null;
  const anchorId = placement.before_project_id ?? placement.after_project_id;
  const anchor = cards.find((c) => c.card.project_id === anchorId)?.card.band_rank ?? null;
  if (own === null || anchor === null) return null;
  if (placement.before_project_id !== null) return anchor > own ? anchor - 1 : anchor;
  return anchor < own ? anchor + 1 : anchor;
}

/** P36: the drag handle's accessible name — a hard-gated P1 card can only be reordered within P1. */
export function handleLabel(name: string, locked: boolean): string {
  return locked ? `Reorder ${name} within P1` : `Move ${name} within or between priority columns`;
}
