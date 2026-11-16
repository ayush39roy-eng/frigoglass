import type * as React from 'react';
import { CircleAlert, CircleOff, Clock, TriangleAlert, UserX } from 'lucide-react';

import type { BadgeProps } from '@/components/ui/badge';
import type { ScheduleOutcomeFlag } from '@/types/enums';

/**
 * Presentation metadata for the five named scheduling outcomes (DOMAIN_RULES.md
 * booking rules + I1/I2/I5). Kept in a plain module so it can be consumed by
 * tables/legends without pulling in a component.
 *
 * Every flag pairs a status colour with an icon AND a text label — never colour alone
 * (ui-ux-pro-max SKILL).
 */
export interface OutcomeMeta {
  tone: NonNullable<BadgeProps['tone']>;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** May contain `{spillover_year}`; render through `outcomeDescription`,
   *  which fills it from the served `plan_year` (P37, ADR 0052). */
  description: string;
}

/** The meta's description with `{spillover_year}` filled in. */
export function outcomeDescription(meta: OutcomeMeta, spilloverYear: string): string {
  return meta.description.replaceAll('{spillover_year}', spilloverYear);
}

export const SCHEDULE_OUTCOME_META: Record<ScheduleOutcomeFlag, OutcomeMeta> = {
  ENG_CONFLICT: {
    tone: 'danger',
    label: 'Eng. conflict',
    Icon: UserX,
    description: 'Assigned engineer is double-booked in at least one week (frozen project).',
  },
  OVERLAP: {
    tone: 'danger',
    label: 'Chamber overlap',
    Icon: CircleAlert,
    description: 'A lab chamber exceeds its concurrent-project limit (frozen project).',
  },
  LEFT_OUT: {
    tone: 'warning',
    // Client ask 2026-10-13: the UI frames a 52-week year only, so a project the
    // server could not place is presented as spillover (it is certainly not done
    // by W52), not as a separate "beyond the horizon" concept. Flag unchanged.
    label: 'Spillover · unplaced',
    Icon: CircleOff,
    description: 'Not done by week 52 — no slot found in the plan yet, so it spills over to {spillover_year} unscheduled.',
  },
  SPILLOVER: {
    tone: 'warning',
    label: 'Spillover',
    Icon: Clock,
    description: 'Not done by week 52 — finishes after the plan year and spills over to {spillover_year}.',
  },
  CAT_NOT_ALLOWED: {
    tone: 'warning',
    label: 'Category not allowed',
    Icon: TriangleAlert,
    description:
      "Assigned leader's allowed categories exclude this project's category. Warning, not a scheduling block.",
  },
};
