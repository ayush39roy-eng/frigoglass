// Mirrors of backend/schemas/checkin.py (P12 contract §5, ADR 0023), reconciled
// field for field with the P12-T03 backend on 2026-10-10.

/**
 * Weekly check-in (ADR 0021). Thin wrappers only: the server decides which
 * stages are due, who may check in (`can_check_in`), the tracking status and
 * the "per plan" percentage. The browser never derives any of them.
 *
 * Kept in `lib/api` (not the lazy surface) because the sidebar's due-count
 * badge reads `GET /check-ins/due` from the always-loaded shell.
 */

import { useQuery } from '@tanstack/react-query';

import type { TrackingStatus } from '@/components/shared/tracking-status-meta';
import { queryKeys } from '@/lib/query-keys';
import type { Id } from '@/types/common';
import type { HubName, LabRegion, WorkflowStepKind, WorkflowStepStatus } from '@/types/enums';

import { ApiError, apiGet, apiSend, type ApiRequestOptions } from './client';

export interface CheckInDueStage {
  step_id: string;
  step_name: string;
  kind: WorkflowStepKind;
  status: WorkflowStepStatus;
  percent_complete: number;
  blocked_reason: string | null;
  planned_start_week: number | null;
  planned_end_week: number | null;
  /** Share of the planned window elapsed at CURRENT_WEEK, 0..100 — served, display only (ADR 0021 §5). */
  plan_percent: number | null;
  checked_in_this_week: boolean;
  last_checkin_week: number | null;
  can_check_in: boolean;
}

export interface CheckInDueProject {
  project_id: Id;
  name: string;
  hub: HubName;
  hub_id: Id;
  tracking_status: TrackingStatus;
  schedule_stale: boolean;
  stages: CheckInDueStage[];
}

export interface CheckInDueSummary {
  due_stages: number;
  checked_in_stages: number;
  projects_live: number;
  projects_due: number;
  projects_overdue: number;
  /** Projects among these with `schedule_stale = true` (the planners' Recalculate hint). */
  stale_projects: number;
}

export interface CheckInDueResponse {
  /** CURRENT_WEEK. */
  week: number;
  summary: CheckInDueSummary;
  projects: CheckInDueProject[];
}

export interface CheckInEntry {
  project_id: Id;
  step_id: string;
  status: WorkflowStepStatus;
  percent_complete: number;
  blocked_reason: string | null;
  note: string | null;
}

export interface CheckInSubmitRequest {
  entries: CheckInEntry[];
}

export interface CheckInSubmitResponse {
  week: number;
  accepted: number;
  projects_marked_stale: Id[];
  /** One greedy run per batch (ADR 0023 §1). `deferred` ⇒ a coalesced follow-up run is recorded. */
  recalc_status: 'queued' | 'deferred' | 'not_needed' | 'dispatch_failed';
  /** Set only when `queued`. */
  schedule_run_id: Id | null;
  /** The run active before the batch; null if none / not queued. */
  baseline_run_id: Id | null;
  task_id: string | null;
}

export interface CheckInHistoryRow {
  week: number;
  status: WorkflowStepStatus;
  percent_complete: number;
  blocked_reason: string | null;
  note: string | null;
  /** Full name of the submitter — shown only on the stage's own history (GDPR, ADR 0021 §7). */
  by: string;
  created_at: string;
}

/** The batch error code: any invalid entry fails the whole batch (contract §5). */
export const CHECKIN_INVALID = 'CHECKIN_INVALID';

/** One per-entry error of a 422 `CHECKIN_INVALID`. `index` is into `entries`. */
export interface CheckInEntryError {
  index: number;
  code: string;
  message: string;
}

/** Max entries per batch (contract §5). */
export const CHECKIN_BATCH_MAX = 100;
/** Max note length (contract §0, stage_checkins CHECK). */
export const CHECKIN_NOTE_MAX = 1000;
/** Max hold-reason length (`schemas/checkin.py::BLOCKED_REASON_MAX_LENGTH`). */
export const CHECKIN_REASON_MAX = 2000;

export function fetchCheckInsDue(
  hubId: string | null,
  options: Pick<ApiRequestOptions, 'signal'> = {},
  region: LabRegion | null = null,
): Promise<CheckInDueResponse> {
  return apiGet<CheckInDueResponse>('/check-ins/due', {
    query: { hub_id: hubId ?? undefined, region: region ?? undefined },
    signal: options.signal,
  });
}

export function submitCheckIns(entries: CheckInEntry[]): Promise<CheckInSubmitResponse> {
  const body: CheckInSubmitRequest = { entries };
  return apiSend<CheckInSubmitResponse>('POST', '/check-ins', body);
}

export function fetchCheckInHistory(
  projectId: string,
  stepId: string,
  options: Pick<ApiRequestOptions, 'signal'> = {},
): Promise<CheckInHistoryRow[]> {
  return apiGet<CheckInHistoryRow[]>('/check-ins/history', {
    query: { project_id: projectId, step_id: stepId },
    signal: options.signal,
  });
}

function isEntryError(value: unknown): value is CheckInEntryError {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.index === 'number' && typeof v.code === 'string' && typeof v.message === 'string';
}

/**
 * The per-entry errors of a 422 `CHECKIN_INVALID`, read from the error body's
 * `detail` (`{errors: […]}` per the contract; a bare list is accepted too,
 * since `CodedHTTPException.detail` may also be a list). Empty when the error
 * is anything else.
 */
export function checkInEntryErrors(err: unknown): CheckInEntryError[] {
  if (!(err instanceof ApiError) || err.code !== CHECKIN_INVALID || !err.detail) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.detail);
  } catch {
    return [];
  }
  const list: unknown =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { errors?: unknown }).errors : parsed;
  return Array.isArray(list) ? list.filter(isEntryError) : [];
}

/** `GET /check-ins/due?hub_id=`. The sidebar badge and the check-in page share
 *  this key, so one fetch serves both. */
export function useCheckInsDue(hubId: string | null, enabled = true, region: LabRegion | null = null) {
  return useQuery({
    // P13 (ADR 0025): the country filter is keyed and sent beside the hub.
    queryKey: queryKeys.checkInsDue(hubId, region),
    queryFn: ({ signal }) => fetchCheckInsDue(hubId, { signal }, region),
    enabled,
  });
}
