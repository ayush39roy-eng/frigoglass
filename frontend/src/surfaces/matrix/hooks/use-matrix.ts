/**
 * TanStack Query hooks for the Prioritization Matrix surface (P4-T04).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number or converts a currency — hooks return raw API payloads
 * (Invariant I9 — no independent calculation, including in the frontend).
 */

import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys, sortedKeyList } from '@/lib/query-keys';
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
  fetchPriorityCapacityFill,
  fetchPriorityCompare,
  fetchPriorityDistribution,
  fetchPriorityMatrix,
  fetchPriorityRow,
  fetchScoringDimensions,
  fetchScoringRubric,
  fetchScoringRubricVersions,
  previewScoringRubric,
  updateScoringRubric,
  fetchPrioritySummary,
  fetchScenarioVersionDetail,
  fetchScenarioVersions,
  updateCurrencyRate,
  updatePriorityScore,
  type MatrixQueryParams,
} from '../api/matrix-api';
import type {
  MatrixCurrencyCode,
  PriorityScoreUpdateRequest,
  ScenarioApplyRequest,
  ScoringRubricPreviewRequest,
  ScoringRubricUpdateRequest,
} from '../api/types';

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
  /** P31: multi-select (repeated params), canonical order; sorted in the key. */
  category?: readonly ProjectCategory[] | undefined;
  type?: readonly ProjectType[] | undefined;
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
        category: sortedKeyList(params.category),
        type: sortedKeyList(params.type),
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
 * P21-T05: every query that shows a served score or band. `priority-matrix`
 * covers the grid, the distribution, compare and the edit rows; the Priority
 * board's cards show the weighted score and band; the Project Workspace has a
 * scoring section. A score write changes none of the run-derived views
 * (Gantt, Dashboard, Capacity): the scheduler never reads the score.
 */
export function invalidateScoreReaders(queryClient: QueryClient, projectId: string | null): void {
  void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
  void queryClient.invalidateQueries({ queryKey: ['priority-board'] });
  void queryClient.invalidateQueries({
    queryKey: projectId === null ? ['projects', 'workspace'] : queryKeys.projectWorkspace(projectId),
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
    onSuccess: (_data, { projectId }) => {
      invalidateScoreReaders(queryClient, projectId);
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
      invalidateScoreReaders(queryClient, null);
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

/** The served table of ACTIVE dimensions (weights, scaled weights, total, rubric
 *  version). Under `priority-matrix`, so a rubric save re-reads it. */
export function useScoringDimensions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.priorityDimensions(),
    queryFn: ({ signal }) => fetchScoringDimensions({ signal }),
    staleTime: 5 * 60_000,
    retry: retryUnlessAuth,
    enabled,
  });
}

// --- P26 scoring rubric (ADR 0037) ----------------------------------------------

/** `GET /scoring-rubric`: every dimension (active and inactive) and the caller's `can_edit`. */
export function useScoringRubric(enabled = true) {
  return useQuery({
    queryKey: queryKeys.scoringRubric(),
    queryFn: ({ signal }) => fetchScoringRubric({ signal }),
    retry: retryUnlessAuth,
    enabled,
  });
}

/** `GET /scoring-rubric/versions`, read only when the history tab is shown. */
export function useScoringRubricVersions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scoringRubricVersions(),
    queryFn: ({ signal }) => fetchScoringRubricVersions({ signal }),
    retry: retryUnlessAuth,
    enabled,
  });
}

/** `POST /scoring-rubric/preview`: writes nothing, so it invalidates nothing. */
export function usePreviewScoringRubric() {
  return useMutation({ mutationFn: (body: ScoringRubricPreviewRequest) => previewScoringRubric(body) });
}

/**
 * P26: a rubric save recomputes EVERY stored score server-side (ADR 0037 §4),
 * so every reader of a score or band is re-read: the Matrix rows, distribution,
 * summary, capacity fill, compare, edit rows and the served dimension table
 * (all under `priority-matrix`), the rubric and its versions, the Priority
 * board, the VIP board (it orders by weighted score) and every Workspace. A
 * rubric change never changes the schedule (ADR 0037 §7), so run-derived views
 * (Gantt, Dashboard, Capacity) are deliberately not refreshed.
 */
export function invalidateRubricReaders(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.scoringRubric() });
  void queryClient.invalidateQueries({ queryKey: ['priority-board'] });
  void queryClient.invalidateQueries({ queryKey: ['vip-board'] });
  void queryClient.invalidateQueries({ queryKey: ['projects', 'workspace'] });
}

/** `PUT /scoring-rubric`: on success every score reader is re-read (`invalidateRubricReaders`). */
export function useSaveScoringRubric() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ScoringRubricUpdateRequest) => updateScoringRubric(body),
    onSuccess: () => {
      invalidateRubricReaders(queryClient);
    },
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
  const keyFilters = { ...filters, category: sortedKeyList(filters.category), type: sortedKeyList(filters.type) };
  return useQuery({
    queryKey: ['priority-matrix', 'distribution', keyFilters] as const,
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

/** P25: per-hub P1 capacity fill for the global hub / country filter. Under `priority-matrix`,
 *  so a score save or a priority move re-reads it with the grid. */
export function usePriorityCapacityFill(hubId: string | null, region: LabRegion | null) {
  const params = { hubId: hubId ?? undefined, region: region ?? undefined };
  return useQuery({
    queryKey: ['priority-matrix', 'capacity-fill', params] as const,
    queryFn: ({ signal }) => fetchPriorityCapacityFill(params, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}
