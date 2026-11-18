/**
 * P47-T03 (ADR 0059 C1 / C2): the field-level optimistic check, browser side.
 *
 * Every edit request carries, for each field it changes, the value the user
 * STARTED FROM:
 *
 *   single record (PATCH / PUT):  { …changes, "base": { field: value-as-read } }
 *   batch (register-edits, bulk): { edits: [{ id, …changes, "base": {…} }, …] }
 *
 * `base` holds only the fields being changed. The server compares each with
 * the stored value under the row lock and answers 409 `EDIT_CONFLICT` (nothing
 * written) when any differs. This module only carries values: it never decides
 * whether two values conflict (the server does, with its own normalisation).
 *
 * "The value as read" is the TanStack Query cached value at the moment the user
 * started editing, never the value after a later refetch. Grids that stage
 * edits over time keep a {@link BaseSnapshots} map, captured per field the
 * first time that field is changed (`captureBase`); forms take the record they
 * were opened with (`pickBase`).
 */

import { ApiError } from './client';

/** The `base` object of one record: field → value as the client read it. */
export type EditBase = Record<string, unknown>;

export const EDIT_CONFLICT = 'EDIT_CONFLICT';
/** What the server sends in place of a financial value (TCOGS, margin, selling
 *  price, customer name): never echoed. Shown as "hidden". */
export const HIDDEN_VALUE = '<hidden>';

/** One element of `conflicts` on a 409 `EDIT_CONFLICT`. */
export interface EditConflict {
  entity: string;
  id: string;
  /** A human label for the record (project name, engineer name…). */
  label: string;
  /** The API field name (`status`, `leader_engineer_id`…). */
  field: string;
  your_value: unknown;
  current_value: unknown;
  /** Full name from the latest audit row; null when no audit row exists. */
  changed_by: string | null;
  /** ISO timestamp of that audit row; null when none. */
  changed_at: string | null;
}

// ---- building `base` --------------------------------------------------------

/** `base` for a form: the values of `fields` in the record as it was opened. */
export function pickBase(original: object, fields: Iterable<string>): EditBase {
  const src = original as Record<string, unknown>;
  const out: EditBase = {};
  for (const field of fields) {
    if (field === 'base') continue;
    out[field] = field in src ? src[field] : null;
  }
  return out;
}

/** The fields of `changes` whose value differs from `original` (deep for
 *  arrays / objects): what a form actually changed. */
export function changedKeys(original: object, changes: object): string[] {
  const src = original as Record<string, unknown>;
  return Object.entries(changes as Record<string, unknown>)
    .filter(([k, v]) => k !== 'base' && !sameValue(src[k], v))
    .map(([k]) => k);
}

/** `body` with its `base` set (only the fields `body` changes, read from `original`). */
export function withBase<B extends object>(body: B, original: object, fields?: Iterable<string>): B & { base: EditBase } {
  const keys = fields ?? Object.keys(body).filter((k) => k !== 'base');
  return { ...body, base: pickBase(original, keys) };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Per-record snapshots of the values a user started from, keyed by record id. */
export type BaseSnapshots = Readonly<Record<string, EditBase>>;

/**
 * Captures `fields` of `values` into the record's snapshot, keeping a field
 * already captured (the value the user STARTED from wins). Returns the same
 * object when nothing new is captured, so it is safe in a state updater.
 * A value of `undefined` (not served yet) is not captured.
 */
export function captureBase(
  snapshots: BaseSnapshots,
  key: string,
  values: object,
  fields: Iterable<string>,
): BaseSnapshots {
  const src = values as Record<string, unknown>;
  const current = snapshots[key] ?? {};
  let next: EditBase | null = null;
  for (const field of fields) {
    if (field in current || src[field] === undefined) continue;
    next ??= { ...current };
    next[field] = src[field];
  }
  return next ? { ...snapshots, [key]: next } : snapshots;
}

/** The snapshot's `base` for `fields`; a field never captured falls back to `fallback`. */
export function snapshotBase(
  snapshots: BaseSnapshots,
  key: string,
  fields: Iterable<string>,
  fallback: object,
): EditBase {
  const snap = snapshots[key] ?? {};
  const src = fallback as Record<string, unknown>;
  const out: EditBase = {};
  for (const field of fields) out[field] = field in snap ? snap[field] : field in src ? src[field] : null;
  return out;
}

/** Forgets `fields` of one record (all when omitted): the next edit re-captures them. */
export function forgetBase(snapshots: BaseSnapshots, key: string, fields?: Iterable<string>): BaseSnapshots {
  if (!(key in snapshots)) return snapshots;
  const out: Record<string, EditBase> = { ...snapshots };
  if (fields === undefined) {
    delete out[key];
    return out;
  }
  const rest: EditBase = { ...out[key] };
  for (const f of fields) delete rest[f];
  if (Object.keys(rest).length === 0) delete out[key];
  else out[key] = rest;
  return out;
}

// ---- reading a 409 ----------------------------------------------------------

function isConflict(v: unknown): v is EditConflict {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.field === 'string';
}

function normalise(v: EditConflict): EditConflict {
  const o = v as unknown as Record<string, unknown>;
  return {
    entity: typeof o.entity === 'string' ? o.entity : '',
    id: typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : '',
    label: typeof o.label === 'string' ? o.label : '',
    field: v.field,
    your_value: o.your_value ?? null,
    current_value: o.current_value ?? null,
    changed_by: typeof o.changed_by === 'string' ? o.changed_by : null,
    changed_at: typeof o.changed_at === 'string' ? o.changed_at : null,
  };
}

/**
 * The conflicts of a 409 `EDIT_CONFLICT`, or `null` for any other error.
 * Accepts `conflicts` at the envelope's top level (ADR 0059) or inside an
 * object `detail` (the `CodedHTTPException` shape).
 */
export function editConflicts(err: unknown): EditConflict[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body;
  const detail: unknown = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
  const detailObj = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : null;
  const code = err.code ?? (typeof detailObj?.code === 'string' ? detailObj.code : undefined);
  if (code !== EDIT_CONFLICT) return null;
  const list: unknown =
    (body && typeof body === 'object' ? (body as { conflicts?: unknown }).conflicts : undefined) ?? detailObj?.conflicts;
  return Array.isArray(list) ? list.filter(isConflict).map(normalise) : [];
}

export function isEditConflict(err: unknown): boolean {
  return editConflicts(err) !== null;
}

/** The conflicts of one record (`id`), or all when `id` is omitted. */
export function conflictsFor(conflicts: readonly EditConflict[], id?: string): EditConflict[] {
  return id === undefined ? [...conflicts] : conflicts.filter((c) => c.id === id || c.id === '');
}

/**
 * "Keep mine": the same `base` with each conflicting field set to the value
 * stored NOW (the 409's `current_value`), so the resend is a deliberate
 * overwrite. A hidden (financial) current value cannot be echoed back, so that
 * field leaves `base`: it is then not checked, which is the overwrite the user
 * chose. Fields without a conflict keep their original base.
 */
export function keepMineBase(base: EditBase, conflicts: readonly EditConflict[]): EditBase {
  const out: EditBase = { ...base };
  for (const c of conflicts) {
    const hidden = c.current_value === HIDDEN_VALUE;
    if (c.field in out) {
      if (hidden) delete out[c.field];
      else out[c.field] = c.current_value;
      continue;
    }
    // A dotted field: `step_exclusions.<code>` / `scores.<key>` (a key of an
    // object base) or `<step_id>.<field>` (a stage's own field).
    const dot = c.field.indexOf('.');
    if (dot < 0) continue;
    const head = c.field.slice(0, dot);
    const tail = c.field.slice(dot + 1);
    const nested = out[head];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const copy: Record<string, unknown> = { ...(nested as Record<string, unknown>) };
      if (hidden) delete copy[tail];
      else copy[tail] = c.current_value;
      out[head] = copy;
    } else if (tail in out) {
      if (hidden) delete out[tail];
      else out[tail] = c.current_value;
    }
  }
  return out;
}

/** The record field a conflict names: `<step_id>.status` → `status`; a
 *  plain field is returned as is. */
export function conflictLeafField(field: string): string {
  const dot = field.lastIndexOf('.');
  return dot < 0 ? field : field.slice(dot + 1);
}

/** The prefix of a dotted conflict field (`<step_id>.status` → `<step_id>`), else null. */
export function conflictFieldPrefix(field: string): string | null {
  const dot = field.indexOf('.');
  return dot < 0 ? null : field.slice(0, dot);
}

/** The conflicting field names, per record id (`''` when the server named none). */
export function conflictFieldsById(conflicts: readonly EditConflict[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of conflicts) {
    let set = out.get(c.id);
    if (!set) out.set(c.id, (set = new Set()));
    set.add(c.field);
  }
  return out;
}

// ---- the resolve loop of one save -------------------------------------------

/** The user's answer in the conflict dialog; `null` = closed without choosing
 *  (nothing is saved, the edit stays where it was). */
export type ConflictChoice = 'theirs' | 'mine' | null;

export type ConflictSaveOutcome<T> =
  | { outcome: 'saved'; data: T }
  | { outcome: 'theirs' | 'dismissed'; conflicts: EditConflict[] };

/**
 * One save with the ADR 0059 C2 loop: send with `base`; on 409
 * `EDIT_CONFLICT` ask the user; "Keep mine" resends with {@link keepMineBase}
 * (and asks again if yet another change landed meanwhile); "Use theirs" runs
 * `onUseTheirs` (refetch, drop the conflicting fields) and resolves without
 * saving. Any other error is rethrown untouched.
 */
export async function saveWithConflictCheck<T>(opts: {
  send: (base: EditBase) => Promise<T>;
  base: EditBase;
  ask: (conflicts: EditConflict[]) => Promise<ConflictChoice>;
  onUseTheirs?: (conflicts: EditConflict[]) => void | Promise<void>;
}): Promise<ConflictSaveOutcome<T>> {
  let base = opts.base;
  for (;;) {
    try {
      return { outcome: 'saved', data: await opts.send(base) };
    } catch (err) {
      const conflicts = editConflicts(err);
      if (conflicts === null) throw err;
      const choice = await opts.ask(conflicts);
      if (choice === 'mine') {
        base = keepMineBase(base, conflicts);
        continue;
      }
      if (choice === 'theirs') {
        await opts.onUseTheirs?.(conflicts);
        return { outcome: 'theirs', conflicts };
      }
      return { outcome: 'dismissed', conflicts };
    }
  }
}

/** `body` plus its `base`, when there is one (`base` is optional server-side). */
export function bodyWithBase<B extends object>(body: B, base: EditBase | undefined): B | (B & { base: EditBase }) {
  return base === undefined ? body : { ...body, base };
}

export type EditSendOutcome<T> =
  | { outcome: 'saved'; data: T; dropped: string[] }
  /** "Use theirs" dropped every changed field: nothing was left to send. */
  | { outcome: 'theirs'; dropped: string[] }
  /** The dialog was closed without a choice: nothing saved. */
  | { outcome: 'dismissed'; conflicts: EditConflict[] };

/**
 * A single-record edit (PATCH / PUT) with the ADR 0059 loop. `body` holds
 * only the changed fields; `base` is read from `original`, the record as it
 * was when the user started editing (`readBase` maps a field whose read
 * shape differs from its write shape).
 *
 * - "Keep mine": resend with `base` = the values stored now.
 * - "Use theirs": drop my value for the conflicting fields only, refetch
 *   (`onUseTheirs`) and send the remaining fields, which never conflicted
 *   (a form has no edit buffer to keep them in, and they must not be lost).
 * - Closed: nothing is saved; the caller keeps the form open.
 */
export async function sendEditWithBase<B extends object, T>(opts: {
  body: B;
  original: object;
  send: (body: B & { base: EditBase }) => Promise<T>;
  ask: (conflicts: EditConflict[]) => Promise<ConflictChoice>;
  onUseTheirs?: (conflicts: EditConflict[]) => void | Promise<void>;
  readBase?: (field: string) => unknown;
  /** A PUT that must carry every field: "Use theirs" puts the stored value
   *  in place of mine (and in `base`) instead of leaving the field out; when
   *  nothing of mine is left, nothing is sent. */
  replaceOnTheirs?: boolean;
}): Promise<EditSendOutcome<T>> {
  let body: Record<string, unknown> = { ...(opts.body as Record<string, unknown>) };
  delete body.base;
  let base: EditBase = opts.readBase
    ? Object.fromEntries(Object.keys(body).map((f) => [f, opts.readBase?.(f) ?? null]))
    : pickBase(opts.original, Object.keys(body));
  const dropped: string[] = [];
  for (;;) {
    try {
      const data = await opts.send({ ...body, base } as B & { base: EditBase });
      return { outcome: 'saved', data, dropped };
    } catch (err) {
      const conflicts = editConflicts(err);
      if (conflicts === null) throw err;
      const choice = await opts.ask(conflicts);
      if (choice === 'mine') {
        base = keepMineBase(base, conflicts);
        continue;
      }
      if (choice !== 'theirs') return { outcome: 'dismissed', conflicts };
      const fields = new Set(conflicts.map((c) => c.field));
      if (opts.replaceOnTheirs) {
        for (const c of conflicts) {
          if (!(c.field in body) || c.current_value === HIDDEN_VALUE) continue;
          body[c.field] = c.current_value;
          base[c.field] = c.current_value;
        }
      } else {
        body = Object.fromEntries(Object.entries(body).filter(([k]) => !fields.has(k)));
        base = Object.fromEntries(Object.entries(base).filter(([k]) => !fields.has(k)));
      }
      dropped.push(...fields);
      await opts.onUseTheirs?.(conflicts);
      const mineLeft = opts.replaceOnTheirs
        ? Object.keys(body).some((k) => !sameValue(body[k], base[k]))
        : Object.keys(body).length > 0;
      if (!mineLeft) return { outcome: 'theirs', dropped };
    }
  }
}

/** The form-level message after "Use theirs" / a closed dialog. */
export const CONFLICT_COPY = {
  dismissed: 'Nothing was saved: someone else changed this while you were editing. Save again to choose whose value to keep.',
  theirs: 'Their saved values were kept; the form shows them now.',
  theirsKept: 'Nothing was saved. Their values were kept for the conflicting fields; your other changes are still here: save again to keep them.',
  batchTheirs: 'Their saved values were kept for the conflicting fields. Your other edits are still here: save again to keep them.',
  batchNote: 'Your other edits stay in the edit buffer.',
} as const;

/** Thrown by a save whose conflict dialog was closed without a choice:
 *  nothing was saved and the editor stays open. Its message is user-facing. */
export class EditConflictDismissedError extends Error {
  constructor(message: string = CONFLICT_COPY.dismissed) {
    super(message);
    this.name = 'EditConflictDismissedError';
  }
}
