/**
 * P35-T02 (D35-2): the Projects register's inline edit session, after the
 * Matrix grid-edit pattern (P34 D34-1, `surfaces/matrix/lib/grid-edit.ts`).
 *
 * A draft holds only the fields a user changed on one project; a field set
 * back to its served value is dropped, and a project with no changed field is
 * dropped. Save sends ONE `POST /projects/register-edits` with, per changed
 * project, only the changed fields (P35-T01). Nothing here computes a
 * schedule figure: "calculated" design / lab time is the served
 * `*_weeks_calculated`, and the server re-splits a figure (I9, D35-1).
 */

import { snapshotBase, type BaseSnapshots, type EditBase } from '@/lib/api/edit-conflict';
import type { ProjectStatus } from '@/types/enums';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';

import type { RegisterEditPatch, RegisterEditsRequest } from '../api/register-edits';

/**
 * P44-T01: the row's inline edit also edits the hub, "Needs lab testing" and
 * the current step (the popup's fields, API_CONTRACT_REGISTER_POPUP §2). Their
 * served values are not all on the list row: the page passes a
 * {@link RegisterRow} whose `hub_id` (the served hub name mapped through the
 * served hub list) and `certification_testing_required` (the served
 * `GET /projects/{id}`) it has at hand; `null` = not known yet, and the cell
 * stays disabled until it is.
 */
export const EDITABLE_FIELDS = [
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
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface RegisterValues {
  status: ProjectStatus;
  hub_id: string | null;
  leader_engineer_id: string | null;
  actual_start_week: number | null;
  actual_end_week: number | null;
  design_effort_weeks: number | null;
  lab_effort_weeks: number | null;
  certification_testing_required: boolean | null;
  /** null = no current step served (every step done). Never sent as null. */
  current_step_code: string | null;
}

/** A row's draft: the changed scalars, plus (P44-T01, owner 2026-11-18) the
 *  steps whose exclusion flag differs from the served one. */
export type RegisterDraft = Partial<RegisterValues> & { excluded?: Readonly<Record<string, boolean>> };
export type RegisterDrafts = Readonly<Record<string, RegisterDraft>>;

/** A served list row plus the served values the list row does not carry. */
export type RegisterRow = ProjectFilterRow & {
  hub_id?: string | null;
  certification_testing_required?: boolean | null;
  /** Served exclusion flag per step code (`GET /projects/{id}/register-steps`);
   *  undefined until the steps are loaded. */
  excluded?: Readonly<Record<string, boolean>>;
  /** The served workflow order of the step codes (the batch lists exclusions in it). */
  step_order?: readonly string[];
};

/** The served values of the editable fields. */
export function baseValues(row: RegisterRow): RegisterValues {
  return {
    status: row.status,
    hub_id: row.hub_id ?? null,
    leader_engineer_id: row.leader_engineer_id,
    actual_start_week: row.actual_start_week,
    actual_end_week: row.actual_end_week,
    design_effort_weeks: row.design_effort_weeks,
    lab_effort_weeks: row.lab_effort_weeks,
    certification_testing_required: row.certification_testing_required ?? null,
    current_step_code: row.current_step_code,
  };
}

/** What the grid shows for `row` in Edit mode: the draft over the served row. */
export function valuesFor(drafts: RegisterDrafts, row: RegisterRow): RegisterValues {
  const draft = drafts[row.project_id];
  return draft ? { ...baseValues(row), ...draft } : baseValues(row);
}

/** Only the fields of `draft` that still differ from the CURRENT served row
 *  (a refetch may have caught up with a draft). */
export function changedFields(draft: RegisterDraft | undefined, row: RegisterRow): RegisterDraft {
  const out: Record<string, unknown> = {};
  if (!draft) return out;
  const base = baseValues(row);
  for (const field of EDITABLE_FIELDS) {
    if (field in draft && draft[field] !== base[field]) out[field] = draft[field];
  }
  if (draft.excluded) {
    const excluded: Record<string, boolean> = {};
    for (const [code, on] of Object.entries(draft.excluded)) {
      // Staged only once the steps were loaded; kept as is if they are not now.
      if (row.excluded === undefined || (row.excluded[code] ?? false) !== on) excluded[code] = on;
    }
    if (Object.keys(excluded).length > 0) out.excluded = excluded;
  }
  return out as RegisterDraft;
}

function withValues(drafts: RegisterDrafts, row: RegisterRow, patch: RegisterDraft): RegisterDrafts {
  const merged = changedFields({ ...(drafts[row.project_id] ?? {}), ...patch }, row);
  const out: Record<string, RegisterDraft> = { ...drafts };
  if (Object.keys(merged).length > 0) out[row.project_id] = merged;
  else delete out[row.project_id];
  return out;
}

export function setDraftField<F extends EditableField>(
  drafts: RegisterDrafts,
  row: RegisterRow,
  field: F,
  value: RegisterValues[F],
): RegisterDrafts {
  return withValues(drafts, row, { [field]: value } as RegisterDraft);
}

/**
 * P35-T08: the bulk bar stages one patch on every ticked row (the same draft
 * the cells write). `skipStatus` lists rows whose status may not be set here
 * (a Draft row leaves Draft through Submit, ADR 0034).
 */
export function setDraftBulk(
  drafts: RegisterDrafts,
  rows: readonly RegisterRow[],
  patch: RegisterDraft,
): RegisterDrafts {
  let next = drafts;
  for (const row of rows) {
    const rowPatch: RegisterDraft = { ...patch };
    if (row.status === 'Draft') delete rowPatch.status;
    next = withValues(next, row, rowPatch);
  }
  return next;
}

/** The served flags with the row's draft applied. */
export function excludedFor(drafts: RegisterDrafts, row: RegisterRow): Readonly<Record<string, boolean>> {
  return { ...(row.excluded ?? {}), ...(drafts[row.project_id]?.excluded ?? {}) };
}

/** Flips one step's exclusion in the row's draft (the popup's rule,
 *  `register-popup.ts toggleExclusion`): a draft current step that becomes
 *  excluded is dropped (the server picks the current step past it). */
export function toggleDraftExclusion(drafts: RegisterDrafts, row: RegisterRow, stepCode: string): RegisterDrafts {
  const now = excludedFor(drafts, row)[stepCode] ?? false;
  const draft = drafts[row.project_id] ?? {};
  const patch: RegisterDraft = { excluded: { ...(draft.excluded ?? {}), [stepCode]: !now } };
  let next = withValues(drafts, row, patch);
  if (!now && next[row.project_id]?.current_step_code === stepCode) {
    next = withValues(next, row, { current_step_code: row.current_step_code });
  }
  return next;
}

/** Drops the staged exclusions of `codes` (all when null): a lab flag change
 *  re-decides the lab steps, a workflow change re-points every step. */
export function dropDraftExclusions(
  drafts: RegisterDrafts,
  row: RegisterRow,
  codes: readonly string[] | null,
): RegisterDrafts {
  const draft = drafts[row.project_id];
  if (!draft?.excluded) return drafts;
  const excluded: Record<string, boolean> = {};
  if (codes !== null) {
    for (const [code, on] of Object.entries(draft.excluded)) if (!codes.includes(code)) excluded[code] = on;
  }
  const rest: RegisterDraft = { ...draft };
  delete rest.excluded;
  const out: Record<string, RegisterDraft> = { ...drafts, [row.project_id]: rest };
  return withValues(out, row, Object.keys(excluded).length > 0 ? { excluded } : {});
}

export function exclusionsChanged(drafts: RegisterDrafts, row: RegisterRow): boolean {
  return changedFields(drafts[row.project_id], row).excluded !== undefined;
}

export function fieldChanged(drafts: RegisterDrafts, row: RegisterRow, field: EditableField): boolean {
  return field in changedFields(drafts[row.project_id], row);
}

/** Ids of projects with at least one changed field, in `rows` order. */
export function changedProjectIds(drafts: RegisterDrafts, rows: readonly RegisterRow[]): string[] {
  return rows.filter((r) => Object.keys(changedFields(drafts[r.project_id], r)).length > 0).map((r) => r.project_id);
}

/** P47 (ADR 0059): the snapshot key of one step's served exclusion flag. */
export function stepBaseKey(stepCode: string): string {
  return `step:${stepCode}`;
}

/**
 * P47 (ADR 0059 C1): the served values of `row` a `base` snapshot may capture.
 * A value not served yet (lab flag, hub, steps not loaded) is `undefined`, so
 * it is captured later, when it is known, never as a guessed `null`.
 */
export function registerSnapshotValues(row: RegisterRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...baseValues(row),
    hub_id: row.hub_id === undefined || row.hub_id === null ? undefined : row.hub_id,
    certification_testing_required:
      row.certification_testing_required === undefined || row.certification_testing_required === null
        ? undefined
        : row.certification_testing_required,
  };
  for (const [code, on] of Object.entries(row.excluded ?? {})) out[stepBaseKey(code)] = on;
  return out;
}

/** The snapshot keys a draft patch touches (its scalars and its steps). */
export function draftBaseKeys(patch: RegisterDraft): string[] {
  const keys = Object.keys(patch).filter((k) => k !== 'excluded');
  for (const code of Object.keys(patch.excluded ?? {})) keys.push(stepBaseKey(code));
  return keys;
}

/** The `base` of one batch row: each changed scalar's value as first read,
 *  and the first-read flag of each step whose exclusion it changes. */
function registerPatchBase(patch: RegisterEditPatch, row: RegisterRow, snapshots: BaseSnapshots): EditBase {
  const scalars = Object.keys(patch).filter((k) => k !== 'project_id' && k !== 'step_exclusions' && k !== 'base');
  const fallback = registerSnapshotValues(row);
  const base = snapshotBase(snapshots, row.project_id, scalars, fallback);
  if (patch.step_exclusions) {
    const steps = snapshotBase(
      snapshots,
      row.project_id,
      patch.step_exclusions.map((e) => stepBaseKey(e.step_code)),
      fallback,
    );
    // The backend's shape: `{code: excluded-as-read}` (conflict field `step_exclusions.<code>`).
    base.step_exclusions = Object.fromEntries(
      patch.step_exclusions.map((e) => [e.step_code, steps[stepBaseKey(e.step_code)] ?? false]),
    );
  }
  return base;
}

/** The ONE batch body: per changed project, only its changed fields, and
 *  (P47) when `snapshots` is given, the row's `base`. */
export function buildRegisterEditsBody(
  drafts: RegisterDrafts,
  rows: readonly RegisterRow[],
  snapshots?: BaseSnapshots,
): RegisterEditsRequest {
  const edits: RegisterEditPatch[] = [];
  for (const row of rows) {
    const changed = changedFields(drafts[row.project_id], row);
    // The current step is a pick from a list; there is no "clear" (contract §2.2).
    if (changed.current_step_code === null) delete changed.current_step_code;
    const { excluded, ...scalars } = changed;
    const patch: RegisterEditPatch = { project_id: row.project_id, ...scalars } as RegisterEditPatch;
    if (excluded) {
      // The popup's key and order (API_CONTRACT_REGISTER_POPUP §2.1): workflow order.
      const order = new Map((row.step_order ?? []).map((code, i) => [code, i]));
      patch.step_exclusions = Object.entries(excluded)
        .sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
        .map(([step_code, step_excluded]) => ({ step_code, step_excluded }));
    }
    if (Object.keys(patch).length > 1) {
      if (snapshots) patch.base = registerPatchBase(patch, row, snapshots);
      edits.push(patch);
    }
  }
  return { edits };
}

/** The inline end-before-start warning (the server's 422
 *  `ACTUAL_END_BEFORE_START` is the rule; this only flags the typed pair). */
export function endBeforeStart(values: Pick<RegisterValues, 'actual_start_week' | 'actual_end_week'>): boolean {
  return (
    values.actual_start_week !== null &&
    values.actual_end_week !== null &&
    values.actual_end_week < values.actual_start_week
  );
}

/** A typed design / lab time: `''` → null (no figure, "calculated"); a number
 *  0..9999.99 with at most 2 decimals; anything else `undefined` (not staged). */
export function parseEffortInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n <= 9999.99 ? n : undefined;
}

/** True for a conflict field that names the step exclusions
 *  (`step_exclusions.<code>`, or the whole `step_exclusions`). */
export function isStepConflictField(field: string): boolean {
  return field === 'step_exclusions' || field.startsWith('step_exclusions.');
}

/** The step code of a `step_exclusions.<code>` conflict; null for the whole set. */
function stepConflictCode(field: string): string | null {
  return field.startsWith('step_exclusions.') ? field.slice('step_exclusions.'.length) : null;
}

/**
 * P47 (ADR 0059 C2, "Use theirs"): the draft without the conflicting fields;
 * every other staged field stays. Step conflicts drop the staged exclusions.
 */
export function withoutConflictFields<D extends { excluded?: Readonly<Record<string, boolean>> | undefined }>(
  draft: D,
  fields: Iterable<string>,
): D {
  const out: Record<string, unknown> = { ...draft };
  for (const field of fields) {
    if (!isStepConflictField(field)) {
      delete out[field];
      continue;
    }
    const code = stepConflictCode(field);
    const excluded = out.excluded as Record<string, boolean> | undefined;
    if (code === null || !excluded) {
      delete out.excluded;
      continue;
    }
    const rest = { ...excluded };
    delete rest[code];
    if (Object.keys(rest).length > 0) out.excluded = rest;
    else delete out.excluded;
  }
  return out as D;
}

/** The snapshot keys to forget after "Use theirs" (re-captured on the next edit). */
export function conflictBaseKeys(fields: Iterable<string>, draft: RegisterDraft | undefined): string[] {
  const keys: string[] = [];
  for (const field of fields) {
    if (!isStepConflictField(field)) keys.push(field);
    else {
      const code = stepConflictCode(field);
      keys.push(...(code === null ? Object.keys(draft?.excluded ?? {}) : [code]).map(stepBaseKey));
    }
  }
  return keys;
}
