import * as React from 'react';

import { cn } from '@/lib/utils';
import { categoryRank, categoricalRankSoftBg, categoricalRankText } from '@/lib/categorical-palette';
import { useCategoryCatalogSnapshot } from '@/lib/category-catalog';

/**
 * A category tag that cycles the full Boltshift categorical palette (spec §5's
 * table pattern) — a pill tinted by the project's category, assigned
 * DETERMINISTICALLY by `categoryRank` (P33-T14: the seven seeded codes keep
 * their slots, an Admin-added category takes the next free slot by its served
 * rank), so "A+" is always the same hue everywhere it appears, on any surface,
 * not re-coloured per table. The served label is the tooltip when it differs
 * from the code.
 *
 * Promoted here 2026-10-01 (Capacity Boltshift reskin) from
 * `surfaces/dashboard/components/category-tag.tsx`, where it was built the day
 * before as a Dashboard-only pill reading Dashboard-only tokens. Capacity's
 * class-breakdown table uses the SAME category codes this
 * component already handled, so promoting it here (the same move `bolt-card.tsx`
 * made for the same reason) avoids a second, duplicate pill implementation.
 * Never touches the shared `<Badge>` other, not-yet-reskinned surfaces
 * (Matrix/Gantt/Planning/Registration/Workspace/Settings/Admin) still use for
 * the same field.
 */
export function CategoryTag({ category }: { category: string }): React.JSX.Element {
  const catalog = useCategoryCatalogSnapshot();
  const rank = categoryRank(category, catalog);
  const label = catalog.labelOf(category);
  return (
    <span
      title={label !== category ? label : undefined}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-pill px-2 py-0.5 text-2xs font-bold',
        categoricalRankSoftBg(rank),
        categoricalRankText(rank),
      )}
    >
      {category}
    </span>
  );
}
