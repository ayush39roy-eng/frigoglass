"""Shared building blocks for the P2-T05 golden-file / invariant-negative
pytest suite.

Not a test module itself (no `test_` prefix — pytest will not collect it).
Mirrors the small, hand-traceable fixtures established by
`scheduling/_selftest.py` (P2-T01) and `scheduling/_selftest_invariants.py`
(P2-T04): a minimal 2-step (one design, one lab) workflow template so each
golden-file scenario stays a 2-3 project, 1-2 step fixture that exercises
exactly one named rule, per the `scheduling-algorithms` skill's "one rule per
fixture" guidance, rather than paying for the full 14-step template in every
test.

All objects here are `@dataclass(frozen=True)` instances (immutable) so
sharing them by reference across many independent test functions is safe —
`run_greedy_sgs` never mutates its input (see `scheduling/greedy.py`'s purity
contract), confirmed by every P2-T01/T04 self-test scenario that reuses
`ENGINEER_A`/`CHAMBER_GR1` etc. across multiple calls.
"""

from __future__ import annotations

from scheduling import ChamberInput, EngineerInput, ProjectInput, WorkflowStepTemplate

# A minimal 2-step template (one design, one lab step), matching
# `scheduling/_selftest.py`'s TEMPLATE exactly, so behaviour cross-checked
# against that informal self-test is directly comparable.
TEMPLATE: tuple[WorkflowStepTemplate, ...] = (
    WorkflowStepTemplate("PDD-A", "Marketing Brief", "design", base_weeks=2, sequence_order=1),
    WorkflowStepTemplate("PDD-F", "Proof of Concept", "lab", base_weeks=3, sequence_order=2),
)

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
    Mirrors `_selftest_invariants.py::_base_project`.
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
