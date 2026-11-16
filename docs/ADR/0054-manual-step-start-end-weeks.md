# ADR 0054 — Manual step Start / End weeks on the Project Execution Timeline

- **Status:** Accepted with ruling (2026-11-17, workflow-auditor, P40-T02). The ruling R40-1..R40-15
  below is binding and wins wherever it differs from the Decision text. Binding rules and
  invariants: `docs/DOMAIN_RULES.md` "Manual step weeks (ADR 0054)".
- **Supersedes in part:** ADR 0048 (per-project step timing retired). ADR 0048 stays in force for
  the old fields `duration_override_weeks`, `start_not_before_week` and `overlap_weeks`; they stay
  retired. This ADR adds a different, explicit mechanism.
- **Owner answers (2026-11-17):**
  - Q1, the editing model: "copy the logic of the old app … they don't do it only for frozen, so
    you also do the same, do for all."
  - Q2, what happens after a hand-changed End: "Leave later steps."
  - Q3, who may edit: Admin and Super Admin.

## Context

The client's old tool (`Charter.jsx`, read 2026-11-17) shows two week inputs, Start and End, on
every step row of every project. They are disabled once the project is frozen, and only an
Administrator can unfreeze. The typed weeks replace the bar at once (`act_<step>_s` / `_e`, with a
length of `e − s`). A start week greater than or equal to the end week turns both inputs red. The
owner wants the same on our Gantt, plus two behaviours of their own:
- changing Start pushes End by the step's current length;
- changing End by hand squeezes or stretches the step.

The typed dates override the scheduled ones. A frozen project keeps its dates and is not moved by
the scheduler.

## Decision (proposed)

- **M1 — fields.** `ProjectWorkflowStep.manual_start_week` and `manual_end_week`:
  - each is an int in 1..HORIZON_WEEKS, or null;
  - both are set, or neither (CHECK constraint);
  - `manual_end_week ≥ manual_start_week`;
  - the end is inclusive, as in our Gantt (the old tool's end was exclusive; the UI uses our
    convention throughout).

  A run never overwrites them.
- **M2 — editing.**
  - **Who:** Admin and Super Admin only, within their hub scope. The step must belong to a project
    that is not frozen, not Cancelled and not Commercialized, and the step must not be Completed,
    Skipped or excluded (ADR 0049).
  - **Start:** typing a Start sets End = Start + the current length − 1, where the current length
    is the shown (scheduled or manual) length.
  - **End:** typing an End keeps Start and sets the length to End − Start + 1, minimum 1 week.
  - **Invalid:** End < Start is refused, with the inputs shown red.
  - **Clear:** a "Clear" control per step returns it to the scheduler.
- **M3 — neighbours.** Only the edited step changes (owner Q2). Later and earlier steps keep their
  dates. If a pin starts before its predecessor ends, the step is not corrected: the result is
  flagged `MANUAL_OVERLAP` on the step and the project, the same way as OVERLAP / ENG CONFLICT.
- **M4 — scheduler.** A pinned step is placed exactly on its weeks, for any non-frozen project:
  - its length overrides the template length, the effort split, the FTE stretch and the gap;
  - it consumes engineer and chamber capacity in those weeks like a frozen step, and over-capacity
    is flagged (ENG_CONFLICT / OVERLAP), not resolved;
  - the unpinned steps are scheduled as today, with each successor's earliest start taken from the
    predecessor's end, pinned or not. A gap therefore follows a pinned step's end, but an unpinned
    later step is never moved earlier than a pin, nor does it move a pin.
- **M5 — frozen.** Freezing locks every step at its current weeks, manual or scheduled (I10
  unchanged). The inputs become read-only, and only Admin or Super Admin may unfreeze. Freezing
  keeps the pins.
- **M6 — save and recalc.** Edits are drafted in the Gantt and saved with one batch write. That
  write audits each changed step with before and after values, and dispatches ONE greedy run, like
  a priority move (ADR 0015) or a register Save (D35-5).
- **M7 — invariants.**
  - **New I45:** every pinned step of a non-frozen project in a run sits exactly on its
    `manual_start_week..manual_end_week`.
  - **New I46:** no run writes either field.
  - I1 and I2 allow pinned steps, which raise ENG_CONFLICT / OVERLAP the same way frozen ones do.
  - The precedence invariant allows a pinned step, with the `MANUAL_OVERLAP` flag.
- **M8 — out of scope.** The old tool's per-step "D" (delay) input is not adopted. The owner is
  asked separately.

## Consequences

- This reintroduces per-project timing in a narrower, explicit form: typed weeks, Admin only, no
  drag. Category templates (P33) still drive every step that is not pinned.
- Capacity can be overbooked by pins. Overbooking is flagged, never hidden.
- What-if and plan-import keep their own inputs. Pins enter the scheduler input as fixed
  placements.

## Ruling (P40-T02)

*Workflow-auditor, 2026-11-17.* Derived from `docs/DOMAIN_RULES.md` and checked against the code as it
is today: `backend/scheduling/greedy.py`, `types.py` and `workflow.py`, `api/routers/gantt.py` (freeze),
`services/run_step_effort.py`, `services/schedule_persistence.py`, `frontend/src/surfaces/gantt/lib/
gantt-coordinates.ts` and the old tool's `Charter.jsx` (lines 284–300, 420–660 and 1295–1330).

**Verdict: ACCEPT WITH AMENDMENTS.**
- M1, M3, M6 and M8 are accepted, with the precisions below.
- M2, M4, M5 and M7 are amended.
- Where this ruling and the Decision text disagree, the ruling wins.

### Findings that shaped the ruling

- **F1 — the old tool honours typed dates only on frozen projects.** `isManual = p.isFrozen &&
  existingStart > 0 && existingEnd > existingStart` (line 455). On an unfrozen project the auto-schedule
  overwrites the typed values; the inputs are disabled once frozen (line 1322). So the old flow is
  "type, then freeze". The owner's Q1 ("do for all") deliberately extends pins to unfrozen projects.
  That is an owner decision, so it is accepted (R40-15), and it is recorded as a divergence, not as a
  copy of the old tool.
- **F2 — our Freeze does not lock the current weeks.** `POST /projects/{id}/freeze` writes only `frozen`
  and `actual_start_week`. The frozen walk (`greedy._schedule_one_project`, `w = gate if frozen`)
  re-derives every step from `actual_start_week`, with no capacity search, no FTE stretch and no wait.
  A frozen project's bars can therefore differ from its pre-freeze plan. M5's "Freezing locks every step
  at its current weeks … (I10 unchanged)" describes the old tool, not ours. Amended in R40-10.
- **F3 — the end convention.**
  - Ours is inclusive everywhere:
    - `StepSchedule.end_week` is inclusive (`types.py`);
    - greedy books `range(w, w + span)` and emits `end = w + span − 1`;
    - the Gantt bar width is `end − start + 1` (`gantt-coordinates.ts`);
    - `plan_percent` divides by `end − start + 1`.
  - The old tool is end-exclusive: its length is `e − s`, its bar is `d = e − s` weeks wide, and its
    inputs turn red when `s ≥ e`.
  - So an old pair `(s, e)` is our `(s, e − 1)`. M1 is correct, and R40-1 fixes the arithmetic.
- **F4 — a same-project double booking is not flagged today.** `_ResourceState.book_engineer` flags a
  conflict only against *other* projects (`holders - {project_id}`). Two pinned design steps of one
  project in the same weeks would therefore break I1 silently. Fixed in R40-6.
- **F5 — successors could jump ahead of upstream work.** Under the strict chain A → B → C, with B pinned
  before A ends: if the pin passes on only its own end (`G = end`), C may start before A ends. Fixed in
  R40-7: a pin passes on `max(end, release)`.
- **F6 — per-week readers assume lab rows are never stretched.** `capacity_priority` says "Lab rows are
  never stretched and keep the elapsed count". A pinned lab row's window can differ from its effort.
  Fixed in R40-3.

### Binding items

- **R40-1 — fields, end convention, domain (M1, amended).**
  - The fields are `manual_start_week` (`ms`) and `manual_end_week` (`me`).
  - Both are set, or neither.
  - The end is **inclusive**. The pin length is `L = me − ms + 1 ≥ 1`. A one-week pin has
    `ms = me`.
  - An old-tool pair `(s, e)` maps to `(s, e − 1)`.
  - DB CHECK: both null, or `1 ≤ ms ≤ me ≤ 52`.
  - Write domain: `CW ≤ ms ≤ me ≤ 52`, where CW is the request's **calendar** week from
    `plan_clock` (I40). The cap is `WITHIN_YEAR_WEEK`, not `HORIZON_WEEKS` (amends M1):
    - no surface shows a week past W52 (`DISPLAY_HORIZON`), and the input would;
    - typing a Start that would push End past W52 is refused, not clamped.
  - Scheduler input domain: `1 ≤ start ≤ end ≤ horizon_weeks`. Anything else is a `ValueError` at
    validation. The scheduler does not check `ms ≥ CW`; R40-5 handles lapsed pins.
  - A run never writes either field (I46).
- **R40-2 — who, and which steps (M2, amended).**
  - **Who:** the Admin and Super Admin **roles** only. A Hub Planner, an Engineer or a project-grant
    Admin (ADR 0012) gets 403.
  - **Which steps:** a pin may be **set** only when every condition below holds. Otherwise the server
    returns the error shown:

    | Condition | Error if not |
    |---|---|
    | the project is not frozen | 409 `PROJECT_FROZEN` |
    | the project is not Cancelled or Commercialized | 409 `PROJECT_CLOSED` |
    | the step's stored stage is **Not Started** | 409 `STEP_STARTED` |
    | the step is not skipped (`eff > 0` under R35-1, so excluded steps included) | 409 `STEP_SKIPPED` |

    This amends M2: In Progress and Blocked steps are refused too (R40-4).
  - On Hold, Draft and the schedulable statuses may carry pins.
  - **Clear** is allowed on any step of a non-frozen project.
  - **Invalid values:**
    - a partial pair, or `me < ms` → 422 `PIN_INVALID`;
    - a value outside the write domain → 422 `PIN_OUT_OF_RANGE`.
  - **Typing semantics** are accepted as written:
    - typing a Start gives `End = Start + current length − 1`;
    - typing an End keeps the Start, and the length is `End − Start + 1 ≥ 1`;
    - `End < Start` is red and cannot be saved.
  - **Current length:**
    - the length of the active run's row window, or of the live pin if one is set;
    - for a step with no run row: `eff` stretched by the leader's FTE (`ceil(eff / fte)`) for a
      design step of a non-frozen project, otherwise `eff`.
    - The server serves it per step as `current_length_weeks`. The browser never derives it.
  - The server also serves `pin_editable` and `pin_block_reason` (one of the codes above) per step,
    so the browser re-implements no rule.
- **R40-3 — a pin is a placement, not effort (clarifies M4's "overrides … the effort split").**
  - The pin fixes the step's window. `duration_weeks` on the run row stays `eff(p,s)`, so I29 holds.
  - `effort_weeks`, R2/R3, R6 and I26 are untouched. No pin write is an R6 trigger.
  - Demand (I25), booked loads (I6/I7: Σ `duration_weeks`), roll-up weights (I12) and booked % are
    unchanged by any pin.
  - **Booking:**
    - a design step books its leader for every pin week;
    - a lab step books 1.0 platform-week per pin week (ADR 0007);
    - an elapsed step books nothing.
  - **FTE:** the pin replaces the FTE span. A pinned row stores `span_fte = NULL`.
  - **Per-week readers** (`run_step_effort.weekly_effort_for_rows`, `capacity_priority`, engineer
    utilization) spread `duration_weeks` evenly over a pinned row's window, **lab rows included**. The
    "lab rows keep the elapsed count" shortcut does not apply to pinned rows.
  - A squeezed pin therefore shows above 100 % per-week utilization. That is overbooking, shown, never
    hidden.
- **R40-4 — pins govern Not Started steps only (progress, ADR 0006, I11).**
  - **Clearing on start.** A write that moves a stage out of Not Started clears that step's pin in the
    same transaction. It writes a `project.step_pin_cleared` audit row with `cause = "stage_started"`.
    - This covers check-ins, the Workspace stage PATCH, client re-import and the seed.
    - It runs under the project row lock (R33-10 / R35-10).
  - **After the start.** The progress rules govern from then on:
    - the tail is `remaining_span`, derived from `eff`, not from the pin length;
    - `actual_start_week` stays locked;
    - a Done stage keeps its actuals (I11).
  - **Scheduler tolerance.** A pin on a started or Done step that reaches the scheduler (replay,
    What-if) is ignored for a non-frozen project.
  - **Frozen projects.** Their progress rows are ignored entirely (ADR 0006, "frozen wins"), so their
    pins apply whatever the stored stage says.
  - **Blocked hold.** A pinned step inside a Blocked hold (`held_step_ids`) is held as today: not
    placed and nothing booked. The pin stays stored.
- **R40-5 — CURRENT_WEEK and lapsed pins.**
  - Let `cw` be the run's `current_week`.
  - **Non-frozen projects:**
    - `ms ≥ cw`: the step sits exactly on `ms..me`.
    - `ms < cw` (the planned start passed without a check-in; ADR 0023, no automatic advance): the
      pin has **lapsed**. The step is fixed on `cw .. cw + L − 1`, keeping its length, and the outcome
      is flagged `pin_lapsed`.
    - Placing it in the past instead would drop not-done work out of the plan and hide lateness. It
      would contradict ADR 0052's "a Not Started step can start at CURRENT_WEEK at the earliest".
    - The weekly rollover lapses pins by itself, with no write.
    - A lapsed step's planned start is `cw`, so it stays due under R37-1.
  - **Frozen projects:** the pin is exact, even in the past. Frozen dates are not floored at CW, as
    today; I10.
  - **Past the horizon:** if the effective end exceeds `horizon_weeks`, the project is `LEFT_OUT`
    ("no feasible window before HORIZON_WEEKS"). The pin is not booked, and rows already placed or
    anchored are kept (Gate ruling 2).
- **R40-6 — where pins are placed (M4, amended).**
  - **Frozen projects (phase 2):** pinned steps sit at their pins; unpinned steps follow the existing
    frozen rule from the amended `G` (R40-7).
  - **Non-frozen projects (phase 3):** pins are pre-booked in the **same pass as the anchored steps**.
    - The pass runs per project in scheduling order, and over steps in walk order, before any search.
    - So a later-priority project's pin keeps its weeks against a higher-priority project that is not
      started. This mirrors Gate ruling 4.
  - **Capacity is consumed regardless of conflict:**
    - **Engineers:** `ENG_CONFLICT` goes on every project involved. **New:** two fixed design
      placements of the **same** project that share a week also raise `ENG_CONFLICT` (F4). That
      covers pin and pin, pin and anchored tail, and frozen pins.
    - **Lab:** the step takes the first eligible chamber (chamber-id order) with room in every
      consumed week. Only if none has room is it booked into the first eligible chamber, with
      `OVERLAP` (Gate ruling 1).
    - **No eligible chamber:** `no_chamber_step_id` and `LEFT_OUT`, exactly as for an anchored step.
  - Unpinned steps search around the pins (I1 for the leader's own other steps).
  - `no_leader` and `data_error` projects emit no rows (unchanged). A `LEFT_OUT` project still emits
    its pre-booked pinned rows (Gate ruling 2).
- **R40-7 — precedence, gaps and neighbours (M3 accepted, M4 made exact).**
  - **The pinned step itself** ignores its own `gate`, wait, overlap, `start_not_before_week` and the
    project frontier.
  - **What it passes on** to its successors: `G(q) = max(end(q), release(q))`.
    - Successors therefore still wait for every upstream step (F5).
    - With the pin ending after its predecessors, this is `end(q)`, exactly as M4 says.
  - **Unpinned steps** use the unchanged gate, wait and overlap formulas (§D, ADR 0043) on that `G`.
    - A wait counts from the release.
    - An unpinned step is never moved to sit before a pin, and never moves one.
    - An unpinned predecessor is scheduled as usual and may end after the pin starts.
  - **`MANUAL_OVERLAP`.** A pinned row with effective start `a` is flagged `manual_overlap` iff
    `a < release(s) + 1 − o(s)`.
    - `o(s)` is the step's template overlap, 0 in a frozen project.
    - A pin starting inside a wait (`w > 0`) is not flagged: the pin overrides the gap.
    - `release` comes from the run's own rows.
    - The outcome's `manual_overlap` is the OR over its steps.
    - The flag is a warning: it never blocks the run or changes `within_year`.
- **R40-8 — unconstrained finish.**
  - `unconstrained_end_week` places pinned steps at their effective windows (R40-5) and passes on `G`
    by R40-7.
  - A pin is a plan input, like the ADR 0019 floor ruling of 2026-10-10.
  - With no `target_end_week`, a pin can therefore move `expected_end_week`.
- **R40-9 — skips, exclusion and other writers.**
  - **Skipped steps.** A pin on a skipped step (`eff = 0` for any reason) is inert: I33 holds, and the
    step is emitted skipped at `G`.
  - **Exclusion.** R35-4 is unchanged: excluding a step does not clear its pin. Re-including the step
    makes the pin active again, and R40-5 covers a pin that is in the past by then.
  - **Workflow re-point.** A workflow change (`sync_project_steps` re-point) clears pins, with
    `cause = "workflow_change"` audit rows.
  - **Writers that never touch a pin:**
    - category change, template apply, effort figures and the certification toggle;
    - freeze and unfreeze;
    - precedence edits, band rank and VIP.
  - (Non-binding) The apply dialog may flag a pinned pair: "placement fixed by a pin".
- **R40-10 — frozen projects (M5, amended; F2).**
  - **Rejected wording.** "Freezing locks every step at its current weeks" is not adopted. Binding
    instead:
    - freeze and unfreeze never write or clear a pin;
    - a frozen project's pinned steps sit exactly on their pins;
    - its unpinned steps follow the existing frozen rule;
    - any pin write on a frozen project is 409 `PROJECT_FROZEN`;
    - I10 is unchanged.
  - **Unfreeze permission.** Accepted from M5 and the old tool (line 1150): only Admin and Super
    Admin may **unfreeze** (403 otherwise). Freezing keeps today's permission. This is a permission
    change for the security-auditor at P40-T04.
  - **Open question (proposed).** Should Freeze copy the active run's weeks onto every Not Started
    unpinned step as pins, which is the old tool's real behaviour? Until the owner answers: no.
- **R40-11 — save and recalculation (M6, accepted and made exact).**
  - **One batch write.**
    - Each item is `{project_id, step_template_id, manual_start_week, manual_end_week}`; both null
      means Clear.
    - The batch is **all-or-nothing**. A rejection names each failing item and writes nothing.
  - **Locking.** The write takes the project rows `FOR UPDATE` in `project_id` order (the R33-10 lock)
    and evaluates R40-2 under it.
  - **Audit.** Each step whose stored pair changes gets exactly one audit row:
    - `project.step_pinned` (set or changed) or `project.step_pin_cleared`;
    - with `before` and `after` pairs, the step id, its stage and the `cause` (`manual`);
    - no financial field.
  - An item equal to the stored pair writes nothing.
  - **Then:** `schedule_stale` is set on the changed projects, and **one** greedy run follows:
    - `trigger_reason = "step_pin"`;
    - the priority-move lifecycle: queued, or deferred plus one coalesced follow-up (I20, I24), or
      not_needed;
    - the week is read when the QUEUED row is created (R37-2);
    - greedy only;
    - P32-R12 governs replacing an active CP-SAT plan.
  - The run is `not_needed` when no schedulable project's pair changed.
  - This joins the exceptions to "Rescheduling is explicit".
- **R40-12 — scheduler input, solvers, byte-identity.**
  - **Input shape.**
    - Pins travel as a new `StepPinInput(step_id, start_week, end_week)` in
      `ProjectInput.step_pins: tuple[...] = ()`.
    - They are **not** in `StepTimingInput`. Monte Carlo perturbs that, and its old fields are the
      ADR 0048 retired ones.
    - The builder maps the live pins, sorted by `step_id`.
  - **Validation (`ValueError`):** an unknown step, a duplicate step, or a pair outside the R40-1
    scheduler domain.
  - **Hashing and snapshots.**
    - `canonical_schedule_input_asdict` drops `step_pins` when it is empty.
    - `build_workflow_snapshot_from_input` adds a `step_pins` key only when some project has a pin, so
      the run can be replayed (I14, I15).
  - **New output fields:**
    - `StepSchedule.pinned` and `StepSchedule.manual_overlap`;
    - `ProjectScheduleOutcome.manual_overlap` and `ProjectScheduleOutcome.pin_lapsed`.
    - Each defaults to `False` and is omitted from every serialised or hashed form at its default.
    - Their DB columns are `NOT NULL DEFAULT false`, with a server default.
  - **CP-SAT** takes pins through the shared pre-booking, as fixed placements.
    - It adds **no** precedence constraint *into* a pinned step.
    - A pinned step's successors are constrained from `max(end, release) + 1 (+ w)`.
    - `manual_overlap` is computed after the solve with the R40-7 formula.
    - Greedy and CP-SAT must give identical pinned rows and identical `pin_lapsed`.
    - `manual_overlap` depends on where each solver placed the predecessors, so each solver
      evaluates it on its own rows (I47).
  - **Monte Carlo** never perturbs a pin.
  - **What-if:** the baseline (`build_schedule_input_from_db`) carries pins, so the "before" equals
    the active plan.
  - **Plan import:** a matched project that the file replaces drops its pins, and the import result
    lists it (`PIN_DROPPED`). Unmatched live projects keep theirs.
  - **Byte-identity.** With **no pin anywhere in the input**, these are byte-identical before and after
    P40:
    - every golden file, the live input hash and the priority-preview and band-rank tokens;
    - fresh greedy and CP-SAT runs;
    - re-serialised stored runs and the workflow snapshot.

    With pins present, other projects may move: that is the point of a fixed placement.
- **R40-13 — reconciliation (I9, I23).**
  - Gantt bars are the active run's rows, and the flags are the run's.
  - Gantt per-project design and lab weeks stay Σ `duration_weeks` (`gantt._kind_weeks`), so they still
    equal Capacity's booked figures. Dashboard and Capacity change only through the run.
  - The inputs show the **live** pin. While it differs from the active run's row window (run queued,
    deferred or failed), the step shows "Pin applies on the next run".
  - The browser computes no length, flag, domain or editability.
- **R40-14 — invariants (M7, amended).**
  - I45–I48 are new. I1, I2, I3/I15, I21 and I22/I27 are amended.
  - Exact texts are in DOMAIN_RULES "Manual step weeks (ADR 0054)".
  - I5, I6, I7, I9, I10, I11, I12, I25, I26, I29 and I33 are unchanged in text and must hold with pins.
- **R40-15 — old-tool divergences (recorded; the oracle is retired).**
  - (a) Pins apply to unfrozen projects too (owner Q1). The old tool honours them only on frozen
    projects (F1).
  - (b) Our end is inclusive; the old tool's is exclusive (F3).
  - (c) The old tool consumed design capacity at a category weight (1.0, 0.8, 0.5 or 0.25 per week).
    We book one engineer-week or one platform-week per pinned week, and load figures stay effort
    (R40-3).
  - (d) The old tool's past steps were laid backward from the current week. Ours keep their progress
    actuals.
  - (e) The per-step "D" delay is not adopted (M8 accepted; asked separately).

### Proposed owner questions (the orchestrator numbers them)

1. Should End be editable on a step that has started? It would have to write
   `remaining_weeks_override`, which is effort; under FTE < 1 the mapping from a week is not exact.
   Until answered: no (R40-4).
2. Should Freeze copy the active run's weeks onto every Not Started unpinned step as pins? Until
   answered: no (R40-10).
3. Should pins be allowed past W52 (into the next plan year)? Until answered: no (R40-1).

### Not measured

There is no pin code yet. P40-T03 acceptance includes:
- the byte-identity proof (R40-12);
- an audited run on a disposable copy of the dev DB with pins of every kind: on time, lapsed, frozen,
  overlapping, squeezed below the FTE span, behind a Blocked hold, on an excluded step;
- I45–I48 holding on that run, with greedy and CP-SAT diffed.
