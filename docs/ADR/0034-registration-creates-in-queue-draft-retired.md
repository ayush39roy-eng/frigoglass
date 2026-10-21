# ADR 0034: Registration creates In Queue projects; Draft retired

## Status

Accepted (2026-10-21). Part of P23 (P23-T01 frontend, P23-T02 backend). **Supersedes** the P1-T01 /
P3-T01 decision that `POST /projects` always creates a `Draft` row and that the hard gates apply
only when a project leaves Draft (`docs/PROJECT_AND_STACK.md` §2, Project Registration). Does not
change the scheduler: `Draft` was already excluded from scheduling and stays excluded
(`backend/scheduling/` is untouched).

## Context

Owner ruling, 2026-10-21: the Draft status is dropped from registration. A new project goes
straight to `In Queue`. A Draft-then-submit flow cost two steps and left half-registered projects
outside the plan. No stored project is `Draft` or `In Buyoff` today.

## Decision

1. **Create is gated up front.** `POST /projects` checks the hard-gate fields before it writes
   anything. The fields are leader, category, type, actual start week, TCOGS, selling price, gross
   margin and **priority**. If any is missing (absent or `null`), the response is a 422
   `HARD_GATE_FIELDS_MISSING` that lists every missing field. Nothing is written: no project, no
   stage rows, no audit row. `name` and `hub_id` are schema-required, as before.
2. **Priority joins the gate.** Under Draft, a project without a priority could not be scheduled
   and did no harm. A project that is `In Queue` from creation must have one, because the scheduler
   rejects a schedulable project with no priority as a configuration error for the whole run. The
   legacy leave-Draft check uses the same list, so `GET /projects/{id}/hard-gate-status` now also
   reports a missing priority.
3. **Created In Queue, marked stale.** A valid create writes `status = In Queue` and
   `schedule_stale = true`, because the project is not in the active run. No solve is triggered
   (ADR 0006). One `project.create` audit row is written, with the financial fields redacted.
   RBAC, hub scoping (a 403 for a hub outside scope comes before the gate check) and encryption of
   the financial fields are unchanged. An unknown `leader_engineer_id` is a 422 `UNKNOWN_LEADER`;
   before this ADR it surfaced as a foreign-key failure.
4. **One error shape.** The create 422 and the legacy `POST /projects/{id}/submit` 422 share one
   body: `code`, `detail.message`, `detail.missing_fields` (labels, as before) and
   `detail.field_errors` (`{field_name: message}`). See `docs/API_CONTRACT_P23.md`.
5. **Draft retired, not deleted.** The `Draft` enum value stays, for historic rows and for the
   migrations that created it. Nothing new creates Draft:
   - `POST /projects` writes `In Queue`.
   - The ORM no longer defaults `status` to `Draft`, so every writer must state a status.
   - `PATCH /projects/{id}` with `status: "Draft"` is a 422 `DRAFT_RETIRED`, even as a no-op on a
     legacy Draft row.
   - The seed refuses a Draft status in its data.

   A legacy Draft row still leaves Draft through `GET .../hard-gate-status` and `POST .../submit`,
   unchanged except for the shared error shape.
6. **In Buyoff stays.** `In Buyoff` is a schedulable status (scheduling order 0). It stays a valid
   `PATCH` and `submit` target.

## Consequences

- The registration drawer has a single "Register project" action, with the same required fields
  validated on the client and mapped from the server 422 (P23-T01). The Drafts filter chip has
  nothing new to show.
- A client that relied on creating a bare project and filling it in later must now send the full
  gate set in one request.
- Every newly registered project is immediately part of the next run and raises the stale banner.
- `customer_name` is still not a gate field (P3-T01 decision, unchanged).
