/**
 * Horizon constants from `docs/DOMAIN_RULES.md` ("Horizon constants").
 *
 * These are the DOMAIN_RULES contract, mirrored verbatim from the backend
 * (`backend/scheduling/domain_constants.py` / `backend/models` week fields) — they
 * are NOT derived and must never be recomputed. A frontend surface may draw a
 * fixed marker line at `WITHIN_YEAR_WEEK` (that is a constant, not a calculation),
 * but any per-project "completing within year" / spillover verdict is the server's
 * flag, never a client comparison (Invariant I9).
 */

/** 1-indexed absolute week number that "now" falls in. */
export const CURRENT_WEEK = 31;

/** A project completes "within the year" iff its last step ends (plus delay) by
 *  this week. The per-project verdict is `row.spillover` / `row.left_out` from the
 *  API — this constant only positions the year-end marker line. */
export const WITHIN_YEAR_WEEK = 52;

/** Total scheduling horizon. No feasible window before this week ⇒ `LEFT_OUT`. */
export const HORIZON_WEEKS = 78;
