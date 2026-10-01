import { describe, expect, it } from 'vitest';

import { applyStatus, validateStage, type StageDraft } from './stage-validation';

const base: StageDraft = {
  status: 'Not Started',
  percent_complete: 0,
  actual_start_week: null,
  actual_end_week: null,
  remaining_weeks_override: null,
  blocked_reason: null,
};

describe('validateStage — DOMAIN_RULES per-stage consistency rules', () => {
  it('a clean Not Started row is valid', () => {
    expect(validateStage(base)).toEqual({});
  });
  it('Not Started ⇒ 0%; Done ⇒ 100%', () => {
    expect(validateStage({ ...base, percent_complete: 10 }).percent_complete).toMatch(/0%/);
    expect(
      validateStage({ ...base, status: 'Done', percent_complete: 90, actual_start_week: 10, actual_end_week: 12 })
        .percent_complete,
    ).toMatch(/100%/);
  });
  it('percent must be an integer 0..100', () => {
    expect(validateStage({ ...base, status: 'In Progress', actual_start_week: 3, percent_complete: 101 }).percent_complete).toBeTruthy();
    expect(validateStage({ ...base, status: 'In Progress', actual_start_week: 3, percent_complete: 2.5 }).percent_complete).toBeTruthy();
  });
  it('actual start is required for In Progress, Blocked and Done', () => {
    for (const status of ['In Progress', 'Blocked', 'Done'] as const) {
      expect(validateStage({ ...base, status, percent_complete: status === 'Done' ? 100 : 20, blocked_reason: 'x', actual_end_week: status === 'Done' ? 5 : null }).actual_start_week).toMatch(/required/);
    }
  });
  it('actual end: required when Done, forbidden otherwise, never before start', () => {
    expect(validateStage({ ...base, status: 'Done', percent_complete: 100, actual_start_week: 10 }).actual_end_week).toMatch(/required/);
    expect(validateStage({ ...base, status: 'In Progress', percent_complete: 30, actual_start_week: 10, actual_end_week: 12 }).actual_end_week).toMatch(/Only a Done/);
    expect(validateStage({ ...base, status: 'Done', percent_complete: 100, actual_start_week: 10, actual_end_week: 9 }).actual_end_week).toMatch(/before/);
    expect(validateStage({ ...base, status: 'Done', percent_complete: 100, actual_start_week: 10, actual_end_week: 10 })).toEqual({});
  });
  it('blocked reason: required (non-blank) when Blocked, absent otherwise', () => {
    expect(validateStage({ ...base, status: 'Blocked', percent_complete: 40, actual_start_week: 8, blocked_reason: '  ' }).blocked_reason).toMatch(/needs a reason/);
    expect(validateStage({ ...base, blocked_reason: 'supplier' }).blocked_reason).toMatch(/Only a blocked/);
  });
  it('remaining override is a non-negative integer or null; weeks stay on 1..78', () => {
    expect(validateStage({ ...base, status: 'In Progress', percent_complete: 10, actual_start_week: 5, remaining_weeks_override: -1 }).remaining_weeks_override).toBeTruthy();
    expect(validateStage({ ...base, status: 'In Progress', percent_complete: 10, actual_start_week: 90 }).actual_start_week).toMatch(/1–78/);
  });
});

describe('applyStatus — status changes imply the consistent fields', () => {
  it('Done sets 100%; Not Started clears actuals and percent; leaving Blocked clears the reason', () => {
    expect(applyStatus({ ...base, status: 'In Progress', percent_complete: 40, actual_start_week: 3 }, 'Done').percent_complete).toBe(100);
    expect(applyStatus({ ...base, status: 'In Progress', percent_complete: 40, actual_start_week: 3 }, 'Not Started')).toEqual(base);
    expect(applyStatus({ ...base, status: 'Blocked', percent_complete: 40, actual_start_week: 3, blocked_reason: 'x' }, 'In Progress').blocked_reason).toBeNull();
    expect(applyStatus({ ...base, status: 'Done', percent_complete: 100, actual_start_week: 3, actual_end_week: 6 }, 'In Progress')).toMatchObject({ actual_end_week: null, percent_complete: 99 });
  });
});
