import { describe, expect, it } from 'vitest';

import { NOTIFICATION_REASON_META } from '@/components/notifications/notification-reason-meta';
import { OUTCOME_STYLE } from '@/surfaces/dashboard/lib/outcome';
import { HEALTH_META } from '@/surfaces/project-workspace/lib/health-meta';
import { stageStatusLabel, WORKFLOW_STEP_STATUSES, WORKFLOW_STEP_STATUS_LABELS } from '@/types/enums';

/**
 * ADR 0017: every user-facing "Blocked" reads "On Hold". The wire values
 * (`Blocked`, `blocked`, `stage_blocked`) are unchanged: they stay the KEYS of
 * these maps; only the labels changed.
 */
describe('On Hold labels (ADR 0017)', () => {
  it('the stage status wire value stays `Blocked` but is labelled "On Hold"', () => {
    expect(WORKFLOW_STEP_STATUSES).toContain('Blocked');
    expect(stageStatusLabel('Blocked')).toBe('On Hold');
    expect(stageStatusLabel('In Progress')).toBe('In Progress');
    expect(Object.values(WORKFLOW_STEP_STATUS_LABELS)).not.toContain('Blocked');
  });

  it('the health value `blocked` is labelled "On Hold" and describes a stage hold, not a paused project', () => {
    expect(HEALTH_META.blocked.label).toBe('On Hold');
    expect(HEALTH_META.blocked.description).toMatch(/stays in the plan/);
  });

  it('the Dashboard outcome bucket `blocked` is labelled "On Hold"', () => {
    expect(OUTCOME_STYLE.blocked.label).toBe('On Hold');
  });

  it('the `stage_blocked` notification reason is labelled "Stage on hold"', () => {
    expect(NOTIFICATION_REASON_META.stage_blocked.label).toBe('Stage on hold');
  });
});
