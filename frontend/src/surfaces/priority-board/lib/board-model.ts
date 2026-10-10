import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import type { PriorityBoardCard, PriorityBoardColumn } from '../api';

/**
 * Presentation-only helpers for the Priority board (ADR 0018). Grouping,
 * order and counts are served; these only place a card the user just dropped
 * (optimistically, until the server answers) and say which columns a card may
 * be dropped on. Nothing here scores, ranks or schedules.
 */

/** A card shown in a column other than its served one, while its move is confirmed / submitted / refetched. */
export type BoardOverrides = Readonly<Record<string, ProjectPriority>>;

export interface DisplayCard {
  card: PriorityBoardCard;
  /** The column the server put the card in. */
  servedPriority: ProjectPriority;
  /** True while the card sits in a column the server has not confirmed yet. */
  pending: boolean;
}

export interface DisplayColumn {
  priority: ProjectPriority;
  /** The served count — never recounted in the browser (I9). */
  count: number;
  cards: DisplayCard[];
}

/**
 * The served columns with any optimistic moves applied: a moved card leaves its
 * served column and is shown first in its target column, marked pending. The
 * served order of every other card is untouched.
 */
export function applyOverrides(columns: readonly PriorityBoardColumn[], overrides: BoardOverrides): DisplayColumn[] {
  const moved: Partial<Record<ProjectPriority, DisplayCard[]>> = {};
  for (const column of columns) {
    for (const card of column.cards) {
      const to = overrides[card.project_id];
      if (to && to !== column.priority) {
        (moved[to] ??= []).push({ card, servedPriority: column.priority, pending: true });
      }
    }
  }
  return columns.map((column) => {
    const kept: DisplayCard[] = [];
    for (const card of column.cards) {
      const to = overrides[card.project_id];
      if (to && to !== column.priority) continue;
      kept.push({ card, servedPriority: column.priority, pending: false });
    }
    return { priority: column.priority, count: column.count, cards: [...(moved[column.priority] ?? []), ...kept] };
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
