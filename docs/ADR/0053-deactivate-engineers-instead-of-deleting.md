# ADR 0053: Deactivate engineers instead of deleting them

## Status

**Accepted (2026-11-17, P38-T02)** with the workflow-auditor's ruling R38-1..R38-9 ("Ruling
(P38-T01)", below), which is **binding and wins over the Decision text where they differ**. The
sections below have been amended to match the ruling. Each change is marked *(R38-n)*. The
invariants I42–I44 are the ruling's exact text, and P38-T03 is needed (R38-2). Pending owner
answers to OQ #93–#99 and #101–#103 use their stated assumptions.

Originally **Proposed (2026-11-17, P38)**. It needed the workflow-auditor's ruling (P38-T01)
before any code task opened, because it changes capacity supply (ADR 0008) and what goes into the
scheduler input.

Amends ADR 0008 (supply formulas gain an active-weeks factor), ADR 0042 §5 (`counts_in_capacity`
stays; "inactive" is a separate state) and ADR 0006 ("Rescheduling is explicit": a deactivation
that reassigns leaders triggers one automatic recalculation, like a priority move (ADR 0015), a
check-in (ADR 0023) and the register Save (ADR 0049 R35-7)). Contract: `docs/API_CONTRACT_P38.md`.
DOMAIN_RULES "Engineer deactivation" (2026-11-17), invariants I42–I44. Owner questions OQ #93–#99
and #101–#103.

## Context

Owner, 2026-11-16: "rather than deleting an engineer add an option to deactivate them, so in older
projects in which they were assigned it shows them".

What the code does today (inventory at HEAD 9a41987 plus the working tree; mid-merge by another
session):

- **Endpoint.** `DELETE /engineers/{id}` (`backend/api/routers/engineers.py`, `delete_engineer`).
  Permission: `capacity_planning` WRITE, so Hub Planner (own hub, hub-scoped; out-of-scope → 404),
  Admin and Super Admin. It writes an `engineer.delete` audit row (`before_state` holds the name,
  hub, FTE, categories, `user_id`, `counts_in_capacity`) and then deletes the row.
- **Foreign keys.** Three columns reference `engineers.id`, all with no `ON DELETE` clause (NO
  ACTION, P1-T02 by design): `projects.leader_engineer_id`,
  `project_workflow_steps.assigned_engineer_id` and `schedule_run_project_steps.assigned_engineer_id`.
  A referenced engineer fails the commit; the router maps the `IntegrityError` to **409** "Cannot
  delete engineer: still referenced…" and rolls back (the audit row goes too). There is no cascade
  and no SET NULL. `projects.leader_engineer_id` is never nulled by a delete.
- **In practice**, any engineer who has ever led a project, or been assigned a step in any stored
  run, cannot be deleted. Only an engineer created by mistake and never used can be. The owner's
  real need (someone leaves; their projects must keep showing them) is not served: the only options
  today are the 409, or editing the person's projects first, which loses who led them.
- **UI.** Capacity Planning (`frontend/src/surfaces/planning/PlanningPage.tsx`), engineer table row
  action "Delete" → `ConfirmDialog` "This cannot be undone. Deleting an engineer fails if they are
  still referenced…". On a 409 the dialog stays open with the error.
- **No notion of "active".** The schedule-input builder loads every engineer
  (`services/schedule_persistence.py`, `select(Engineer)`). Supply sums every engineer with
  `counts_in_capacity = true` for the **whole year**, whenever they were created
  (`services/capacity_hubs.py`; the P1 capacity fill has its own query in
  `services/priority_capacity_fill.py`). The What-if leader picker (`scheduling/whatif.py
  _pick_leader`) takes the capacity hub's counted engineers with FTE > 0. Plan import matches
  spreadsheet names against the roster. Registration and the register's leader cells offer every
  engineer from `GET /engineers`.
- **`counts_in_capacity` is not deactivation.** It is the ADR 0042 flag for a leader who is on no
  client roster (OQ #52): still booked, still pickable in Registration, never counted as supply.
- **History reads names live.** Stored run rows carry engineer ids only; names are resolved from
  `engineers` at read time (Gantt, Workspace, utilization, exports, run changes). Keeping the row
  keeps every historic name working.
- **Check-ins** are keyed on `user_id`, not on the engineer, and are immutable; unaffected.
- **Access.** An Engineer-role user linked to an engineer row (`engineers.user_id`) sees projects
  they lead or have a step on in the active run (ADR 0012 rule 6). Login is separate
  (`users.is_active`, Users surface).
- **Live step engineer.** `project_workflow_steps.assigned_engineer_id` is never written by the app
  (null legacy column); the check-in and tracking services read it.
- **Leader changes.** Registration rejects an unknown leader (`UNKNOWN_LEADER`). A PATCH of
  `leader_engineer_id` sets `schedule_stale` and clears `leader_is_provisional`; it never solves.
- **The scheduler** books the project's leader for design steps. A leader that does not resolve
  makes the project `LEFT_OUT` with `no_leader` (`greedy._no_leader_outcome`). Excluded statuses
  (Commercialized, On Hold, Cancelled, Draft) are never scheduled and need no leader.
- **GDPR.** OQ #8 is still open: engineer-level data is treated as personal data (access-controlled,
  audit-logged). The audit log is append-only and immutable (DB triggers) and already holds engineer
  names in `before_state` / `after_state`.

## Decision

### 1. Deactivate / Reactivate replaces Delete

- New state: an engineer is **active** or **inactive**. Inactive is reversible.
- `POST /engineers/{id}/deactivate` and `POST /engineers/{id}/reactivate`. A read-only
  `GET /engineers/{id}/deactivation-preview` feeds the dialog.
- **Who:** Admin and Super Admin (owner's recommendation; the same role gate as
  `counts_in_capacity`, which is the other switch that changes supply). Today's Delete is also open
  to a Hub Planner for their own hub; whether a Hub Planner may deactivate is OQ #93. Until
  answered: Admin / Super Admin only; a Hub Planner gets 403 `ENGINEER_STATUS_ADMIN_ONLY`.
- `DELETE /engineers/{id}` is **retired**: 410 `ENGINEER_DELETE_RETIRED`, pointing to deactivate.
  The Delete action leaves the UI. No hard delete and no purge are built in P38. A Super-Admin
  erasure path (pseudonymisation, not deletion, because stored runs and the immutable audit log
  reference the row) waits for the DPO (OQ #95).
- The deactivation **reason** is a fixed code (`left_company`, `changed_role`, `long_absence`,
  `other`), never free text, so no one types health or personal details about a colleague into a
  permanent record (OQ #97).

### 2. What is stored

- `engineers.active` (bool, default true), `deactivated_at` (timestamptz), `deactivated_week`
  (smallint 1..52, the calendar week when it happened), `deactivated_plan_year`,
  `deactivated_by_user_id`, `deactivation_reason` (enum above). Null when active
  (CHECK: `active` ⇔ all null).
- `engineer_inactive_periods(id, engineer_id, from_plan_year, from_week, to_plan_year, to_week)`:
  one row per deactivation, closed by a reactivation. At most one open row per engineer (partial
  unique index). This table is what supply reads (§4); `engineers.active` is the fast filter and
  equals "has an open period" (kept in the same transaction; tested).
- Audit: `engineer.deactivate` and `engineer.reactivate` (before / after state including `active`,
  week, reason code), plus one `project.update` row per reassigned project
  (`leader_engineer_id` before / after, `cause = "engineer_deactivated"`). No financial field.
- The **week** is the calendar week from the one week accessor the request uses: after P37-T04
  that is `services/plan_clock`; before it, `domain_constants.CURRENT_WEEK`. This reader is added
  to the ADR 0052 Appendix list so P37-T04 covers it. *(R38-7)* `deactivated_week` and every
  period's `from_week` / `to_week` are **calendar** weeks: they record a fact. The deactivate and
  reactivate endpoints join the ADR 0052 Appendix if P37-T04 has not landed.
  `deactivated_plan_year` is the served `plan_year`, not the ISO year. While `plan_year_closed`,
  a deactivation is recorded at `(plan_year, 52)`.
- *(R38-6)* `project_leader_history` gets a row for **every** leader change from P38 on, on every
  write path, not only deactivation. Weeks are calendar weeks. Nothing is backfilled for earlier
  changes; those stay in the audit log only.

### 3. The popup asks for new leaders; the Admin decides (owner ruling 2026-11-17)

Owner, 2026-11-17: "it is Frigoglass's headache for engineer, but give a popup when deactivating:
show the list of active assigned projects and then ask to change the leader too".

"Active" (open) projects = projects the engineer leads whose status is **not** Commercialized or
Cancelled: the four schedulable statuses (frozen or not), On Hold, and legacy Draft.

- **The popup.** Deactivate opens a dialog listing every open project the engineer leads (name,
  hub, status, priority, category). Each row has a new-leader picker, and a "Use one leader for
  all" control fills every empty row. The picker offers **eligible active engineers of the
  project's capacity hub** (ADR 0042), least-loaded first. *(R38-3)* Eligibility is exactly the
  scheduler's predicate (`greedy._cat_not_allowed`): the category is in `allowed_categories`, or,
  for an OEM hub, the `OEM` marker or the project's own OEM-workflow category. The engineer must
  also be active, have FTE > 0, be in the same capacity hub, and not be the one being
  deactivated. The new leader is a real choice: `leader_is_provisional = false`. The list can be
  empty: measured, 3 of Theoni's 6 schedulable R&D-Greece B/C projects have no eligible engineer
  (OQ #103). Such a row can only be left empty. On a frozen project that means the dialog cannot
  complete until the project is unfrozen (below).
- *(R38-3)* **Per-row facts in the preview:** `frozen`, `progress_tracked`, `done_stages` (count)
  and `in_flight_lab` (bool).
- **The Admin's call.** Picking is asked for, not forced. If any row is left empty, the confirm
  button reads **"Deactivate anyway"**, and a warning lists those projects: *"These N projects will
  have no leader. They will not be scheduled (Left out: no leader) until someone sets a leader."*
  *(R38-3)* When any of those rows has `progress_tracked` or `in_flight_lab`, the warning adds,
  verbatim: *"Their recorded stages will not show on the Gantt, and any lab test in progress gives
  up its chamber in the plan, until someone sets a leader."* (`_no_leader_outcome` emits no rows,
  so Done history and in-flight tails, lab tails included, drop out of the run. That is ruling 2's
  `no_leader` exemption. Measured: Elena Micu "anyway" drops 56 rows. Whether a no-leader project
  should keep them is a scheduler change, OQ #102, not in P38.)
  The owner ruled that this is **Frigoglass's responsibility**: the application warns, records and
  surfaces, and does not block.
- *(R38-3)* **Exception: frozen projects must get a leader.** A `null` row on a frozen project is
  rejected with 422 `FROZEN_NEEDS_LEADER` (row index). The explicit path is to unfreeze on the
  Gantt first, which is its own audited action. Clearing a frozen project would silently drop its
  locked dates and chamber weeks (no rows; I10 skips empty outcomes), breaking ADR 0006 "frozen
  wins". The dev data has 0 frozen projects. OQ #101 confirms with the owner, assuming yes.
- **What "no leader" means.** A project left without a choice gets `leader_engineer_id = NULL`.
  It does not keep the inactive id. This is exactly today's "no leader" state:
  - the shared `NoLeaderLabel` ("No leader", with "Left out: no leader assigned" when the run says
    so) shows on the register, Gantt, Matrix and Workspace with no new component;
  - the scheduler's existing rule makes it `LEFT_OUT` with `no_leader` (Booking rules), so it is
    not new semantics;
  - every leader picker can fix it later.
  The engineer who led it is not lost: §6 "Former leader" and the audit row keep the name.
- **Findable.** The register and Projects leader filter gain a "No leader" option (if not already
  present). After a "Deactivate anyway", the Dashboard / Notifications "left out" lists name them
  through the existing `no_leader` reason. The success toast links to the register filtered to
  "No leader".
- **One transaction, one recalculation.** The server applies the deactivation, every chosen
  reassignment and every clear-to-no-leader in **one transaction**. It then dispatches **one**
  greedy run (`trigger_reason = "engineer_deactivated"`, ADR 0023 lifecycle `queued` / `deferred`
  with the one coalesced follow-up, I24; it joins the auto-trigger set that registers a
  follow-up). The week is read when the `QUEUED` row is created (R37-2). Greedy only; P32-R12
  governs replacing an active CP-SAT run. *(R38-5)* The run is dispatched iff **(a)** a
  schedulable project changed leader, **or (b)** the active run has a design row assigned to this
  engineer that ends after `d`. Otherwise `not_needed`. On Hold and Draft changes alone stay
  `not_needed`. A priority-preview token issued before a deactivation fails I37d on confirm
  through the existing stale-preview response.
- *(R38-5)* **Lock order:**
  - the engineer row first: `FOR UPDATE` in deactivate and reactivate, `FOR SHARE` in every leader
    write that names an engineer;
  - then project rows, in `project_id` order;
  - a path that writes band ranks keeps the band-rank advisory lock first (R36-8). Deactivation
    takes none;
  - a lock timeout or deadlock returns 503 `ENGINEER_STATUS_BUSY`.
- *(R38-8)* A leader change keeps the band rank (R36-3). A schedulable project cleared to NULL keeps
  its rank (I37b), is `LEFT_OUT no_leader` at that rank, holds no capacity, and schedules from the
  same rank once a leader is set. No P33 interaction.
- **Race safety.** The request carries the exact set of open project ids the dialog showed, each
  with a leader id or `null`. If the set the server finds under lock differs (a project was
  assigned to this engineer, or closed, since the preview), it returns 409 `LED_PROJECTS_CHANGED`
  with the fresh list. A concurrent leader write that names this engineer re-checks `active` under
  a row lock.
- **Server-side target rule.** The target leader rule is the same as for a leader PATCH: an
  existing **active** engineer with FTE > 0. The picker narrows this to the eligible engineers of
  the capacity hub. A `CAT_NOT_ALLOWED` target, which is possible only through the API, stays a
  warning (Booking rules).
- **Commercialized and Cancelled** projects keep the inactive engineer as leader, shown with the
  tag. That is the history the owner asked to see.
- **No write may set an inactive leader.** This covers Registration, PATCH, register batch, bulk
  edit and the dialog targets: 422 `LEADER_INACTIVE`. Reactivating the engineer does not give back
  the projects that were reassigned or cleared.
- *(R38-4)* **Reopening a closed project.** Any write that moves a project out of {Commercialized,
  Cancelled} while its stored leader is inactive must set a leader (active, or `null`) in the same
  write. Otherwise it returns 422 `LEADER_INACTIVE` on `leader_engineer_id`. This covers PATCH,
  register batch, bulk edit, client re-import and the seed. A legacy Draft cleared to NULL cannot
  leave Draft until a leader is set (ADR 0034 hard gate). The ADR 0034 hard gate runs only at
  registration and when leaving Draft, so a NULL leader breaks no later edit.

### 4. Capacity supply: active weeks only

Whole-week rule, using the ADR 0008 split (elapsed = weeks 1..CW, remaining = weeks CW+1..52, OQ #91):

- The **deactivation week counts as worked**. An engineer deactivated in week *d* is inactive from
  week *d* + 1. A reactivation in week *r* makes them active again from week *r* + 1. Deactivating
  and reactivating in the same week loses nothing.
- `inactive_weeks(e, Y)` = the number of weeks of plan year *Y* covered by *e*'s periods, where a
  period covers weeks `from_week + 1 .. to_week` (an open period, or one that ends in a later year,
  runs to 52; a period that began in an earlier year starts at 1).
- *(R38-1, binding)* One helper for every reader: the year and remaining figures, per-engineer
  figures, the P1 fill, What-if and plan import.

  ```
  A_e(Y, a..b) = number of weeks w in a..b of plan year Y not covered by any of e's periods

  per capacity hub h, over engineers of h with counts_in_capacity (active or not):
  yearly_design_capacity(h)    = working_weeks_per_engineer(h) × Σ fte_e × A_e(Y, 1..52) / 52
  remaining_design_capacity(h) = ((52 − CW) − deduction_weeks × remaining_fraction)
                                 × Σ fte_e × A_e(Y, CW+1..52) / (52 − CW)          (0 when CW = 52)
  ```

  - In normal operation `A_e(CW+1..52)` is 0 or `52 − CW`, i.e. "active now". The general form
    keeps it right under a lowered pin.
  - FTE is summed as `Decimal` and the week factor as an exact `Fraction`. An engineer with no
    period goes through today's `fte_sum` path, so with no period every figure is the same float
    as before P38.
  - `design_capacity()` takes the yearly and remaining FTE sums separately.
  - CW is the response's calendar week (R38-7; I19, I40).
  - Measured at W47: deactivating Elena Micu changes PD-Romania 253.00 → 248.77 (year) and
    24.33 → 20.10 (remaining).

  Active engineers with no period have factor 1, so every figure is unchanged until someone is
  deactivated. Past weeks of an inactive engineer still count in the year (the work they did is in
  the full-year demand, I25), so a mid-year departure does not show the hub as over-booked for the
  whole year. OQ #94 asks the owner to confirm pro rata against "drop them from the whole year".
- *(R38-1)* Engineer-level views (utilization matrix, engineer utilization, resource load) give
  an engineer 0 capacity in **every week a period covers**, so a closed period stays at 0. Their
  per-engineer yearly and remaining figures use the same helper and sum, unrounded, to the hub
  figure.
- *(R38-1)* The P1 capacity fill's `C` is the served `design_capacity_remaining` from the same
  function. Its own FTE query (`services/priority_capacity_fill.py`) is retired.
- *(R38-1)* Roster counts: `counted` and `not_counted` count active engineers only.
  `inactive_engineers` counts the hub's inactive engineers, counted in capacity or not. The three
  sum to the roster.
- *(R38-7)* While the plan is behind, utilization may show the engineer booked after `d` until
  the `engineer_deactivated` run lands. The "Plan from W*n*" notice (I40) covers it.
- An engineer created mid-year is still counted for the whole year, as today. This approximation is
  stated, not changed.

### 5. The scheduler: no new semantics

- The schedule-input builder leaves inactive engineers out of `ScheduleInput.engineers`. Under §3,
  no open project is led by one (I42): each is reassigned or cleared to no leader. So no project's
  outcome changes because of the filter itself. Outcomes change only through the existing leader
  input: a new leader, or `NULL`, which gives `no_leader`.
- The same filter removes them from the What-if leader pool, `remove_engineers`, the best-FTE
  speed, Monte Carlo and plan-import auto-assignment, with no change in `scheduling/`. Measured
  (R38-2): the filter changes no outcome except through leaders. Demand (I25) does not read
  engineers.
- *(R38-2)* **What-if and plan-import supply** (`scheduling/whatif.py _supply`,
  `scheduling/plan_import.py` weekly supply) read the input's engineers. With the filter, an
  inactive engineer would vanish from the whole year (PD-Romania 209.00 against Capacity's
  248.77, which breaks `test_p18_r02`). So **P38-T03 is needed**:
  - add a supply-only field to `WhatIfBaseline`, **not** `ScheduleInput`, so the canonical input
    and hash are unchanged. It carries per-engineer active weeks (hub, FTE, covered weeks) for
    every counted engineer with a period, inactive included;
  - `_supply` and the plan-import weekly series apply R38-1;
  - with the field empty, everything is byte-identical.

  T05 fills the field. The plan-import "keep the matched project's leader" branch
  (`roster_by_id`) uses active engineers only.
- Plan import (services side) matches names against **all** engineers. A row naming an inactive
  engineer is treated as "inactive engineer" (warning, then auto-assigned as for "no engineer
  given"). It never becomes a hypothetical new engineer. An export suffix " (inactive)" is stripped
  before matching.
- Stored runs, their input hashes and their rows are never touched (I14). Runs created before the
  deactivation keep booking the engineer in future weeks until the recalculation (§3) replaces the
  active run.
- *(R38-2)* Greedy, CP-SAT and the validator do not change. `scheduling/` changes only for the
  What-if / plan-import supply field above (P38-T03).
- *(R38-9)* Engineers stay sorted as today in the builder. With no inactive engineer, all of
  these are byte-identical: the live input hash, golden files, a fresh greedy run, re-serialised
  stored runs, every supply figure and the What-if / plan-import supply.

### 6. Where inactive engineers are hidden, and where they still show

Hidden from (choices of a person for future work):
- every leader picker: Registration, register inline leader cell and bulk edit, Workspace leader
  edit, the deactivation dialog's targets;
- What-if candidate lists and plan-import auto-assignment;
- the user-form "linked engineer" picker;
- the engineer eligibility / category editors and the category-add extension list (P33). The data
  extension still applies to them, so a reactivated engineer is consistent;
- P1 capacity-fill supply and every supply figure after their deactivation week (§4);
- rosters and utilization lists **by default**: a Show filter (Active / Inactive / All) on the
  Capacity Planning roster and the utilization views. Inactive rows have the tag and no write
  actions except Reactivate.

Still shown, by name, with an **"Inactive" tag** (history):
- projects they led (any status), the register, project cards, Priority / VIP boards, Dashboard
  lists, Workspace;
- Gantt and Workspace stages from the active run and any stored run;
- leader filter options on Projects / Gantt / Resource load (an "Inactive" group, so history stays
  filterable);
- run changes, audit log, exports (the leader cell reads "Name (inactive)").

*(R38-6)* History readers (projects, active and stored runs, run changes, the audit log, exports)
never filter engineers by `active`.

Every served engineer name gets a sibling `active` flag (contract §4). Name withholding under
OQ #8 / P13 is unchanged: the tag is shown only where the name is.

**Former leader.** An open project reassigned at deactivation shows the new leader on every design
row of runs created after the reassignment, including past Done steps, because the scheduler books
"the project's leader". To keep the owner's "it shows them", every leader change from P38 on is
appended to `project_leader_history(project_id, engineer_id, from_week, to_week, cause)`, and the
Workspace and register show "Former leader: Name (Inactive), until W*n*". Per-step attribution of
past stages is OQ #98. Not built in P38.

### 7. Editing an inactive engineer

PATCH accepts `name` only (a correction or GDPR rectification). Any other field is 409
`ENGINEER_INACTIVE` (reactivate first). Hub moves are refused. Reactivation dispatches no run: an
engineer who leads nothing changes no schedule, and supply updates at once.

### 8. The linked login is not touched

Deactivating an engineer does not deactivate the linked user account. The dialog says whether a
login is linked (yes / no, no name) and points to Users. The ADR 0012 rule 6 access stays as
long as the account is active. OQ #96.

### 9. Not in P38

Future-dated deactivation ("leaves on 31 Dec") — deactivation is immediate (OQ #99). Purge or
erasure (OQ #95). Retention limits for inactive engineers' data (OQ #95).

## Alternatives considered

- **Soft delete hidden everywhere** (`deleted_at`, filtered out of every read): the opposite of the
  ask. Historic projects would lose the name.
- **Reuse `counts_in_capacity = false`**: it means "booked but not supply". The engineer would
  stay pickable and keep booking work, and supply would drop for the whole year.
- **Force a new leader for every open project (no "Deactivate anyway")**: this was the
  orchestrator's first recommendation. The owner overruled it on 2026-11-17: the popup asks, and the
  Admin decides.
- **Keep the inactive engineer as leader of an un-reassigned open project** (the scheduler would
  not find them and would mark it `no_leader` anyway). It was rejected because the existing "No
  leader" marker, the leader filter and the Registration hard gate all key on
  `leader_engineer_id IS NULL`. Keeping the id would need a second marker, and I42 could not be
  stated simply. The name survives through "Former leader".
- **Store `active` only, no periods table**: a reactivation within the year could not keep the
  pro rata supply exact. The table is small and makes §4 a pure function of stored rows.
- **Scheduler field `EngineerInput.active`**: needs `scheduling/` changes, golden files and
  algorithm-engineer work for no behavioural gain, since no open project keeps an inactive leader
  (§3). A builder filter is enough (§5), subject to the T01 ruling.

## Consequences

- Nobody loses history by removing a person. The 409 dead end disappears.
- A deactivation can leave open projects with no leader, by the Admin's choice. Per the owner's
  ruling, that outcome is Frigoglass's responsibility: the app warns before it happens, writes it to
  the audit log, and keeps those projects findable ("No leader" marker and filter, `no_leader` in
  the left-out lists).
- Capacity supply becomes time-dependent for the first time (per-engineer active weeks). I17 now
  reads the formula of §4.
- One more automatic recalculation trigger (`engineer_deactivated`). ADR 0023 rules apply
  unchanged.
- Every reader that serves an engineer name gains an `active` flag: a broad, mechanical change.
- Personal data of people who have left is kept indefinitely until the DPO sets a retention rule
  (OQ #95). The data was kept before too (delete never succeeded for a used engineer). Now it is
  explicit.

## Questions for the workflow-auditor (P38-T01)

*Answered by the ruling below (Q1–Q6 all ACCEPT WITH AMENDMENT). Kept as asked.*

1. **Supply.** Is the §4 pro rata formula, with the "deactivation week counts as worked"
   convention, consistent with ADR 0008, I17, I19 and the P1 capacity fill? Exact text for I43.
2. **Builder filter.** Does leaving inactive engineers out of `ScheduleInput.engineers` change
   any outcome other than through the reassigned leaders? Check the What-if baseline, plan import,
   Monte Carlo, demand (I25) and excluded projects whose leader becomes unresolvable. Is
   `scheduling/` touched (P38-T03 needed or skipped)?
3. **Open set and clearing.** Frozen projects are in the open set. Their past dates are locked, and
   the new leader takes the booking from CW on, possibly with `ENG_CONFLICT`. A frozen project
   cleared to no leader becomes `LEFT_OUT` with its locked dates dropped. Is that acceptable, or
   must a frozen project always get a leader (an exception to the owner's "their call")? Is
   clearing to NULL safe for every reader that assumes a registered project has a leader
   (ADR 0034 hard gate, project cards, exports, the Matrix)?
4. **Recalculation.** Does `engineer_deactivated` follow the ADR 0023 lifecycle exactly (I24)?
   Is `not_needed` right when no schedulable project changed leader? Should reactivation trigger
   nothing?
5. **Invariants.** Exact text of I42–I44 (DOMAIN_RULES "Engineer deactivation").
6. **History.** Is "former leader" at project level enough for I44, given that runs after the
   reassignment put the new leader on past Done design rows?

## Appendix: readers to change (inventory at 9a41987 + working tree)

- Supply: `services/capacity_hubs.py` (supply query), `services/capacity_supply.py` (formula),
  `services/priority_capacity_fill.py` (own FTE query), `api/routers/engineers.py` (per-engineer
  YearRemaining), `api/routers/planning.py` (`/capacity-summary`).
- Engineer-level: `api/routers/capacity.py` (`/utilization-matrix`, `/engineer-utilization`),
  `api/routers/planning.py` (`/resource-load`, `/resource-load/options`).
- Scheduler input: `services/schedule_persistence.py` (builder engineer query); What-if
  (`services/whatif.py`, `services/whatif_baseline.py`, `services/whatif_import.py`);
  `services/plan_import_xlsx.py` (name matching).
- Leader writes: `api/routers/projects.py` (register, PATCH, status change), register batch /
  bulk edit, `api/routers/engineers.py` (PATCH, DELETE), `api/routers/users.py` (engineer link).
- Names served (gain `active`): `api/routers/gantt.py`, `services/workspace.py`,
  `services/project_cards.py`, `api/routers/priority_board.py`, `api/routers/vip_board.py`,
  `api/routers/dashboard.py`, `services/run_changes.py`, `services/export_builder.py`,
  `api/routers/audit_log.py` (entity label), `services/project_filters.py` (leader options).
- Frontend: `surfaces/planning` (roster, dialogs), `surfaces/registration` (leader select),
  `surfaces/projects` (cells, bulk edit, filters), `surfaces/admin-users` (user form),
  What-if surfaces, Gantt / Workspace / boards / dashboard name renderers.

## Ruling (P38-T01)

workflow-auditor, 2026-11-17. Inputs: this ADR, `docs/API_CONTRACT_P38.md`, DOMAIN_RULES "Engineer
deactivation" and the "Capacity supply" amendment, the owner's popup ruling of 2026-11-17, and the
code at the working tree on top of 9a41987. Docs only. No feature code, and git was not touched.

**Verdicts.** Q1–Q6 are all **ACCEPT WITH AMENDMENT**. The binding items are R38-1..R38-9.
**P38-T03 is NEEDED**, but only for What-if and plan-import supply (R38-2). Greedy, CP-SAT and the
validator do not change.

### R38-1 — Supply: one active-weeks rule (Q1)

The pro rata idea is accepted. It is restated as a single helper, so the year figure, the remaining
figure, per-engineer figures, the P1 fill and the What-if all read one rule:

```
A_e(Y, a..b) = number of weeks w in a..b of plan year Y not covered by any of e's periods
               (a period covers from_week+1 .. to_week; open → 52; earlier/later plan years as in §4)

per capacity hub h, over engineers of h with counts_in_capacity (active or not):
yearly_design_capacity(h)    = working_weeks_per_engineer(h) × Σ fte_e × A_e(Y, 1..52) / 52
remaining_design_capacity(h) = ((52 − CW) − deduction_weeks × remaining_fraction)
                               × Σ fte_e × A_e(Y, CW+1..52) / (52 − CW)          (0 when CW = 52)
```

- **When the active-weeks form matters.** A deactivation is immediate and stamped with the calendar
  week, so in normal operation `A_e(CW+1..52)` is either 0 or `52 − CW`. That makes the remaining
  figure exactly "Σ over engineers active now", as the ADR says. The general form is what keeps it
  right under a lowered `RPD_CURRENT_WEEK` pin.
- **Arithmetic.**
  - FTE is summed as `Decimal` and the week factor as an exact `Fraction`.
  - An engineer with no period (factor 1) goes through today's `fte_sum` path unchanged. So with no
    `engineer_inactive_periods` row, every served figure is the same float as before P38, not just
    the same to two decimals (I43).
  - `design_capacity()` takes the yearly and remaining FTE sums separately. Today one Σfte feeds
    both.
- **Engineer-level capacity** is 0 in **every week a period covers**, not only "after d". A
  reactivated engineer's closed period stays at 0.
  - The per-engineer yearly and remaining figures use the same helper.
  - Their unrounded sum equals the hub figure.
- **P1 capacity fill.** `C` is the served `design_capacity_remaining` from the same function. The
  fill's own FTE query (`services/priority_capacity_fill.py`) is retired. ADR 0036 already says
  `C = /capacity/hub-load design_capacity_remaining`, and this makes it literally one source.
- **Roster counts.**
  - `counted` and `not_counted` count active engineers only.
  - `inactive_engineers` counts the hub's inactive engineers, whether or not they count in
    capacity.
  - The three add up to the roster.
- **Plan year.**
  - `deactivated_plan_year` is the served `plan_year`, not the ISO year.
  - While `plan_year_closed` (P37 R37-10), a deactivation is recorded at `(plan_year, 52)`. It
    therefore covers 0 weeks of that year, and all weeks of later plan years.
- **Measured** at W47 on a copy of the dev DB: deactivating Elena Micu (PD-Romania, 1.0 FTE,
  counted) changes PD-Romania yearly capacity 253.00 → 248.77 and remaining capacity 24.33 → 20.10.
  Deactivating an engineer with `counts_in_capacity = false` changes nothing (Sailesh, Theoni:
  0.00).

### R38-2 — Builder filter: no outcome effect, but What-if supply must follow (Q2, T03 NEEDED)

- **The filter is accepted.** Leaving inactive engineers out of `ScheduleInput.engineers` changes no
  outcome except through leader resolution. This was measured with greedy at W47:
  - dropping an engineer who leads nothing open (Praveer Kumar Singh) changed 0 outcomes;
  - dropping one who leads only a Commercialized project (Sailesh) changed 0 outcomes. A closed
    project whose leader no longer resolves is harmless, because `prepare_run` validates
    schedulable projects only;
  - "drop only" for Elena Micu, without touching leaders, gave the same result as "every open
    project cleared to NULL".
  - Monte Carlo, the What-if leader pool (`whatif._pick_leader`, `remove_engineers`, the best-FTE
    speed) and plan-import auto-assignment all read the input, so they become active-only with no
    code change. Demand (I25) does not read engineers.
- **What-if and plan-import supply break single-source reconciliation.**
  - `scheduling/whatif.py _supply` (estimate before/after, simulate `utilization_before`) and
    `scheduling/plan_import.py` (the weekly supply series) compute supply from the input's
    engineers.
  - With the filter, an inactive engineer disappears from the **whole** year. Measured: What-if
    PD-Romania year `capacity_before` would be 209.00 against the Capacity surface's 248.77, a
    divergence of 39.77. For R&D-India the divergence is 19.96.
  - That breaks the existing contract that What-if `capacity_before` equals the Capacity
    `design_capacity_{year,remaining}` (`tests/test_p18_r02.py`).
  - **P38-T03 (algorithm-engineer):**
    - add a supply-only input to `WhatIfBaseline`, **not** to `ScheduleInput`, so the canonical
      input and its hash do not change. It carries per-engineer active weeks for every counted
      engineer with a period, inactive ones included (hub, FTE, covered weeks);
    - `_supply` and the plan-import weekly series apply R38-1, so a week a period covers supplies 0;
    - with the field empty, everything is byte-identical.
  - T05 fills the input from the services side. `test_p18_r02` gains an inactive engineer and a
    reactivated one.
- **Plan import (services).**
  - The "keep the matched project's leader" branch (`plan_import_xlsx.py`, `roster_by_id`) must use
    active engineers only.
  - Name matching uses all engineers, as in contract §3.

### R38-3 — Open set and clearing to NULL (Q3)

- **Frozen open projects must get a leader.**
  - A `null` row on a frozen project is rejected: 422 `FROZEN_NEEDS_LEADER`, with the row index. The
    explicit path is to unfreeze on the Gantt first. Unfreezing is its own audited action.
  - Why: `greedy._no_leader_outcome` emits **no rows**, and it does so for frozen projects too
    (`_schedule_one_project` checks the leader before anything frozen-specific). The validator's I10
    check skips an outcome with no rows. So a cleared frozen project would silently lose its locked
    dates and release its chamber weeks. That breaks ADR 0006 "frozen wins" and the spirit of I10,
    and it is caused by a non-scheduling action.
  - The dev data has 0 frozen projects, so this exception to "the Admin decides" costs nothing in
    practice. It is still put to the owner (proposed OQ "frozen needs a leader", numbered at T02).
- **Non-frozen projects may be cleared (owner ruling), with an exact warning.**
  - `_no_leader_outcome` also drops every **anchored** row: Done history and In Progress / Blocked
    tails, lab tails included. Gate remediation ruling 2 exempts `no_leader`
    (`invariants._required_anchored_rows`).
  - Measured: Elena Micu's 4 schedulable projects are all In Development and progress-tracked, with
    4–5 Done stages each and one design step In Progress. "Deactivate anyway" drops all 56 of their
    run rows. PD-Romania booked design load goes 186 → 116 effort weeks, while demand (I25) is
    unchanged.
  - Across the portfolio, 6 lab steps are in flight. Clearing such a project frees its chamber in
    the plan while the test is still physically running.
  - The preview therefore serves, per row: `progress_tracked`, `done_stages` (count) and
    `in_flight_lab` (bool). The warning must say: *"Their recorded stages will not show on the Gantt,
    and any lab test in progress gives up its chamber in the plan, until someone sets a leader."*
  - Whether a no-leader project should keep its anchored rows is a scheduler change that affects the
    existing no-leader project too. It goes to the owner as a proposed OQ and follow-up, not into
    P38.
- **Candidate eligibility.**
  - It is exactly the scheduler's predicate (`greedy._cat_not_allowed`): the category is in
    `allowed_categories`, or, for an OEM hub, the `OEM` marker or the project's own OEM-workflow
    category. FTE > 0, active, same capacity hub, never the engineer being deactivated.
  - Measured: for Theoni (R&D-Greece, not counted), 3 of 6 schedulable projects (R&D-Greece B/C,
    In Development) have **no** eligible engineer in R&D-Greece, because only Theoni allows B or C
    there. The dialog can only leave them empty. The owner should know before the first real use.
- **Readers that assume a leader.**
  - The ADR 0034 hard gate runs only at registration and when leaving Draft. PATCH does not check it
    again (`api/routers/projects.py`), so a NULL leader breaks no later edit.
  - A legacy Draft project cleared to NULL cannot leave Draft until a leader is set. That is
    intended.
  - The dev data already holds 3 NULL-leader projects (In Development, Cancelled, Commercialized),
    so readers cope today. T05 adds explicit NULL-leader tests for export, Matrix, cards and the
    leader filter.

### R38-4 — Reopening a closed project (I42 gap)

- Commercialized and Cancelled projects keep their inactive leader, and PATCH has no status
  transition guard: Cancelled → In Queue is accepted today.
- Any write that moves a project out of {Commercialized, Cancelled} while its stored leader is
  inactive must set an active leader, or `null`, in the same write. Otherwise it returns 422
  `LEADER_INACTIVE` on `leader_engineer_id`.
- This covers PATCH, the register batch, bulk edit, client re-import and the seed. Without it, I42
  fails on an ordinary status edit.

### R38-5 — Recalculation and locking (Q4)

- **Lifecycle.** ADR 0023 applies exactly: `queued` / `deferred` with the one coalesced follow-up /
  `not_needed`. `engineer_deactivated` joins the auto-trigger set that registers a follow-up (I24).
  - The week is read when the `QUEUED` row is created (R37-2).
  - Greedy only. P32-R12 governs replacing an active CP-SAT run.
- **Dispatch condition, amended.** The run is `queued` / `deferred` iff:
  - (a) a schedulable project changed leader, **or**
  - (b) the active run has a design row assigned to this engineer that ends after `d`. This is a plan
    left stale by an earlier leader change, and without the run, utilization would show them booked
    against 0 capacity.

  Otherwise the run is `not_needed`. On Hold and Draft changes alone stay `not_needed`.
- **Reactivation** dispatches nothing (accepted).
- **Preview tokens.** A priority-preview token issued before a deactivation fails I37d on confirm
  through the existing stale-preview response. No new code is needed.
- **Lock order.**
  - The engineer row comes first: `FOR UPDATE` in deactivate and reactivate, `FOR SHARE` in every
    leader write that names an engineer. Then project rows, in `project_id` order.
  - A path that writes band ranks keeps the band-rank advisory lock first (R36-8). Deactivation
    writes no rank and takes no band lock.
  - A lock timeout or deadlock returns 503 `ENGINEER_STATUS_BUSY`.
  - T04 tests a concurrent leader PATCH and a deactivate in both orders.

### R38-6 — History (Q6)

- **Former leader.** A project-level "Former leader" plus the audit row is enough for I44.
  - Runs created after a reassignment put the new leader on past Done design rows. That is a new
    run's attribution, not a rewrite of a stored row (I14 holds).
  - Per-step attribution stays OQ #98.
- **Leader history.**
  - `project_leader_history` gets a row for **every** leader change from P38 on, on every write
    path, not only deactivation. `from_week` and `to_week` are calendar weeks.
  - Nothing is backfilled for changes before P38; those stay in the audit log only.
- **History readers** never filter engineers by `active`.

### R38-7 — P37 interaction

- **Deactivation week.** `deactivated_week` and the period's `from_week` / `to_week` are
  **calendar** weeks from `plan_clock`, because they record a fact. Add the deactivate and
  reactivate endpoints to the ADR 0052 Appendix if P37-T04 has not landed.
- **Remaining supply** is at the response's calendar week (I19, I40).
- **While the plan is behind,** engineer-level utilization pairs the active run's bookings (week
  *n*) with capacity at the calendar week. It may therefore show the engineer booked after `d`
  until the `engineer_deactivated` run lands. The "Plan from W*n*" notice (I40) covers this, and
  nothing new is needed.

### R38-8 — P36 and P33 interaction

- **P36 band ranks.** A leader change keeps the band rank (R36-3, `services/band_rank.py`).
  - A schedulable project cleared to NULL keeps its rank (I37b: schedulable with a priority).
  - It is `LEFT_OUT no_leader` at that rank, and it schedules from the same rank once a leader is
    set. It holds no capacity meanwhile.
  - Measured: clearing Elena Micu's 4 projects changed no other project's outcome.
- **P33.** A leader change is not an R6 trigger. It writes no `plan_weeks`, `plan_gap_weeks`,
  `effort_weeks` or `excluded`. Template apply lists carry no leader (`services/template_apply.py`).
  No interaction.

### R38-9 — Byte identity

- Engineers stay sorted as today in the builder.
- With no inactive engineer, all of these are byte-identical (I43): the live input hash, every
  golden file, a fresh greedy run, re-serialised stored runs, every supply figure and the What-if /
  plan-import supply.

### Invariants, exact text

- **I42 — no open project is led by an inactive engineer.**
  - At every commit, no project whose status is not Commercialized or Cancelled has a
    `leader_engineer_id` of an engineer with `active = false`.
  - Every write that would create such a row is rejected with 422 `LEADER_INACTIVE`. That includes
    naming an inactive leader, and moving a project out of Commercialized or Cancelled while its
    stored leader is inactive.
  - A deactivation never leaves a frozen open project without a leader.
  - `engineers.active = false` holds iff the engineer has exactly one open `engineer_inactive_periods`
    row, and no engineer has two open rows.
- **I43 — inactive engineers supply nothing in the weeks their periods cover.**
  - These figures equal R38-1 evaluated on the stored periods at the response's calendar week, to
    two decimals: the Capacity supply (hub, area, per-engineer), the P1 fill's `C`, and the What-if
    and plan-import `capacity_before` and weekly supply. Engineer-level capacity is 0 in every
    covered week.
  - Every `ScheduleInput` built from the database after a deactivation commits contains no inactive
    engineer. No run whose input was built after that commit books them in any week.
  - With no `engineer_inactive_periods` row, every supply figure, the live input hash, every golden
    file and every stored run is byte-identical to before P38.
- **I44 — deactivation never rewrites history.**
  - Deactivation and reactivation change none of the following: a stored `ScheduleRun` or run row,
    an audit row, a check-in row, a `project_leader_history` row already written, or the leader of a
    Commercialized or Cancelled project.
  - Each leader change a deactivation causes has exactly one `project.update` audit row
    (`cause = "engineer_deactivated"`) and one `project_leader_history` row. Reactivation changes no
    leader.
  - No engineer row is ever deleted. `DELETE` answers 410 and writes nothing.
  - Every served engineer name carries its `active` flag, which is withheld with the name. Readers of
    projects, active and stored runs, run changes, the audit log and exports never filter engineers
    by `active`. They never replace a name with "No leader" or "Unknown" because the engineer is
    inactive.

### Measured (reported, not tuned)

- **Setup.**
  - A disposable copy of the dev DB (`pg_dump` → `rpd_p38t01_copy`, since dropped). `rpd` was
    untouched: p33c, 14 runs.
  - Greedy in memory at W47, the calendar week. Deactivations were applied as the builder would see
    them: the engineer filtered out and leaders replaced.
  - The baseline equals P37-T01's W47 figures: 114 within year (63 scheduled + 51 Commercialized),
    82 spillover, 76 left out (75 + 1 no leader).
  - `validate_invariants` (I8 repeat, `live_state=True`) found 0 violations in every scenario.

| Scenario | Within (sched.) | Spillover | Left out (of which no leader) | Changed outcomes |
|---|---|---|---|---|
| Baseline W47 | 63 | 82 | 76 (1) | — |
| Elena Micu, all 4 reassigned (Alin Boboc, Stef Marius, Adrian Bortoc ×2) | 63 | 82 | 76 (1) | 5: 3 led (end 59→60, 66→63, 73→70); 2 PD-Romania P4 In Queue pushed 62→70, 61→74 |
| Elena Micu, "Deactivate anyway" (all NULL) | 62 | 79 | 80 (5) | 4, all led; one within-year project (end W50) lost; 56 rows dropped incl. Done history |
| Praveer Kumar Singh (no open projects) | 63 | 82 | 76 (1) | 0; no run (`not_needed`) |
| Theoni, reassigned where possible (3 of 6 have no candidate) | 58 | 84 | 79 (4) | 8: 3 within-year projects become no leader; 2 reassigned OEM-HCK projects slip 49→53 and 50→66 (both leave within year); 2 others pushed (60→74, 73→74); 1 left-out project stays left out |

PD-Romania, Elena "anyway": within 2 → 1, spillover 10 → 7, no leader 0 → 4. Supply as in R38-1.
Practical effect for the owner: reassigning keeps the year count. Leaving projects without a leader
drops their in-flight history from the plan.
