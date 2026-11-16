import type { ImportFormat } from './import-types';

/**
 * P41 (ADR 0055 D1): the Excel-format editor's input checks, mirrored from the server's
 * validation so the planner sees a problem before Save. The server stays the authority
 * (422 `FORMAT_*`, 409 `FORMAT_VERSION_CONFLICT` are still shown). Nothing here touches a
 * schedule figure.
 */

export const MAX_ALIASES = 10;
export const MAX_ALIAS_LENGTH = 60;

/** Normalised the way the parser matches headers (and the server stores them): casefold, single spaces, trimmed. */
export function normaliseAlias(alias: string): string {
  return alias.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export type FormatDraft = Record<string, string[]>;

export function draftOf(format: ImportFormat): FormatDraft {
  return Object.fromEntries(format.fields.map((f) => [f.key, [...f.aliases]]));
}

/** Adds `alias` to a field's list unless it is blank or already there (normalised). */
export function withAlias(list: readonly string[], alias: string): string[] {
  const clean = alias.replace(/\s+/g, ' ').trim();
  if (clean === '') return [...list];
  const n = normaliseAlias(clean);
  return list.some((a) => normaliseAlias(a) === n) ? [...list] : [...list, clean];
}

export interface FormatDraftErrors {
  /** Per field key. */
  fields: Record<string, string>;
  /** A rule across fields ("Status or Hub needs a header name"). */
  form: string | null;
}

export function validateFormatDraft(format: ImportFormat, draft: FormatDraft): FormatDraftErrors {
  const fields: Record<string, string> = {};
  const owner = new Map<string, string>();
  const labelOf = new Map(format.fields.map((f) => [f.key, f.label]));
  for (const f of format.fields) {
    const list = draft[f.key] ?? [];
    if (list.length > MAX_ALIASES) {
      fields[f.key] = `At most ${String(MAX_ALIASES)} header names.`;
      continue;
    }
    for (const a of list) {
      const n = normaliseAlias(a);
      if (n.length < 1 || n.length > MAX_ALIAS_LENGTH) {
        fields[f.key] = `Each header name is 1–${String(MAX_ALIAS_LENGTH)} characters.`;
        break;
      }
      const other = owner.get(n);
      if (other !== undefined && other !== f.key) {
        fields[f.key] = `“${a}” is already a header name of ${labelOf.get(other) ?? other}.`;
        break;
      }
      owner.set(n, f.key);
    }
  }
  // Every field needs 1–10 header names; only one of Status / Hub may have none (backend
  // P41-T02: an empty list is allowed for exactly one of the two).
  const has = (key: string) => (draft[key] ?? []).length > 0;
  let form: string | null = null;
  for (const f of format.fields) {
    if (has(f.key) || f.key === 'status' || f.key === 'hub') continue;
    fields[f.key] ??= `${f.label} needs at least one header name.`;
  }
  if (!has('status') && !has('hub')) form = 'Status or Hub needs at least one header name.';
  return { fields, form };
}

export function hasDraftErrors(e: FormatDraftErrors): boolean {
  return e.form !== null || Object.keys(e.fields).length > 0;
}

/** The PUT body's `fields`: every field of the format, in served order. */
export function draftBody(format: ImportFormat, draft: FormatDraft): Record<string, string[]> {
  return Object.fromEntries(format.fields.map((f) => [f.key, draft[f.key] ?? []]));
}

/** "Required", "Status or Hub", or null. */
export function requirementOf(key: string, required: boolean): string | null {
  if (required) return 'Required';
  if (key === 'status' || key === 'hub') return 'Status or Hub';
  return null;
}
