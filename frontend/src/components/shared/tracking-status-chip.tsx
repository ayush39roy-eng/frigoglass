import * as React from 'react';
import { CalendarClock, CircleDashed, ClockAlert, Radio } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { TRACKING_STATUS_META, type TrackingStatus } from './tracking-status-meta';

export type { TrackingStatus } from './tracking-status-meta';

const ICON: Record<TrackingStatus, React.ComponentType<{ className?: string }>> = {
  live: Radio,
  due: CalendarClock,
  overdue: ClockAlert,
  idle: CircleDashed,
};

/**
 * The project's served tracking status (ADR 0021 §4): Live, Due this week,
 * Overdue or No active stage. Icon + text, never colour alone. The status is
 * computed by the server and only labelled here.
 *
 * Shared by the Gantt row, Projects cards, VIP cards, the Priority board and
 * the weekly check-in page (API_CONTRACT_P12 §7).
 */
export function TrackingStatusChip({
  status,
  className,
}: {
  status: TrackingStatus;
  className?: string;
}): React.JSX.Element {
  const meta = TRACKING_STATUS_META[status];
  const Icon = ICON[status];
  return (
    <Badge
      tone={meta.tone}
      className={cn('whitespace-nowrap', className)}
      title={`Tracking: ${meta.label}. ${meta.description}`}
      data-testid="tracking-status-chip"
      data-tracking={status}
    >
      <Icon aria-hidden="true" />
      <span className="sr-only">Tracking: </span>
      {meta.label}
    </Badge>
  );
}
