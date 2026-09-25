/**
 * Fetchers for the Prioritization Matrix surface (P4-T04).
 *
 * Thin wrappers over `apiGet` / `apiSend` — no transformation, no derived
 * numbers, no currency math. Each maps 1:1 to an endpoint in
 * `backend/api/routers/priorities.py`.
 *
 * `GET /priorities` returns financial columns ALREADY converted to the
 * requested `currency` (server-side); the only thing the currency toggle does
 * here is change that query param.
 */

import { apiGet, apiSend, type ApiRequestOptions } from '@/lib/api/client';
import type { CurrencyCode, ProjectCategory } from '@/types/enums';

import type {
  PriorityMatrixRow,
  PriorityPortfolioSummary,
  PriorityScoreRead,
  PriorityScoreUpdateRequest,
  ScenarioApplyRequest,
  ScenarioApplyResponse,
  ScenarioApplyRunDetail,
  ScenarioApplyRunSummary,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export interface MatrixQueryParams {
  currency: CurrencyCode;
  hubId?: string | undefined;
  category?: ProjectCategory | undefined;
}

export function fetchPriorityMatrix(
  params: MatrixQueryParams,
  ctx: FetchCtx = {},
): Promise<PriorityMatrixRow[]> {
  return apiGet<PriorityMatrixRow[]>('/priorities', {
    ...ctx,
    query: {
      currency: params.currency,
      hub_id: params.hubId,
      category: params.category,
    },
  });
}

export function fetchPrioritySummary(ctx: FetchCtx = {}): Promise<PriorityPortfolioSummary> {
  return apiGet<PriorityPortfolioSummary>('/priorities/summary', ctx);
}

/**
 * `PUT /priorities/{projectId}` — upsert the 13 dimension scores + hard gates.
 * The server recomputes `weighted_score` / `normalized_pct` / `suggested_band`;
 * this does NOT write `Project.priority` ("Apply Priorities" is a separate,
 * deferred action) and MUST NOT trigger a schedule run.
 */
export function updatePriorityScore(
  projectId: string,
  body: PriorityScoreUpdateRequest,
): Promise<PriorityScoreRead> {
  return apiSend<PriorityScoreRead>('PUT', `/priorities/${projectId}`, body);
}

/**
 * `POST /scenarios/apply` (P5-T02) — apply a scenario's accumulated
 * priority-score diff. The backend snapshots the pre-apply state of every
 * touched `PriorityScore` row into a new versioned `ScenarioApplyRun` before
 * writing the new values (`docs/PROJECT_AND_STACK.md` §4). `body.priority_scores`
 * must already be the genuine diff — only projects whose staged values differ
 * from their last-committed (live) values — the frontend does not rely on the
 * backend to drop no-op entries.
 */
export function applyScenario(body: ScenarioApplyRequest): Promise<ScenarioApplyResponse> {
  return apiSend<ScenarioApplyResponse>('POST', '/scenarios/apply', body);
}

/**
 * `GET /scenarios/versions` (P5-T03 — Versions & History) — every applied
 * scenario, most recent first, already hub-scope-filtered server-side (a Hub
 * Planner only sees versions that touched at least one project in their own
 * hub). **Scope note**: today every version's `entity_types_touched` is
 * `['priority_score']` — there is no general "schedule run" versioning yet,
 * only applied priority-score scenario diffs (see `docs/MEMORY.md`'s
 * P5-T02/P5-T03 entries).
 */
export function fetchScenarioVersions(ctx: FetchCtx = {}): Promise<ScenarioApplyRunSummary[]> {
  return apiGet<ScenarioApplyRunSummary[]>('/scenarios/versions', ctx);
}

/**
 * `GET /scenarios/versions/{version}` — one version's full before/after diff
 * for every changed row. 404s (via `ApiError`, `status === 404`) when the
 * version doesn't exist OR every one of its changes is outside the caller's
 * hub scope — the backend deliberately does not distinguish the two so a
 * hub-restricted caller can't infer that an out-of-scope version exists.
 */
export function fetchScenarioVersionDetail(
  version: number,
  ctx: FetchCtx = {},
): Promise<ScenarioApplyRunDetail> {
  return apiGet<ScenarioApplyRunDetail>(`/scenarios/versions/${String(version)}`, ctx);
}
