# API contract — P40 (manual step weeks; Timeline step colours)

Status: **final for P40-T03b** (backend-builder, 2026-11-17). Binding rules: ADR 0054 "Ruling
(P40-T02)" R40-1..R40-15 and `docs/DOMAIN_RULES.md` "Manual step weeks". TypeScript mirror:
`frontend/src/surfaces/gantt/api/types.ts` (exact rows in `backend/tests/test_openapi_frontend_contract.py`).

Conventions: weeks are plan weeks; **every end week is inclusive** (length = end − start + 1). The
browser derives no length, flag, domain or editability: all of it is served.

## 1. `PUT /gantt/step-pins` — save manual Start / End weeks (one batch)

**Who.** The Admin and Super Admin **roles** only (`require_roles`). Every other role, and a
project-grant Admin (ADR 0012), gets **403** (plain FastAPI error, no `code`). Hub-scoped: a project
outside the caller's hub scope, or one that does not exist, is **404 `PROJECT_NOT_FOUND`**.

**Request** (`StepPinsRequest`, `extra="forbid"`):

```json
{ "items": [
  { "project_id": "uuid", "step_template_id": "PDD-E",
    "manual_start_week": 40, "manual_end_week": 43 },
  { "project_id": "uuid", "step_template_id": "PDD-F",
    "manual_start_week": null, "manual_end_week": null }
] }
```

- 1..500 items. Both week keys are required (a missing key, a non-integer or a boolean is the standard
  request-validation 422 without `code`). Both `null` = **Clear**.
- An item equal to the stored pair is a **no-op**: never refused, never audited (re-sending a whole
  drafted grid is safe, including a lapsed or frozen pin).

**Checks, in order. All-or-nothing: any refusal writes nothing.**

| Phase | Condition | Status / `code` |
|---|---|---|
| rate limit (after the role check, before any lock) *(P40-F01)* | more than the per-user limit: a burst of 10 saves, then one every 6 seconds (`STEP_PINS_RATE_LIMIT`, same style as `REGISTER_EDITS_RATE_LIMIT`) | 429 `RATE_LIMITED`, `Retry-After` header (whole seconds, ≥ 1) |
| shape (before any lock) | the same `(project_id, step_template_id)` twice | 422 `DUPLICATE_STEP` |
| shape | exactly one week null, or end < start | 422 `PIN_INVALID` |
| lock + scope | project rows **in the caller's hub scope** `FOR UPDATE` in `project_id` order (R33-10 lock; *P40-F01: an out-of-scope row is never locked*); project not in scope / missing | 404 `PROJECT_NOT_FOUND` |
| lock | step not a live step of the project's current workflow | 422 `UNKNOWN_STEP` |
| changed **set** items | not `CW ≤ start ≤ end ≤ 52` (CW = the request's `plan_clock` week) | 422 `PIN_OUT_OF_RANGE` |
| changed **set** items (first failing per item) | project frozen | 409 `PROJECT_FROZEN` |
| | project Cancelled / Commercialized | 409 `PROJECT_CLOSED` |
| | stored stage not Not Started | 409 `STEP_STARTED` |
| | step skipped (R35-1 `eff = 0`) | 409 `STEP_SKIPPED` |
| changed **clear** items | project frozen | 409 `PROJECT_FROZEN` |

Within a phase every failing item is reported; a later phase runs only when the earlier ones pass
(so 422 range errors win over 409s). On Hold and Draft projects may carry pins.

**Rate limit (P40-F01, security S40-M1).** The 429 body is the standard coded error
`{"code": "RATE_LIMITED", "detail": "Too many pin saves. Please wait a moment and try again."}`
with a `Retry-After` header. Nothing is locked, written or dispatched. 401 / 403 come first; a 422
from request validation (the Pydantic body) comes before it too. The limiter is per user and per API
process (`services.rate_limit`, the documented limitation). The frontend already maps it
(`use-step-pin-save.ts`, `rateLimited`).

**Scope and locks (P40-F01, security S40-L1).** The locking `SELECT … FOR UPDATE` carries the hub
scope filter (`services.template_apply.lock_projects_in_scope`), and the lookup then reads only the
locked ids. A project outside the caller's scope is not locked, and its answer is unchanged: the same
404 `PROJECT_NOT_FOUND` body as a project that does not exist.

**Refusal body** (`StepPinsRefusal`; the top-level `code` is the first failing item's code):

```json
{ "code": "PROJECT_FROZEN",
  "detail": { "code": "PROJECT_FROZEN",
              "message": "Nothing was saved: fix the steps listed in errors.",
              "errors": [ { "index": 1, "project_id": "uuid", "step_template_id": "PDD-E",
                            "code": "PROJECT_FROZEN", "message": "…" } ] } }
```

`PIN_OUT_OF_RANGE` messages name the allowed weeks (`"Pick weeks between W31 and W52."`).

**Success: 200** (`StepPinsResponse`):

```json
{ "changes": [ { "project_id": "uuid", "step_template_id": "PDD-E", "action": "pinned",
                 "before_start_week": null, "before_end_week": null,
                 "manual_start_week": 40, "manual_end_week": 43 } ],
  "unchanged_count": 1,
  "projects_marked_stale": ["uuid"],
  "current_week": 31,
  "recalc_status": "queued",
  "schedule_run_id": "uuid", "baseline_run_id": "uuid", "task_id": "celery-id" }
```

- `changes` in request order; `action` is `pinned` (set or changed) or `cleared`.
- Each change writes exactly **one audit row**: `project.step_pinned` or `project.step_pin_cleared`,
  `entity_type = "ProjectWorkflowStep"`, `entity_id` = the live step row id, `hub_id` = the project's
  hub. `before_state` / `after_state` = `{project_id, step_id, stage, manual_start_week,
  manual_end_week}`; `after_state.cause = "manual"`. No financial or personal field.
- `schedule_stale = true` on the changed projects, then **one** greedy run for the whole batch
  (`trigger_reason = "step_pin"`), through the priority move's lifecycle (ADR 0015 / I20 / I24; the
  week is fixed when the QUEUED row is created, R37-2):
  - `unchanged` — every item equalled its stored pair (nothing written, no headers);
  - `not_needed` — no changed project is schedulable;
  - `deferred` — a run is in flight; the one coalesced follow-up is registered (ADR 0023);
  - `queued` — `schedule_run_id`, `task_id`; `baseline_run_id` when a run was active;
  - `dispatch_failed` — broker down; the pins are saved and the projects stay stale.
- Headers as the priority move: `X-Schedule-Recalc`, `X-Schedule-Run-Id` (queued only),
  `X-Schedule-Baseline-Run-Id` (queued with an active run). Never solves in-process.

## 2. `GET /gantt` — pin fields

New query parameter **`include_unplaced`** (bool, default `false`). When true, each project row also
lists its live steps that have **no row in the active run** (a left-out project's missing steps, an On
Hold / Draft project, a project added since the run), with `planned_start_week` / `planned_end_week` /
`duration_weeks` null, no assignee, no flags, and `skipped` from the live skip rule. Rows are sorted by
`sequence_order`. Default `false` keeps the existing payload (run rows only).

**`GanttStepRow`** gains (served to every reader; a pin is not personal data):

| Field | Type | Meaning |
|---|---|---|
| `manual_start_week`, `manual_end_week` | int \| null | the **live** pin (R40-13); null/null when none |
| `pinned` | bool | the active run placed this step on a pin (its effective window, R40-5) |
| `manual_overlap` | bool | the pinned row starts before its release (R40-7); warning only |
| `current_length_weeks` | int | R40-2: the live pin's length; else the run row's `end − start + 1` (0 if skipped); else (no run row) `ceil(eff / fte)` for a design step of a non-frozen project **whose leader has a valid FTE** (`is_valid_fte`, the scheduler's rule); with no leader or an invalid FTE, a lab step or a frozen project: `eff` |
| `pin_editable` | bool | the caller may **set** a pin on this step now |
| `pin_block_reason` | `"NOT_ALLOWED"` \| `"PROJECT_FROZEN"` \| `"PROJECT_CLOSED"` \| `"STEP_STARTED"` \| `"STEP_SKIPPED"` \| null | why not; `NOT_ALLOWED` = not an Admin / Super Admin role, or hub out of scope. A step with **no live row** (allowed caller) reads `STEP_STARTED`, or `PROJECT_FROZEN` when the project is frozen: it cannot be pinned |
| `pin_lapsed` *(P40-R02)* | bool | this step's own lapse: the active run's row is `pinned` **and** its window (`planned_start_week`, `planned_end_week`) differs from the pin recorded for the step in that run's `workflow_snapshot.step_pins`, i.e. the pin's start had passed and the run placed it from the run's week (R40-5). False with no run row (`include_unplaced` rows), an unpinned row, or no recorded pin. Stored values compared, nothing recomputed |
| `pin_clearable` *(P40-R02)* | bool | the caller may **clear** this step's pin now, by the save's own rules: Admin / Super Admin role, project in the caller's hub scope, a live step row, project not frozen. Independent of `pin_editable` (a started, skipped or closed step may be cleared). Re-sending a pair equal to the stored one is always a no-op, whatever this says |

Editing semantics for the frontend (R40-2): typing a Start sets End = Start + `current_length_weeks`
− 1; typing an End keeps the Start; End < Start is red and cannot be saved. Clear is allowed when
`pin_clearable` is true (send nulls; `pin_block_reason` describes **set** only). While the live pin
differs from the run row's window (`planned_*`), show "Pin applies on the next run". A step is shown
as lapsed only by its own served `pin_lapsed` *(P40-R02)*: the browser never infers it from the
project flag and the weeks (a sibling whose live pin was moved before its run window is not lapsed).

**`GanttProjectRow`** gains `pin_lapsed` (bool: some applied pin's start had passed, the step was
placed from the run's week) and `manual_overlap` (bool: OR of its rows), both from the active run's
outcome row. A project's `pin_lapsed` can be true with no step flagged: a lapsed pin of a left-out
project has no run row (R40-5). `design_weeks` / `lab_weeks` stay Σ `duration_weeks` (I9, I23).

## 3. `GET /gantt` — per-step activity (P40-T01 support)

- **`GanttWeeklyActiveCount.by_step`**: `{step_id: count}`, e.g. `{"PDD-A": 3, "OEM-E": 1}` — the same
  active rows as `pdd` / `oem` (non-skipped active-run rows of the filtered set covering the week), keyed
  by step id. Zero counts are omitted. **Σ `by_step` = `pdd + oem`** for every week.
- **`GanttResponse.current_step_counts`**: `{step_id: number of projects}` of the whole filtered set
  with a non-skipped active-run row covering the current week (a project in two steps that week counts
  once in each). `{}` without an active run.
- **`GanttResponse.current_week`**: the `plan_clock` week used; null without an active run.

## 4. `POST /gantt/projects/{id}/freeze` — unfreeze permission

Unchanged request / response. **Unfreezing** (`frozen: false` on a frozen project) now requires the
Admin or Super Admin role: anyone else gets **403 `UNFREEZE_REQUIRES_ADMIN`** (nothing written).
Freezing keeps `GANTT`/`WRITE`. Neither writes nor clears a pin (R40-10).

## 5. Pins cleared by other writers (audit only, no API change)

- Stage leaves Not Started (Workspace `PATCH /projects/{id}/stages/{step}`, `POST /check-ins`, and
  the Projects register's current step, `POST /projects/register-edits` `current_step_code`, P40-R01): the pin
  is cleared in the same transaction, under the project row lock, with a `project.step_pin_cleared`
  row, `cause = "stage_started"` (before/after carry the stage).
- Workflow re-point (`PATCH /projects/{id}` hub move PDD ↔ OEM, via `sync_project_steps`): cleared with
  `cause = "workflow_change"`; `before_state.step_id` is the old step, `after_state.step_id` the new one.
  *(P40-F01, S40-I1)* A row that `sync_project_steps` would delete (no step of the new workflow at its
  sequence; unreachable today, both workflows have 14 steps) gets the same `cause = "workflow_change"`
  audit row before the delete (`before_state.step_id = after_state.step_id` = the deleted step).
- The seed and the client data load insert fresh step rows, which carry no pin.

## 6. Plan import (What-if) — `PIN_DROPPED`

`POST` import simulate (merge mode): every included, schedulable file row that replaces a matched plan
project carrying pins adds one issue `{ref: <row key>, severity: "info", code: "PIN_DROPPED",
message}`. No pin weeks are disclosed. Not repeated if the engine already reported it. Unmatched plan
projects keep their pins in the simulation (the baseline carries them).

## 7. Storage (migration `p40a_step_pins`, revises `p41a_import_format_and_scenarios`)

- `project_workflow_steps.manual_start_week`, `manual_end_week` (int, nullable); CHECK
  `ck_project_workflow_steps_step_pin_range`: both null, or `1 ≤ ms ≤ me ≤ 52`.
- `schedule_run_project_steps.pinned`, `manual_overlap`; `schedule_run_project_outcomes.manual_overlap`,
  `pin_lapsed`: boolean NOT NULL DEFAULT false.
- A pinned run row stores `span_fte = NULL`. The run's `workflow_snapshot` gains a `step_pins` list
  (`{project_id, step_id, start_week, end_week}`, by project then step) only when some project has a pin.
- Per-week readers (`weekly_effort_for_rows` → engineer utilization, `capacity_priority`) spread a
  pinned row's `duration_weeks` evenly over its window, lab rows included.
