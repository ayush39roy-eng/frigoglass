"""Informal self-test for P2-T04's invariant validator (`scheduling.invariants`).

Run directly: `python -m scheduling._selftest_invariants` from `backend/`.

Same status as `scheduling._selftest.py` (P2-T01): deliberately not a pytest
module under `backend/tests/` (qa-inspector's directory) — formal pytest
coverage of `backend/scheduling/` is P2-T09's job, not this one's.

This script verifies the validator two ways, per this task's explicit brief:

  1. **Zero violations on accepted-correct output.** Runs `validate_invariants`
     against `run_greedy_sgs`'s real output for every scenario reused/adapted
     from P2-T01's own `_selftest.py`, plus the full 46-project real seed
     dataset (`backend/seed/prototype_seed_data.json`) with the canonical
     14-step template — i.e. at both hand-traced-fixture scale and real-data
     scale. A violation found here would mean the *validator*, not the
     already-reviewed-and-accepted scheduler, has a bug (see this task's own
     instruction: investigate and fix the validator, don't touch the
     scheduler, unless there's strong independent evidence the scheduler is
     actually wrong).

  2. **Each invariant's hand-crafted BROKEN case is actually caught.** For
     every one of I1-I10, hand-builds a `ScheduleOutput` (directly as
     dataclass instances, no real scheduler run needed) that deliberately
     violates that specific invariant, and asserts `validate_invariants`
     reports at least one violation tagged with that invariant's id. This is
     the more important half — it is what proves the validator would actually
     catch a real future regression.
"""

from __future__ import annotations

import json
from pathlib import Path

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ProjectScheduleOutcome,
    ScheduleInput,
    ScheduleOutput,
    StepSchedule,
    WorkflowStepTemplate,
    check_scheduler_determinism,
    run_greedy_sgs,
    validate_invariants,
)

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    status = "OK" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        FAILURES.append(label)


def check_violations_contain(label: str, violations: tuple, invariant: str) -> None:
    found = any(v.invariant == invariant for v in violations)
    check(f"{label} (found {invariant} among {[v.invariant for v in violations]})", found)


# --- Shared fixtures (mirrors scheduling._selftest.py's building blocks) ------

TEMPLATE = (
    WorkflowStepTemplate("PDD-A", "Marketing Brief", "design", base_weeks=2, sequence_order=1),
    WorkflowStepTemplate("PDD-F", "Proof of Concept", "lab", base_weeks=3, sequence_order=2),
)

ENGINEER_A = EngineerInput("eng-a", "Engineer A", "R&D-Greece", ("A+", "A", "B", "C"))
ENGINEER_B = EngineerInput("eng-b", "Engineer B", "R&D-Greece", ("A+", "A", "B", "C"))
ENGINEER_C_NARROW = EngineerInput("eng-c", "Engineer C", "R&D-Greece", ("C",))

CHAMBER_GR1 = ChamberInput(
    "ch-gr1", "GR-CH1", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)
CHAMBER_GR2 = ChamberInput(
    "ch-gr2", "GR-CH2", "Greece", max_concurrent=1, allowed_stages=("PDD-F",)
)


# ==============================================================================
# Direction 1: zero violations on accepted-correct scheduler output
# ==============================================================================


def direction1_normal_case() -> None:
    proj = ProjectInput(
        project_id="p-normal",
        name="Normal",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P2",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check("direction1 normal_case: zero violations", v == ())


def direction1_single_engineer_contention() -> None:
    common = dict(
        hub="R&D-Greece", status="In Queue", category="A", frozen=False, leader_engineer_id="eng-a"
    )
    p1 = ProjectInput(project_id="p-eng-1", name="First", priority="P1", **common)
    p2 = ProjectInput(project_id="p-eng-2", name="Second", priority="P2", **common)
    si = ScheduleInput(
        projects=(p2, p1),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1, CHAMBER_GR2),
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check("direction1 single_engineer_contention: zero violations", v == ())


def direction1_chamber_saturation() -> None:
    common = dict(hub="R&D-Greece", status="In Queue", category="A", priority="P1", frozen=False)
    p1 = ProjectInput(project_id="p-lab-1", name="First", leader_engineer_id="eng-a", **common)
    p2 = ProjectInput(project_id="p-lab-2", name="Second", leader_engineer_id="eng-b", **common)
    si = ScheduleInput(
        projects=(p1, p2),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check("direction1 chamber_saturation: zero violations", v == ())


def direction1_frozen_conflict() -> None:
    p1 = ProjectInput(
        project_id="p-frozen-1",
        name="Frozen A",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-a",
        actual_start_week=10,
    )
    p2 = ProjectInput(
        project_id="p-frozen-2",
        name="Frozen B",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-a",
        actual_start_week=10,
    )
    si = ScheduleInput(
        projects=(p1, p2), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    # This scenario deliberately produces a real ENG_CONFLICT (I1's "unless
    # frozen" branch) -- validate_invariants must recognise that as VALID
    # (correctly-flagged), not report it as a violation.
    check("direction1 frozen_conflict: zero violations (ENG_CONFLICT correctly flagged)", v == ())


def direction1_frozen_chamber_overlap() -> None:
    """Two frozen projects both need the same single-slot chamber in the same
    week -> a real, correctly-flagged OVERLAP (I2's "unless frozen" branch).
    """

    p1 = ProjectInput(
        project_id="p-fr-lab-1",
        name="Frozen lab A",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-a",
        actual_start_week=10,
    )
    p2 = ProjectInput(
        project_id="p-fr-lab-2",
        name="Frozen lab B",
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-b",
        actual_start_week=10,
    )
    si = ScheduleInput(
        projects=(p1, p2),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),  # max_concurrent=1, both projects land here in the same weeks
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check(
        "direction1 frozen_chamber_overlap: zero violations (OVERLAP correctly flagged)", v == ()
    )


def direction1_left_out_at_horizon() -> None:
    proj = ProjectInput(
        project_id="p-horizon",
        name="Too late",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=77,
        horizon_weeks=78,
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check("direction1 left_out_at_horizon: zero violations", v == ())


def direction1_category_mismatch_and_oem() -> None:
    proj = ProjectInput(
        project_id="p-cat",
        name="Cat mismatch",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-c",
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_C_NARROW,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check("direction1 category_mismatch: zero violations", v == ())


def direction1_spillover_boundary_and_delay() -> None:
    common = dict(
        hub="R&D-Greece",
        status="In Queue",
        category="A+",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    proj_ok = ProjectInput(project_id="p-spill-ok", name="Just in time", **common)
    si_ok = ScheduleInput(
        projects=(proj_ok,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=48,
    )
    check(
        "direction1 spillover_boundary (on time): zero violations",
        validate_invariants(si_ok, run_greedy_sgs(si_ok)) == (),
    )

    proj_late = ProjectInput(project_id="p-spill-late", name="One week over", **common)
    si_late = ScheduleInput(
        projects=(proj_late,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=49,
    )
    check(
        "direction1 spillover_boundary (one week over): zero violations",
        validate_invariants(si_late, run_greedy_sgs(si_late)) == (),
    )

    proj_delay = ProjectInput(
        project_id="p-delay",
        name="Delayed",
        hub="R&D-Greece",
        status="In Queue",
        category="A+",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
        delay_weeks=10,
    )
    si_delay = ScheduleInput(
        projects=(proj_delay,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=45,
    )
    check(
        "direction1 delay_is_terminal: zero violations",
        validate_invariants(si_delay, run_greedy_sgs(si_delay)) == (),
    )


def direction1_excluded_statuses() -> None:
    common = dict(
        hub="R&D-Greece", category="A", priority="P1", frozen=False, leader_engineer_id="eng-a"
    )
    commercialized = ProjectInput(
        project_id="p-comm", name="Done", status="Commercialized", **common
    )
    on_hold = ProjectInput(project_id="p-hold", name="Paused", status="On Hold", **common)
    active = ProjectInput(project_id="p-active", name="Active", status="In Queue", **common)
    si = ScheduleInput(
        projects=(commercialized, on_hold, active),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check("direction1 excluded_statuses: zero violations", v == ())


def direction1_full_14_step_multi_hub() -> None:
    """Larger, mixed scenario using the *canonical* 14-step template (the
    default `ScheduleInput.workflow_steps`), several hubs/lab regions, a mix
    of frozen/non-frozen, contention, and category mismatch -- exercising the
    validator against a schedule shaped like the real thing, not just the
    2-step TEMPLATE fixture.
    """

    engineers = (
        EngineerInput("eng-gr1", "GR One", "R&D-Greece", ("A+", "A", "B", "C")),
        EngineerInput("eng-gr2", "GR Two", "R&D-Greece", ("A+", "A", "B", "C")),
        EngineerInput("eng-ro1", "RO One", "PD-Romania", ("A+", "A", "B", "C")),
        EngineerInput("eng-oem1", "OEM One", "OEM-HCK", ("OEM",)),
    )
    chambers = (
        ChamberInput(
            "ch-gr-a",
            "GR-A",
            "Greece",
            max_concurrent=2,
            allowed_stages=("PDD-F", "PDD-H", "PDD-J", "PDD-L"),
        ),
        ChamberInput(
            "ch-ro-a",
            "RO-A",
            "Romania",
            max_concurrent=1,
            allowed_stages=("PDD-F", "PDD-H", "PDD-J", "PDD-L"),
        ),
        ChamberInput(
            "ch-in-a",
            "IN-A",
            "India",
            max_concurrent=1,
            allowed_stages=("PDD-F", "PDD-H", "PDD-J", "PDD-L"),
        ),
    )
    projects = (
        ProjectInput(
            project_id="p-full-frozen",
            name="Frozen",
            hub="R&D-Greece",
            status="In Development",
            category="A",
            priority="P1",
            frozen=True,
            leader_engineer_id="eng-gr1",
            actual_start_week=15,
        ),
        ProjectInput(
            project_id="p-full-a",
            name="A",
            hub="R&D-Greece",
            status="In Queue",
            category="A+",
            priority="P1",
            frozen=False,
            leader_engineer_id="eng-gr1",
        ),
        ProjectInput(
            project_id="p-full-b",
            name="B",
            hub="R&D-Greece",
            status="In Queue",
            category="B",
            priority="P3",
            frozen=False,
            leader_engineer_id="eng-gr1",
        ),
        ProjectInput(
            project_id="p-full-c",
            name="C",
            hub="PD-Romania",
            status="Under Industrialization",
            category="C",
            priority="P2",
            frozen=False,
            leader_engineer_id="eng-ro1",
        ),
        ProjectInput(
            project_id="p-full-oem",
            name="OEM",
            hub="OEM-HCK",
            status="In Queue",
            category="A",
            priority="P1",
            frozen=False,
            leader_engineer_id="eng-oem1",
        ),
        ProjectInput(
            project_id="p-full-catmismatch",
            name="Cat mismatch",
            hub="OEM-HCK",
            status="In Queue",
            category="A",
            priority="P4",
            frozen=False,
            leader_engineer_id="eng-gr2",  # not OEM-eligible
        ),
    )
    si = ScheduleInput(projects=projects, engineers=engineers, chambers=chambers)
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check("direction1 full_14_step_multi_hub: zero violations", v == ())


def direction1_real_seed_dataset() -> None:
    """The full real 46-project P1-T03 seed dataset, canonical 14-step
    template -- confirms the validator holds at realistic scale, not just on
    small hand-traced fixtures. Uses the same identifier scheme
    `tests/oracle/diff_against_scheduler.py` (P2-T03) established
    (project_id = external code, engineer_id = name, chamber_id = code), but
    is self-contained here (does not import from `tests/oracle/`, which is
    temporary scaffolding deleted at P2-T05 -- this permanent validator's
    self-test should not depend on it).
    """

    seed_path = Path(__file__).resolve().parent.parent / "seed" / "prototype_seed_data.json"
    if not seed_path.exists():
        check("direction1 real_seed_dataset: seed file present (skipped, not found)", False)
        return

    seed = json.loads(seed_path.read_text())

    engineers = tuple(
        EngineerInput(
            engineer_id=e["name"],
            name=e["name"],
            hub=e["hub"],
            allowed_categories=tuple(e["cats"]),
            fte=e["fte"],
        )
        for e in seed["engineers"]
    )
    chambers = tuple(
        ChamberInput(
            chamber_id=c["id"],
            code=c["id"],
            lab_region=c["labHub"],
            max_concurrent=c["max"],
            allowed_stages=tuple(f"PDD-{letter}" for letter in c["stages"]),
            efficiency=c["eff"],
            weeks_per_chamber=c["wksCh"],
        )
        for c in seed["chambers"]
    )
    projects = tuple(
        ProjectInput(
            project_id=p["id"],
            name=p["name"],
            hub=p["hub"],
            status=p["status"],
            category=p["cat"],
            priority=p["prio"],
            frozen=p["frozen"],
            leader_engineer_id=p["leader"],
            actual_start_week=p["actualStart"] if p["frozen"] else None,
            delay_weeks=p["delay"],
        )
        for p in seed["projects"]
    )
    si = ScheduleInput(projects=projects, engineers=engineers, chambers=chambers)
    out = run_greedy_sgs(si)
    v = validate_invariants(si, out)
    check(f"direction1 real_seed_dataset (46 projects): zero violations (got {len(v)})", v == ())
    if v:
        for viol in v[:20]:
            print(f"    {viol}")


# ==============================================================================
# Direction 2: hand-crafted BROKEN ScheduleOutput per invariant, must be caught
# ==============================================================================


def _base_project(**overrides) -> ProjectInput:
    defaults = dict(
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
    return ProjectInput(**defaults)


def direction2_i1_engineer_double_booked_non_frozen() -> None:
    """Two non-frozen projects, same engineer, hand-crafted to overlap weeks
    -- with neither eng_conflict flag set. Should never happen; must be
    caught regardless.
    """

    p1 = _base_project(project_id="p-i1-a")
    p2 = _base_project(project_id="p-i1-b")
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
    broken_output = ScheduleOutput(
        project_outcomes=(outcome_a, outcome_b), scheduling_order=("p-i1-a", "p-i1-b")
    )
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I1 (non-frozen double-booking)", v, "I1")


def direction2_i2_chamber_over_capacity_no_frozen() -> None:
    """Two non-frozen projects both booked into a max_concurrent=1 chamber in
    the same week, no frozen project involved, no overlap flag set.
    """

    p1 = _base_project(project_id="p-i2-a")
    p2 = _base_project(project_id="p-i2-b", leader_engineer_id="eng-b")
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
    broken_output = ScheduleOutput(
        project_outcomes=(outcome_a, outcome_b), scheduling_order=("p-i2-a", "p-i2-b")
    )
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I2 (non-frozen chamber over-capacity)", v, "I2")


def direction2_i3_steps_overlap_within_project() -> None:
    """A single project's two steps overlap in weeks -- I3 violated."""

    p1 = _base_project(project_id="p-i3-a")
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
    broken_output = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i3-a",))
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I3 (overlapping steps within a project)", v, "I3")


def direction2_i4_wrong_lab_region_and_stage() -> None:
    """A Greece-hub project's lab step booked to a Romania chamber whose
    allowed_stages don't even include the step -- double I4 breach.
    """

    p1 = _base_project(project_id="p-i4-a", hub="R&D-Greece")
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
    # wrong region + wrong stage
    step2 = StepSchedule("PDD-F", 2, "lab", 33, 35, 3, None, "ch-ro-x")
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
    broken_output = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i4-a",))
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I4 (wrong lab region / disallowed stage)", v, "I4")


def direction2_i5_incomplete_not_flagged_left_out() -> None:
    """A project has only 1 of 2 template steps booked, but left_out=False."""

    p1 = _base_project(project_id="p-i5-a")
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
    broken_output = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i5-a",))
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I5 (incomplete schedule, not left_out)", v, "I5")


def direction2_i6_negative_design_duration() -> None:
    """A design step reports a negative duration_weeks -- makes the I6
    aggregate uncomputable/meaningless.
    """

    p1 = _base_project(project_id="p-i6-a")
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
    broken_output = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i6-a",))
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I6 (negative design duration)", v, "I6")


def direction2_i7_negative_lab_duration() -> None:
    """A lab step reports a negative duration_weeks -- makes the I7 aggregate
    uncomputable/meaningless.
    """

    p1 = _base_project(project_id="p-i7-a")
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
    broken_output = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i7-a",))
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I7 (negative lab duration)", v, "I7")


def direction2_i8_nondeterministic_input_rejected() -> None:
    """I8 cannot be broken by hand-crafting a ScheduleOutput (check_scheduler_
    determinism re-runs the real scheduler on ScheduleInput, ignoring whatever
    ScheduleOutput was passed in) -- so this direction instead confirms
    `check_scheduler_determinism` reports ZERO violations for a real,
    deterministic input (there is nothing to "break" here since the greedy
    scheduler has no randomness by construction; this documents why I8 has no
    hand-crafted-broken-output counterpart, rather than silently omitting it).
    """

    p1 = _base_project(project_id="p-i8-a")
    si = ScheduleInput(
        projects=(p1,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    v = check_scheduler_determinism(si, runs=3)
    check("direction2 I8 (real scheduler input has zero determinism violations)", v == ())

    # Also confirm validate_invariants(..., check_determinism=True) (the
    # default) actually runs this check as part of the full pass, using a
    # correct, freshly-computed ScheduleOutput for the same input.
    out = run_greedy_sgs(si)
    v_full = validate_invariants(si, out, check_determinism=True)
    check(
        "direction2 I8 (validate_invariants default check_determinism=True runs cleanly)",
        v_full == (),
    )


def direction2_i9_within_year_flag_wrong() -> None:
    """A project's within_year is hand-set to True despite end_week + delay
    exceeding within_year_week (52 by default) -- must be re-derived and
    caught as inconsistent.
    """

    p1 = _base_project(project_id="p-i9-a", delay_weeks=0)
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
    broken_output = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i9-a",))
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I9 (within_year flag inconsistent with formula)", v, "I9")


def direction2_i10_frozen_dates_mutated() -> None:
    """A frozen project's actual_start_week is 10, but its output first step
    starts at week 15 -- dates must never move for a frozen project.
    """

    p1 = _base_project(
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
    broken_output = ScheduleOutput(project_outcomes=(outcome,), scheduling_order=("p-i10-a",))
    v = validate_invariants(si, broken_output, check_determinism=False)
    check_violations_contain("direction2 I10 (frozen project's dates mutated)", v, "I10")


def main() -> int:
    print("=== Direction 1: zero violations on accepted-correct scheduler output ===")
    direction1_normal_case()
    direction1_single_engineer_contention()
    direction1_chamber_saturation()
    direction1_frozen_conflict()
    direction1_frozen_chamber_overlap()
    direction1_left_out_at_horizon()
    direction1_category_mismatch_and_oem()
    direction1_spillover_boundary_and_delay()
    direction1_excluded_statuses()
    direction1_full_14_step_multi_hub()
    direction1_real_seed_dataset()

    print()
    print("=== Direction 2: hand-crafted BROKEN output per invariant must be caught ===")
    direction2_i1_engineer_double_booked_non_frozen()
    direction2_i2_chamber_over_capacity_no_frozen()
    direction2_i3_steps_overlap_within_project()
    direction2_i4_wrong_lab_region_and_stage()
    direction2_i5_incomplete_not_flagged_left_out()
    direction2_i6_negative_design_duration()
    direction2_i7_negative_lab_duration()
    direction2_i8_nondeterministic_input_rejected()
    direction2_i9_within_year_flag_wrong()
    direction2_i10_frozen_dates_mutated()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
