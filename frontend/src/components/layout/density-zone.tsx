import { createContext, useContext, useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * DENSITY ZONES — the governing decision of the design system.
 *
 * Two zones, one token system. See src/styles/tokens.css §"LAYER 2b" for the values
 * and the reasoning; this file is only the mechanism that selects between them.
 *
 *   overview   Dashboard, Project Workspace     generous, board-presentable
 *   working    Matrix, Gantt, Capacity, Planning  dense, 40 rows visible at once
 *
 * The zone is expressed as a plain `data-density` attribute rather than a class,
 * because CSS custom properties cascade: any descendant — including one rendered by
 * a component that knows nothing about density — picks up the right scale for free.
 * The React context exists only for the small number of components that need to
 * branch in JS (e.g. a chart choosing a tick count, a table choosing a row height
 * for the virtualizer, which needs a number and cannot read a CSS variable).
 *
 * Zones nest. A `working` island inside an `overview` page (a compact table on the
 * Dashboard, say) is legitimate and works correctly, because the inner element
 * re-declares every variable the outer one set.
 */

export type Density = 'overview' | 'working';

const DensityContext = createContext<Density>('overview');

/**
 * Read the active density in JS. Returns 'overview' outside any zone, matching the
 * CSS default on :root — a component rendered in a portal, a test or a Storybook
 * cell is always legible rather than unstyled.
 */
export function useDensity(): Density {
  return useContext(DensityContext);
}

/**
 * Numeric row height for the active zone, in pixels.
 *
 * TanStack Virtual needs an actual number for `estimateSize`, and cannot read
 * `--row-h` off the DOM without a layout measurement on every render. Keeping the
 * mapping here — rather than letting each table hard-code 32 — means the two
 * definitions of a row height can never drift apart.
 *
 * These MUST stay in sync with --row-h / --row-h-compact in tokens.css.
 * The contract is asserted in density-zone.test.tsx.
 */
export const ROW_HEIGHT_PX: Record<Density, { default: number; compact: number }> = {
  overview: { default: 44, compact: 36 },
  working: { default: 32, compact: 28 },
};

export function useRowHeight(compact = false): number {
  const density = useDensity();
  return compact ? ROW_HEIGHT_PX[density].compact : ROW_HEIGHT_PX[density].default;
}

export interface DensityZoneProps extends React.HTMLAttributes<HTMLDivElement> {
  density: Density;
  /**
   * Render without a wrapping element, applying the zone to an existing child.
   * Useful when an extra <div> would break a grid or flex parent.
   */
  asChild?: never;
  children: React.ReactNode;
}

/**
 * Wraps a subtree in a density zone. Sets both the DOM attribute (which drives every
 * CSS token) and the React context (for the few JS consumers), so the two can never
 * disagree.
 */
export function DensityZone({ density, className, children, ...props }: DensityZoneProps) {
  // The context value is a bare string, so memoising is not about referential
  // stability — it is about not re-rendering every consumer when the parent
  // re-renders with an unchanged density.
  const value = useMemo(() => density, [density]);

  return (
    <DensityContext.Provider value={value}>
      <div data-density={density} className={cn('contents', className)} {...props}>
        {children}
      </div>
    </DensityContext.Provider>
  );
}

/**
 * `display: contents` on the wrapper above means the zone element itself is not a
 * box — it does not participate in layout, so dropping a DensityZone around a grid
 * child does not break the grid. When the zone genuinely IS the layout container
 * (a page shell, a panel), use this variant instead, which keeps its box.
 */
export function DensityRegion({ density, className, children, ...props }: DensityZoneProps) {
  const value = useMemo(() => density, [density]);

  return (
    <DensityContext.Provider value={value}>
      <div data-density={density} className={className} {...props}>
        {children}
      </div>
    </DensityContext.Provider>
  );
}
