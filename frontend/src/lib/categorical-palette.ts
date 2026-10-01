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

import { PROJECT_CATEGORIES, type ProjectCategory } from '@/types/enums';

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

export const CATEGORICAL_RANK_TEXT = [
  'text-dashChart-1',
  'text-dashChart-2',
  'text-dashChart-3',
  'text-dashChart-4',
  'text-dashChart-5',
  'text-dashChart-6',
  'text-dashChart-7',
  'text-dashChart-8',
  'text-dashChart-9',
  'text-dashChart-10',
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
 * A DETERMINISTIC rank for a project category — unlike chart series (ranked by
 * value), a category tag's colour must stay the same for "A+" everywhere it
 * appears on the page, so it is assigned by the category's fixed position in
 * the canonical `PROJECT_CATEGORIES` enum, not by any per-table count.
 *
 * Reads the real enum (`@/types/enums`) rather than a second hand-maintained
 * copy of the same seven strings — `dash-chart-theme.ts`'s original version of
 * this function carried its own literal `CATEGORY_ORDER` array that happened
 * to list the same seven values in the same order; this consolidates the two.
 */
export function categoryRank(category: string): number {
  const index = PROJECT_CATEGORIES.indexOf(category as ProjectCategory);
  return index === -1 ? PROJECT_CATEGORIES.length : index;
}
