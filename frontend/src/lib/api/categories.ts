/**
 * P33-T14 (ADR 0047 §4, API_CONTRACT_P33 B1 / Part I): the ONE category source.
 *
 * `GET /reference/categories[?hub_id=]` → `{code, label, workflow_id, rank}[]`
 * in rank order (readable by every authenticated role). Cached for an hour;
 * "+ Add category" (B2, P33-T18) invalidates `queryKeys.categoriesAll()`.
 *
 * Every successful global fetch is mirrored into `lib/category-catalog.ts`, so
 * the palette and the chip components that cannot hold a query see the same list.
 *
 * Unit tests get a fixture list through a global mock of this module
 * (`src/test/setup.ts`, `src/test/category-fixtures.ts`).
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryKeys } from '@/lib/query-keys';
import { CategoryCatalog, setCategoryCatalog, type Category } from '@/lib/category-catalog';

import { apiGet, ApiError } from './client';

export type { Category } from '@/lib/category-catalog';

function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

/** B1. With `hubId`, only that hub's workflow's categories (404 for an unknown hub). */
export function fetchCategories(hubId?: string, signal?: AbortSignal): Promise<Category[]> {
  return apiGet<Category[]>('/reference/categories', {
    signal,
    query: hubId === undefined ? undefined : { hub_id: hubId },
  });
}

export interface UseCategoriesResult {
  /** Served rows in rank order; empty while loading or after an error. */
  categories: readonly Category[];
  catalog: CategoryCatalog;
  isPending: boolean;
  isError: boolean;
}

/** Every category, in rank order. */
export function useCategories(): UseCategoriesResult {
  const query = useQuery({
    queryKey: queryKeys.categoriesAll(),
    queryFn: async ({ signal }) => {
      const rows = await fetchCategories(undefined, signal);
      setCategoryCatalog(rows);
      return rows;
    },
    retry: retryUnlessAuth,
    staleTime: 60 * 60_000,
  });
  const catalog = useMemo(() => new CategoryCatalog(query.data ?? []), [query.data]);
  return { categories: catalog.categories, catalog, isPending: query.isPending, isError: query.isError };
}

/** The codes in rank order, or `null` while no list is available (loading or
 *  failed): callers that canonicalise URL params keep the raw values meanwhile,
 *  so a shared `?category=B2` link is not dropped before the list arrives. */
export function useCategoryCodes(): readonly string[] | null {
  const { catalog } = useCategories();
  return catalog.isEmpty ? null : catalog.codes;
}
