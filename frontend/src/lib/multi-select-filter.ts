/**
 * P31 (owner: "Can we pick A+, A, B — multiple together, same with project
 * types"): the category / project-type multi-select, as URL state and as API
 * params.
 *
 * Contract (IMPLEMENTATION_PLAN P31): `category` and `type` are REPEATABLE
 * query params. Values within one param are ORed by the server, different
 * params are ANDed, and an empty list means "no filter". A single value
 * behaves exactly as before, so an old `?category=A` link still parses.
 *
 * Everything here is pure list handling: no row is filtered and no figure is
 * computed in the browser (I9). The selection is kept in ONE canonical order
 * (the option order), so the request, the URL and the React Query key are
 * identical whichever order the chips were pressed in.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  PROJECT_CATEGORIES,
  PROJECT_TYPE_LABELS,
  PROJECT_TYPES,
  type ProjectCategory,
  type ProjectType,
} from '@/types/enums';

/** The register-only "no type" value (`type IS NULL`). */
export const UNMAPPED_TYPE = 'Unmapped' as const;
export type TypeFilterValue = ProjectType | typeof UNMAPPED_TYPE;

/** Type options with the Dashboard's `Unmapped` value appended. P31 contract:
 *  `Unmapped` (= NULL) is accepted on the Dashboard endpoints only (both
 *  `category` and `type`); elsewhere it is a 422, so it is never offered there. */
export const TYPE_FILTER_VALUES: readonly TypeFilterValue[] = [...PROJECT_TYPES, UNMAPPED_TYPE];

export type CategoryFilterValue = ProjectCategory | typeof UNMAPPED_TYPE;
/** Category options with the Dashboard-only `Unmapped` appended. */
export const CATEGORY_FILTER_VALUES: readonly CategoryFilterValue[] = [...PROJECT_CATEGORIES, UNMAPPED_TYPE];

/** The URL / API param names (the same on every surface). */
export const CATEGORY_PARAM = 'category';
export const TYPE_PARAM = 'type';

/** Keep only allowed values, drop duplicates, return them in option order. */
export function canonicalSelection<T extends string>(values: Iterable<string>, allowed: readonly T[]): T[] {
  const picked = new Set<string>();
  for (const v of values) picked.add(v);
  return allowed.filter((a) => picked.has(a));
}

/** Toggle one value in a selection, keeping the option order. */
export function toggleSelection<T extends string>(current: readonly T[], value: T, allowed: readonly T[]): T[] {
  const next = new Set<string>(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return canonicalSelection(next, allowed);
}

/**
 * Read a repeated param (`?category=A%2B&category=B`). A legacy single value
 * (`?category=B`) is just a one-element list. Unknown values are ignored here
 * (an old or hand-edited link never breaks the page); the server still 422s
 * an unknown value it is sent, but none is.
 */
export function parseMultiParam<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
): T[] {
  return canonicalSelection(params.getAll(key), allowed);
}

/** Write a selection as a repeated param (deleted when empty). Returns a copy. */
export function writeMultiParam(params: URLSearchParams, key: string, values: readonly string[]): URLSearchParams {
  const out = new URLSearchParams(params);
  out.delete(key);
  for (const v of values) out.append(key, v);
  return out;
}

/** An empty selection is not sent (`undefined`), so the unfiltered request and
 *  query key stay what they were before P31. */
export function selectionParam<T extends string>(values: readonly T[]): T[] | undefined {
  return values.length === 0 ? undefined : [...values];
}

/**
 * One repeated URL param as React state. Writes `replace` the history entry
 * (a filter click is not a navigation) and keep every other param.
 */
export function useMultiSearchParam<T extends string>(
  key: string,
  allowed: readonly T[],
): [T[], (next: readonly T[]) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.getAll(key).join('\u0000');
  // Re-derive only when this param's raw values change, so the array identity
  // is stable across unrelated URL changes (it feeds memo deps and query keys).
  const values = useMemo(() => canonicalSelection(raw === '' ? [] : raw.split('\u0000'), allowed), [raw, allowed]);
  const setValues = useCallback(
    (next: readonly T[]) => {
      setParams((prev) => writeMultiParam(prev, key, canonicalSelection(next, allowed)), { replace: true });
    },
    [setParams, key, allowed],
  );
  return [values, setValues];
}

/** The category + type pair most surfaces use. */
export interface CategoryTypeSelection<TType extends string = ProjectType> {
  categories: ProjectCategory[];
  types: TType[];
}

export function useCategoryTypeParams<
  TType extends string = ProjectType,
  TCat extends string = ProjectCategory,
>(
  typeValues: readonly TType[] = PROJECT_TYPES as unknown as readonly TType[],
  categoryValues: readonly TCat[] = PROJECT_CATEGORIES as unknown as readonly TCat[],
): {
  categories: TCat[];
  types: TType[];
  setCategories: (next: readonly TCat[]) => void;
  setTypes: (next: readonly TType[]) => void;
  /** Write both lists in ONE navigation. React Router 6's functional
   *  `setSearchParams` is not queued, so two writes in one tick would lose the first. */
  setBoth: (categories: readonly TCat[], types: readonly TType[]) => void;
  clear: () => void;
} {
  const [categories, setCategories] = useMultiSearchParam(CATEGORY_PARAM, categoryValues);
  const [types, setTypes] = useMultiSearchParam(TYPE_PARAM, typeValues);
  const [, setParams] = useSearchParams();
  const setBoth = useCallback(
    (nextCategories: readonly TCat[], nextTypes: readonly TType[]) => {
      setParams(
        (prev) =>
          writeMultiParam(
            writeMultiParam(prev, CATEGORY_PARAM, canonicalSelection(nextCategories, categoryValues)),
            TYPE_PARAM,
            canonicalSelection(nextTypes, typeValues),
          ),
        { replace: true },
      );
    },
    [setParams, typeValues, categoryValues],
  );
  const clear = useCallback(() => setBoth([], []), [setBoth]);
  return { categories, types, setCategories, setTypes, setBoth, clear };
}

/* ------------------------------ chip options ------------------------------ */

/** One chip of `<MultiChipFilter>` (`components/shared/multi-chip-filter.tsx`). */
export interface MultiChipOption<T extends string> {
  value: T;
  label: string;
  /** Tooltip (e.g. the code behind a full name). */
  title?: string | undefined;
  /** Legend use: a colour swatch before the label (a CSS colour). */
  swatch?: string | undefined;
  /** Legend use: a short figure after the label, e.g. "52". Served, printed verbatim. */
  meta?: string | undefined;
}

/** Category chips: the codes are the labels ("A+", "B-OEM"). */
export const CATEGORY_CHIP_OPTIONS: readonly MultiChipOption<ProjectCategory>[] = PROJECT_CATEGORIES.map((c) => ({
  value: c,
  label: c,
}));

/** Type chips: the served labels (`PROJECT_TYPE_LABELS`), the code as tooltip. */
export const TYPE_CHIP_OPTIONS: readonly MultiChipOption<ProjectType>[] = PROJECT_TYPES.map((t) => ({
  value: t,
  label: PROJECT_TYPE_LABELS[t],
  title: t,
}));

/** Category chips plus the Dashboard-only `Unmapped` (no category). */
export const CATEGORY_CHIP_OPTIONS_WITH_UNMAPPED: readonly MultiChipOption<CategoryFilterValue>[] = [
  ...CATEGORY_CHIP_OPTIONS,
  { value: UNMAPPED_TYPE, label: 'Unmapped', title: 'Projects with no category' },
];

/** Type chips plus the Dashboard-only `Unmapped` (no type). */
export const TYPE_CHIP_OPTIONS_WITH_UNMAPPED: readonly MultiChipOption<TypeFilterValue>[] = [
  ...TYPE_CHIP_OPTIONS,
  { value: UNMAPPED_TYPE, label: 'Unmapped', title: 'Projects with no type' },
];
