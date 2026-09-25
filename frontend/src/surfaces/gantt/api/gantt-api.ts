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
  FreezeToggleRequest,
  FreezeToggleResponse,
  GanttActiveRun,
  GanttResponse,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export interface GanttQueryParams {
  /** `hub_id` uuid filter (optional). */
  hubId?: string | undefined;
}

/**
 * `GET /gantt`. `limit` is set to the API max (500) so the whole portfolio
 * (~236 projects) arrives in one page — `total_count` in the response signals if
 * that was ever exceeded. Row virtualization keeps the render cheap regardless.
 */
export function fetchGantt(params: GanttQueryParams, ctx: FetchCtx = {}): Promise<GanttResponse> {
  return apiGet<GanttResponse>('/gantt', {
    ...ctx,
    query: { hub_id: params.hubId, limit: 500 },
  });
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
