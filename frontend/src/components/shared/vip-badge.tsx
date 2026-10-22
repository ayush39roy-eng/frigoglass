import * as React from 'react';
import { Star } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Marks a project pinned as VIP (`projects.is_vip`, ADR 0022, ADR 0040).
 * Shown on the Gantt row, the Dashboard project cards and the Priority board.
 * Since ADR 0040 a pin is manual only (`PUT /projects/{id}/vip`) and is a
 * scheduling input: a VIP project schedules first (sort key after `frozen`,
 * before priority) and is listed first. The badge itself is display only; the
 * pin is set with `VipToggle` on the Projects page and the Matrix grid.
 */
export function VipBadge({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent/12 px-1.5 py-0.5 text-2xs font-semibold leading-none text-accent-subtle-fg',
        className,
      )}
      title="VIP project (pinned)"
      data-testid="vip-badge"
    >
      <Star className="size-3 shrink-0 fill-current" aria-hidden="true" />
      VIP
      <span className="sr-only"> project</span>
    </span>
  );
}
