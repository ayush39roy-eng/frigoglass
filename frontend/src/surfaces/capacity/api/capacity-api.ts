/**
 * Fetchers for the RPD Capacity surface (P4-T03).
 *
 * Thin wrappers over `apiGet` — no transformation, no derived numbers. Each maps
 * 1:1 to an endpoint in `backend/api/routers/capacity.py` (+ one read of
 * `backend/api/routers/schedule_runs.py` for provenance enrichment).
 *
 * The endpoints are already RBAC-gated (CAPACITY/READ — Engineer/Auditor get
 * 403) and hub-scoped server-side (P3-T02 / P3-T03).
 */

import { apiGet, ApiError, type ApiRequestOptions } from '@/lib/api/client';

import type {
  ClassBreakdown,
  HubCapacitySummary,
  ScheduleRunSummary,
  UtilizationMatrix,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export function fetchHubLoadVsCapacity(ctx: FetchCtx = {}): Promise<HubCapacitySummary> {
  return apiGet<HubCapacitySummary>('/capacity/hub-load', ctx);
}

export function fetchClassBreakdown(ctx: FetchCtx = {}): Promise<ClassBreakdown> {
  return apiGet<ClassBreakdown>('/capacity/class-breakdown', ctx);
}

export function fetchUtilizationMatrix(ctx: FetchCtx = {}): Promise<UtilizationMatrix> {
  return apiGet<UtilizationMatrix>('/capacity/utilization-matrix', ctx);
}

/**
 * The single active schedule run. Returns `null` (not a throw) on 404 — "no
 * schedule computed yet" is a normal Capacity state, and this call only feeds
 * the provenance caption, never a load/capacity figure.
 */
export async function fetchActiveScheduleRun(
  ctx: FetchCtx = {},
): Promise<ScheduleRunSummary | null> {
  try {
    return await apiGet<ScheduleRunSummary>('/schedule-runs/active', ctx);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
