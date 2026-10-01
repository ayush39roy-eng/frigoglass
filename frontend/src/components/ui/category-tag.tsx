import * as React from 'react';

import { cn } from '@/lib/utils';
import { categoryRank, categoricalRankSoftBg, categoricalRankText } from '@/lib/categorical-palette';

/**
 * A category tag that cycles the full Boltshift categorical palette (spec §5's
 * table pattern) — a pill tinted by the project's category, assigned
 * DETERMINISTICALLY by the category's fixed position in `PROJECT_CATEGORIES`
 * (`categoryRank`), so "A+" is always the same hue everywhere it appears,
 * on any surface, not re-coloured per table.
 *
 * Promoted here 2026-10-01 (Capacity Boltshift reskin) from
 * `surfaces/dashboard/components/category-tag.tsx`, where it was built the day
 * before as a Dashboard-only pill reading Dashboard-only tokens. Capacity's
 * class-breakdown table uses the SAME seven `PROJECT_CATEGORIES` values this
 * component already handled, so promoting it here (the same move `bolt-card.tsx`
 * made for the same reason) avoids a second, duplicate pill implementation.
 * Never touches the shared `<Badge>` other, not-yet-reskinned surfaces
 * (Matrix/Gantt/Planning/Registration/Workspace/Settings/Admin) still use for
 * the same field.
 */
export function CategoryTag({ category }: { category: string }): React.JSX.Element {
  const rank = categoryRank(category);
  return (
    <span
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
