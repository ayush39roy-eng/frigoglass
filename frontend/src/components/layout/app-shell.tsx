import * as React from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { SURFACES } from '@/app/nav';
import { TooltipProvider } from '@/components/ui/tooltip';

import { AppHeader } from './app-header';
import { AppSidebar } from './app-sidebar';
import { DensityRegion, type Density } from './density-zone';

/**
 * App shell: fixed header + collapsible sidebar + scrolling main region. The six
 * surfaces render into <Outlet>. This is the only always-loaded layout — surface
 * chunks lazy-load per route (frontend-builder SKILL) to hold the 400 KB budget.
 *
 * The shell also selects the DENSITY ZONE for the active route, so a surface never
 * has to declare its own density and two surfaces can never disagree about what
 * "dense" means. See src/components/layout/density-zone.tsx.
 */

/** Longest-prefix match, so nested routes inherit their parent surface's density. */
function densityForPath(pathname: string): Density {
  let best: Density = 'overview';
  let bestLength = -1;

  for (const surface of SURFACES) {
    const matches =
      surface.path === '/' ? pathname === '/' : pathname === surface.path || pathname.startsWith(`${surface.path}/`);

    if (matches && surface.path.length > bestLength) {
      best = surface.density;
      bestLength = surface.path.length;
    }
  }

  return best;
}

export function AppShell(): React.JSX.Element {
  const { pathname } = useLocation();
  const density = React.useMemo(() => densityForPath(pathname), [pathname]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col">
        <AppHeader />
        <div className="flex min-h-0 flex-1">
          {/* The sidebar sits OUTSIDE the density region on purpose: navigation chrome
              is identical on every screen, and a sidebar that changed size when you
              moved from the Dashboard to the Matrix would read as a layout bug. */}
          <AppSidebar />
          <DensityRegion
            density={density}
            className="min-w-0 flex-1 overflow-auto bg-canvas"
            data-testid="surface-region"
          >
            {/* Overview is capped at 1680px so a KPI row does not stretch to absurd
                widths on a 34" monitor. Working is full-bleed — the Gantt and Matrix
                need every pixel, and a max-width there would throw away columns. */}
            <div className="mx-auto max-w-content p-gutter">
              <Outlet />
            </div>
          </DensityRegion>
        </div>
      </div>
    </TooltipProvider>
  );
}
