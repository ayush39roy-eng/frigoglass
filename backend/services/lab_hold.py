"""Lab hold weeks on the service side (P62-T04; ADR 0071 R62-0 / R62-10, I64,
I66; `docs/API_CONTRACT_P62.md` §5 / §6).

The rules live in `backend/scheduling/` (`booked_hold_weeks`, `hold_window`,
`row_lab_load_weeks`, `is_partial_room`, ...). This module only adapts them to
stored `schedule_run_project_steps` rows (`duration_weeks`, `start_week`,
`end_week`, `lab_hold_weeks`), which are ORM rows, not the engine's
`StepSchedule`:

- `run_row_lab_weeks`: the lab **load** of one stored lab row (I66): its `h`,
  NULL read as `duration_weeks` (a full-hold row, or one written before
  migration p71a). Equal to `scheduling.row_lab_load_weeks` on the row the
  engine produced (tested in `tests/test_p62_lab_hold_backend.py`).
- `run_row_held_weeks`: the weeks the row holds its chamber, the **last**
  `h` of `start_week..end_week` (`scheduling.hold_window`); every booked week
  when NULL.
- `held_weeks_from`: how many of those held weeks fall at or after a week
  (remaining load, R62-10 windowing).

Every reader of lab load (capacity, utilisation, Gantt `lab_weeks`, the
Priority board's remaining lab, exports) goes through these three, so no
surface recomputes lab load from the step length (I9 / I66).
"""

from __future__ import annotations

from scheduling import hold_window


def run_row_lab_weeks(duration_weeks: int, lab_hold_weeks: int | None) -> int:
    """I66: the lab load of one non-skipped lab run row, `h` with NULL read as
    `duration_weeks`. The caller has already filtered kind / skipped."""

    if lab_hold_weeks is None:
        return duration_weeks
    return max(0, lab_hold_weeks)


def run_row_held_weeks(start_week: int, end_week: int, lab_hold_weeks: int | None) -> range:
    """R62-0: the weeks a lab run row holds its chamber (the last `h` of
    `start_week..end_week`); `range(start_week, end_week + 1)` when NULL."""

    return hold_window(start_week, end_week, lab_hold_weeks)


def held_weeks_from(start_week: int, end_week: int, lab_hold_weeks: int | None, week: int) -> int:
    """How many held weeks of the row are at or after `week` (0 when none)."""

    held = run_row_held_weeks(start_week, end_week, lab_hold_weeks)
    if not held:
        return 0
    return max(0, held.stop - max(held.start, week))


def room_week_range(end_week: int | None, h: int | None) -> tuple[int | None, int | None]:
    """Contract §5: `(room_start_week, room_end_week)` of a placed lab row
    with booked hold `h` (inclusive weeks, the `planned_*_week` convention):
    `(end − h + 1, end)`; `(None, None)` when `h` is 0 / None or the row is
    not placed."""

    if end_week is None or not h:
        return None, None
    return end_week - h + 1, end_week
