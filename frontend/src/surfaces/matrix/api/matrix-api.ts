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
import type { CurrencyRate } from '@/lib/api/reference';
import type {
  LabRegion,
  ProjectCategory,
  ProjectStatus,
  ProjectType,
} from '@/types/enums';

import {
  CURRENCY_NAMES,
  MATRIX_CURRENCY_CODES,
  type CurrencyOption,
  type MatrixCurrencyCode,
  type PriorityCapacityFill,
  type PriorityCompareResponse,
  type PriorityDistribution,
  type PriorityMatrixRow,
  type PriorityPortfolioSummary,
  type PriorityScoreRead,
  type PriorityScoreUpdateRequest,
  type ScoringDimensionTable,
  type ScoringRubric,
  type ScoringRubricPreview,
  type ScoringRubricPreviewRequest,
  type ScoringRubricUpdateRequest,
  type ScoringRubricVersions,
  type ScenarioApplyRequest,
  type ScenarioApplyResponse,
  type ScenarioApplyRunDetail,
  type ScenarioApplyRunSummary,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export interface MatrixQueryParams {
  currency: MatrixCurrencyCode;
  hubId?: string | undefined;
  /** P13 (ADR 0025): the country filter, sent as `region`. */
  region?: LabRegion | undefined;
  /** P31: repeated `category` params (OR); omitted = all. */
  category?: readonly ProjectCategory[] | undefined;
  /** P13-T14 (API_CONTRACT_P13 §7): the Type chips — P31: repeated `type` params (OR). */
  type?: readonly ProjectType[] | undefined;
  /** P13-T14: the Status chip, sent as `status_`. */
  status?: ProjectStatus | undefined;
  /** P13-T14: the Project column search — name or code substring, ≤ 100 chars. */
  q?: string | undefined;
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
      region: params.region,
      category: params.category,
      type: params.type,
      status_: params.status,
      q: params.q,
    },
  });
}

/**
 * `PUT /currency-rates/{code}` (P13-T14, existing endpoint) — Admin / Super
 * Admin only; the server 403s anyone else. The body is exactly
 * `{rate_to_eur}` (`extra="forbid"`). The server then converts every
 * financial column with the new rate; the browser never applies it.
 */
export function updateCurrencyRate(code: MatrixCurrencyCode, rateToEur: number): Promise<CurrencyRate> {
  return apiSend<CurrencyRate>('PUT', `/currency-rates/${code}`, { rate_to_eur: rateToEur });
}

export function fetchPrioritySummary(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
): Promise<PriorityPortfolioSummary> {
  // P12 (ADR 0020) + P13 (ADR 0025): the global hub / country filter, ANDed server-side with the scope.
  return apiGet<PriorityPortfolioSummary>(
    '/priorities/summary',
    hubId || region ? { ...ctx, query: { hub_id: hubId ?? undefined, region: region ?? undefined } } : ctx,
  );
}

/**
 * `GET /priorities/{projectId}` — one served Matrix row (hub-scoped; 404 out of
 * scope). P21-T04: the Compare editor reads the live `hard_gates` / `has_score`
 * from it, so a score save from Compare sends the same full body as the edit
 * dialog. Default currency (EUR); nothing is converted here.
 */
export function fetchPriorityRow(projectId: string, ctx: FetchCtx = {}): Promise<PriorityMatrixRow> {
  return apiGet<PriorityMatrixRow>(`/priorities/${projectId}`, ctx);
}

/**
 * `PUT /priorities/{projectId}` — P26: `{scores: {key: 0..5 | null}, hard_gates}`
 * (active keys only; omitted keys unchanged; null clears) + hard gates.
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

/** `GET /priorities/dimensions` (P16, ADR 0029) — the served weight table. */
export function fetchScoringDimensions(ctx: FetchCtx = {}): Promise<ScoringDimensionTable> {
  return apiGet<ScoringDimensionTable>('/priorities/dimensions', ctx);
}

// --- P21 (docs/API_CONTRACT_P21.md) ------------------------------------------

/** P21 endpoint paths (docs/API_CONTRACT_P21.md), in one place. */
export const P21_PATHS = {
  currencies: '/currency-rates',
  distribution: '/priorities/distribution',
  compare: '/priorities/compare',
  capacityFill: '/priorities/capacity-fill',
} as const;

function isMatrixCurrency(code: string): code is MatrixCurrencyCode {
  return (MATRIX_CURRENCY_CODES as readonly string[]).includes(code);
}

/** A `GET /currency-rates` row; `name` / `configured` are P21 additions that a
 *  pre-P21 API omits. */
type ServedRate = Omit<CurrencyOption, 'name' | 'configured' | 'currency_code'> &
  Partial<Pick<CurrencyOption, 'name' | 'configured'>> & { currency_code: string };

/**
 * The Matrix currency list (P21 §1): `GET /currency-rates` rows with `name`
 * and `configured`. Every offered code is listed in enum order; a code with no
 * served row is not configured (the server would answer 422
 * `CURRENCY_NOT_CONFIGURED`). A pre-P21 API without `name` / `configured`
 * gets the static name and `configured = rate !== null`. Shown verbatim only.
 */
export async function fetchMatrixCurrencies(ctx: FetchCtx = {}): Promise<CurrencyOption[]> {
  const served = await apiGet<ServedRate[]>(P21_PATHS.currencies, ctx);
  return MATRIX_CURRENCY_CODES.map((code) => {
    const row = served.find((r) => isMatrixCurrency(r.currency_code) && r.currency_code === code);
    if (!row) return { currency_code: code, name: CURRENCY_NAMES[code], rate_to_eur: null, configured: false };
    return {
      currency_code: code,
      name: row.name ?? CURRENCY_NAMES[code],
      rate_to_eur: row.rate_to_eur,
      configured: row.configured ?? row.rate_to_eur !== null,
    };
  });
}

export type DistributionQueryParams = Omit<MatrixQueryParams, 'currency'>;

/** `GET /priorities/distribution` (P21 §4): band distribution and score
 *  histogram for the same filtered set as the grid. Shares and buckets are served. */
export function fetchPriorityDistribution(
  params: DistributionQueryParams,
  ctx: FetchCtx = {},
): Promise<PriorityDistribution> {
  return apiGet<PriorityDistribution>(P21_PATHS.distribution, {
    ...ctx,
    query: {
      hub_id: params.hubId,
      region: params.region,
      category: params.category,
      type: params.type,
      status_: params.status,
      q: params.q,
    },
  });
}

/** `GET /priorities/compare?project_id=a&project_id=b…` (P21 §5): 2–5 distinct ids,
 *  projects returned in the order given. */
export function fetchPriorityCompare(
  projectIds: readonly string[],
  ctx: FetchCtx = {},
): Promise<PriorityCompareResponse> {
  const search = new URLSearchParams();
  for (const id of projectIds) search.append('project_id', id);
  return apiGet<PriorityCompareResponse>(`${P21_PATHS.compare}?${search.toString()}`, ctx);
}

/** `GET /priorities/capacity-fill?hub_id&region` (P25, ADR 0036): per-hub P1 capacity fill,
 *  hub-scoped by the server (an out-of-scope hub gives `hubs: []`). Served figures only. */
export function fetchPriorityCapacityFill(
  params: { hubId?: string | undefined; region?: LabRegion | undefined },
  ctx: FetchCtx = {},
): Promise<PriorityCapacityFill> {
  return apiGet<PriorityCapacityFill>(P21_PATHS.capacityFill, {
    ...ctx,
    query: { hub_id: params.hubId, region: params.region },
  });
}

// --- P26 scoring rubric (docs/API_CONTRACT_P26.md) ------------------------------

export const RUBRIC_PATHS = {
  rubric: '/scoring-rubric',
  versions: '/scoring-rubric/versions',
  preview: '/scoring-rubric/preview',
} as const;

/** `GET /scoring-rubric` (Matrix read): every dimension, active and inactive, plus `can_edit`. */
export function fetchScoringRubric(ctx: FetchCtx = {}): Promise<ScoringRubric> {
  return apiGet<ScoringRubric>(RUBRIC_PATHS.rubric, ctx);
}

/** `GET /scoring-rubric/versions` (Matrix read): every version, newest first. */
export function fetchScoringRubricVersions(ctx: FetchCtx = {}): Promise<ScoringRubricVersions> {
  return apiGet<ScoringRubricVersions>(RUBRIC_PATHS.versions, ctx);
}

/** `POST /scoring-rubric/preview` (Admin / Super Admin): the impact of a proposal; nothing is saved. */
export function previewScoringRubric(body: ScoringRubricPreviewRequest): Promise<ScoringRubricPreview> {
  return apiSend<ScoringRubricPreview>('POST', RUBRIC_PATHS.preview, body);
}

/** `PUT /scoring-rubric` (Admin / Super Admin): the full replacement; 409 `RUBRIC_VERSION_CONFLICT` when stale. */
export function updateScoringRubric(body: ScoringRubricUpdateRequest): Promise<ScoringRubric> {
  return apiSend<ScoringRubric>('PUT', RUBRIC_PATHS.rubric, body);
}
