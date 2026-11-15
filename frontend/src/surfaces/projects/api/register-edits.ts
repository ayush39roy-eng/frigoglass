/**
 * P35-T02 — the Projects register batch save (`POST /projects/register-edits`,
 * P35-T01, backend `schemas/project.py`). Hand-authored mirror, pinned by
 * `backend/tests/test_openapi_frontend_contract.py`.
 *
 * One Save sends ONE request with only the changed fields of each changed row.
 * The server validates every row (the single PATCH's rules), writes all or
 * nothing, and dispatches ONE greedy run for the batch (D35-5, OQ #83). The
 * browser never splits an effort figure or derives a week (I9).
 */

import { ApiError, apiSend } from '@/lib/api/client';
import type { RecalcStatus } from '@/lib/api/priority-move';
import type { Id, WeekNumber } from '@/types/common';
import type { ProjectStatus } from '@/types/enums';

/** One project's changes. Only the keys sent are applied; `null` clears
 *  `leader_engineer_id`, the actual weeks and the effort figures (a null
 *  `status` is a 422 `NULL_NOT_ALLOWED`, so the grid never sends one). */
export interface RegisterEditPatch {
  project_id: Id;
  status?: ProjectStatus | null;
  leader_engineer_id?: Id | null;
  actual_start_week?: WeekNumber | null;
  actual_end_week?: WeekNumber | null;
  /** Design / lab time figure (ADR 0041), ≥ 0, 2 dp. `null` = "↺ reset". */
  design_effort_weeks?: number | null;
  lab_effort_weeks?: number | null;
}

/** 1..100 patches, applied all-or-nothing. */
export interface RegisterEditsRequest {
  edits: RegisterEditPatch[];
}

/** Always 200 on success; the recalc fields mirror `PriorityMoveResponse`. */
export interface RegisterEditsResponse {
  project_ids: Id[];
  projects_marked_stale: Id[];
  recalc_status: RecalcStatus;
  /** Only when `queued`. */
  schedule_run_id: Id | null;
  /** Only when `queued` and a run was active. */
  baseline_run_id: Id | null;
  task_id: string | null;
}

/** One element of `detail.errors` on 403 `REGISTER_EDITS_FORBIDDEN` / 422
 *  `REGISTER_EDITS_INVALID` (error bodies are not OpenAPI components). `code`
 *  is the single PATCH's code (e.g. `ACTUAL_END_BEFORE_START`), or
 *  `DUPLICATE_PROJECT` / `FORBIDDEN_PROJECT` / `STATUS_DRAFT_SUBMIT_ONLY`. */
export interface RegisterEditError {
  project_id: Id;
  code: string;
  message: string;
}

export const REGISTER_EDITS_INVALID = 'REGISTER_EDITS_INVALID';
export const REGISTER_EDITS_FORBIDDEN = 'REGISTER_EDITS_FORBIDDEN';
/** Server cap on one batch (`REGISTER_EDITS_MAX`). */
export const REGISTER_EDITS_MAX = 100;

export function saveRegisterEdits(body: RegisterEditsRequest): Promise<RegisterEditsResponse> {
  return apiSend<RegisterEditsResponse>('POST', '/projects/register-edits', body);
}

function isEditError(v: unknown): v is RegisterEditError {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.project_id === 'string' && typeof o.code === 'string' && typeof o.message === 'string';
}

/** The per-row errors of a 422 / 403 batch answer; `[]` for anything else. */
export function registerEditErrors(err: unknown): RegisterEditError[] {
  if (!(err instanceof ApiError) || !err.detail) return [];
  if (err.code !== REGISTER_EDITS_INVALID && err.code !== REGISTER_EDITS_FORBIDDEN) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.detail);
  } catch {
    return [];
  }
  const list: unknown =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { errors?: unknown }).errors : null;
  return Array.isArray(list) ? list.filter(isEditError) : [];
}

/** Readable text for the per-row codes the grid can trigger. Unknown codes
 *  print the server's own message. */
const ROW_ERROR_COPY: Record<string, string> = {
  ACTUAL_END_BEFORE_START: 'Actual end is before actual start.',
  NULL_NOT_ALLOWED: 'A required field was cleared.',
  DRAFT_RETIRED: 'Draft is no longer a project status.',
  STATUS_DRAFT_SUBMIT_ONLY: 'A Draft project leaves Draft through Edit registration (Submit).',
  FORBIDDEN_PROJECT: 'You cannot edit this project.',
  DUPLICATE_PROJECT: 'This project was listed twice.',
};

export function registerRowErrorText(error: RegisterEditError): string {
  const known = ROW_ERROR_COPY[error.code];
  return known && error.code !== 'NULL_NOT_ALLOWED' ? known : error.message || known || error.code;
}
