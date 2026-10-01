import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The Boltshift Dashboard card (spec §3/§5), 2026-10-01 — REPLACES `GlassPanel`
 * (2026-09-30, deleted in this same change) as the Dashboard's own card chrome.
 *
 * Deliberately a sibling of the shared `Card` (`@/components/ui/card`), not a
 * rewrite of it, same reasoning `GlassPanel` itself gave: `Card`'s existing
 * "soft surface" treatment stays the chrome for every OTHER surface
 * (Capacity/Matrix/Gantt/Planning/Registration/Workspace/Settings/Admin — out of
 * scope this task), so `BoltCard` reads from its OWN radius/shadow/border tokens
 * (`--radius-dash`/`--shadow-dash-card`/`--color-dash-hairline`, tokens.css
 * "BOLTSHIFT LAYER") rather than touching `--radius-card`/`--shadow-card`/
 * `--color-border`, which those other surfaces' `<Card>` still reads unchanged.
 * `BoltCard` composes with the SAME `CardHeader`/`CardTitle`/`CardContent`
 * sub-components `Card` uses (they are unstyled with respect to their parent),
 * so swapping `<GlassPanel>` → `<BoltCard>` required no change to any card's
 * children — only the outer wrapper.
 *
 * No translucency/blur here (that was `GlassPanel`'s whole premise) — Boltshift's
 * cards are plain opaque white (light) / dark-surface (dark) with a soft, cool-
 * tinted shadow (`--shadow-dash-card`, spec §3's `--sh-card`) and a light hairline
 * border, never a hard 1px grey rule.
 */
const boltCardVariants = cva(
  'relative rounded-dash border-[1.5px] border-dash-hairline bg-surface text-text shadow-dashCard transition-[box-shadow,transform] duration-fast ease-ease-out-expo',
  {
    variants: {
      interactive: {
        true: 'cursor-pointer hover:-translate-y-0.5 hover:shadow-pop',
        false: '',
      },
    },
    defaultVariants: {
      interactive: false,
    },
  },
);

export interface BoltCardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof boltCardVariants> {}

const BoltCard = React.forwardRef<HTMLDivElement, BoltCardProps>(
  ({ className, interactive, ...props }, ref) => (
    <div ref={ref} className={cn(boltCardVariants({ interactive }), className)} {...props} />
  ),
);
BoltCard.displayName = 'BoltCard';

export { BoltCard, boltCardVariants };
