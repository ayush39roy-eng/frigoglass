import * as React from 'react';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Suspense fallback for a lazily-loaded surface route chunk. Matches the rough
 * shape of a surface (page title + a couple of panels) so the route swap does
 * not jolt the layout. Skeletons, not a spinner (ui-ux-pro-max).
 */
export function SurfaceFallback(): React.JSX.Element {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
