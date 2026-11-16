# ADR 0052: The current week follows the calendar

## Status

**Accepted with changes (2026-11-17, P37-T02).**

- **Workflow-auditor ruling.** "Ruling (P37-T01)", at the end of this ADR, is binding. Its items
  R37-1..R37-10 and its invariant texts override §1–§9 where they differ. §4–§7 below have been
  edited to match.
- **Owner answers (2026-11-17)** to OQ #88–#92, in the owner's words: "no problem, now we don't need
  to show dummy data, so make the week follow". Every assumption is accepted:
  - #88: stay at W52, marked closed, until an Admin opens 2027;
  - #89: the Monday greedy rollover may replace a CP-SAT plan;
  - #90: week-42 check-in stamps stay as they are;
  - #91: "N wks left" excludes the current week;
  - #92: the drop is accepted, and the release is not gated on it.
- Originally: Proposed (2026-11-16, P37).

Amends ADR 0024 §3 ("`CURRENT_WEEK = 42`"), which said "Moving it to a value derived from the
calendar is a future decision". This ADR makes that decision. It also amends ADR 0006 ("Rescheduling
is explicit") by adding a fourth automatic recalculation, the weekly rollover, next to the priority
move (ADR 0015), the check-in (ADR 0023) and the register Save (ADR 0049 R35-7). Contract:
`docs/API_CONTRACT_P37.md`. DOMAIN_RULES "Horizon constants" (2026-11-16 amendment).

## Context

Owner, 2026-11-16: the header reads "Week 42 · 10 wks left · 16 Nov 2026". 16 Nov 2026 is ISO week
47. The week never moves because `backend/domain_constants.py` reads it once, at import time:

```python
CURRENT_WEEK: Final[int] = int(os.environ.get("RPD_CURRENT_WEEK", "42"))
```

The frontend has its own build-time copy (`frontend/src/lib/domain-constants.ts` `CURRENT_WEEK = 42`,
`PLAN_YEAR = 2026`). The P32 gate had already flagged it (workflow finding F9). The owner wants the
week to follow the calendar.

What already exists:

- The scheduler takes the week as an input: `ScheduleInput.current_week`. Its default is
  `dc.CURRENT_WEEK`, bound at import.
- Every `ScheduleRun` stores the week it was solved at (`schedule_runs.current_week`).
- Several readers that interpret a stored run already use `run.current_week`: project cards,
  workspace, ask-agent, capacity priority, run step effort.
- Every other reader uses `dc.CURRENT_WEEK` directly, or through a default argument bound at import.
  The Appendix lists them.

ISO facts for 2026 (Europe/Athens):

- W42 = 12–18 Oct.
- W47 = 16–22 Nov (today).
- W52 = 21–27 Dec.
- 2026 has 53 ISO weeks: **W53 = Mon 28 Dec 2026 – Sun 3 Jan 2027**.
- 2027-W01 starts Mon 4 Jan 2027.

The plan-week coordinate system (ADR 0035 §11, OQ #85, `plan-week-date.ts`) is 2026 W1–W52, then
2027 W1–W26 = 53–78. It already maps a 2026-W53 date to 52.

## Decision

1. **One clock.** A backend service, `services/plan_clock.py`, is the only source of "today". Its
   function `plan_clock.now()` returns a `PlanClock` with these fields:
   - `as_of_date`: the Athens calendar date;
   - `iso_year` and `iso_week`;
   - `week`: the plan week;
   - `plan_year`;
   - `plan_year_closed`;
   - `source`: `"calendar"` or `"pinned"`;
   - `week_ends_at`: the next Monday 00:00 Europe/Athens, as an aware datetime.

   Rules for using it:
   - **Time zone:** Europe/Athens for every hub, India included. Monday 00:00 Athens is 03:30 IST.
   - **When it is read:** once per request, through a FastAPI dependency, and once per solve
     dispatch. It is never read at import time. No function parameter may default to it, because a
     default value is bound at import.
   - **Tests:** the service takes an injectable `now` for tests.
   - **`dc.CURRENT_WEEK` is removed as a runtime value.** No code reads it after P37-T04. A grep
     test enforces this.
2. **Plan week from the date.** `plan_year` = env `RPD_PLAN_YEAR`, default 2026. It is served, and
   the frontend constant goes.
   - If the ISO year equals `plan_year`: `week = min(iso_week, 52)`. W53 (28 Dec – 3 Jan) is
     clamped to 52, as ADR 0035 §11 already does for end dates.
   - If the ISO year is later than `plan_year`: `week = 52` and `plan_year_closed = true`. This
     holds until the owner rules on the year rollover (OQ #88). Nothing re-bases stored weeks
     automatically.
   - If the ISO year is earlier than `plan_year`: `week = 1`. This is not expected in production.
3. **Pin.** `RPD_CURRENT_WEEK` stays as an explicit override (`source = "pinned"`). Both test suites
   pin it to 31, so the golden files are unchanged; demos may pin it too.
   - It is validated at startup to the integer range 1..52. Anything else stops the app with a
     clear message. Today a bad value is an unhandled `int()` error.
   - A pin never expires. Pinned stacks therefore see at most one rollover run, when the pin value
     changes.
4. **Two readings of "the week", one rule.**
   - **Calendar week** (`plan_clock.now().week`) is used for:
     - (a) recording facts: the check-in stamp `actual_start_week` / `actual_end_week`,
       `stage_checkins.week`, tracking `live` / `due` / `overdue`, and plan-based "per plan" %.
       *(R37-1)* A Not Started stage is due when its active-run planned start is `≤` the calendar
       week, and it has been due since that planned start;
     - (b) every new solve: live recalculations, What-if, plan import, Monte Carlo and the
       unconstrained finish inside them;
     - (c) run-independent figures: the remaining capacity supply (ADR 0008) and the remaining
       demand (I25), which I19 pairs, plus the Capacity `remaining_weeks` label that sits beside
       them;
     - (d) every "now" marker: the header, the Gantt "today" line, the heatmap's current column and
       the What-if import axis.
   - **Run week** (`schedule_runs.current_week`) is used for interpreting a stored run: overrun and
     overdue-against-plan on the Workspace and project cards, effort from the current week in the
     capacity priority split, run step effort and ask-agent context. A stored run is never
     re-evaluated against a different week (I13, I14).
   - *(R37-2)* **A run's week is read once, when its row is created.** That is the `QUEUED` row
     (`create_queued_schedule_run`, the follow-up included) or the request of a synchronous solve.
     The worker builds the input with `current_week=run.current_week`; it never re-reads the clock
     at execution.
   - **Capacity `remaining_weeks`** moves from the run week to the calendar week. Today it is the
     run week, while the remaining capacity beside it is computed at `dc.CURRENT_WEEK`. They agree
     only because both are 42.
5. **Weekly rollover recalculation.** When the calendar week moves past the active run's week, the
   plan is out of date: Not Started steps sit in weeks that have passed, and "remaining" figures no
   longer match. One idempotent service function, `ensure_week_rollover()`, brings it up to date.
   - **Callers:**
     - a Celery beat entry: Mondays 00:05 Europe/Athens, plus every 15 minutes as a safety net;
     - an in-app lifespan ticker: every 5 minutes, with jitter.

     Both are needed because the hosted and local dev stacks run greedy inline with no beat
     (P32-R01). Several Gunicorn workers may tick; the dispatch advisory lock serialises them.
   - **Decision, under the dispatch advisory lock:**
     - `not_needed` when there is **no active run** (R37-7), or the active run's week **==** the
       calendar week, or an in-flight run's stored week **==** the calendar week (R37-6: equality,
       never "<", so a lowered pin is handled too). The rollover also answers `not_needed` while
       `plan_year_closed`.
     - `deferred` when a run at another week is in flight. This registers the ADR 0023 coalesced
       follow-up, which is dispatched later and so reads the new week.
     - `queued` otherwise: a greedy run with `activate=True`, `trigger_reason="week_rollover"`,
       `triggered_by_user_id = null` (system). It writes audit row `schedule.week_rollover` with the
       from-week and to-week.
   - **No project flag.** It never sets per-project `schedule_stale`. No project input changed;
     plan-level staleness is derived as `active_run.current_week ≠ calendar week`.
   - *(R37-8)* **State decides on every tick.** The decision is recomputed each time from the active
     run's week, the in-flight runs and the follow-up flag. A durable `plan_week_rollovers` row per
     `(plan_year, week)` only counts the dispatched (`queued`) attempts and their run ids, so
     `not_needed` and `deferred` are not terminal for the week.
     - A failed attempt is a queued run that ends `FAILED`, `DISPATCH_FAILED` or `ABANDONED` while
       the active run's week still differs.
     - At most 3 attempts per week, at least 30 minutes apart. After that the status is `failed`,
       the notice offers the existing manual Recalculate, and nothing loops.
     - A follow-up registered by `deferred` is governed by I24, not by this budget.
     - The rollover never dispatches CP-SAT.
   - *(R37-9)* **Settings.** A setting turns the ticker off (`RPD_WEEK_ROLLOVER_TICKER`, default
     on, `false` in both conftests, because `TestClient` runs the lifespan). The beat schedule is
     evaluated in Europe/Athens. The 15-minute entry is the guarantee; the Monday 00:05 entry is an
     optimisation.
   - **Active CP-SAT run (owner, OQ #89 (a)):** greedy replaces it, like every other automatic
     trigger. A CP-SAT plan therefore lives at most until the next Monday.
6. **What the user sees while the plan is behind.** The header always shows the calendar week, the
   weeks left and the served Athens date: "Week 47 · 5 wks left · 16 Nov 2026". It never shows the
   browser's date beside the server's week.
   - When the active run's week differs from the calendar week, the header shows a chip: "Plan from
     W42 · recalculating…" (queued or running), or "Plan from W42 · recalculation failed" with
     Recalculate for roles that may run it.
   - The Gantt, Dashboard, Capacity, Workspace and *(R37-3)* check-in page show the same one-line
     notice.
   - *(R37-3)* The What-if and plan-import results say "Simulated from W47; the active plan is from
     W42" whenever their input week differs from the active run's week.
   - *(R37-4)* `GET /schedule-runs/{run}/changes` serves `baseline_week` and `run_week`. When they
     differ, the UI labels the list "includes the move from W*a* to W*b*". I20 is unchanged.
   - Verdicts stay the active run's (I9).
   - The browser refetches `/me` at the served `week_ends_at` and on window focus. It never derives
     the week from its own clock.
7. **The seed keeps its own status week.** The client seed derives progress "as of" a week
   (`seed/client_2026.py`). That derivation week becomes a named constant, `SEED_STATUS_WEEK = 42`,
   independent of the calendar. Reseeding in December therefore does not invent more progress.
   - The owner confirmed (ADR 0041) that the client has no newer status than "April".
   - *(R37-5)* `SEED_STATUS_WEEK` drives only the progress derivation. The seed's summary run and
     its persisted first run both use the calendar week, and the summary prints that week.
7a. *(R37-10, owner OQ #88 (a))* **Closed year.** While `plan_year_closed`, `POST /check-ins`
   answers 409 `PLAN_YEAR_CLOSED`. Reads stay available, and no rollover run is dispatched. The
   year stays closed until an Admin opens 2027, which is a separate ADR and phase (P37-F01).
8. **Unchanged.**
   - `WITHIN_YEAR_WEEK = 52`, `DISPLAY_HORIZON = 52` and `HORIZON_WEEKS = 78`. The horizon is
     absolute and ends at 2027-W26.
   - "Weeks left" = `52 − week`, so the current week is not counted. This keeps ADR 0008's
     `remaining_fraction` basis (OQ #91).
   - The within-year rule.
   - ADR 0023's "no automatic stage advance": a missing check-in never moves a stage.
   - Stored runs, and stored check-in rows already stamped 42 (owner, OQ #90 (a): left as they
     are; planners may correct actual dates on the register).
9. **Preview tokens.** The input hash and the priority-preview token (ADR 0026) include
   `current_week`. A preview opened before Monday 00:00 and confirmed after it is answered 409, and
   the user re-previews. This is correct behaviour and needs no special case.

## Effects the owner should expect (stated plainly)

These come from the rules, not from tuning. P37-T07 measures them on a copy of the dev DB, and they
are reported, not tuned.

- **Within-year falls and spillover grows.** At W42 a Not Started step could start at W42, which
  left 10 weeks before W52. At W47 the earliest start is W47, which leaves 5 weeks after the current
  one (6 weeks of placement, W47–W52). Projects whose remaining work does not fit become spillover.
  Any step placed in W42–W46 in the old plan moves to W47 or later.
- **No progress is assumed for the five weeks.** In-Progress tails keep their remaining weeks and
  restart at W47, because no stage advances without a report (ADR 0023).
  - Every project seeded "In Progress at W42" therefore finishes 5 weeks later than the W42 plan
    said, unless check-ins have been recorded.
  - The seeded status is the client's April status (ADR 0041). The gap between that status and
    today grows every week until real check-ins arrive.
- **LEFT_OUT grows.** The search ends at W78. A Not Started step longer than 78 − 47 = 31 weeks can
  no longer be placed (at W42 the limit was 36). Late in December the limit is 26 weeks.
- **Check-in tracking jumps.**
  - Check-ins have been stamped week 42 since 19 Oct, because of the fixed constant.
  - On the first request at W47, every due stage with no check-in in W47 or W46 is `overdue`. That
    is all of them.
  - The "per plan" % moves forward five weeks.
- **One recalculation each Monday.** The change list (`/schedule-runs/{run}/changes`) of that run
  shows every finish-week move caused by the week passing, labelled `week_rollover`.
- **From 28 Dec 2026 to 3 Jan 2027** (ISO W53) the week stays 52, and the year is not yet closed.
  From 4 Jan 2027 the app shows "Planning year 2026 closed", stays at W52 and refuses check-ins
  until an Admin opens 2027 (OQ #88 (a), P37-F01).
- **Measured at P37-T01** (dev DB copy, reported not tuned): within-year falls from 135 to 114 at
  W47 (77 at W52). Spillover rises from 63 to 82 and left out from 74 to 76, and 144 of 145
  projected finishes move +5. The owner accepted the drop on 2026-11-17 (OQ #92): "now we don't
  need to show dummy data".

## Consequences

- Every surface agrees on one served week, and the browser stops carrying its own copy (closes P32
  workflow finding F9).
- **Determinism (I8) holds.** The week is an explicit, hashed solver input, and two solves at the
  same week on the same input are byte-identical. A solve on Monday differs from one on Sunday,
  because its input does.
- **ADR 0006 gains a fourth exception.** The automatic rollover run has no user actor; its audit
  row carries the system actor.
- The year rollover to 2027 needs its own decision and phase (OQ #88). Stored plan weeks, check-ins,
  actual weeks and runs are all in 2026-based coordinates.

## Questions for the workflow-auditor (P37-T01)

- **Q1.** Is the calendar-week / run-week split in §4 complete, and does every reader in the
  Appendix fall on the right side? In particular: tracking "due" compares the calendar week with the
  active run's planned windows. While the plan is behind, a window can lie entirely in the past.
- **Q2.** Should I13 and I19 be restated under the two readings, given that the remaining demand
  and the remaining capacity both use the calendar week, and the booked load uses the run?
- **Q3.** Is the rollover's `not_needed` / `deferred` / `queued` rule in §5 sound against ADR 0023
  coalescing (I24)? Is it correct that it never sets per-project `schedule_stale`?
- **Q4.** Check the W53 clamp and the `plan_year_closed` clamp for consequences in the
  unconstrained finish, anchored tails (Gate ruling 10) and `Done` intervals with
  `actual_end_week > week`.
- **Q5.** Confirm the new invariants I38–I41 (DOMAIN_RULES "Horizon constants", 2026-11-16) or
  amend them with exact text.

## Appendix: readers of `CURRENT_WEEK` (inventory at HEAD 6d3c760; the working tree is mid-merge)

**Backend, reading `dc.CURRENT_WEEK` directly. All move to the calendar week through the
dependency:**

- `api/routers/me.py:91-92` (`current_week`, `weeks_left_in_year`);
- `api/routers/checkins.py:176, 230, 232, 378` (stamp and due week);
- `api/routers/capacity.py:194, 875` (supply), `:414` (`remaining_weeks`, today the run week, moves
  to the calendar week), `:957` (heatmap `current_week`, today the run week, becomes the calendar
  week for the "now" column, plus `run_week`);
- `api/routers/planning.py:153, 399` (supply), `:536` (run week, kept, plus the calendar week);
- `api/routers/engineers.py:144`;
- `api/routers/chambers.py:117`;
- `api/routers/workflow_settings.py:282`;
- `services/priority_capacity_fill.py:154`;
- `services/whatif_chat.py:173, 368`.

**Backend, default arguments bound at import. Make the argument required:**

- `services/capacity_supply.py:76, 181, 211`;
- `services/tracking.py:76, 123, 144, 184, 236`;
- `services/schedule_persistence.py:234, 733` (the run input week: the calendar week at dispatch);
- `scheduling/types.py:492` (`ScheduleInput.current_week`, owned by the algorithm-engineer).

**Backend, run week with a fallback to the constant. The fallback (no active run) becomes the
calendar week:**

- `services/project_cards.py:136`;
- `services/workspace.py:909`;
- `services/ask_agent.py:221`;
- `api/routers/capacity.py:414, 957`;
- `api/routers/planning.py:536`.

**Backend, already run-week only (unchanged):**

- `services/capacity_priority.py:161-163`;
- `services/run_step_effort.py:191`.

**Seed:** `seed/seed_demo_data.py:751` and `seed/client_2026.py` use `SEED_STATUS_WEEK` (§7).
`models/schedule.py:77` keeps the column; its `default=31` is never relied on, and the builder
always sets the value.

**Scheduler (`backend/scheduling/`):** greedy, CP-SAT, workflow (`first_step_frontier`,
`unconstrained_end_week`), invariants, What-if, plan import and Monte Carlo already read
`ScheduleInput.current_week`. The only change is that the field no longer has an import-time
default.

**Frontend (`frontend/src`):**

- `lib/domain-constants.ts` `CURRENT_WEEK`, `PLAN_YEAR` (+ `SPILLOVER_YEAR`, `CARRY_OVER_YEAR`)
  → served `/me` fields, with the constants kept only in test fixtures;
- `components/layout/app-header.tsx` (`WeekPill`: the constant fallback and the browser `new
  Date()` date);
- `surfaces/gantt/components/gantt-time-axis.tsx:55, 118, 165` (today line);
- `surfaces/planning/whatif/import/gantt-geometry.ts`, `.../step-timing-dialog.tsx`,
  `.../results-gantt.tsx`;
- `surfaces/capacity/components/engineer-utilization-heatmap.tsx`, `hub-booking-strip.tsx`,
  `capacity-toolbar.tsx`;
- `surfaces/dashboard/lib/upcoming-completions.ts`, `.../executive/upcoming-completions-card.tsx`;
- `surfaces/project-workspace/components/completion-strip.tsx`;
- `surfaces/planning/components/overview/planning-toolbar.tsx`;
- `surfaces/projects/lib/plan-week-date.ts` (date ↔ plan week for inputs; reads the served
  `plan_year`).

**Added at P37-T02 from the ruling (binding):**

- *Backend callers of the input builders that rely on the import-bound default (R37-2):*
  - `workers/schedule_tasks.py:382`;
  - `api/routers/schedule_runs.py:373`;
  - `services/priority_preview.py:250, 269`;
  - `services/whatif_baseline.py:103`;
  - the follow-up `create_queued_schedule_run` in `services/run_dispatch.py`;
  - `seed/seed_demo_data.py:905, 975`.
- *Frontend week readers (R37-3):* `gantt-legend.tsx:81`, `gantt-coordinates.ts:124`.
- *Frontend year readers (R37-3):* `plan-month.ts`, `format.ts:118`, and every `SPILLOVER_YEAR` /
  `CARRY_OVER_YEAR` label (`project-outcome-chips`, `schedule-outcome-meta`,
  `completion-profile-card`, `executive-charts`, `pipeline-row`, `schedule-run-provenance`,
  `within-year-panel`, `gantt-bars`, `gantt-chart`, `gantt-step-row`, `GanttPage`). These derive
  from the served `plan_year`.
- *Added 2026-11-17 (P38-T02, ADR 0053 R38-7):* P38's engineer deactivate and reactivate
  endpoints stamp `deactivated_week`, `deactivated_plan_year` and the `engineer_inactive_periods`
  weeks. All three are calendar weeks from `plan_clock`. P38's `A_e` supply helper uses the
  response's calendar week. If P38-T04 lands first, these read the constant, and P37-T04 swaps
  them over.

## Ruling (P37-T01, workflow-auditor, 2026-11-16)

**Verdict: ACCEPT WITH AMENDMENTS.** Q1–Q5 are all accepted with amendments. The binding items are
R37-1 to R37-10 below. The ADR becomes Accepted when P37-T02 folds them in. All references were
checked against the code at 6d3c760 (clean worktree) and in the main working tree. A measurement was
run on a disposable copy of the dev DB (see "Measured effect").

### Q1: the calendar-week / run-week split, and the Appendix: ACCEPT WITH AMENDMENT

The split in §4 is right, and every reader in the Appendix is on the correct side. I checked the
following against the code:

- Health badge and overrun (`workspace.py:350`, `ask_agent.py:221`, `project_cards.py:136`) take
  the run week.
- Due stages (`project_cards` → `due_stages_for`) take the calendar week.
- Capacity priority split and run step effort stay on the run week.
- Supply, `remaining_weeks` and P1 fill go to the calendar week. They are run-independent. The P1
  fill is a suggestion only and never feeds the solver.

What-if needs no change. `simulate` and the capacity-change "before" re-solve the baseline at the
input week, so both sides of a What-if use the same week. Priority preview needs no change either:
the in-memory base and the "after" side are both built at the request's week.

The amendments:

- **R37-1: tracking "due" while the plan is behind.**
  - **Current rule.** A Not Started stage is due when the active run's window *contains* the week.
  - **The problem.** While the plan is behind, a Not Started stage planned in W43–W46 drops off the
    check-in list at W47, so missed work becomes invisible.
  - **New text** for DOMAIN_RULES "Weekly check-in", Due stage: "…either `status ∈ {In Progress,
    Blocked}` or the active run's planned start for the stage is `≤ CURRENT_WEEK` (calendar week)."
  - **Due since** for such a stage is its planned start.
  - **Why it reduces exactly to today's rule** whenever the active run's week equals the calendar
    week (and so under every pin):
    - every Not Started step of a non-frozen project starts at or after the run's week;
    - frozen projects are never due;
    - so "start ≤ week" is the same as "start = week", which is the same as "window contains week".
  - `plan_percent` stays as defined. It reads 100 for a window that is wholly in the past, which is
    the truthful "per plan".
- **R37-2: the run's week is fixed when the run row is created, and the worker uses it.**
  - **Today.** `create_queued_schedule_run` stores the default week. The worker then builds the
    input at *execution* (`workers/schedule_tasks.py:382`, `build_schedule_input_from_db(db)`), and
    `persist_schedule_output` overwrites `run.current_week` from that input (`:589`).
  - **The problem.** A run queued on Sunday 23:59 and executed on Monday stores a different week
    than the one the rollover decision saw. A queued CP-SAT run can wait for minutes.
  - **Ruling.**
    - `create_queued_schedule_run` reads `plan_clock` once and stores the week.
    - The worker calls `build_schedule_input_from_db(db, current_week=run.current_week)`.
    - The synchronous paths (`schedule_runs.py:373` greedy-recalc, `priority_preview.py:250/269`,
      `whatif_baseline.py:103`, `seed_demo_data.py:975`) read the clock once per request.
  - **Callers to add to the Appendix.** These callers of the two builders rely on the import-bound
    default today: `workers/schedule_tasks.py:382`, `api/routers/schedule_runs.py:373`,
    `services/priority_preview.py:250, 269`, `services/whatif_baseline.py:103`,
    `services/run_dispatch.py` (follow-up `create_queued_schedule_run`) and
    `seed/seed_demo_data.py:905, 975`.
- **R37-3: a notice wherever the two weeks meet in one view.**
  - **Today.** §6 lists Gantt, Dashboard, Capacity and Workspace. The header chip is global and
    covers every page.
  - **Added to the explicit notices:**
    - the **check-in page**. It stamps at the calendar week against run windows.
    - the **What-if / plan import results**: "Simulated from W47; the active plan is from W42"
      whenever the input week differs from the active run's week. Their "before" is a re-solve at
      W47, not the Dashboard's run.
  - **Frontend readers to add to the Appendix:**
    - the week: `gantt-legend.tsx:81` ("Week N — now") and `gantt-coordinates.ts:124`;
    - the year: `plan-month.ts`, `format.ts:118`, and every `SPILLOVER_YEAR` / `CARRY_OVER_YEAR`
      label (`project-outcome-chips`, `schedule-outcome-meta`, `completion-profile-card`,
      `executive-charts`, `pipeline-row`, `schedule-run-provenance`, `within-year-panel`,
      `gantt-bars`, `gantt-chart`, `gantt-step-row`, `GanttPage`). These derive from the served
      `plan_year`.
- **R37-4: the change list says when the week moved.**
  - **The problem.** The first automatic run of a new week may be a check-in or priority-move run,
    not the rollover. Its `/schedule-runs/{run}/changes` then mixes the week effect into that
    trigger.
  - **Ruling.** Add `baseline_week` and `run_week` to the changes response. The UI labels the list
    "includes the move from W*a* to W*b*" when they differ. I20 is unchanged: rows still equal the
    stored-field difference.
- **R37-5: the seed's summary run uses the calendar week.**
  - **The problem.** The seed's in-memory summary run (`seed_demo_data.py:905`) currently uses the
    derivation week. Its log would then report W42 figures while the persisted first run and the
    Dashboard are at the calendar week.
  - **Ruling.** `SEED_STATUS_WEEK` drives only the progress derivation (`client_2026`). Both the
    summary run and the persisted run use the calendar week, and the summary prints that week.

### Q2: restate I13 and I19: ACCEPT WITH AMENDMENT (exact text)

- **I13 (replacement text):** "The Project Workspace health badge for a project is a pure function
  of that project's stored outcome in the active `ScheduleRun` (finish week, per-stage overrun,
  `left_out`, `blocked`). Every week comparison it makes (overrun, overdue against plan) uses that
  run's stored `current_week`, never the calendar week. No independent recomputation anywhere;
  mirrors I9."
- **I19 (appended sentence):** "The remaining capacity, and the `remaining_weeks` served beside it,
  are evaluated at the response's calendar week (I40). Remaining demand (I25) does not depend on the
  week. Neither depends on the active run, so the remaining pair is never mixed with a run's week."
- **I9 (appended sentence):** "While the active run's week differs from the calendar week, the count
  is still the active run's, and the surface shows the run's week (ADR 0052 §6)."

### Q3: the rollover decision rule vs ADR 0023 (I24), and per-project stale: ACCEPT WITH AMENDMENT

The lifecycle is sound. All of it happens under the dispatch advisory lock; the deferred path goes
through `find_in_flight_run(request_follow_up=True)`; and the follow-up is re-dispatched by the run
end and by the sweeper. Never setting per-project `schedule_stale` is correct: no project input
changed, and the stale state belongs to the plan (`active.current_week ≠ calendar week`).

- **R37-6: compare with "≠", not "<".**
  - **The problem.** With "<", lowering a pin (for example a demo pinned at 31 against a DB whose
    active run is at W47) gives `not_needed`. The header then says W31 beside a W47 plan with no
    notice. That contradicts §3 ("a rollover run when the pin value changes").
  - **Ruling.** Wherever the rule compares the active run's or an in-flight run's week with the
    calendar week, it uses equality.
    - `not_needed` when the active run's week == calendar week, or when an in-flight run's stored
      week == calendar week.
    - `plan_week.status = current ⇔ run_week == current_week`.
  - Under the real calendar the week never goes down, so calendar behaviour is identical.
- **R37-7: the "no schedulable project" clause is replaced by "no active run".**
  - **The problem.** With "no schedulable project → `not_needed`", the status stays `pending`
    forever.
  - **Ruling.** `not_needed` when there is **no active run**; `plan_week` is then null. If an active
    run exists and no project is schedulable, the rollover runs anyway. Greedy on an empty
    schedulable set is cheap, and it brings the active week up to date.
- **R37-8: only the state decides; the `plan_week_rollovers` row only counts attempts.**
  - **Decisions are recomputed on every tick from state:** the active run's week, in-flight runs and
    the follow-up flag.
  - **What the row holds.** The `plan_week_rollovers` row records only **dispatched (`queued`)
    attempts** and their run ids.
  - **`not_needed` and `deferred` are not terminal for the week.** An example: an in-flight run at
    the new week that does not activate (an admin CP-SAT dispatch) gives `not_needed`, and the next
    tick queues once it ends.
  - **What counts as a failed attempt:** a queued run that ends `FAILED`, including `DISPATCH_FAILED`
    and `ABANDONED`, while the active run's week still differs.
  - **Limits.** At most 3 attempts per `(plan_year, week)`, at least 30 minutes apart, after which
    the status is `failed`.
  - **Follow-ups.** A follow-up registered by `deferred` is governed by I24, not by this budget.
  - **Never CP-SAT.** The rollover never dispatches CP-SAT. The non-negotiable "CP-SAT never in the
    FastAPI process" holds, because the lifespan ticker can only dispatch greedy.
- **R37-9: the ticker is off in test suites and beat runs on the Athens clock.**
  - **The problem.** FastAPI `TestClient` runs the lifespan, so a ticker would dispatch runs inside
    tests whose fixtures create active runs at weeks other than 31. That would break the "pin
    reduces to today" property.
  - **Ruling.**
    - A setting (for example `RPD_WEEK_ROLLOVER_TICKER`, default on, `false` in both conftests)
      turns off the ticker. `ensure_week_rollover()` is tested directly.
    - The beat crontab is evaluated in Europe/Athens (Celery `timezone` or a tz-aware schedule). The
      15-minute entry is the real guarantee; the Monday 00:05 entry is only an optimisation.
- **I24 (appended):** "A coalesced follow-up's input week is the calendar week read when its row is
  created (R37-2)."
- **P32-R12 / OQ #89.** Assumption (a), greedy replaces an active CP-SAT run, is consistent with
  every other automatic trigger. Note that a CP-SAT plan now lives at most until the next Monday.
  If the owner answers (c), the decision gains a branch: when the active run is CP-SAT, answer
  `not_needed` with a new status `held`. That needs a contract change, which T02 should note as
  conditional.

### Q4: the W53 clamp and the closed-year clamp: ACCEPT WITH AMENDMENT

The clamps are coherent with HORIZON_WEEKS = 78 and the within-year rule:

- **ISO week-year decides.** 1–3 Jan 2027 is ISO 2026-W53, so → 52 and **not** closed. This matches
  `plan-week-date.ts`.
- **Unconstrained finish.** `max(week, actual_start_week)` needs no special case at 52.
- **Anchored tails (Gate ruling 10).** These already include `actual_start_week`, so an actual start
  entered on the register in 2027 (53+, OQ #85) keeps its recorded start.
- **Done intervals with `actual_end_week > week`.** These book capacity from the current week
  (unchanged rule). They arise only from register dates, never from check-ins.
- **W53.** One extra calendar week shares plan week 52. There is no rollover run, and a W52 check-in
  keeps the project `live` through W53. This is accepted and documented.

The amendment:

- **R37-10: refuse check-ins while the year is closed.** While `plan_year_closed`, `POST /check-ins`
  answers 409 `PLAN_YEAR_CLOSED`; reads stay available. Otherwise every January check-in would be
  stamped 52, repeating the OQ #90 defect. This makes assumption (a) honest, and it is one more
  reason OQ #88 must be answered before 28 Dec. No rollover run is dispatched while the year is
  closed: the week stays 52, so the rule gives `not_needed`.

### Q5: invariants I38–I41: ACCEPT WITH AMENDMENT (exact text)

- **I38 — one week per solve.** "Every `ScheduleRun` stores `current_week` equal to its input's
  `current_week`. That value is the calendar week (or the pin), read once when the run row is created
  (the `QUEUED` row, or the request of a synchronous solve), and the solver input is built with the
  row's week. It is never a value bound at import. Every row and outcome of the run is computed at
  that week. Re-reading a stored run uses its stored week."
- **I39 — one rollover per week.** "For each calendar week `w`, while an active run exists whose
  week ≠ `w` and the planning year is not closed:
  - the system dispatches at most one `week_rollover` run per attempt, and at most 3 attempts at
    least 30 minutes apart; or it registers one coalesced follow-up when a run at another week is in
    flight;
  - after a dispatched or follow-up run completes, the active run's week is `w`;
  - concurrent or repeated ticks create no further run;
  - a pinned week that does not change creates none;
  - the rollover never dispatches CP-SAT and never sets per-project `schedule_stale`."
- **I40 — one served week.** "Within one response, every field derived from 'today' uses the same
  calendar week. `GET /me.current_week` equals it and `weeks_left_in_year = 52 − current_week`.
  Every view that shows run-derived values beside a 'now' value shows the run's week when it differs
  ('Plan from W*n*'). The frontend holds no week or plan-year constant outside test fixtures and
  never derives the week or the date from the browser clock."
- **I41 — week domain.** "`1 ≤ CURRENT_WEEK ≤ 52` always. The ISO week-year (not the calendar
  year) decides: an ISO W53 date maps to 52, and a date in a later ISO week-year than `plan_year`
  maps to 52 with `plan_year_closed`. Stored plan weeks are never re-based by the clock."

### Pin reduction (asked by the orchestrator): holds, with two conditions

With `RPD_CURRENT_WEEK` pinned, every reader reduces to today's behaviour. This holds because:

- R37-1 reduces exactly to the current rule;
- `remaining_weeks` uses the calendar week, which equals the run week whenever the active run is at
  the pin;
- the rollover answers `not_needed`.

The two conditions:

- **(i) Run weeks match the pin.** No stored active run may be at a week other than the pin. If one
  is, R37-6 dispatches one run and the notice shows; that is intended.
- **(ii) No new input field.** `ScheduleInput.current_week` loses its default without adding a new
  field to `canonical_schedule_input_asdict`. Use a keyword-only field or a sentinel that validation
  rejects. Then the input hashes, golden files (suites pin 31) and stored runs (I14) stay
  byte-identical.

The P37-T04/T05 migration only adds `plan_week_rollovers` and touches no run row.

### Measured effect (dev DB copy, 2026-11-16; reported, not tuned)

**Method.**

- **The copy.** `pg_dump rpd | psql rpd_p37t01_copy` in `rpd-pg-dev`, at
  `p33c_clear_step_timing`: 330 projects, active run v13 (greedy, `timing_cleared`, W42). The copy
  was dropped afterwards; `rpd` was not written.
- **The code.** Code at 6d3c760 ran `build_schedule_input_from_db(current_week=w)` and then
  `run_greedy_sgs`, in memory only.
- **Checks.** Each solve was repeated and was byte-identical (I8). The W42 re-solve equals stored
  run v13 project by project: 0 differences, which reconciles I9 and I14.
- **Buckets.** These are the Dashboard's: within-year = `within_year AND NOT blocked`, with the 51
  Commercialized projects counted in it (ADR 0030); the other columns are left out and spillover.
  Blocked was 0 in every solve.

| Hub | W42 within / spill / left out | W47 within / spill / left out | W52 within / spill / left out |
|---|---|---|---|
| PD-India | 88 / 34 / 63 | 78 / 42 / 65 | 59 / 60 / 66 |
| PD-Romania | 20 / 6 / 2 | 16 / 10 / 2 | 14 / 11 / 3 |
| R&D-India | 7 / 17 / 6 | 2 / 22 / 6 | 0 / 22 / 8 |
| R&D-Greece | 3 / 0 / 3 | 3 / 0 / 3 | 1 / 2 / 3 |
| OEM-HCK | 8 / 3 / 0 | 6 / 5 / 0 | 1 / 9 / 1 |
| OEM-Seitek | 9 / 3 / 0 | 9 / 3 / 0 | 2 / 9 / 1 |
| **All** | **135 / 63 / 74** | **114 / 82 / 76** | **77 / 113 / 82** |

- **W42 → W47.**
  - Within-year falls by 21. Without the 51 Commercialized projects, the scheduled within-year count
    goes 84 → 63.
  - Spillover rises by 19 and left out by 2.
  - Transitions: 21 within → spillover and 2 spillover → left out. Nothing improved its bucket.
- **Finish weeks.**
  - **144 of 145** projects with a projected finish move exactly +5 weeks.
  - **1** (a PD-India spillover project) moves −5 (77 → 72). Its PDD-K slot was freed because a
    higher-ranked project (scheduling position 21) became LEFT_OUT. This is a normal serial-SGS
    knock-on, not a defect.
  - Done history (W37–W41) is identical at both weeks (I11).
- **Why the shift is a uniform +5.** The plan is saturated from the current week, and the 51 In
  Progress steps get no credit without check-ins. So the shift is almost exactly the week delta.
  Without check-ins, every later Monday repeats it, at +1 per week.
- **W52.** The late-December lower bound under assumption (a) is 77 / 113 / 82.
- **Check-ins.** The dev DB has **0** `stage_checkins` rows, so the OQ #90 count and the "overdue
  jump" are 0 here. With no check-ins, every due stage was already overdue at W42. P37-T07 must
  measure these on the client's data, where check-ins exist.

## Owner answers and fold-in (P37-T02, orchestrator, 2026-11-17)

The owner answered OQ #88–#92 on 2026-11-17: "no problem, now we don't need to show dummy data, so
make the week follow". Every recommended assumption is therefore accepted:

- **#88 (a).** The week holds at 52 through ISO W53. From 4 Jan 2027 it is flagged
  `plan_year_closed` (R37-10 applies) until an Admin opens 2027. Opening 2027 needs its own ADR and
  phase: P37-F01, which must be planned before 28 Dec 2026.
- **#89 (a).** The Monday greedy rollover may replace an active CP-SAT plan. The conditional `held`
  branch in the ruling's Q3 note is **not** adopted, and the contract carries no `held` status.
- **#90 (a).** Check-in rows stamped 42 stay as they are; planners may correct actual dates on the
  register.
- **#91.** "N wks left" = `52 − week`, so the current week is excluded.
- **#92.** The drop (135 → 114 within-year at W47) is accepted. The owner no longer needs the demo
  figures, so the P37 release is **not** gated on P37-T07's figures; T07 is still a gate input.

Folded into DOMAIN_RULES ("The current week follows the calendar", the Due stage under "Weekly
check-in", and invariants I9, I13, I19, I24 and I38–I41), `docs/API_CONTRACT_P37.md` and the P37
plan rows.
