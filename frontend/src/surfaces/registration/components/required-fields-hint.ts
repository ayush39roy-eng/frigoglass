/**
 * Client-side MIRROR of `backend/services/project_hard_gates.py::HARD_GATE_FIELDS`.
 * Client validation is for responsiveness only — the backend is the authority
 * (`frontend-builder` SKILL, same idiom as the Matrix's `score-edit-schema.ts`).
 *
 * P23-T01 / P23-T02 (owner ruling 2026-10-21, ADR 0034, `docs/API_CONTRACT_P23.md`):
 * Draft is dropped from registration and `POST /projects` creates the project
 * In Queue. A legacy Draft project still leaves Draft through
 * `GET /projects/{id}/hard-gate-status` + `POST …/submit` (`hard-gate-panel.tsx`);
 * that answer is always the server's.
 *
 * P56 (owner 2026-11-19, "remove all the mandatory fields except project
 * title"; Hub kept): `HARD_GATE_FIELDS` is empty, so only Name (form schema)
 * and Hub (form submit) are required. `CLIENT_REQUIRED_FIELD_KEYS` is empty and
 * `missingRequiredFields` never blocks a submit. The labels below are kept
 * ONLY so a server 422 naming one of these fields (`HARD_GATE_FIELDS_MISSING`,
 * should the server ever send it) still lands on that field
 * (`requiredFieldErrorsFromApi`). A project saved without priority or
 * category is not scheduled until they are set.
 */

import { ApiError } from '@/lib/api/client';

/** Fields a server 422 may name (former gate fields) → the server's label. */
export const REQUIRED_FIELD_LABELS = {
  leader_engineer_id: 'leader',
  category: 'category',
  type: 'type',
  // ADR 0065 (P55): `actual_start_week` is no longer a gate field — the
  // scheduler starts an unstarted project at max(current week, start week).
  tcogs_eur: 'TCOGS',
  selling_price_eur: 'selling price',
  gross_margin_pct: 'gross margin',
  priority: 'priority',
} as const;

export type RequiredFieldKey = keyof typeof REQUIRED_FIELD_LABELS;

export const REQUIRED_FIELD_KEYS = Object.keys(REQUIRED_FIELD_LABELS) as RequiredFieldKey[];

/** The fallback inline message when a server 422 names the field without one. */
export const REQUIRED_FIELD_MESSAGES: Record<RequiredFieldKey, string> = {
  leader_engineer_id: 'Leader is required.',
  category: 'Category is required.',
  type: 'Type is required.',
  tcogs_eur: 'TCOGS is required.',
  selling_price_eur: 'Selling price is required.',
  gross_margin_pct: 'Gross margin is required.',
  priority: 'Priority is required.',
};

export type RequiredFieldErrors = Partial<Record<RequiredFieldKey, string>>;

/** P56: the fields the client checks before submit — none (Name and Hub are
 *  checked by the form itself). Mirrors the empty `HARD_GATE_FIELDS`. */
export const CLIENT_REQUIRED_FIELD_KEYS: readonly RequiredFieldKey[] = [];

/** Which client-required fields are unset in the values about to be sent.
 *  `null`, `undefined` and blank strings count as unset (the server checks
 *  `is None`). P56: always empty, since no gate field is required. */
export function missingRequiredFields(values: Readonly<Partial<Record<RequiredFieldKey, unknown>>>): RequiredFieldErrors {
  const errors: RequiredFieldErrors = {};
  for (const key of CLIENT_REQUIRED_FIELD_KEYS) {
    const v = values[key];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      errors[key] = REQUIRED_FIELD_MESSAGES[key];
    }
  }
  return errors;
}

/** A field name or the server's human label ("TCOGS", "gross margin") → key. */
function toRequiredKey(name: string): RequiredFieldKey | null {
  const n = name.trim();
  if ((REQUIRED_FIELD_KEYS as string[]).includes(n)) return n as RequiredFieldKey;
  const lower = n.toLowerCase();
  for (const key of REQUIRED_FIELD_KEYS) {
    if (REQUIRED_FIELD_LABELS[key].toLowerCase() === lower) return key;
  }
  return null;
}

function messageFor(key: RequiredFieldKey, raw: unknown): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : REQUIRED_FIELD_MESSAGES[key];
}

/**
 * Per-field errors from a 422 on `POST /projects` (P23-T02). Accepts the
 * leave-Draft gate shape the backend reuses (`detail.missing_fields: string[]`,
 * labels or field names), an optional `detail.field_errors` map
 * (`{field: message}`), and FastAPI's validation list (`[{loc, msg}]`). Returns
 * null when nothing maps onto a required field, so the caller falls back to
 * the general error line. Never echoes a submitted value (financial fields).
 */
export function requiredFieldErrorsFromApi(err: unknown): RequiredFieldErrors | null {
  if (!(err instanceof ApiError) || err.status !== 422 || !err.detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.detail);
  } catch {
    return null;
  }
  const out: RequiredFieldErrors = {};
  const add = (name: unknown, msg?: unknown): void => {
    if (typeof name !== 'string') return;
    const key = toRequiredKey(name);
    if (key) out[key] = messageFor(key, msg);
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const loc = (item as { loc?: unknown }).loc;
        const last = Array.isArray(loc) ? loc[loc.length - 1] : undefined;
        add(last, (item as { msg?: unknown }).msg);
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const body = parsed as { missing_fields?: unknown; field_errors?: unknown };
    if (Array.isArray(body.missing_fields)) {
      for (const f of body.missing_fields) {
        if (typeof f === 'string') add(f);
        else if (f && typeof f === 'object') {
          const o = f as { field?: unknown; label?: unknown; message?: unknown };
          add(o.field ?? o.label, o.message);
        }
      }
    }
    if (body.field_errors && typeof body.field_errors === 'object') {
      if (Array.isArray(body.field_errors)) {
        for (const f of body.field_errors as unknown[]) {
          if (f && typeof f === 'object') {
            const o = f as { field?: unknown; message?: unknown };
            add(o.field, o.message);
          }
        }
      } else {
        for (const [name, msg] of Object.entries(body.field_errors as Record<string, unknown>)) add(name, msg);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * ADR 0065 §2–3: the actual start week stays required only for a started
 * status (the DOMAIN_RULES per-stage rule: In Progress, Blocked — shown "On
 * Hold" — or Done). The server is the authority; this only drives the mark.
 */
export const START_WEEK_REQUIRED_STATUSES: readonly string[] = ['In Progress', 'Blocked', 'Done'];

export function startWeekRequiredFor(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && START_WEEK_REQUIRED_STATUSES.includes(status);
}

/**
 * ADR 0065 §3: the server's own message for `actual_start_week` from a 422
 * (FastAPI `[{loc, msg}]`, `detail.field_errors` map or list, or
 * `detail.errors: [{field, message}]`), or null. Never echoes a value.
 */
export function startWeekErrorFromApi(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 422 || !err.detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.detail);
  } catch {
    return null;
  }
  const FIELD = 'actual_start_week';
  const pick = (items: unknown[], nameOf: (o: Record<string, unknown>) => unknown, msgOf: (o: Record<string, unknown>) => unknown): string | null => {
    for (const item of items) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        if (nameOf(o) === FIELD) {
          const msg = msgOf(o);
          return typeof msg === 'string' && msg.trim() !== '' ? msg : 'Actual start week is required for a started status.';
        }
      }
    }
    return null;
  };
  if (Array.isArray(parsed)) {
    return pick(parsed, (o) => (Array.isArray(o.loc) ? o.loc[o.loc.length - 1] : undefined), (o) => o.msg);
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as { field_errors?: unknown; errors?: unknown };
  if (Array.isArray(body.field_errors)) {
    const hit = pick(body.field_errors, (o) => o.field, (o) => o.message);
    if (hit) return hit;
  } else if (body.field_errors && typeof body.field_errors === 'object') {
    const msg = (body.field_errors as Record<string, unknown>)[FIELD];
    if (typeof msg === 'string' && msg.trim() !== '') return msg;
  }
  if (Array.isArray(body.errors)) return pick(body.errors, (o) => o.field, (o) => o.message);
  return null;
}
