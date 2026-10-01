import * as React from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { SURFACES } from '@/app/nav';
import { SessionGate } from '@/components/session/session-gate';
import { GlowOverlay } from '@/components/ui/background-components';
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
  // The Project Workspace is a per-project page a person READS (tokens.css
  // names it an 'overview' zone); it is not a SURFACES entry.
  if (pathname.startsWith('/projects/')) return 'overview';

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
      {/* Nothing below renders until GET /me resolves (ADR 0010): the sidebar,
          the route guards and every write control read the permission table. */}
      <SessionGate>
        {/*
         * Boltshift layout (spec §4), 2026-10-01: a grey PAGE (reusing the
         * EXISTING `bg-canvas` token — it already matches the spec's `--page`
         * hex closely enough that no new colour token was needed, see
         * tokens.css's "BOLTSHIFT LAYER" note) holds two floating white
         * siblings, padded 20px apart: the icon-only rail (AppSidebar, OUTSIDE
         * the Shell, to its left — unchanged from before, navigation chrome is
         * identical on every screen) and the Shell itself — a single rounded,
         * shadowed white container (reusing the EXISTING `bg-surface` token)
         * that now owns the TopNav (AppHeader) at its top and the scrollable
         * density region below it, instead of the header spanning the full
         * viewport width above the sidebar as it did before this task.
         */}
        <div className="relative h-screen bg-canvas p-5">
          {/* Ambient brand tint on the grey canvas, behind the floating sidebar
              and shell panels (both opaque, so this only shows in the gaps
              between them) — present on every surface, unlike `Component`'s
              stronger page-level treatment on `/login`. */}
          <GlowOverlay light />
          <div className="relative flex h-full items-start gap-5">
            <AppSidebar />
            {/* Bold Blocks (2026-10-01): the Shell is a light-grey ground (`bg-shell`)
                rather than white, so the white cards inside it read as separate
                boxes, and the header floats as its own white bar. */}
            <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-shell border-[1.5px] border-border bg-shell shadow-shell">
              <AppHeader />
              <DensityRegion
                density={density}
                className="min-h-0 flex-1 overflow-auto"
                data-testid="surface-region"
              >
                {/* Overview is capped at 1680px so a KPI row does not stretch to
                    absurd widths on a 34" monitor. Working is full-bleed — the
                    Gantt and Matrix need every pixel, and a max-width there
                    would throw away columns. */}
                <div className="mx-auto max-w-content p-gutter">
                  <Outlet />
                </div>
              </DensityRegion>
            </div>
          </div>
        </div>
      </SessionGate>
    </TooltipProvider>
  );
}
