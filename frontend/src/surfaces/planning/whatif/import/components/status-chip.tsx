import * as React from 'react';

import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { Badge } from '@/components/ui/badge';
import { BOOKING_STATUSES, type BookingStatus } from '@/types/enums';

/** A served capacity status (ADR 0016) as the app's booking chip; an unknown value is shown as served. */
export function ServedStatusChip({ status }: { status: string }): React.JSX.Element {
  if ((BOOKING_STATUSES as readonly string[]).includes(status))
    return <BookingStatusChip status={status as BookingStatus} />;
  return <Badge tone="neutral">{status}</Badge>;
}
