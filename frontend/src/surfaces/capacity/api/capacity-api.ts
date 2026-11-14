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
import { hasHubSelection, NO_HUB_SELECTION, toHubFilterParams, type HubSelection } from '@/stores/hub-filter';

import type {
  ClassBreakdown,
  EngineerUtilizationResponse,
  HubCapacitySummary,
  ScheduleRunSummary,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/** P12 (ADR 0020): the global hub filter as `hub_id`, ANDed server-side with the
 *  caller's scope. With a hub, `rows` holds that hub and `areas[]` the area
 *  containing it; lab figures stay region-wide (ADR 0020 §4). */
function withHubQuery(ctx: FetchCtx, hub: HubSelection = NO_HUB_SELECTION): ApiRequestOptions {
  // P13 (ADR 0025): with a country, hub rows are that country's hubs, `areas[]`
  // the containing area, and lab rows that lab region — all server-side.
  // Multi-select contract §2: hubs and countries as repeated params, UNIONED;
  // lab regions = scoped ∩ (regions of the hubs ∪ the countries), server-side.
  if (!hasHubSelection(hub)) return ctx;
  return { ...ctx, query: { ...toHubFilterParams(hub.hubIds, hub.regions) } };
}

export function fetchHubLoadVsCapacity(
  ctx: FetchCtx = {},
  hub?: HubSelection,
): Promise<HubCapacitySummary> {
  return apiGet<HubCapacitySummary>('/capacity/hub-load', withHubQuery(ctx, hub));
}

export function fetchClassBreakdown(
  ctx: FetchCtx = {},
  hub?: HubSelection,
): Promise<ClassBreakdown> {
  return apiGet<ClassBreakdown>('/capacity/class-breakdown', withHubQuery(ctx, hub));
}

export function fetchEngineerUtilization(
  ctx: FetchCtx = {},
  hub?: HubSelection,
): Promise<EngineerUtilizationResponse> {
  return apiGet<EngineerUtilizationResponse>('/capacity/engineer-utilization', withHubQuery(ctx, hub));
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
