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

import {
  fetchActiveScheduleRun,
  fetchCompletingWithinYear,
  fetchDashboardProjects,
  fetchHubTypePipeline,
  fetchPipelineTotals,
  fetchStatusOverview,
} from '../api/dashboard-api';
import type { ProjectFilterParams } from '../api/types';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry.
 *  Param typed `Error` (not `unknown`) so `useQuery` infers `TError = Error`. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export function useCompletingWithinYear(hubId: string | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardCompletingWithinYear(hubId),
    queryFn: ({ signal }) => fetchCompletingWithinYear({ signal }, hubId),
    retry: retryUnlessAuth,
  });
}

export function usePipelineTotals(hubId: string | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardPipelineTotals(hubId),
    queryFn: ({ signal }) => fetchPipelineTotals({ signal }, hubId),
    retry: retryUnlessAuth,
  });
}

export function useStatusOverview(hubId: string | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardStatusOverview(hubId),
    queryFn: ({ signal }) => fetchStatusOverview({ signal }, hubId),
    retry: retryUnlessAuth,
  });
}

export function useHubTypePipeline(hubId: string | null = null) {
  return useQuery({
    queryKey: queryKeys.dashboardHubTypePipeline(hubId),
    queryFn: ({ signal }) => fetchHubTypePipeline({ signal }, hubId),
    retry: retryUnlessAuth,
  });
}

export function useDashboardProjects(params: ProjectFilterParams) {
  const filters: DashboardProjectFilters = {
    hub_id: params.hub_id,
    category: params.category,
    status_: params.status_,
    priority: params.priority,
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
