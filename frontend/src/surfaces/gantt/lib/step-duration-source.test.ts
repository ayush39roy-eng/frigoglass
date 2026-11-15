import { describe, expect, it } from 'vitest';

import { durationSourceSuffix, isEffortZeroed, stepDurationSource } from './step-duration-source';
import { gapChipText } from './step-gap';

/** P33-T15 (contract Part G): the duration source is the served `own_effort` flag. */
describe('step duration source (served fields only)', () => {
  it('own effort or template', () => {
    expect(stepDurationSource({ own_effort: true })).toBe('effort');
    expect(stepDurationSource({ own_effort: false })).toBe('template');
    expect(durationSourceSuffix({ own_effort: true })).toBe(' (client effort)');
    expect(durationSourceSuffix({ own_effort: false })).toBe('');
  });

  it('isEffortZeroed: an own-effort step whose share is 0 on a non-zero template length', () => {
    expect(isEffortZeroed({ own_effort: true, effort_weeks: 0, plan_weeks: 1 })).toBe(true);
    expect(isEffortZeroed({ own_effort: false, effort_weeks: 0, plan_weeks: 1 })).toBe(false);
    expect(isEffortZeroed({ own_effort: true, effort_weeks: 0, plan_weeks: 0 })).toBe(false);
    expect(isEffortZeroed({ own_effort: true, effort_weeks: 2, plan_weeks: 1 })).toBe(false);
  });
});

/** P33-T15 (ADR 0048 §1): the read-only gap chip, verbatim from the served signed `gap_weeks`. */
describe('gapChipText', () => {
  it('negative = parallel, positive = wait, zero = none', () => {
    expect(gapChipText(-3)).toBe('parallel 3 wk');
    expect(gapChipText(-1)).toBe('parallel 1 wk');
    expect(gapChipText(2)).toBe('wait 2 wk');
    expect(gapChipText(0)).toBeNull();
  });
});
