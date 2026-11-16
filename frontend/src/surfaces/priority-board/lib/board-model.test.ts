import { describe, expect, it } from 'vitest';

import type { PriorityBoardCard, PriorityBoardColumn } from '../api';
import {
  applyOverrides,
  canRerank,
  displayPlacementForRank,
  isNoopSlot,
  lastServedIdIfFullBand,
  parseTypedRank,
  placementForSlot,
  positionForPlacement,
  slotForIndex,
  type DisplayCard,
} from './board-model';

function card(id: string, band_rank: number | null): PriorityBoardCard {
  return {
    project_id: id, name: id, hub_id: 'h', hub: 'R&D-Greece', category: 'A', status: 'In Queue', external_code: null,
    score: null, band: null, suggested_band: null, score_band: null, capacity_fill: false, capacity_fill_reason: null,
    hard_gated: false, is_vip: false, projected_end_week: null, within_year: null, health: null, tracking_status: 'live',
    band_rank, frozen: false,
  };
}

function col(priority: 'P1' | 'P2', ids: [string, number | null][]): PriorityBoardColumn {
  return { priority, count: ids.length, design_weeks: 0, lab_weeks: 0, cards: ids.map(([id, r]) => card(id, r)) };
}

function shown(ids: [string, number | null][]): DisplayCard[] {
  return ids.map(([id, r]) => ({ card: card(id, r), servedPriority: 'P1', pending: false }));
}

const P1 = col('P1', [['a', 1], ['b', 2], ['c', 3]]);
const P2 = col('P2', [['x', 1]]);

describe('P36 board-model', () => {
  it('a re-ranked card is placed before / after its anchor and marked pending; the rest keep served order', () => {
    const [p1] = applyOverrides([P1, P2], { c: { priority: 'P1', placement: { before_project_id: 'a', after_project_id: null } } });
    expect(p1?.cards.map((c) => [c.card.project_id, c.pending])).toEqual([['c', true], ['a', false], ['b', false]]);
    const [q1] = applyOverrides([P1], { a: { priority: 'P1', placement: { before_project_id: null, after_project_id: 'c' } } });
    expect(q1?.cards.map((c) => c.card.project_id)).toEqual(['b', 'c', 'a']);
    expect(q1?.count).toBe(3);
  });

  it('a cross-column move shows the card LAST in the target (R36-8)', () => {
    const [p1, p2] = applyOverrides([P1, P2], { a: { priority: 'P2' } });
    expect(p1?.cards.map((c) => c.card.project_id)).toEqual(['b', 'c']);
    expect(p2?.cards.map((c) => [c.card.project_id, c.pending])).toEqual([['x', false], ['a', true]]);
  });

  it('an anchor no longer shown puts the card last rather than losing it', () => {
    const [p1] = applyOverrides([P1], { a: { priority: 'P1', placement: { before_project_id: 'gone', after_project_id: null } } });
    expect(p1?.cards.map((c) => c.card.project_id)).toEqual(['b', 'c', 'a']);
  });

  it('slots: above card X → before X; below the last → after it; next to the dragged card → no move', () => {
    const cards = shown([['a', 1], ['b', 2], ['c', 3]]);
    expect(placementForSlot(cards, 0, 'c')).toEqual({ before_project_id: 'a', after_project_id: null });
    expect(placementForSlot(cards, 3, 'a')).toEqual({ before_project_id: null, after_project_id: 'c' });
    expect(placementForSlot(cards, 1, 'b')).toBeNull();
    expect(placementForSlot(cards, 2, 'b')).toBeNull();
    expect(placementForSlot(cards, 3, 'c')).toBeNull();
    expect(placementForSlot(cards, 9, 'a')).toBeNull();
    expect(isNoopSlot(2, 1)).toBe(true);
    expect(isNoopSlot(0, 1)).toBe(false);
  });

  it('keyboard index → slot skips the dragged card', () => {
    expect(slotForIndex(0, 2)).toBe(0);
    expect(slotForIndex(2, 0)).toBe(3);
    expect(slotForIndex(1, 1)).toBe(1);
  });

  it('display position comes from the served band_rank of card and anchor (filtered band)', () => {
    const cards = shown([['a', 1], ['e', 5], ['i', 9]]);
    expect(positionForPlacement(cards, 'i', { before_project_id: 'e', after_project_id: null })).toBe(5);
    expect(positionForPlacement(cards, 'a', { before_project_id: 'i', after_project_id: null })).toBe(8);
    expect(positionForPlacement(cards, 'a', { before_project_id: null, after_project_id: 'i' })).toBe(9);
    expect(positionForPlacement(cards, 'i', { before_project_id: null, after_project_id: 'a' })).toBe(2);
    expect(positionForPlacement(shown([['a', null], ['b', 2]]), 'a', { before_project_id: null, after_project_id: 'b' })).toBeNull();
  });

  it('only a card with a served band_rank can be re-ranked', () => {
    expect(canRerank(card('a', 3))).toBe(true);
    expect(canRerank(card('a', null))).toBe(false);
  });
});

describe('owner request 2026-11-17: ↑ / ↓ / typed position helpers', () => {
  it('displayPlacementForRank: next to the visible holder of the target rank, else null (stays put)', () => {
    const cards = shown([['a', 4], ['b', 7], ['c', 9]]);
    expect(displayPlacementForRank(cards, 'c', 7)).toEqual({ before_project_id: 'b', after_project_id: null });
    expect(displayPlacementForRank(cards, 'a', 7)).toEqual({ before_project_id: null, after_project_id: 'b' });
    expect(displayPlacementForRank(cards, 'a', 5)).toBeNull(); // rank 5 is not shown (filtered / out of scope)
    expect(displayPlacementForRank(cards, 'a', 4)).toBeNull();
    expect(displayPlacementForRank(shown([['a', null], ['b', 1]]), 'a', 1)).toBeNull();
  });

  it('lastServedIdIfFullBand: the served last card only when the whole band is shown', () => {
    const column = col('P1', [['a', 1], ['b', 2]]);
    expect(lastServedIdIfFullBand(column, true)).toBe('b');
    expect(lastServedIdIfFullBand(column, false)).toBeNull();
    expect(lastServedIdIfFullBand(col('P1', []), true)).toBeNull();
    expect(lastServedIdIfFullBand(col('P1', [['a', 1], ['z', null]]), true)).toBeNull();
  });

  it('parseTypedRank: whole numbers ≥ 1 only', () => {
    expect(parseTypedRank(' 12 ')).toBe(12);
    expect(parseTypedRank('1')).toBe(1);
    for (const bad of ['', '0', '-1', '1.5', '1e3', 'abc', '99999999999999999999']) expect(parseTypedRank(bad)).toBeNull();
  });
});
