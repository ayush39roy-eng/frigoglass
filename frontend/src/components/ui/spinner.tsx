import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Inline spinner — reserved for sub-second inline actions (button pending state) ONLY
 * (ui-ux-pro-max SKILL). For page/panel loading use <Skeleton>. The spin animation is
 * suppressed by the global prefers-reduced-motion rule; `role="status"` + the label
 * keep it meaningful without motion.
 */
export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  label?: string;
}

export function Spinner({ label = 'Loading', className, ...props }: SpinnerProps): React.JSX.Element {
  return (
    <span role="status" className={cn('inline-flex', className)} {...props}>
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
