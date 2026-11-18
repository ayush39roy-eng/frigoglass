# ADR 0059 — Concurrent edits: field-level conflict check, no silent overwrite

- **Status:** Accepted (2026-11-18, orchestrator, owner request).
- **Constraint:** the hosted data belongs to the client (MEMORY standing decision, 2026-11-18). No
  migration may rewrite existing rows. This design needs no schema change.

## Context

Several users now edit the hosted demo at the same time. The owner said: "if someone is editing some
field and another person also the same, make sure that is managed."

The current behaviour differs by surface:
- Some surfaces already detect a concurrent change: Workflow templates (`TEMPLATE_CHANGED`), the
  scoring rubric, the import format (`version`, 409), the priority move preview (`PREVIEW_STALE`) and
  engineer deactivation (`LED_PROJECTS_CHANGED`).
- Project edits (PATCH, register inline / popup / bulk), engineer and chamber edits, capacity edits
  and the other plain PATCHes take a row lock, so data is never corrupted. But they are
  **last-write-wins**: the second save silently replaces the first person's value.

## Decision

**C1 — Field-level optimistic check.**
- Every edit request may carry, for each field it changes, the value the user **started from**:
  ```
  "base": { "<field>": <value as the client read it>, ... }
  ```
  Each surface puts `base` at the request's top level, or per row for batches. Only fields present in
  `base` are checked.
- After it locks the row (`FOR UPDATE`), the server compares each changed field's current stored
  value with `base[field]`, using the same normalisation the read endpoint serves.
- If every field matches, the edit is applied exactly as today.
- If **any** changed field differs, the server returns **409 `EDIT_CONFLICT`** and writes nothing. A
  batch is atomic, as it is today:
  ```json
  {"code": "EDIT_CONFLICT", "detail": "Someone else changed this while you were editing.",
   "conflicts": [{"entity": "project", "id": "…", "label": "<project name>",
                  "field": "status", "your_value": …, "current_value": …,
                  "changed_by": "<full name>|null", "changed_at": "iso|null"}]}
  ```
  `changed_by` and `changed_at` come from the latest audit row for that entity and field (or entity)
  when one exists. Financial fields are never echoed: `your_value` and `current_value` are
  `"<hidden>"` for TCOGS, margin, selling price and customer name.
- A field the request does not change is not checked. **Two people editing different fields of the
  same project both succeed.**
- `base` is optional. A request without it behaves as today, so older cached browsers keep working.
  The frontend always sends it.

**C2 — Resolving a conflict (frontend).**
- On a 409, the screen shows one dialog listing the conflicting fields: what you entered, what is
  stored now, and who changed it and when. The choices are:
  - **Use theirs:** reload and drop my change to those fields;
  - **Keep mine:** resend with `base` = the current values, a deliberate overwrite that is audited
    as usual.

  Fields without a conflict are never lost. In a batch, the user's other edits stay in the edit
  buffer.
- Editable grids and forms refetch on window focus. While the user is not editing, they also poll
  every 60 s, so people see each other's saved changes without reloading.

**C3 — Scope.** Every write endpoint that edits an existing business record:
- projects: PATCH, register-edits (inline, popup, bulk), band rank, status, actual dates, step
  exclusion, timeline manual weeks;
- engineers PATCH;
- chambers PATCH;
- capacity and planning card edits;
- check-ins and step status;
- priority scores, Matrix inline;
- VIP;
- Workflow Settings PUTs;
- user PATCH;
- the What-if saved scenario PATCH;
- category timeline apply (it already has `TEMPLATE_CHANGED`; keep it).

Endpoints that already have a version or token check keep theirs. Creates and appends (new project,
new comment) need nothing.

**C4 — Presence ("X is editing this project") is not in v1** (OQ #114). C1 is what guarantees no
silent overwrite. Presence only warns earlier.

## Consequences

- One shared helper, `services/edit_conflict.py`: `check_base(entity, current_values, base, …)` →
  raises `EDIT_CONFLICT`, plus `latest_change(entity_id, field)` from the audit log. Every endpoint
  uses it.
- There is no migration and no data change.
- Gate: qa (a two-client race test per surface), security (no financial values in a 409, scope
  respected in `changed_by`), workflow (a 409 dispatches no run and marks nothing stale).
