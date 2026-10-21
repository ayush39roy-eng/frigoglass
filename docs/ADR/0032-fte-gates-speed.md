# ADR 0032: FTE gates scheduling speed (0.5 FTE = half speed)

## Status

Accepted (2026-10-21). Part of P20. **Supersedes ADR 0002** ("FTE does not gate scheduling
throughput in v1"). Answers `docs/OPEN_QUESTIONS.md` #2. Closes known defect #1 in
`docs/DOMAIN_RULES.md`. Amends invariant I21 (ADR 0019) and states I6 explicitly as effort.
Changes the scheduler (`backend/scheduling/`, algorithm-engineer).

## Context

Owner ruling, 2026-10-21 (final): **"0.5 FTE represents half speed."** A design step led by an
engineer with FTE `f` takes `duration / f` elapsed weeks. Example: 4 weeks at 0.5 FTE is 8 weeks.
The engineer still does one step at a time.

Until today the scheduler booked every engineer at full speed whatever their FTE (ADR 0002), while
the Capacity surface counted supply as `working_weeks × Σ fte` (ADR 0008). The two disagreed: a
0.63 FTE leader could be booked for 36 straight full-speed weeks (workflow-auditor, SC-650 audit,
2026-10-21, finding 4). OQ #2 offered two readings ("half speed" or "half the available weeks");
the owner chose half speed.

## Decision

### 1. The rule

A **design** step of a **non-frozen** project whose leader has FTE `f` books

```
span = ceil(duration_weeks / f)        consecutive weeks of the leader
```

`duration_weeks` is the step's effective duration (ADR 0019: `duration_override_weeks ?? lead
time`). It is an **effort** figure and it is unchanged. `span` is the **elapsed** figure. The
leader is busy for every week of the span, so I1 (one design step per engineer per week) and
same-leader serialisation work on spans: a 0.5 FTE leader with two 4-week steps is busy W1–W8 and
W9–W16.

### 2. Rounding: `ceil`, per step, in exact decimal arithmetic

- The model is integer weeks. A fractional span is rounded **up**: `4 / 0.63 = 6.35 → 7`.
- This follows the existing convention. The derived remaining duration is already
  `ceil(duration × (1 − pct / 100))` (DOMAIN_RULES "Derived remaining duration"). The lead-time
  table has no `round()` or `max(1, …)` (ADR 0007). Rounding down would book fewer weeks than the
  leader needs. `round()` would do that for half of all cases.
- Rounding is **per step**, because each step is its own integer interval. A project's total
  span can therefore exceed `ceil(Σ effort / f)`. Example: PDD/B design 1+1+4+1+2+1 = 10 effort
  weeks at 0.8 FTE spans 2+2+5+2+3+2 = 16, not 13.
- `ceil` is evaluated on the FTE's decimal value. `Engineer.fte` is `Numeric(3, 2)`, and the
  scheduler uses `Fraction(str(fte))`. Binary-float division would give `21 / 0.7 =
  30.000000000000004 → 31`; the scheduler gives 30. Pure, deterministic (I8).
- FTE above 1.0 is not capped. The same formula applies (`4 / 1.25 → 4`). The schema only requires
  `fte > 0`, and the seed has none above 1.0.

### 3. Which steps

Workflow kinds (ADR 0007): `design` books the leader; `lab` books a chamber; `elapsed` books
nothing; a step is `skipped` when its duration is 0 (or a lab step with certification testing off).

| Kind | Stretched? |
|---|---|
| `design` | Yes, by the **project leader's** FTE (the only engineer a design step books). |
| `lab` | No. Chambers have no FTE; booking stays `max_concurrent`-gated (ADR 0003/0008). |
| `elapsed` | No. Elapsed steps book no resource (Business Case, CAPEX, Pilot, Commercialization). |
| `skipped` | No. Zero weeks. |

Checked against both templates: PDD design = A B D E I J K M; OEM design = A B D G I J K M.
Lab = PDD F H / OEM E H. Elapsed = PDD C G L N / OEM C F L N.

### 4. FTE 0, a bad FTE, or no leader

- **Unassigned or unresolvable leader:** unchanged. The project is `LEFT_OUT` with
  `no_leader = true`. Nothing is stretched or divided.
- **FTE ≤ 0, NaN or infinite** on a non-frozen project that still has design work to place (any
  non-skipped design step that is Not Started, or In Progress / Blocked with remaining > 0): the
  project is rejected through the existing **`data_error`** mechanism. It has no rows, consumes no
  capacity, all completion weeks are null (ruling 9), and the message names the leader id and the
  steps. Nothing is divided: the check comes first. If no design work is left (all design steps
  Done or skipped), the FTE is irrelevant and the project schedules normally. A frozen project is
  never stretched (§5), so its leader's FTE never causes an error.
- Why `data_error` and not `LEFT_OUT`: `LEFT_OUT` means "no window before the horizon", which is a
  capacity outcome. A zero-speed leader is a data fault for the planner to fix (set FTE, or
  reassign the leader). The API and DB already refuse FTE 0 (`schemas/engineer.py`, `gt=0`), so in
  practice it can only come from a direct DB edit or a migration.

### 5. Frozen projects, Done steps, In Progress and Blocked steps

- **Frozen projects are not stretched.** Their dates are locked at `actual_start_week` (I10,
  "frozen wins", ADR 0006). Stretching them would move every frozen project's later steps once,
  at the first run under this ADR. Their capacity load is unchanged. Frozen is deprecated (ADR
  0006).
- **Done steps** keep their recorded `[actual_start_week, actual_end_week]` (I11). There is no
  stretch.
- **In Progress / Blocked steps.** `actual_start_week` stays locked. The *remaining work* is
  stretched by the same rule:
  ```
  remaining      = override ?? ceil(duration × (1 − pct / 100))    # effort, as before
  tail_span      = ceil(remaining / f)                              # design only
  tail           = [max(CURRENT_WEEK, actual_start, pred_end + 1) .. + tail_span)
  ```
  `remaining_weeks_override` is read as **remaining effort**, like the derived value it replaces,
  so a planner's "2 weeks left" becomes 4 elapsed weeks at 0.5 FTE. `remaining == 0` still books
  nothing.
- `start_not_before_week` (ADR 0019) is unchanged. It floors the start; the span follows from it.

### 6. Load and capacity reporting: load stays effort

Supply already counts effort: `capacity = working_weeks × Σ fte` (ADR 0008). A 0.5 FTE engineer
supplies about 26 effort-weeks a year. Load must therefore also count **effort weeks**, the
un-stretched `duration_weeks`, never elapsed weeks. Then `booked % = load / capacity` stays
comparable: a 0.5 FTE leader busy for every elapsed week of the year shows about 100 %, not 200 %.

- `StepSchedule.duration_weeks` (and `ScheduleRunProjectStep.duration_weeks`) stays the effort.
  The row's `start_week..end_week` is the elapsed span.
- I6 (design load) and I7 (lab load) are unchanged in formula. I6 now states that it sums effort.
- Progress roll-up weights (I12) are effort. They are unchanged.

Every load sum, checked (2026-10-21):

| Where | What it sums | Status |
|---|---|---|
| `scheduling.invariants.compute_design_load_by_hub` / `_lab_` (I6/I7) | `duration_weeks` | Correct (effort) |
| `GET /capacity/hub-load` design / lab load, by-priority split | `duration_weeks` | Correct |
| `GET /planning/resource-load` engineer / chamber load | `duration_weeks` | Correct |
| Gantt per-project design / lab / total weeks (`gantt.py`) | `duration_weeks` | Correct |
| What-if engine `_utilization` (run I6/I7), `_plan_loads`, leader balance | `duration_weeks` / plan effort | Correct |
| `GET /capacity/engineer-utilization` `total_booked` | `duration_weeks` | Total correct |
| `GET /capacity/engineer-utilization` per-week cells | 1.0 per week over `[start, start + duration − 1]` | **Needs backend-builder change** (below) |
| `services/workspace.stage_overrun` (health badge "At Risk") | planned end = `start + duration − 1` | **Needs backend-builder change** (below) |

Follow-ups outside `backend/scheduling/`:

1. **Engineer utilization weekly cells** (`api/routers/capacity.py::engineer_utilization`). Today
   it puts 1.0 booked week on each of the first `duration_weeks` weeks of the bar, and 0 on the
   rest of a stretched bar. Spread the effort evenly over the row's elapsed weeks instead:
   `duration_weeks / (end_week − start_week + 1)` per week over `[start_week, end_week]`.
   Then each week reads about `fte` against a weekly capacity of `wwpe × fte / 52`. The total
   stays `duration_weeks` (I6 reconciliation unchanged). In Progress rows start at
   `actual_start_week`, so use the booked tail for them, as the validator does.
2. **Stage overrun / health badge** (`services/workspace.stage_overrun`). The planned end is now
   `start + ceil(duration / fte) − 1` for a design step of a non-frozen project. Without this,
   every sub-1.0 FTE project shows "At Risk". Use the FTE in the run's input snapshot and
   `scheduling.fte_span`, or compare against the run's own `end_week` for Not Started rows.
3. **Gantt drag (ADR 0019)** (frontend Gantt + `services/step_timing`). The right-edge drag
   computes the new `duration_override_weeks` from the bar's elapsed width. The override is an
   effort figure, so at 0.5 FTE a 2-week drag would save +2 effort = +4 elapsed weeks. Convert
   elapsed to effort (for example, serve the leader FTE or the step's span on the Gantt row, and
   send `max(1, floor(elapsed × fte))`). Also label the tooltip "4 wk effort, 8 wk at 0.5 FTE".
4. **Copy that cites ADR 0002**, which now says the opposite of the system:
   `frontend/.../capacity/components/capacity-reporting-notice.tsx`,
   `frontend/.../planning/components/engineer-form.tsx`, `planning/api/types.ts`,
   `components/ui/card-info.tsx`, and backend docstrings in `api/routers/capacity.py`,
   `schemas/capacity.py`, `models/engineer.py`, `models/hub.py`.

### 7. Priority order, Gantt bars, completion lines

- **Scheduling order** is unchanged (frozen, priority, status, category, id). A slower leader makes
  their own projects later. It never reorders projects.
- **Same-leader serialisation** is unchanged in kind (one step at a time) but works on elapsed
  spans. A sub-1.0 FTE leader's queue is longer by `1/f`.
- **Gantt step bars** show elapsed weeks (`start_week..end_week` from the run), so a 4-week step at
  0.5 FTE draws 8 weeks. The step's served `duration_weeks` is still 4 (effort).
- **`unconstrained_end_week`** walks the DAG with spans. "Unlimited engineers" removes contention,
  not the leader's own speed. So `unconstrained ≤ constrained` still holds (I16), and
  `expected_end_week` (when no target is set) is a finish the leader can reach.
- **What-if** (ADR 0031): added designers carry their FTE into the run. `simulate` runs the real
  greedy, so spans follow. A designer with FTE ≤ 0 is never picked as a leader. "Unattainable"
  (OQ #47) is judged at the fastest designer's speed: the larger of the solver's added-designer
  FTE and the best FTE among the hub's designers. The target therefore never depends on which
  designer the leader balance picked. Load figures are effort (§6), so estimate == simulate ==
  Capacity still holds.

### 8. Invariants

- **I21 (amended):** every scheduled step that is not skipped, not Done and not in a frozen project
  carries its effective duration (effort) as `duration_weeks`. It books `ceil(duration / f)` weeks
  if it is a design step (leader FTE `f`), else `duration` weeks. An In Progress / Blocked tail
  books `ceil(remaining / f)` (design) or `remaining`.
- **I6:** stated explicitly as effort weeks (formula unchanged).
- I1, I3, I10, I11, I16 are unchanged in wording. They now hold over spans.

## Consequences

- Plans get later wherever leaders are below 1.0 FTE. On the seeded `client_2026` plan at W42
  (disposable DB, P20-T01), the Dashboard within-year figure goes from **107 to 67**. 40 projects
  move from within-year to spillover and 27 from spillover to left-out. P1 within-year drops from
  11 to 6, and P1 left-out rises from 2 to 8. Every P1 change is a PD-India / R&D-India project
  led at FTE 0.62–0.63. The seed's FTEs were *tuned* so that load ≈ capacity (ADR 0024,
  `client_2026.tune_fte`). They are not a real roster, so this exaggerates the effect. The real
  roster decides the real impact.
- Design load (I6) can fall a little after a re-run. This is not because effort changed. More
  projects go `LEFT_OUT`, and a left-out project carries only the rows it managed to book (P2-T01
  resolution).
- The first run after deployment moves every non-frozen project led below 1.0 FTE. Frozen
  projects, Done steps and actual starts do not move (I10, I11).
- Golden files: no existing scheduling fixture pinned a non-1.0 FTE outcome (every hand fixture
  is at 1.0; the seed-based selftests assert invariants, not weeks), so none needed new expected
  values. `tests/scheduling/test_p20_fte_speed.py` adds the FTE golden cases.
- ADR 0002 is superseded. The ORACLE_DIVERGENCE "INTENTIONAL (matched-to-current)" classification
  of FTE no longer applies. The oracle was retired at P2 close, so this needs no oracle entry.

## Follow-up status (2026-10-21, P20-T02, backend-builder)

§6 follow-ups 1, 2 and 4 (backend part) are done. Follow-up 3 has its backend half:

1. **Engineer utilization weekly cells.** `GET /capacity/engineer-utilization` spreads each design
   row's effort evenly over its stored `[start_week, end_week]`. An In Progress / Blocked row puts
   its remaining effort (`derive_remaining`, capped at the tail's length) on the booked tail
   `[max(current_week, pred_end + 1, start) .. end]` and the done effort on the weeks before it
   (`services.run_step_effort`). `total_booked` is Σ `duration_weeks`, as before. The Priority
   board's remaining design weeks (`services.capacity_priority.remaining_run_load_by_project`)
   counted elapsed weeks too; they now count effort through the same helper.
2. **Stage overrun / health badge.** A Not Started stage's planned end is the run's own stored
   `end_week`. Any other stage's planned end is `start + planned_span_weeks(duration, fte) − 1`,
   for a design row of a non-frozen project (`services.workspace.stage_overrun`, `row_span_fte`).
   `fte` is the run's stored `span_fte` (item 3). Rows from older runs fall back to the assigned
   engineer's current FTE.
3. **Gantt drag (backend half).** The new `GanttStepRow.span_fte: float | null` field is the leader
   FTE the active run used to stretch the step. Migration `p20a_run_step_span_fte` adds
   `ScheduleRunProjectStep.span_fte`, which `persist_schedule_output` copies from the run's own
   input. It is null for lab, elapsed, skipped and Done steps, frozen projects, steps with no
   leader, and rows of runs persisted before the migration. Part-time status is personal data
   (OQ #8), so the field is served only to a caller who may edit step timing on that project:
   GANTT/WRITE with the project's hub in scope, the same check `PATCH .../timing` applies.
   Everyone else gets null. The frontend mirror and the drag conversion are P20-T03. Until the
   mirror lands, the `GanttStepRow` contract row is temporarily "subset".
4. **Backend docstrings** that cited ADR 0002 now cite this ADR.

Also tightened: the engineer create/update `fte` is now `0.01 ≤ fte ≤ 9.99`, with NaN and
infinity refused. `Numeric(3, 2)` would store 0.004 as 0.00, and FTE 0 is now a scheduler
`data_error`.

### Follow-up: `span_fte` withholding is not confidentiality (2026-10-21, P19-R01, S19-I1)

The security gate of P19 + P20 recorded (S19-I1, Info) that serving `GanttStepRow.span_fte` only to
callers who may edit step timing (item 3 above) does not fully hide part-time status. Every Gantt
reader (Executive Viewer, Portfolio Manager, an Engineer on own assignments) still gets
`start_week`, `end_week` and `duration_weeks` of each design step, and
`end − start + 1 = ceil(duration / fte)`, so calendar span ÷ work weeks reveals the leader's
approximate FTE. Withholding `span_fte` is defence in depth only. This is an **accepted owner risk
under ADR 0028** (per-engineer data is an owner residual risk until the DPO answers OQ #8), not a
block. If the DPO rules that part-time status must be hidden from non-planners, the Gantt must also
stop serving the calendar span or the work weeks of design steps to those roles. Recorded in OQ #8.
