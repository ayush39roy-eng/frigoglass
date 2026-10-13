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
  // ADR 0017: the health value stays `blocked`; it is SHOWN as "On Hold".
  blocked: {
    label: 'On Hold',
    tone: 'warning',
    description:
      'A stage is on hold, so the project stays in the plan but waits at that stage until the hold is lifted.',
  },
  off_track: {
    label: 'Off track',
    tone: 'danger',
    description: 'Projected finish is after week 52 (spillover).',
  },
  // Client ask 2026-10-13: presented inside the spillover framing (52-week year
  // only). The served health value stays `left_out`.
  left_out: {
    label: 'Spillover · unplaced',
    tone: 'neutral',
    description: 'Not done by week 52 — the active schedule run found no slot for it yet, so it spills over unscheduled.',
  },
  unscheduled: {
    label: 'Not scheduled',
    tone: 'outline',
    description: 'There is no active schedule run for this project yet (or its status is excluded from scheduling).',
  },
};
