/**
 * Register popup (owner request 2026-11-17): the register fields of ONE
 * project, edited in the row's "Edit" popup next to the registration's
 * identity fields.
 *
 * Same rule as the grid's draft (`register-edit.ts`): the draft keeps only
 * what differs from the served values, and Save sends ONE
 * `POST /projects/register-edits` patch with only those keys. Every flag the
 * chips show (N/A, Done, excludable, current) is served by
 * `GET /projects/{id}/register-steps`; nothing here decides which step
 * applies or what the current step becomes (I9). The only browser-side
 * comparison is the step order the server lists, to word the note under the
 * current-step select.
 */

import type { EditBase } from '@/lib/api/edit-conflict';
import type { ProjectStatus } from '@/types/enums';

import type { ProjectRead } from '@/surfaces/registration/api/types';

import type { RegisterEditPatch, RegisterStep, RegisterStepsResponse, StepExclusionEdit } from '../api/register-edits';

/** The scalar register fields of the popup, in the order the patch lists them. */
export const POPUP_SCALAR_FIELDS = [
  'status',
  'hub_id',
  'leader_engineer_id',
  'actual_start_week',
  'actual_end_week',
  'design_effort_weeks',
  'lab_effort_weeks',
  'certification_testing_required',
  'current_step_code',
] as const;
export type PopupScalarField = (typeof POPUP_SCALAR_FIELDS)[number];

export interface PopupScalars {
  status: ProjectStatus;
  hub_id: string;
  leader_engineer_id: string | null;
  actual_start_week: number | null;
  actual_end_week: number | null;
  design_effort_weeks: number | null;
  lab_effort_weeks: number | null;
  certification_testing_required: boolean;
  /** null = no current step served (every step done, or steps not loaded). */
  current_step_code: string | null;
}

export interface PopupBase extends PopupScalars {
  /** Served exclusion flag per step code (empty until the steps load). */
  excluded: Readonly<Record<string, boolean>>;
}

export interface PopupDraft extends Partial<PopupScalars> {
  /** Only the steps whose flag differs from the served one. */
  excluded?: Readonly<Record<string, boolean>>;
}

export function popupBase(project: ProjectRead, steps: RegisterStepsResponse | undefined): PopupBase {
  const excluded: Record<string, boolean> = {};
  for (const s of steps?.steps ?? []) excluded[s.step_code] = s.step_excluded;
  return {
    status: project.status,
    hub_id: project.hub_id,
    leader_engineer_id: project.leader_engineer_id,
    actual_start_week: project.actual_start_week,
    actual_end_week: project.actual_end_week,
    design_effort_weeks: project.design_effort_weeks,
    lab_effort_weeks: project.lab_effort_weeks,
    certification_testing_required: project.certification_testing_required,
    current_step_code: steps?.current_step_code ?? null,
    excluded,
  };
}

/** What the popup shows: the draft over the served values. */
export function popupValues(base: PopupBase, draft: PopupDraft): PopupBase {
  return { ...base, ...draft, excluded: { ...base.excluded, ...(draft.excluded ?? {}) } };
}

/** Drops every draft value equal to the served one (a refetch may also have
 *  caught up with it). */
export function normaliseDraft(base: PopupBase, draft: PopupDraft): PopupDraft {
  const out: Record<string, unknown> = {};
  for (const f of POPUP_SCALAR_FIELDS) {
    if (f in draft && draft[f] !== undefined && draft[f] !== base[f]) out[f] = draft[f];
  }
  const excluded: Record<string, boolean> = {};
  for (const [code, on] of Object.entries(draft.excluded ?? {})) {
    if ((base.excluded[code] ?? false) !== on) excluded[code] = on;
  }
  if (Object.keys(excluded).length > 0) out.excluded = excluded;
  return out as PopupDraft;
}

export function setPopupField<F extends PopupScalarField>(
  base: PopupBase,
  draft: PopupDraft,
  field: F,
  value: PopupScalars[F],
): PopupDraft {
  return normaliseDraft(base, { ...draft, [field]: value });
}

/** Flips one step's exclusion. A draft current step that becomes excluded is
 *  dropped (the server picks the current step past an excluded one). */
export function toggleExclusion(base: PopupBase, draft: PopupDraft, stepCode: string): PopupDraft {
  const now = popupValues(base, draft).excluded[stepCode] ?? false;
  const next: PopupDraft = { ...draft, excluded: { ...(draft.excluded ?? {}), [stepCode]: !now } };
  if (!now && next.current_step_code === stepCode) delete next.current_step_code;
  return normaliseDraft(base, next);
}

/** Drops the staged exclusions of the given steps (used when the lab flag
 *  changes: the lab steps' N/A marks are re-decided by the server on Save). */
export function dropExclusions(base: PopupBase, draft: PopupDraft, codes: readonly string[]): PopupDraft {
  if (!draft.excluded) return draft;
  const excluded = { ...draft.excluded };
  for (const c of codes) delete excluded[c];
  return normaliseDraft(base, { ...draft, excluded });
}

export function popupChanged(base: PopupBase, draft: PopupDraft): boolean {
  return Object.keys(normaliseDraft(base, draft)).length > 0;
}

export function popupFieldChanged(base: PopupBase, draft: PopupDraft, field: PopupScalarField): boolean {
  return field in normaliseDraft(base, draft);
}

/** The ONE patch of the popup's Save, or null when nothing changed. Step
 *  exclusions are listed in the served workflow order. */
export function buildPopupPatch(
  projectId: string,
  base: PopupBase,
  draft: PopupDraft,
  stepOrder: readonly string[],
): RegisterEditPatch | null {
  const d = normaliseDraft(base, draft);
  if (Object.keys(d).length === 0) return null;
  const patch: RegisterEditPatch = { project_id: projectId };
  const out = patch as unknown as Record<string, unknown>;
  for (const f of POPUP_SCALAR_FIELDS) {
    if (!(f in d)) continue;
    // The current step is a pick from a list: never sent as "cleared".
    if (f === 'current_step_code' && d.current_step_code === null) continue;
    out[f] = d[f];
  }
  if (d.excluded) {
    const order = new Map(stepOrder.map((code, i) => [code, i]));
    const edits: StepExclusionEdit[] = Object.entries(d.excluded)
      .sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
      .map(([step_code, step_excluded]) => ({ step_code, step_excluded }));
    patch.step_exclusions = edits;
  }
  return Object.keys(patch).length > 1 ? patch : null;
}

/** The steps the current-step select offers (contract §3): the served steps
 *  whose status is not `Skipped` (a skipped step cannot be current), minus
 *  the ones the draft excludes, in workflow order. */
export function currentStepOptions(steps: readonly RegisterStep[], values: PopupBase): RegisterStep[] {
  return steps.filter((s) => s.status !== 'Skipped' && !(values.excluded[s.step_code] ?? false));
}

/** Where a picked current step sits against the served one, in the served
 *  workflow order: the note under the select says what the server will do. */
export function currentStepMove(
  steps: readonly RegisterStep[],
  served: string | null,
  picked: string | null,
): 'forward' | 'back' | null {
  if (picked === null || picked === served) return null;
  const at = (code: string | null): number => (code === null ? -1 : steps.findIndex((s) => s.step_code === code));
  const from = at(served);
  const to = at(picked);
  if (to < 0) return null;
  // No served current step (all done): any pick moves back.
  if (from < 0) return served === null ? 'back' : null;
  return to > from ? 'forward' : 'back';
}

/**
 * Why a step cannot be toggled, from its served flags (contract §3):
 * `excludable` decides for a step that is not excluded; an excluded step may
 * be re-included unless the project itself is locked (`projectLock`, from the
 * served project: frozen, or Cancelled / Commercialized). The server stays
 * the authority on Save.
 */
export function servedLockReason(
  step: RegisterStep,
  servedExcluded: boolean,
  projectLock: string | null = null,
): string | null {
  if (!step.applicable) return 'not applicable';
  if (step.status === 'Done') return 'done';
  if (projectLock !== null) return projectLock;
  if (servedExcluded) return null;
  return step.excludable ? null : 'cannot be excluded now';
}

/** The served project's own lock on its steps (frozen / closed), or null. */
export const FROZEN_LOCK = 'project frozen';

export function projectStepLock(project: { frozen: boolean; status: ProjectStatus }): string | null {
  if (project.frozen) return FROZEN_LOCK;
  if (project.status === 'Cancelled' || project.status === 'Commercialized') return 'project closed';
  return null;
}

/** P47 (ADR 0059 C1): the popup patch's `base`, from the values the popup
 *  showed when the user started editing (`start`): each changed scalar, and
 *  the served flag of each step whose exclusion it changes. */
export function popupPatchBase(patch: RegisterEditPatch, start: PopupBase): EditBase {
  const base: EditBase = {};
  const src = start as unknown as Record<string, unknown>;
  for (const f of POPUP_SCALAR_FIELDS) if (f in patch) base[f] = src[f] ?? null;
  if (patch.step_exclusions) {
    base.step_exclusions = Object.fromEntries(
      patch.step_exclusions.map((e) => [e.step_code, start.excluded[e.step_code] ?? false]),
    );
  }
  return base;
}
