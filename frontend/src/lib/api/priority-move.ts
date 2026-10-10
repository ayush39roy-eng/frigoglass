// PLACEHOLDER (P11 contract §1–§3, docs/API_CONTRACT_P11.md) — hand-authored
// mirrors of the P11-T01 backend shapes, written while the backend was built in
// parallel. Reconcile against backend/schemas/ once the OpenAPI is regenerated.

/**
 * Priority move (ADR 0015) and the run-to-run change list.
 *
 * Thin wrappers only. The server decides whether a move schedules
 * (`recalc_status`) and which projects moved (`GET …/changes`). The browser
 * never diffs two runs itself (I20).
 */

import type { Id } from '@/types/common';
import type { HubName, ProjectPriority } from '@/types/enums';

import { apiGet, apiSend, type ApiRequestOptions } from './client';

/** What a priority change did (contract §1). `unchanged` only on the POST. */
export type RecalcStatus = 'queued' | 'deferred' | 'not_needed' | 'unchanged';

/** 409 code: the project has hard gates, so it must stay P1 (ADR 0015 §2). */
export const HARD_GATE_FORCES_P1 = 'HARD_GATE_FORCES_P1';

// PLACEHOLDER (P11 contract §1)
export interface PriorityMoveRequest {
  priority: ProjectPriority;
}

// PLACEHOLDER (P11 contract §1)
export interface PriorityMoveResponse {
  project_id: Id;
  priority_before: ProjectPriority | null;
  priority_after: ProjectPriority;
  recalc_status: RecalcStatus;
  /** Set only when `queued`. */
  schedule_run_id: Id | null;
  /** The run active before the move; null if none / not queued. */
  baseline_run_id: Id | null;
  /** Celery task id, set only when `queued`. */
  task_id: string | null;
}

// PLACEHOLDER (P11 contract §3)
export interface ScheduleRunChangeRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
  /** The project's live priority now. */
  priority: ProjectPriority | null;
  before_projected_end_week: number | null;
  after_projected_end_week: number | null;
  /** after − before, served; null if either is null. */
  delta_weeks: number | null;
  before_within_year: boolean;
  after_within_year: boolean;
  before_left_out: boolean;
  after_left_out: boolean;
  before_blocked: boolean;
  after_blocked: boolean;
  /** No outcome row in the baseline run. */
  is_new: boolean;
  /** No outcome row in the new run. */
  is_removed: boolean;
}

// PLACEHOLDER (P11 contract §3)
export interface ScheduleRunChanges {
  run_id: Id;
  run_version: number;
  against_run_id: Id;
  against_run_version: number;
  /** Changed projects outside the caller's hub scope — a count only. */
  hidden_count: number;
  /** Only projects whose compared fields differ, sorted by the server. */
  rows: ScheduleRunChangeRow[];
}

/** `POST /projects/{id}/priority`. Always 200; `recalc_status` says what happened. */
export function moveProjectPriority(projectId: string, priority: ProjectPriority): Promise<PriorityMoveResponse> {
  const body: PriorityMoveRequest = { priority };
  return apiSend<PriorityMoveResponse>('POST', `/projects/${projectId}/priority`, body);
}

/** `GET /schedule-runs/{run}/changes?against={baseline}`. 409 `RUN_NOT_COMPLETED`
 *  if the run has not completed. Rows are hub-scoped by the server. */
export function fetchScheduleRunChanges(
  runId: string,
  againstRunId: string,
  options: Pick<ApiRequestOptions, 'signal'> = {},
): Promise<ScheduleRunChanges> {
  return apiGet<ScheduleRunChanges>(`/schedule-runs/${runId}/changes`, {
    query: { against: againstRunId },
    signal: options.signal,
  });
}

/**
 * The recalc signal a `PATCH /projects/{id}` carries in its response headers
 * when the priority changed (contract §2). Header names are case-insensitive.
 */
export interface PatchRecalcSignal {
  recalc_status: Exclude<RecalcStatus, 'unchanged'>;
  schedule_run_id: Id | null;
  baseline_run_id: Id | null;
}

const PATCH_RECALC_VALUES = new Set<string>(['queued', 'deferred', 'not_needed']);

/** Read the three `X-Schedule-*` headers verbatim. `null` when the priority did
 *  not change (header absent) or the value is not one the contract defines. */
export function readRecalcHeaders(headers: Headers): PatchRecalcSignal | null {
  const raw = headers.get('X-Schedule-Recalc')?.trim();
  if (!raw || !PATCH_RECALC_VALUES.has(raw)) return null;
  const runId = headers.get('X-Schedule-Run-Id')?.trim() || null;
  const baselineId = headers.get('X-Schedule-Baseline-Run-Id')?.trim() || null;
  return {
    recalc_status: raw as PatchRecalcSignal['recalc_status'],
    schedule_run_id: runId,
    baseline_run_id: baselineId,
  };
}
