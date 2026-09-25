/**
 * Client-side MIRROR of `backend/services/project_hard_gates.py::HARD_GATE_FIELDS`
 * — used only to put a "required" asterisk on the form for responsiveness, the
 * same idiom the Matrix's `score-edit-schema.ts` uses for its Pydantic mirror
 * ("Client validation is for responsiveness only — the backend is the
 * authority", `frontend-builder` SKILL).
 *
 * The single AUTHORITATIVE answer for "can this project leave Draft" is
 * always `GET /projects/{id}/hard-gate-status` (`HardGateStatus`,
 * `hooks/use-registration.ts::useHardGateStatus`) — this list is never used to
 * compute `can_leave_draft` or a missing-fields count that gets displayed as
 * if it came from the server.
 */

export const REQUIRED_FIELD_LABELS = {
  leader_engineer_id: 'leader',
  category: 'category',
  type: 'type',
  actual_start_week: 'actual start date',
  tcogs_eur: 'TCOGS',
  selling_price_eur: 'selling price',
  gross_margin_pct: 'gross margin',
} as const;

export type RequiredFieldKey = keyof typeof REQUIRED_FIELD_LABELS;
