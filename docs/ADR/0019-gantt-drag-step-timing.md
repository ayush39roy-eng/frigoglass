# ADR 0019: Gantt drag sets a per-project step duration and an earliest start

## Status

Accepted (2026-10-10). Part of P12. **Changes the scheduler input** (`backend/scheduling/`, owned by
algorithm-engineer) and adds invariants I21 and I22.

## Context

Frigoglass asked (relayed 2026-10-10): "change the time of the 14 work steps by moving the Gantt
chart … we can decrease or increase it, change the timing by dragging it".

Until now a step's duration came only from the shared lead-time table:
`lead_time[workflow][category][step]` (ADR 0007). Every project of the same workflow and category
got the same durations, and no single project's step could be lengthened, shortened or pushed
later. Start weeks are scheduler output (the serial SGS places each step at the earliest feasible
window), so a dragged start cannot simply be written into `planned_start_week`: the next run would
overwrite it.

## Decision

Two new nullable fields on `ProjectWorkflowStep`. Both are planner inputs that a schedule run never
overwrites, like the ADR 0006 progress fields.

| Field | Domain | Meaning |
|---|---|---|
| `duration_override_weeks` | int `1..104` or null | This project's duration for this step. Null means the lead-time table applies. |
| `start_not_before_week` | int `1..HORIZON_WEEKS` or null | The step may not start before this week. Null means no floor. |

1. **Effective duration.** `duration = duration_override_weeks ?? lead_time[...]`. It is used
   everywhere the lead-time duration was used: booking, the derived remaining duration (ADR 0006),
   capacity load (I6/I7), progress roll-up weights (I12) and the unconstrained/expected finish. A
   lead-time table edit never clears an override.
2. **Earliest start.** For a `Not Started` step the scheduler's search floor becomes
   `max(CURRENT_WEEK, predecessors' end + 1, start_not_before_week)`. Precedence and capacity still
   apply, so the bar may land later than where it was dropped, never earlier.
3. **Gantt gestures.**
   - Dragging the right edge sets `duration_override_weeks`.
   - Dragging the bar body sets `start_not_before_week` to the drop week.
   - Snapping is to whole weeks.
   - "Reset timing" clears both fields.
4. **What can be dragged.**
   - `Done` steps: never (I11, history).
   - `In Progress` and `Blocked` steps: resize only. The actual start is fixed.
   - Skipped steps (lead time 0, not drawn): nothing, so a skipped step cannot be revived by drag.
   - Steps of a `frozen` project: nothing (409 `PROJECT_FROZEN`).
   - Steps of a project with a non-schedulable status: nothing (409 `NOT_SCHEDULABLE`).
5. **A drag recalculates automatically**, the same lifecycle as a priority move (ADR 0015):
   `queued` / `deferred` / `not_needed` / `unchanged`, greedy only, a new immutable run (I14), then
   the "Timeline updated" panel. This widens ADR 0006's "explicit only" rule to cover step timing
   as well as priority. A drag is direct manipulation, and the user expects to see the result. OQ #29
   asks the client to confirm.
6. **Permission:** the same as the Gantt freeze toggle: `GANTT` write, hub-scoped (Hub Planner own
   hub, Admin, Super Admin). Audit action: `project.step_timing`, with before and after values.

## New invariants

- **I21:** For every scheduled step that is not skipped, not `Done` and not frozen, the booked span
  equals the effective duration. For an `In Progress` step the booked tail equals the derived
  remaining duration computed from the effective duration.
- **I22:** Every `Not Started` step with `start_not_before_week` set starts at or after that week
  in the run.

## Consequences

- The solver input hash changes for any project with an override, so determinism (I8) still holds.
  The run's `input_snapshot` records both fields per step, so a run can be replayed.
- `StepSchedule.duration_weeks` now means the *effective* duration, not the table duration.
  Capacity reconciliation (I6/I7) uses the same value on both sides.
- CP-SAT honours both fields too (same model, two extra bounds), so the solver comparison stays
  meaningful.
