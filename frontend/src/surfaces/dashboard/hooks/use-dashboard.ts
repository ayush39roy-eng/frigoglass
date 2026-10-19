/**
 * TanStack Query hooks for the Global RPD Dashboard surface (P4-T02).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). P12 (ADR 0020):
 * each aggregate hook takes the global hub filter (`stores/hub-filter.ts`) and
 * puts it in its key, so switching hubs refetches. Nothing here
 * derives a number — hooks return raw API payloads and the components format
 * them (Invariant I9 — no independent calculation, including in the frontend).
 */

import { useQuery } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys, type DashboardProjectFilters } from '@/lib/query-keys';
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
} from '../api/dashboard-api';
import type { ProjectFilterParams } from '../api/types';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry.
 *  Param typed `Error` (not `unknown`) so `useQuery` infers `TError = Error`. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export function useCompletingWithinYear(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardCompletingWithinYear(hubId, region),
    queryFn: ({ signal }) => fetchCompletingWithinYear({ signal }, hubId, region),
    retry: retryUnlessAuth,
  });
}

export function usePipelineTotals(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardPipelineTotals(hubId, region),
    queryFn: ({ signal }) => fetchPipelineTotals({ signal }, hubId, region),
    retry: retryUnlessAuth,
  });
}

export function useStatusOverview(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardStatusOverview(hubId, region),
    queryFn: ({ signal }) => fetchStatusOverview({ signal }, hubId, region),
    retry: retryUnlessAuth,
  });
}

export function useHubTypePipeline(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardHubTypePipeline(hubId, region),
    queryFn: ({ signal }) => fetchHubTypePipeline({ signal }, hubId, region),
    retry: retryUnlessAuth,
  });
}

/** P13 (API_CONTRACT_P13 §2): per-country chips under the KPI cards. */
export function useRegionSummary(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardRegionSummary(hubId, region),
    queryFn: ({ signal }) => fetchRegionSummary({ signal }, hubId, region),
    retry: retryUnlessAuth,
  });
}

/** P13-T10 (API_CONTRACT_P13 §5): the "Analytics & breakdown" section. */
export function useDashboardAnalytics(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardAnalytics(hubId, region),
    queryFn: ({ signal }) => fetchDashboardAnalytics({ signal }, hubId, region),
    retry: retryUnlessAuth,
  });
}

/** P13 (API_CONTRACT_P13 §3): the register's leader / current-step options. */
export function useProjectFacets(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardProjectFacets(hubId, region),
    queryFn: ({ signal }) => fetchProjectFacets({ signal }, hubId, region),
    retry: retryUnlessAuth,
    staleTime: 60_000,
  });
}

export function useDashboardProjects(params: ProjectFilterParams) {
  // Every changeable filter is in the key (P4-T04 review lesson).
  const filters: DashboardProjectFilters = {
    hub_id: params.hub_id,
    category: params.category,
    status_: params.status_,
    priority: params.priority,
    ...(params.region !== undefined ? { region: params.region } : {}),
    ...(params.q !== undefined ? { q: params.q } : {}),
    ...(params.type !== undefined ? { type: params.type } : {}),
    ...(params.leader_engineer_id !== undefined ? { leader_engineer_id: params.leader_engineer_id } : {}),
    ...(params.current_step !== undefined ? { current_step: params.current_step } : {}),
    ...(params.sort !== undefined ? { sort: params.sort } : {}),
  };
  return useQuery({
    queryKey: queryKeys.dashboardProjects(filters),
    queryFn: ({ signal }) => fetchDashboardProjects(params, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
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
