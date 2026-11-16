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
import { NO_HUB_SELECTION, useHubSelection, type HubSelection } from '@/stores/hub-filter';

import {
  fetchActiveScheduleRun,
  fetchClassBreakdown,
  fetchEngineerUtilization,
  fetchHubLoadVsCapacity,
} from '../api/capacity-api';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry.
 *  Param typed `Error` (not `unknown`) so `useQuery` infers `TError = Error`. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

/** `enabled` (default true) lets the Dashboard's "Capacity booked" card (P11)
 *  share this exact query and cache entry without fetching for a role that
 *  cannot read Capacity. */
export function useHubLoadVsCapacity({
  enabled = true,
  hub = NO_HUB_SELECTION,
}: { enabled?: boolean; hub?: HubSelection } = {}) {
  return useQuery({
    // P12 (ADR 0020) + P13 (ADR 0025), multi-select: the hub / country lists are in the key and the request.
    queryKey: queryKeys.capacityHubLoad(hub),
    queryFn: ({ signal }) => fetchHubLoadVsCapacity({ signal }, hub),
    retry: retryUnlessAuth,
    enabled,
  });
}

export function useClassBreakdown(hub: HubSelection = NO_HUB_SELECTION) {
  return useQuery({
    queryKey: queryKeys.capacityClassBreakdown(hub),
    queryFn: ({ signal }) => fetchClassBreakdown({ signal }, hub),
    retry: retryUnlessAuth,
  });
}

/** P15 (ADR 0028): named per-engineer weekly utilization. The global hub and
 *  country selection (`useHubSelection`) is in the key and the request. */
export function useEngineerUtilization() {
  const hub = useHubSelection();
  return useQuery({
    queryKey: queryKeys.capacityEngineerUtilization(hub),
    queryFn: ({ signal }) => fetchEngineerUtilization({ signal }, hub),
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
