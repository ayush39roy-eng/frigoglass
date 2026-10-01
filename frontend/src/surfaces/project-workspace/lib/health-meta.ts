import type { WorkspaceHealth } from '../api/types';

/** Display copy for the server's `health` (I13 — never derived here). */
export const HEALTH_META: Record<
  WorkspaceHealth,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'outline'; description: string }
> = {
  on_track: {
    label: 'On track',
    tone: 'success',
    description: 'Projected finish is within the year (week 52 or earlier) and no stage is overrunning.',
  },
  at_risk: {
    label: 'At risk',
    tone: 'warning',
    description: 'Projected finish is within the year, but at least one stage is running over its planned duration.',
  },
  // DOMAIN_RULES remediation ruling 5: evaluated after Left out, before the
  // finish-week rules. Warning tone (a hold, not a failure) with the ⏸ icon.
  blocked: {
    label: 'Blocked',
    tone: 'warning',
    description:
      'A stage is Blocked, so the project is held at its earliest feasible point until the block clears.',
  },
  off_track: {
    label: 'Off track',
    tone: 'danger',
    description: 'Projected finish is after week 52.',
  },
  left_out: {
    label: 'Left out',
    tone: 'neutral',
    description: 'No feasible slot inside the 78-week horizon in the active schedule run.',
  },
  unscheduled: {
    label: 'Not scheduled',
    tone: 'outline',
    description: 'There is no active schedule run for this project yet (or its status is excluded from scheduling).',
  },
};
