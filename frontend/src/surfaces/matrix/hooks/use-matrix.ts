/**
 * TanStack Query hooks for the Prioritization Matrix surface (P4-T04).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number or converts a currency — hooks return raw API payloads
 * (Invariant I9 — no independent calculation, including in the frontend).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import { useCurrencyRates } from '@/lib/api/reference';
import type { CurrencyCode, ProjectCategory } from '@/types/enums';

import {
  applyScenario,
  fetchPriorityMatrix,
  fetchPrioritySummary,
  fetchScenarioVersionDetail,
  fetchScenarioVersions,
  updatePriorityScore,
  type MatrixQueryParams,
} from '../api/matrix-api';
import type { PriorityScoreUpdateRequest, ScenarioApplyRequest } from '../api/types';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry.
 *  Param typed `Error` so `useQuery` infers `TError = Error`. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export { useCurrencyRates };

export interface UseMatrixParams {
  currency: CurrencyCode;
  hubId?: string | undefined;
  category?: ProjectCategory | undefined;
}

export function usePriorityMatrix(params: UseMatrixParams) {
  const query: MatrixQueryParams = {
    currency: params.currency,
    hubId: params.hubId,
    category: params.category,
  };
  return useQuery({
    // Every changeable input to `queryFn` must be in the key — `hubId` and
    // `category` are user-facing filters on a hub-scoped surface, so omitting
    // them would serve a stale hub's rows on filter change.
    queryKey: queryKeys.priorityMatrix({
      currency: params.currency,
      hubId: params.hubId,
      category: params.category,
    }),
    queryFn: ({ signal }) => fetchPriorityMatrix(query, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}

export function usePrioritySummary() {
  return useQuery({
    queryKey: queryKeys.prioritySummary(),
    queryFn: ({ signal }) => fetchPrioritySummary({ signal }),
    retry: retryUnlessAuth,
  });
}

/**
 * `PUT /priorities/{id}` inline edit. On success, invalidate every
 * `['priority-matrix', …]` key (grid + summary + detail) so the recomputed
 * band/score/hard-gate-count are re-read from the server. Deliberately does
 * NOT touch any `['schedule-runs', …]` / `['capacity', …]` key — editing a
 * score does not apply priorities and must not imply a schedule change.
 */
export function useUpdatePriorityScore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: PriorityScoreUpdateRequest }) =>
      updatePriorityScore(projectId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
    },
  });
}

/**
 * `POST /scenarios/apply` (P5-T01/P5-T02). Same invalidation posture as
 * `useUpdatePriorityScore` above, for the same reason: a scenario Apply only
 * writes `PriorityScore` rows (the backend's `POST /scenarios/apply` contract
 * accepts `priority_scores` diffs only today — see `docs/MEMORY.md`'s
 * "P5-T02 — backend-builder" entry). It never triggers a schedule run, so
 * `['schedule-runs', …]` / `['capacity', …]` / `['gantt', …]` / `['dashboard',
 * …]` keys are deliberately NOT invalidated here — those are derived from the
 * current *schedule run*, not from priority scores, and Invariant I9 forbids
 * inferring a schedule-derived number from anything other than an actual
 * solver run. Re-running the schedule (a separate, not-yet-built action) is
 * what would make a scenario Apply visible on those surfaces.
 */
export function useApplyScenario() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ScenarioApplyRequest) => applyScenario(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
    },
  });
}

/**
 * `GET /scenarios/versions` (P5-T03 — Versions & History list view).
 * `enabled` lets the caller defer the request until the history dialog is
 * actually opened, rather than fetching on every Matrix page load.
 */
export function useScenarioVersions(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.scenarioVersions(),
    queryFn: ({ signal }) => fetchScenarioVersions({ signal }),
    enabled: options.enabled ?? true,
    retry: retryUnlessAuth,
  });
}

/**
 * `GET /scenarios/versions/{version}` (P5-T03 — one version's before/after
 * diff). `version === null` means "no version selected" — `enabled: false`
 * in that case so this never fires with a nonsense path param.
 */
export function useScenarioVersionDetail(version: number | null) {
  return useQuery({
    queryKey: queryKeys.scenarioVersion(version ?? -1),
    queryFn: ({ signal }) => fetchScenarioVersionDetail(version as number, { signal }),
    enabled: version !== null,
    retry: retryUnlessAuth,
  });
}
