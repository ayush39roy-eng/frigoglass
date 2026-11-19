# ADR 0065 — Actual start week is optional at registration; the scheduler decides the start

- **Status:** Accepted (2026-11-19, orchestrator, owner and client request).
- **Amends:** ADR 0034 §1 (hard-gate fields at create) and the legacy leave-Draft check.

## Context

The client asked why "Actual start week" is mandatory when registering a project, since the
scheduler should plan the start. It is mandatory only because the original "leave Draft" hard-gate
list included "actual start date", and ADR 0034 applied that list at create. The scheduler does
not need it for a project that is not started. It starts the project at
`max(CURRENT_WEEK, actual_start_week or CURRENT_WEEK)` (DOMAIN_RULES), so a past value does nothing
and a future value only delays the start.

## Decision

1. **Removed from the hard-gate fields.** `actual_start_week` leaves `HARD_GATE_FIELDS`, so it no
   longer applies to `POST /projects`, `GET /projects/{id}/hard-gate-status` or `POST …/submit`.
   The other gate fields are unchanged: leader, category, type, TCOGS, selling price, gross margin and
   priority.
2. **Still required for a started project.** The existing rule is unchanged (DOMAIN_RULES,
   project fields): it must be non-null when the status is In Progress, Blocked or Done.
3. **Form.**
   - The field has no required mark. Empty shows the placeholder "Unset — scheduled by the
     scheduler", in the same style as Priority's "Unset".
   - A value later than the current week shows the hint "Won't start before W{n}". A value at or
     before the current week shows no hint for a not-yet-started project.
   - When the status chosen is In Progress, Blocked or Done, the field gets the required mark and
     the server's message.
   - Clearing the value sends `null`.
4. **No data change.** Stored values stay as they are. The scheduler, the migrations and the seed
   are untouched.

## Consequences

- `HARD_GATE_FIELDS` and its frontend mirror (`required-fields-hint.ts`) change together. The
  tests that asserted the start week was required are updated.
- Gate: qa, workflow (a project registered without a start week is scheduled from the current
  week, and nothing else in the run changes) and security (validation unchanged otherwise).

## Gate amendment (2026-11-19)

- §3, the third bullet: In Progress, Blocked and Done are stage statuses, not project statuses, so
  the required mark applies in the Workspace stage editor and through the backend's 422
  `STAGE_INCONSISTENT`, not on the project form. The workflow-auditor ruled this acceptable.
