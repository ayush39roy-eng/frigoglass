/**
 * TanStack Query hooks for the Global RPD Dashboard surface (P4-T02).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). P12 (ADR 0020):
 * each aggregate hook takes the global hub filter (`stores/hub-filter.ts`) and
 * puts it in its key, so switching hubs refetches. Nothing here
 * derives a number — hooks return raw API payloads and the components format
 * them (Invariant I9 — no independent calculation, including in the frontend).
 */

// `keepPreviousData` (not an inline `(prev) => prev`): the identity lambda
// defeats TanStack v5's TData inference here (every hook's `data` collapsed to
// `{}` under tsc), while the exported helper is typed to preserve it.
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys, sortedKeyList, type DashboardProjectFilters } from '@/lib/query-keys';
import type { LabRegion } from '@/types/enums';

import {
  fetchActiveScheduleRun,
  fetchCompletingWithinYear,
  fetchDashboardAnalytics,
  fetchDashboardProjects,
  fetchHubTypePipeline,
  fetchPipelineTotals,
  fetchProjectFacets,
  fetchRegionSummary,
  fetchStatusOverview,
  type DashboardSelection,
} from '../api/dashboard-api';
import type { ProjectFilterParams } from '../api/types';

/** P31: no Dashboard category / type selection (the unfiltered request and key). */
export const NO_SELECTION: DashboardSelection = { categories: [], types: [] };

/** Do not retry an auth failure — a 401/403 will not fix itself on retry.
 *  Param typed `Error` (not `unknown`) so `useQuery` infers `TError = Error`. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export function useCompletingWithinYear(
  hubId: string | null = null,
  region: LabRegion | null = null,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardCompletingWithinYear(hubId, region, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchCompletingWithinYear({ signal }, hubId, region, selection),
    retry: retryUnlessAuth,
  });
}

export function usePipelineTotals(
  hubId: string | null = null,
  region: LabRegion | null = null,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardPipelineTotals(hubId, region, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchPipelineTotals({ signal }, hubId, region, selection),
    retry: retryUnlessAuth,
  });
}

export function useStatusOverview(
  hubId: string | null = null,
  region: LabRegion | null = null,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardStatusOverview(hubId, region, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchStatusOverview({ signal }, hubId, region, selection),
    retry: retryUnlessAuth,
  });
}

export function useHubTypePipeline(
  hubId: string | null = null,
  region: LabRegion | null = null,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardHubTypePipeline(hubId, region, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchHubTypePipeline({ signal }, hubId, region, selection),
    retry: retryUnlessAuth,
  });
}

/** P13 (API_CONTRACT_P13 §2): per-country chips under the KPI cards. */
export function useRegionSummary(
  hubId: string | null = null,
  region: LabRegion | null = null,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardRegionSummary(hubId, region, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchRegionSummary({ signal }, hubId, region, selection),
    retry: retryUnlessAuth,
  });
}

/** P13-T10 (API_CONTRACT_P13 §5): the "Analytics & breakdown" section. */
export function useDashboardAnalytics(
  hubId: string | null = null,
  region: LabRegion | null = null,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardAnalytics(hubId, region, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchDashboardAnalytics({ signal }, hubId, region, selection),
    retry: retryUnlessAuth,
  });
}

/** P13 (API_CONTRACT_P13 §3): the register's leader / current-step options. */
export function useProjectFacets(
  hubId: string | null = null,
  region: LabRegion | null = null,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardProjectFacets(hubId, region, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchProjectFacets({ signal }, hubId, region, selection),
    retry: retryUnlessAuth,
    staleTime: 60_000,
  });
}

export function useDashboardProjects(params: ProjectFilterParams) {
  // Every changeable filter is in the key (P4-T04 review lesson).
  // P31: category / type are SORTED lists in the key (absent when empty).
  const category = sortedKeyList(params.category);
  const type = sortedKeyList(params.type);
  const filters: DashboardProjectFilters = {
    hub_id: params.hub_id,
    category,
    status_: params.status_,
    priority: params.priority,
    ...(params.region !== undefined ? { region: params.region } : {}),
    ...(params.q !== undefined ? { q: params.q } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(params.leader_engineer_id !== undefined ? { leader_engineer_id: params.leader_engineer_id } : {}),
    ...(params.current_step !== undefined ? { current_step: params.current_step } : {}),
    ...(params.sort !== undefined ? { sort: params.sort } : {}),
  };
  return useQuery({
    queryKey: queryKeys.dashboardProjects(filters),
    queryFn: ({ signal }) => fetchDashboardProjects(params, { signal }),
    retry: retryUnlessAuth,
    placeholderData: keepPreviousData,
  });
}

/**
 * P17-R08: the Hub × Type drill-down list. Same endpoint and cache key as the
 * register, but WITHOUT `placeholderData`: a drill-down must never show the
 * previous cell's projects while the new cell's list loads (its count is
 * checked against the clicked cell).
 */
export function useDrilldownProjects(params: ProjectFilterParams, enabled = true) {
  const category = sortedKeyList(params.category);
  const type = sortedKeyList(params.type);
  const filters: DashboardProjectFilters = {
    hub_id: params.hub_id,
    ...(params.region !== undefined ? { region: params.region } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(type !== undefined ? { type } : {}),
  };
  return useQuery({
    queryKey: queryKeys.dashboardProjects(filters),
    queryFn: ({ signal }) => fetchDashboardProjects(params, { signal }),
    retry: retryUnlessAuth,
    enabled,
  });
}

/** Provenance enrichment only — never a headline number. `enabled` gated so it
 *  is not fetched until we know a run exists. */
export function useActiveScheduleRun(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.activeScheduleRun(),
    queryFn: ({ signal }) => fetchActiveScheduleRun({ signal }),
    retry: retryUnlessAuth,
    enabled,
  });
}

/**
 * P31 cross-filter: the served breakdown behind each selectable donut, fetched
 * WITHOUT that donut's own dimension (the type donut honours the category
 * selection, the category donut the type selection; both the hub / country).
 * Each pairs `GET /dashboard/analytics` with `GET /dashboard/pipeline-totals`
 * for the same basis (the donut centre). With no selection every request is
 * the page's own (same key, one fetch).
 */
export function useCrossFilterBreakdowns(
  hubId: string | null,
  region: LabRegion | null,
  selection: DashboardSelection,
) {
  const forType: DashboardSelection = { categories: selection.categories, types: [] };
  const forCategory: DashboardSelection = { categories: [], types: selection.types };
  return {
    type: {
      analytics: useDashboardAnalytics(hubId, region, forType),
      totals: usePipelineTotals(hubId, region, forType),
    },
    category: {
      analytics: useDashboardAnalytics(hubId, region, forCategory),
      totals: usePipelineTotals(hubId, region, forCategory),
    },
  };
}
