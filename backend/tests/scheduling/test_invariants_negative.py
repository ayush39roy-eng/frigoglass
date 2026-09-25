"""Negative-path invariant coverage: one test per invariant (I1-I10)
confirming `validate_invariants` (P2-T04) catches a deliberately-broken
hand-crafted `ScheduleOutput`.

Adapted/formalized from `backend/scheduling/_selftest_invariants.py`'s
"Direction 2" library (already-verified-correct broken-case fixtures) — not
re-derived from scratch, per this task's explicit instruction. Each
`ScheduleOutput` here is built directly as dataclass instances (no scheduler
run) so the violation is unambiguous and hand-traceable.
"""

from __future__ import annotations

from scheduling import (
    ChamberInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
    check_scheduler_determinism,
    run_greedy_sgs,
    validate_invariants,
)
from tests.scheduling._fixtures import CHAMBER_GR1, ENGINEER_A, ENGINEER_B, TEMPLATE, base_project


def _violations_by_invariant(violations, invariant: str) -> bool:
    return any(v.invariant == invariant for v in violations)


def test_i1_engineer_double_booked_non_frozen_is_caught():
    """I1: no engineer is assigned two design steps in the same week unless
    at least one project is frozen. Two non-frozen projects, same engineer,
    hand-crafted to overlap weeks, with neither eng_conflict flag set.
    """

    p1 = base_project(project_id="p-i1-a")
    p2 = base_project(project_id="p-i1-b")
    si = ScheduleInput(
        projects=(p1, p2), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    step_a = StepSchedule("PDD-A", 1, "design", 31, 32, 2, "eng-a", None)
    step_b = StepSchedule("PDD-A", 1, "design", 32, 33, 2, "eng-a", None)  # overlaps week 32
    outcome_a = ProjectScheduleOutcome(
        project_id="p-i1-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step_a,),
        start_week=31,
        end_week=32,
    )
    outcome_b = ProjectScheduleOutcome(
        project_id="p-i1-b",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step_b,),
        start_week=32,
        end_week=33,
    )
    broken = ScheduleOutput(
        project_outcomes=(outcome_a, outcome_b), scheduling_order=("p-i1-a", "p-i1-b")
    )
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I1")


def test_i2_chamber_over_capacity_non_frozen_is_caught():
    """I2: no chamber exceeds max concurrent projects in any week unless
    frozen. Two non-frozen projects both booked into a max_concurrent=1
    chamber in the same week, no overlap flag set.
    """

    p1 = base_project(project_id="p-i2-a")
    p2 = base_project(project_id="p-i2-b", leader_engineer_id="eng-b")
    si = ScheduleInput(
        projects=(p1, p2),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),  # max_concurrent=1
        workflow_steps=TEMPLATE,
    )
    lab_a = StepSchedule("PDD-F", 2, "lab", 40, 42, 3, None, "ch-gr1")
    lab_b = StepSchedule("PDD-F", 2, "lab", 40, 42, 3, None, "ch-gr1")  # same chamber, same weeks
    outcome_a = ProjectScheduleOutcome(
        project_id="p-i2-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(lab_a,),
        start_week=40,
        end_week=42,
    )
    outcome_b = ProjectScheduleOutcome(
        project_id="p-i2-b",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(lab_b,),
        start_week=40,
        end_week=42,
    )
    broken = ScheduleOutput(
        project_outcomes=(outcome_a, outcome_b), scheduling_order=("p-i2-a", "p-i2-b")
    )
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I2")


def test_i3_steps_overlap_within_project_is_caught():
    """I3: steps within a project are strictly sequential and non-overlapping
    (step[n].start >= step[n-1].end + 1). A single project's two steps
    overlap in weeks.
    """

    p1 = base_project(project_id="p-i3-a")
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    step1 = StepSchedule("PDD-A", 1, "design", 31, 32, 2, "eng-a", None)
    step2 = StepSchedule("PDD-F", 2, "lab", 32, 34, 3, None, "ch-gr1")  # starts before step1 ends
    outcome = ProjectScheduleOutcome(
        project_id="p-i3-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step1, step2),
        start_week=31,
        end_week=34,
    )
    broken = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i3-a",))
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I3")


def test_i4_wrong_lab_region_and_disallowed_stage_is_caught():
    """I4: a lab step is only ever booked to a chamber in the project's lab
    region whose allowed_stages contains that step. A Greece-hub project's
    lab step booked to a Romania chamber whose allowed_stages don't even
    include the step -- double I4 breach.
    """

    p1 = base_project(project_id="p-i4-a", hub="R&D-Greece")
    romania_chamber = ChamberInput(
        "ch-ro-x", "RO-X", "Romania", max_concurrent=1, allowed_stages=("PDD-H",)  # not PDD-F
    )
    si = ScheduleInput(
        projects=(p1,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1, romania_chamber),
        workflow_steps=TEMPLATE,
    )
    step1 = StepSchedule("PDD-A", 1, "design", 31, 32, 2, "eng-a", None)
    step2 = StepSchedule("PDD-F", 2, "lab", 33, 35, 3, None, "ch-ro-x")  # wrong region + stage
    outcome = ProjectScheduleOutcome(
        project_id="p-i4-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step1, step2),
        start_week=31,
        end_week=35,
    )
    broken = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i4-a",))
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I4")


def test_i5_incomplete_schedule_not_flagged_left_out_is_caught():
    """I5: every scheduled project has either a complete 14-step (here,
    2-step) schedule or LEFT_OUT=true. A project has only 1 of 2 template
    steps booked, but left_out=False.
    """

    p1 = base_project(project_id="p-i5-a")
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    step1 = StepSchedule("PDD-A", 1, "design", 31, 32, 2, "eng-a", None)
    outcome = ProjectScheduleOutcome(
        project_id="p-i5-a",
        excluded=False,
        left_out=False,  # incomplete schedule but claims NOT left_out
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step1,),  # only 1 of 2 TEMPLATE steps
        start_week=31,
        end_week=32,
    )
    broken = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i5-a",))
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I5")


def test_i6_negative_design_duration_is_caught():
    """I6: total design load per hub must be computable (no negative/
    malformed step durations). A design step reports a negative
    duration_weeks.
    """

    p1 = base_project(project_id="p-i6-a")
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    step1 = StepSchedule("PDD-A", 1, "design", 31, 30, -2, "eng-a", None)  # negative duration
    step2 = StepSchedule("PDD-F", 2, "lab", 31, 33, 3, None, "ch-gr1")
    outcome = ProjectScheduleOutcome(
        project_id="p-i6-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step1, step2),
        start_week=31,
        end_week=33,
    )
    broken = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i6-a",))
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I6")


def test_i7_negative_lab_duration_is_caught():
    """I7: total lab load per hub (durations x 0.5) must be computable. A lab
    step reports a negative duration_weeks.
    """

    p1 = base_project(project_id="p-i7-a")
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    step1 = StepSchedule("PDD-A", 1, "design", 31, 32, 2, "eng-a", None)
    step2 = StepSchedule("PDD-F", 2, "lab", 33, 32, -1, None, "ch-gr1")  # negative duration
    outcome = ProjectScheduleOutcome(
        project_id="p-i7-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step1, step2),
        start_week=31,
        end_week=32,
    )
    broken = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i7-a",))
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I7")


def test_i8_determinism_has_no_broken_output_counterpart():
    """I8: re-running the greedy scheduler on identical input produces
    byte-identical output. Unlike I1-I7/I9/I10, I8 cannot be broken by
    handing `validate_invariants` a bad `ScheduleOutput` --
    `check_scheduler_determinism` re-runs the REAL `run_greedy_sgs` against
    the given `ScheduleInput` and ignores whatever output argument would
    otherwise be passed; the greedy scheduler has no randomness by
    construction (P2-T01), so there is nothing to inject non-determinism
    into without editing `scheduling/greedy.py` itself (out of scope for a
    test suite that must not touch the already-accepted implementation).
    This test documents that explicitly and instead confirms
    `check_scheduler_determinism` — and `validate_invariants`'s default
    `check_determinism=True` path — both run cleanly (zero violations) for a
    real, deterministic input, which is the strongest verification available
    for this invariant's only failure mode.
    """

    p1 = base_project(project_id="p-i8-a")
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    assert check_scheduler_determinism(si, runs=3) == ()

    out = run_greedy_sgs(si)
    assert validate_invariants(si, out, check_determinism=True) == ()


def test_i9_within_year_flag_inconsistent_with_formula_is_caught():
    """I9: within_year on the Dashboard equals the count of projects
    satisfying the within-year rule in the current schedule run -- no
    independent calculation anywhere. A project's within_year is hand-set to
    True despite end_week + delay exceeding within_year_week (52 by
    default).
    """

    p1 = base_project(project_id="p-i9-a", delay_weeks=0)
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    step1 = StepSchedule("PDD-A", 1, "design", 60, 61, 2, "eng-a", None)
    step2 = StepSchedule("PDD-F", 2, "lab", 62, 64, 3, None, "ch-gr1")  # end_week=64 > 52
    outcome = ProjectScheduleOutcome(
        project_id="p-i9-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,  # WRONG: 64 > 52, should be False
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step1, step2),
        start_week=60,
        end_week=64,
    )
    broken = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i9-a",))
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I9")


def test_i10_frozen_project_dates_mutated_is_caught():
    """I10: applying priorities never mutates a frozen project's dates. A
    frozen project's actual_start_week is 10, but its output first step
    starts at week 15.
    """

    p1 = base_project(
        project_id="p-i10-a", frozen=True, actual_start_week=10, status="In Development"
    )
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    step1 = StepSchedule("PDD-A", 1, "design", 15, 16, 2, "eng-a", None)  # should be 10, not 15
    step2 = StepSchedule("PDD-F", 2, "lab", 17, 19, 3, None, "ch-gr1")
    outcome = ProjectScheduleOutcome(
        project_id="p-i10-a",
        excluded=False,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=True,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(step1, step2),
        start_week=15,
        end_week=19,
    )
    broken = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i10-a",))
    violations = validate_invariants(si, broken, check_determinism=False)
    assert _violations_by_invariant(violations, "I10")
