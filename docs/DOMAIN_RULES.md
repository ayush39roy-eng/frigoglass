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

**Revised 2026-10-09** from the client's change requests of that day: ADR 0015 (a priority move
recalculates automatically), ADR 0016 (capacity booked % and Europe/India areas) and ADR 0017
("Blocked" is shown as "On Hold"). Sections marked *(2026-10-09)* changed. Open questions #24–#27.

**Revised 2026-10-10** from the client's second batch of change requests: ADR 0018 (Priority board),
ADR 0019 (Gantt drag sets a per-project step duration and an earliest start — a scheduler input
change), ADR 0020 (global hub filter), ADR 0021 (weekly check-in / live tracking) and ADR 0022 (VIP
projects). Sections marked *(2026-10-10)* changed. Invariants I21–I24. Open questions #28–#33. ADR 0023 (check-ins recalculate; coalesced follow-up run) amends 0015/0019/0021 the same day after the owner's answers.

**Revised 2026-10-13** (ADR 0024): the demo dataset is now the client's real 2026 pipeline, `CURRENT_WEEK` is
42, and every surface shows a 52-week year. Work past W52 is shown as spillover.

**Revised 2026-10-21** (ADR 0032, owner ruling "0.5 FTE represents half speed"): FTE gates
scheduling speed. A design step books `ceil(duration / fte)` weeks of its leader. Sections marked
*(2026-10-21)* changed; ADR 0002 is superseded and known defect #1 is closed.

**Revised 2026-10-21** (P21, ADR 0033, owner ruling): a prioritization dimension may be scored 0
(0 points); currencies EGP, ZAR and IDR are added with no configured rate.

**Revised 2026-10-21** (P23, ADR 0034, owner ruling): Draft is retired from registration. A new
project is created `In Queue` once its required fields are set (see "Project statuses and
registration").

**Revised 2026-10-21** (P24, ADR 0035, owner ruling): the seed uses the client's real roster and
data; ADR 0024's seed tuning is retired. Projects gain three read-only charter fields (see "Project
charter fields"). No scheduling or capacity rule changes.

**Revised 2026-10-21** (P25, ADR 0036, owner ruling): a hub whose P1 design load is under its
remaining-year design capacity promotes lower-scoring projects to a *suggested* "P1 (capacity fill)"
(see "P1 capacity fill"). Scores, score bands and committed priorities are unchanged.

**Revised 2026-10-23** (P30, ADR 0041 with the workflow-auditor's binding R1–R14, owner accepted
R1): a project's typed effort figure (client columns 16 / 21) is split over its steps and sets both
the load and the calendar span; a step whose effective duration is 0 is skipped (one predicate
everywhere); the Capacity surfaces serve run-independent **demand** (full year, remaining) beside
the run-**booked** load; hub `OEM-Seltek` is spelled `OEM-Seitek`. Sections marked *(2026-10-23,
ADR 0041)* changed. New invariants I25 (demand) and I26 (effort split); I6, I7, I17, I19, I23
revised.

**Revised 2026-11-13** (P33, owner change request): ADR 0045 (category timeline editing with buttons
and the stage rule that applies it to projects), ADR 0046 (per-project copies of the category
template, length vs effort, signed gaps), ADR 0047 (categories become a table and Admins may add
one) and ADR 0048 (per-project step timing editing is retired). Sections marked *(2026-11-13)*
changed. New invariants I28–I32; I26, I27 and I31 revised. Binding since P33-T01 (2026-11-13). It
folds in the workflow-auditor's ruling R33-1..R33-12 (ADR 0046 "Ruling (P33-T00)") and the owner's
answer to OQ #76/#77 ("if it is manually set then use them only as the timeline"; ADR 0046 "Owner
ruling" OR-1..OR-6). Until each P33 task lands in code, the rule it replaces stays what the code
does.

**Revised 2026-11-16 (P37, ADR 0052; binding since P37-T02, 2026-11-17, with ruling R37-1..R37-10 and the owner's answers to OQ #88–#92).** The
owner wants the current week to follow the calendar: it is the ISO week of today in Europe/Athens,
computed per request and per solve, and `RPD_CURRENT_WEEK` stays as a pin. A weekly rollover run
keeps the plan current. See "Horizon constants" (2026-11-16 amendment) and invariants I38–I41;
I9, I13, I19 and I24 and the check-in Due stage are amended. Until P37 lands in code, the week
stays the fixed constant.

**Revised 2026-11-17 (P38, ADR 0053; binding since P38-T02, with the workflow-auditor's ruling R38-1..R38-9).**
Engineers are deactivated, not deleted. Inactive engineers keep their name, with an "Inactive" tag,
everywhere history shows them. They are hidden from every choice of a leader. They supply nothing
after their deactivation week. The owner ruled on 2026-11-17 that the deactivate popup asks for a
new leader on each open project they lead, and the Admin may leave some with no leader, except
frozen projects (R38-3). See
"Engineer deactivation", the "Capacity supply" amendment and invariants I42–I44. Until P38 lands in
code, engineers can only be deleted (and almost never can be).

**Revised 2026-11-17 (P39, ADR 0007 amendment 2026-11-17, PROPOSED until the workflow-auditor rules
at P39-T01).** Owner: "marketing is under others, not a design step". PDD-A Marketing Brief changes
kind `design` → `elapsed`: it books nobody (no leader week, no FTE stretch, no design demand or
booked load) but still occupies its calendar weeks on the critical path. The design effort split
(R2) runs over PDD's other design steps only (examples below). Recorded stage history is kept.
OEM-A Commercial Brief is unchanged (OQ #100). Until P39-T03 lands in code, PDD-A stays `design`.

---

## Workflow templates — two workflows, 14 steps each *(2026-09-27, ADR 0007)*

Names follow the client workbook. Step IDs are unchanged from the prototype era. `kind` says which
resource a step books: `design` books the project's leader for every week of the step (its span is
stretched by the leader's FTE, see Booking rules, ADR 0032); `lab` books a chamber; `elapsed` books
nothing but occupies calendar weeks on the project's critical path.

### `PDD` workflow — every non-OEM hub

| ID | Code | Name | Kind |
|---|---|---|---|
| PDD-A | MKTG_BRF | Marketing Brief | elapsed *(2026-11-17, P39; `design` until P39-T03 lands)* |
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

### `OEM` workflow — hubs `OEM-HCK`, `OEM-Seitek`

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

- *(2026-10-23, ADR 0041 R4/R5)* **Effective duration and the one skip predicate.** For project `p`
  and step `s`, with `lead(p,s)` the table value above:
  ```
  eff(p,s) = 0                                        if lead(p,s) = 0
           = 0                                        if kind(s) = lab and not p.certification_testing_required
           = user_override ?? effort_weeks ?? lead    otherwise
  skipped(p,s)  ⟺  eff(p,s) = 0
  ```
  `user_override` is the step's `duration_override_weeks` (the user's figure, below), `effort_weeks`
  its share of the project's effort figure ("Per-project effort", below). A skipped step consumes
  no calendar time and no capacity, and is recorded in the run with `skipped = true`,
  `start = end = max(predecessor end)` (so it is transparent to successors). The 14-row shape of a
  project's schedule is preserved (I5). I5, I11, I21 and I22 read "skipped" this way. Every reader
  uses this one predicate (`scheduling.is_step_skipped`; on the service side
  `services.workspace.is_step_skipped`): the scheduler, the validator's I5 (derived from the
  inputs), step timing (`STEP_SKIPPED`), the Workspace stage PATCH (`STAGE_SKIPPED`), the Gantt's
  `timing_editable`, the project cards, tracking and the demand load. Everywhere a duration was
  used (booking, remaining duration, load, progress weights, the unconstrained finish),
  `duration_weeks` means `eff`.
- `lab` steps are skipped when `project.certification_testing_required == false` (default `true`).
  *(2026-10-23, ADR 0041 §3)* The client import sets the flag when column 18 is "Yes" **or** the
  project carries lab weeks (`lab_effort_weeks > 0`): the client's own lab pivot applies no
  certification filter (`docs/DATA_RECONCILIATION_2026.md` W9; the earlier citation of
  `docs/CLIENT_FORMULAS.md` §2.3 for this rule was a misreading).
- Process-derived totals per project (used by the unconstrained expected finish, below):
  `design_weeks = Σ eff over design steps`, `lab_weeks = Σ eff over lab steps`,
  `critical_path_weeks = longest path through the DAG`.
- *(Retired 2026-10-23, ADR 0041 R13.)* ~~Optional per-project `estimated_design_weeks` /
  `estimated_lab_weeks` feed the Capacity surface's "Estimated" column only.~~ The client's
  per-project figures are now `design_effort_weeks` / `lab_effort_weeks`, and they DO drive the
  schedule and the load (below). The `estimated_*` fields are kept stored and served as deprecated
  (`*_load_estimated_weeks`) for one release; nothing new reads them (OQ #12).
- The table is edited only on Workflow Settings (Super Admin). Every edit is audit-logged and sets
  `schedule_stale` on every schedulable project; it never triggers a solve. *(ADR 0041 R6)* It also
  re-derives every project's effort split (it depends on the table's shape).
  *(2026-11-13, ADR 0045/0046 — superseded once P33 lands; see "Category templates" at the end.)*
  The table becomes the **category template**, edited by Admin and Super Admin. A change reaches a
  project only through the apply stage rule, and a length change never reaches a project's steps of
  a kind for which the project has its own effort figure. Steps without own effort take the
  project's own copy (`plan_weeks`); R2 weights become the immutable `effort_weight_weeks`.
- *(2026-10-10, ADR 0019; 2026-10-23, ADR 0041 R4)* **Per-project user override.** A project's step
  may carry `duration_override_weeks` (1..104), the **user's** figure from the Gantt / Workspace.
  It wins over the effort split and the table (`eff` above). A step whose table duration is 0 stays
  skipped; an override never revives it, nor a lab step without certification testing. A table
  edit and an effort re-derivation never clear an override. A **new** user override cannot be set
  on a step whose effective duration is 0 (409 `STEP_SKIPPED`); an existing one keeps the step.

### Per-project effort *(2026-10-23, ADR 0041 §3 as amended by R1–R7)*

A project may carry the client's typed figures `design_effort_weeks` (workbook column 16 "Process
Design Man Week") and `lab_effort_weeks` (column 21 "Lab Weeks- Process Derived"), `Numeric(6,2)`,
≥ 0. They are not financial fields.

- **R1 (owner accepted 2026-10-23).** One effort figure sets both the load and the calendar span:
  a design step books `ceil(eff / fte)` weeks of its leader, exclusive (ADR 0032). A B project
  with a figure of 4 runs 4 weeks of design at 1.0 FTE, not the table's 10.
- **Split (R2).** For a figure `x > 0`: `S` = the project's steps of that kind (design / lab) with
  `lead > 0`, `T = Σ lead`, `E = max(1, round_half_up(x))` on the stored decimal. Quotas are exact
  rationals `q_i = E × lead_i / T`; each step gets `⌊q_i⌋`; the remainder `E − Σ⌊q_i⌋` goes one week
  at a time by larger fractional part, then larger `lead_i`, then smaller `sequence_order`, then
  `step_id`. `Σ = E`. A step that gets 0 is skipped. Examples: PDD/B design 4 → A 1, E 2, K 1 (D, J,
  M skipped); PDD/C design 3 → A 1, D 1, E 1; PDD/B lab 10 → H 10; PDD/A+ lab 4 → F 2, H 2; 1.5 → 2.
  *(2026-11-17, P39 — PDD-A elapsed; weights = `effort_weight_weeks`, R33-2.)* The design examples
  become: PDD/B design 4 → D 1, E 2, K 1 (J, M skipped); PDD/C design 3 → D 1, E 1, J 1 (K
  skipped); PDD/B design 8 → D 1, E 3, J 1, K 2, M 1 (was A 1, D 1, E 3, J 1, K 1, M 1); PDD/A design
  18 → B 4, D 1, E 7, I 2, J 1, K 2, M 1 (was A 1 … E 6); PDD/A+ design 44 → B 17, D 2, E 13, I 4,
  J 2, K 4, M 2 (was A 2, B 16, … E 12). Σ is still E. PDD-A is then not in S′: it carries no
  `effort_weeks`, is never raised by R3, and its `eff` is its `plan_weeks` (elapsed). A project with
  a design figure therefore keeps its design load (E) but its chain gains PDD-A's `plan_weeks` of
  calendar time (before, PDD-A was either one of the E weeks or skipped); a project without a figure
  keeps its calendar and loses PDD-A's weeks of design load. R3-raised PDD-A weeks leave the load.
- **Recorded work is never erased (R3).** A step whose stage status is not Not Started gets
  `max(1, share)`; the total may then exceed `E` by the number of raised steps. The seed apportions
  before deriving progress, and derives progress on effective durations.
- **Edge cases (R7).** No non-zero step of the kind (`T = 0`): not applied (no effort written). A
  split that would put a step above 104 weeks: rejected at write (422 `EFFORT_SPLIT_REJECTED`) and
  at import. Certification testing off: lab steps stay skipped, whatever `lab_effort_weeks` says
  (no lab effort written). A blank or 0 figure: no effort written; the table applies (fallback).
- **Storage (R4).** The split lives in `project_workflow_steps.effort_weeks` (0..104, null = none),
  never in `duration_override_weeks`. Gantt "Reset timing" clears the user's values, so the step
  falls back to its effort value.
- **Re-derivation (R6)**, in the same transaction, audit action `project.effort_rederived` (only
  when a step's effort changes), sets `schedule_stale`, never solves: on a figure edit, a change of
  `category` or `certification_testing_required`, a workflow change (hub move PDD ↔ OEM), a step-kind
  or lead-time edit on Workflow Settings, a stage status crossing Not Started (R3's input), and on
  unfreezing. Scope: every project with a figure or a stored effort, non-schedulable ones included.
  A **frozen** project is a no-op (I10); its figures are still validated (R7).
- **Monte Carlo (R10).** A sampled duration keeps a floor of 1 for a non-zero input; 0 stays 0.
- *Observation.* A Not Started step longer than `HORIZON_WEEKS − CURRENT_WEEK` can never be placed
  (Romania's 70-week H steps at W42 are `LEFT_OUT` by construction).

Categories: non-OEM hubs use `A+ / A / B / C`; OEM hubs use `A-OEM / B-OEM / C-OEM`. The
prototype-era multipliers (`A+ 1.0, A 0.8, B 0.5, C 0.25`) are retired and must not be reintroduced.
*(2026-11-13, ADR 0047)* These seven are the **seeded** categories. Categories become a table
(`categories`: code, label, workflow, rank), and Admin / Super Admin may add one. A category belongs
to exactly one workflow; the hub's workflow decides which categories a project may take.

## Hubs and lab-region mapping

Hubs: `R&D-Greece`, `R&D-India`, `PD-India`, `PD-Romania`, `OEM-HCK`, `OEM-Seitek`

*(2026-10-23, ADR 0041 §4)* `OEM-Seitek` is the client's spelling; the prototype's `OEM-Seltek` was
renamed (migration `p30a`). Stored schedule runs keep the string they were written with (I14), and
the scheduler accepts both spellings (`scheduling.hubs`).

Lab region mapping:

| Hub | Lab region |
|---|---|
| R&D-Greece | Greece |
| R&D-India | India |
| PD-India | India |
| PD-Romania | Romania |
| OEM-HCK | Greece |
| OEM-Seitek | Greece |

## Horizon constants *(revised 2026-10-13, ADR 0024)*

```
CURRENT_WEEK      = 42      (env RPD_CURRENT_WEEK; test suites pin 31)
WITHIN_YEAR_WEEK   = 52
DISPLAY_HORIZON    = 52      every surface shows W1–W52 only
HORIZON_WEEKS      = 78      the scheduler's internal search limit, never displayed
```

The planning year is 52 weeks. No surface shows a week past W52; work that runs past W52 is
shown as **spillover**. `HORIZON_WEEKS` is still the scheduler's search limit, so it can tell
spillover (it fits by W78) apart from `LEFT_OUT`. Surfaces present any `LEFT_OUT` project
inside the spillover framing ("past W52"). The server still decides each verdict (I9).

### The current week follows the calendar *(2026-11-16, ADR 0052; binding since P37-T02, 2026-11-17)*

This replaces the `CURRENT_WEEK = 42` line above. Until each P37 task lands in code, the rule it
replaces stays what the code does. The text folds in the workflow-auditor's ruling R37-1..R37-10
(ADR 0052 "Ruling (P37-T01)") and the owner's answers to OQ #88–#92 (2026-11-17).

```
plan_year        = RPD_PLAN_YEAR (default 2026), served
(iso_year, iso_week) = ISO week-date of today in Europe/Athens (every hub); the ISO week-year decides
CURRENT_WEEK     = RPD_CURRENT_WEEK                      if set (pin, 1..52, validated at startup;
                                                          test suites pin 31)
                 = min(iso_week, 52)                     if iso_year == plan_year   (W53 → 52, not closed)
                 = 52, plan_year_closed = true           if iso_year >  plan_year   (OQ #88 (a))
                 = 1                                     if iso_year <  plan_year
weeks_left_in_year = 52 − CURRENT_WEEK                   (the current week not counted; OQ #91)
WITHIN_YEAR_WEEK = 52, DISPLAY_HORIZON = 52, HORIZON_WEEKS = 78   (unchanged, absolute)
```

- **One clock, read late.** The week is evaluated through one service, `plan_clock`:
  - once per request;
  - once when a run row is created: the `QUEUED` row, the coalesced follow-up included, or the
    request of a synchronous solve.

  The worker builds the solver input with the row's week (R37-2). The week is never evaluated at
  import, and no function parameter defaults to it. The browser never derives the week or the date
  from its own clock; it shows the served `current_week` and `as_of_date`.
- **Two readings.** Everywhere this document writes `CURRENT_WEEK`, it means one of two things:
  - **Calendar week** (the formula above) is used for:
    - recording facts: the check-in stamps, `stage_checkins.week`, and the tracking status and
      "per plan" % (see "Weekly check-in", Due stage as amended by R37-1);
    - the input week of every new solve: live, What-if, plan import and Monte Carlo;
    - run-independent figures: remaining capacity supply ("Capacity supply"), remaining demand
      (I25), the Capacity `remaining_weeks` and the P1 capacity fill;
    - every "now" marker.
  - **Run week** (`ScheduleRun.current_week`) is used for anything that interprets a stored run:
    the health badge, overrun and overdue against plan (I13), the capacity priority split, run step
    effort and ask-agent context. A stored run is never re-evaluated at another week (I14).
- **Weekly rollover run.** One idempotent function, `ensure_week_rollover()`, is called by:
  - a Celery beat schedule on the Europe/Athens clock: every 15 minutes, which is the guarantee,
    plus Mondays 00:05;
  - an in-app ticker, every 5 minutes. A setting turns it off, and it is off in the test suites
    (R37-9).

  Under the dispatch advisory lock, it recomputes the decision from state on every tick (R37-8):
  - `not_needed`:
    - there is no active run (R37-7);
    - or the active run's week **==** `CURRENT_WEEK`;
    - or an in-flight run's stored week **==** `CURRENT_WEEK` (R37-6: equality, never "<");
    - or `plan_year_closed`.
  - `deferred` when a run at another week is in flight. This registers the one coalesced follow-up
    (ADR 0023), which reads the week when its row is created.
  - `queued` otherwise: greedy, `activate=True`, `trigger_reason="week_rollover"`, system actor,
    audit `schedule.week_rollover`. It runs even when no project is schedulable.

  Retry: `plan_week_rollovers` counts only queued attempts. A failed attempt is a queued run ending
  `FAILED`, `DISPATCH_FAILED` or `ABANDONED` while the weeks still differ. There are at most 3
  attempts per `(plan_year, week)`, at least 30 minutes apart, and then the status is `failed`.

  The rollover never dispatches CP-SAT and never sets per-project `schedule_stale`. It may replace
  an active CP-SAT plan (owner, OQ #89 (a)). This is the fourth exception to "Rescheduling is
  explicit".
- **While the plan is behind** (`active run week ≠ CURRENT_WEEK`):
  - surfaces still show the active run's verdicts (I9);
  - the header, Gantt, Dashboard, Capacity, Workspace and check-in page say "Plan from W*n*" with
    the rollover status;
  - the What-if and plan-import results say "Simulated from W*c*; the active plan is from W*n*"
    whenever their input week differs (R37-3);
  - `GET /schedule-runs/{run}/changes` serves `baseline_week` and `run_week`, and the UI labels a
    list where they differ "includes the move from W*a* to W*b*" (R37-4).

  A surface never shows a calendar-week value beside a run of another week without saying so.
- **Closed year (R37-10, OQ #88 (a)).** While `plan_year_closed`, `POST /check-ins` answers 409
  `PLAN_YEAR_CLOSED`. Reads stay available, and no rollover is dispatched. An Admin opening 2027 is
  a separate ADR and phase (P37-F01).
- **Seed status week (R37-5).** The client seed derives stage progress as of `SEED_STATUS_WEEK = 42`
  (the client's April status, ADR 0041), whatever the calendar says. The seed's summary run and its
  persisted first run use the calendar week.
- **History (OQ #90 (a)).** Check-in rows already stamped 42 are left as they are.
- *Observations.*
  - At W47 a Not Started step can start at W47 at the earliest, so within-year has 6 placement
    weeks (W47–W52), and a Not Started step longer than 78 − 47 = 31 weeks is `LEFT_OUT`.
  - No stage advances for weeks without a check-in (ADR 0023). Without check-ins, every Monday
    therefore moves about every projected finish by +1.
  - Measured at P37-T01 on the dev data, within-year / spillover / left out were 135/63/74 at W42,
    114/82/76 at W47 and 77/113/82 at W52 (accepted by the owner, OQ #92).

**Invariants (ruled at P37-T01, exact text):**

- **I38 — one week per solve.** Every `ScheduleRun` stores `current_week` equal to its input's
  `current_week`. That value is the calendar week (or the pin), read once when the run row is
  created (the `QUEUED` row, or the request of a synchronous solve), and the solver input is built
  with the row's week. It is never a value bound at import. Every row and outcome of the run is
  computed at that week. Re-reading a stored run uses its stored week.
- **I39 — one rollover per week.** For each calendar week `w`, while an active run exists whose week
  ≠ `w` and the planning year is not closed:
  - the system dispatches at most one `week_rollover` run per attempt, and at most 3 attempts at
    least 30 minutes apart; or it registers one coalesced follow-up when a run at another week is in
    flight;
  - after a dispatched or follow-up run completes, the active run's week is `w`;
  - concurrent or repeated ticks create no further run;
  - a pinned week that does not change creates none;
  - the rollover never dispatches CP-SAT and never sets per-project `schedule_stale`.
- **I40 — one served week.** Within one response, every field derived from "today" uses the same
  calendar week. `GET /me.current_week` equals it and `weeks_left_in_year = 52 − current_week`.
  Every view that shows run-derived values beside a "now" value shows the run's week when it differs
  ("Plan from W*n*"). The frontend holds no week or plan-year constant outside test fixtures and
  never derives the week or the date from the browser clock.
- **I41 — week domain.** `1 ≤ CURRENT_WEEK ≤ 52` always. The ISO week-year (not the calendar year)
  decides: an ISO W53 date maps to 52, and a date in a later ISO week-year than `plan_year` maps to
  52 with `plan_year_closed`. Stored plan weeks are never re-based by the clock.

## Scheduling order (serial schedule-generation scheme)

Sort all projects by, in order:

1. `frozen` descending (frozen projects scheduled first, dates locked)
1a. *(2026-11-17, ADR 0056 R42-5; binding once P42-T02 lands)* `counts_toward_year` descending:
    queued P3 (In Queue) projects walk after every counting project. See "Priority band meaning".
2. `is_vip` descending: a VIP project schedules before every non-VIP one, whatever its band
   *(2026-10-22, ADR 0040)*
3. Priority: `P1 → P2 → P3 → P4 → Q`
3a. *(2026-11-15, ADR 0050, R36-1..R36-10)* `band_rank` ascending, NULL last: the planner-set
   position inside the band (Priority board). Every schedulable project with a priority has a rank,
   dense 1..n per band; so keys 4–5 only order unranked (What-if / imported) projects. A project
   entering a band goes last. CP-SAT takes the order via `prepare_run`; its objective is unchanged.
   I30 reads "equal on keys 1–3a and 4"; I37 a–d in ADR 0050 / MEMORY P36-T01.
4. Status: `In Buyoff (0) → Under Industrialization (1) → In Development (2) → In Queue (3)`
5. Category: `A+ → A → B → C → A-OEM → B-OEM → C-OEM` *(OEM tail added 2026-09-27)*
   *(2026-11-13, ADR 0047 §3, R33-8)*: ascending `categories.rank`, recorded in
   `workflow_snapshot["categories"]` when it differs from the default seven. The seeded ranks reproduce the order above exactly. An added category takes the
   position chosen when it was created. *(2026-11-15, P33-T20)* Since key 3a, every schedulable
   live project has a band rank, so the category rank is only a tie-breaker. In practice it orders
   What-if and plan-import projects; it never moves a ranked live project.

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

## Booking rules *(revised 2026-09-27; FTE 2026-10-21, ADR 0032)*

- **Design step**: the project's assigned leader must be free for every week in `[w, w + span)`.
  Non-frozen projects advance `w` until a free window is found. *(2026-10-21, ADR 0032)* FTE gates
  speed:
  ```
  span = ceil(duration_weeks / leader.fte)      # elapsed weeks; per step; exact decimal arithmetic
  ```
  (4 weeks at 0.5 FTE = 8; at 0.63 FTE = 7; at 1.0 = 4.) `duration_weeks` stays the effort figure
  and is what the run row reports, load counts and progress weights. The leader is booked for every
  week of the span and still does one step at a time. Lab, elapsed and skipped steps are never
  stretched. A **frozen** project is never stretched (its dates are locked, I10).
- *(2026-10-21, ADR 0032)* **Leader FTE ≤ 0** (or not finite) on a non-frozen project with design
  work left to place: the project is rejected as a `data_error` (no rows, no capacity, null
  completion weeks). Nothing divides by zero. With no design work left, the FTE is irrelevant. An
  unassigned or unknown leader is unchanged: `LEFT_OUT` with `no_leader`.
- **Lab step**: a chamber in the project's lab region whose `allowed_stages` includes this step, with
  concurrent project count `< chamber.max_concurrent` (= platform count) for every week in the
  window. Consumption is **`1.0` platform-week per project-week** (ADR 0007; the prototype's `0.5`
  is retired).
- **Elapsed step**: no resource is booked; the step occupies `[w, w + duration)` starting at its
  earliest feasible start. It never waits for capacity.
- **Skipped step** (`eff == 0`: a 0-week lead time, a lab step when `certification_testing_required`
  is false, or a step the effort split zeroed; ADR 0041 R5): occupies nothing;
  `start = end = max(predecessor end)`.
- **Frozen projects**: dates are locked at `actual_start`; capacity is consumed regardless of
  conflict. A double-booked engineer raises `ENG_CONFLICT`; an over-capacity chamber raises `OVERLAP`.
- **LEFT_OUT**: no feasible window before `HORIZON_WEEKS`.
- **CAT_NOT_ALLOWED**: assigned leader's `allowed_categories` excludes the project's category (or
  `OEM` for OEM-hub projects). Warning, not a scheduling block.
- **Completing within year**: `!left_out AND (last_step_end + delay <= WITHIN_YEAR_WEEK)`. Otherwise
  `SPILLOVER`.
- Status `Commercialized`, `On Hold`, `Cancelled` and `Draft` are excluded from scheduling entirely.
- *(2026-11-17, ADR 0056 R42-3)* A non-frozen project with priority `P4` or `Q` in a schedulable status
  is excluded too (`not_scheduled_priority`). "Completing within year" also requires
  `counts_toward_year`. See "Priority band meaning".

## Project statuses and registration *(2026-10-21, ADR 0034)*

Statuses: the four schedulable ones (`In Buyoff`, `Under Industrialization`, `In Development`,
`In Queue`, ordered as in "Scheduling order") and the excluded ones (`Commercialized`, `On Hold`,
`Cancelled`, `Draft`).

- **Registration creates `In Queue`.** A project is registered only when every required field is
  set: leader, category, type, actual start week, TCOGS, selling price, gross margin and priority.
  `name` and `hub` are always required. A missing field rejects the registration, and nothing is
  stored. A new project is marked `schedule_stale`; registering never runs the scheduler.
- **`Draft` is retired.** It is kept only for historic rows. Nothing creates it, and no edit may set
  a project to `Draft`. A legacy Draft row may still leave Draft. The same required-field check
  applies, and the default target is `In Queue`.
- `In Buyoff` is a normal schedulable status and may be set by an edit.

## Project charter fields *(2026-10-21, ADR 0035)*

`plant`, `requesting_department` and `product_type` are optional text (≤ 100 characters). Each
holds the client workbook's value as written (`Plant/OEM`, `Requesting Department`,
`Product Type`). The workbook's lists are reference vocabularies, not a write constraint:
`domain_constants.PLANT_OPTIONS`, `REQUESTING_DEPARTMENT_OPTIONS` and `PRODUCT_TYPE_OPTIONS`.
These fields are served read-only and are never a scheduling input. The resource-load
`requesting_department` filter matches the stored value exactly; a project with no department
never matches. Not financial, so not encrypted.

## Priority moves *(2026-10-09, ADR 0015)*

Changing a project's `priority` to a different value is the one edit that schedules by itself.
Every other input edit still only sets `schedule_stale` (ADR 0006). This holds whether the change
comes through `POST /projects/{id}/priority` or `PATCH /projects/{id}`.

```
if new == old:                        no-op (unchanged)
if hard_gates non-empty and new != P1: reject 409 HARD_GATE_FORCES_P1
write priority, audit project.priority_move, set schedule_stale
if status not schedulable:            not_needed (no run)
elif a run is queued/running:         deferred   (stays stale; registers the one coalesced follow-up run — ADR 0023)
else:                                 queued — greedy run, activate=True, trigger_reason="priority_move"
```

- Greedy only (OQ #10). The run is a new immutable `ScheduleRun` (I14). Frozen dates never move
  (I10).
- What moved is served by `GET /schedule-runs/{run}/changes?against={baseline}`. It compares the
  stored `projected_end_week`, `within_year`, `left_out` and `blocked` of the two runs. It is
  hub-scoped and its rows are never recomputed (I20).

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
                       with the effective durations `eff` only (Done/In-Progress stages keep their actual
                       start; remaining weeks as in the progress rules). Computed by the scheduler
                       as a pure by-product and stored on the run's outcome row.
                       (2026-10-21, ADR 0032) Design steps use their FTE-stretched span:
                       unlimited engineers remove contention, not the leader's own speed.
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
| Financial Return | Gross Profitability *(was "Gross Margins")* | 25 |
| Market & Volume | Annual Volume | 15 |
| Market & Volume | 3-Year Volume | 25 |
| Market & Volume | New Models | 15 |
| Investment & Feasibility | CAPEX Investment (inverted) | 15 |
| Investment & Feasibility | ROI *(was "Profitability", moved from Financial Return)* | 25 |

*(Amended 2026-10-19, ADR 0029.)* Wire and DB keys are unchanged (`gross_margins`, `profitability`).

*(Amended 2026-10-21, ADR 0033.)* Each dimension score is an integer **0..5** (was 1..5). A score of
0 ("does not apply") earns 0 points. The formula, the total and the bands below are unchanged.

*(Amended 2026-10-22, ADR 0037: editable rubric.)* The table above is the **initial** rubric
(version 1), not a constant.
- **Where it lives.** Dimensions (stable `key`, `label`, `pillar`, `weight` 1..100, `inverted`,
  `active`, `display_order`) are in `scoring_dimensions`. Per-project scores are in
  `priority_dimension_scores` (0..5 or null).
- **Editing.** Admin and Super Admin edit the rubric in the Matrix: weights, labels, pillars and
  order; they can add dimensions (and new pillars) and deactivate or reactivate dimensions. A
  dimension is never deleted.
- **Versions.** Every change is a new rubric version (snapshot, who, when, reason), and every
  stored score is recomputed in the same transaction.
- **TOTAL_WEIGHT** = Σ weights of the **active** dimensions.
- **Missing scores.** A missing (null) score on an active dimension counts 0 points and makes the
  project's score "incomplete" (`missing_dimension_keys`). A project with no score on any active
  dimension is Unscored.
- **Rounding** is exact, half up. Under the initial rubric it is identical to the old `round()`.
- **Schedule.** A rubric change never changes the schedule: the scheduler does not read scores, and
  nothing is marked stale.

*(Amended 2026-10-22, ADR 0038: registration tags.)* At Registration a project carries zero or more
"project nature" tags: New Customer → `new_customer`, Strategic Project → `strategic_project`, New
Options → `new_options`, Regulatory / Business Compliance → `regulatory_compliance`, New Models →
`new_models`, Improvement → `quality_improvements`.
- When a tag goes from not set to set, the mapped dimension's score is written as **5** (full
  weight) in the same transaction. Re-saving a tag already set does not rewrite it; removing a tag
  leaves the score unchanged.
- The pre-filled 5 is an ordinary, editable score. Untagged dimensions are scored manually.
- Existing projects are backfilled from `type`: NM → New Models, NO → New Options, RC → Regulatory
  Compliance, IMP → Improvement.
- Schedule unchanged; committed priority never rewritten.

```
TOTAL_WEIGHT = Σ weights = 295            (derived, never hard-coded; the client said "300", see OQ #41;
                                          ADR 0037: Σ ACTIVE weights of the current rubric version)
score(d)     ∈ {0, 1, 2, 3, 4, 5}         (ADR 0033)
points(d)    = score(d) / 5 × weight(d)   a dimension contributes its weight at score 5, weight/5 at
                                          score 1 and 0 at score 0 (not score × weight)
raw          = Σ points(d)                out of TOTAL_WEIGHT
normalised_pct = round(raw / TOTAL_WEIGHT × 100)      shown out of 100
displayed points(d) = points(d) × 100 / TOTAL_WEIGHT  (the scaled-to-100 view)
```

The percentage is mathematically the same as the old `Σ(score × weight) / (280 × 5)`, but with the
new weights. Bands are unchanged.

```
Bands:
  >= 70 → P1
  >= 55 → P2
  >= 40 → P3
  else  → P4
```

### P1 capacity fill *(2026-10-21, ADR 0036)*

Owner ruling: "P1 for score >= 70 is right, but if capacity is not full, add projects to P1 until
capacity is full." This changes the **suggested** band only, computed on read, per hub:

```
C       = hub remaining-year design capacity        (= /capacity/hub-load design_capacity_remaining)
load(p) = p's remaining design DEMAND (I25 rem, effort weeks; 0 for a non-schedulable project)
          (2026-10-23, ADR 0041 R12: the same basis as `design_load_remaining_weeks`, so "capacity
          full" means the same as on the Capacity page; before, the remaining effort the active
          run booked)
base    = hub's scored projects with normalised_pct >= 70 (score band P1, any status)
L       = Σ load(p) over base
if no active run, or C <= 0, or L >= C:  promote nothing
candidates = hub's scored projects with normalised_pct < 70 and a schedulable status
             (not Commercialized / Cancelled / On Hold / Draft),
             ordered by normalised_pct DESC, then project_id ASC (canonical UUID string)
for p in candidates:
    if load(p) == 0:        skip p (not promoted), continue
    if L + load(p) <= C:    promote p to "P1 (capacity fill)"; L += load(p)
    else:                   STOP
```

- Served as `suggested_band` (promoted band), `score_band` (pure score band), `capacity_fill` and
  `capacity_fill_reason` on Matrix rows. Per-hub totals are served by `GET /priorities/capacity-fill`
  (`docs/API_CONTRACT_P25.md`). Matrix band counts use the promoted band. *(P25-T03:)* the same
  four fields, from the same computation, are served on Priority board cards, in the Workspace
  score section and in the Matrix export, so a project's fill is identical everywhere it is shown.
  Board columns stay keyed by the committed priority.
- The fill never writes `Project.priority`, a score or an audit row, and it never schedules. The
  committed priority stays a human decision (Priority board, ADR 0015/0018). Exact 2 dp arithmetic.
- The walk for a hub uses every project of the hub, independent of row filters and of the caller.
  Hub Planners see only their own hubs.
- *(P27, security S26-L1:)* `capacity_fill_reason` carries the hub's P1 design load and capacity.
  In the Workspace it is served with figures only to a caller who has the project's hub in scope
  and can read the Matrix. Anyone else gets "P1 (capacity fill)" when promoted, null otherwise.
  The band and `capacity_fill` stay identical everywhere.
- Hard gates do not enter the base set (`docs/OPEN_QUESTIONS.md` #51).

### Hard gates (override band, force P1)

- Regulatory deadline within 6 months
- Customer certification at risk (Coke/Pepsi)
- Active safety non-compliance

## Currency

Base EUR. `EUR = 1.0`, `USD = 1.08`, `INR = 97`. Rates must be configurable at runtime, not
hardcoded constants — store them in a config table, not in code.

*(Amended 2026-10-21, P21.)* Currencies are `EUR`, `USD`, `INR`, `EGP` (Egyptian pound), `ZAR`
(South African rand) and `IDR` (Indonesian rupiah). No rate is invented: `EGP`, `ZAR` and `IDR` are
seeded with **no rate** ("not configured", `rate_to_eur = null`) until a Super Admin (or Admin) sets
one through `PUT /currency-rates/{code}` (positive, audited). Converting into a currency with no
configured rate is a 422 `CURRENCY_NOT_CONFIGURED`; nothing falls back to EUR silently. The rates for
the three new currencies are asked in `docs/OPEN_QUESTIONS.md` #50.

---

## KNOWN DEFECTS IN THE PROTOTYPE — do not silently replicate or silently fix

These three are **open decisions**. Each requires an ADR before implementation. Recording them here
so no agent "fixes" them without approval and no agent copies them blindly.

1. **FTE is not applied in scheduling.** The Capacity Planning surface reports capacity scaled by
   FTE (0.5 FTE → 9.4 weeks, 1.0 FTE → 18.9 weeks), but the scheduler treats every engineer as fully
   available for whole weeks. Capacity reporting and the Gantt therefore disagree.
   → `docs/OPEN_QUESTIONS.md` #2. **Closed 2026-10-21 (ADR 0032, supersedes ADR 0002):** FTE gates
   speed. A design step books `ceil(duration / fte)` weeks, and load stays in effort weeks, so the
   Gantt and booked % now agree with the FTE-scaled capacity.
2. **Chamber `efficiency` and `weeks_per_chamber` are display-only.** Only `max` concurrent gates
   booking. → `docs/OPEN_QUESTIONS.md` #3. *(2026-09-27: `weeks_per_chamber` retired; `efficiency`,
   platforms and downtime now feed the capacity-supply formula (ADR 0008). Booking is still gated
   by `max_concurrent` only.)*
3. **Delay is not propagated.** It is applied once at the end (`end + delay <= 52`) rather than
   pushed into downstream steps. → `docs/OPEN_QUESTIONS.md` #5.

## Invariants (the workflow-auditor asserts all of these on every solver run)

- **I1**: No engineer is assigned two design steps in the same week — unless at least one project is
  `frozen`, in which case `ENG_CONFLICT` is raised. *(ADR 0032: "in the same week" means any week of
  either step's FTE-stretched span.)* *(2026-11-17, ADR 0054: amended. See "Manual step weeks":
  pinned placements are exempt with `ENG_CONFLICT`, including two placements of the same project.)*
- **I2**: No chamber exceeds `max` concurrent projects in any week — unless frozen, then `OVERLAP`.
  *(2026-11-17, ADR 0054: amended. See "Manual step weeks": pinned placements, like anchored ones.)*
- **I3** *(revised 2026-09-27, ADR 0009)*: Every non-skipped step starts after all of its
  predecessors end: `step.start >= max(pred.end) + 1`. Under the seeded strict chain this is the
  old `step[n].start >= step[n-1].end + 1`. *(2026-11-17, ADR 0054: every non-skipped,
  **non-pinned** step; a pinned step answers to I47. See "Manual step weeks".)*
- **I4**: A lab step is only ever booked to a chamber in the project's lab region whose
  `allowed_stages` contains that step.
- **I5** *(revised)*: Every scheduled project has either a complete 14-step schedule (skipped steps
  present with `skipped = true` and zero duration) or `LEFT_OUT = true`.
- **I6** *(rev. 2026-10-23, ADR 0041)*: **booked design load** per capacity hub (ADR 0042) = Σ
  `duration_weeks` of the non-skipped `design`-kind rows **of the active run**, over the projects of
  the hub and its members. Elapsed and skipped rows add 0. These are effort weeks, never the span
  (ADR 0032). The served `design_load_booked_weeks` equals it to the week, and so does Σ Gantt
  per-project design weeks. Each row's `duration_weeks` = `eff` of the run input.
- **I7** *(rev. 2026-10-23, ADR 0041)*: **booked lab load** per lab region = Σ `duration_weeks` × 1.0
  of the non-skipped `lab` rows of the active run. It equals the served `lab_load_booked_weeks`, with
  each region counted once.
- **I8**: Re-running the greedy scheduler on identical input produces byte-identical output
  (determinism).
- **I9**: `within_year` count on the Dashboard equals the count of projects satisfying the
  within-year rule in the current schedule run. No independent calculation anywhere.
  *(2026-11-17, ADR 0052 / P37-T01)* While the active run's week differs from the calendar week, the
  count is still the active run's, and the surface shows the run's week (ADR 0052 §6).
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

*(2026-10-09, ADR 0017)* The `Blocked` status is **shown to users as "On Hold"**, and
`blocked_reason` is shown as "Hold reason". The stored and wire values stay `Blocked` /
`blocked_reason`, and the rules below are unchanged. A stage on hold is not the project-level status
`On Hold`. That status takes the whole project out of the plan. A stage hold keeps the project in
the plan, waiting at that stage.

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

remaining_span = ceil(remaining / leader.fte)   # design step of a non-frozen project (ADR 0032)
               = remaining                       # every other step
```

*(2026-10-21, ADR 0032)* `remaining` (including `remaining_weeks_override`) is remaining
**effort**. The In Progress / Blocked tail books `remaining_span` weeks. `actual_start_week`
stays locked.

`duration_weeks` is the step's effective duration `eff` (ADR 0007, ADR 0019, ADR 0041 R4). A skipped
step (`eff == 0`) has no progress state of its own — it is always treated as complete. A `remaining == 0` in-progress step occupies no future
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
    tail    = [max(CURRENT_WEEK, prev_step_end + 1) .. + remaining_span)   # the not-yet-done part (ADR 0032)
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
| ⏸ On Hold | `blocked == true` (added 2026-09-27, remediation ruling 5; labelled "On Hold" since 2026-10-09, ADR 0017 — health value stays `"blocked"`) |
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
  mean of the 14 `percent_complete` values. *(Rounding, stated 2026-10-23, P30 gate:)* the exact
  quotient is rounded half-to-even — a tie at exactly .5 goes to the even integer (62.5 → 62,
  87.5 → 88). Scheduler and Workspace share `scheduling.project_progress_pct`. This deliberately
  differs from the half-up rounding of scores (ADR 0037) and effort (I26).
- **I13** *(restated 2026-11-17, ADR 0052 / P37-T01)*: The Project Workspace health badge for a
  project is a pure function of that project's stored outcome in the active `ScheduleRun` (finish
  week, per-stage overrun, `left_out`, `blocked`). Every week comparison it makes (overrun, overdue
  against plan) uses that run's stored `current_week`, never the calendar week. No independent
  recomputation anywhere; mirrors I9.
- **I14**: "Recalculate schedule" creates a new `ScheduleRun` row; it never mutates an existing one.
  Every historical schedule version remains byte-stable after later recalculations.

---

## Capacity supply *(2026-09-27, ADR 0008)*

The RPD Capacity surface's *supply* figures are the client's, computed from a per-hub work calendar
and per-chamber downtime. `CURRENT_WEEK` is one global value. *(2026-10-23, ADR 0041)* The load is
served three ways ("Load basis", below): full-year demand, remaining demand (both I25) and the
run-booked load (I6/I7).

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

*(2026-11-17, ADR 0053 §4, R38-1)* Inactive engineers count only for their active weeks:
- `Σ fte` in `yearly_design_capacity` becomes `Σ fte_e × A_e(Y, 1..52) / 52`.
- `Σ fte` in `remaining_design_capacity` becomes `Σ fte_e × A_e(Y, CW+1..52) / (52 − CW)`, which is
  0 when CW = 52.

`A_e` counts the weeks not covered by an inactive period, and the deactivation week counts as
worked. See "Engineer deactivation".

### Load basis *(2026-10-23, ADR 0041 §2, R8, R9, R12)*

Per capacity hub (design, own + member hubs) and per lab region (lab, each region once):

| Served field | Definition | Paired with (booked %, gap, completion) |
|---|---|---|
| `design_load_weeks` / `lab_load_weeks` | **full-year demand** (I25): Σ `eff` over every project with status ∉ {Cancelled, Draft} — On Hold and Commercialized included (client ruling 2026-10-22) | yearly capacity |
| `design_load_remaining_weeks` / `lab_load_remaining_weeks` | **remaining demand** (I25): Σ `rem` over projects in a schedulable status (In Buyoff, Under Industrialization, In Development, In Queue) | remaining capacity |
| `design_load_booked_weeks` / `lab_load_booked_weeks` | **booked in plan** (I6/I7): what the active run booked | nothing (no booked % of this kind) |

`rem(p,s)` = 0 when `eff = 0` or the stage is Done; for In Progress / Blocked the derived remaining
duration of `eff`; `eff` for Not Started. Effort weeks, never a span; not windowed to W52; stored
progress counts for every project, frozen included. Demand is computed from live project and step
rows (never a run) with the scheduler's own `eff` (`scheduling.demand.compute_demand_load`).

Which load each reader uses (R12): the hub table, areas, totals and lab-region rows serve all three;
`*_load_by_priority` splits the full-year demand; the ADR 0042 `members` carry demand (full year and
remaining) and booked, each summing to its row; the P1 capacity fill uses remaining demand; engineer
utilization (heatmap, resource load) and the what-if "before" stay run-booked; any Dashboard capacity
figure reads the same served fields.

Seed values: `docs/CLIENT_FORMULAS.md` §2.1–2.2. Editable on Capacity Planning (Hub Planner, own
hub) and Workflow Settings (Super Admin); audit-logged. Downtime does not gate chamber booking; it
is a supply-reporting input. *(2026-10-21, ADR 0032, superseding ADR 0002)* FTE now gates design
booking speed (`span = ceil(duration / fte)`, Booking rules). It is still the supply multiplier
here. Supply (`working_weeks × Σ fte`) and load (I6, Σ `duration_weeks`) are both in **effort**
weeks, so `booked_pct` stays comparable: a 0.5 FTE engineer booked for every elapsed week reads
about 100 %, not 200 %. Load sums never use the elapsed span.

### Capacity hubs *(2026-10-22, ADR 0042)*

Client ruling: OEM-HCK and OEM-Seitek are under Greece. `hubs.capacity_hub_id` points both at
R&D-Greece; every other hub is its own capacity hub. Supply (the formulas above) is computed per
capacity hub over its engineers with `counts_in_capacity = true`; load is Σ over the projects of
the capacity hub and its member hubs. Capacity surfaces serve the four capacity hubs only, the
Greece row with a `members` breakdown (own / OEM-HCK / OEM-Seitek) for display; `booked_pct`,
status, gap and `completion_pct` exist for the aggregate only. Booking is unchanged: the scheduler
books the project's assigned leader (Booking rules). Wherever an engineer is *chosen* for a project
(the seed's provisional-leader picker, the what-if planner), the candidates are the engineers of its
capacity hub; workflow selection and lab region stay by hub. Engineers not on
the client's capacity roster (Theoni, Dipak, Antonis, Sailesh — OQ #52) have
`counts_in_capacity = false`: they are booked but never counted as supply. OEM hubs remain hubs for
registration, plant, filters, RBAC and the country filter (ADR 0025).

### Booked % and areas *(2026-10-09, ADR 0016)*

```
booked_pct   = load / capacity × 100            (2 dp; null when capacity == 0)   — year and remaining
               (2026-10-23, ADR 0041, I19 rev.: year = full-year demand / yearly capacity;
                remaining = remaining demand / remaining capacity)
status       = full       if booked_pct >= 100 (or capacity == 0 and load > 0)
               near_full  if 85 <= booked_pct < 100
               available  otherwise
area         = Europe for lab regions Greece, Romania; India for lab region India
area figures = Σ over the area's in-scope hubs (design) and in-scope lab regions, each region once (lab)
```

These are reporting figures. They never gate booking. The thresholds are
`BOOKING_NEAR_FULL_PCT = 85` and `BOOKING_FULL_PCT = 100` (OQ #25).

## Roles *(2026-09-27, ADR 0010)*

`Super Admin` has read + write on every surface and is the only role that may grant/revoke
`Admin`/`Super Admin` or write Workflow Settings. The last active Super Admin cannot be deactivated
or demoted. `GET /me` publishes `permissions[surface] = {read, write}`; the frontend gates
navigation and write controls on it; the server enforces. Full matrix:
`docs/PROJECT_AND_STACK.md` §5.
*(2026-11-13, ADR 0045 §7, owner decision)* **Admin and Super Admin** may edit category timelines,
the Lead times tab and add categories (new surface `workflow_templates`, Admin RW, Super Admin
RW). Steps & precedence, Hub calendars and Chambers stay Super Admin only (`workflow_settings`).

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
  *(2026-11-17, ADR 0054: non-pinned steps only, with `G` of a pinned predecessor as in I47.)*
- **I16**: `expected_end_week`, `projected_end_week` and `unconstrained_end_week` shown anywhere in
  the UI equal the values stored on the active run's outcome row / the project record. No client
  recomputation.
- **I17** *(rev. 2026-10-23, ADR 0041)*: The Capacity surface's supply figures equal the ADR 0008
  formulas evaluated on the stored calendar/chamber inputs, to two decimals. Its load figures equal
  I25 (demand: `*_load_weeks`, `*_load_remaining_weeks`) and I6/I7 (booked: `*_load_booked_weeks`),
  each served field to its own definition.
- **I18** *(2026-09-30, ADR 0012)*: A `ProjectAccessGrant` write (grant or revoke) succeeds only
  when the actor is Super Admin, global Admin, or a manager granting/revoking their own direct
  report on a project where the manager's own effective access is Admin. No principal can grant a
  project role to themselves, to a non-report, or on a project they cannot themselves administer.
  Revoking a grant never reduces a principal's effective access below what rules (1)-(4)/(6) of the
  resolver above already give them.
- **I19** *(2026-10-09, ADR 0016; rev. 2026-10-23, ADR 0041)*: Every served `booked_pct` equals
  `load / capacity × 100` of the same row, to two decimals. **Year** pairs `design_load_weeks` /
  `lab_load_weeks` (full-year demand) with the yearly capacity; **remaining** pairs
  `*_load_remaining_weeks` with the remaining capacity; `gap` and `completion_pct` use the same
  pairs. Nothing of this kind is served for `*_load_booked_weeks`. Its status follows the threshold
  rule. An area's lab load and lab capacity count each lab region exactly once. No booked figure or
  status is computed in the browser. *(2026-11-17, ADR 0052 / P37-T01)* The remaining capacity, and
  the `remaining_weeks` served beside it, are evaluated at the response's calendar week (I40).
  Remaining demand (I25) does not depend on the week. Neither depends on the active run, so the
  remaining pair is never mixed with a run's week.
- **I20** *(2026-10-09, ADR 0015)*: A priority move that returns `queued` creates exactly one new
  `ScheduleRun`, and that run's input carries the new priority. Frozen projects' dates are identical
  across the baseline and the new run (I10). Every row of `GET /schedule-runs/{run}/changes` equals
  the difference of the two runs' stored outcome fields. A project whose compared fields did not
  change never appears.

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

---

## Step timing from the Gantt *(2026-10-10, ADR 0019)*

*(2026-11-13, ADR 0048: **retired** once P33 lands.)* No surface edits these fields any more. The
PATCH answers 410 `STEP_TIMING_RETIRED`. The migration clears the stored values (with audit rows)
and a CHECK forbids new ones. The fields stay in the scheduler input for what-if and plan-import
scenarios only. The text below is kept as the history of the rule.

Two planner inputs per `ProjectWorkflowStep`, never overwritten by a run:

| Field | Domain | Effect |
|---|---|---|
| `duration_override_weeks` | int 1..104 or null | the user's duration for this step; wins over the effort split and the table (see Lead times, `eff`) |
| `start_not_before_week` | int 1..HORIZON_WEEKS or null | a `Not Started` step's search floor becomes `max(CURRENT_WEEK, predecessors' end + 1, start_not_before_week)` |

- Editable from the Gantt: drag the right edge → duration; drag the bar → earliest start; "Reset
  timing" clears both. Done steps never; In Progress / Blocked steps resize only; skipped steps and
  frozen or non-schedulable projects never. *(2026-10-23, ADR 0041 R4)* "Reset timing" restores the
  step's effort value (`effort_weeks`), never the table, when the project carries a figure; a step
  the effort split zeroed refuses a new value (409 `STEP_SKIPPED`), clearing is always allowed. The
  Gantt's "(table T)" hint and "has a timing edit" read only the user's two fields.
- A timing change **recalculates automatically**, exactly like a priority move (same lifecycle,
  greedy only, `trigger_reason="step_timing"`). This is the second exception to "Rescheduling is
  explicit" (OQ #29).
- *(P12-T01 review rulings, 2026-10-10)* A **frozen** project uses its duration overrides (so its bars
  and its capacity load keep matching) but ignores `start_not_before_week`. The **unconstrained
  finish** honours the floor (a floor is a plan input like precedence, not a resource limit), so with
  no `target_end_week` a later floor moves `expected_end_week` later too. A lab step skipped because
  certification testing is off stays skipped regardless of any override.

## Global hub filter *(2026-10-10, ADR 0020)*

Every portfolio read endpoint takes an optional `hub_id` that is **ANDed with the RBAC hub scope and
never widens it**; an out-of-scope `hub_id` returns empty rows and zero totals. Every total, count
and percentage under a filter is computed by the server for the filtered set (I9, I19, I23). Lab
capacity stays region-wide under a hub filter (chambers are shared per region).

## Weekly check-in and tracking status *(2026-10-10, ADR 0021)*

- **Due stage** (for the current week): the project is schedulable and not `frozen` (P12-T03 / P12-R03
  rulings — such projects are `idle`); the stage is not skipped, not `Done`, and either `status ∈ {In Progress,
  Blocked}` or the active run's planned window for the stage contains `CURRENT_WEEK`.
  *(2026-11-17, ADR 0052 R37-1; replaces the last clause once P37 lands)* "…either `status ∈ {In
  Progress, Blocked}` or the active run's planned start for the stage is `≤ CURRENT_WEEK` (calendar
  week)". Due-since for such a stage is its planned start.
  - This reduces exactly to the old rule whenever the run's week equals the calendar week.
  - While the plan is behind, it keeps missed Not Started stages on the check-in list.
  - `plan_percent` reads 100 for a window wholly in the past.
  - While `plan_year_closed`, `POST /check-ins` answers 409 `PLAN_YEAR_CLOSED` (R37-10).
- **Who may check in:** an Engineer for stages of projects they lead or stages assigned to them
  (their engineer = `Engineer.user_id`); Hub Planner (own hub), Portfolio Manager, Admin, Super Admin
  for any due stage in scope; an Editor-or-higher project grant for that project.
- A check-in writes the per-stage progress fields under the existing consistency rules and appends an
  immutable `stage_checkins` row. The server fills `actual_start_week = CURRENT_WEEK` on the first
  move out of `Not Started`, and `actual_end_week = CURRENT_WEEK` on `Done`. It sets
  `schedule_stale` and *(ADR 0023)* dispatches one greedy run per batch (`trigger_reason="check_in"`)
  with the priority-move lifecycle (`queued` / `deferred` / `not_needed`).
- **Coalesced follow-up run** *(ADR 0023)*: any auto-trigger (`priority_move`, `step_timing`,
  `check_in`) that answers `deferred` records one durable follow-up request; when the in-flight run
  ends (success, failure or sweep) exactly one greedy run (`trigger_reason="follow_up"`) is
  dispatched and the request cleared, under the dispatch advisory lock. At most one run in flight
  plus one pending. The explicit Workspace Recalculate is unchanged (409 in flight, no follow-up).
- **No automatic stage advance** *(ADR 0023)*: a stage is never started or completed without a report.
- **Tracking status** (per project, served):
  - `idle` — no due stage;
  - `live` — every due stage has a check-in with `week == CURRENT_WEEK`;
  - `overdue` — some due stage has had no check-in in `CURRENT_WEEK` or `CURRENT_WEEK − 1` and has been
    due since at least `CURRENT_WEEK − 1`;
  - `due` — otherwise.
- **Plan-based progress** ("per plan"): `plan_percent = clamp(round((CURRENT_WEEK − planned_start_week
  + 1) / (planned_end_week − planned_start_week + 1) × 100), 0, 100)`. It is displayed next to the
  reported %, and is never written into progress fields (OQ #31).
- Compliance is shown per project and per stage, never ranked per engineer (GDPR, OQ #8).

## VIP projects *(2026-10-10, ADR 0022)*

- Per hub and year (`plan` = weeks 1–52, `next` = weeks 53–78), at most `limit` (10..15, default
  15) projects. A project is in a year if any of its scheduled step weeks in the active run fall in
  that range; a pipeline project not yet in the run belongs to `plan`.
- Order: pinned projects (`projects.is_vip`) first, then automatic fill; within each group by
  priority `P1 → P4 → Q`, then weighted score descending, then name. More pins than `limit` are all
  shown and the hub is flagged `over_limit`.
- *(Superseded 2026-10-22, ADR 0040.)* ~~VIP never changes scheduling order and a pin never
  recalculates.~~ VIP is a manual pin only (`PUT /projects/{id}/vip`); a VIP board link no longer
  sets it. A pin is a scheduling input (sort key 2 above) and follows the priority-change
  recalculation path.

## P12 invariants *(2026-10-10)*

- **I21** (ADR 0019; amended 2026-10-21, ADR 0032): every scheduled step that is not skipped, not
  `Done` and not in a frozen project carries its effective duration (effort) as `duration_weeks`
  and books a span of `ceil(duration / fte)` weeks if it is a design step (leader FTE `fte`), else
  `duration` weeks. For `In Progress`/`Blocked` the tail is `ceil(remaining / fte)` (design) or
  `remaining`, with `remaining` derived from the effective duration. *(2026-11-17, ADR 0054: pinned
  steps are exempt. A pinned row's window is its pin (I45); its `duration_weeks` is still `eff`.)*
- **I22** (ADR 0019; 2026-11-17, ADR 0054: unpinned steps only): every `Not Started` step with `start_not_before_week` set starts at or after it
  (frozen projects exempt — their dates are locked, I10; ruled 2026-10-10 at P12-T01 review).
- **I24** (ADR 0023): for any burst of auto-triggers answering `deferred` during one in-flight run,
  exactly one `follow_up` run is created after it, and its input snapshot reflects every change saved
  before it was dispatched. *(2026-11-17, ADR 0052 R37-2)* A coalesced follow-up's input week is the
  calendar week read when its row is created.
- **I23** (ADR 0020; rev. 2026-10-23, ADR 0041): for any hub `h` in scope, each hub-filtered Dashboard
  total equals the corresponding unfiltered per-hub figure for `h`, and the Gantt, Capacity and
  Dashboard agree for `h` to two decimals: Dashboard and Capacity show the same served capacity fields
  for `h`, and the Gantt's per-project design and lab weeks for `h` sum to the Capacity
  `*_load_booked_weeks` (not the demand).

## ADR 0041 invariants *(2026-10-23)*

- **I25 — demand load**, from live project and step rows, never from a run, with the same `eff` the
  scheduler uses.
  - Full-year design demand(h) = Σ `eff(p,s)` over design-kind `s`, for every project of capacity
    hub `h` and its members with status ∉ {Cancelled, Draft}.
  - Remaining design demand(h) = Σ `rem(p,s)` over the same, for projects in a schedulable status
    (In Buyoff, Under Industrialization, In Development, In Queue).
  - `rem(p,s)` is 0 when `eff = 0` or the stage is Done; for In Progress or Blocked it is
    `derive_remaining(eff, percent_complete, remaining_weeks_override)`; for Not Started it is `eff`.
    Effort, never a span. Not windowed to W52. Stored progress applies to every project, frozen
    included.
  - Lab is the same per lab region.
  - The served `design_load_weeks`, `design_load_remaining_weeks`, `lab_load_weeks` and
    `lab_load_remaining_weeks` equal these (design to the week, lab to 2 dp).
- **I26 — effort split.** For every non-frozen project with `design_effort_weeks = x > 0` whose
  category has a design-kind step with `lead > 0`, the derived effort on those steps equals the R2
  apportionment of `E = max(1, round_half_up(x))` over their lead times, raised to `max(1, ·)` on
  started steps (R3); Σ = E plus the number of raised steps; other steps carry no derived effort. Lab
  is the same with `lab_effort_weeks` when certification testing is on. It holds in the same
  transaction as any re-derivation trigger (R6). A project without a figure carries no derived
  effort on any step.

## Parallel steps — per-project overlap *(2026-11-04, ADR 0043)*

*(2026-11-13, ADR 0046/0048:)* The overlap is no longer set by dragging. It is the negative part of
the project's copy of the category template gap (`plan_gap_weeks`). A positive gap is a wait (see
"Category templates", below). The formulas here stay in force with `w(s) = 0`.

A `ProjectWorkflowStep` may carry `overlap_weeks` (1..104, null = 0), set by dragging a step bar onto
the work it waits for (Gantt, live or What-if). It amends "Precedence" for that project only:

```
G(q) = max(G(p) for p in P(q))  (frontier-1 if none)   if q skipped (where it is emitted)
G(q) = end(q)                                           if o(q) = 0
G(q) = max(end(q), max(G(p) for p in P(q)))             if o(q) > 0
release(s) = max(G(q) for q in P(s))  (frontier-1 if none)
gate(s)    = max(release(s) + 1 - o(s), max start of the nearest non-skipped predecessors if o(s) > 0, frontier)
```

A Not Started step's search floor is `max(CURRENT_WEEK, gate(s), start_not_before_week)`; an In
Progress / Blocked tail uses `gate(s)` where it used `pred_end + 1`. Frozen projects ignore overlap.
With every overlap 0 this is exactly "Precedence" above. A step that overlapped its predecessors
passes their end on, so successors still wait for all upstream work. Two design steps of one
project still never overlap (one leader, I1). Project completion is the max end over steps. Not
allowed on a workflow's first step (422) or as a new value on a started step (409 `STEP_STARTED`).
"Reset timing" clears it with the other two timing fields.

- **I27** (ADR 0043): every non-skipped Not Started step of a non-frozen project starts at or after
  `gate(s)`; I3 holds unchanged for every step with `o(s) = 0`.

## Plan import into the What-if *(2026-11-04, ADR 0044)*

An `.xlsx` in the client's capacity-planning format can be parsed and simulated on the What-if
planner, merged with the live plan (a matching row replaces its project) or alone. Nothing is
persisted. Durations come from the file's `Process steps` sheet; ancestors of the file's stage are
done before the import; In Development / Under Industrialization rows start their current step In
Progress at `CURRENT_WEEK`; ranked rows are P1 in rank order, unranked rows keep their matched band
or take P3; a blank engineer keeps the matched plan project's leader, else is auto-assigned (What-if picker); On Hold / Cancelled / Commercialized rows are not mapped, an unknown named one becomes a new
What-if designer. The plan year is selectable (2026 → W52, 2027 → W104, absolute weeks); "within
the plan year" is `projected_end_week <= plan_year_end_week`. A file without a Status column (or a blank cell) derives the status — PRIORITY "Running" → In Development (P1, first), else the matched plan project's status, else "Spillover" = Yes → In Development, else In Queue — and blank hub / category / stage fall back to the matched plan project; budget lines (blank PRIORITY, "Provision…", "… CAPEX", "… Certification program") are excluded (ADR 0044 amendment 2026-11-05). Full rules: ADR 0044,
`docs/API_CONTRACT_P32.md`.

*(2026-11-17, ADR 0055 amendment.)* "Nothing is persisted" now means nothing in the **live plan**
is changed. The header names the parser recognises are a stored format; Admin and Super Admin
edit it, and the built-in names are the default. A scenario may be hand-picked: unticked file rows
are excluded, and unticked plan projects (`exclude_plan_project_ids`, merge only) are removed from
**both** runs. A **saved import scenario** is a frozen record of a server-recomputed request and
response, with the week and plan version it was simulated from. It is visible to Admin and Super
Admin, and to a user whose hub scope covers all of its hubs. It never feeds the live plan. Exports
are server-built `.xlsx` with formula injection neutralised. Full rules: ADR 0055,
`docs/API_CONTRACT_P41.md`.


## Category templates, apply rules, categories table *(2026-11-13, ADR 0045–0048; final at P33-T01)*

Binding. Sources: ADR 0045–0048, the workflow-auditor's ruling R33-1..R33-12 and the owner's
ruling OR-1..OR-6 (both in ADR 0046). Where the earlier sections ("Lead times", "Per-project
effort", "Parallel steps", "Step timing from the Gantt") disagree with this one, this one wins.

### A. The category template

One row per workflow × category × step (`workflow_lead_times`):

| Field | Domain | Edited by |
|---|---|---|
| `weeks` | 0..104, the category length | Admin, Super Admin, via apply only |
| `gap_weeks` | −104..104; negative = overlap, positive = wait; 0 on a workflow's first step | Admin, Super Admin, via apply only |
| `effort_weight_weeks` | 0..104, the R2 split weights; backfill = `weeks` | **never** (immutable; copied by "+ Add category") |

The template is edited on Workflow templates (Move ± / Length ± per step, or the Lead times tab).
Both save through one apply.

### B. The per-project copy and the effective duration

Each project step carries `plan_weeks` (0..104) and `plan_gap_weeks` (−104..104). The p33b
migration backfills them from the table and gap 0.

For `k ∈ {design, lab}`: `ownEffort(p,k)` ⟺ some step of `p` of kind `k` carries a non-null
`effort_weeks`. That is, R2 applied: a figure > 0, a step of the kind with
`effort_weight_weeks > 0`, and certification testing on for lab.

```
eff(p,s) = 0                      if kind(s) = lab and not p.certification_testing_required
         = effort_weeks(p,s) ?? 0 if ownEffort(p, kind(s))       # a project's own figure is its timeline
         = plan_weeks(p,s)        otherwise                       # elapsed steps, and kinds with no figure
skipped(p,s) ⟺ eff(p,s) = 0
```

- **R2** (Per-project effort) splits `E` over the category's `effort_weight_weeks`, not over
  `weeks`. R3 and R7 are unchanged. A template edit therefore never reshapes a project's split.
- **R6 triggers** are those of ADR 0041 **minus** "a lead-time edit on Workflow Settings". An apply
  never re-derives effort and never writes `effort_weeks`.
- **A figure cleared** for kind `k`: R6 clears the effort, and the current template `weeks` are
  re-copied onto the steps of kind `k` that are not reached (§C). The project then follows the
  template. Entering a figure makes it govern that kind; `plan_weeks` is kept but unused.
- **Registration** copies `weeks` and `gap_weeks` onto all 14 rows. A **category change**
  re-copies them onto the not-reached steps (and R6 re-derives with the new weights).
- **Load.** An own-effort kind loads `E + raised`, whatever the template. Every other step loads its
  `plan_weeks`. Demand (I25) moves at commit; booked loads (I6/I7) move after the run.
- **Scheduler input.** The live builder maps each step as follows:
  - **own-effort step:** `lead_weeks = effort_weight_weeks` (None when equal to the table) and
    `duration_override_weeks = effort_weeks`;
  - **any other step:** `lead_weeks = plan_weeks` (None when equal to the table) and
    `duration_override_weeks = None`.
  The scheduler evaluates `lead = lead_weeks ?? table`, `eff = override ?? lead` (R33-1).

### C. Applying a template change

Evaluation is per (project `p`, changed step `S`), on stored stage statuses, after locking the
category's project rows `FOR UPDATE` in `project_id` order. The stage PATCH and check-ins take the
same lock.

```
reached(p,S)   ⟺ stage(S) ∈ {In Progress, Blocked, Done}
                  ∨ ∃ t ∈ succ⁺(S) in the DAG in force: stage(t) ≠ Not Started
never(p,S)     ⟺ p.frozen ∨ p.status ∈ {Cancelled, Commercialized} ∨ reached(p,S)
automatic(p,S) ⟺ ¬never(p,S) ∧ every stored stage of p is Not Started    (any other status:
                                                                           On Hold, Draft, In Queue, …)
choosable(p,S) ⟺ ¬never(p,S) ∧ ¬automatic(p,S)
```

- **Choosable projects:** the user applies to all or ticks individual ones. Automatic pairs always
  apply.
- **What a receiving pair gets:**
  - a **gap** change → `plan_gap_weeks`, for every project;
  - a **length** change → `plan_weeks`, only if `¬ownEffort(p, kind(S))`; otherwise nothing,
    flagged "uses its own effort figure — length not applied".
- **One transaction:** template (`weeks`, `gap_weeks`, `template_version + 1`), copies,
  `schedule_stale` on the changed projects, and the audit (one `workflow_template.applied` summary
  with every affected project id, and one `project.template_applied` per changed project).
- **Then one greedy run** with the priority-move lifecycle (`trigger_reason="template_apply"`;
  queued / deferred plus coalesced follow-up / not_needed). It is `not_needed` when no schedulable
  project's copy changed.

### D. Signed gap

`g = plan_gap_weeks`, `o = max(0, −g)`, `w = max(0, g)`. `G` and the anchor are as in "Parallel
steps".

```
gate(s) = release(s) + 1 + w(s)                                       if o(s) = 0
        = max(release(s) + 1 − o(s), max start of SG(s), frontier)    if o(s) > 0
```

- **Not Started floor:** `max(CURRENT_WEEK, gate(s), start_not_before_week)`. A wait counts from
  the release, so an already elapsed wait costs nothing. Waits count against `HORIZON_WEEKS`.
- **A wait books nothing:** no engineer, no chamber, no row, no load, no progress weight.
- **`w = 0`** on In Progress / Blocked tails and in a Blocked hold; `o` is kept on started steps.
- **`g` is ignored** on a skipped step (emitted at `G`) and in a frozen project. A frozen project
  still honours `lead_weeks` and the effort merge. A non-zero `g` on a first step is rejected.
  `o > 0 ∧ w > 0` is invalid.
- **CP-SAT** uses `start ≥ pe + w`. **Monte Carlo** never samples gaps.
- **`unconstrained_end_week`** applies the one-leader rule: a design step never overlaps another
  design step of the same project. Under the strict chain with `o = 0` it is vacuous.
- **Template preview:** the same gate from week 0, with no capacity, FTE 1.0 and the one-leader
  rule. Flags are `same_leader_serialised` ("Overlap — same leader, runs back-to-back"),
  `anchor_clamped` and `gap_ignored_zero_length`. It always carries the note that real projects
  also wait for engineers and chambers.
- **Canonical / hashed input and the run snapshot** omit `wait_weeks = 0`, `lead_weeks = None` and
  the default category list (R33-7). Per-project overlaps recorded in stored runs keep their values
  (I14, T05 ruling 6).
- *History (T05-A1, retired by P33-T13 on 2026-11-15).* Between p33b and p33c the live builder also
  carried the hand-set `duration_override_weeks`, `start_not_before_week` and `overlap_weeks`, so
  that p33b alone changed nothing. p33c cleared those fields, and the CHECK keeps them null. P33-T13
  removed that term and the user-override term from `services/workflow_durations.py`.
- **Final effective duration for live projects** (no user-override term): `eff` is §B exactly. The
  run input carries `duration_override_weeks = effort_weeks` on own-effort steps and None
  elsewhere, `start_not_before_week = None`, and `overlap_weeks` / `wait_weeks` from
  `plan_gap_weeks` only. The scheduler's `override ?? lead` (R33-1) remains for what-if and
  plan-import scenarios. With every gap 0 and every copy equal to the table, every
  golden file, input hash, fresh run and stored run is byte-identical (I8, I14).

### E. Categories table (ADR 0047)

- `categories(code, label, workflow_id, rank, template_version, …)`, seeded with the seven codes at
  ranks 1..7.
- `projects.category`, `workflow_lead_times.category` and `engineers.allowed_categories` reference
  it (`OEM` stays a reserved eligibility value).
- **Adding a category** copies the source's `weeks`, `gap_weeks` and `effort_weight_weeks`, extends
  every engineer eligible for the source, and inserts the new code at the chosen rank. The relative
  order of the existing categories is unchanged. Nothing becomes stale.
- **Scheduling order key 5** = rank value. The input's category list is validated (unique codes,
  unique ranks ≥ 1). Each entry's `workflow_id` is checked for **non-default lists** (T05 ruling 4).
  Every project's category must be listed and of the project's workflow, always.
- Rename, deactivate, delete and re-rank are out of scope (OQ #79).

### F. Per-project timing editing retired (ADR 0048)

The Gantt drag and dialog and the Workflow "Project step timing" drag become read-only. The step
timing PATCH and `PUT /workflow-settings/lead-times` answer 410. Migration `p33c` clears the hand-set
`duration_override_weeks`, `start_not_before_week` and `overlap_weeks` (with audit rows), and a
CHECK forbids new values. One recalc follows (`trigger_reason="timing_cleared"`). The fields stay in
the scheduler input for what-if and plan-import scenarios. I22 is vacuous for live runs and stays in
the validator.

**Deploy order (2026-11-15).**
- The P33-T13 code and migration `p33c` ship **together**.
- After `alembic upgrade head`, run the script **once**, on-prem as
  `docker compose run --rm api python -m scripts.p33_recalc_after_timing_clear`. Use `run`, not
  `exec`, consistent with `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` §8. The container needs
  `RPD_DATABASE_URL` and the field encryption key.
- *(2026-11-15, P33-R01)* A second call answers `already_dispatched` only if the first
  `timing_cleared` run completed or is still running. After a failed, cancelled or abandoned run it
  dispatches again. With nothing cleared it answers `nothing_cleared`.
- Exit codes:
  - `0`: ok (`queued` / `deferred` / `already_dispatched` / `nothing_cleared`);
  - `1`: `run_failed` or `dispatch_failed`;
  - `2`: database URL missing;
  - `3`: `still_running`.
- Migration chain: `p32a → p35a → p33a → p36a → p33b → p33c`. The P35 and P36 migrations must ship
  with P33 or before it, never after.

### Invariants (P33)

- **I26** *(rev.)*: for every non-frozen project with figure `x > 0` of a kind whose category has a
  step of that kind with `effort_weight_weeks > 0` (certification testing on, for lab), the stored
  `effort_weeks` on those steps equal the R2 apportionment of `E = max(1, round_half_up(x))` over
  `effort_weight_weeks`, raised to `max(1, ·)` on started steps. Σ = E + the raised count. Other
  steps carry none.
- **I27** *(rev.; 2026-11-17, ADR 0054: "and not pinned")*: in every run, every non-skipped Not
  Started step of a non-frozen project that is not in a Blocked hold and not pinned starts at or after `max(CURRENT_WEEK, gate(s), start_not_before_week)`, with
  `gate` as in §D and `release`/`G` taken from the run's own rows. I3 holds unchanged for every step
  with `o(s) = 0`, including `w(s) > 0`.
- **I28**: every such step with `w(s) > 0` starts at or after `release(s) + 1 + w(s)`. Two inputs
  differing only in `w` give identical `duration_weeks` on every row, identical I25 demand and
  identical I12 weights.
- **I29**: every run row's `duration_weeks` equals `eff` evaluated on the run's input
  (`lead_weeks ?? table`, then `override ?? lead`), with "skipped" exactly when it is 0. On live
  input that equals §B's `eff`.
- **I30** *(rev. 2026-11-15, R36-9)*: for consecutive ids `a, b` in `scheduling_order` (greedy and
  CP-SAT) equal on sort keys 1–3a and 4: `rank(a) ≤ rank(b)`, and equal rank implies `project_id(a) < project_id(b)`.
  `workflow_snapshot["categories"]` equals `ScheduleInput.categories` when non-default and is
  absent otherwise.
- **I37** *(2026-11-15, ADR 0050)*: a) keys 1–3a never decrease along `scheduling_order` (NULL
  rank last); b) live state: each band's ranks are exactly 1..n, set iff schedulable with a
  priority; c) a re-rank puts the project next to its anchor, others keep their relative order;
  d) a preview's input equals the input rebuilt from the database after confirm.
- **I31** *(rev.)*: an apply transaction:
  - (i) writes `plan_gap_weeks` and `template_change_id` only on pairs `¬never(p,S)` evaluated under
    lock, and writes `plan_weeks` only on such pairs with `¬ownEffort(p, kind(S))`;
  - (ii) every written value equals the template's new value;
  - (iii) it writes no `effort_weeks`, no progress field, and nothing on a reached pair;
  - (iv) every written pair has a `project.template_applied` row naming the apply, with before and
    after;
  - (v) automatic pairs apply whatever the selection mode.
- **I32**:
  - (i) after an apply, every pair whose length was written has `plan_weeks` = the template's new
    `weeks`;
  - (ii) for every step with `¬ownEffort(p, kind(s))`, `eff = plan_weeks` (0 for lab with
    certification off);
  - (iii) for every step with `ownEffort(p, kind(s))`, `eff = effort_weeks ?? 0`, independent of
    `plan_weeks` and of the template `weeks`.

## Per-project step exclusion *(2026-11-15, P35, ADR 0049 as ruled at P35-T03)*

A project may switch off individual applicable steps (owner OQ #81/#82/#83). The items below are
binding and are copied verbatim from the workflow-auditor ruling (MEMORY "[2026-11-13] P35-T03").
R35-1 replaces the P33 §B `eff` formula and R35-3 replaces the R2/R3 `S` definition; I26 rev. 2
replaces I26. Scheduler side: P35-T04 (`effort_split` `excluded`, I35 in the validator). Service side:
P35-T05.

**Binding items.**

- **R35-1 — effective duration.** It replaces DOMAIN_RULES P33 §B's formula. Exact text:
  ```
  eff(p,s) = 0                      if excluded(p,s)                                   # ADR 0049, first
           = 0                      if kind(s) = lab and not p.certification_testing_required
           = effort_weeks(p,s) ?? 0 if ownEffort(p, kind(s))
           = plan_weeks(p,s)        otherwise
  skipped(p,s) ⟺ eff(p,s) = 0
  ```
  Every reader in ADR 0041 R5's list takes `excluded` through the one service predicate. That covers the demand load,
  workspace, Gantt, cards, tracking, check-in, export and ask-agent context. No surface tests the flag on its own to
  derive a number.

- **R35-2 — which steps may be excluded** (replaces ADR 0049 §4's first sentence):
  ```
  inForce(p,k)    ⟺ figure_k(p) > 0 ∧ (k ≠ lab ∨ p.certification_testing_required)
                     ∧ ∃ s of kind k: effort_weight_weeks(s) > 0
  applicable(p,s) ⟺ ¬(kind(s) = lab ∧ ¬p.certification_testing_required)
                     ∧ (effort_weight_weeks(s) > 0   if inForce(p, kind(s))
                        plan_weeks(s) > 0            otherwise)
  ```
  A step may be excluded iff it is `applicable`, it is not excluded, its stored stage ∈ {Not Started, In Progress,
  Blocked}, and the project is not frozen and not Cancelled or Commercialized.
  - Otherwise: 409 `STEP_NOT_APPLICABLE` (the OQ #81 "N/A" step), 409 `STEP_DONE`, 409 `PROJECT_FROZEN` or 409
    `PROJECT_CLOSED`.
  - An applicable step the split zeroed (D, J, M of PDD/B with figure 4) **is** excludable. Without that, exclusion
    cannot be controlled (probe rows 2–3).
  - The chips show such a step as "0 wk (split)", never as N/A.
  - Re-include = clearing the flag on an excluded step. It is always allowed under the same frozen/closed rule and
    revives nothing that was not applicable.
  - "Include" on a non-excluded step is a no-op, never a revival.

- **R35-3 — R2/R3 over S′.** It replaces the R2/R3 `S` definition. Exact text:
  > `S′` = the project's steps of that kind with `effort_weight_weeks > 0` **and not excluded**. `T = Σ
  > effort_weight_weeks over S′`. R2 apportions `E` over S′. **R3:** a step of S′ whose stage status is not Not
  > Started gets `max(1, share)`. An excluded step is not in S′, gets no share and is never raised. It carries
  > `effort_weeks = null`.

  Implemented in `scheduling/effort_split` as an explicit `EffortStepInput.excluded: bool = False` (members exclude
  it), not by the caller zeroing `lead_weeks`, so R3's exemption is tested where R2 is.

- **R35-4 — no progress write.** Excluding or re-including writes only `excluded` (plus R6's `effort_weeks` and
  `schedule_stale`). No status, percent, actual week, remaining override or hold reason is written.

- **R35-5 — guards** on the project's final state after all edits of one Save, and on every other writer:
  - category change, certification toggle, figure entry, client import.
  - (a) `inForce(p,k)` ⇒ S′ non-empty. Otherwise 409 `EFFORT_NEEDS_A_STEP` naming the kind. The message tells the
    user to clear the design/lab time or keep one step.
  - (b) The project keeps at least one step with `eff > 0`. Otherwise 409 `NO_STEPS_LEFT`.
  - A rejected project writes nothing. Whether the batch is all-or-nothing is the P35-T01 contract's choice, but it
    must be stated there.

- **R35-6 — R6 trigger added.** An exclusion or re-inclusion re-derives the project's effort in the same transaction
  (`project.effort_rederived` when a share changes).
  - Audit: one `project.step_excluded` / `project.step_included` row per step, with `step_id`, the stage status at
    the time, and that kind's `eff` before and after for every step whose `eff` changed. Revived steps are thereby
    visible.
  - No financial field appears in these rows.

- **R35-7 — recalculation (OQ #83).** The Save commits first. It then sets `schedule_stale` and dispatches **one**
  greedy run for the whole Save, with the priority-move lifecycle (queued / deferred plus one coalesced follow-up /
  not_needed; I20, I24).
  - `not_needed` applies when no schedulable project's `eff` changed.
  - The run reads committed state.
  - The Save response lists, per project, the steps whose `eff` changed (before/after, flags `revived` /
    `skipped_now`), so the grid can say "D now runs 1 wk". The grid renders the served values and never re-splits in
    the browser (I9 spirit).
  - P32-R12 (an auto run replacing an active CP-SAT run, owner-blocked) also governs these runs.

- **R35-8 — gaps and applies.** See Q4. Apply writes never touch `excluded`; E2 flags `excluded_no_effect`.

- **R35-9 — builder mapping.** See Q5. It sits above OR-3's table as its first row. The R33-9 test ("no live row
  carries `lead_weeks` equal to its table value") still holds: excluded on a table-0 step → None.

- **R35-10 — locking.** Exclude/include takes the project row `FOR UPDATE` (the R33-10 lock) and evaluates
  stage status, R35-2 and R35-5 under it. A concurrent stage PATCH to Done therefore cannot race an exclusion.

- **R35-11 — lifecycle of the flag.**
  - Kept on a category change: the same workflow keeps the same activity. R35-5 re-checks.
  - Cleared on a workflow change (`sync_project_steps` re-point), with a `project.step_included` audit,
    reason `workflow_change`. A workflow change with progress is already refused, so only Not Started rows are
    affected.
  - Kept across freeze and unfreeze. A frozen project honours the exclusions set before it was frozen (they are
    durations through `lead_weeks`), and none change while frozen (I10).
  - Seed and client re-import never set `excluded` and never write progress onto an excluded step. Such a row is
    reported, not silently changed.
  - Plan import into the What-if replaces a matched project's durations from the file (ADR 0044), unchanged.

- **R35-12 — "calculated" weeks.** P35-T01's `design_weeks_calculated` / `lab_weeks_calculated` (D35-1) = Σ over
  the kind of R35-1's `eff` with the project's own figure ignored. Excluded steps add 0. "↺ reset" (figure cleared,
  OR-5) therefore returns the project to the calculated total it shows.
  - `row_calculated_weeks` must take `excluded`. Its docstring already flags the P33-T08 rewrite.
  - Naming note (non-binding): `ProjectScheduleOutcome.excluded` already means "project excluded from the run". The
    step-level wire field should not reuse the bare name on any object that also carries outcome fields
    (`step_excluded` recommended for API/Gantt payloads).

**Invariants.** I1–I32 are unchanged in text. I5's 14-row shape is kept (an excluded step is a skipped row).
I25/I29 hold through R35-1/R35-9.

- **I26 (rev. 2, restated)** — For every non-frozen project and kind k with `inForce(p,k)`:
  - the stored `effort_weeks` on S′ equal the R2 apportionment of `E = max(1, round_half_up(x))` over
    `effort_weight_weeks` on S′, raised to `max(1, ·)` on started steps of S′;
  - Σ over S′ = E + the raised count;
  - excluded steps and all other steps carry none;
  - S′ is non-empty.

  It holds in the same transaction as every R6 trigger, exclusion included. A project without a figure carries no
  derived effort.

- **I33 — exclusion is a skip, everywhere.**
  - For every live step with `excluded`: §B `eff = 0`, the service predicate says skipped, and the built run input
    has `lead_weeks = 0` (or None with table 0) and override None.
  - Every run row for it has `skipped = true` and `duration_weeks = 0`.
  - No surface derives a duration, load, weight or current step for it from anything but that predicate.

- **I34 — Done is never excluded, and exclusion never writes progress.**
  - No live step is both `excluded` and stored `Done`.
  - Between an exclude and its re-include, the step's progress fields are byte-equal to their values at exclusion.
  - Difference test: exclude then re-include with no other edit restores every step's `eff`, `effort_weeks` and
    progress fields, and the project's run-input canonical form, exactly.

- **I35 — no empty project.** Every non-excluded project in a live run input has at least one step with
  `eff > 0`. The Dashboard partition within-year + spillover + left-out + blocked + unscheduled therefore covers
  every run project with no ghost outcome (I9, I23).

- **I36 — byte-identity and the frozen guard.**
  - With no step excluded, the live input hash, every golden file, a fresh greedy run, re-serialised stored runs and
    a pre-deploy priority-preview token are byte-identical before and after the `excluded` column lands.
  - No `excluded` value changes on a frozen project (I10).
  - Every change has exactly one `project.step_excluded` / `project.step_included` audit row.


## Engineer deactivation *(2026-11-17, P38, ADR 0053 as ruled at P38-T01, R38-1..R38-9)*

Engineers are never deleted. `DELETE /engineers/{id}` is retired: it answers 410 and writes
nothing. Admin and Super Admin deactivate or reactivate an engineer. Whether a Hub Planner may too
is OQ #93; until answered, they may not.

- **State.**
  - An engineer is `active` or inactive.
  - A deactivation records:
    - the time;
    - the **calendar** week `d` from `plan_clock` (the constant until P37-T04 lands);
    - the served `plan_year`;
    - the actor;
    - a reason code (`left_company`, `changed_role`, `long_absence`, `other`; never free text).
  - While `plan_year_closed`, a deactivation is recorded at `(plan_year, 52)`.
  - Each deactivation opens one `engineer_inactive_periods` row. A reactivation in week `r`
    closes it.
- **Whole-week rule.**
  - The deactivation week counts as worked. A period covers weeks `from_week + 1 .. to_week` of its
    plan year.
  - An open period runs to 52. In later plan years a period covers 1..52; a period that began in an
    earlier year starts at 1.
  - Deactivating and reactivating in the same week covers nothing.
- **Supply** (R38-1), one helper for every reader:
  - The helper is `A_e(Y, a..b)`: the number of weeks in `a..b` of plan year Y not covered by any
    of e's periods.
  - The formulas below run per capacity hub, over engineers with `counts_in_capacity`, active or
    not:
    ```
    yearly_design_capacity    = working_weeks_per_engineer × Σ fte_e × A_e(Y, 1..52) / 52
    remaining_design_capacity = ((52 − CW) − deduction_weeks × remaining_fraction)
                                × Σ fte_e × A_e(Y, CW+1..52) / (52 − CW)            (0 when CW = 52)
    ```
  - CW is the response's calendar week.
  - FTE is summed as Decimal and the week factor as an exact Fraction. With no period, the result
    is the same float as before P38.
  - Engineer-level capacity is 0 in every covered week. Per-engineer yearly and remaining figures
    use the same helper and sum, unrounded, to the hub figure.
  - The P1 capacity fill's `C` is the served remaining figure.
  - The What-if and plan-import supply apply the same rule (`WhatIfBaseline` supply-only field,
    P38-T03).
  - `counted` and `not_counted` count active engineers only. `inactive_engineers` counts the rest,
    and the three sum to the roster.
- **Open projects at deactivation** (owner ruling 2026-11-17; R38-3, R38-5).
  - *Open* means the engineer leads it and its status is not Commercialized or Cancelled.
  - The popup lists every open project, with per-row facts: `frozen`, `progress_tracked`,
    `done_stages`, `in_flight_lab`.
  - Each row offers the eligible engineers for it:
    - the scheduler's own category predicate (`greedy._cat_not_allowed`) passes;
    - the engineer is active, FTE > 0, and in the same capacity hub;
    - the engineer is not the one being deactivated.
  - "Use one leader for all" fills the empty rows.
  - Non-frozen rows may be left empty after a "Deactivate anyway" warning. Those projects get
    `leader_engineer_id = NULL`: the existing "No leader" state, and `LEFT_OUT no_leader` on the next
    run.
  - When a cleared row is progress-tracked or has a lab test in flight, the warning adds:
    *"Their recorded stages will not show on the Gantt, and any lab test in progress gives up its
    chamber in the plan, until someone sets a leader."*
  - Leaving projects without a leader is Frigoglass's responsibility (owner). They stay findable
    through the "No leader" marker, the "No leader" filter option and the left-out lists.
  - **A frozen open project must get a leader:** a null row returns 422 `FROZEN_NEEDS_LEADER`. The
    path is to unfreeze on the Gantt first. OQ #101 confirms this with the owner.
  - Commercialized and Cancelled projects keep the inactive leader.
  - The deactivation and every reassignment or clear happen in one transaction. Each project gets
    one `project.update` audit row (`cause = "engineer_deactivated"`) and one
    `project_leader_history` row.
  - The request must name exactly the open set found under lock. Otherwise 409
    `LED_PROJECTS_CHANGED`.
  - Exactly one greedy run (`engineer_deactivated`, ADR 0023 lifecycle, I24, week read at QUEUED)
    is dispatched iff:
    - (a) a schedulable project changed leader, or
    - (b) the active run has a design row of this engineer that ends after `d`.
    Otherwise the run is `not_needed`.
  - Reactivation dispatches nothing and gives back no project.
  - **Lock order:** the engineer row first (FOR UPDATE in deactivate and reactivate, FOR SHARE in
    any leader write naming an engineer), then projects in id order. The band-rank lock comes first
    only on paths that write ranks. Busy returns 503 `ENGINEER_STATUS_BUSY`.
  - A leader change keeps the band rank (R36-3). A project cleared to NULL keeps its rank (I37b) and
    holds no capacity.
- **Scheduler input.**
  - The builder leaves inactive engineers out of `ScheduleInput.engineers`, sorted as today. So the
    scheduler, Monte Carlo, the What-if pool and plan-import auto-assignment never see them.
  - No scheduling rule changes, and greedy, CP-SAT and the validator are unchanged.
  - Stored runs are never touched (I14). A new run that attributes past Done design rows to a new
    leader is not a rewrite.
  - Whether a no-leader project should keep its anchored rows (Done history, in-flight tails) is a
    scheduler change, OQ #102. It is not in P38: today `_no_leader_outcome` emits no rows (Gate
    remediation ruling 2 exemption).
- **No new choice of an inactive engineer.**
  - No write may set an inactive leader: 422 `LEADER_INACTIVE`. This covers registration, PATCH,
    register batch, bulk edit, the deactivate targets and the user-engineer link.
  - *(R38-4)* A write that moves a project out of {Commercialized, Cancelled} while its stored
    leader is inactive must set a leader (active, or null) in the same write. Otherwise 422
    `LEADER_INACTIVE`. This covers PATCH, register batch, bulk edit, client re-import and the seed.
  - Plan import matches all names, warns `ENGINEER_INACTIVE` and auto-assigns. Its "keep matched
    leader" branch uses active engineers only.
  - Inactive engineers are absent from every leader picker, the What-if candidate lists and the
    eligibility editors. Rosters and utilization views hide them by default, with a Show filter.
  - An inactive engineer's only editable field is `name`.
- **History keeps the name.**
  - Every surface that names an engineer still names an inactive one, with an "Inactive" tag and a
    served `active` flag. The flag is withheld with the name (OQ #8 / P13).
  - History readers never filter by `active`: projects, active and stored runs, run changes, the
    audit log and exports (`Name (inactive)`).
  - The Workspace shows "Former leader" from `project_leader_history`, which gets a row for every
    leader change from P38 on (no backfill).

### Invariants (P38, exact text of ruling P38-T01)

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

## Manual step weeks *(2026-11-17, P40, ADR 0054 as ruled at P40-T02, R40-1..R40-15)*

Binding. Source: ADR 0054 "Ruling (P40-T02)". Where an earlier section ("Booking rules",
"Precedence", "How progress feeds a schedule run", "Relationship to the `frozen` flag", "Category
templates" §D, "Per-project step exclusion") disagrees with this one, this one wins for pinned steps.
ADR 0048 is unchanged: the old timing fields stay retired. A pin is a different, explicit mechanism.

- **Fields.** `ProjectWorkflowStep.manual_start_week` (`ms`) and `manual_end_week` (`me`).
  - Both are set, or neither. The end is **inclusive**; the length is `L = me − ms + 1 ≥ 1`.
  - Stored: `1 ≤ ms ≤ me ≤ 52`.
  - Written: `CW ≤ ms ≤ me ≤ 52`, where CW is the request's calendar week. Otherwise 422
    `PIN_OUT_OF_RANGE`; a partial pair or `me < ms` is 422 `PIN_INVALID`.
  - The old tool's end-exclusive pair `(s, e)` is `(s, e − 1)` here.
- **Who and where.**
  - Admin and Super Admin roles only (403 otherwise).
  - A pin may be set only on a step that:
    - belongs to a project that is not frozen (409 `PROJECT_FROZEN`) and not Cancelled or
      Commercialized (409 `PROJECT_CLOSED`);
    - has stored stage **Not Started** (409 `STEP_STARTED`);
    - is not skipped (R35-1 `eff > 0`, excluded steps included; 409 `STEP_SKIPPED`).
  - Clear is allowed on any step of a non-frozen project.
  - Typing a Start gives `End = Start + current length − 1`. Typing an End keeps the Start.
    `End < Start` is refused.
  - The server serves `current_length_weeks`, `pin_editable` and `pin_block_reason` per step. Current
    length is the active run row's window length, or the live pin's length if one is set; with no
    run row it is `ceil(eff / fte)` for a design step of a non-frozen project whose leader has a valid
    FTE (> 0, finite), `eff` otherwise. *(2026-11-17, P40-R02: FTE condition stated.)*
  - For a step with no live row, `pin_block_reason` is `STEP_STARTED` (or `PROJECT_FROZEN` on a
    frozen project). `pin_clearable` and a per-step `pin_lapsed` are also served (P40-R02); the
    browser derives neither.
- **A pin is a placement, not effort.**
  - The step occupies exactly its window. `duration_weeks` on its row stays `eff`.
  - Effort split (R2/R3/R6, I26), demand (I25), booked loads (I6/I7), roll-up weights (I12) and
    booked % do not change with pins.
  - A pinned design step books its leader in every pin week, replacing the FTE span
    (`span_fte = NULL`). A pinned lab step books 1.0 platform-week per pin week. An elapsed step books
    nothing.
  - Per-week readers spread `duration_weeks` evenly over a pinned row's window, lab rows included.
- **Which pins the scheduler applies.**
  - Non-frozen project: only on a Not Started step that is not skipped and not in a Blocked hold.
  - Frozen project: on every non-skipped step (frozen ignores progress, ADR 0006).
  - A pin on a skipped step is inert and stays stored (I33). On a started step it is ignored.
  - A write moving a stage out of Not Started (check-in, stage PATCH, the register's current step
    via `POST /projects/register-edits` (P40-R01), client re-import, seed) clears
    that step's pin in the same transaction, under the project row lock. It writes a
    `project.step_pin_cleared` audit row with `cause = "stage_started"`. From then on the progress
    rules govern.
  - A workflow re-point clears pins (`cause = "workflow_change"`).
  - None of these writers touch a pin: exclusion, category change, template apply, effort figures,
    certification, freeze/unfreeze, precedence, band rank, VIP.
- **Effective window** (run week `cw`):
  ```
  (a, b) = (ms, me)                     if frozen or ms ≥ cw
         = (cw, cw + L − 1)             otherwise ("lapsed"; outcome flag pin_lapsed)
  if b > horizon_weeks:                 the project is LEFT_OUT; the pin is not booked
  ```
- **Placement order.**
  - Frozen projects (first): pinned steps sit on their pins; unpinned steps follow the frozen rule.
  - Non-frozen projects: pins are pre-booked with the anchored steps, before any search. The pass runs
    per project in scheduling order, steps in walk order. Unpinned steps then search as today.
  - Fixed placements consume capacity regardless of conflict:
    - `ENG_CONFLICT` on every project involved, **including two fixed design placements of the same
      project** that share a week;
    - a lab step takes the first eligible chamber with room in every consumed week, else the first
      eligible chamber with `OVERLAP`;
    - no eligible chamber gives `LEFT_OUT` with `no_chamber_step_id`.
  - A `LEFT_OUT` project keeps its pre-booked pinned rows.
- **Precedence.**
  - A pinned step ignores its own gate, wait, overlap, `start_not_before_week` and the frontier.
  - It passes on `G(q) = max(end(q), release(q))`.
  - Unpinned steps use §D / ADR 0043 unchanged on that `G`. A neighbour is never moved by a pin, and
    never moves one.
  - `MANUAL_OVERLAP` (`manual_overlap` on the row and, as an OR, on the outcome) ⟺
    `a < release(s) + 1 − o(s)`, where `o(s)` is the template overlap (0 when frozen). It is a
    warning only.
- **Unconstrained finish.** Pinned steps sit on their effective windows, and `G` is as above.
- **Save.**
  - One all-or-nothing batch. It takes the project rows `FOR UPDATE` in `project_id` order and checks
    the rules above under that lock.
  - Each step whose stored pair changes gets exactly one audit row, `project.step_pinned` or
    `project.step_pin_cleared`, with before and after.
  - `schedule_stale` is set on the changed projects.
  - Then **one** greedy run follows: `trigger_reason = "step_pin"`, with the priority-move lifecycle
    (I20, I24) and the week read at QUEUED. It is `not_needed` when no schedulable project changed.
- **Freeze.**
  - Freeze and unfreeze never write a pin. Unfreezing needs Admin or Super Admin.
  - Freezing does **not** copy the plan's weeks into pins (proposed OQ). The unpinned steps of a
    frozen project are placed from `actual_start_week` as before.
- **Scheduler input.**
  - Pins are carried as `ProjectInput.step_pins` (`StepPinInput(step_id, start_week, end_week)`,
    default `()`), never in `StepTimingInput`. An empty value is omitted from the canonical/hashed
    form, and from the run snapshot.
  - **What-if** baselines carry pins.
  - **Plan import** drops the pins of a replaced matched project and lists it (`PIN_DROPPED`).
  - **Monte Carlo** never perturbs pins.
  - **CP-SAT** fixes pins through the shared pre-booking, with no precedence constraint into a pinned
    step.
- **Surfaces.**
  - Bars and flags come from the active run. Per-project design and lab weeks stay Σ
    `duration_weeks` (I9, I23).
  - The inputs show the live pin. While it differs from the run's row window, the step reads "Pin
    applies on the next run", unless the step's served `pin_lapsed` is true: a truly lapsed pin
    (R40-5) differs from its run window permanently and reads "Lapsed: placed from W{n}". Only the
    step's own `pin_lapsed` marks a step lapsed, never the project flag. *(2026-11-17, P40-R02
    re-check: aligned with ADR 0054 R40-13 as amended.)*
  - The browser derives no length, flag, domain or editability.

### Invariants (P40, exact text of ruling P40-T02)

- **I45 — pinned steps sit on their pins.** For every run, every project `p` with rows in it, and
  every step `s` with a pin `(ms, me)` in the run's input that is not skipped, not in a Blocked hold
  and (if `p` is not frozen) has input stage Not Started:
  - let `L = me − ms + 1`;
  - let `(a, b) = (ms, me)` when `p` is frozen or `ms ≥ current_week`, and
    `(current_week, current_week + L − 1)` otherwise.

  Then:
  - if `b ≤ horizon_weeks`, `s`'s row has `start_week = a`, `end_week = b`, `pinned = true` and
    `duration_weeks = eff(p,s)`. A design row books the leader and a lab row books one platform of
    one chamber in every week `a..b`;
  - if `b > horizon_weeks`, `p` is `left_out` and `s` has no row;
  - the outcome's `pin_lapsed` is true iff some such step has `(a, b) ≠ (ms, me)`;
  - no other row has `pinned = true`.
- **I46 — only people write pins.**
  - (a) No schedule run (any solver, any trigger) writes `manual_start_week` or `manual_end_week`.
    Nor do these: a week rollover, a template apply, an exclusion or inclusion, an effort
    re-derivation, a category change, freeze or unfreeze.
  - (b) A pin is set or changed only by the pin batch write: an Admin or Super Admin role; the project
    not frozen and not closed; the step Not Started and not skipped; `CW ≤ ms ≤ me ≤ 52`.
  - (c) A pin is cleared only by that write, by its stage leaving Not Started
    (`cause = "stage_started"`) or by a workflow re-point (`cause = "workflow_change"`).
  - (d) Each change of a stored pair has exactly one `project.step_pinned` /
    `project.step_pin_cleared` audit row with before and after.
  - (e) At every commit, every live step has both fields null or `1 ≤ ms ≤ me ≤ 52`, and no step
    whose stage is not Not Started carries a pin.
- **I47 — precedence around pins.** In every run:
  - (a) A pinned row `s` with start `a` has `manual_overlap = true` iff `a < release(s) + 1 − o(s)`.
    Here `release` comes from the run's own rows, `G(q) = max(end(q), release(q))` for a pinned `q`,
    and `o(s)` is the template overlap (0 in a frozen project). The outcome's `manual_overlap` is the
    OR over its rows.
  - (b) I3, I15, I27 and I28 hold for every non-pinned step, with `G` of a pinned predecessor as in
    (a).
  - (c) Greedy and CP-SAT emit identical pinned rows and identical `pin_lapsed` for the same input.
    Each evaluates `manual_overlap` on its own rows by (a).
  - (d) I1 and I2 allow a pinned placement only with `ENG_CONFLICT` / `OVERLAP` raised. That
    includes two fixed design placements of one project in the same week. For a lab step it also
    requires that no eligible chamber had room.
- **I48 — byte-identity and load neutrality.**
  - (a) With no pin in the input, these are byte-identical to before P40: every golden file, the live
    input hash, the priority-preview and band-rank tokens, the workflow snapshot, fresh greedy and
    CP-SAT output, and re-serialised stored runs.
  - (b) Two inputs that differ only in pins give, on every row present in both runs, identical
    `duration_weeks`. They also give identical I25 demand, identical I12 weights and identical
    `effort_weeks`.
  - (c) Per-week readers spread a pinned row's `duration_weeks` evenly over its window.
  - (d) No pin changes on a frozen project (I10).

## Priority band meaning *(2026-11-17, P42, ADR 0056 as ruled at P42-T01, R42-1..R42-12)*

The full ruling is in MEMORY "[2026-11-17] P42-T01". Until P42-T02/T03 land in code, today's rules
apply.

- **Labels (R42-1):**

  | Band | Label |
  |---|---|
  | P1 | Must do this year |
  | P2 | Good to have this year |
  | P3 | In queue |
  | P4 | Miscellaneous |
  | Q | Unprioritised (displayed as "Q") |

  Score bands and the P1 capacity fill are unchanged.
- **P4 / Q (R42-2, R42-3):**
  - A non-frozen P4 or Q project in a schedulable status is never scheduled, in every solver and
    path (greedy, CP-SAT, Monte Carlo, What-if, scenarios, plan import).
  - Its outcome is `not_scheduled_priority`, shown as "Not scheduled (P4)".
  - VIP does not override this, and it applies whatever the project's status.
  - A frozen P4 or Q project books its locked capacity, with `counts_toward_year = false`
    (OQ #107).
  - Status exclusion is checked first.
- **Counts toward the year (R42-4):**
  ```
  counts_toward_year(p) = NOT ( p.status ∈ SCHEDULABLE_STATUS_ORDER
                                AND ( p.priority ∈ {P4,Q} OR (p.priority = P3 AND p.status = "In Queue") ) )
  within_year = counts ∧ scheduled ∧ end+delay ≤ within_year_week
  spillover   = counts ∧ scheduled ∧ ¬within_year
  ```
  - Both flags are stored on the run's outcome rows (migration `p42a`), and surfaces read only the
    stored row.
  - A queued P3 is shown as "Queued — fits by W{n}", "Queued — after W52" or "Queued — no slot".
- **Spare capacity (R42-5):**
  - Sort key 1a (above). Frozen walks, and the anchored and pinned steps, still book first.
  - CP-SAT leaves queued projects out of the model. After the solve it books its placements and
    then walks the queued projects with the greedy single-project routine.
- **KPIs (R42-6):**
  - Bucket order: `NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED > WITHIN_YEAR > SPILLOVER > LEFT_OUT`.
  - Every within-year, spillover and left-out count and denominator uses counting rows only.
  - `queued_count` and `not_scheduled_priority_count` are served.
  - I25 remaining demand covers schedulable status ∧ (priority ∉ {P4, Q} ∨ frozen).
  - I20 compares both flags.
- **Band rank (R42-7):**
  - P4 keeps its ranks, and I37b is unchanged.
  - Board cards for queued P3 show a "Queued" badge.
- **Moves (R42-8):**
  - Into P4: "leaves the plan".
  - In Queue, P4 → P3: "joins the queue — not counted this year".
- **Invariants:** I49 (band exclusion), I50 (year basis), I51 (tier order), I52 (spare-capacity
  neutrality) and I53 (KPI basis), exact text in R42-9. I30 and I37a read "equal on keys 1, 1a, 2,
  3, 3a (, 4)". I9 follows I50.

## Hub demand cards: priority split and "need to finish" *(2026-11-18, P45, display only)*

Served on each `HubCapacityRow` (`GET /capacity/hub-load`); never a scheduler input.
- `*_demand_by_priority`: the full-year demand (I25) split by the project's live priority band
  (P1, P2, P3, P4, Queue = Q or none), summing to `*_load_weeks` via `split_to_total`.
- `*_remaining_by_priority`: the same split of the remaining demand, summing to
  `*_load_remaining_weeks`.
- `need_p1 = max(0, R(P1) − C_rem)`, `need_p1_p2 = max(0, R(P1) + R(P2) − C_rem)`, per kind, 2 dp,
  where `R` is the remaining split and `C_rem` the served `*_capacity_remaining`. Design per capacity
  hub (own + members, ADR 0042); lab per lab region, repeated on each hub of the region.
- It is an aggregate capacity figure, not the run's verdict: the run may still leave a P1 project
  out because of sequencing or eligibility, even when `need_p1 = 0`.
