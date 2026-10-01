import { HORIZON_WEEKS } from '@/lib/domain-constants';
import type { WorkflowStepStatus } from '@/types/enums';

/**
 * Client mirror of the DOMAIN_RULES per-stage consistency rules
 * ("Per-stage progress fields"). The SERVER enforces them (422 with field
 * errors); this makes the Progress panel refuse an inconsistent row and say
 * why before sending.
 *
 *   percent_complete      integer 0..100; Not Started ⇒ 0; Done ⇒ 100
 *   actual_start_week     required when status ∈ {In Progress, Blocked, Done}
 *   actual_end_week       required when Done; null otherwise; ≥ actual_start_week
 *   remaining override    integer ≥ 0, or null
 *   blocked_reason        non-empty when Blocked; null otherwise
 *   weeks                 on the 1..78 axis
 */

export interface StageDraft {
  status: WorkflowStepStatus;
  percent_complete: number;
  actual_start_week: number | null;
  actual_end_week: number | null;
  remaining_weeks_override: number | null;
  blocked_reason: string | null;
}

export type StageField = keyof StageDraft;
export type StageErrors = Partial<Record<StageField, string>>;

const needsStart: ReadonlySet<WorkflowStepStatus> = new Set(['In Progress', 'Blocked', 'Done']);

function inHorizon(week: number): boolean {
  return Number.isInteger(week) && week >= 1 && week <= HORIZON_WEEKS;
}

export function validateStage(d: StageDraft): StageErrors {
  const e: StageErrors = {};
  if (!Number.isInteger(d.percent_complete) || d.percent_complete < 0 || d.percent_complete > 100) {
    e.percent_complete = 'Percent must be a whole number from 0 to 100.';
  } else if (d.status === 'Not Started' && d.percent_complete !== 0) {
    e.percent_complete = 'A stage that has not started is 0% complete.';
  } else if (d.status === 'Done' && d.percent_complete !== 100) {
    e.percent_complete = 'A done stage is 100% complete.';
  }

  if (needsStart.has(d.status) && d.actual_start_week === null) {
    e.actual_start_week = `Actual start week is required when the stage is ${d.status}.`;
  } else if (d.actual_start_week !== null && !inHorizon(d.actual_start_week)) {
    e.actual_start_week = `Week must be 1–${String(HORIZON_WEEKS)}.`;
  }

  if (d.status === 'Done') {
    if (d.actual_end_week === null) e.actual_end_week = 'Actual end week is required when the stage is Done.';
    else if (!inHorizon(d.actual_end_week)) e.actual_end_week = `Week must be 1–${String(HORIZON_WEEKS)}.`;
    else if (d.actual_start_week !== null && d.actual_end_week < d.actual_start_week)
      e.actual_end_week = 'Actual end week cannot be before the actual start week.';
  } else if (d.actual_end_week !== null) {
    e.actual_end_week = 'Only a Done stage has an actual end week.';
  }

  if (d.remaining_weeks_override !== null && (!Number.isInteger(d.remaining_weeks_override) || d.remaining_weeks_override < 0)) {
    e.remaining_weeks_override = 'Remaining weeks must be a whole number, 0 or more.';
  }

  if (d.status === 'Blocked') {
    if (!d.blocked_reason || d.blocked_reason.trim() === '') e.blocked_reason = 'A blocked stage needs a reason.';
  } else if (d.blocked_reason !== null && d.blocked_reason !== '') {
    e.blocked_reason = 'Only a blocked stage has a blocked reason.';
  }
  return e;
}

/**
 * The consistent draft a status change implies, so the editor does not trap
 * the user in errors it could have resolved: Not Started → 0% and no actuals;
 * Done → 100%; leaving Done clears the end week; leaving Blocked clears the
 * reason. Fields the user must supply (start week, end week, reason) are left
 * for them.
 */
export function applyStatus(d: StageDraft, status: WorkflowStepStatus): StageDraft {
  const next: StageDraft = { ...d, status };
  if (status === 'Not Started') {
    next.percent_complete = 0;
    next.actual_start_week = null;
    next.actual_end_week = null;
  }
  if (status === 'Done') next.percent_complete = 100;
  else if (d.status === 'Done' && next.percent_complete === 100) next.percent_complete = 99;
  if (status !== 'Done') next.actual_end_week = null;
  if (status !== 'Blocked') next.blocked_reason = null;
  return next;
}
