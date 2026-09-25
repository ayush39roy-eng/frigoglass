/**
 * Fetchers for the Global RPD Dashboard surface (P4-T02).
 *
 * Thin wrappers over `apiGet` — no transformation, no derived numbers. Each maps
 * 1:1 to an endpoint in `backend/api/routers/dashboard.py` (+ one read of
 * `backend/api/routers/schedule_runs.py` for provenance enrichment).
 */

import { apiGet, ApiError, type ApiRequestOptions } from '@/lib/api/client';

import type {
  CompletingWithinYear,
  HubTypePipelineRow,
  PipelineTotals,
  ProjectFilterParams,
  ProjectFilterResult,
  ScheduleRunSummary,
  StatusOverview,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export function fetchPipelineTotals(ctx: FetchCtx = {}): Promise<PipelineTotals> {
  return apiGet<PipelineTotals>('/dashboard/pipeline-totals', ctx);
}

export function fetchStatusOverview(ctx: FetchCtx = {}): Promise<StatusOverview> {
  return apiGet<StatusOverview>('/dashboard/status-overview', ctx);
}

export function fetchHubTypePipeline(ctx: FetchCtx = {}): Promise<HubTypePipelineRow[]> {
  return apiGet<HubTypePipelineRow[]>('/dashboard/hub-type-pipeline', ctx);
}

export function fetchCompletingWithinYear(ctx: FetchCtx = {}): Promise<CompletingWithinYear> {
  return apiGet<CompletingWithinYear>('/dashboard/completing-within-year', ctx);
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
