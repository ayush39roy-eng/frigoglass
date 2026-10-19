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

/** What a priority change did (contract §1). `unchanged` only on the POST.
 *  P14 (ADR 0026): `applied` — a confirm with a current `preview_token`; the
 *  run was computed in-process and is already active. `dispatch_failed`: the
 *  change is saved and the project stays stale, but the recalculation could
 *  not be started (broker refused) — the user presses Recalculate. */
export type RecalcStatus = 'queued' | 'deferred' | 'not_needed' | 'unchanged' | 'applied' | 'dispatch_failed';

/** 409 code: the project has hard gates, so it must stay P1 (ADR 0015 §2). */
export const HARD_GATE_FORCES_P1 = 'HARD_GATE_FORCES_P1';

/** 409 code (P14, ADR 0026 §2): the inputs changed since the preview; nothing was written. */
export const PREVIEW_STALE = 'PREVIEW_STALE';
/** 503 code (P14 contract §1): the in-process preview exceeded its time cap. */
export const PREVIEW_TIMEOUT = 'PREVIEW_TIMEOUT';

// P11 contract §1; P14 contract §1 adds the optional `preview_token`.
export interface PriorityMoveRequest {
  priority: ProjectPriority;
  /** From `POST …/priority/preview`. With it the move is applied in-process
   *  (`recalc_status: "applied"`); without it, ADR 0015 behaviour. */
  preview_token?: string | null;
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
  // PLACEHOLDER (P14 contract §1) — present on `applied`; the same shapes as the preview.
  moved?: PriorityPreviewMoved | null;
  summary?: PriorityPreviewSummary | null;
  changes?: PriorityPreviewChange[];
  hidden_count?: number;
}

// ---------------------------------------------------------------------------
// P14 (ADR 0026, docs/API_CONTRACT_P14.md §1): preview, then confirm.
// PLACEHOLDER — written against the contract while backend A builds it.
// ---------------------------------------------------------------------------

export type PriorityPreviewResult = 'preview' | 'unchanged' | 'not_needed';

export interface PriorityPreviewRequest {
  priority: ProjectPriority;
}

/** The moved project's own finish, before (active run) → after (preview). */
export interface PriorityPreviewMoved {
  end_week_before: number | null;
  end_week_after: number | null;
  within_year_before: boolean | null;
  within_year_after: boolean | null;
  left_out_before: boolean | null;
  left_out_after: boolean | null;
}

/** Served counts over the other affected projects in the caller's scope. */
export interface PriorityPreviewSummary {
  affected: number;
  delayed: number;
  earlier: number;
  pushed_out_of_year: number;
  pulled_into_year: number;
}

/** One other project whose finish / within-year / left-out / on-hold would
 *  change. Ordered by the server (pushed out of year first). */
export interface PriorityPreviewChange {
  project_id: Id;
  name: string;
  hub: HubName;
  priority: ProjectPriority | null;
  end_week_before: number | null;
  end_week_after: number | null;
  within_year_before: boolean | null;
  within_year_after: boolean | null;
  left_out_before: boolean | null;
  left_out_after: boolean | null;
  blocked_before: boolean | null;
  blocked_after: boolean | null;
}

export interface PriorityPreviewResponse {
  result: PriorityPreviewResult;
  project_id: Id;
  from_priority: ProjectPriority | null;
  to_priority: ProjectPriority;
  /** The active run the preview is compared against. */
  baseline_run_id: Id | null;
  /** Opaque hash of the input snapshot + target priority; sent back on confirm. */
  preview_token: string | null;
  moved: PriorityPreviewMoved | null;
  summary: PriorityPreviewSummary;
  changes: PriorityPreviewChange[];
  /** Affected projects outside the caller's hub scope — a count only. */
  hidden_count: number;
  elapsed_ms: number | null;
  /** E.g. "no active run to compare against". */
  note?: string | null;
}

/** `POST /projects/{id}/priority/preview`. Writes nothing (ADR 0026 §1). */
export function previewProjectPriority(
  projectId: string,
  priority: ProjectPriority,
  options: Pick<ApiRequestOptions, 'signal'> = {},
): Promise<PriorityPreviewResponse> {
  const body: PriorityPreviewRequest = { priority };
  return apiSend<PriorityPreviewResponse>(
    'POST',
    `/projects/${encodeURIComponent(projectId)}/priority/preview`,
    body,
    { signal: options.signal },
  );
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

/** `POST /projects/{id}/priority`. Always 200; `recalc_status` says what happened.
 *  With `previewToken` (P14) it is the confirm of a preview: 409 `PREVIEW_STALE`
 *  if the inputs changed since. */
export function moveProjectPriority(
  projectId: string,
  priority: ProjectPriority,
  previewToken?: string | null,
): Promise<PriorityMoveResponse> {
  const body: PriorityMoveRequest = previewToken ? { priority, preview_token: previewToken } : { priority };
  return apiSend<PriorityMoveResponse>('POST', `/projects/${encodeURIComponent(projectId)}/priority`, body);
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
  recalc_status: Exclude<RecalcStatus, 'unchanged' | 'applied' | 'dispatch_failed'>;
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
