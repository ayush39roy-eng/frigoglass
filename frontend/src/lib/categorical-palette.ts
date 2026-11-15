/**
 * THE SHARED BOLTSHIFT CATEGORICAL PALETTE.
 *
 * Extracted 2026-10-01 (Capacity Boltshift reskin) from what was, until this
 * change, `surfaces/dashboard/lib/dash-chart-theme.ts` — a Dashboard-only
 * module built the day before (2026-10-01, "Boltshift shell + Dashboard
 * rebuild") specifically to avoid reskinning Capacity/Matrix/Gantt's charts,
 * which were out of scope THAT task. Now that THIS task reskins Capacity to
 * the same Boltshift visual system, the two surfaces are legitimate joint
 * consumers of one 10-hue ramp and one deterministic category→colour mapping,
 * so the logic moves here rather than Capacity importing across a surface
 * boundary from `surfaces/dashboard/**` (which that file's own doc comment
 * explicitly said never to do) or duplicating the rank-assignment arithmetic a
 * second time. `dash-chart-theme.ts` now re-exports from here unchanged by
 * name, so neither of its five existing Dashboard call sites needed to change.
 *
 * Reads `--dash-cat-1..10` (tokens.css "BOLTSHIFT LAYER") — the CSS custom
 * property names themselves were not renamed; only where the TypeScript that
 * reads them lives. Still deliberately separate from the older, more
 * restrained sitewide `--chart-1..6` ramp (`@/lib/chart-theme.ts`), which
 * `components/ui/bar-chart.tsx` keeps drawing from unchanged — that ramp is
 * RANKED BY VALUE for magnitude comparisons (hub load bars), a different job
 * from this ramp's DETERMINISTIC BY CATEGORY assignment (a project's category
 * is always the same hue, independent of any one table's sort order).
 */

import { getCategoryCatalog, type CategoryCatalog } from '@/lib/category-catalog';

const BOLT_CAT_TOKENS = [
  '--dash-cat-1',
  '--dash-cat-2',
  '--dash-cat-3',
  '--dash-cat-4',
  '--dash-cat-5',
  '--dash-cat-6',
  '--dash-cat-7',
  '--dash-cat-8',
  '--dash-cat-9',
  '--dash-cat-10',
] as const;

export function token(name: string, alpha = 1): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return 'transparent';
  }
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!channels) return 'transparent';
  return alpha === 1 ? `hsl(${channels})` : `hsl(${channels} / ${alpha})`;
}

/** Resolve the raw channel string for CSS custom properties that need it verbatim
 *  (e.g. building an `hsl(${channels} / <alpha>)` string inside an SVG `<pattern>`). */
export function channelsOf(name: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '0 0% 0%';
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return channels || '0 0% 0%';
}

/**
 * Assign the 10-hue ramp to series ordered by magnitude, not arrival order —
 * same rule as `assignSeriesColors` (`@/lib/chart-theme.ts`): the largest
 * series is always the darkest/most saturated, so a reader ranks the series
 * before reading an axis.
 */
export function assignCategoricalColors(values: readonly number[]): string[] {
  const ranked = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value);

  const out = new Array<string>(values.length);
  ranked.forEach(({ index }, rank) => {
    out[index] = token(BOLT_CAT_TOKENS[Math.min(rank, BOLT_CAT_TOKENS.length - 1)]);
  });
  return out;
}

export function categoricalChannels(rank: number): string {
  return channelsOf(BOLT_CAT_TOKENS[Math.min(Math.max(rank, 0), BOLT_CAT_TOKENS.length - 1)]);
}

/** Tailwind class names for the ramp (dot swatches, progress tracks), by rank. */
export const CATEGORICAL_RANK_BG = [
  'bg-dashChart-1',
  'bg-dashChart-2',
  'bg-dashChart-3',
  'bg-dashChart-4',
  'bg-dashChart-5',
  'bg-dashChart-6',
  'bg-dashChart-7',
  'bg-dashChart-8',
  'bg-dashChart-9',
  'bg-dashChart-10',
] as const;

export function categoricalRankBg(rank: number): string {
  return CATEGORICAL_RANK_BG[Math.min(Math.max(rank, 0), CATEGORICAL_RANK_BG.length - 1)];
}

/**
 * Text/icon classes for the ramp, by rank. P12-R04: these read the INK
 * companion tokens (`--dash-cat-ink-N`), not the chart fill (`--dash-cat-N`):
 * the fill hue on its own 15 % tint failed WCAG AA (B-OEM 3.02:1). Chart fills
 * and `CATEGORICAL_RANK_BG` are unchanged.
 */
export const CATEGORICAL_RANK_TEXT = [
  'text-dashChartInk-1',
  'text-dashChartInk-2',
  'text-dashChartInk-3',
  'text-dashChartInk-4',
  'text-dashChartInk-5',
  'text-dashChartInk-6',
  'text-dashChartInk-7',
  'text-dashChartInk-8',
  'text-dashChartInk-9',
  'text-dashChartInk-10',
] as const;

export function categoricalRankText(rank: number): string {
  return CATEGORICAL_RANK_TEXT[Math.min(Math.max(rank, 0), CATEGORICAL_RANK_TEXT.length - 1)];
}

const CATEGORICAL_RANK_SOFT_BG = [
  'bg-dashChart-1/15',
  'bg-dashChart-2/15',
  'bg-dashChart-3/15',
  'bg-dashChart-4/15',
  'bg-dashChart-5/15',
  'bg-dashChart-6/15',
  'bg-dashChart-7/15',
  'bg-dashChart-8/15',
  'bg-dashChart-9/15',
  'bg-dashChart-10/15',
] as const;

/** The "% pill in the same hue" background — a 15%-alpha tint of the rank colour. */
export function categoricalRankSoftBg(rank: number): string {
  return CATEGORICAL_RANK_SOFT_BG[Math.min(Math.max(rank, 0), CATEGORICAL_RANK_SOFT_BG.length - 1)];
}

/**
 * P33-T14 (ADR 0047 §4): palette slots of the seven categories that existed
 * before categories became a table. A colour assignment, not a category list:
 * nothing iterates it. It keeps "A+" the hue it has always had after an Admin
 * inserts a category ahead of it (a pure by-rank slot would re-colour every
 * category below the insertion).
 */
const SEEDED_CATEGORY_SLOTS: ReadonlyMap<string, number> = new Map([
  ['A+', 0],
  ['A', 1],
  ['B', 2],
  ['C', 3],
  ['A-OEM', 4],
  ['B-OEM', 5],
  ['C-OEM', 6],
]);
const FIRST_FREE_SLOT = 7;

/**
 * A DETERMINISTIC palette slot for a project category, so a category is the
 * same hue on every surface, never re-coloured per table.
 *
 * - The seven seeded codes keep their historical slots (0..6).
 * - Any other code takes the next free slot by rank (ADR 0047 §4): the n-th
 *   non-seeded category in the served rank order gets slot 7 + n, wrapping
 *   over the 10-hue ramp.
 * - A code the served list does not (yet) carry falls back to slot 7.
 *
 * `catalog` defaults to the mirrored served list (`lib/category-catalog.ts`).
 * The historical name is kept: every caller treats it as the palette index.
 */
export function categoryRank(category: string, catalog: CategoryCatalog = getCategoryCatalog()): number {
  const seeded = SEEDED_CATEGORY_SLOTS.get(category);
  if (seeded !== undefined) return seeded;
  const extras = catalog.codes.filter((c) => !SEEDED_CATEGORY_SLOTS.has(c));
  const n = extras.indexOf(category);
  if (n === -1) return FIRST_FREE_SLOT;
  return (FIRST_FREE_SLOT + n) % BOLT_CAT_TOKENS.length;
}

/**
 * The Dashboard donuts' slice fill for a palette position (`--dash-cat-1..10`,
 * theme-reactive CSS, wraps after 10). Moved here from `executive-charts.tsx`
 * (P32-R05) so the plan-import Executive donuts use the same hues.
 */
export function dashCatFill(rank: number): string {
  return `hsl(var(--dash-cat-${String((((rank % 10) + 10) % 10) + 1)}))`;
}
