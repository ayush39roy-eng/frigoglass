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
import type { LabRegion } from '@/types/enums';

import type {
  ClassBreakdown,
  EngineerUtilizationResponse,
  HubCapacitySummary,
  ScheduleRunSummary,
  UtilizationMatrix,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/** P12 (ADR 0020): the global hub filter as `hub_id`, ANDed server-side with the
 *  caller's scope. With a hub, `rows` holds that hub and `areas[]` the area
 *  containing it; lab figures stay region-wide (ADR 0020 §4). */
function withHubQuery(
  ctx: FetchCtx,
  hubId: string | null | undefined,
  region?: LabRegion | null,
): ApiRequestOptions {
  // P13 (ADR 0025): with a country, hub rows are that country's hubs, `areas[]`
  // the containing area, and lab rows that lab region — all server-side.
  if (!hubId && !region) return ctx;
  return { ...ctx, query: { hub_id: hubId ?? undefined, region: region ?? undefined } };
}

export function fetchHubLoadVsCapacity(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
): Promise<HubCapacitySummary> {
  return apiGet<HubCapacitySummary>('/capacity/hub-load', withHubQuery(ctx, hubId, region));
}

export function fetchClassBreakdown(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
): Promise<ClassBreakdown> {
  return apiGet<ClassBreakdown>('/capacity/class-breakdown', withHubQuery(ctx, hubId, region));
}

export function fetchUtilizationMatrix(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
): Promise<UtilizationMatrix> {
  return apiGet<UtilizationMatrix>('/capacity/utilization-matrix', withHubQuery(ctx, hubId, region));
}

export function fetchEngineerUtilization(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
): Promise<EngineerUtilizationResponse> {
  return apiGet<EngineerUtilizationResponse>('/capacity/engineer-utilization', withHubQuery(ctx, hubId, region));
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
