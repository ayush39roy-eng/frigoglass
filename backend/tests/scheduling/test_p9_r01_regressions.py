"""P9-R01 regression goldens: one per workflow-auditor repro from the failed P9
gate (P9-T06 F1/F2/F3), plus ENG_CONFLICT-on-both-sides and CP-SAT ruling 6.

Contract: DOMAIN_RULES "Gate remediation rulings" 1-3 and 6. Every expected
value is hand-derived from DOMAIN_RULES (PDD / B lead times
A1 B0 C0 D1 E4 F0 G0 H6 I0 J1 K2 L1 M1 N1, Σ 18).
"""

from __future__ import annotations

from dataclasses import replace

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    project_progress_pct,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
)
from tests.scheduling._fixtures import progress

ENG_1 = EngineerInput("eng-1", "One", "R&D-India", ("A+", "A", "B", "C"))
ENG_2 = EngineerInput("eng-2", "Two", "R&D-India", ("A+", "A", "B", "C"))
ENG_3 = EngineerInput("eng-3", "Three", "R&D-India", ("A+", "A", "B", "C"))
# Chamber ids sort IN-CH1 < IN-CH3, the auditor's c2 shape: CH1 has 1 platform,
# CH3 has 2, both host PDD-H.
IN_CH1 = ChamberInput("IN-CH1", "IN-CH1", "India", max_concurrent=1, allowed_stages=("PDD-H",))
IN_CH3 = ChamberInput("IN-CH3", "IN-CH3", "India", max_concurrent=2, allowed_stages=("PDD-H",))


def _in_progress_cert(pid: str, leader: str, priority: str = "P1") -> ProjectInput:
    """R&D-India, cat B. A, D, E Done before CURRENT_WEEK; PDD-H In Progress
    from wk 16 with 3 weeks remaining -> tail [31..33] (pred end 15 < CW)."""

    return ProjectInput(
        project_id=pid,
        name=pid,
        hub="R&D-India",
        status="In Development",
        category="B",
        priority=priority,
        frozen=False,
        leader_engineer_id=leader,
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=10, actual_end_week=10
            ),
            progress(
                "PDD-D", "Done", percent_complete=100, actual_start_week=11, actual_end_week=11
            ),
            progress(
                "PDD-E", "Done", percent_complete=100, actual_start_week=12, actual_end_week=15
            ),
            progress(
                "PDD-H",
                "In Progress",
                percent_complete=50,
                actual_start_week=16,
                remaining_weeks_override=3,
            ),
        ),
    )


def _si(*projects: ProjectInput, chambers=(IN_CH1, IN_CH3), **kw: object) -> ScheduleInput:
    return ScheduleInput(
        projects=projects,
        engineers=(ENG_1, ENG_2, ENG_3),
        chambers=chambers,
        **kw,  # type: ignore[arg-type]
    )


def _by(out: ScheduleOutput):
    return {o.project_id: o for o in out.project_outcomes}


def _step(outcome, step_id: str):
    return next(s for s in outcome.steps if s.step_id == step_id)


# --- F1 / ruling 1: anchored lab steps take a chamber with room ------------------


def test_f1_two_in_progress_cert_tails_use_the_chamber_with_room_greedy():
    si = _si(_in_progress_cert("p-a", "eng-1"), _in_progress_cert("p-b", "eng-2"))
    out = run_greedy_sgs(si)
    by = _by(out)
    ha, hb = _step(by["p-a"], "PDD-H"), _step(by["p-b"], "PDD-H")
    assert (ha.start_week, ha.end_week, ha.assigned_chamber_id) == (16, 33, "IN-CH1")
    # Before P9-R01 this landed in IN-CH1 too (2 > max 1, spurious OVERLAP).
    assert (hb.start_week, hb.end_week, hb.assigned_chamber_id) == (16, 33, "IN-CH3")
    assert not by["p-a"].overlap and not by["p-b"].overlap
    assert validate_invariants(si, out) == ()


def test_f1_two_in_progress_cert_tails_use_the_chamber_with_room_cp_sat():
    si = _si(_in_progress_cert("p-a", "eng-1"), _in_progress_cert("p-b", "eng-2"))
    out, _info = run_cp_sat(si)
    by = _by(out)
    assert _step(by["p-a"], "PDD-H").assigned_chamber_id == "IN-CH1"
    assert _step(by["p-b"], "PDD-H").assigned_chamber_id == "IN-CH3"
    assert not by["p-a"].overlap and not by["p-b"].overlap
    assert validate_invariants(si, out) == ()


def test_f1_overbooks_first_eligible_chamber_only_when_every_chamber_is_full():
    # IN-CH1 (1) + IN-CH3 (2) = 3 platforms; the 4th anchored tail has nowhere
    # to go, so it is booked over capacity into eligible[0] and raises OVERLAP.
    si = _si(*(_in_progress_cert(f"p-{i}", "eng-1") for i in range(4)))
    out = run_greedy_sgs(si)
    by = _by(out)
    chambers = [_step(by[f"p-{i}"], "PDD-H").assigned_chamber_id for i in range(4)]
    assert chambers == ["IN-CH1", "IN-CH3", "IN-CH3", "IN-CH1"]
    assert [by[f"p-{i}"].overlap for i in range(4)] == [False, False, False, True]
    # Allowed by I2: every eligible chamber was full (the shared leader's
    # design history is all before CURRENT_WEEK, so I1 is untouched).
    assert [v for v in validate_invariants(si, out) if v.invariant == "I2"] == []


def test_f1_validator_flags_avoidable_anchored_overbooking():
    """The pre-P9-R01 shape (auditor c2): second tail in the full IN-CH1 with
    OVERLAP raised while IN-CH3 is empty. I2 must now call that a violation."""

    si = _si(_in_progress_cert("p-a", "eng-1"), _in_progress_cert("p-b", "eng-2"))
    good = run_greedy_sgs(si)
    by = _by(good)
    bad_b = replace(
        by["p-b"],
        overlap=True,
        steps=tuple(
            replace(s, assigned_chamber_id="IN-CH1") if s.step_id == "PDD-H" else s
            for s in by["p-b"].steps
        ),
    )
    broken = replace(
        good,
        project_outcomes=tuple(
            bad_b if o.project_id == "p-b" else o for o in good.project_outcomes
        ),
    )
    viol = validate_invariants(si, broken, check_determinism=False)
    # Both tails sit in the overfull IN-CH1 and either could have used IN-CH3.
    assert sorted(v.project_id for v in viol) == ["p-a", "p-b"]
    assert all(v.invariant == "I2" and "'IN-CH3' had room" in v.description for v in viol)


# --- F2 / ruling 2: in-flight work is never erased from a CP-SAT run -------------

ENG_GR1 = EngineerInput("eng-gr1", "GR1", "R&D-Greece", ("A+", "A", "B", "C"))
ENG_GR2 = EngineerInput("eng-gr2", "GR2", "R&D-Greece", ("A+", "A", "B", "C"))
CH_GR = ChamberInput("ch-gr", "GR", "Greece", max_concurrent=1, allowed_stages=("PDD-H",))


def _f2_input() -> ScheduleInput:
    """One Greece chamber, horizon 50. Each project needs PDD-H (6 weeks) and
    cannot finish before the horizon if it queues behind the other's PDD-H,
    so only one fits. CP-SAT keeps the P1 (ADR 0005 weight 4) and leaves out
    the progress-tracked Q project (weight 0), whose Done PDD-A and
    In-Progress PDD-E must still be in the run."""

    p1 = ProjectInput(
        project_id="p1-new",
        name="p1-new",
        hub="R&D-Greece",
        status="In Development",
        category="B",
        priority="P1",
        frozen=False,
        leader_engineer_id="eng-gr1",
    )
    q = ProjectInput(
        project_id="q-inflight",
        name="q-inflight",
        hub="R&D-Greece",
        status="In Development",
        category="B",
        priority="Q",
        frozen=False,
        leader_engineer_id="eng-gr2",
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20
            ),
            progress(
                "PDD-D", "Done", percent_complete=100, actual_start_week=21, actual_end_week=21
            ),
            progress("PDD-E", "In Progress", percent_complete=50, actual_start_week=29),
        ),
    )
    return ScheduleInput(
        projects=(p1, q), engineers=(ENG_GR1, ENG_GR2), chambers=(CH_GR,), horizon_weeks=50
    )


def test_f2_cp_sat_left_out_progress_project_keeps_its_anchored_rows():
    si = _f2_input()
    out, info = run_cp_sat(si)
    by = _by(out)
    assert info.status_name == "OPTIMAL" and out.solver_status == "OPTIMAL"
    # Both projects are CP-SAT decision variables (q is not greedy-resolved):
    # the solver itself set present=0 on q.
    assert (info.num_solvable_projects, info.num_pre_resolved_left_out) == (2, 0)
    assert not by["p1-new"].left_out and by["p1-new"].within_year
    q = by["q-inflight"]
    assert q.left_out and not q.within_year and q.projected_end_week is None
    # E: remaining = ceil(4 * 0.5) = 2 -> tail [31, 32], shown from actual_start 29.
    rows = {s.step_id: (s.start_week, s.end_week, s.assigned_engineer_id) for s in q.steps}
    assert rows == {
        "PDD-A": (20, 20, "eng-gr2"),
        "PDD-D": (21, 21, "eng-gr2"),
        "PDD-E": (29, 32, "eng-gr2"),
    }
    assert (q.start_week, q.end_week) == (20, 32)
    assert q.progress_pct == round((100 * 1 + 100 * 1 + 50 * 4) / 18)  # 22
    assert validate_invariants(si, out) == ()


def test_f2_validator_flags_erased_anchored_rows():
    """The pre-P9-R01 shape: LEFT_OUT with `steps=()`. I11 must fail."""

    si = _f2_input()
    out, _info = run_cp_sat(si)
    broken = replace(
        out,
        project_outcomes=tuple(
            replace(o, steps=(), start_week=None, end_week=None)
            if o.project_id == "q-inflight"
            else o
            for o in out.project_outcomes
        ),
    )
    viol = validate_invariants(si, broken, check_determinism=False)
    assert sorted((v.invariant, v.step_id) for v in viol) == [
        ("I11", "PDD-A"),
        ("I11", "PDD-D"),
        ("I11", "PDD-E"),
    ]


# --- F3 / ruling 3: one progress formula, frozen projects included --------------


def _frozen_with_progress() -> ProjectInput:
    """The auditor's 4837f055 shape: frozen, with stored stage progress
    (PDD-A Done 100%, PDD-E In Progress 40%)."""

    return ProjectInput(
        project_id="p-frozen",
        name="p-frozen",
        hub="R&D-India",
        status="In Development",
        category="B",
        priority="P1",
        frozen=True,
        leader_engineer_id="eng-1",
        actual_start_week=24,
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=24, actual_end_week=24
            ),
            progress("PDD-E", "In Progress", percent_complete=40, actual_start_week=26),
        ),
    )


def test_f3_frozen_project_progress_pct_uses_the_duration_weighted_formula():
    si = _si(_frozen_with_progress())
    # Stored percents with effective durations (skipped steps weigh 0), exactly
    # what the Workspace passes: round((100*1 + 40*4) / 18) = round(14.44) = 14.
    pairs = [(100, 1), (0, 0), (0, 0), (0, 1), (40, 4), (0, 0), (0, 0), (0, 6)]
    pairs += [(0, 0), (0, 1), (0, 2), (0, 1), (0, 1), (0, 1)]
    assert project_progress_pct(pairs) == 14
    greedy = _by(run_greedy_sgs(si))["p-frozen"]
    cp_out, _ = run_cp_sat(si)
    cp = _by(cp_out)["p-frozen"]
    assert greedy.progress_pct == cp.progress_pct == 14  # was 0 before P9-R01
    # Frozen still wins for *dates*: progress rows never move the steps.
    assert _step(greedy, "PDD-A").start_week == 24 and _step(greedy, "PDD-E").start_week == 26
    assert validate_invariants(si, run_greedy_sgs(si)) == ()


def test_f3_validator_flags_the_old_frozen_zero():
    si = _si(_frozen_with_progress())
    out = run_greedy_sgs(si)
    broken = replace(out, project_outcomes=(replace(out.project_outcomes[0], progress_pct=0),))
    assert [v.invariant for v in validate_invariants(si, broken, check_determinism=False)] == [
        "I12"
    ]


def test_project_progress_pct_edges():
    assert project_progress_pct([]) is None
    assert project_progress_pct([(50, 0), (100, 0)]) is None  # all skipped
    assert project_progress_pct(iter([(50, 2), (100, 2)])) == 75  # any iterable
    assert project_progress_pct([(25, 1), (26, 1)]) == 26  # round(25.5), half-to-even


# --- ENG_CONFLICT on both projects of a fixed double booking (auditor D4) --------


def _in_progress_design(pid: str, priority: str) -> ProjectInput:
    """Leader eng-3; PDD-A Done wk 20, PDD-D In Progress from wk 30 with 1
    week remaining -> tail [31, 31]."""

    return ProjectInput(
        project_id=pid,
        name=pid,
        hub="R&D-India",
        status="In Development",
        category="B",
        priority=priority,
        frozen=False,
        leader_engineer_id="eng-3",
        step_progress=(
            progress(
                "PDD-A", "Done", percent_complete=100, actual_start_week=20, actual_end_week=20
            ),
            progress(
                "PDD-D",
                "In Progress",
                percent_complete=0,
                actual_start_week=30,
                remaining_weeks_override=1,
            ),
        ),
    )


def test_anchored_engineer_double_booking_flags_both_projects():
    si = _si(_in_progress_design("p-x", "P1"), _in_progress_design("p-y", "P2"))
    for out in (run_greedy_sgs(si), run_cp_sat(si)[0]):
        by = _by(out)
        assert _step(by["p-x"], "PDD-D").end_week == _step(by["p-y"], "PDD-D").end_week == 31
        assert by["p-x"].eng_conflict and by["p-y"].eng_conflict
        assert validate_invariants(si, out, check_determinism=False) == ()


# --- Ruling 6: deterministic budgets, solver status on the output ---------------


def test_solver_status_is_recorded_and_wall_clock_limit_is_ignored():
    si = _si(_in_progress_cert("p-a", "eng-1"), _in_progress_cert("p-b", "eng-2"))
    assert run_greedy_sgs(si).solver_status is None
    out1, info1 = run_cp_sat(si)
    # A wall-clock budget is accepted for call-site compatibility but ignored.
    out2, _ = run_cp_sat(si, max_time_in_seconds=0.001)
    assert out1.solver_status == info1.status_name == "OPTIMAL"
    assert repr(out1) == repr(out2)
