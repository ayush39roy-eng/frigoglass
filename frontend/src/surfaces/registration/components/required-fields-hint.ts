/**
 * Client-side MIRROR of `backend/services/project_hard_gates.py::HARD_GATE_FIELDS`.
 * Client validation is for responsiveness only — the backend is the authority
 * (`frontend-builder` SKILL, same idiom as the Matrix's `score-edit-schema.ts`).
 *
 * P23-T01 / P23-T02 (owner ruling 2026-10-21, ADR 0034, `docs/API_CONTRACT_P23.md`):
 * Draft is dropped from
 * registration. `POST /projects` validates these fields up front and creates
 * the project In Queue, so the create form checks them before submit
 * (`missingRequiredFields`) and maps the server's 422 onto the same fields
 * (`requiredFieldErrorsFromApi`). A legacy Draft project still leaves Draft
 * through `GET /projects/{id}/hard-gate-status` + `POST …/submit`
 * (`hard-gate-panel.tsx`); that answer is always the server's.
 */

import { ApiError } from '@/lib/api/client';

export const REQUIRED_FIELD_LABELS = {
  leader_engineer_id: 'leader',
  category: 'category',
  type: 'type',
  actual_start_week: 'actual start date',
  tcogs_eur: 'TCOGS',
  selling_price_eur: 'selling price',
  gross_margin_pct: 'gross margin',
  // ADR 0034 / docs/API_CONTRACT_P23.md §1: the scheduler needs a priority.
  priority: 'priority',
} as const;

export type RequiredFieldKey = keyof typeof REQUIRED_FIELD_LABELS;

export const REQUIRED_FIELD_KEYS = Object.keys(REQUIRED_FIELD_LABELS) as RequiredFieldKey[];

/** The inline message shown under a missing required field. */
export const REQUIRED_FIELD_MESSAGES: Record<RequiredFieldKey, string> = {
  leader_engineer_id: 'Leader is required.',
  category: 'Category is required.',
  type: 'Type is required.',
  actual_start_week: 'Actual start week is required.',
  tcogs_eur: 'TCOGS is required.',
  selling_price_eur: 'Selling price is required.',
  gross_margin_pct: 'Gross margin is required.',
  priority: 'Priority is required.',
};

export type RequiredFieldErrors = Partial<Record<RequiredFieldKey, string>>;

/** Which required fields are unset in the values about to be sent. `null`,
 *  `undefined` and blank strings count as unset (the server checks `is None`). */
export function missingRequiredFields(values: Readonly<Partial<Record<RequiredFieldKey, unknown>>>): RequiredFieldErrors {
  const errors: RequiredFieldErrors = {};
  for (const key of REQUIRED_FIELD_KEYS) {
    const v = values[key];
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
      errors[key] = REQUIRED_FIELD_MESSAGES[key];
    }
  }
  return errors;
}

/** A field name or the server's human label ("TCOGS", "actual start date") → key. */
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
