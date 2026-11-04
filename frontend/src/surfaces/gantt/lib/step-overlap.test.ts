import { describe, expect, it } from 'vitest';

import {
  nearestStartAnchor,
  overlapForDrop,
  releaseWeek,
  type OverlapStep,
} from './step-overlap';

function step(
  stepId: string,
  startWeek: number | null,
  endWeek: number | null,
  predecessorIds: string[] = [],
  extra: Partial<OverlapStep> = {},
): OverlapStep {
  return {
    stepId,
    startWeek,
    endWeek,
    skipped: false,
    predecessorIds,
    overlapWeeks: null,
    ...extra,
  };
}

// Chain a(10..14) -> b(15..20) -> c(21..25); d waits for b and c'.
const chain: OverlapStep[] = [
  step('a', 10, 14),
  step('b', 15, 20, ['a'], { name: 'TF-1', kind: 'design' }),
  step('c', 21, 25, ['b'], { name: 'Cert testing', kind: 'lab' }),
];

describe('releaseWeek', () => {
  it('is frontier - 1 for a first step', () => {
    expect(releaseWeek(chain, 'a', 5)).toBe(4);
  });

  it('is the predecessor end when no overlap (reduces to I3)', () => {
    expect(releaseWeek(chain, 'b', 5)).toBe(14);
    expect(releaseWeek(chain, 'c', 5)).toBe(20);
  });

  it('takes the max over several predecessors', () => {
    const steps = [...chain, step('d', 26, 27, ['a', 'c'])];
    expect(releaseWeek(steps, 'd', 5)).toBe(25);
  });

  it('walks through a skipped predecessor (G = its predecessors max)', () => {
    const steps = [
      step('a', 10, 14),
      step('s', 14, 14, ['a'], { skipped: true }),
      step('c', 15, 18, ['s']),
    ];
    expect(releaseWeek(steps, 'c', 5)).toBe(14);
  });

  it('a skipped first step releases at frontier - 1', () => {
    const steps = [step('s', null, null, [], { skipped: true }), step('c', 8, 9, ['s'])];
    expect(releaseWeek(steps, 'c', 8)).toBe(7);
  });

  it('a step that overlapped passes its predecessors end on', () => {
    // c overlaps b: c runs 18..19 but b ends 20, so d still waits for week 20.
    const steps = [
      step('a', 10, 14),
      step('b', 15, 20, ['a']),
      step('c', 18, 19, ['b'], { overlapWeeks: 3 }),
      step('d', 21, 22, ['c']),
    ];
    expect(releaseWeek(steps, 'd', 5)).toBe(20);
  });

  it('an overlapping step that ends later releases at its own end', () => {
    const steps = [
      step('a', 10, 14),
      step('c', 12, 30, ['a'], { overlapWeeks: 3 }),
      step('d', 31, 32, ['c']),
    ];
    expect(releaseWeek(steps, 'd', 5)).toBe(30);
  });

  it('ignores unknown predecessors and unknown steps', () => {
    expect(releaseWeek(chain, 'zzz', 5)).toBe(4);
    expect(releaseWeek([step('x', 9, 10, ['missing'])], 'x', 5)).toBe(4);
  });
});

describe('nearestStartAnchor', () => {
  it('returns null for a first step', () => {
    expect(nearestStartAnchor(chain, 'a')).toBeNull();
  });

  it('returns the latest nearest non-skipped predecessor start', () => {
    expect(nearestStartAnchor(chain, 'c')).toEqual({ week: 15, stepIds: ['b'] });
  });

  it('walks through skipped steps', () => {
    const steps = [
      step('a', 10, 14),
      step('s', 14, 14, ['a'], { skipped: true }),
      step('c', 15, 18, ['s']),
    ];
    expect(nearestStartAnchor(steps, 'c')).toEqual({ week: 10, stepIds: ['a'] });
  });

  it('lists every predecessor tied on the anchor week', () => {
    const steps = [step('a', 10, 14), step('b', 10, 12), step('c', 15, 16, ['b', 'a'])];
    expect(nearestStartAnchor(steps, 'c')).toEqual({ week: 10, stepIds: ['a', 'b'] });
  });
});

describe('overlapForDrop', () => {
  it('a drop after release + 1 is a plain floor', () => {
    expect(overlapForDrop(chain, 'c', 24, 5)).toEqual({
      startNotBeforeWeek: 24,
      overlapWeeks: null,
      clampedWeek: 24,
      parallelWith: [],
    });
  });

  it('a drop exactly at release + 1 has no overlap', () => {
    expect(overlapForDrop(chain, 'c', 21, 5).overlapWeeks).toBeNull();
  });

  it('a drop onto the predecessor sets overlap = release + 1 - w', () => {
    const r = overlapForDrop(chain, 'c', 18, 5);
    expect(r.startNotBeforeWeek).toBe(18);
    expect(r.overlapWeeks).toBe(3);
    expect(r.parallelWith.map((p) => p.name)).toEqual(['TF-1']);
  });

  it('clamps to the start anchor of the nearest predecessor', () => {
    const r = overlapForDrop(chain, 'c', 3, 1);
    expect(r.clampedWeek).toBe(15);
    expect(r.startNotBeforeWeek).toBe(15);
    expect(r.overlapWeeks).toBe(6);
  });

  it('clamps to the frontier', () => {
    const r = overlapForDrop(chain, 'c', 16, 17);
    expect(r.clampedWeek).toBe(17);
    expect(r.overlapWeeks).toBe(4);
  });

  it('never sets an overlap on the first step', () => {
    expect(overlapForDrop(chain, 'a', 2, 1)).toEqual({
      startNotBeforeWeek: 2,
      overlapWeeks: null,
      clampedWeek: 2,
      parallelWith: [],
    });
  });

  it('rounds a fractional drop week', () => {
    expect(overlapForDrop(chain, 'c', 18.4, 5).startNotBeforeWeek).toBe(18);
  });
});
