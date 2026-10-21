import * as React from 'react';

import { BOOKING_STATUS_META } from '@/components/shared/booking-status-meta';
import { cn } from '@/lib/utils';
import type { BookingStatus } from '@/types/enums';

import { STATUS_TONE_TEXT } from '../lib/status-format';

/* P19-T06: the compact `StatusMark` went with the hub utilization matrix; the merged
 * table's booked cells carry the icon and a visible label themselves. */

/** Icon legend with the SERVED thresholds (`full_threshold_pct`, `near_full_threshold_pct`). */
export function StatusLegend({
  fullPct,
  nearFullPct,
  className,
  children,
}: {
  fullPct: number;
  nearFullPct: number;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const range: Record<BookingStatus, string> = {
    full: `${String(fullPct)}% or more`,
    near_full: `${String(nearFullPct)}% to under ${String(fullPct)}%`,
    available: `under ${String(nearFullPct)}%`,
  };
  return (
    <div className={cn('flex flex-wrap items-center gap-x-s4 gap-y-1 text-2xs text-text-muted', className)}>
      {children}
      {(['full', 'near_full', 'available'] as const).map((s) => {
        const meta = BOOKING_STATUS_META[s];
        return (
          <span key={s} className="inline-flex items-center gap-1">
            <meta.Icon className={cn('size-3.5', STATUS_TONE_TEXT[meta.tone])} aria-hidden="true" />
            {meta.label}{' '}
            <span className="text-text-subtle">({range[s]})</span>
          </span>
        );
      })}
    </div>
  );
}
