import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Skeleton loader — the ONLY loading affordance for above-the-fold layout regions
 * (ui-ux-pro-max SKILL: "skeleton loaders, not spinners"). Match the real content's
 * shape. Spinners are reserved for sub-second inline button-pending states.
 *
 * The shimmer is a CSS animation and is disabled by the global `prefers-reduced-motion`
 * rule in index.css; the muted block still communicates "loading" without motion.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        'relative overflow-hidden rounded bg-surface-sunken',
        'before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer',
        'before:bg-gradient-to-r before:from-transparent before:via-black/5 before:to-transparent',
        'dark:before:via-white/5',
        className,
      )}
      {...props}
    >
      <span className="sr-only">Loading</span>
    </div>
  );
}

export { Skeleton };
