# Domain Rules — RPD Web Application

This is the executable contract every agent validates against. Values here are extracted from
`reference/RPD_Web_Application_mock-up-Frigoglass.pptx` (slides 3–4: scheduling logic flowchart
and prioritization matrix) and cross-checked against `reference/rpd-platform-prototype.html`.

Where our implementation and the prototype disagree, **this document and the deck win.** The
prototype is a differential test oracle during P2 only (see `docs/IMPLEMENTATION_PLAN.md` P2-T02/T03)
and is retired when P2 closes. It is not the specification and it is not the architecture.

**Revised 2026-09-27** from the client's own formula workbook (`docs/CLIENT_FORMULAS.md`,
`reference/Formula-2025-26 Global RPD Project Pipeline.xlsx`) and the feature requests of that day.
ADRs 0007 (lead times, step kinds, OEM workflow), 0008 (capacity supply), 0009 (precedence DAG) and
0010 (Super Admin) record why. Sections marked *(2026-09-27)* changed; everything else is as before.
Where the workbook is inconsistent with itself the assumption taken is stated and the question is
in `docs/OPEN_QUESTIONS.md` #11–#22 — no agent picks a side silently.

---

## Workflow templates — two workflows, 14 steps each *(2026-09-27, ADR 0007)*

Names follow the client workbook. Step IDs are unchanged from the prototype era. `kind` says which
resource a step books: `design` books the project's leader for every week of the step; `lab` books a
chamber; `elapsed` books nothing but occupies calendar weeks on the project's critical path.

### `PDD` workflow — every non-OEM hub

| ID | Code | Name | Kind |
|---|---|---|---|
| PDD-A | MKTG_BRF | Marketing Brief | design |
| PDD-B | FEAS_STD | Feasibility Study (Conceptual Design) | design |
| PDD-C | BUS_CASE | Business Case Approval | elapsed |
| PDD-D | TECH_BRIEF | Final Technical Brief & Project Kick-off | design |
| PDD-E | DESIGN | Design Detailing | design |
| PDD-F | POC | Proof of Concept | lab |
| PDD-G | CAPEX | Online CAPEX Approval | elapsed |
| PDD-H | CERT | Certification Testing & Compliance | lab |
| PDD-I | TF_1 | TF-1 | design |
| PDD-J | PROD_PR | Pre-Production (Pr. Pr) | design |
| PDD-K | TF_2 | TF-2 | design |
| PDD-L | PILOT | Pilot | elapsed |
| PDD-M | TF_3 | TF-3 | design |
| PDD-N | COMM | Commercialization | elapsed |

### `OEM` workflow — hubs `OEM-HCK`, `OEM-Seltek`

| ID | Code | Name | Kind |
|---|---|---|---|
| OEM-A | COMM_BRF | Commercial Brief | design |
| OEM-B | TECH_BRIEF | Final Technical Brief & Project Kick-off | design |
| OEM-C | BUS_CASE | Business Case Approval | elapsed |
| OEM-D | DESIGN | Design Detailing | design |
| OEM-E | POC | Proof of Concept | lab |
| OEM-F | CAPEX | Online CAPEX Approval | elapsed |
| OEM-G | TST_ANAL | Test Results Analysis | design |
| OEM-H | CERT | Certification Testing & Compliance | lab |
| OEM-I | TF_1 | TF-1 | design |
| OEM-J | PROD_PR | Pre-Production (Pr. Pr) | design |
| OEM-K | TF_2 | TF-2 | design |
| OEM-L | PILOT | Pilot | elapsed |
| OEM-M | TF_3 | TF-3 | design |
| OEM-N | COMM | Commercialization | elapsed |

OEM kinds are assigned by analogous name — the workbook gives no split for OEM rows
(`docs/OPEN_QUESTIONS.md` #14). A project's workflow is a function of its hub (`Hub.is_oem`).

## Lead times *(2026-09-27, ADR 0007 — replaces "Category multipliers")*

Durations are read from a configurable lead-time table seeded verbatim from the workbook's
`Final RPD` sheet. There is no multiplier and no `max(1, …)` floor.

```
duration_weeks = lead_time[workflow][category][step_id]      # integer weeks, may be 0
```

| Workflow / Cat | A | B | C | D | E | F | G | H | I | J | K | L | M | N | Σ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PDD / A+ | 1 | 8 | 4 | 1 | 6 | 6 | 2 | 6 | 2 | 1 | 2 | 3 | 1 | 1 | 44 |
| PDD / A | 1 | 4 | 4 | 1 | 6 | 4 | 2 | 6 | 2 | 1 | 2 | 3 | 1 | 1 | 38 |
| PDD / B | 1 | 0 | 0 | 1 | 4 | 0 | 0 | 6 | 0 | 1 | 2 | 1 | 1 | 1 | 18 |
| PDD / C | 1 | 0 | 0 | 1 | 2 | 0 | 0 | 1 | 0 | 1 | 1 | 0 | 0 | 1 | 8 |
| OEM / A-OEM | 1 | 1 | 1 | 2 | 2 | 2 | 4 | 6 | 0 | 1 | 0 | 0 | 0 | 1 | 21 |
| OEM / B-OEM | 1 | 1 | 1 | 0 | 0 | 2 | 2 | 6 | 0 | 1 | 0 | 0 | 0 | 0 | 14 |
| OEM / C-OEM | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |

- A step whose `duration_weeks == 0` is **skipped**: it consumes no calendar time and no capacity,
  and is recorded in the run with `skipped = true`, `start = end = max(predecessor end)` (so it is
  transparent to successors). The 14-row shape of a project's schedule is preserved (I5).
- `lab` steps are also skipped when `project.certification_testing_required == false` (default
  `true`) — this is how the client's lab-load pivot works (`docs/CLIENT_FORMULAS.md` §2.3).
- Process-derived totals per project (used by the Capacity surface "Process derived" column and by
  the unconstrained expected finish, below): `design_weeks = Σ duration over design steps`,
  `lab_weeks = Σ duration over lab steps`, `critical_path_weeks = longest path through the DAG`.
- Optional per-project `estimated_design_weeks` / `estimated_lab_weeks` feed the Capacity surface's
  "Estimated" column only; they never affect the schedule (`docs/OPEN_QUESTIONS.md` #12).
- The table is edited only on Workflow Settings (Super Admin). Every edit is audit-logged and sets
  `schedule_stale` on every schedulable project; it never triggers a solve.

Categories: non-OEM hubs use `A+ / A / B / C`; OEM hubs use `A-OEM / B-OEM / C-OEM`. The
prototype-era multipliers (`A+ 1.0, A 0.8, B 0.5, C 0.25`) are retired and must not be reintroduced.

## Hubs and lab-region mapping

Hubs: `R&D-Greece`, `R&D-India`, `PD-India`, `PD-Romania`, `OEM-HCK`, `OEM-Seltek`

Lab region mapping:

| Hub | Lab region |
|---|---|
| R&D-Greece | Greece |
| R&D-India | India |
| PD-India | India |
| PD-Romania | Romania |
| OEM-HCK | India |
| OEM-Seltek | India |

## Horizon constants

```
CURRENT_WEEK      = 31
WITHIN_YEAR_WEEK   = 52
HORIZON_WEEKS      = 78
```

## Scheduling order (serial schedule-generation scheme)

Sort all projects by, in order:

1. `frozen` descending (frozen projects scheduled first, dates locked)
2. Priority: `P1 → P2 → P3 → P4 → Q`
3. Status: `In Buyoff (0) → Under Industrialization (1) → In Development (2) → In Queue (3)`
4. Category: `A+ → A → B → C → A-OEM → B-OEM → C-OEM` *(OEM tail added 2026-09-27)*

## Precedence *(2026-09-27, ADR 0009)*

Each step template carries `predecessor_ids` (steps in the same workflow). The seeded default is
the strict chain (`X-B ← X-A`, `X-C ← X-B`, …). Super Admin may edit it on Workflow Settings; the
server rejects cycles, self-references, cross-workflow references, and an empty predecessor set on
any step but the first. A change is audit-logged, marks every schedulable project `schedule_stale`,
never auto-solves, and is snapshotted onto each `ScheduleRun` (`workflow_snapshot`).

```
earliest_start(step) = max(pred.end for pred in predecessors) + 1        (or the project frontier
                                                                          for a first step)
```

Two `design` steps of one project can never overlap in practice: both book the leader and I1
forbids one engineer on two design steps in a week, so the scheduler serialises them. Parallelism
therefore means lab ∥ design and elapsed ∥ anything. `sequence_order` is display order and the
deterministic walk/tie-break order; it is not a dependency.

## Booking rules *(revised 2026-09-27)*

- **Design step**: the project's assigned leader must be free for every week in `[w, w + duration)`.
  Non-frozen projects advance `w` until a free window is found.
- **Lab step**: a chamber in the project's lab region whose `allowed_stages` includes this step, with
  concurrent project count `< chamber.max_concurrent` (= platform count) for every week in the
  window. Consumption is **`1.0` platform-week per project-week** (ADR 0007; the prototype's `0.5`
  is retired).
- **Elapsed step**: no resource is booked; the step occupies `[w, w + duration)` starting at its
  earliest feasible start. It never waits for capacity.
- **Skipped step** (`duration == 0`, or a lab step when `certification_testing_required` is false):
  occupies nothing; `start = end = max(predecessor end)`.
- **Frozen projects**: dates are locked at `actual_start`; capacity is consumed regardless of
  conflict. A double-booked engineer raises `ENG_CONFLICT`; an over-capacity chamber raises `OVERLAP`.
- **LEFT_OUT**: no feasible window before `HORIZON_WEEKS`.
- **CAT_NOT_ALLOWED**: assigned leader's `allowed_categories` excludes the project's category (or
  `OEM` for OEM-hub projects). Warning, not a scheduling block.
- **Completing within year**: `!left_out AND (last_step_end + delay <= WITHIN_YEAR_WEEK)`. Otherwise
  `SPILLOVER`.
- Status `Commercialized`, `On Hold`, `Cancelled` and `Draft` are excluded from scheduling entirely.

## Expected vs projected completion *(2026-09-27)*

Two per-project week numbers, both served by the API and drawn on the Gantt as two vertical marker
lines in two colours with a legend; the browser never computes either (I16).

```
projected_end_week   = active_run.end_week + project.delay_weeks           ("will be completed")
                       null when left_out or excluded
expected_end_week    = project.target_end_week                              ("expected completion")
                       if set, else unconstrained_end_week
unconstrained_end_week = earliest finish assuming unlimited engineers and chambers:
                       start at max(CURRENT_WEEK, actual_start_week or CURRENT_WEEK), walk the DAG
                       with the lead-time durations only (Done/In-Progress stages keep their actual
                       start; remaining weeks as in the progress rules). Computed by the scheduler
                       as a pure by-product and stored on the run's outcome row.
slip_weeks           = projected_end_week − expected_end_week               (may be negative)
```

`target_end_week` is entered on Project Registration / the Project Workspace (charter column
"Project End Date - LATEST"). `docs/OPEN_QUESTIONS.md` #19.

## Prioritization scoring — 13 dimensions

| Pillar | Dimension | Weight |
|---|---|---|
| Strategic Alignment | Strategic Project | 25 |
| Strategic Alignment | New Customer | 25 |
| Strategic Alignment | New Options | 25 |
| Regulatory & Quality | Regulatory Compliance | 25 |
| Regulatory & Quality | Quality Improvements | 25 |
| Financial Return | RM Savings | 25 |
| Financial Return | Total RM Savings | 25 |
| Financial Return | Gross Margins | 25 |
| Financial Return | Profitability | 25 |
| Market & Volume | Annual Volume | 15 |
| Market & Volume | 3-Year Volume | 15 |
| Market & Volume | New Models | 15 |
| Investment & Feasibility | CAPEX Investment (inverted) | 10 |

```
TOTAL_WEIGHT = 280
weighted_score = Σ(dimension_score × weight)   where each score ∈ [1..5]
normalised_pct = round(weighted_score / (280 × 5) × 100)

Bands:
  >= 70 → P1
  >= 55 → P2
  >= 40 → P3
  else  → P4
```

### Hard gates (override band, force P1)

- Regulatory deadline within 6 months
- Customer certification at risk (Coke/Pepsi)
- Active safety non-compliance

## Currency

Base EUR. `EUR = 1.0`, `USD = 1.08`, `INR = 97`. Rates must be configurable at runtime, not
hardcoded constants — store them in a config table, not in code.

---

## KNOWN DEFECTS IN THE PROTOTYPE — do not silently replicate or silently fix

These three are **open decisions**. Each requires an ADR before implementation. Recording them here
so no agent "fixes" them without approval and no agent copies them blindly.

1. **FTE is not applied in scheduling.** The Capacity Planning surface reports capacity scaled by
   FTE (0.5 FTE → 9.4 weeks, 1.0 FTE → 18.9 weeks), but the scheduler treats every engineer as fully
   available for whole weeks. Capacity reporting and the Gantt therefore disagree.
   → `docs/OPEN_QUESTIONS.md` #2.
2. **Chamber `efficiency` and `weeks_per_chamber` are display-only.** Only `max` concurrent gates
   booking. → `docs/OPEN_QUESTIONS.md` #3. *(2026-09-27: `weeks_per_chamber` retired; `efficiency`,
   platforms and downtime now feed the capacity-supply formula (ADR 0008). Booking is still gated
   by `max_concurrent` only.)*
3. **Delay is not propagated.** It is applied once at the end (`end + delay <= 52`) rather than
   pushed into downstream steps. → `docs/OPEN_QUESTIONS.md` #5.

## Invariants (the workflow-auditor asserts all of these on every solver run)

- **I1**: No engineer is assigned two design steps in the same week — unless at least one project is
  `frozen`, in which case `ENG_CONFLICT` is raised.
- **I2**: No chamber exceeds `max` concurrent projects in any week — unless frozen, then `OVERLAP`.
- **I3** *(revised 2026-09-27, ADR 0009)*: Every non-skipped step starts after all of its
  predecessors end: `step.start >= max(pred.end) + 1`. Under the seeded strict chain this is the
  old `step[n].start >= step[n-1].end + 1`.
- **I4**: A lab step is only ever booked to a chamber in the project's lab region whose
  `allowed_stages` contains that step.
- **I5** *(revised)*: Every scheduled project has either a complete 14-step schedule (skipped steps
  present with `skipped = true` and zero duration) or `LEFT_OUT = true`.
- **I6** *(revised)*: Total design load per hub = Σ `design`-kind step durations for that hub's
  projects (elapsed and skipped steps contribute 0). Must reconcile with the Capacity surface to the
  week.
- **I7** *(revised)*: Total lab load per lab region = Σ `lab`-kind step durations × 1.0. Must
  reconcile with the Capacity surface.
- **I8**: Re-running the greedy scheduler on identical input produces byte-identical output
  (determinism).
- **I9**: `within_year` count on the Dashboard equals the count of projects satisfying the
  within-year rule in the current schedule run. No independent calculation anywhere.
- **I10**: Applying priorities never mutates a `frozen` project's dates.

These invariants are the permanent correctness contract (see P2-T04). The prototype oracle is
temporary; these are not. I11–I14 (progress) and I15–I17 (precedence, completion lines, capacity
supply) are defined in their sections below.

---

## Per-stage progress capture (Project Workspace, Surface #7)

Added 2026-09-08 for the Project Workspace surface (`docs/PROJECT_AND_STACK.md` §2). The prototype
has no equivalent — it is **not** an oracle for any rule in this section. See `docs/ADR/0006`.

### Per-stage progress fields

Each of a project's 14 `ProjectWorkflowStep` rows carries progress state a Hub Planner edits on the
Project Workspace:

| Field | Domain | Consistency rule |
|---|---|---|
| `status` | `Not Started` \| `In Progress` \| `Blocked` \| `Done` | see below |
| `percent_complete` | integer `0..100` | `Not Started ⇒ 0`; `Done ⇒ 100` |
| `actual_start_week` | int or null | required (non-null) when `status ∈ {In Progress, Blocked, Done}` |
| `actual_end_week` | int or null | required when `status == Done`; must be null otherwise; `>= actual_start_week` |
| `remaining_weeks_override` | int `>= 0` or null | when null, remaining is derived (below) |
| `blocked_reason` | text or null | required (non-empty) when `status == Blocked`; null otherwise |

A project is **progress-tracked** once any one of its 14 stages has `status != Not Started`.
`percent_complete` and `remaining_weeks_override` are advisory inputs to the scheduler, not stored
schedule output — they are never overwritten by a schedule run.

### Derived remaining duration

```
if remaining_weeks_override is not null:
    remaining = remaining_weeks_override
else:
    remaining = ceil(duration_weeks * (1 - percent_complete / 100))
remaining = max(0, remaining)
```

`duration_weeks` is the step's lead-time-table duration (ADR 0007). A skipped step (`duration == 0`)
has no progress state of its own — it is always treated as complete. A `remaining == 0` in-progress step occupies no future
weeks and consumes no future capacity, but is **not** treated as fixed history unless `status ==
Done`.

### How progress feeds a schedule run

For a progress-tracked project, the serial schedule-generation scheme replaces "schedule every step
from scratch" with the following per step, walking steps in sequence order:

```
if status == Done:
    schedule = [actual_start_week .. actual_end_week]      # fixed history, never moved
    consume capacity for the portion of that interval at or after CURRENT_WEEK
    do not search for a slot

if status == In Progress:
    start   = actual_start_week                            # fixed
    tail    = [max(CURRENT_WEEK, prev_step_end + 1) .. + remaining)   # the not-yet-done part
    the step's booked interval for capacity/conflict purposes is `tail`
    if remaining == 0: the step is complete for scheduling; end = max(actual_start_week, prev_step_end)

if status == Blocked:
    as In Progress, but `tail` may not begin until the block clears — the step (and therefore every
    successor in the DAG) is held at the earliest-feasible frontier and the project is flagged; a Blocked
    step whose `remaining > 0` and whose predecessor is complete still cannot be placed, so the
    project takes a BLOCKED hold and surfaces on Notifications (`docs/PROJECT_AND_STACK.md` §2).

if status == Not Started:
    schedule normally — earliest feasible window at or after max(CURRENT_WEEK, prev_step_end + 1),
    per the existing Booking rules.
```

- **Capacity is only tracked for weeks `>= CURRENT_WEEK`.** Work already executed (weeks before
  `CURRENT_WEEK`) is recorded for display but does not consume schedulable capacity.
- **Determinism (I8) is preserved** — progress fields are part of the sorted, hashed solver input.
- If an `In Progress`/`Blocked`/`Done` step is missing a required `actual_*_week` the run **rejects
  the project as a data error** (it is not silently scheduled from scratch) — the workspace's
  consistency rules above are enforced at write time, and the solver re-checks.

### Relationship to the `frozen` flag

`frozen` (project-level, Gantt surface) and per-stage progress are two anchoring mechanisms:

1. If `project.frozen` is true → the existing frozen rules apply unchanged (all 14 steps locked
   from `actual_start`, capacity consumed regardless of conflict, `ENG_CONFLICT`/`OVERLAP` raised).
   `frozen` still wins, for backward compatibility (ADR 0006).
2. Else if the project is progress-tracked → the per-stage rules above apply.
3. Else → schedule from scratch, unchanged.

`frozen` is **retained but deprecated**: it is expected to fall out of use once real progress data
is loaded, and is not offered alongside stage-level progress in the Project Workspace UI. It is not
removed in v1.

### Rescheduling is explicit

A progress edit **never triggers a solve.** It sets a per-project `schedule_stale` flag and shows a
banner; the user runs "Recalculate schedule", which dispatches a solver run (Celery, per
`docs/PROJECT_AND_STACK.md` §4) and writes a **new immutable `ScheduleRun` version**. Prior
`ScheduleRun` rows are never mutated — "what did the plan look like before I updated this?" is always
answerable (I14).

### Project roll-up progress

```
project_progress_pct = round( Σ(step.percent_complete * step.duration_weeks)
                               / Σ(step.duration_weeks) )
```

Duration-weighted, never a 14-way mean (I12).

### Health badge (derived, never entered)

A pure function of the **active `ScheduleRun`'s stored outcome** for the project (I13):

| Badge | Condition |
|---|---|
| ⚫ Left Out | `left_out == true` |
| ⏸ Blocked | `blocked == true` (added 2026-09-27, remediation ruling 5) |
| 🔴 Off Track | projected finish week `> WITHIN_YEAR_WEEK` |
| 🟡 At Risk | projected finish `<= WITHIN_YEAR_WEEK` **and** some stage's `(actual_end_week or projected end) - (planned end)` `> 0` (running over planned duration) |
| 🟢 On Track | projected finish `<= WITHIN_YEAR_WEEK` and no stage overrunning and no overdue stage |

"Projected finish" is `last_step_end + delay` from the active run (consistent with the within-year
rule and ADR 0004 — delay is still terminal).

### Additional invariants (workflow-auditor asserts I11–I14 on every progress-aware run)

- **I11**: A `Done` stage's scheduled `[start, end]` in every subsequent `ScheduleRun` equals its
  recorded `[actual_start_week, actual_end_week]`. Done stages are immutable history; the solver
  never re-places them.
- **I12**: `project_progress_pct` equals the duration-weighted formula above — never an unweighted
  mean of the 14 `percent_complete` values.
- **I13**: The Project Workspace health badge for a project is a pure function of that project's
  stored outcome in the active `ScheduleRun` (finish week, per-stage overrun, `left_out`). No
  independent recomputation anywhere — mirrors I9.
- **I14**: "Recalculate schedule" creates a new `ScheduleRun` row; it never mutates an existing one.
  Every historical schedule version remains byte-stable after later recalculations.

---

## Capacity supply *(2026-09-27, ADR 0008)*

The RPD Capacity surface's *supply* figures are the client's, computed from a per-hub work calendar
and per-chamber downtime. Load is unchanged (I6/I7). `CURRENT_WEEK` is one global value.

```
# per hub (HubWorkCalendar: weekdays_per_week, national_holiday_days, medical_leave_days,
#          casual_leave_days, annual_leave_days)
deduction_weeks             = Σ(days / weekdays_per_week)
working_weeks_per_engineer  = 52 − deduction_weeks
yearly_design_capacity      = working_weeks_per_engineer × Σ engineer.fte         (engineers of the hub)
remaining_fraction          = (52 − CURRENT_WEEK) / 52
remaining_design_capacity   = ((52 − CURRENT_WEEK) − deduction_weeks × remaining_fraction) × Σ fte

# per chamber (platforms = max_concurrent, efficiency, maintenance_weeks, breakdown_weeks,
#              calibration_weeks; holiday_weeks = the region's national_holiday_days / weekdays_per_week)
working_weeks_per_chamber   = 52 − holiday_weeks − maintenance_weeks − breakdown_weeks − calibration_weeks
efficient_lab_weeks         = working_weeks_per_chamber × efficiency × platforms
yearly_lab_capacity         = Σ efficient_lab_weeks over the lab region's chambers
remaining_lab_capacity      = yearly_lab_capacity × remaining_fraction

gap                         = load − capacity
completion_pct              = capacity / load          (null when load == 0)
```

Seed values: `docs/CLIENT_FORMULAS.md` §2.1–2.2. Editable on Capacity Planning (Hub Planner, own
hub) and Workflow Settings (Super Admin); audit-logged. FTE still does not gate week-level booking
(ADR 0002) and downtime does not gate chamber booking; both are supply-reporting inputs.

## Roles *(2026-09-27, ADR 0010)*

`Super Admin` has read + write on every surface and is the only role that may grant/revoke
`Admin`/`Super Admin` or write Workflow Settings. The last active Super Admin cannot be deactivated
or demoted. `GET /me` publishes `permissions[surface] = {read, write}`; the frontend gates
navigation and write controls on it; the server enforces. Full matrix:
`docs/PROJECT_AND_STACK.md` §5.

## Project access grants and delegation *(2026-09-30, ADR 0012)*

A principal's effective access to one project is the MAX over: (1) Super Admin → Admin; (2) global
Admin/Portfolio Manager → Admin; (3) Hub Planner scoped to the project's hub → Admin; (4) Executive
Viewer → Viewer; (5) an active `ProjectAccessGrant` for that (user, project) → the grant's role
(Viewer/Editor/Admin); (6) an Engineer linked to an assignment on the project → Viewer ("own
assignments", unchanged, not a grant). Grants are additive only — never used to reduce access rule
(1)-(4)/(6) already gives. Editor may write stage progress, files and comments only, never
Registration charter fields, freeze state or precedence. A manager may grant/revoke a
Viewer/Editor/Admin project role only for their own direct reports (`User.manager_id`), and only on
a project where the manager's own effective access is Admin. Full detail and the delegation
authorization rule: ADR 0012.

## Ask the agent *(2026-09-30, ADR 0014)*

`POST /projects/{id}/ask-agent` answers questions about one project from data the asker can already
see (the resolver above). The assembled context never includes financial fields (TCOGS, gross
margin, selling price, customer name) or real engineer names, regardless of the asker's role or
project access level — engineers are described by role/step, not by name. No-ops with `503
AGENT_UNAVAILABLE` when `RPD_GROQ_API_KEY` is unset. Provisional pending `docs/OPEN_QUESTIONS.md`
#23. Full detail: ADR 0014.

## Additional invariants *(2026-09-27)*

- **I15**: The stored precedence graph of each workflow is acyclic, and in every `ScheduleRun` every
  non-skipped step starts strictly after every predecessor ends (this is I3 stated over the DAG).
  The `workflow_snapshot` on the run equals the settings in force when the run was created.
- **I16**: `expected_end_week`, `projected_end_week` and `unconstrained_end_week` shown anywhere in
  the UI equal the values stored on the active run's outcome row / the project record. No client
  recomputation.
- **I17**: The Capacity surface's supply figures equal the ADR 0008 formulas evaluated on the stored
  calendar/chamber inputs, to two decimals, and its load figures equal I6/I7 sums over the active
  run.
- **I18** *(2026-09-30, ADR 0012)*: A `ProjectAccessGrant` write (grant or revoke) succeeds only
  when the actor is Super Admin, global Admin, or a manager granting/revoking their own direct
  report on a project where the manager's own effective access is Admin. No principal can grant a
  project role to themselves, to a non-report, or on a project they cannot themselves administer.
  Revoking a grant never reduces a principal's effective access below what rules (1)-(4)/(6) of the
  resolver above already give them.

## Gate remediation rulings *(2026-09-27, P9-T06 FAIL)*

These close the ambiguities the workflow-auditor found in the P9 gate. Recorded in `docs/MEMORY.md`
("P9 gate — combined result").

1. **Anchored lab steps choose a chamber with room (fixes F1 / I2).** A Done or In-Progress lab
   step keeps its fixed weeks, but it goes to the first eligible chamber (lab region + allowed stage,
   in deterministic chamber-id order) with `count < max_concurrent` for every week of its fixed
   interval at or after `CURRENT_WEEK`. Only when no eligible chamber has room is it booked over
   capacity. That raises `OVERLAP` on the outcome, exactly as for frozen projects. "Over capacity
   only when unavoidable" applies to both solvers and to the validator: I2 treats an anchored step's
   overbooking as a violation unless every eligible chamber was full.
2. **In-flight work is never erased from a run (fixes F2 / I11).** A progress-tracked project's
   Done steps and In-Progress / Blocked tails are always emitted in the run, whatever the solver
   decides about the rest. If the solver leaves the remaining not-started steps unscheduled, the
   project is `left_out = true` with those anchored rows present. I5 counts that as a valid
   left-out outcome. CP-SAT (whether it may drop an in-flight project at all) remains OQ #10.
3. **One progress rule (fixes F3 / I12).** `project_progress_pct` is always the duration-weighted
   formula over the stored `percent_complete` values. That holds for every project, frozen ones
   included, and in every code path (scheduler outcome and workspace). **Stage progress cannot be
   edited on a frozen project**: the stage PATCH returns 409 `PROJECT_FROZEN`, and the Workspace
   disables the Progress panel with "Unfreeze on the Gantt to record stage progress". This makes
   ADR 0006's "frozen is not offered alongside stage-level progress" enforced, not just a UI
   intention. Progress already stored on a frozen project (for example derived by migration
   `5c9e1f2a7b3d`) is shown read-only and still counted by the formula.
4. **Pre-booking order (records an accepted P9-T02 call).** Before the serial search, capacity is
   booked in this order: frozen projects, then every progress-tracked project's Done-at-or-after-
   `CURRENT_WEEK` and In-Progress / Blocked tail intervals. After that, not-started steps are placed
   in scheduling order. A later-priority project's in-flight work therefore keeps its weeks against
   a higher-priority project that has not started.
5. **Blocked health badge.** The health-badge table gains ⏸ **Blocked** (`outcome.blocked == true`),
   evaluated after ⚫ Left Out and before the finish-week rules. I13 unchanged: it is still a pure
   function of the stored outcome.
6. **CP-SAT budgets are deterministic.** Both CP-SAT passes use deterministic-time limits, never
   wall-clock ones. Then a re-run on identical input gives identical output on any machine, which
   extends I8's spirit to CP-SAT. Whether the result is OPTIMAL or FEASIBLE is recorded on the run.
7. **Frozen projects and stored progress (clarifies I11).** A frozen project follows ADR 0006's
   "frozen wins". All 14 steps are placed from the locked `actual_start_week`, even when some stages
   have stored Done actuals with different weeks. I11 ("Done stages keep their recorded weeks")
   therefore applies only to non-frozen, progress-tracked projects. The stored progress is still
   shown read-only and counted by the roll-up formula (ruling 3).
8. **Unconstrained finish for frozen projects (D1).** A frozen project's `unconstrained_end_week`
   walks the DAG from its locked `actual_start_week` with the lead-time durations, ignoring resources.
   It does not start from `max(CURRENT_WEEK, actual_start_week)` the way non-frozen projects do,
   because a frozen project's dates are fixed history.
9. **Null outcome fields for excluded and data-error projects (D3).** A project that is excluded
   (non-schedulable status) or rejected with `data_error` has null `start_week`, `end_week`,
   `unconstrained_end_week`, `expected_end_week`, `projected_end_week` and `progress_pct` in the
   run. The Project Workspace roll-up never reads the stored value. It always evaluates the ruling-3
   formula over the stored stage percents, so a stored null never reaches the UI.
10. **In-Progress tail start (D8).** An In-Progress or Blocked tail starts at
    `max(CURRENT_WEEK, actual_start_week, predecessor_end + 1)`. `actual_start_week` is included so
    a stage recorded as started in the future (after `CURRENT_WEEK`) keeps its recorded start.
