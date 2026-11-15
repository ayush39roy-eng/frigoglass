import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { MOVE_COPY } from '@/components/shared/priority-move/move-copy';

import type { ApplyNeverReason, ApplyStepFlag } from '../api/types';

/**
 * P33-T16..T18 copy, in one place (ADR 0045, API_CONTRACT_P33 Part I). Plain
 * words for a non-technical owner; every number in a sentence is a served
 * field or a value the user typed.
 */

export const TEMPLATE_CHANGED = 'TEMPLATE_CHANGED';

export const TEMPLATE_COPY = {
  editorIntro:
    'Move starts a step a week earlier (overlap) or later (wait). Length makes it a week shorter or longer. ' +
    'Changes are drafts until you Save; Save shows which projects they reach.',
  pending: 'Updating the preview…',
  previewRateLimited: 'Too many clicks in a row — wait a moment and the preview will catch up.',
  previewFailed: 'The preview could not be calculated. Your drafts are kept.',
  // E2 / E3 refusals.
  templateChanged:
    'Someone saved this category meanwhile. The latest template has been loaded — check your changes and save again. Nothing was saved.',
  noChange: 'These values already equal the saved template, so there is nothing to save.',
  badProject: 'One of the chosen projects is no longer available to you. Close this dialog and save again.',
  applyRateLimited: 'Too many saves in a row — wait a few seconds and try again. Nothing was saved.',
  applyPreviewRateLimited: 'Too many save checks in a row — wait a few seconds and try again. Nothing was saved.',
  forbidden: 'Your role cannot change the category templates.',
  // The apply dialog.
  automaticHelp: 'These projects have not started, so they always follow the template.',
  choosableHelp: 'These projects have started, but have not reached the changed steps yet.',
  ownEffortTitle: 'Uses its own weeks — length not changed',
  ownEffortHelp:
    'These projects have their own effort figure for this kind of work, so their step lengths stay their own. Nothing is changed on them.',
  neverTitle: 'Not changed',
  neverHelp: 'Finished, cancelled, commercialized or frozen projects, and steps a project has already reached.',
  // The result panel.
  notNeeded: 'No project in the plan changed, so the timeline did not need recalculating.',
  dispatchFailed:
    'The template is saved, but the recalculation could not be started. The changed projects are marked stale — press Recalculate on a project.',
  queuedWithoutRun: 'The recalculation was queued but no run was reported back — press Recalculate on a project.',
  failedRun: 'The template is saved and the changed projects are marked stale. Press Recalculate on a project to try again.',
  deferred: MOVE_COPY.deferred,
  followUpWatching: MOVE_COPY.followUpWatching,
} as const;

/** R33-11 step flags as short notes. */
export const APPLY_FLAG_NOTE: Record<ApplyStepFlag, string> = {
  revived: 'was skipped, now runs',
  skipped_now: 'now skipped (0 weeks)',
  gap_ignored_skipped: 'skipped for this project, so the gap has no effect',
  cert_off_no_effect: 'certification testing is off, so no effect',
  own_effort_length_not_applied: 'uses its own weeks — length not changed',
};

export const NEVER_REASON: Record<ApplyNeverReason, string> = {
  frozen: 'Frozen',
  cancelled: 'Cancelled',
  commercialized: 'Commercialized',
  reached_stage: 'Already started or finished',
};

export const NOT_APPLIED_REASON = {
  reached_stage: 'started this step meanwhile — not changed',
  not_choosable: 'could no longer receive the change — not changed',
} as const;

/** One text for a refused E2 / E3 call. */
export function applyErrorMessage(err: unknown, stage: 'preview' | 'apply'): string {
  if (err instanceof ApiError) {
    if (err.code === TEMPLATE_CHANGED) return TEMPLATE_COPY.templateChanged;
    if (err.code === 'NO_CHANGE') return TEMPLATE_COPY.noChange;
    if (err.code === 'BAD_PROJECT') return TEMPLATE_COPY.badProject;
    if (err.status === 429) {
      const base = stage === 'apply' ? 'Too many saves in a row' : 'Too many save checks in a row';
      return err.retryAfterSeconds === undefined
        ? stage === 'apply'
          ? TEMPLATE_COPY.applyRateLimited
          : TEMPLATE_COPY.applyPreviewRateLimited
        : `${base} — wait ${String(Math.max(1, err.retryAfterSeconds))} s and try again. Nothing was saved.`;
    }
    if (err.isForbidden) return TEMPLATE_COPY.forbidden;
  }
  return apiErrorMessage(
    err,
    stage === 'apply' ? 'The template could not be saved. Nothing was changed.' : 'The save check could not be calculated. Nothing was changed.',
  );
}

export function isTemplateChanged(err: unknown): boolean {
  return err instanceof ApiError && err.code === TEMPLATE_CHANGED;
}

/** "1 project" / "3 projects". */
export function projects(n: number): string {
  return `${String(n)} ${n === 1 ? 'project' : 'projects'}`;
}
