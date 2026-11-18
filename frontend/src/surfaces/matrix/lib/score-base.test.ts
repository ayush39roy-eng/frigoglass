import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/client';
import type { HardGateReason } from '@/types/enums';

import type { PriorityScoreBase, PriorityScoreChangeBody, PriorityScoreUpdateRequest } from '../api/types';
import { sendScoreChange, toScoreChangeBody } from './score-base';

const GATE: HardGateReason = 'Active safety non-compliance';
const REG: HardGateReason = 'Regulatory deadline within 6 months';

/**
 * A fake score store with the server rules of P47-T02 + P47-R02:
 * - only fields in both the request and `base` are checked; a stored value
 *   differing from `base` is a 409 `EDIT_CONFLICT`, and nothing is written;
 * - `hard_gates` is written ONLY when present in the body (omitted = kept).
 */
function fakeServer(initial: PriorityScoreUpdateRequest) {
  const stored: PriorityScoreUpdateRequest = { scores: { ...initial.scores }, hard_gates: [...initial.hard_gates] };
  const send = vi.fn(async (body: PriorityScoreChangeBody & { base: PriorityScoreBase }) => {
    const conflicts: unknown[] = [];
    for (const [key, v] of Object.entries(body.base.scores)) {
      if (key in body.scores && (stored.scores[key] ?? null) !== v) conflicts.push({ id: 'p1', field: `scores.${key}` });
    }
    const gates = body.base.hard_gates;
    if (body.hard_gates !== undefined && gates !== undefined && [...gates].sort().join() !== [...stored.hard_gates].sort().join()) {
      conflicts.push({ id: 'p1', field: 'hard_gates', current_value: stored.hard_gates });
    }
    if (conflicts.length > 0) {
      throw new ApiError(409, 'Conflict', 'x', 'EDIT_CONFLICT', undefined, { code: 'EDIT_CONFLICT', conflicts });
    }
    Object.assign(stored.scores, body.scores);
    if (body.hard_gates !== undefined) stored.hard_gates = [...body.hard_gates];
    return { ok: true };
  });
  return { stored, send };
}

describe('score change body (P47-R03 / QA-2, A4)', () => {
  it('unchanged gates are left out of BOTH the body and base; changed ones carry the served list', () => {
    const served = { scores: { strategic_project: 3 }, hard_gates: [GATE] };
    expect(toScoreChangeBody({ scores: { strategic_project: 5 }, hard_gates: [GATE] }, served)).toEqual({
      scores: { strategic_project: 5 },
      base: { scores: { strategic_project: 3 } },
    });
    expect(toScoreChangeBody({ scores: {}, hard_gates: [] }, served)).toEqual({
      scores: {},
      hard_gates: [],
      base: { scores: {}, hard_gates: [GATE] },
    });
  });

  it("another user's concurrent gate change survives this user's scores-only save", async () => {
    // Bob read the project with no gates; meanwhile Alice set a gate.
    const bobRead = { scores: { strategic_project: 3 }, hard_gates: [] as HardGateReason[] };
    const { stored, send } = fakeServer({ scores: { strategic_project: 3 }, hard_gates: [REG] });
    const ask = vi.fn();
    const out = await sendScoreChange({
      change: { scores: { strategic_project: 5 }, hard_gates: bobRead.hard_gates },
      read: bobRead,
      send,
      ask,
    });
    expect(out.outcome).toBe('saved');
    expect(ask).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('hard_gates');
    expect(stored).toEqual({ scores: { strategic_project: 5 }, hard_gates: [REG] });
  });

  it('staged gates that differ from the stored ones, with no concurrent change, save without a 409 (A4)', async () => {
    const { stored, send } = fakeServer({ scores: { strategic_project: 3 }, hard_gates: [] });
    const ask = vi.fn();
    const out = await sendScoreChange({
      change: { scores: { strategic_project: 5 }, hard_gates: [GATE] },
      read: { scores: { strategic_project: 3 }, hard_gates: [] },
      send,
      ask,
    });
    expect(out.outcome).toBe('saved');
    expect(ask).not.toHaveBeenCalled();
    expect(stored.hard_gates).toEqual([GATE]);
  });

  it('a concurrent change to gates this user also changed is a conflict; "Use theirs" keeps theirs', async () => {
    const { stored, send } = fakeServer({ scores: { strategic_project: 3 }, hard_gates: [GATE] });
    const ask = vi.fn().mockResolvedValue('theirs');
    const out = await sendScoreChange({
      change: { scores: { strategic_project: 4 }, hard_gates: [REG] },
      read: { scores: { strategic_project: 3 }, hard_gates: [] },
      send,
      ask,
    });
    expect(ask).toHaveBeenCalledWith([expect.objectContaining({ field: 'hard_gates' })]);
    expect(out.outcome).toBe('saved');
    expect(send.mock.calls[1]?.[0]).toEqual({ scores: { strategic_project: 4 }, base: { scores: { strategic_project: 3 } } });
    expect(stored).toEqual({ scores: { strategic_project: 4 }, hard_gates: [GATE] });
  });
});
