# ADR 0048: Retire per-project step timing editing; the category template is the one timing tool

## Status

Accepted (2026-11-13), in full since P33-T01. §4 is as amended by R33-9: live
`duration_override_weeks` carries only the effort merge; `lead_weeks` is None when it equals the
table; I22 stays in the validator; a scenario overlap drag clears `w`. Part of P33. Supersedes the editing
parts of ADR 0019 (Gantt drag duration / earliest start) and ADR 0043 §5 (the overlap gesture), and
the P32-R02 / P32-R04b owner requests. ADR 0043's scheduler semantics stay, fed from the template
gap (ADR 0046 §4).

## Context

The owner's request of 2026-11-13: timing is shaped per category on Workflow templates (ADR 0045),
and per-project timing editing goes away. The edit surfaces today are:
- the Project Execution Timeline (`/timeline`): drag, resize, drop onto the step above, the
  "Edit timing" dialog and "Reset timing" (P32-T05, P32-R02);
- the Workflow Settings "Project step timing" tab: the same gestures on every project (P32-R04b);
- `PATCH /projects/{id}/steps/{step_id}/timing`, which writes `duration_override_weeks`,
  `start_not_before_week` and `overlap_weeks` and recalculates (`trigger_reason="step_timing"`).

Hand-set values in the data today (owner's count): 4 projects, with 2 `duration_override_weeks`, 3
`start_not_before_week` and 2 `overlap_weeks` rows.

## Decision

1. **UI: read-only.**
   - The Timeline and the "Project step timing" tab keep their step rows, tooltips and markers.
   - They lose drag, resize, drop-to-overlap, the Edit timing dialog, Reset timing and the "edited"
     marker.
   - The "parallel N wk" chip becomes a read-only gap chip from the served `gap_weeks`:
     "parallel N wk" or "wait N wk".
   - The dead code is removed: the drag overlay, the step-timing provider and dialog, the timing
     copy, and `StepDragOverlay` on the live Gantt.
   - The **What-if import Gantt** (P32-T06) keeps its own drag, because it is a scenario that is
     never persisted (ADR 0031/0044). The owner is asked to confirm (`OPEN_QUESTIONS.md` #78).

2. **API.**
   - `PATCH /projects/{id}/steps/{step_id}/timing` answers **410 Gone** with code
     `STEP_TIMING_RETIRED` for one release, then is removed. It is not kept as an internal path: the
     template apply writes per-project copies through its own service (ADR 0045), never through this
     endpoint.
   - `GET /gantt` drops `timing_editable`, `duration_override_weeks` and `start_not_before_week`, and
     replaces `overlap_weeks` with the signed `gap_weeks` (from `plan_gap_weeks`). It also serves
     `length_pinned`.
   - `trigger_reason="step_timing"` is no longer produced. Stored runs keep it (I14), and readers
     still accept it.

3. **Data.**
   - Migration `p33c` writes one audit row per affected project (`project.step_timing_cleared`,
     actor = system, before = the three fields per step, reason "ADR 0048"). It then sets the three
     fields to null on every row, sets `schedule_stale` on those projects, and adds
     `CHECK (duration_override_weeks IS NULL AND start_not_before_week IS NULL AND overlap_weeks IS
     NULL)` so nothing can write them again.
   - The two `overlap_weeks` rows are cleared, not converted into gaps (owner: "clear").
   - The columns are dropped in a follow-up release (P33-F01) after the 410 period.
   - **Recalculation.** A migration does not dispatch runs. A one-off command
     (`python -m scripts.p33_recalc_after_timing_clear`) is run once after `alembic upgrade`. It
     dispatches exactly one greedy run with `trigger_reason="timing_cleared"` and an audit row. If no
     project was affected, it does nothing. Its change list (`/schedule-runs/{run}/changes`) shows
     what moved.

4. **The scheduler keeps the fields (Proposed, ruling Q9).**
   - `StepTimingInput.duration_override_weeks`, `start_not_before_week` and `overlap_weeks` stay.
     The backend uses `duration_override_weeks` to pass the pinned / effort merge (ADR 0046 §4) and
     `overlap_weeks` to pass a negative gap. The what-if engine (ADR 0031) and the plan import
     (ADR 0044) keep using all three in scenarios.
   - I22 (`start_not_before_week`) becomes vacuous for live runs and stays enforced for what-if runs.
     Golden files are unchanged.

## Consequences

- One way to shape timing, governed by a stated rule and audited per apply. No project-specific
  tweaks remain. A project that genuinely needs its own timing needs its own category (ADR 0047).
- The 4 projects with hand-set values are re-timed by the template. The change list shows by how
  much.
- P32-R13's "rate-limit step timing" is moot for the retired endpoint. The rate limit moves to the
  apply endpoint (ADR 0045 §6).

## Alternatives rejected

- *Keep the PATCH for Super Admin only.* This leaves a second, rule-less timing path that the owner
  asked to remove.
- *Convert the hand-set values into per-project gaps.* The owner asked to clear them. Converting
  would also need a per-project gap editor, which is exactly what is being removed.
