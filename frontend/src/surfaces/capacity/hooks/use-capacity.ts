/**
 * TanStack Query hooks for the RPD Capacity surface (P4-T03).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number — hooks return raw API payloads and the components format
 * them (CLAUDE.md / Invariants I6 / I7 — no independent calculation, including
 * in the frontend).
 */

import { useQuery } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';

import {
  fetchActiveScheduleRun,
  fetchClassBreakdown,
  fetchHubLoadVsCapacity,
  fetchUtilizationMatrix,
} from '../api/capacity-api';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry.
 *  Param typed `Error` (not `unknown`) so `useQuery` infers `TError = Error`. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export function useHubLoadVsCapacity() {
  return useQuery({
    queryKey: queryKeys.capacityHubLoad(),
    queryFn: ({ signal }) => fetchHubLoadVsCapacity({ signal }),
    retry: retryUnlessAuth,
  });
}

export function useClassBreakdown() {
  return useQuery({
    queryKey: queryKeys.capacityClassBreakdown(),
    queryFn: ({ signal }) => fetchClassBreakdown({ signal }),
    retry: retryUnlessAuth,
  });
}

export function useUtilizationMatrix() {
  return useQuery({
    queryKey: queryKeys.capacityUtilizationMatrix(),
    queryFn: ({ signal }) => fetchUtilizationMatrix({ signal }),
    retry: retryUnlessAuth,
  });
}

/** Provenance enrichment only — never a headline number. `enabled` gated so it
 *  is not fetched until we know a run exists. Shares the `['schedule-runs',
 *  'active']` key with the Dashboard so the cache is reused. */
export function useActiveScheduleRun(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.activeScheduleRun(),
    queryFn: ({ signal }) => fetchActiveScheduleRun({ signal }),
    retry: retryUnlessAuth,
    enabled,
  });
}
