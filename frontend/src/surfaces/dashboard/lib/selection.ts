/**
 * P31 (owner, 2026-10-23: "can this be done in pie chart instead and should be
 * dynamic based on different filterings"): the Dashboard-wide category / type
 * selection — Power BI-style cross-filtering.
 *
 * P31 contract: the Dashboard endpoints accept `Unmapped` (NULL) on BOTH
 * `category` and `type`, so both lists offer it here (and only here).
 *
 * Stored in the URL (`/?category=A%2B&category=A&type=NM`, old single-value
 * links still parse) and sent with EVERY Dashboard request in both views,
 * beside the global hub / country filter. The server filters and totals; the
 * browser only renders (I9).
 *
 * Cross-filter rule: a donut of one dimension shows its full distribution
 * within the OTHER active filters — the type donut ignores the type selection
 * but honours the category one (and the hub / country), and vice versa. That
 * is one more request per donut with that dimension's list left out, so every
 * slice is still a served figure (`useCrossFilterBreakdowns`).
 */

import { useMemo } from 'react';

import {
  CATEGORY_FILTER_VALUES,
  TYPE_FILTER_VALUES,
  useCategoryTypeParams,
  type CategoryFilterValue,
  type TypeFilterValue,
} from '@/lib/multi-select-filter';

import type { DashboardSelection } from '../api/dashboard-api';

export interface DashboardSelectionState extends DashboardSelection {
  categories: CategoryFilterValue[];
  types: TypeFilterValue[];
  setCategories: (next: readonly CategoryFilterValue[]) => void;
  setTypes: (next: readonly TypeFilterValue[]) => void;
  clear: () => void;
  /** Any category or type selected. */
  active: boolean;
}

export function useDashboardSelection(): DashboardSelectionState {
  const { categories, types, setCategories, setTypes, clear } = useCategoryTypeParams<
    TypeFilterValue,
    CategoryFilterValue
  >(TYPE_FILTER_VALUES, CATEGORY_FILTER_VALUES);
  return useMemo(
    () => ({
      categories,
      types,
      setCategories,
      setTypes,
      clear,
      active: categories.length > 0 || types.length > 0,
    }),
    [categories, types, setCategories, setTypes, clear],
  );
}
