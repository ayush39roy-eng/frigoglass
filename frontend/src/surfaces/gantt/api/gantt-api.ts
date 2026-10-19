/**
 * Fetchers for the Project Execution Timeline (Gantt) surface (P4-T05).
 *
 * Thin 1:1 wrappers over `apiGet` / `apiSend` — no transformation, no derived
 * numbers, no bar geometry. Each maps to an endpoint in
 * `backend/api/routers/gantt.py`.
 *
 * The endpoints are already RBAC-gated (`GANTT`/`READ` — Auditor gets 403;
 * freeze is `GANTT`/`WRITE` — Hub Planner / Admin only) and hub-scoped
 * server-side (P3-T02 / P3-T03).
 */

import { apiGet, apiSend, ApiError, type ApiRequestOptions } from '@/lib/api/client';
import type {
  LabRegion,
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
} from '@/types/enums';

import type {
  FreezeToggleRequest,
  FreezeToggleResponse,
  GanttActiveRun,
  GanttFacets,
  GanttResponse,
  GanttSort,
  StepTimingRequest,
  StepTimingResponse,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export interface GanttQueryParams {
  /** `hub_id` uuid filter (optional). */
  hubId?: string | undefined;
  /** P13 (ADR 0025): `region` country filter (optional). */
  region?: LabRegion | undefined;
  // P13-T13 (API_CONTRACT_P13 §7): server-side toolbar filters, all ANDed with
  // the scope and with `hub_id` / `region`. Undefined = not sent.
  /** Case-insensitive substring of name or external code, ≤ 100 chars. */
  q?: string | undefined;
  category?: ProjectCategory | undefined;
  type?: ProjectType | undefined;
  /** Sent as `status_` (the API's param name). */
  status?: ProjectStatus | undefined;
  leaderEngineerId?: string | undefined;
  /** A step code, e.g. `PDD-E`. */
  currentStep?: string | undefined;
  /** The P1–P4 / Queue tab. `Q` is the queue band. */
  priority?: ProjectPriority | undefined;
  sort?: GanttSort | undefined;
}

/**
 * `GET /gantt`. `limit` is set to the API max (500) so the whole portfolio
 * (~236 projects) arrives in one page — `total_count` in the response signals if
 * that was ever exceeded. Row virtualization keeps the render cheap regardless.
 */
export function fetchGantt(params: GanttQueryParams, ctx: FetchCtx = {}): Promise<GanttResponse> {
  return apiGet<GanttResponse>('/gantt', {
    ...ctx,
    query: {
      hub_id: params.hubId,
      region: params.region,
      q: params.q,
      category: params.category,
      type: params.type,
      status_: params.status,
      leader_engineer_id: params.leaderEngineerId,
      current_step: params.currentStep,
      priority: params.priority,
      sort: params.sort,
      limit: 500,
    },
  });
}

/**
 * `GET /dashboard/projects/facets` (API_CONTRACT_P13 §3) — the leaders and
 * current steps present in the caller's scoped set, so the Leader / Step
 * filters only offer values that exist. Same request (and cache key) as the
 * Dashboard register's facets. Needs `dashboard` read: a role without it (an
 * Engineer) gets a 403 and the two filters are simply not offered.
 */
export function fetchGanttFacets(
  hubId: string | null,
  region: LabRegion | null,
  ctx: FetchCtx = {},
): Promise<GanttFacets> {
  return apiGet<GanttFacets>(
    '/dashboard/projects/facets',
    hubId || region ? { ...ctx, query: { hub_id: hubId ?? undefined, region: region ?? undefined } } : ctx,
  );
}

/**
 * `POST /gantt/projects/{projectId}/freeze`. Does NOT trigger a recalculation —
 * a Hub Planner / Admin separately runs `POST /schedule-runs/greedy-recalc` for
 * the freeze to affect any planned dates. `actual_start_week` must be present
 * whenever `frozen` is `true` (the API 422s otherwise).
 */
export function toggleFreeze(
  projectId: string,
  body: FreezeToggleRequest,
): Promise<FreezeToggleResponse> {
  return apiSend<FreezeToggleResponse>('POST', `/gantt/projects/${projectId}/freeze`, body);
}

/**
 * `PATCH /projects/{projectId}/steps/{stepId}/timing` (ADR 0019, P12 contract
 * §3). Always 200 on success; `recalc_status` says whether a run was started.
 * 409 `PROJECT_FROZEN` / `NOT_SCHEDULABLE` / `STEP_DONE` / `STEP_STARTED` /
 * `STEP_SKIPPED`, 422 `VALIDATION_ERROR`. The server decides every outcome.
 */
export function setStepTiming(
  projectId: string,
  stepId: string,
  body: StepTimingRequest,
): Promise<StepTimingResponse> {
  return apiSend<StepTimingResponse>(
    'PATCH',
    `/projects/${projectId}/steps/${encodeURIComponent(stepId)}/timing`,
    body,
  );
}

function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export { retryUnlessAuth };

/**
 * `GET /schedule-runs/active` — provenance enrichment only (solver + timestamp
 * for the "which run" caption), never a headline number. Returns `null` (not a
 * throw) on 404: "no schedule computed yet" is a normal Gantt state.
 */
export async function fetchActiveScheduleRun(ctx: FetchCtx = {}): Promise<GanttActiveRun | null> {
  try {
    return await apiGet<GanttActiveRun>('/schedule-runs/active', ctx);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
