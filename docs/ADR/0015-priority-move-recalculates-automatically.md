# ADR 0015: Moving a project's priority recalculates the timeline automatically

## Status

Accepted (2026-10-09). Part of P11. Narrows ADR 0006's "rescheduling is explicit" rule: priority
changes are now the one exception. Progress edits and Workflow Settings edits are unchanged.

## Context

Frigoglass asked (relayed by the project owner, 2026-10-09): "P1 to P2 can be moved and it decide
timeline automatically". Today a priority change is possible, but only through the Registration
form's `PATCH /projects/{id}`. That marks the project `schedule_stale` and stops there. The user
then has to find "Recalculate schedule" on the Project Workspace, and nothing shows which *other*
projects moved as a result. Priority is the second key of the scheduling sort (DOMAIN_RULES
"Scheduling order"). Moving one project from P1 to P2 changes which projects get the shared
engineers and chambers first. The knock-on effect on other projects is the thing the client wants
to see.

## Decision

### 1. A priority change dispatches a greedy recalculation

Changing `Project.priority` to a different value, through `POST /projects/{id}/priority` (new) or
through `PATCH /projects/{id}` (existing), does the following in one transaction:

1. writes the new priority;
2. writes an audit row (`project.priority_move`, before/after priority);
3. sets `schedule_stale` as today.

Then, if the project's status is schedulable, it dispatches the **greedy** scheduler. It uses the
same Celery lifecycle as the Workspace "Recalculate schedule" (`run_greedy_schedule`,
`activate=True`, `trigger_reason="priority_move"`). The completed run becomes the active schedule.
It is a new immutable `ScheduleRun` (I14).

- **CP-SAT is not used.** OQ #10 still blocks CP-SAT behind any user-facing action.
- **A run is already queued or running.** The priority is saved and stays stale. No second run is
  started. The response says `deferred`, and the user recalculates when the first run finishes.
  This avoids two runs racing to become active.
- **Non-schedulable status** (Draft, On Hold, Commercialized, Cancelled). The priority is saved. No
  run is started, because the project is not in the plan. The response says `not_needed`.
- **Same priority as before.** No-op, no audit row, no run. The response says `unchanged`.
- **Frozen projects.** Allowed. A frozen project's own dates never move (I10). The run still
  executes because ordering can change for others, but frozen projects are scheduled first
  regardless of priority, so a frozen project's move usually changes nothing.

### 2. Hard gates pin P1

A project whose `PriorityScore.hard_gates` is non-empty cannot leave P1 (DOMAIN_RULES "Hard
gates"). Both paths return 409 `HARD_GATE_FORCES_P1`. The PATCH path had no such check before.
This closes that gap.

### 3. Permission is unchanged

Moving priority needs exactly what changing it through the Registration form needs today:
`PROJECT_REGISTRATION` WRITE, hub-scoped, or an Admin-level project grant (ADR 0012). The recalc
that follows is a consequence of the write, not a separate permission. A Hub Planner could
already change priority and then press Recalculate. This removes the second step and does not
widen anyone's power.

### 4. What moved: a run-to-run change list

`POST /projects/{id}/priority` returns the `baseline_run_id`, which is the run that was active
before the move, together with the new `schedule_run_id`. After the run completes,
`GET /schedule-runs/{run_id}/changes?against={baseline_run_id}` lists every project whose stored
outcome differs between the two runs. The compared fields are `projected_end_week`,
`within_year`, `left_out` and `blocked`. The list is hub-scoped like every other read. Both runs
are immutable (I14), so the list never changes after the fact. The browser shows these rows. It
never diffs the runs itself.

`PATCH /projects/{id}` keeps its `ProjectRead` body. When a priority change dispatched a run, the
run id comes back in the response headers instead: `X-Schedule-Run-Id`, `X-Schedule-Baseline-Run-Id`
and `X-Schedule-Recalc`. This follows the existing `X-Schedule-Stale-Count` pattern on Workflow
Settings.

## Consequences

- One click on the Gantt or the Workspace moves a project and shows the new timeline, plus a short
  "these other projects moved" list.
- A Hub Planner's move can shift projects in another hub when the two hubs share a lab region. For
  example, PD-India and R&D-India share the India chambers. That was already true through PATCH plus
  Recalculate. The change list makes it visible, but hub scoping still hides the other hub's rows
  from a hub-scoped user. The list shows a count of hidden rows instead.
- Greedy at the full 236-project scale has not been re-profiled since P3. It runs in the worker,
  not the API process, so a slow run delays the timeline but never blocks requests.
- The Registration form's Priority field now triggers a recalculation when it changes. The form
  says so next to the field.
- Should other edits (status, category, leader) also auto-recalculate? Open as
  `docs/OPEN_QUESTIONS.md` #24. Until answered they stay "stale until Recalculate".
