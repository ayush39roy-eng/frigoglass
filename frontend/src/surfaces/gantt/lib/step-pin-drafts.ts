import { formatWeek } from '@/lib/format';
/**
 * P40-T03c (ADR 0054 ruling R40-1, R40-2, R40-13): the Timeline's drafted
 * manual Start / End weeks, before one batch Save.
 *
 * Pure helpers. Every length, flag and permission is SERVED
 * (`current_length_weeks`, `pin_editable`, `pin_block_reason`, `pinned`,
 * the step's `pin_lapsed`, `pin_clearable`); nothing here derives one. The only arithmetic is the owner's
 * typing rule as written in R40-2 — typing a Start gives
 * `End = Start + current_length_weeks − 1` — and the red range check of the
 * write domain `current week ≤ start ≤ end ≤ 52` (the server checks it again
 * under its lock and is the authority).
 */

import type { GanttStepRow, StepPinItem } from '../api/types';

/** One drafted step. Week values are the raw input text: `''` + `''` = Clear. */
export interface StepPinDraft {
  projectId: string;
  stepId: string;
  projectName: string;
  stepName: string;
  start: string;
  end: string;
  /** P47 (ADR 0059): the served pin when this step was first edited (`base`). */
  baseStart?: number | null;
  baseEnd?: number | null;
}

export function pinKey(projectId: string, stepId: string): string {
  return `${projectId}:${stepId}`;
}

function liveText(week: number | null): string {
  return week == null ? '' : String(week);
}

/** True when the draft equals the step's live pin (so it is not a change). */
export function sameAsLive(draft: Pick<StepPinDraft, 'start' | 'end'>, step: GanttStepRow): boolean {
  return draft.start.trim() === liveText(step.manual_start_week) && draft.end.trim() === liveText(step.manual_end_week);
}

/** The values the inputs show: the draft, else the live pin, else empty. */
export function shownPair(step: GanttStepRow, draft: StepPinDraft | undefined): { start: string; end: string } {
  if (draft) return { start: draft.start, end: draft.end };
  return { start: liveText(step.manual_start_week), end: liveText(step.manual_end_week) };
}

const WHOLE = /^\d+$/;

function parseWeek(text: string): number | null {
  const t = text.trim();
  return WHOLE.test(t) ? Number(t) : null;
}

/**
 * Typing a Start (R40-2): the End follows at `Start + current_length_weeks − 1`
 * (the owner's "end pushes automatically"). A Start that is not a whole week
 * yet leaves the End as it is.
 */
export function typeStart(
  current: { start: string; end: string },
  raw: string,
  currentLengthWeeks: number,
): { start: string; end: string } {
  const start = parseWeek(raw);
  if (start === null || currentLengthWeeks < 1) return { start: raw, end: current.end };
  return { start: raw, end: String(start + currentLengthWeeks - 1) };
}

/**
 * Typing an End keeps the Start (R40-2: the step is squeezed or stretched).
 * With nothing typed and no pin, the Start is the bar's served planned start.
 */
export function typeEnd(
  current: { start: string; end: string },
  raw: string,
  plannedStartWeek: number | null,
): { start: string; end: string } {
  const start = current.start.trim() === '' && plannedStartWeek != null ? String(plannedStartWeek) : current.start;
  return { start, end: raw };
}

export interface PinDraftProblem {
  message: string;
  start: boolean;
  end: boolean;
}

/**
 * The red state of a drafted pair, or null when it can be saved. `minWeek` is
 * the served current week; `maxWeek` the plan year's last week (52).
 */
export function pinDraftProblem(
  pair: { start: string; end: string },
  minWeek: number,
  maxWeek: number,
): PinDraftProblem | null {
  const s = pair.start.trim();
  const e = pair.end.trim();
  if (s === '' && e === '') return null; // Clear
  const range = `Pick weeks between ${formatWeek(minWeek)} and ${formatWeek(maxWeek)}.`;
  if (s === '' || e === '') {
    return { message: 'Enter both a start and an end week, or clear the step.', start: s === '', end: e === '' };
  }
  const start = parseWeek(s);
  const end = parseWeek(e);
  if (start === null || end === null) {
    return { message: 'Enter whole week numbers.', start: start === null, end: end === null };
  }
  if (end < start) return { message: 'The end week is before the start week.', start: false, end: true };
  const startOut = start < minWeek || start > maxWeek;
  const endOut = end < minWeek || end > maxWeek;
  if (startOut || endOut) return { message: range, start: startOut, end: endOut };
  return null;
}

/** The batch body, in draft order (the order maps server `index` back). */
export function draftsToItems(drafts: readonly StepPinDraft[]): StepPinItem[] {
  return drafts.map((d) => {
    const s = d.start.trim();
    const e = d.end.trim();
    const item: StepPinItem = {
      project_id: d.projectId,
      step_template_id: d.stepId,
      manual_start_week: s === '' ? null : Number(s),
      manual_end_week: e === '' ? null : Number(e),
    };
    if (d.baseStart !== undefined && d.baseEnd !== undefined) {
      item.base = { manual_start_week: d.baseStart, manual_end_week: d.baseEnd };
    }
    return item;
  });
}

/**
 * How the step's live pin relates to the active run (R40-13; contract §2,
 * P40-R02). Comparisons of served weeks plus the step's OWN served
 * `pin_lapsed`; the browser never infers a lapse from the project flag:
 * - `pending`: the live pin differs from the run's row window and the step is
 *   not lapsed, or the pin was cleared while the run still has the row pinned
 *   → "Pin applies on the next run";
 * - `lapsed`: the served `step.pin_lapsed` (the run placed the pinned row from
 *   its own week because the pin's start had passed, R40-5);
 * - `applied`: the run row sits on the live pin;
 * - null: no pin either side.
 */
export type PinRunState = 'pending' | 'lapsed' | 'applied' | null;

export function pinRunState(step: GanttStepRow): PinRunState {
  const ms = step.manual_start_week;
  const me = step.manual_end_week;
  if (ms == null || me == null) return step.pinned ? 'pending' : null;
  if (step.skipped) return null; // an inert pin (I33): the run never places it
  if (step.pinned && step.planned_start_week === ms && step.planned_end_week === me) return 'applied';
  if (step.pin_lapsed) return 'lapsed';
  return 'pending';
}
