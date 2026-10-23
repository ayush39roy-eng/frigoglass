/**
 * Fetchers for the Global RPD Dashboard surface (P4-T02).
 *
 * Thin wrappers over `apiGet` — no transformation, no derived numbers. Each maps
 * 1:1 to an endpoint in `backend/api/routers/dashboard.py` (+ one read of
 * `backend/api/routers/schedule_runs.py` for provenance enrichment).
 */

import { apiGet, ApiError, type ApiRequestOptions } from '@/lib/api/client';
import type { CategoryFilterValue, TypeFilterValue } from '@/lib/multi-select-filter';
import type { LabRegion } from '@/types/enums';

import type {
  CompletingWithinYear,
  DashboardAnalytics,
  HubTypePipelineRow,
  PipelineTotals,
  ProjectFacets,
  ProjectFilterParams,
  ProjectFilterResult,
  RegionSummary,
  ScheduleRunSummary,
  StatusOverview,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/** P31: the Dashboard-wide category / type selection (repeatable params; OR
 *  within, AND across, empty = no filter). Served figures only (I9). */
export interface DashboardSelection {
  categories: readonly CategoryFilterValue[];
  types: readonly TypeFilterValue[];
}

/** P12 (ADR 0020) + P13 (ADR 0025): the global hub / country filter as
 *  `hub_id` / `region`. The server ANDs them with the caller's scope and
 *  computes every total for the filtered set (I9/I19/I23); "All hubs" sends no
 *  param at all. P31: plus the Dashboard selection as repeated `category` /
 *  `type` params (none sent when empty). */
function withHubQuery(
  ctx: FetchCtx,
  hubId: string | null | undefined,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): ApiRequestOptions {
  const categories = selection?.categories ?? [];
  const types = selection?.types ?? [];
  if (!hubId && !region && categories.length === 0 && types.length === 0) return ctx;
  return {
    ...ctx,
    query: {
      hub_id: hubId ?? undefined,
      region: region ?? undefined,
      category: categories.length > 0 ? categories : undefined,
      type: types.length > 0 ? types : undefined,
    },
  };
}

export function fetchPipelineTotals(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): Promise<PipelineTotals> {
  return apiGet<PipelineTotals>('/dashboard/pipeline-totals', withHubQuery(ctx, hubId, region, selection));
}

export function fetchStatusOverview(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): Promise<StatusOverview> {
  return apiGet<StatusOverview>('/dashboard/status-overview', withHubQuery(ctx, hubId, region, selection));
}

export function fetchHubTypePipeline(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): Promise<HubTypePipelineRow[]> {
  return apiGet<HubTypePipelineRow[]>('/dashboard/hub-type-pipeline', withHubQuery(ctx, hubId, region, selection));
}

export function fetchCompletingWithinYear(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): Promise<CompletingWithinYear> {
  return apiGet<CompletingWithinYear>('/dashboard/completing-within-year', withHubQuery(ctx, hubId, region, selection));
}

/** P13 (API_CONTRACT_P13 §2): per-country counts and served shares. */
export function fetchRegionSummary(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): Promise<RegionSummary> {
  return apiGet<RegionSummary>('/dashboard/region-summary', withHubQuery(ctx, hubId, region, selection));
}

/** P13-T10 (API_CONTRACT_P13 §5): served breakdowns and the completing
 *  Hub × Type cross-tab, for the "Analytics & breakdown" section. */
export function fetchDashboardAnalytics(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): Promise<DashboardAnalytics> {
  return apiGet<DashboardAnalytics>('/dashboard/analytics', withHubQuery(ctx, hubId, region, selection));
}

/** P13 (API_CONTRACT_P13 §3): leaders and current steps present in the scoped,
 *  filtered set, for the register's dropdowns. */
export function fetchProjectFacets(
  ctx: FetchCtx = {},
  hubId?: string | null,
  region?: LabRegion | null,
  selection?: DashboardSelection,
): Promise<ProjectFacets> {
  return apiGet<ProjectFacets>('/dashboard/projects/facets', withHubQuery(ctx, hubId, region, selection));
}

export function fetchDashboardProjects(
  params: ProjectFilterParams,
  ctx: FetchCtx = {},
): Promise<ProjectFilterResult> {
  return apiGet<ProjectFilterResult>('/dashboard/projects', {
    ...ctx,
    query: {
      hub_id: params.hub_id,
      category: params.category,
      status_: params.status_,
      priority: params.priority,
      region: params.region,
      q: params.q,
      type: params.type,
      leader_engineer_id: params.leader_engineer_id,
      current_step: params.current_step,
      sort: params.sort,
    },
  });
}

/**
 * The single active schedule run. Returns `null` (not a throw) on 404 — "no
 * schedule computed yet" is a normal Dashboard state, and this call only feeds
 * the provenance caption, never a headline number.
 */
export async function fetchActiveScheduleRun(ctx: FetchCtx = {}): Promise<ScheduleRunSummary | null> {
  try {
    return await apiGet<ScheduleRunSummary>('/schedule-runs/active', ctx);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
