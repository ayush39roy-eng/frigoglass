"""Shared building blocks for the `backend/scheduling/` pytest suite.

Not a test module itself (no `test_` prefix — pytest will not collect it).

`TEMPLATE` / `LEAD_TIMES` (re-exported from `scheduling._selftest_common`) are
the minimal two-step PDD workflow the P2 hand-traced scenarios were written
against: `PDD-A` design 2 weeks, `PDD-F` lab 3 weeks, strict chain, identical
lead times for every PDD category. Under ADR 0007 durations come from the
lead-time table, so the table — not a `base_weeks` × multiplier — carries the
2/3-week arithmetic those scenarios rely on.

`progress(...)` is a keyword-friendly `StepProgressInput` builder for the
P9-T02 progress-aware golden files.

All objects here are `@dataclass(frozen=True)` instances (immutable) so
sharing them by reference across many independent test functions is safe —
`run_greedy_sgs` never mutates its input.
"""

from __future__ import annotations

from scheduling import ChamberInput, EngineerInput, ProjectInput, StepProgressInput
from scheduling._selftest_common import LEAD_TIMES, TEMPLATE

__all__ = [
    "CHAMBER_GR1",
    "CHAMBER_GR2",
    "ENGINEER_A",
    "ENGINEER_B",
    "ENGINEER_C_NARROW",
    "LEAD_TIMES",
    "TEMPLATE",
    "base_project",
    "progress",
]

ENGINEER_A = EngineerInput("eng-a", "Engineer A", "R&D-Greece", ("A+", "A", "B", "C"))
ENGINEER_B = EngineerInput("eng-b", "Engineer B", "R&D-Greece", ("A+", "A", "B", "C"))
# Only allows category "C" -- used for the CAT_NOT_ALLOWED golden-file case.
ENGINEER_C_NARROW = EngineerInput("eng-c", "Engineer C", "R&D-Greece", ("C",))

CHAMBER_GR1 = ChamberInput(
    "ch-gr1", "GR-CH1", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)
CHAMBER_GR2 = ChamberInput(
    "ch-gr2", "GR-CH2", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)


def base_project(**overrides: object) -> ProjectInput:
    """A well-formed, schedulable, non-frozen `ProjectInput` with sensible
    defaults, for negative-path (invariant-violation) fixtures where only the
    hand-crafted `ScheduleOutput` matters, not the specific project fields.
    """

    defaults: dict[str, object] = dict(
        project_id="p-x",
        name="X",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    defaults.update(overrides)
    return ProjectInput(**defaults)  # type: ignore[arg-type]


def progress(
    step_id: str,
    status: str,
    *,
    percent_complete: int = 0,
    actual_start_week: int | None = None,
    actual_end_week: int | None = None,
    remaining_weeks_override: int | None = None,
) -> StepProgressInput:
    return StepProgressInput(
        step_id=step_id,
        status=status,
        percent_complete=percent_complete,
        actual_start_week=actual_start_week,
        actual_end_week=actual_end_week,
        remaining_weeks_override=remaining_weeks_override,
    )
