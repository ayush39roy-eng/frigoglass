# ADR 0066 — Only name and hub are required at registration

- **Status:** Accepted (2026-11-19, orchestrator, owner request: "remove all the mandatory fields
  except project title"; the owner chose to keep Hub required).
- **Amends:** ADR 0034 (required fields at registration) and ADR 0065.

## Decision

- `POST /projects` and the legacy Draft submit require only `name` and `hub_id`.
  `HARD_GATE_FIELDS` is empty. Leader, category, type, TCOGS, selling price, gross margin and
  priority are optional. The project is created `In Queue`, as before.
- **Scheduling.** A schedulable project with no priority, or no category (unless it is a non-frozen
  P4/Q), is left out of the scheduler input (`services/schedule_readiness.py`, applied in
  `build_schedule_input_from_db`). So it can never fail a run. It is served with `outcome = null`
  and `outcome_label` set to "Not scheduled — missing priority / category / priority and
  category". Filling the field marks it stale, and the next run schedules it. A missing leader
  keeps its existing outcome, LEFT_OUT `no_leader`. Type and the financial fields are not
  scheduler inputs.
- An existing priority still cannot be cleared on a schedulable project (PATCH rule unchanged).
- No migration and no data change. With every field set, the scheduler input is identical.

## Known limits

- A left-out project cannot be matched by a plan-import row or referenced by a What-if scenario.
- A frozen project with no category loses its locked booking.
