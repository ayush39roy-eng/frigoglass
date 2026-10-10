import { describe, expect, it } from 'vitest';

import type { CheckInDueProject, CheckInDueStage } from '@/lib/api/check-ins';

import { initialDraft, isIncluded, planBatch, stageKey, toEntry, validateDraft, withStatus, type CheckInDraft } from './check-in-draft';

function stage(overrides: Partial<CheckInDueStage> = {}): CheckInDueStage {
  return {
    step_id: 'PDD-E',
    step_name: 'Design Detailing',
    kind: 'design',
    status: 'In Progress',
    percent_complete: 40,
    blocked_reason: null,
    planned_start_week: 28,
    planned_end_week: 34,
    plan_percent: 50,
    checked_in_this_week: false,
    last_checkin_week: 30,
    can_check_in: true,
    ...overrides,
  };
}

function draft(overrides: Partial<CheckInDraft> = {}): CheckInDraft {
  return { ...initialDraft(stage()), ...overrides };
}

describe('validateDraft (DOMAIN_RULES per-stage progress rules)', () => {
  it('On Hold needs a hold reason', () => {
    expect(validateDraft(draft({ status: 'Blocked', blocked_reason: '  ' })).blocked_reason).toBe('A stage on hold needs a hold reason.');
    expect(validateDraft(draft({ status: 'Blocked', blocked_reason: 'Waiting for supplier' }))).toEqual({});
  });

  it('Not Started ⇒ 0 %, Done ⇒ 100 %, integer 0..100', () => {
    expect(validateDraft(draft({ status: 'Not Started', percent_complete: 10 })).percent_complete).toMatch(/0% complete/);
    expect(validateDraft(draft({ status: 'Done', percent_complete: 90 })).percent_complete).toMatch(/100% complete/);
    expect(validateDraft(draft({ percent_complete: 101 })).percent_complete).toMatch(/0 to 100/);
    expect(validateDraft(draft({ percent_complete: 12.5 })).percent_complete).toMatch(/whole number/);
  });

  it('a note is at most 1000 characters', () => {
    expect(validateDraft(draft({ note: 'x'.repeat(1001) })).note).toMatch(/1000/);
    expect(validateDraft(draft({ note: 'x'.repeat(1000) }))).toEqual({});
  });
});

describe('withStatus', () => {
  it('implies the consistent percent and keeps a hold reason only while On Hold', () => {
    const s = stage({ blocked_reason: 'old reason' });
    expect(withStatus(draft(), 'Done', s).percent_complete).toBe(100);
    expect(withStatus(draft(), 'Not Started', s).percent_complete).toBe(0);
    expect(withStatus(draft(), 'Blocked', s).blocked_reason).toBe('old reason');
    expect(withStatus(draft({ status: 'Blocked', blocked_reason: 'x' }), 'In Progress', s).blocked_reason).toBe('');
    expect(withStatus(draft({ confirmed: true }), 'Done', s).confirmed).toBe(false);
  });
});

describe('planBatch', () => {
  const project: CheckInDueProject = {
    project_id: 'p1',
    name: 'Cooler',
    hub: 'R&D-Greece',
    hub_id: 'hub-gr',
    tracking_status: 'due',
    schedule_stale: false,
    stages: [
      stage({ step_id: 'A' }),
      stage({ step_id: 'B' }),
      stage({ step_id: 'C' }),
      stage({ step_id: 'D', can_check_in: false }),
    ],
  };

  it('includes edited and confirmed-unchanged stages in display order, never untouched or read-only ones', () => {
    const plan = planBatch([project], {
      [stageKey('p1', 'C')]: draft({ percent_complete: 60 }),
      [stageKey('p1', 'A')]: draft({ confirmed: true }),
      [stageKey('p1', 'D')]: draft({ percent_complete: 90 }),
    });
    expect(plan.keys).toEqual([stageKey('p1', 'A'), stageKey('p1', 'C')]);
    expect(plan.entries).toEqual([
      { project_id: 'p1', step_id: 'A', status: 'In Progress', percent_complete: 40, blocked_reason: null, note: null },
      { project_id: 'p1', step_id: 'C', status: 'In Progress', percent_complete: 60, blocked_reason: null, note: null },
    ]);
    expect(plan.errors).toEqual({});
  });

  it('reports client errors by stage key', () => {
    const plan = planBatch([project], { [stageKey('p1', 'B')]: draft({ status: 'Blocked', blocked_reason: '' }) });
    expect(plan.errors[stageKey('p1', 'B')]?.blocked_reason).toBeDefined();
  });

  it('isIncluded is false for a read-only stage even when confirmed', () => {
    expect(isIncluded(draft({ confirmed: true }), stage({ can_check_in: false }))).toBe(false);
  });

  it('toEntry sends the hold reason only when On Hold and trims the note', () => {
    expect(toEntry('p', 's', draft({ status: 'Blocked', blocked_reason: ' r ', note: '  hi ' }))).toMatchObject({
      status: 'Blocked',
      blocked_reason: 'r',
      note: 'hi',
    });
    expect(toEntry('p', 's', draft({ blocked_reason: 'stale' })).blocked_reason).toBeNull();
  });
});
