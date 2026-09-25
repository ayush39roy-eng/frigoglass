"""Golden-file tests, one per named `docs/DOMAIN_RULES.md` rule.

Replaces `tests/oracle/` (deleted as part of this task) as the permanent
correctness test suite for `backend/scheduling/`'s greedy SGS scheduler.
Adapted/formalized from `backend/scheduling/_selftest.py`'s already-verified
hand-traced scenarios (P2-T01) — not re-derived from scratch, per this task's
explicit instruction.

Every test asserts BOTH:
  (a) the scheduler (`run_greedy_sgs`) produces the documented outcome, AND
  (b) `validate_invariants` (P2-T04) reports zero violations on that output —
      tying the golden-file suite to the invariant validator, per this task's
      explicit brief ("a golden-file test that never checks invariants is
      missing half the point").

Each fixture is a small (2-3 project, 1-2 step) scenario exercising exactly
one named rule in isolation, per the `scheduling-algorithms` skill's "one
rule per fixture" convention.
"""

from __future__ import annotations

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    run_greedy_sgs,
    validate_invariants,
)
from tests.scheduling._fixtures import (
    CHAMBER_GR1,
    CHAMBER_GR2,
    ENGINEER_A,
    ENGINEER_B,
    ENGINEER_C_NARROW,
    TEMPLATE,
)


def _outcome(out, project_id: str):
    by_id = {o.project_id: o for o in out.project_outcomes}
    return by_id[project_id]


# --- Baseline: normal sequential booking (I3 tight packing) ------------------


def test_normal_case_sequential_booking():
    """A single, unremarkable project schedules both steps sequentially, no
    flags raised. Baseline sanity check underpinning every other scenario.
    """

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
    outcome = _outcome(out, "p-normal")

    assert not outcome.left_out
    assert not outcome.excluded
    assert not outcome.eng_conflict
    assert not outcome.overlap
    assert len(outcome.steps) == 2
    design_step, lab_step = outcome.steps
    assert design_step.start_week == 31  # current_week default
    assert design_step.duration_weeks == 2  # duration_weeks(2, "A") = round(2*0.8) = 2
    assert lab_step.start_week == design_step.end_week + 1  # I3, tight packing
    assert lab_step.assigned_chamber_id == "ch-gr1"
    assert outcome.within_year
    assert not outcome.cat_not_allowed

    assert validate_invariants(si, out) == ()


# --- Single engineer contention ----------------------------------------------


def test_single_engineer_contention():
    """Two non-frozen projects share the same leader; the lower-priority one
    must wait for the higher-priority one's design step to finish (Booking
    rules: "Non-frozen projects advance w until a free window is found").
    """

    common = dict(
        hub="R&D-Greece", status="In Queue", category="A", frozen=False, leader_engineer_id="eng-a"
    )
    p1 = ProjectInput(project_id="p-eng-1", name="First", priority="P1", **common)
    p2 = ProjectInput(project_id="p-eng-2", name="Second", priority="P2", **common)
    si = ScheduleInput(
        projects=(p2, p1),  # deliberately out of priority order in the input
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1, CHAMBER_GR2),
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)

    assert out.scheduling_order == ("p-eng-1", "p-eng-2")  # P1 scheduled before P2
    o1, o2 = _outcome(out, "p-eng-1"), _outcome(out, "p-eng-2")
    assert o2.steps[0].start_week > o1.steps[0].end_week
    assert not o1.eng_conflict
    assert not o2.eng_conflict  # non-frozen projects just wait, never conflict

    assert validate_invariants(si, out) == ()


# --- Chamber saturation -------------------------------------------------------


def test_chamber_saturation():
    """A max_concurrent=1 chamber forces two non-frozen projects' lab steps
    into non-overlapping weeks (Booking rules: "concurrent project count <
    chamber.max for every week in the window").
    """

    common = dict(hub="R&D-Greece", status="In Queue", category="A", priority="P1", frozen=False)
    p1 = ProjectInput(project_id="p-lab-1", name="First", leader_engineer_id="eng-a", **common)
    p2 = ProjectInput(project_id="p-lab-2", name="Second", leader_engineer_id="eng-b", **common)
    si = ScheduleInput(
        projects=(p1, p2),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),  # only one chamber, max_concurrent=1
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)

    lab1 = _outcome(out, "p-lab-1").steps[1]
    lab2 = _outcome(out, "p-lab-2").steps[1]
    weeks1 = set(range(lab1.start_week, lab1.end_week + 1))
    weeks2 = set(range(lab2.start_week, lab2.end_week + 1))
    assert not (weeks1 & weeks2)  # never share a week in the same chamber
    assert not _outcome(out, "p-lab-1").overlap
    assert not _outcome(out, "p-lab-2").overlap  # non-frozen projects just wait

    assert validate_invariants(si, out) == ()


# --- Frozen conflict (ENG_CONFLICT) -------------------------------------------


def test_frozen_conflict_raises_eng_conflict():
    """Two frozen projects sharing a leader and identical weeks -> the second
    raises ENG_CONFLICT; BOTH projects' dates stay locked at actual_start_week
    (Booking rules: "capacity is consumed regardless of conflict"; I10: a
    frozen project's dates are never mutated).
    """

    common = dict(
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-a",
        actual_start_week=10,
    )
    p1 = ProjectInput(project_id="p-frozen-1", name="Frozen A", **common)
    p2 = ProjectInput(project_id="p-frozen-2", name="Frozen B", **common)
    si = ScheduleInput(
        projects=(p1, p2), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    out = run_greedy_sgs(si)

    o1, o2 = _outcome(out, "p-frozen-1"), _outcome(out, "p-frozen-2")
    assert o1.steps[0].start_week == 10
    assert o2.steps[0].start_week == 10  # I10: never mutated, despite the conflict
    assert o2.eng_conflict
    assert not o1.eng_conflict  # booked first, no conflict on its own side

    # A real, correctly-flagged ENG_CONFLICT is VALID output, not a violation.
    assert validate_invariants(si, out) == ()


# --- Frozen conflict (OVERLAP) — I2's "unless frozen" branch -----------------


def test_frozen_chamber_overlap_raises_overlap():
    """Two frozen projects both need the same single-slot chamber in the same
    week -> OVERLAP (Booking rules: "an over-capacity chamber raises
    OVERLAP" for frozen projects specifically). P2-T01's own self-test didn't
    happen to cover this branch of I2; P2-T04 added it, reused here.
    """

    common = dict(
        hub="R&D-Greece",
        status="In Development",
        category="A",
        priority="P1",
        frozen=True,
        actual_start_week=10,
    )
    p1 = ProjectInput(
        project_id="p-fr-lab-1", name="Frozen lab A", leader_engineer_id="eng-a", **common
    )
    p2 = ProjectInput(
        project_id="p-fr-lab-2", name="Frozen lab B", leader_engineer_id="eng-b", **common
    )
    si = ScheduleInput(
        projects=(p1, p2),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),  # max_concurrent=1, both land here in the same weeks
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)

    o1, o2 = _outcome(out, "p-fr-lab-1"), _outcome(out, "p-fr-lab-2")
    assert o1.steps[0].start_week == 10
    assert o2.steps[0].start_week == 10  # I10 still holds despite the OVERLAP
    assert o1.overlap or o2.overlap  # at least one side raises OVERLAP

    assert validate_invariants(si, out) == ()


# --- Left-out at horizon ------------------------------------------------------


def test_left_out_at_horizon():
    """No feasible window remains before HORIZON_WEEKS -> LEFT_OUT, zero
    steps booked, never within_year, never spillover (mutually exclusive).
    """

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
        current_week=77,  # design step duration 2 -> 77+2=79 > horizon 78
        horizon_weeks=78,
    )
    out = run_greedy_sgs(si)
    outcome = _outcome(out, "p-horizon")

    assert outcome.left_out
    assert len(outcome.steps) == 0
    assert not outcome.within_year
    assert not outcome.spillover  # mutually exclusive with left_out

    assert validate_invariants(si, out) == ()


# --- Category mismatch (CAT_NOT_ALLOWED, warning only) -----------------------


def test_category_mismatch_is_warning_not_block():
    """Leader's allowed_categories excludes the project's category ->
    CAT_NOT_ALLOWED is raised as a warning; scheduling still proceeds
    normally (Booking rules: "Warning, not a scheduling block").
    """

    proj = ProjectInput(
        project_id="p-cat",
        name="Cat mismatch",
        hub="R&D-Greece",
        status="In Queue",
        category="A",  # eng-c only allows "C"
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
    outcome = _outcome(out, "p-cat")

    assert outcome.cat_not_allowed
    assert not outcome.left_out  # warning only, never a block
    assert len(outcome.steps) == 2  # fully scheduled despite the mismatch

    assert validate_invariants(si, out) == ()


def test_category_mismatch_oem_hub_variant():
    """For an OEM-hub project, CAT_NOT_ALLOWED checks the leader's "OEM"
    eligibility specifically -- not the project's own category (Booking
    rules: "or OEM for OEM-hub projects").
    """

    eng_without_oem = EngineerInput("eng-oem-no", "No OEM", "OEM-HCK", ("A+", "A", "B", "C"))
    eng_with_oem = EngineerInput("eng-oem-yes", "Has OEM", "OEM-HCK", ("OEM",))
    common = dict(hub="OEM-HCK", status="In Queue", category="A", priority="P1", frozen=False)
    p_no = ProjectInput(
        project_id="p-oem-no", name="No OEM eligibility", leader_engineer_id="eng-oem-no", **common
    )
    p_yes = ProjectInput(
        project_id="p-oem-yes",
        name="Has OEM eligibility",
        leader_engineer_id="eng-oem-yes",
        **common,
    )
    india_chamber = ChamberInput(
        "ch-in1", "IN-CH1", "India", max_concurrent=2, allowed_stages=("PDD-F",)
    )
    si = ScheduleInput(
        projects=(p_no, p_yes),
        engineers=(eng_without_oem, eng_with_oem),
        chambers=(india_chamber,),
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)

    assert _outcome(out, "p-oem-no").cat_not_allowed
    assert not _outcome(out, "p-oem-yes").cat_not_allowed

    assert validate_invariants(si, out) == ()


# --- Spillover boundary at week 52 (kept as two separate tests, per this
#     task's explicit instruction not to collapse the on-time/late variants
#     into one parametrized case) -----------------------------------------


def test_spillover_boundary_on_time_at_week_52():
    """end_week + delay <= 52 -> within_year=True, spillover=False, at
    exactly the boundary week (Booking rules: "Completing within year:
    !left_out AND (last_step_end + delay <= WITHIN_YEAR_WEEK)").
    """

    # Category A+ (multiplier 1.0) so durations equal base_weeks exactly (2
    # and 3, TEMPLATE total 5 weeks), keeping the boundary arithmetic exact.
    proj = ProjectInput(
        project_id="p-spill-ok",
        name="Just in time",
        hub="R&D-Greece",
        status="In Queue",
        category="A+",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=48,  # start=48 -> end = 48+5-1 = 52
    )
    out = run_greedy_sgs(si)
    outcome = _outcome(out, "p-spill-ok")

    assert outcome.end_week == 52
    assert outcome.within_year
    assert not outcome.spillover

    assert validate_invariants(si, out) == ()


def test_spillover_boundary_one_week_over_at_week_53():
    """One week later than the boundary case above -> end_week=53 (>52) ->
    spillover=True, within_year=False, but still NOT left_out (it WAS
    scheduled, just outside the within-year window).
    """

    proj = ProjectInput(
        project_id="p-spill-late",
        name="One week over",
        hub="R&D-Greece",
        status="In Queue",
        category="A+",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=49,  # start=49 -> end = 49+5-1 = 53
    )
    out = run_greedy_sgs(si)
    outcome = _outcome(out, "p-spill-late")

    assert outcome.end_week == 53
    assert not outcome.within_year
    assert outcome.spillover
    assert not outcome.left_out  # scheduled, just late

    assert validate_invariants(si, out) == ()


# --- Delay is terminal (ADR 0004) ---------------------------------------------


def test_delay_is_terminal_not_propagated():
    """delay_weeks only affects the within_year/spillover check, never step
    dates themselves -- ADR 0004's "delay is a terminal adjustment, not
    propagated" decision.
    """

    proj = ProjectInput(
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
    si = ScheduleInput(
        projects=(proj,),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        current_week=45,
    )
    out = run_greedy_sgs(si)
    outcome = _outcome(out, "p-delay")

    # start=45, duration 5 -> end=49 (undelayed step dates).
    assert outcome.end_week == 49
    # within_year check: 49 + 10 = 59 > 52 -> spillover, because of delay_weeks.
    assert not outcome.within_year
    assert outcome.spillover

    assert validate_invariants(si, out) == ()


# --- Excluded statuses (distinct from LEFT_OUT) -------------------------------


def test_excluded_status_commercialized():
    """A Commercialized project is excluded from scheduling entirely --
    distinct from left_out (never fed into the greedy walk at all) -- and
    within_year defaults to True (already-done semantics).
    """

    proj = ProjectInput(
        project_id="p-comm",
        name="Done",
        hub="R&D-Greece",
        status="Commercialized",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(proj,), engineers=(ENGINEER_A,), chambers=(CHAMBER_GR1,), workflow_steps=TEMPLATE
    )
    out = run_greedy_sgs(si)
    outcome = _outcome(out, "p-comm")

    assert outcome.excluded
    assert not outcome.left_out  # distinct outcomes
    assert outcome.within_year
    assert out.scheduling_order == ()  # excluded projects never enter the walk

    assert validate_invariants(si, out) == ()


def test_excluded_status_on_hold():
    """An On Hold project is also excluded entirely, but within_year defaults
    to False (unlike Commercialized) -- confirming excluded status handling
    isn't a single blanket rule but status-specific, per DOMAIN_RULES.md's
    silence being resolved per-status (see docs/MEMORY.md P2-T01 entry).
    Also confirms an excluded project never consumes engineer capacity that a
    concurrently-scheduled active project needs.
    """

    on_hold = ProjectInput(
        project_id="p-hold",
        name="Paused",
        hub="R&D-Greece",
        status="On Hold",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    active = ProjectInput(
        project_id="p-active",
        name="Active",
        hub="R&D-Greece",
        status="In Queue",
        category="A",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-a",
    )
    si = ScheduleInput(
        projects=(on_hold, active),
        engineers=(ENGINEER_A,),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
    )
    out = run_greedy_sgs(si)

    o_hold, o_active = _outcome(out, "p-hold"), _outcome(out, "p-active")
    assert o_hold.excluded
    assert not o_hold.within_year
    assert not o_active.excluded
    # eng-a is free at current_week despite "sharing" it with the on-hold project.
    assert o_active.steps[0].start_week == 31
    assert out.scheduling_order == ("p-active",)

    assert validate_invariants(si, out) == ()


# --- Determinism (Invariant I8), positive path --------------------------------


def test_determinism_byte_identical_rerun():
    """Re-running the greedy scheduler on identical input produces
    byte-identical output (Invariant I8), and result is independent of the
    caller-supplied project ordering.
    """

    projects = tuple(
        ProjectInput(
            project_id=f"p-{i}",
            name=f"Project {i}",
            hub="R&D-Greece" if i % 2 == 0 else "PD-Romania",
            status="In Queue",
            category=["A+", "A", "B", "C"][i % 4],
            priority=["P1", "P2", "P3", "P4", "Q"][i % 5],
            frozen=(i % 5 == 0),
            leader_engineer_id="eng-a" if i % 2 == 0 else "eng-b",
            actual_start_week=(20 + i) if (i % 5 == 0) else None,
        )
        for i in range(12)
    )
    romania_chamber = ChamberInput(
        "ch-ro1", "RO-CH1", "Romania", max_concurrent=2, allowed_stages=("PDD-F",)
    )
    si = ScheduleInput(
        projects=projects,
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1, CHAMBER_GR2, romania_chamber),
        workflow_steps=TEMPLATE,
    )
    out1 = run_greedy_sgs(si)
    out2 = run_greedy_sgs(si)
    assert out1 == out2
    assert repr(out1) == repr(out2)

    shuffled = ScheduleInput(
        projects=tuple(reversed(projects)),
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1, CHAMBER_GR2, romania_chamber),
        workflow_steps=TEMPLATE,
    )
    out3 = run_greedy_sgs(shuffled)
    assert out1 == out3

    assert validate_invariants(si, out1) == ()
