import { describe, expect, it } from 'vitest';

import { findCycle, parallelPeers, topologicalLevels, validateDag, type DagStep } from './dag';

function chain(n: number, prefix = 'PDD'): DagStep[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `${prefix}-${String.fromCharCode(65 + i)}`;
    const prev = i === 0 ? [] : [`${prefix}-${String.fromCharCode(64 + i)}`];
    return { step_id: id, sequence_order: i + 1, predecessor_ids: prev };
  });
}

describe('validateDag — mirrors the server codes (ADR 0009)', () => {
  it('the seeded strict chain is valid', () => {
    expect(validateDag(chain(14))).toEqual([]);
    expect(findCycle(chain(14))).toBeNull();
  });

  it('detects a cycle and names it', () => {
    const steps = chain(4);
    steps[0] = { ...steps[0]!, predecessor_ids: ['PDD-D'] }; // A ← D closes A→B→C→D→A
    const errors = validateDag(steps);
    expect(errors.map((e) => e.code)).toContain('CYCLE');
    expect(findCycle(steps)).toEqual(['PDD-A', 'PDD-D', 'PDD-C', 'PDD-B', 'PDD-A']);
  });

  it('rejects a self-reference', () => {
    const steps = chain(3);
    steps[1] = { ...steps[1]!, predecessor_ids: ['PDD-B'] };
    expect(validateDag(steps).map((e) => e.code)).toEqual(['SELF_REFERENCE', 'CYCLE']);
  });

  it('rejects a reference outside the workflow (cross-workflow / unknown)', () => {
    const steps = chain(3);
    steps[2] = { ...steps[2]!, predecessor_ids: ['OEM-B'] };
    expect(validateDag(steps)).toEqual([
      expect.objectContaining({ code: 'BAD_PREDECESSOR', step_id: 'PDD-C' }),
    ]);
  });

  it('rejects an empty predecessor set on any step but the first', () => {
    const steps = chain(3);
    steps[2] = { ...steps[2]!, predecessor_ids: [] };
    expect(validateDag(steps)).toEqual([
      expect.objectContaining({ code: 'EMPTY_PREDECESSORS', step_id: 'PDD-C' }),
    ]);
  });
});

describe('parallelPeers / topologicalLevels — the "runs in parallel with" affordance', () => {
  it('under the strict chain nothing runs in parallel', () => {
    const steps = chain(5);
    for (const s of steps) expect(parallelPeers(steps, s.step_id)).toEqual([]);
  });

  it('lab H allowed to start after G, and TF-1 (I) also after G → H ∥ I; both precede J', () => {
    // A→B→…→G, H←G, I←G, J←H,I
    const steps = chain(10);
    steps[8] = { ...steps[8]!, predecessor_ids: ['PDD-G'] }; // I after G, not H
    steps[9] = { ...steps[9]!, predecessor_ids: ['PDD-H', 'PDD-I'] };
    expect(parallelPeers(steps, 'PDD-H')).toEqual(['PDD-I']);
    expect(parallelPeers(steps, 'PDD-I')).toEqual(['PDD-H']);
    expect(parallelPeers(steps, 'PDD-J')).toEqual([]);
    const levels = topologicalLevels(steps);
    expect(levels.get('PDD-G')).toBe(6);
    expect(levels.get('PDD-H')).toBe(7);
    expect(levels.get('PDD-I')).toBe(7);
    expect(levels.get('PDD-J')).toBe(8);
  });

  it('levels fall back to sequence order while the graph is cyclic', () => {
    const steps = chain(3);
    steps[0] = { ...steps[0]!, predecessor_ids: ['PDD-C'] };
    expect([...topologicalLevels(steps).values()]).toEqual([0, 1, 2]);
  });
});
