// P61 (ADR 0069): mirrors backend/schemas/schedule_run.py
// `PlanFreshnessResponse` and `RecalculateNowResponse`.

import type { Id } from '@/types/common';

import { apiGet, apiSend, type ApiRequestOptions } from './client';

/** `GET /schedule-runs/freshness` — served, readable by everyone. */
export interface PlanFreshness {
  /** Projects changed (`schedule_stale`) since the active run. */
  stale_project_count: number;
  /** ISO timestamp of the active run; null before the first run. */
  last_run_at: string | null;
  last_run_version: number | null;
  /** A schedule run is queued or running now. */
  run_in_flight: boolean;
  /** Not tracked by the server yet (always null). */
  oldest_stale_since: string | null;
}

/** `POST /schedule-runs/recalculate` (202, `RecalculateNowResponse`): ONE
 *  greedy run (ADR 0069). `queued` = follow `schedule_run_id`; `deferred` = a
 *  run was in flight, the ADR 0023 follow-up is registered (follow
 *  `in_flight_run_id` meanwhile); `dispatch_failed` = the broker refused. */
export interface PlanRecalculateResponse {
  recalc_status: 'queued' | 'deferred' | 'dispatch_failed';
  schedule_run_id: Id | null;
  baseline_run_id: Id | null;
  task_id: string | null;
  in_flight_run_id: Id | null;
  stale_project_count: number;
}

export const PLAN_FRESHNESS_PATH = '/schedule-runs/freshness';
export const PLAN_RECALCULATE_PATH = '/schedule-runs/recalculate';

export function fetchPlanFreshness(options: ApiRequestOptions = {}): Promise<PlanFreshness> {
  return apiGet<PlanFreshness>(PLAN_FRESHNESS_PATH, options);
}

export function recalculatePlan(): Promise<PlanRecalculateResponse> {
  return apiSend<PlanRecalculateResponse>('POST', PLAN_RECALCULATE_PATH);
}

/** The run to follow: the queued run, else the in-flight one; null if none. */
export function recalculateRunId(res: PlanRecalculateResponse | undefined | null): Id | null {
  if (!res || typeof res !== 'object') return null;
  return res.schedule_run_id ?? res.in_flight_run_id ?? null;
}
