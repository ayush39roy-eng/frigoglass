import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Glassmorphism card surface — the Dashboard's hero-tile treatment (Global RPD
 * Dashboard polish, 2026-09-30). See `src/styles/tokens.css` "GLASS SURFACE
 * LAYER" for the palette-reconciliation reasoning: this is translucency + blur
 * of the SAME `--color-surface`/`--color-border`/`--slate-900` tokens every
 * other card already uses, not a second colour system.
 *
 * `opacity="hero"` (60%) is for surfaces that hold no dense text underneath —
 * KPI stat tiles, the hub globe panel. `opacity="content"` (90%) is for cards
 * that hold a virtualized data table (Hub × type pipeline, Project breakdown):
 * the blur/border/shadow chrome is identical, only the tint is less translucent,
 * so P4-T11's WCAG contrast work on the text tokens underneath is never at risk.
 *
 * Deliberately a sibling of `Card`, not a rewrite of it — `Card`'s solid-white
 * "soft surface" treatment (2026-09-08, client-directed) stays the primary
 * chrome for every other surface (Capacity/Matrix/Gantt/Planning/Registration/
 * Project Workspace). `GlassPanel` composes with the SAME `CardHeader` /
 * `CardTitle` / `CardContent` / `CardFooter` subcomponents (they are unstyled
 * with respect to their parent), so a call site can switch between `<Card>` and
 * `<GlassPanel>` without touching its children.
 */
const glassPanelVariants = cva(
  'relative rounded-panel border backdrop-blur-xl backdrop-saturate-150 text-text transition-[box-shadow,transform] duration-fast ease-ease-out-expo',
  {
    variants: {
      opacity: {
        hero: 'border-glass-border/40 bg-glass/60 shadow-glass',
        content: 'border-glass-border/30 bg-glass/90 shadow-glass',
      },
      interactive: {
        true: 'cursor-pointer hover:-translate-y-px hover:shadow-hover',
        false: '',
      },
    },
    defaultVariants: {
      opacity: 'hero',
      interactive: false,
    },
  },
);

export interface GlassPanelProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof glassPanelVariants> {}

const GlassPanel = React.forwardRef<HTMLDivElement, GlassPanelProps>(
  ({ className, opacity, interactive, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(glassPanelVariants({ opacity, interactive }), className)}
      {...props}
    />
  ),
);
GlassPanel.displayName = 'GlassPanel';

export { GlassPanel, glassPanelVariants };
