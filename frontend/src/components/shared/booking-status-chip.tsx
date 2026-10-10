import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { formatBookedPct } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import { BOOKING_STATUS_META } from './booking-status-meta';

/**
 * Capacity booking status (ADR 0016) as a chip: icon + text + tone, never
 * colour alone. The status is the SERVER's (`*_booking_status_*`, I19); this
 * only maps it to a label and a token. Full → danger, Near full → warning,
 * Available → success.
 */
export function BookingStatusChip({
  status,
  className,
}: {
  status: BookingStatus;
  className?: string;
}): React.JSX.Element {
  const meta = BOOKING_STATUS_META[status];
  return (
    <Badge tone={meta.tone} className={cn('rounded-pill font-semibold', className)} data-booking-status={status}>
      <meta.Icon aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

/**
 * A served booked % with its status chip. Over 100 % the figure is printed as
 * served (e.g. "131.2 %") with an "over-booked" hint; a null % (capacity 0)
 * prints "—" with a "no capacity" hint. Both hints read the served number;
 * the status itself is never re-derived.
 */
export function BookedFigure({
  label,
  bookedPct,
  status,
  size = 'md',
  className,
  'data-testid': testId,
}: {
  label: string;
  bookedPct: number | null;
  status: BookingStatus;
  size?: 'sm' | 'md';
  className?: string;
  'data-testid'?: string;
}): React.JSX.Element {
  const overBooked = bookedPct !== null && bookedPct > 100;
  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid={testId}>
      <span className="label-caps text-text-subtle">{label}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn('font-mono font-bold tabular-nums text-text', size === 'md' ? 'text-figure' : 'text-sm')}
          data-numeric=""
        >
          {formatBookedPct(bookedPct)}
        </span>
        <BookingStatusChip status={status} />
      </span>
      {overBooked ? (
        <span className="text-2xs font-semibold text-danger-subtle-fg" data-testid={testId ? `${testId}-over` : undefined}>
          Over-booked: more work planned than capacity
        </span>
      ) : bookedPct === null ? (
        <span className="text-2xs text-text-muted">No capacity in scope</span>
      ) : null}
    </div>
  );
}
