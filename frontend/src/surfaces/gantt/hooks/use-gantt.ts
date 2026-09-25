/**
 * TanStack Query hooks for the Project Execution Timeline (Gantt) surface (P4-T05).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number, a week, or a bar position — hooks return raw API payloads
 * (Invariant I9 — no independent calculation, including in the frontend).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import {
  fetchActiveScheduleRun,
  fetchGantt,
  retryUnlessAuth,
  toggleFreeze,
} from '../api/gantt-api';
import type { FreezeToggleRequest } from '../api/types';

export interface UseGanttParams {
  hubId?: string | undefined;
}

export function useGantt(params: UseGanttParams) {
  return useQuery({
    // `hubId` is a user-facing filter on a hub-scoped surface — it must be in the
    // key or a filter change would serve the previous hub's rows (P4-T04 review).
    queryKey: queryKeys.gantt({ hubId: params.hubId }),
    queryFn: ({ signal }) => fetchGantt({ hubId: params.hubId }, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
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
