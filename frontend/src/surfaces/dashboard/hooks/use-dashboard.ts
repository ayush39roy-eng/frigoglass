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
import { NO_HUB_SELECTION, type HubSelection } from '@/stores/hub-filter';

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
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardCompletingWithinYear(hub, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchCompletingWithinYear({ signal }, hub, selection),
    retry: retryUnlessAuth,
  });
}

export function usePipelineTotals(
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardPipelineTotals(hub, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchPipelineTotals({ signal }, hub, selection),
    retry: retryUnlessAuth,
  });
}

export function useStatusOverview(
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardStatusOverview(hub, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchStatusOverview({ signal }, hub, selection),
    retry: retryUnlessAuth,
  });
}

export function useHubTypePipeline(
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardHubTypePipeline(hub, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchHubTypePipeline({ signal }, hub, selection),
    retry: retryUnlessAuth,
  });
}

/** P13 (API_CONTRACT_P13 §2): per-country chips under the KPI cards. */
export function useRegionSummary(
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardRegionSummary(hub, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchRegionSummary({ signal }, hub, selection),
    retry: retryUnlessAuth,
  });
}

/** P13-T10 (API_CONTRACT_P13 §5): the "Analytics & breakdown" section. */
export function useDashboardAnalytics(
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardAnalytics(hub, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchDashboardAnalytics({ signal }, hub, selection),
    retry: retryUnlessAuth,
  });
}

/** P13 (API_CONTRACT_P13 §3): the register's leader / current-step options. */
export function useProjectFacets(
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NO_SELECTION,
) {
  return useQuery({
    queryKey: queryKeys.dashboardProjectFacets(hub, selection),
    // Keep the last figures on screen while a new hub / country loads, so the
    // page keeps its height and scroll position (owner ask 2026-10-22). The
    // page dims while `isPlaceholderData` is set, so they never pass as current.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchProjectFacets({ signal }, hub, selection),
    retry: retryUnlessAuth,
    staleTime: 60_000,
  });
}

export function useDashboardProjects(params: ProjectFilterParams) {
  // Every changeable filter is in the key (P4-T04 review lesson).
  // P31: category / type are SORTED lists in the key (absent when empty).
  // Multi-select contract: every other list filter likewise (sorted, absent when empty).
  const category = sortedKeyList(params.category);
  const type = sortedKeyList(params.type);
  const region = sortedKeyList(params.region) as DashboardProjectFilters['region'];
  const leader = sortedKeyList(params.leader_engineer_id);
  const step = sortedKeyList(params.current_step);
  const filters: DashboardProjectFilters = {
    hub_id: sortedKeyList(params.hub_id),
    category,
    status_: sortedKeyList(params.status_),
    priority: sortedKeyList(params.priority),
    ...(region !== undefined ? { region } : {}),
    ...(params.q !== undefined ? { q: params.q } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(leader !== undefined ? { leader_engineer_id: leader } : {}),
    ...(step !== undefined ? { current_step: step } : {}),
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
  const region = sortedKeyList(params.region) as DashboardProjectFilters['region'];
  const filters: DashboardProjectFilters = {
    hub_id: sortedKeyList(params.hub_id),
    ...(region !== undefined ? { region } : {}),
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
  hub: HubSelection,
  selection: DashboardSelection,
) {
  const forType: DashboardSelection = { categories: selection.categories, types: [] };
  const forCategory: DashboardSelection = { categories: [], types: selection.types };
  return {
    type: {
      analytics: useDashboardAnalytics(hub, forType),
      totals: usePipelineTotals(hub, forType),
    },
    category: {
      analytics: useDashboardAnalytics(hub, forCategory),
      totals: usePipelineTotals(hub, forCategory),
    },
  };
}
