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
  description: string;
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
    label: 'Left out',
    Icon: CircleOff,
    description: 'No feasible window before the 78-week horizon — not scheduled.',
  },
  SPILLOVER: {
    tone: 'warning',
    label: 'Spillover',
    Icon: Clock,
    description: 'Completes after week 52 — will not finish inside the calendar year.',
  },
  CAT_NOT_ALLOWED: {
    tone: 'warning',
    label: 'Category not allowed',
    Icon: TriangleAlert,
    description:
      "Assigned leader's allowed categories exclude this project's category. Warning, not a scheduling block.",
  },
};
