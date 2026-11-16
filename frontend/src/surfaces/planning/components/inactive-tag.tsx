import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * P38-T06 (ADR 0053 §6): the "Inactive" tag on the Capacity Planning roster.
 * Text, not colour only. Shown only from the served `active === false` flag (an
 * API before P38 omits the flag, which means active). P38-T07 builds the shared
 * tag for every other surface; this one is local to the roster.
 */
export function InactiveTag({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-pill border border-border-strong bg-surface-sunken px-1.5 text-2xs font-semibold text-text-muted',
        className,
      )}
      data-testid="inactive-tag"
    >
      Inactive
    </span>
  );
}
