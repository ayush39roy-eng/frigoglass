import { describe, expect, it } from 'vitest';

import { laneCount, packLanes } from './lane-packing';

describe('packLanes', () => {
  it('keeps a sequential chain on one lane', () => {
    const packed = packLanes([
      { id: 'a', start: 1, end: 4 },
      { id: 'b', start: 5, end: 8 },
      { id: 'c', start: 9, end: 9 },
    ]);
    expect(packed.map((p) => p.lane)).toEqual([0, 0, 0]);
    expect(laneCount(packed)).toBe(1);
  });

  it('treats weeks as inclusive (shared week = overlap)', () => {
    const packed = packLanes([
      { id: 'a', start: 1, end: 5 },
      { id: 'b', start: 5, end: 8 },
    ]);
    expect(packed.map((p) => [p.item.id, p.lane])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('reuses the first free lane, sorted by start then end', () => {
    const packed = packLanes([
      { id: 'late', start: 10, end: 12 },
      { id: 'long', start: 1, end: 20 },
      { id: 'short', start: 1, end: 3 },
      { id: 'mid', start: 4, end: 6 },
    ]);
    expect(packed.map((p) => [p.item.id, p.lane])).toEqual([
      ['short', 0],
      ['long', 1],
      ['mid', 0],
      ['late', 0],
    ]);
    expect(laneCount(packed)).toBe(2);
  });

  it('stacks three mutually overlapping items in three lanes', () => {
    const packed = packLanes([
      { start: 1, end: 10 },
      { start: 2, end: 9 },
      { start: 3, end: 8 },
    ]);
    expect(laneCount(packed)).toBe(3);
  });

  it('laneCount is 1 for an empty row', () => {
    expect(laneCount(packLanes([]))).toBe(1);
  });
});
