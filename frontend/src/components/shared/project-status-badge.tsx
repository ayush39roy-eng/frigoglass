import * as React from 'react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { ProjectStatus } from '@/types/enums';

/**
 * Project lifecycle status (DOMAIN_RULES.md). Status is structural, not a scheduling
 * outcome — kept visually quiet (mostly neutral) so the scheduler's outcome badges
 * (<ScheduleOutcomeBadge>) stay the load-bearing colour on a row.
 */
const STATUS_TONE: Record<ProjectStatus, NonNullable<BadgeProps['tone']>> = {
  'In Buyoff': 'primary',
  'Under Industrialization': 'neutral',
  'In Development': 'neutral',
  'In Queue': 'neutral',
  Commercialized: 'success',
  'On Hold': 'warning',
  Draft: 'outline',
};

export interface ProjectStatusBadgeProps extends Omit<BadgeProps, 'tone' | 'children'> {
  status: ProjectStatus;
}

export function ProjectStatusBadge({
  status,
  ...props
}: ProjectStatusBadgeProps): React.JSX.Element {
  return (
    <Badge tone={STATUS_TONE[status]} {...props}>
      {status}
    </Badge>
  );
}
