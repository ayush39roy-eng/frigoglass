/**
 * Owner request 2026-11-16: Hub / Project type / Category multi-select filters
 * on the Dashboard "Completion profile" card.
 *
 * These filters narrow the card's OWN served rows (`CompletingWithinYear.rows`,
 * already scoped server-side by the header hub / country filter and the
 * Dashboard-wide category / type selection). Nothing is recomputed: a row is
 * kept or dropped on its served `hub`, `type` and `category` values, and the
 * card then groups the kept rows exactly as before, so the bar total always
 * equals the listed projects (I9: membership is still the server's outcome flag).
 *
 * Semantics follow the P31 multi-select contract: values within one dimension
 * are ORed, dimensions are ANDed, an empty list means "no filter". A NULL
 * type / category is the `Unmapped` value, as on the other Dashboard filters.
 */

import { UNMAPPED_TYPE } from '@/lib/multi-select-filter';
import { HUB_NAMES, PROJECT_TYPES, PROJECT_TYPE_LABELS } from '@/types/enums';

import type { CompletingWithinYearRow } from '../api/types';

/** URL params (card-prefixed so they never collide with the Dashboard-wide
 *  `category` / `type` selection). */
export const PROFILE_HUB_PARAM = 'cp_hub';
export const PROFILE_TYPE_PARAM = 'cp_type';
export const PROFILE_CATEGORY_PARAM = 'cp_category';

export interface ProfileFilter {
  hubs: readonly string[];
  types: readonly string[];
  categories: readonly string[];
}

export interface ProfileFilterOption {
  value: string;
  label: string;
  title?: string | undefined;
}

export interface ProfileFilterOptions {
  hubs: ProfileFilterOption[];
  types: ProfileFilterOption[];
  categories: ProfileFilterOption[];
}

type FilterRow = Pick<CompletingWithinYearRow, 'hub' | 'type' | 'category'>;

export function rowTypeKey(row: Pick<CompletingWithinYearRow, 'type'>): string {
  return row.type ?? UNMAPPED_TYPE;
}

export function rowCategoryKey(row: Pick<CompletingWithinYearRow, 'category'>): string {
  return row.category ?? UNMAPPED_TYPE;
}

export function isProfileFilterActive(f: ProfileFilter): boolean {
  return f.hubs.length > 0 || f.types.length > 0 || f.categories.length > 0;
}

/** Keep a row when every non-empty dimension contains its value. */
export function matchesProfileFilter(row: FilterRow, f: ProfileFilter): boolean {
  if (f.hubs.length > 0 && !f.hubs.includes(row.hub)) return false;
  if (f.types.length > 0 && !f.types.includes(rowTypeKey(row))) return false;
  if (f.categories.length > 0 && !f.categories.includes(rowCategoryKey(row))) return false;
  return true;
}

/** Order `present` by `canonical`, then any value the canonical list lacks
 *  (alphabetically), then `Unmapped` last. */
function ordered(present: ReadonlySet<string>, canonical: readonly string[]): string[] {
  const known = canonical.filter((v) => present.has(v));
  const extra = [...present]
    .filter((v) => v !== UNMAPPED_TYPE && !canonical.includes(v))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...extra, ...(present.has(UNMAPPED_TYPE) ? [UNMAPPED_TYPE] : [])];
}

/**
 * The options each dropdown offers: only values present in the card's rows
 * (the rows are already hub / country scoped, so no out-of-scope hub appears),
 * in the canonical order of each dimension: `HUB_NAMES`, `PROJECT_TYPES`, and
 * the served category list in rank order (`useCategories()`, P33-T14).
 */
export function profileFilterOptions(
  rows: readonly FilterRow[],
  categories: readonly { code: string; label: string }[],
): ProfileFilterOptions {
  const hubs = new Set<string>();
  const types = new Set<string>();
  const cats = new Set<string>();
  for (const r of rows) {
    hubs.add(r.hub);
    types.add(rowTypeKey(r));
    cats.add(rowCategoryKey(r));
  }
  const catLabel = new Map(categories.map((c) => [c.code, c.label]));
  return {
    hubs: ordered(hubs, HUB_NAMES).map((h) => ({ value: h, label: h })),
    types: ordered(types, PROJECT_TYPES).map((t) =>
      t === UNMAPPED_TYPE
        ? { value: t, label: 'Unmapped', title: 'Projects with no type' }
        : { value: t, label: PROJECT_TYPE_LABELS[t as (typeof PROJECT_TYPES)[number]] ?? t, title: t },
    ),
    categories: ordered(
      cats,
      categories.map((c) => c.code),
    ).map((c) => {
      if (c === UNMAPPED_TYPE) return { value: c, label: 'Unmapped', title: 'Projects with no category' };
      const label = catLabel.get(c);
      return { value: c, label: c, title: label !== undefined && label !== c ? label : undefined };
    }),
  };
}
