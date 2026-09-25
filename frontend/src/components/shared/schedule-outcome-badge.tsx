import * as React from 'react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ScheduleOutcomeFlag } from '@/types/enums';

import { SCHEDULE_OUTCOME_META } from './schedule-outcome-meta';

/**
 * The five named scheduling outcomes (DOMAIN_RULES.md booking rules + I1/I2/I5).
 * These are FREQUENT, expected outputs of a resource-constrained scheduler — rendered
 * as a small inline badge (icon + label + status colour), never a full red row
 * (ui-ux-pro-max SKILL "conflict/warning states without a wall of red").
 */
export interface ScheduleOutcomeBadgeProps extends Omit<BadgeProps, 'tone' | 'children'> {
  flag: ScheduleOutcomeFlag;
  /** Render the icon only; the label stays available to assistive tech. */
  iconOnly?: boolean;
}

export function ScheduleOutcomeBadge({
  flag,
  iconOnly = false,
  className,
  ...props
}: ScheduleOutcomeBadgeProps): React.JSX.Element {
  const meta = SCHEDULE_OUTCOME_META[flag];
  return (
    <Badge tone={meta.tone} className={cn(className)} title={meta.description} {...props}>
      <meta.Icon className="size-3" aria-hidden="true" />
      {iconOnly ? <span className="sr-only">{meta.label}</span> : meta.label}
    </Badge>
  );
}
