/**
 * Defense-in-depth client-side redaction for the Audit Log's `before_state`/
 * `after_state` JSON viewer.
 *
 * `backend/services/audit_helpers.py` already redacts these four field names
 * to the literal string `"<redacted>"` BEFORE a row is ever persisted
 * (`backend/models/types.py::FINANCIAL_FIELD_NAMES`) — a real financial value
 * never reaches this endpoint's response in the first place. See
 * `backend/schemas/audit.py`'s module docstring and
 * `backend/tests/test_audit_log_api.py::
 * test_audit_log_never_exposes_real_financial_values_to_admin_or_auditor`,
 * which proves this end-to-end against a real API mutation, not a hand-built
 * fixture.
 *
 * This module is a SECOND, independent guard, applied only in the browser,
 * per CLAUDE.md's "Financial fields ... never logged" non-negotiable: if any
 * write path this frontend does not control (a bug, a manual DB insert, a
 * future mutation handler that forgets to redact) ever lands an unredacted
 * financial value in a stored JSONB blob, this surface still never renders
 * it. It walks the object recursively (`before_state`/`after_state` can
 * nest), matching key names case-sensitively against the same four names
 * `backend/models/types.py::FINANCIAL_FIELD_NAMES` defines.
 */

export const FINANCIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  'tcogs_eur',
  'selling_price_eur',
  'gross_margin_pct',
  'customer_name',
]);

const REDACTED = '<redacted>';

export function redactFinancialFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactFinancialFields);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = FINANCIAL_FIELD_NAMES.has(key) ? REDACTED : redactFinancialFields(v);
    }
    return out;
  }
  return value;
}
