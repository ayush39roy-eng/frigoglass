import type { CheckInDueProject, CheckInDueStage, CheckInEntry } from '@/lib/api/check-ins';
import { CHECKIN_NOTE_MAX, CHECKIN_REASON_MAX } from '@/lib/api/check-ins';
import type { WorkflowStepStatus } from '@/types/enums';

/**
 * The weekly check-in form model (ADR 0021 §1–§2). Client mirror of the
 * DOMAIN_RULES "Per-stage progress fields" rules that a check-in can break; the
 * SERVER enforces them (422 `CHECKIN_INVALID` / `INCONSISTENT_PROGRESS`). Week
 * numbers are never typed here: the server fills `actual_start_week` and
 * `actual_end_week` from CURRENT_WEEK.
 *
 *   percent_complete   integer 0..100; Not Started ⇒ 0; Done ⇒ 100
 *   blocked_reason     non-empty when Blocked ("On Hold", ADR 0017); null otherwise
 *   note               optional, at most 1000 characters
 *   hold reason        at most 2000 characters (server schema)
 */

export interface CheckInDraft {
  status: WorkflowStepStatus;
  percent_complete: number;
  /** Hold reason text; sent only when the status is Blocked. */
  blocked_reason: string;
  note: string;
  /** "Confirm unchanged": report the stage as it is (a no-change report still counts, ADR 0021 §2). */
  confirmed: boolean;
}

export type CheckInField = 'status' | 'percent_complete' | 'blocked_reason' | 'note';
export type CheckInErrors = Partial<Record<CheckInField, string>>;

export function stageKey(projectId: string, stepId: string): string {
  return `${projectId}::${stepId}`;
}

/** The draft a served stage starts from. */
export function initialDraft(stage: CheckInDueStage): CheckInDraft {
  return {
    status: stage.status,
    percent_complete: stage.percent_complete,
    blocked_reason: stage.blocked_reason ?? '',
    note: '',
    confirmed: false,
  };
}

/** The consistent draft a status change implies (same rules as the Workspace editor). */
export function withStatus(draft: CheckInDraft, status: WorkflowStepStatus, stage: CheckInDueStage): CheckInDraft {
  const next: CheckInDraft = { ...draft, status, confirmed: false };
  if (status === 'Not Started') next.percent_complete = 0;
  if (status === 'Done') next.percent_complete = 100;
  else if (draft.status === 'Done' && next.percent_complete === 100) next.percent_complete = 99;
  next.blocked_reason = status === 'Blocked' ? draft.blocked_reason || (stage.blocked_reason ?? '') : '';
  return next;
}

/** The user changed something versus the served stage (note counts). */
export function isEdited(draft: CheckInDraft, stage: CheckInDueStage): boolean {
  return (
    draft.status !== stage.status ||
    draft.percent_complete !== stage.percent_complete ||
    (draft.status === 'Blocked' && draft.blocked_reason.trim() !== (stage.blocked_reason ?? '').trim()) ||
    draft.note.trim() !== ''
  );
}

/** Whether the stage goes into the batch: edited, or confirmed unchanged. */
export function isIncluded(draft: CheckInDraft, stage: CheckInDueStage): boolean {
  return stage.can_check_in && (draft.confirmed || isEdited(draft, stage));
}

export function validateDraft(draft: CheckInDraft): CheckInErrors {
  const e: CheckInErrors = {};
  const pct = draft.percent_complete;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    e.percent_complete = 'Percent must be a whole number from 0 to 100.';
  } else if (draft.status === 'Not Started' && pct !== 0) {
    e.percent_complete = 'A stage that has not started is 0% complete.';
  } else if (draft.status === 'Done' && pct !== 100) {
    e.percent_complete = 'A done stage is 100% complete.';
  }
  if (draft.status === 'Blocked' && draft.blocked_reason.trim() === '') {
    e.blocked_reason = 'A stage on hold needs a hold reason.';
  } else if (draft.status === 'Blocked' && draft.blocked_reason.length > CHECKIN_REASON_MAX) {
    e.blocked_reason = `A hold reason can be at most ${String(CHECKIN_REASON_MAX)} characters.`;
  }
  if (draft.note.length > CHECKIN_NOTE_MAX) {
    e.note = `A note can be at most ${String(CHECKIN_NOTE_MAX)} characters.`;
  }
  return e;
}

export function toEntry(projectId: string, stepId: string, draft: CheckInDraft): CheckInEntry {
  const note = draft.note.trim();
  return {
    project_id: projectId,
    step_id: stepId,
    status: draft.status,
    percent_complete: draft.percent_complete,
    blocked_reason: draft.status === 'Blocked' ? draft.blocked_reason.trim() : null,
    note: note === '' ? null : note,
  };
}

export interface BatchPlan {
  /** In submit order; `keys[i]` is the row of `entries[i]` (for mapping server error indexes). */
  entries: CheckInEntry[];
  keys: string[];
  /** Client validation errors for included rows, by stage key. */
  errors: Record<string, CheckInErrors>;
}

/** Build the one-week batch from the served projects and the user's drafts. */
export function planBatch(projects: readonly CheckInDueProject[], drafts: Readonly<Record<string, CheckInDraft>>): BatchPlan {
  const plan: BatchPlan = { entries: [], keys: [], errors: {} };
  for (const project of projects) {
    for (const stage of project.stages) {
      const key = stageKey(project.project_id, stage.step_id);
      const draft = drafts[key] ?? initialDraft(stage);
      if (!isIncluded(draft, stage)) continue;
      const errors = validateDraft(draft);
      if (Object.keys(errors).length > 0) plan.errors[key] = errors;
      plan.entries.push(toEntry(project.project_id, stage.step_id, draft));
      plan.keys.push(key);
    }
  }
  return plan;
}
