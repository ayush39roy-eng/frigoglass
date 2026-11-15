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

import type { ProjectStatus } from '@/types/enums';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';

import type { RegisterEditPatch, RegisterEditsRequest } from '../api/register-edits';

export const EDITABLE_FIELDS = [
  'status',
  'leader_engineer_id',
  'actual_start_week',
  'actual_end_week',
  'design_effort_weeks',
  'lab_effort_weeks',
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface RegisterValues {
  status: ProjectStatus;
  leader_engineer_id: string | null;
  actual_start_week: number | null;
  actual_end_week: number | null;
  design_effort_weeks: number | null;
  lab_effort_weeks: number | null;
}

export type RegisterDraft = Partial<RegisterValues>;
export type RegisterDrafts = Readonly<Record<string, RegisterDraft>>;

/** The served values of the editable fields. */
export function baseValues(row: ProjectFilterRow): RegisterValues {
  return {
    status: row.status,
    leader_engineer_id: row.leader_engineer_id,
    actual_start_week: row.actual_start_week,
    actual_end_week: row.actual_end_week,
    design_effort_weeks: row.design_effort_weeks,
    lab_effort_weeks: row.lab_effort_weeks,
  };
}

/** What the grid shows for `row` in Edit mode: the draft over the served row. */
export function valuesFor(drafts: RegisterDrafts, row: ProjectFilterRow): RegisterValues {
  const draft = drafts[row.project_id];
  return draft ? { ...baseValues(row), ...draft } : baseValues(row);
}

/** Only the fields of `draft` that still differ from the CURRENT served row
 *  (a refetch may have caught up with a draft). */
export function changedFields(draft: RegisterDraft | undefined, row: ProjectFilterRow): RegisterDraft {
  const out: Record<string, unknown> = {};
  if (!draft) return out;
  const base = baseValues(row);
  for (const field of EDITABLE_FIELDS) {
    if (field in draft && draft[field] !== base[field]) out[field] = draft[field];
  }
  return out as RegisterDraft;
}

function withValues(drafts: RegisterDrafts, row: ProjectFilterRow, patch: RegisterDraft): RegisterDrafts {
  const merged = changedFields({ ...(drafts[row.project_id] ?? {}), ...patch }, row);
  const out: Record<string, RegisterDraft> = { ...drafts };
  if (Object.keys(merged).length > 0) out[row.project_id] = merged;
  else delete out[row.project_id];
  return out;
}

export function setDraftField<F extends EditableField>(
  drafts: RegisterDrafts,
  row: ProjectFilterRow,
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
  rows: readonly ProjectFilterRow[],
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

export function fieldChanged(drafts: RegisterDrafts, row: ProjectFilterRow, field: EditableField): boolean {
  return field in changedFields(drafts[row.project_id], row);
}

/** Ids of projects with at least one changed field, in `rows` order. */
export function changedProjectIds(drafts: RegisterDrafts, rows: readonly ProjectFilterRow[]): string[] {
  return rows.filter((r) => Object.keys(changedFields(drafts[r.project_id], r)).length > 0).map((r) => r.project_id);
}

/** The ONE batch body: per changed project, only its changed fields. */
export function buildRegisterEditsBody(drafts: RegisterDrafts, rows: readonly ProjectFilterRow[]): RegisterEditsRequest {
  const edits: RegisterEditPatch[] = [];
  for (const row of rows) {
    const changed = changedFields(drafts[row.project_id], row);
    if (Object.keys(changed).length > 0) edits.push({ project_id: row.project_id, ...changed });
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
