import { describe, expect, it } from 'vitest';

import { hasTimingEdit } from '../components/step-timing/step-timing-context';
import { timingChangeSummary } from '../components/step-timing/step-timing-state';
import { EFFORT_SKIPPED_COPY, timingErrorCopy } from '../components/step-timing/timing-copy';
import { ApiError } from '@/lib/api/client';
import {
  durationSourceSuffix,
  editBaselineText,
  isEffortZeroed,
  stepDurationSource,
} from './step-duration-source';

/** P30-T03 (ADR 0041 R4): effective = user ?? effort ?? lead; only the user's value is an edit. */
describe('step duration source (served fields only)', () => {
  it('user ?? effort ?? table', () => {
    expect(stepDurationSource({ duration_override_weeks: 6, effort_weeks: 4 })).toBe('user');
    expect(stepDurationSource({ duration_override_weeks: null, effort_weeks: 4 })).toBe('effort');
    expect(stepDurationSource({ duration_override_weeks: null, effort_weeks: 0 })).toBe('effort');
    expect(stepDurationSource({ duration_override_weeks: null, effort_weeks: null })).toBe('table');
    expect(durationSourceSuffix({ duration_override_weeks: null, effort_weeks: 4 })).toBe(' (client effort)');
    expect(durationSourceSuffix({ duration_override_weeks: 6, effort_weeks: null })).toBe(' (timing edit)');
    expect(durationSourceSuffix({ duration_override_weeks: null, effort_weeks: null })).toBe('');
  });

  it('the edit hint names the effort only when there is one', () => {
    expect(editBaselineText({ duration_override_weeks: 6, effort_weeks: 4, lead_time_weeks: 10 })).toBe('client effort 4, table 10');
    expect(editBaselineText({ duration_override_weeks: 6, effort_weeks: null, lead_time_weeks: 10 })).toBe('table 10');
  });

  it('isEffortZeroed: effort 0 on a non-zero table step with no user value', () => {
    expect(isEffortZeroed({ duration_override_weeks: null, effort_weeks: 0, lead_time_weeks: 1 })).toBe(true);
    expect(isEffortZeroed({ duration_override_weeks: 2, effort_weeks: 0, lead_time_weeks: 1 })).toBe(false);
    expect(isEffortZeroed({ duration_override_weeks: null, effort_weeks: 0, lead_time_weeks: 0 })).toBe(false);
    expect(isEffortZeroed({ duration_override_weeks: null, effort_weeks: null, lead_time_weeks: 1 })).toBe(false);
  });

  it('hasTimingEdit ignores effort values', () => {
    expect(hasTimingEdit({ duration_override_weeks: null, start_not_before_week: null })).toBe(false);
    const withEffort = { duration_override_weeks: null, start_not_before_week: null, effort_weeks: 4 };
    expect(hasTimingEdit(withEffort)).toBe(false);
    expect(hasTimingEdit({ duration_override_weeks: 6, start_not_before_week: null })).toBe(true);
    expect(hasTimingEdit({ duration_override_weeks: null, start_not_before_week: 40 })).toBe(true);
  });

  it('the change summary names the client effort when the user value is cleared', () => {
    const base = { stepName: 'Design', effectiveDurationWeeks: 4, startNotBeforeWeek: null };
    expect(timingChangeSummary({ ...base, durationOverrideWeeks: null, effortWeeks: 4 })).toBe('Design: 4 wks (client effort) · no start floor');
    expect(timingChangeSummary({ ...base, durationOverrideWeeks: null, effortWeeks: null })).toBe('Design: 4 wks (lead-time table) · no start floor');
    expect(timingChangeSummary({ ...base, durationOverrideWeeks: 4, effortWeeks: 2 })).toBe('Design: 4 wks · no start floor');
  });

  it('timingErrorCopy: STEP_SKIPPED on an effort-zeroed step (by target or by the served detail)', () => {
    const err = new ApiError(409, 'Conflict', 'skipped', 'STEP_SKIPPED');
    expect(timingErrorCopy(err, { effortWeeks: 0 })).toBe(EFFORT_SKIPPED_COPY);
    expect(timingErrorCopy(new ApiError(409, 'Conflict', '… its effort share is 0 weeks …', 'STEP_SKIPPED'))).toBe(EFFORT_SKIPPED_COPY);
    expect(timingErrorCopy(err, { effortWeeks: null })).toMatch(/skipped for the project \(0 weeks\)/);
    expect(timingErrorCopy(new ApiError(409, 'Conflict', 'x', 'PROJECT_FROZEN'), { effortWeeks: 0 })).toMatch(/frozen/);
  });
});
