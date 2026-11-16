import type * as React from 'react';
import { CircleAlert, CircleOff, CircleSlash, Clock, Hourglass, TriangleAlert, UserX } from 'lucide-react';

import type { BadgeProps } from '@/components/ui/badge';
import type { NonCountingOutcome, ScheduleOutcome, ScheduleOutcomeFlag } from '@/types/enums';

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

/**
 * P42 (ADR 0056, R42-3 / R42-4): the two outcomes that do not count toward the
 * year. The chip TEXT is always the served `outcome_label` ("Not scheduled
 * (P4)", "Queued — fits by W40", "Queued — after W52", "Queued — no slot");
 * `label` here is only the short legend name. Neither is a warning: a queued
 * P3 waits for spare capacity, a P4 is never planned — so neutral tones.
 */
export const BAND_OUTCOME_META: Record<NonCountingOutcome, OutcomeMeta> = {
  QUEUED: {
    tone: 'primary',
    label: 'Queued',
    Icon: Hourglass,
    description: 'P3 in queue: planned only with spare capacity and not counted in this year\'s figures.',
  },
  NOT_SCHEDULED_PRIORITY: {
    tone: 'neutral',
    label: 'Not scheduled (P4)',
    Icon: CircleSlash,
    description: 'P4 or Q: never planned, books nobody and is not counted in this year\'s figures.',
  },
};

/** The served bucket, narrowed to the two non-counting outcomes (else null). */
export function nonCountingOutcome(outcome: ScheduleOutcome | null | undefined): NonCountingOutcome | null {
  return outcome === 'QUEUED' || outcome === 'NOT_SCHEDULED_PRIORITY' ? outcome : null;
}

/**
 * P42: which non-counting bucket a served payload is in, read from its STORED
 * flags only (API_CONTRACT_P42 §0: QUEUED = `counts_toward_year` false and not
 * `not_scheduled_priority`). null = counts toward the year, or not in the run.
 */
export function servedNonCountingOutcome(flags: {
  counts_toward_year?: boolean | null;
  not_scheduled_priority?: boolean | null;
}): NonCountingOutcome | null {
  if (flags.not_scheduled_priority === true) return 'NOT_SCHEDULED_PRIORITY';
  if (flags.counts_toward_year === false) return 'QUEUED';
  return null;
}
