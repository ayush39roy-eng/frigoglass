/**
 * TanStack Query hooks for the Prioritization Matrix surface (P4-T04).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number or converts a currency — hooks return raw API payloads
 * (Invariant I9 — no independent calculation, including in the frontend).
 */

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import { useCurrencyRates } from '@/lib/api/reference';
import type {
  LabRegion,
  ProjectCategory,
  ProjectStatus,
  ProjectType,
} from '@/types/enums';

import {
  applyScenario,
  fetchMatrixCurrencies,
  fetchPriorityCompare,
  fetchPriorityDistribution,
  fetchPriorityMatrix,
  fetchPriorityRow,
  fetchScoringDimensions,
  fetchPrioritySummary,
  fetchScenarioVersionDetail,
  fetchScenarioVersions,
  updateCurrencyRate,
  updatePriorityScore,
  type MatrixQueryParams,
} from '../api/matrix-api';
import type { MatrixCurrencyCode, PriorityScoreUpdateRequest, ScenarioApplyRequest } from '../api/types';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry.
 *  Param typed `Error` so `useQuery` infers `TError = Error`. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export { useCurrencyRates };

const MATRIX_CURRENCIES_KEY = ['matrix-currencies'] as const;

export interface UseMatrixParams {
  currency: MatrixCurrencyCode;
  hubId?: string | undefined;
  region?: LabRegion | undefined;
  category?: ProjectCategory | undefined;
  type?: ProjectType | undefined;
  status?: ProjectStatus | undefined;
  q?: string | undefined;
}

export function usePriorityMatrix(params: UseMatrixParams) {
  const query: MatrixQueryParams = {
    currency: params.currency,
    hubId: params.hubId,
    region: params.region,
    category: params.category,
    type: params.type,
    status: params.status,
    q: params.q,
  };
  return useQuery({
    // Every changeable input to `queryFn` must be in the key — `hubId` and
    // `category` are user-facing filters on a hub-scoped surface, so omitting
    // them would serve a stale hub's rows on filter change.
    // Same shape as `queryKeys.priorityMatrix` (prefix `priority-matrix`), built
    // here because the P21 currency codes are wider than the shared `CurrencyCode`.
    queryKey: [
      'priority-matrix',
      {
        currency: params.currency,
        hubId: params.hubId,
        region: params.region,
        category: params.category,
        type: params.type,
        status: params.status,
        q: params.q,
      },
    ] as const,
    queryFn: ({ signal }) => fetchPriorityMatrix(query, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}

export function usePrioritySummary(hubId: string | null = null, region: LabRegion | null = null) {
  return useQuery({
    queryKey: queryKeys.prioritySummary(hubId, region),
    queryFn: ({ signal }) => fetchPrioritySummary({ signal }, hubId, region),
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

/**
 * `PUT /currency-rates/{code}` (P13-T14). On success the rate list and every
 * Matrix entry are re-read: the converted columns change server-side.
 */
export function useUpdateCurrencyRate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ code, rateToEur }: { code: MatrixCurrencyCode; rateToEur: number }) =>
      updateCurrencyRate(code, rateToEur),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.currencyRates() });
      void queryClient.invalidateQueries({ queryKey: MATRIX_CURRENCIES_KEY });
      void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
    },
  });
}

/** The served dimension table (weights, scaled weights, total). Static for a
 *  session in practice; failure leaves the static fallback in place. */
export function useScoringDimensions() {
  return useQuery({
    queryKey: queryKeys.priorityDimensions(),
    queryFn: ({ signal }) => fetchScoringDimensions({ signal }),
    staleTime: 5 * 60_000,
    retry: retryUnlessAuth,
  });
}

// --- P21 ----------------------------------------------------------------------

/** The served currencies list (P21) with `configured` per code. */
export function useMatrixCurrencies() {
  return useQuery({
    queryKey: MATRIX_CURRENCIES_KEY,
    queryFn: ({ signal }) => fetchMatrixCurrencies({ signal }),
    retry: retryUnlessAuth,
    staleTime: 10 * 60_000,
  });
}

export type UseDistributionParams = Omit<UseMatrixParams, 'currency'>;

/** Band distribution + score histogram for the grid's server filters (P21).
 *  Under `priority-matrix` so a score save re-reads it with the grid. */
export function usePriorityDistribution(params: UseDistributionParams) {
  const filters = {
    hubId: params.hubId,
    region: params.region,
    category: params.category,
    type: params.type,
    status: params.status,
    q: params.q,
  };
  return useQuery({
    queryKey: ['priority-matrix', 'distribution', filters] as const,
    queryFn: ({ signal }) => fetchPriorityDistribution(filters, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}

/** `GET /priorities/compare` for the selected ids, fetched only when enabled. */
export function usePriorityCompare(projectIds: readonly string[], enabled: boolean) {
  return useQuery({
    queryKey: ['priority-matrix', 'compare', [...projectIds]] as const,
    queryFn: ({ signal }) => fetchPriorityCompare(projectIds, { signal }),
    enabled: enabled && projectIds.length > 0,
    retry: retryUnlessAuth,
  });
}

/**
 * P21-T04: the live Matrix row of each compared project (`GET /priorities/{id}`),
 * read only for users who may edit from Compare. Under `priority-matrix`, so a
 * score save re-reads them with the grid, the distribution and compare.
 */
export function usePriorityEditRows(projectIds: readonly string[], enabled: boolean) {
  return useQueries({
    queries: projectIds.map((id) => ({
      queryKey: ['priority-matrix', 'row', id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchPriorityRow(id, { signal }),
      enabled,
      retry: retryUnlessAuth,
    })),
  });
}
