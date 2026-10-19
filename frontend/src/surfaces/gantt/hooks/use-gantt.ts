/**
 * TanStack Query hooks for the Project Execution Timeline (Gantt) surface (P4-T05).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number, a week, or a bar position — hooks return raw API payloads
 * (Invariant I9 — no independent calculation, including in the frontend).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import type { LabRegion } from '@/types/enums';

import {
  fetchActiveScheduleRun,
  fetchGantt,
  fetchGanttFacets,
  retryUnlessAuth,
  toggleFreeze,
  type GanttQueryParams,
} from '../api/gantt-api';
import type { FreezeToggleRequest } from '../api/types';

/** P13-T13: every toolbar filter is a server param (API_CONTRACT_P13 §7). */
export type UseGanttParams = GanttQueryParams;

export function useGantt(params: UseGanttParams) {
  return useQuery({
    // Every user-facing filter must be in the key or a filter change would
    // serve the previous filter's rows (P4-T04 review). The whole params
    // object is the key, so a new filter can never be forgotten here.
    queryKey: queryKeys.gantt(params),
    queryFn: ({ signal }) => fetchGantt(params, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}

/** Leader / Step filter options (P13 §3 facets), keyed like the Dashboard's so
 *  the cache is shared. `enabled` is the caller's `dashboard` read. */
export function useGanttFacets(hubId: string | null, region: LabRegion | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.dashboardProjectFacets(hubId, region),
    queryFn: ({ signal }) => fetchGanttFacets(hubId, region, { signal }),
    retry: retryUnlessAuth,
    enabled,
    staleTime: 60_000,
  });
}

/** Provenance enrichment only. `enabled` gated so it is not fetched until we know
 *  an active run exists. Shares the `['schedule-runs', 'active']` key with the
 *  Dashboard / Capacity so the cache is reused. */
export function useActiveScheduleRun(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.activeScheduleRun(),
    queryFn: ({ signal }) => fetchActiveScheduleRun({ signal }),
    retry: retryUnlessAuth,
    enabled,
  });
}

/**
 * `POST /gantt/projects/{id}/freeze`. On success, invalidate the `['gantt', …]`
 * keys so the row re-reads its `frozen` / `actual_start_week` state. Deliberately
 * does NOT invalidate `['schedule-runs', …]` / `['dashboard', …]` / `['capacity',
 * …]`: freezing does not recalculate the schedule (the caller surfaces a
 * "recalc needed" notice instead). Invariant I10: this never mutates a frozen
 * project's already-locked planned dates.
 */
export function useToggleFreeze() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: FreezeToggleRequest }) =>
      toggleFreeze(projectId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['gantt'] });
    },
  });
}
