import type { ProjectCategory, WorkflowId } from '@/types/enums';

import type {
  LeadTimeSetting,
  TemplateChangeEntry,
  TemplateFlag,
  TemplateStepOverride,
  TimelineStep,
} from '../api/types';

/**
 * P33-T16 (ADR 0045 §1, API_CONTRACT_P33 D / E1): the category timeline
 * editor's drafts. A draft is the value the user is asking for — a length or a
 * signed gap typed by clicking — never a computed week. Every start week,
 * total and flag comes back from `POST /workflow-templates/timeline-preview`.
 *
 * Drafts are stored per step and only while they differ from the saved
 * template, so a draft set always satisfies E1 ("at least one value differs",
 * else 422 `NO_CHANGE`).
 */

/** DOMAIN_RULES "Category templates" §A ranges. */
export const WEEKS_MIN = 0;
export const WEEKS_MAX = 104;
export const GAP_MIN = -104;
export const GAP_MAX = 104;

/** One step's saved template values (`GET /workflow-settings` `lead_times[]`, C1). */
export interface SavedCell {
  weeks: number;
  gap_weeks: number;
  /** P62 (ADR 0071): room weeks; null = Full. Absent = Full (older callers). */
  lab_hold_weeks?: number | null;
}

/** The overrides of one step; a missing field keeps the saved value. */
export interface StepDraft {
  weeks?: number;
  gap_weeks?: number;
  /** P62: drafted room weeks — an integer, or null = "Full". Undefined = keep. */
  lab_hold_weeks?: number | null;
}

/** P62: a room-weeks click — one week fewer / more, or "Full" (the whole length). */
export type HoldAction = -1 | 1 | 'full';

function hasAnyValue(step: StepDraft): boolean {
  return step.weeks !== undefined || step.gap_weeks !== undefined || step.lab_hold_weeks !== undefined;
}

/** Put `step` back into the drafts, dropping it when it no longer changes anything. */
function withStep(drafts: CategoryDrafts, stepId: string, step: StepDraft): CategoryDrafts {
  const out: Record<string, StepDraft> = { ...drafts };
  if (hasAnyValue(step)) out[stepId] = step;
  else delete out[stepId];
  return out;
}

/**
 * P62 (API_CONTRACT_P62 §4.1): after a length change, a DRAFTED room-weeks
 * integer above the new length is cut to it, so the request never asks for
 * room weeks outside `0..weeks` (422 `LAB_HOLD_OUT_OF_RANGE`). A saved value is
 * left alone: the server clamps it and the apply preview says so.
 */
function clampDraftedHold(step: StepDraft, saved: SavedCell | undefined): void {
  const weeks = step.weeks;
  const hold = step.lab_hold_weeks;
  if (weeks === undefined || hold === undefined || hold === null || hold <= weeks) return;
  if (weeks === (saved?.lab_hold_weeks ?? null)) delete step.lab_hold_weeks;
  else step.lab_hold_weeks = weeks;
}

/** step_id → draft, only for steps with at least one changed value. */
export type CategoryDrafts = Readonly<Record<string, StepDraft>>;

export type DraftField = 'weeks' | 'gap_weeks';

/** The saved template cells of one (workflow, category), by step id. */
export function savedCells(
  leadTimes: readonly LeadTimeSetting[],
  workflowId: WorkflowId,
  category: ProjectCategory,
): Record<string, SavedCell> {
  const out: Record<string, SavedCell> = {};
  for (const lt of leadTimes) {
    if (lt.workflow_id !== workflowId || lt.category !== category) continue;
    out[lt.step_id] = { weeks: lt.weeks, gap_weeks: lt.gap_weeks, lab_hold_weeks: lt.lab_hold_weeks };
  }
  return out;
}

const RANGE: Record<DraftField, [number, number]> = {
  weeks: [WEEKS_MIN, WEEKS_MAX],
  gap_weeks: [GAP_MIN, GAP_MAX],
};

/** The value in force for one field: the draft, else the saved one (0 when no row). */
export function currentValue(
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
  field: DraftField,
): number {
  return drafts[stepId]?.[field] ?? saved[stepId]?.[field] ?? 0;
}

/** Whether a ± click on `field` can move in `direction` (the range ends clamp). */
export function canNudge(
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
  field: DraftField,
  direction: -1 | 1,
): boolean {
  const value = currentValue(drafts, saved, stepId, field);
  const [min, max] = RANGE[field];
  return direction < 0 ? value > min : value < max;
}

/**
 * One ± click: the field moves by `direction`, clamped to its range. A value
 * that returns to the saved one drops out of the drafts (so Save never sends a
 * no-op step).
 */
export function nudge(
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
  field: DraftField,
  direction: -1 | 1,
): CategoryDrafts {
  const [min, max] = RANGE[field];
  const next = Math.min(max, Math.max(min, currentValue(drafts, saved, stepId, field) + direction));
  const savedValue = saved[stepId]?.[field] ?? 0;
  const step: StepDraft = { ...drafts[stepId] };
  if (next === savedValue) delete step[field];
  else step[field] = next;
  if (field === 'weeks') clampDraftedHold(step, saved[stepId]);
  return withStep(drafts, stepId, step);
}

// --- P62 room weeks (ADR 0071) ---------------------------------------------------------

/** The room weeks in force: the draft, else the saved value; null = "Full". */
export function currentHold(
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
): number | null {
  const drafted = drafts[stepId]?.lab_hold_weeks;
  if (drafted !== undefined) return drafted;
  return saved[stepId]?.lab_hold_weeks ?? null;
}

/** Whether a room-weeks click can act, for a step whose length in force is `weeks`. */
export function canHold(
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
  action: HoldAction,
  weeks: number,
): boolean {
  const hold = currentHold(drafts, saved, stepId);
  if (action === 'full') return hold !== null;
  // From "Full", − asks for one week fewer than the length; + has nowhere to go.
  const value = Math.min(hold ?? weeks, weeks);
  return action < 0 ? value > 0 : hold !== null && value < weeks;
}

/**
 * One room-weeks click (range 0..the length in force; "Full" = null). A value
 * equal to the saved one drops out of the drafts, like `nudge`.
 */
export function nudgeHold(
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
  action: HoldAction,
  weeks: number,
): CategoryDrafts {
  if (!canHold(drafts, saved, stepId, action, weeks)) return drafts;
  const hold = currentHold(drafts, saved, stepId);
  const next = action === 'full' ? null : Math.min(weeks, Math.max(0, Math.min(hold ?? weeks, weeks) + action));
  const savedValue = saved[stepId]?.lab_hold_weeks ?? null;
  const step: StepDraft = { ...drafts[stepId] };
  if (next === savedValue) delete step.lab_hold_weeks;
  else step.lab_hold_weeks = next;
  return withStep(drafts, stepId, step);
}

/** "Full" or "2w" for a room-weeks value. */
export function holdText(hold: number | null): string {
  return hold === null ? 'Full' : `${String(hold)}w`;
}

/** Per-row reset: back to the saved template. */
export function resetStep(drafts: CategoryDrafts, stepId: string): CategoryDrafts {
  if (!(stepId in drafts)) return drafts;
  const out: Record<string, StepDraft> = { ...drafts };
  delete out[stepId];
  return out;
}

/** Drop every drafted value that now equals the saved one (a reloaded template). */
export function pruneDrafts(drafts: CategoryDrafts, saved: Readonly<Record<string, SavedCell>>): CategoryDrafts {
  let changed = false;
  const out: Record<string, StepDraft> = {};
  for (const [stepId, d] of Object.entries(drafts)) {
    const step: StepDraft = {};
    if (d.weeks !== undefined && d.weeks !== (saved[stepId]?.weeks ?? 0)) step.weeks = d.weeks;
    if (d.gap_weeks !== undefined && d.gap_weeks !== (saved[stepId]?.gap_weeks ?? 0)) step.gap_weeks = d.gap_weeks;
    if (d.lab_hold_weeks !== undefined && d.lab_hold_weeks !== (saved[stepId]?.lab_hold_weeks ?? null)) {
      step.lab_hold_weeks = d.lab_hold_weeks;
    }
    if (step.weeks !== d.weeks || step.gap_weeks !== d.gap_weeks || step.lab_hold_weeks !== d.lab_hold_weeks) changed = true;
    if (hasAnyValue(step)) out[stepId] = step;
  }
  return changed ? out : drafts;
}

/** The overrides as contract D / E1 steps, in step-id order (a stable query key). */
export function draftOverrides(drafts: CategoryDrafts): TemplateStepOverride[] {
  return Object.keys(drafts)
    .sort()
    .map((stepId) => {
      const d = drafts[stepId] ?? {};
      const o: TemplateStepOverride = { step_id: stepId };
      if (d.weeks !== undefined) o.weeks = d.weeks;
      if (d.gap_weeks !== undefined) o.gap_weeks = d.gap_weeks;
      // P62 §4.1: null ("Full") goes on the wire as the string "full".
      if (d.lab_hold_weeks !== undefined) o.lab_hold_weeks = d.lab_hold_weeks ?? 'full';
      return o;
    });
}

/** The E1 entry for this category, or null when nothing is drafted. */
export function changeEntry(
  workflowId: WorkflowId,
  category: ProjectCategory,
  baseVersion: number,
  drafts: CategoryDrafts,
): TemplateChangeEntry | null {
  const steps = draftOverrides(drafts);
  if (steps.length === 0) return null;
  return { workflow_id: workflowId, category, base_version: baseVersion, steps };
}

/** The value a served timeline reflects for an override set (for the optimistic bar). */
export function overrideValue(
  overrides: readonly TemplateStepOverride[],
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
  field: DraftField,
): number {
  const o = overrides.find((s) => s.step_id === stepId);
  return o?.[field] ?? saved[stepId]?.[field] ?? 0;
}

// --- Display copy (no arithmetic beyond formatting a served or drafted integer). ---

/**
 * "A · PDD-E length 6w → 7w" / "A · PDD-H gap 0w → −2w" / "A · PDD-J room
 * weeks Full → 1w" for the apply dialog, in step-id order.
 */
export function draftSummaryLines(
  category: string,
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
): string[] {
  const lines: string[] = [];
  for (const stepId of Object.keys(drafts).sort()) {
    const d = drafts[stepId] ?? {};
    const s = saved[stepId] ?? { weeks: 0, gap_weeks: 0 };
    if (d.weeks !== undefined) lines.push(`${category} · ${stepId} length ${String(s.weeks)}w → ${String(d.weeks)}w`);
    if (d.gap_weeks !== undefined) {
      lines.push(`${category} · ${stepId} gap ${signedWeeks(s.gap_weeks)}w → ${signedWeeks(d.gap_weeks)}w`);
    }
    if (d.lab_hold_weeks !== undefined) {
      lines.push(`${category} · ${stepId} room weeks ${holdText(s.lab_hold_weeks ?? null)} → ${holdText(d.lab_hold_weeks)}`);
    }
  }
  return lines;
}

/** "−3" with a true minus sign. */
export function signedWeeks(n: number): string {
  return n < 0 ? `−${String(-n)}` : String(n);
}

export type GapTone = 'first' | 'none' | 'overlap' | 'wait';

/** The gap badge: "—" on the first step, "0w", "−3w" (overlap) or "3w" (wait). */
export function gapBadge(gap: number, isFirst: boolean): { text: string; tone: GapTone; label: string } {
  if (isFirst) return { text: '—', tone: 'first', label: 'first step, no gap' };
  if (gap === 0) return { text: '0w', tone: 'none', label: 'starts right after the step before' };
  if (gap < 0) {
    const n = -gap;
    return {
      text: `${signedWeeks(gap)}w`,
      tone: 'overlap',
      label: `overlaps the step before by ${String(n)} ${n === 1 ? 'week' : 'weeks'}`,
    };
  }
  return {
    text: `${String(gap)}w`,
    tone: 'wait',
    label: `waits ${String(gap)} ${gap === 1 ? 'week' : 'weeks'} after the step before`,
  };
}

/**
 * A short note per served flag (API_CONTRACT_P33 Part I). `anchor_clamped`
 * names the step's non-skipped predecessors from the served timeline.
 */
export function templateFlagNote(
  flag: TemplateFlag,
  step: TimelineStep,
  steps: readonly TimelineStep[],
): string {
  switch (flag) {
    case 'same_leader_serialised':
      return 'Overlap — same leader, runs back-to-back';
    case 'anchor_clamped': {
      const anchors = step.predecessor_ids.filter((id) => (steps.find((s) => s.code === id)?.duration_weeks ?? 0) > 0);
      return anchors.length > 0
        ? `Can’t start before ${anchors.join(' / ')} starts`
        : 'Can’t start before the step it overlaps starts';
    }
    case 'gap_ignored_zero_length':
      return '0-week step: gap ignored';
  }
}
