/**
 * Thin Dashboard-named re-export of the shared Boltshift categorical palette
 * (`@/lib/categorical-palette.ts`).
 *
 * This file used to hold the real logic (2026-10-01, "Boltshift shell +
 * Dashboard rebuild") — the 10-hue `--dash-cat-1..10` ramp, the by-value rank
 * assignment, and the deterministic project-category rank, all deliberately
 * kept Dashboard-only so Capacity/Matrix/Gantt's charts (out of scope that
 * task) were not silently reskinned by repointing a shared token. The same
 * day's follow-up task reskins Capacity to this same Boltshift system, which
 * made the ramp a genuine joint consumer rather than a Dashboard exclusive —
 * see `@/lib/categorical-palette.ts`'s own doc comment for the full move.
 *
 * Kept here, under the original names, so the remaining Dashboard call site
 * (`hub-rank-list.tsx`) needed no import change. New code should import `@/lib/categorical-palette`
 * directly rather than through this alias.
 */

// P17-R08: the series-colour and category aliases lost their last consumer
// with the Hub × type bar chart; only the rank colours (Top hubs) remain.
export {
  categoricalRankBg as dashRankBg,
  categoricalRankText as dashRankText,
  categoricalRankSoftBg as dashRankSoftBg,
} from '@/lib/categorical-palette';
