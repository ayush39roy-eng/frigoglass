/**
 * Register popup (owner 2026-11-17): which popup field a batch error code
 * points at. Every error is shown inline on its field; codes that name no
 * field show above the section.
 */

import { registerRowErrorText, type RegisterEditError } from '../api/register-edits';
import type { PopupScalarField } from './register-popup';

/** Which popup field a batch error code points at (the error is always listed
 *  too). Codes not listed show above the section. */
export type PopupErrorTarget = PopupScalarField | 'steps';

const ERROR_FIELD: Record<string, PopupErrorTarget[]> = {
  ACTUAL_END_BEFORE_START: ['actual_end_week'],
  EFFORT_SPLIT_REJECTED: ['design_effort_weeks', 'lab_effort_weeks'],
  NULL_NOT_ALLOWED: ['status'],
  DRAFT_RETIRED: ['status'],
  STATUS_DRAFT_SUBMIT_ONLY: ['status'],
  STEP_DONE: ['steps'],
  NO_STEPS_LEFT: ['steps'],
  // The message names the kind; the row does not (contract §2.3).
  EFFORT_NEEDS_A_STEP: ['steps'],
  PROJECT_CLOSED: ['steps'],
  CATEGORY_WORKFLOW_MISMATCH: ['hub_id'],
  WORKFLOW_CHANGE_WITH_PROGRESS: ['hub_id'],
  UNKNOWN_HUB: ['hub_id'],
  INCONSISTENT_PROGRESS: ['current_step_code'],
};

/** Codes shared by the step chips and the current step (contract §2.1 /
 *  §2.2): the error row names no step, so they land on whichever of the two
 *  the Save changed (both when both changed). */
const STEP_OR_CURRENT = new Set(['UNKNOWN_STEP', 'STEP_NOT_APPLICABLE', 'PROJECT_FROZEN']);

/** What the refused Save changed, to place the codes above. */
export interface PopupErrorContext {
  exclusionsChanged: boolean;
  currentChanged: boolean;
}

function targetsOf(error: RegisterEditError, ctx: PopupErrorContext): PopupErrorTarget[] {
  if (STEP_OR_CURRENT.has(error.code)) {
    const out: PopupErrorTarget[] = [];
    if (ctx.exclusionsChanged || !ctx.currentChanged) out.push('steps');
    if (ctx.currentChanged) out.push('current_step_code');
    return out;
  }
  const known = ERROR_FIELD[error.code];
  return known ? [...known] : [];
}

/** The batch errors grouped by the field they name; `general` holds the rest. */
export function groupPopupErrors(
  errors: readonly RegisterEditError[],
  ctx: PopupErrorContext,
): { byTarget: Partial<Record<PopupErrorTarget, string[]>>; general: string[] } {
  const byTarget: Partial<Record<PopupErrorTarget, string[]>> = {};
  const general: string[] = [];
  for (const e of errors) {
    const text = registerRowErrorText(e);
    const targets = targetsOf(e, ctx);
    if (targets.length === 0) general.push(text);
    for (const t of targets) (byTarget[t] ??= []).push(text);
  }
  return { byTarget, general };
}
