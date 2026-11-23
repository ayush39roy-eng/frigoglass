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

import { ApiError, apiGet, apiSend, type ApiRequestOptions } from '@/lib/api/client';
import type { EditBase } from '@/lib/api/edit-conflict';
import type { RecalcStatus } from '@/lib/api/priority-move';
import type { Id, WeekNumber } from '@/types/common';
import type {
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
  WorkflowStepKind,
  WorkflowStepStatus,
} from '@/types/enums';

/** Register popup (owner 2026-11-17, ADR 0049): one step's exclusion flag.
 *  `false` re-includes an excluded step; "include" on a step that is not
 *  excluded is a no-op on the server (R35-2). */
export interface StepExclusionEdit {
  step_code: string;
  step_excluded: boolean;
}

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
  /** Register popup (2026-11-17, API_CONTRACT_REGISTER_POPUP §2): sent in the
   *  batch, not the PATCH, so one Save is one recalculation. A `null` hub or
   *  lab flag is a 422 `NULL_NOT_ALLOWED`: the popup never sends one. */
  hub_id?: Id | null;
  /** "Needs lab testing": off skips every lab step (ADR 0007 §5). */
  certification_testing_required?: boolean | null;
  /** Only the steps whose flag the user changed (`null` = no change). */
  step_exclusions?: StepExclusionEdit[] | null;
  /** The step the project is on now (§2.2): the server marks the earlier steps
   *  Done and the later ones Not Started. `null` = no change. */
  current_step_code?: string | null;
  /** P59 (owner 2026-11-23, bulk edit): the project's priority band. A project
   *  moved to a new band goes to the END of that band; the batch is still one
   *  recalculation. Commercialized / Cancelled rows are refused per row with
   *  `PRIORITY_NOT_APPLICABLE` (ADR 0067). `null` = no change. */
  priority?: ProjectPriority | null;
  /** P59: a category code (`GET /reference/categories`) of the project's
   *  workflow. `null` = no change. */
  category?: ProjectCategory | null;
  /** P59: the project type (the register's "Type"). `null` = no change. */
  project_type?: ProjectType | null;
  /** P47 (ADR 0059 C1): per row, the value the user started from for each
   *  field this patch changes (`step_exclusions` lists the served flag of each
   *  step it changes). A differing stored value is a 409 `EDIT_CONFLICT`. */
  base?: EditBase;
}

/** A step's status on the register read (contract §1): the stored stage
 *  status, or `Skipped` when the step's effective duration is 0 (excluded, a
 *  0-week copy, a lab step with lab testing off, or a split share of 0). A
 *  Skipped step cannot be the current step. */
export type RegisterStepStatus = WorkflowStepStatus | 'Skipped';

/** One step of `GET /projects/{id}/register-steps` (backend `RegisterStepRead`),
 *  in workflow order. Every flag is served; the popup derives none (I9). */
export interface RegisterStep {
  step_code: string;
  step_name: string;
  kind: WorkflowStepKind;
  status: RegisterStepStatus;
  step_excluded: boolean;
  /** False = the old tool's "N/A" step (R35-2): never excludable. */
  applicable: boolean;
  /** The server's verdict whether this (not excluded) step may be excluded
   *  now: applicable, not stored Done, project not frozen / closed. */
  excludable: boolean;
  is_current: boolean;
}

/** Backend `RegisterStepsRead`. */
export interface RegisterStepsResponse {
  project_id: Id;
  current_step_code: string | null;
  /** The scheduler's forecast finish (the register list's `end_week`), read-only. */
  end_week: WeekNumber | null;
  /** Calculated design / lab weeks (same rule as the register row; excluded steps add 0). */
  design_weeks_calculated: number;
  lab_weeks_calculated: number;
  steps: RegisterStep[];
}

export function fetchRegisterSteps(
  projectId: Id,
  ctx: Pick<ApiRequestOptions, 'signal'> = {},
): Promise<RegisterStepsResponse> {
  return apiGet<RegisterStepsResponse>(`/projects/${encodeURIComponent(projectId)}/register-steps`, ctx);
}

/** 1..100 patches, applied all-or-nothing. */
export interface RegisterEditsRequest {
  /** P61 (ADR 0069): added centrally by `lib/api/defer-recalc.ts` when Auto-recalculate is Off. */
  defer_recalc?: boolean;
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
  /** Register popup contract §2.5 (R35-7): every step whose effective duration
   *  changed with this Save, by project then workflow order. Served; the
   *  browser never re-splits. Optional only so a pre-contract API still parses. */
  eff_changes?: RegisterEditEffChange[];
}

/** One step whose effective duration (weeks) changed with a register Save. */
export interface RegisterEditEffChange {
  project_id: Id;
  step_code: string;
  eff_before: number;
  eff_after: number;
  /** `eff_before == 0 && eff_after > 0`. */
  revived: boolean;
  /** `eff_before > 0 && eff_after == 0`. */
  skipped_now: boolean;
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
  // Register popup (ADR 0049, R35-2 / R35-5).
  STEP_DONE: 'A Done step cannot be excluded.',
  STEP_NOT_APPLICABLE: 'That step does not apply to this project (N/A).',
  UNKNOWN_STEP: 'That step is not in this project’s workflow.',
  EFFORT_NEEDS_A_STEP: 'A design / lab time needs at least one step of its kind: clear the time or keep one step.',
  NO_STEPS_LEFT: 'The project needs at least one step that runs.',
  PROJECT_FROZEN: 'The project is frozen: its steps cannot change.',
  PROJECT_CLOSED: 'The project is Cancelled or Commercialized: its steps cannot change.',
  UNKNOWN_HUB: 'That hub does not exist.',
  WORKFLOW_CHANGE_WITH_PROGRESS: 'This hub uses the other workflow, and the project has recorded progress: it cannot move.',
  INCONSISTENT_PROGRESS: 'The recorded weeks of the steps do not allow this current step.',
  // P59: priority in the batch (ADR 0067).
  PRIORITY_NOT_APPLICABLE: 'The project is Commercialized or Cancelled: a priority does not apply.',
};

/** Codes whose server message is more precise than the fixed copy (it names
 *  the field, the step or the kind). */
const PREFER_SERVER_MESSAGE = new Set(['NULL_NOT_ALLOWED', 'EFFORT_NEEDS_A_STEP', 'INCONSISTENT_PROGRESS']);

export function registerRowErrorText(error: RegisterEditError): string {
  const known = ROW_ERROR_COPY[error.code];
  return known && !PREFER_SERVER_MESSAGE.has(error.code) ? known : error.message || known || error.code;
}
