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

import type { EditBase } from '@/lib/api/edit-conflict';
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
  /** P47 (ADR 0059 C1): the value as read of each field sent; `{}` = no check. */
  base?: EditBase;
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
  /** P42 (API_CONTRACT_P42 §7): the stored flags on each side; null when that
   *  side has no outcome. */
  counts_toward_year_before?: boolean | null;
  counts_toward_year_after?: boolean | null;
  not_scheduled_priority_before?: boolean | null;
  not_scheduled_priority_after?: boolean | null;
  /** P42 (R42-8): `leaves_plan` (into P4 / Q) or `joins_queue` (now a queued
   *  P3); null otherwise. The moved project is never "drops out of the year". */
  effect?: PriorityMoveEffect | null;
  /** P42: the served copy — "leaves the plan" / "joins the queue — not counted
   *  this year". Printed verbatim. */
  effect_label?: string | null;
}

/** P42 (R42-8): what a priority move does to the moved project's plan. */
export type PriorityMoveEffect = 'leaves_plan' | 'joins_queue';

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
  /** P42 (API_CONTRACT_P42 §7): the stored flags; a side with no outcome reads
   *  counts = true, not scheduled = false. */
  counts_toward_year_before?: boolean;
  counts_toward_year_after?: boolean;
  not_scheduled_priority_before?: boolean;
  not_scheduled_priority_after?: boolean;
  /** P42 (R42-1): the label of `priority`. */
  priority_label?: string | null;
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

// ---------------------------------------------------------------------------
// P36 (ADR 0050, docs/API_CONTRACT_P36.md §2–§3): rank within a priority band.
// PLACEHOLDER — written against the contract while P36-T03 builds it.
// The responses reuse the priority move's preview / confirm shapes.
// ---------------------------------------------------------------------------

/** 409 code: the project has no priority or a non-schedulable status. */
export const NOT_RANKABLE = 'NOT_RANKABLE';
/** 422 code: the anchor is not ranked in the same band (or is out of scope, or is the project itself). */
export const NOT_SAME_BAND = 'NOT_SAME_BAND';
/** 422 code: both anchors were given. */
export const BOTH_ANCHORS = 'BOTH_ANCHORS';
/** 422 code (owner request 2026-11-17): `to_rank` is outside 1..n of the full band. */
export const BAD_RANK = 'BAD_RANK';

/**
 * Where the project goes inside its band, relative to one project of the full
 * band (so a drop on a filtered board is well defined, R36-8). At most one is
 * set; both null = last in the band. The server decides the resulting rank.
 */
export interface BandRankAnchorPlacement {
  before_project_id: Id | null;
  after_project_id: Id | null;
}

/**
 * Owner request 2026-11-17: the target position in the FULL band (1-based), for
 * the ↑ / ↓ buttons (current rank ± 1) and a typed position. Never combined with
 * the anchors (422). Out of range → 422 `BAD_RANK`; the same rank → `unchanged`.
 */
export interface BandRankToRankPlacement {
  to_rank: number;
}

export type BandRankPlacement = BandRankAnchorPlacement | BandRankToRankPlacement;

export function isToRankPlacement(placement: BandRankPlacement): placement is BandRankToRankPlacement {
  return 'to_rank' in placement;
}

/** `POST /projects/{id}/band-rank/preview` body: anchors, or `to_rank` alone. */
export type BandRankPreviewRequest = BandRankAnchorPlacement | BandRankToRankPlacement;

/** `POST /projects/{id}/band-rank`: the previewed placement plus its token. */
export type BandRankMoveRequest = BandRankPreviewRequest & { preview_token: string };

/** The wire body for a placement: only the keys of its own form, so a `to_rank`
 *  request never carries anchor keys (the server answers 422 to both). */
function placementBody(placement: BandRankPlacement): BandRankPreviewRequest {
  if (isToRankPlacement(placement)) return { to_rank: placement.to_rank };
  return { before_project_id: placement.before_project_id, after_project_id: placement.after_project_id };
}

/** `POST /projects/{id}/band-rank/preview`. Writes nothing (contract §2). */
export function previewProjectBandRank(
  projectId: string,
  placement: BandRankPlacement,
  options: Pick<ApiRequestOptions, 'signal'> = {},
): Promise<PriorityPreviewResponse> {
  return apiSend<PriorityPreviewResponse>(
    'POST',
    `/projects/${encodeURIComponent(projectId)}/band-rank/preview`,
    placementBody(placement),
    { signal: options.signal },
  );
}

/** `POST /projects/{id}/band-rank` (contract §3): the confirm of a re-rank
 *  preview. 409 `PREVIEW_STALE` if the band changed since. */
export function moveProjectBandRank(
  projectId: string,
  placement: BandRankPlacement,
  previewToken: string,
): Promise<PriorityMoveResponse> {
  const body: BandRankMoveRequest = { ...placementBody(placement), preview_token: previewToken };
  return apiSend<PriorityMoveResponse>('POST', `/projects/${encodeURIComponent(projectId)}/band-rank`, body);
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
  /** P42 (API_CONTRACT_P42 §9): the stored flags on each side (false with no
   *  outcome row). A project that only changed class is listed (I20). */
  before_counts_toward_year: boolean;
  after_counts_toward_year: boolean;
  before_not_scheduled_priority: boolean;
  after_not_scheduled_priority: boolean;
  /** P42 (R42-1): the label of `priority`. */
  priority_label: string | null;
}

// PLACEHOLDER (P11 contract §3)
export interface ScheduleRunChanges {
  run_id: Id;
  run_version: number;
  against_run_id: Id;
  against_run_version: number;
  /** P37 R37-4: the baseline run's stored `current_week`. */
  baseline_week: number;
  /** P37 R37-4: this run's stored `current_week`. When it differs from
   *  `baseline_week` the list "includes the move from W<a> to W<b>". */
  run_week: number;
  /** Changed projects outside the caller's hub scope — a count only. */
  hidden_count: number;
  /** Only projects whose compared fields differ, sorted by the server. */
  rows: ScheduleRunChangeRow[];
  /** P53 (API_CONTRACT_P53 §3): the baseline is pre-P53 and this run is P53 —
   *  the list "includes the scheduling-rule change (P53)". */
  includes_rule_change?: boolean;
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
