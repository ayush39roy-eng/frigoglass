import * as React from 'react';
import { Star } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Marks a project pinned as VIP (`projects.is_vip`, ADR 0022). Shown on the
 * Gantt row, Projects cards, the Priority board and the VIP page. A pin never
 * changes scheduling order, so the badge is information only.
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
