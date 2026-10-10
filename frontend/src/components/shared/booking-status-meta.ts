import type * as React from 'react';
import { CircleCheck, CircleSlash, Gauge } from 'lucide-react';

import type { BookingStatus } from '@/types/enums';

/** Booking status (ADR 0016) → label, tone token and icon. Full → danger,
 *  Near full → warning, Available → success. The status is always served. */
export const BOOKING_STATUS_META: Record<
  BookingStatus,
  { label: string; tone: 'danger' | 'warning' | 'success'; Icon: React.ComponentType<{ className?: string }> }
> = {
  full: { label: 'Full', tone: 'danger', Icon: CircleSlash },
  near_full: { label: 'Near full', tone: 'warning', Icon: Gauge },
  available: { label: 'Available', tone: 'success', Icon: CircleCheck },
};
