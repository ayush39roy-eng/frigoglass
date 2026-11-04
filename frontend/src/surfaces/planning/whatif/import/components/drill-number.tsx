import * as React from 'react';

import { cn } from '@/lib/utils';

import { int } from '../../components/figures';
import { drillLabel, type Drill } from '../drilldown';
import { useDrill } from '../drill-store';

/**
 * A clickable figure (P32-R07): the served number as a quiet button — underline on hover,
 * focus ring, pointer — that opens the drill-down sheet listing what is behind it.
 */
export function DrillNumber({
  drill,
  children,
  className,
  testId,
}: {
  drill: Drill;
  /** What to show; defaults to the figure. */
  children?: React.ReactNode;
  className?: string;
  testId?: string;
}): React.JSX.Element {
  const open = useDrill((s) => s.open);
  return (
    <button
      type="button"
      className={cn(
        'cursor-pointer rounded-sm text-inherit underline-offset-2 decoration-[1.5px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        className,
      )}
      aria-haspopup="dialog"
      aria-label={drillLabel(drill)}
      onClick={(e) => open(drill, e.currentTarget)}
      data-testid={testId}
      data-drill-figure={drill.figure}
    >
      {children ?? int(drill.figure)}
    </button>
  );
}
