import * as React from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Suspense fallback for a lazily-loaded PANEL inside an already-rendered surface
 * (as opposed to `<SurfaceFallback>`, which stands in for a whole lazily-loaded
 * route). One card-shaped skeleton block, so a deferred analytics panel reserves
 * its slot and the page does not jolt when the real panel swaps in
 * (ui-ux-pro-max: skeleton loaders, never spinners, above the fold).
 *
 * `height` is a Tailwind height class rather than a number so each call site can
 * match the real panel it replaces; it is the only thing that varies. The
 * accessible "Loading" announcement and the reduced-motion-safe shimmer both come
 * from the shared `<Skeleton>` primitive unchanged.
 */
export function PanelSkeleton({
  height = 'h-64',
  className,
}: {
  height?: string;
  className?: string;
}): React.JSX.Element {
  return <Skeleton className={cn('w-full rounded-dash', height, className)} />;
}
