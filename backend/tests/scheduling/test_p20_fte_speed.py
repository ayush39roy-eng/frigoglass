"""P20-T01 — FTE gates scheduling speed (ADR 0032, supersedes ADR 0002).

Owner ruling 2026-10-21: "0.5 FTE represents half speed". A design step of a
non-frozen project led by an engineer with FTE `f` books `ceil(duration / f)`
consecutive weeks of that engineer; `duration_weeks` (effort) is unchanged, so
load (I6) and progress weights (I12) are unchanged. Lab, elapsed and skipped
steps are not stretched; frozen projects are not stretched (I10); an
In Progress tail stretches its remaining effort the same way; FTE <= 0 is a
`data_error`, never a division by zero.

Hand-worked figures are in each test. Pure, in-process; no DB.
"""

from __future__ import annotations

import dataclasses
import math

import pytest

from scheduling import (
    ChamberInput,
    EngineerInput,
    LeadTime,
    ProjectInput,
    ScheduleInput,
    StepProgressInput,
    analyse_project,
    build_lead_time_table,
    build_workflows,
    compute_design_load_by_hub,
    fte_span,
    is_valid_fte,
    run_cp_sat,
    run_greedy_sgs,
    unconstrained_end_week,
    validate_invariants,
)
from scheduling._selftest_common import TEMPLATE, load_seed_schedule_input
from scheduling.types import PDD_CATEGORIES
from scheduling.whatif import (
    AddEngineer,
    AddProject,
    Scenario,
    analytic_requirements,
    build_scenario_input,
    simulate,
    solve_minimum_additions,
)
from tests.scheduling._whatif_fixtures import portfolio_baseline

CW = 10

#: Two-step workflow (TEMPLATE): PDD-A design 4 weeks -> PDD-F lab 3 weeks.
LEAD_4_3: tuple[LeadTime, ...] = tuple(
    LeadTime("PDD", cat, sid, w)
    for cat in PDD_CATEGORIES
    for sid, w in (("PDD-A", 4), ("PDD-F", 3))
)

CHAMBER = ChamberInput("ch-1", "GR-1", "Greece", 5, ("PDD-F", "PDD-H"))


def _eng(fte: float, eid: str = "eng-1") -> EngineerInput:
    return EngineerInput(eid, eid, "R&D-Greece", ("A+", "A", "B", "C"), fte=fte)


def _proj(pid: str = "p1", leader: str = "eng-1", **kw: object) -> ProjectInput:
    base: dict[str, object] = {
        "project_id": pid,
        "name": pid,
        "hub": "R&D-Greece",
        "status": "In Queue",
        "category": "A",
        "priority": "P1",
        "frozen": False,
        "leader_engineer_id": leader,
    }
    base.update(kw)
    return ProjectInput(**base)  # type: ignore[arg-type]


def _two_step_input(
    projects: tuple[ProjectInput, ...], engineers: tuple[EngineerInput, ...]
) -> ScheduleInput:
    return ScheduleInput(
        projects=projects,
        engineers=engineers,
        chambers=(CHAMBER,),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_4_3,
        current_week=CW,
    )


def _steps(out, pid: str):  # type: ignore[no-untyped-def]
    o = next(o for o in out.project_outcomes if o.project_id == pid)
    return o, {s.step_id: s for s in o.steps}


# --- 1. The rounding rule ---------------------------------------------------------


@pytest.mark.parametrize(
    ("effort", "fte", "span"),
    [
        (4, 0.5, 8),  # the owner's example
        (4, 0.63, 7),  # 6.349... -> 7
        (4, 1.0, 4),
        (1, 0.5, 2),
        (1, 0.63, 2),  # 1.587 -> 2
        (6, 0.8, 8),  # 7.5 -> 8
        (3, 0.3, 10),
        (21, 0.7, 30),  # exact: binary-float 21 / 0.7 is 30.000000000000004 -> 31
        (21, 0.35, 60),  # same trap
        (4, 1.25, 4),  # 3.2 -> 4 (FTE > 1 applies the same formula)
        (0, 0.5, 0),
    ],
)
def test_fte_span_is_ceil_of_effort_over_fte(effort: int, fte: float, span: int) -> None:
    assert fte_span(effort, fte) == span


def test_binary_float_trap_is_avoided() -> None:
    assert math.ceil(21 / 0.7) == 31  # the trap fte_span must not fall into
    assert fte_span(21, 0.7) == 30


@pytest.mark.parametrize("fte", [0.0, -0.5, float("nan"), float("inf")])
def test_fte_span_rejects_invalid_fte(fte: float) -> None:
    assert not is_valid_fte(fte)
    with pytest.raises(ValueError):
        fte_span(4, fte)


# --- 2. Hand examples through the scheduler ----------------------------------------


@pytest.mark.parametrize(("fte", "design_end"), [(0.5, 17), (0.63, 16), (1.0, 13)])
def test_hand_examples_design_step_stretches_lab_does_not(fte: float, design_end: int) -> None:
    """4 effort weeks from W10: 0.5 FTE -> 8 weeks (W10..W17), 0.63 -> 7
    (W10..W16), 1.0 -> 4 (W10..W13). The 3-week lab step follows at its own
    3 weeks whatever the leader's FTE."""

    si = _two_step_input((_proj(),), (_eng(fte),))
    out = run_greedy_sgs(si)
    o, st = _steps(out, "p1")
    a, f = st["PDD-A"], st["PDD-F"]
    assert (a.start_week, a.end_week) == (10, design_end)
    assert a.duration_weeks == 4  # effort, not elapsed
    assert a.assigned_engineer_id == "eng-1"
    assert (f.start_week, f.end_week) == (design_end + 1, design_end + 3)
    assert f.duration_weeks == 3
    assert o.end_week == design_end + 3
    assert o.unconstrained_end_week == design_end + 3  # stretched too
    assert validate_invariants(si, out) == ()


def test_full_workflow_only_design_steps_stretch() -> None:
    """Default 14-step PDD / A (design A1 B4 D1 E6 I2 J1 K2 M1, lab F4 H6,
    elapsed C4 G2 L3 N1) at 0.5 FTE: every design row spans 2 x its effort,
    every lab and elapsed row spans exactly its effort."""

    si = ScheduleInput(
        projects=(_proj(),),
        engineers=(_eng(0.5),),
        chambers=(ChamberInput("ch-1", "GR-1", "Greece", 5, ("PDD-F", "PDD-H")),),
        current_week=CW,
    )
    out = run_greedy_sgs(si)
    o, st = _steps(out, "p1")
    assert not o.left_out and o.data_error is None
    kinds = {"design": 0, "lab": 0, "elapsed": 0}
    for s in st.values():
        assert not s.skipped
        span = s.end_week - s.start_week + 1
        if s.kind == "design":
            assert span == 2 * s.duration_weeks
        else:
            assert span == s.duration_weeks
        kinds[s.kind] += 1
    assert kinds == {"design": 8, "lab": 2, "elapsed": 4}
    # Critical path 38 effort weeks, 18 of them design, each doubled: 56 weeks
    # from W10 -> W65.
    assert o.end_week == CW + 38 + 18 - 1 == 65
    assert validate_invariants(si, out) == ()


def test_same_leader_serialises_on_elapsed_weeks() -> None:
    """Two P1 projects, one 0.5 FTE leader: the first holds W10..W17, the
    second's design step waits until W18 (one step at a time)."""

    si = _two_step_input((_proj("p1"), _proj("p2")), (_eng(0.5),))
    out = run_greedy_sgs(si)
    _, s1 = _steps(out, "p1")
    _, s2 = _steps(out, "p2")
    assert (s1["PDD-A"].start_week, s1["PDD-A"].end_week) == (10, 17)
    assert (s2["PDD-A"].start_week, s2["PDD-A"].end_week) == (18, 25)
    assert validate_invariants(si, out) == ()


def test_load_counts_effort_not_elapsed_weeks() -> None:
    """I6 sums `duration_weeks`: two 4-week design steps at 0.5 FTE book 16
    elapsed leader weeks but are 8 weeks of load, the same as at 1.0 FTE."""

    half = _two_step_input((_proj("p1"), _proj("p2")), (_eng(0.5),))
    full = _two_step_input((_proj("p1"), _proj("p2")), (_eng(1.0),))
    assert compute_design_load_by_hub(half, run_greedy_sgs(half)) == {"R&D-Greece": 8}
    assert compute_design_load_by_hub(full, run_greedy_sgs(full)) == {"R&D-Greece": 8}


def test_progress_pct_weights_are_effort() -> None:
    plan_kwargs = {
        "step_progress": (StepProgressInput("PDD-A", "In Progress", 50, 8, None, None),),
    }
    si_half = _two_step_input((_proj(**plan_kwargs),), (_eng(0.5),))
    si_full = _two_step_input((_proj(**plan_kwargs),), (_eng(1.0),))
    o_half, _ = _steps(run_greedy_sgs(si_half), "p1")
    o_full, _ = _steps(run_greedy_sgs(si_full), "p1")
    # 50 % of 4 design weeks over 4 + 3 = 7 effort weeks -> round(200 / 7) = 29.
    assert o_half.progress_pct == o_full.progress_pct == 29


# --- 3. FTE 0 and unresolved leaders -------------------------------------------------


@pytest.mark.parametrize("fte", [0.0, -1.0, float("nan")])
def test_fte_zero_leader_is_a_data_error_not_a_crash(fte: float) -> None:
    si = _two_step_input(
        (_proj("p-zero", leader="eng-0"), _proj("p-ok", leader="eng-1")),
        (_eng(fte, "eng-0"), _eng(1.0, "eng-1")),
    )
    out = run_greedy_sgs(si)
    bad, _ = _steps(out, "p-zero")
    ok, ok_steps = _steps(out, "p-ok")
    assert bad.data_error is not None
    assert "FTE" in bad.data_error and "PDD-A" in bad.data_error
    assert bad.steps == () and not bad.within_year and not bad.left_out
    assert bad.projected_end_week is None and bad.unconstrained_end_week is None
    # The other project is untouched and the rejected one booked nothing.
    assert ok.data_error is None and ok_steps["PDD-A"].start_week == CW
    assert validate_invariants(si, out) == ()
    cp_out, _ = run_cp_sat(si, deterministic_time=2.0, earliness_deterministic_time=1.0)
    assert next(o for o in cp_out.project_outcomes if o.project_id == "p-zero").data_error


def test_fte_zero_is_irrelevant_when_no_design_work_is_left() -> None:
    """Design step Done: nothing to place at the leader's speed, so FTE 0 is
    not an error; the lab step schedules normally."""

    p = _proj(step_progress=(StepProgressInput("PDD-A", "Done", 100, 5, 8, None),))
    si = _two_step_input((p,), (_eng(0.0),))
    out = run_greedy_sgs(si)
    o, st = _steps(out, "p1")
    assert o.data_error is None
    assert (st["PDD-A"].start_week, st["PDD-A"].end_week) == (5, 8)
    assert (st["PDD-F"].start_week, st["PDD-F"].end_week) == (10, 12)
    assert validate_invariants(si, out) == ()


def test_unassigned_leader_is_still_no_leader_left_out() -> None:
    si = _two_step_input((_proj(leader="nobody"),), (_eng(0.5),))
    o, _ = _steps(run_greedy_sgs(si), "p1")
    assert o.left_out and o.no_leader and o.data_error is None


# --- 4. Frozen and anchored steps -----------------------------------------------------


def test_frozen_dates_unchanged_by_fte() -> None:
    """A frozen project is never stretched: its outcome at 0.5 FTE is
    identical to its outcome at 1.0 FTE (I10), even at FTE 0."""

    frozen = _proj(frozen=True, actual_start_week=6)
    outs = [run_greedy_sgs(_two_step_input((frozen,), (_eng(f),))) for f in (1.0, 0.5, 0.63, 0.0)]
    assert outs[0] == outs[1] == outs[2] == outs[3]
    _, st = _steps(outs[1], "p1")
    assert (st["PDD-A"].start_week, st["PDD-A"].end_week) == (6, 9)
    for f in (0.5, 0.0):
        si = _two_step_input((frozen,), (_eng(f),))
        assert validate_invariants(si, run_greedy_sgs(si)) == ()


def test_in_progress_tail_stretches_remaining_effort() -> None:
    """PDD-A In Progress from W8, 50 % of 4 -> remaining 2 effort weeks. At
    0.5 FTE the tail is ceil(2 / 0.5) = 4 weeks W10..W13; at 0.63 it is
    ceil(2 / 0.63) = 4; at 1.0 it is 2 (W10..W11). The recorded start (W8) is
    kept."""

    sp = (StepProgressInput("PDD-A", "In Progress", 50, 8, None, None),)
    for fte, end in ((0.5, 13), (0.63, 13), (1.0, 11)):
        si = _two_step_input((_proj(step_progress=sp),), (_eng(fte),))
        out = run_greedy_sgs(si)
        _, st = _steps(out, "p1")
        assert (st["PDD-A"].start_week, st["PDD-A"].end_week) == (8, end), fte
        assert st["PDD-A"].duration_weeks == 4
        assert validate_invariants(si, out) == ()


def test_remaining_override_is_effort_and_stretches() -> None:
    sp = (StepProgressInput("PDD-A", "In Progress", 10, 8, None, 3),)
    si = _two_step_input((_proj(step_progress=sp),), (_eng(0.5),))
    _, st = _steps(run_greedy_sgs(si), "p1")
    assert (st["PDD-A"].start_week, st["PDD-A"].end_week) == (8, 15)  # 3 / 0.5 = 6 wk from W10


def test_done_steps_keep_their_recorded_weeks() -> None:
    sp = (StepProgressInput("PDD-A", "Done", 100, 3, 9, None),)
    si = _two_step_input((_proj(step_progress=sp),), (_eng(0.5),))
    out = run_greedy_sgs(si)
    _, st = _steps(out, "p1")
    assert (st["PDD-A"].start_week, st["PDD-A"].end_week) == (3, 9)
    assert validate_invariants(si, out) == ()


# --- 5. Invariants, determinism, solver agreement -----------------------------------


def test_invariants_hold_on_the_seed_with_mixed_fte() -> None:
    """The 46-project prototype seed has FTE 1.0 x 9, 0.8 x 2 and 0.5 x 3."""

    si = load_seed_schedule_input()
    ftes = sorted({e.fte for e in si.engineers})
    assert ftes == [0.5, 0.8, 1]
    out = run_greedy_sgs(si)
    assert validate_invariants(si, out) == ()
    # Every design row of a non-frozen project spans ceil(effort / fte).
    fte_of = {e.engineer_id: e.fte for e in si.engineers}
    frozen = {p.project_id for p in si.projects if p.frozen}
    checked = 0
    for o in out.project_outcomes:
        if o.project_id in frozen:
            continue
        for s in o.steps:
            if s.kind == "design" and not s.skipped and s.assigned_engineer_id:
                span = s.end_week - s.start_week + 1
                assert span == fte_span(s.duration_weeks, fte_of[s.assigned_engineer_id])
                checked += 1
    assert checked > 50


def test_i21_catches_an_unstretched_design_row() -> None:
    si = _two_step_input((_proj(),), (_eng(0.5),))
    out = run_greedy_sgs(si)
    o, st = _steps(out, "p1")
    a = st["PDD-A"]
    broken_a = dataclasses.replace(a, end_week=a.start_week + 3)  # 4 weeks, should be 8
    broken = dataclasses.replace(
        out,
        project_outcomes=(dataclasses.replace(o, steps=(broken_a, st["PDD-F"])),),
    )
    found = {v.invariant for v in validate_invariants(si, broken, check_determinism=False)}
    assert "I21" in found


def test_rerun_is_byte_identical() -> None:
    si = load_seed_schedule_input()
    assert repr(run_greedy_sgs(si)) == repr(run_greedy_sgs(si))


def test_greedy_and_cp_sat_agree_on_durations_and_spans() -> None:
    si = _two_step_input(
        (_proj("p1"), _proj("p2", priority="P2"), _proj("p3", leader="eng-2", category="B")),
        (_eng(0.5), _eng(0.63, "eng-2")),
    )
    g = run_greedy_sgs(si)
    c, info = run_cp_sat(si, deterministic_time=5.0, earliness_deterministic_time=2.0)
    assert info.status_name in ("OPTIMAL", "FEASIBLE")
    assert validate_invariants(si, c, check_determinism=False) == ()
    for go, co in zip(g.project_outcomes, c.project_outcomes, strict=True):
        assert go.project_id == co.project_id
        assert go.unconstrained_end_week == co.unconstrained_end_week
        gs = {s.step_id: s for s in go.steps}
        cs = {s.step_id: s for s in co.steps}
        assert gs.keys() == cs.keys()
        for sid in gs:
            assert gs[sid].duration_weeks == cs[sid].duration_weeks
            assert (gs[sid].end_week - gs[sid].start_week) == (
                cs[sid].end_week - cs[sid].start_week
            )


def test_cp_sat_books_stretched_spans() -> None:
    si = _two_step_input((_proj(),), (_eng(0.5),))
    c, _ = run_cp_sat(si, deterministic_time=2.0, earliness_deterministic_time=1.0)
    _, st = _steps(c, "p1")
    assert (st["PDD-A"].start_week, st["PDD-A"].end_week) == (10, 17)
    assert (st["PDD-F"].start_week, st["PDD-F"].end_week) == (18, 20)


def test_unconstrained_walk_matches_plan_spans() -> None:
    wfs = build_workflows(TEMPLATE)
    table = build_lead_time_table(LEAD_4_3)
    p = _proj()
    plan_half = analyse_project(p, wfs["PDD"], table, leader_fte=0.5)
    plan_none = analyse_project(p, wfs["PDD"], table)
    assert plan_half.steps["PDD-A"].span == 8 and plan_half.steps["PDD-A"].duration == 4
    assert plan_half.steps["PDD-F"].span == 3
    assert plan_none.steps["PDD-A"].span == 4  # no leader FTE given: effort only
    assert unconstrained_end_week(plan_half, CW) == 20
    assert unconstrained_end_week(plan_none, CW) == 16


# --- 6. What-if engine -----------------------------------------------------------------


def _half_fte_portfolio():  # type: ignore[no-untyped-def]
    base = portfolio_baseline()
    engs = tuple(
        dataclasses.replace(e, fte=0.5 if i % 2 == 0 else 0.8)
        for i, e in enumerate(base.schedule.engineers)
    )
    return dataclasses.replace(base, schedule=dataclasses.replace(base.schedule, engineers=engs))


def test_whatif_zero_scenario_equals_baseline_with_fractional_fte() -> None:
    base = _half_fte_portfolio()
    res = simulate(base, Scenario())
    assert res.diff.within_year_delta == 0
    assert res.diff.newly_slipping == () and res.diff.recovered == () and res.diff.moved == ()
    assert res.outcome_counts_before == res.outcome_counts_after
    assert res.utilization_before == res.utilization_after
    assert run_greedy_sgs(build_scenario_input(base, Scenario())) == run_greedy_sgs(base.schedule)
    # Estimate "before" load == the run's I6 sum (effort weeks), as Capacity.
    est = analytic_requirements(base, Scenario())
    run_load = compute_design_load_by_hub(base.schedule, run_greedy_sgs(base.schedule))
    for row in est.design:
        assert row.baseline_load_weeks == pytest.approx(float(run_load.get(row.hub, 0)))
        assert row.extra_design_weeks == 0


def test_whatif_added_designer_carries_fte() -> None:
    """One new PDD / C project (design A1 D1 E2 J1 K1) led by a new 0.5 FTE
    designer (the least-loaded pick): every design row spans 2 x effort."""

    base = _half_fte_portfolio()
    sc = Scenario(
        add_projects=(AddProject("R&D-Greece", "C", priority="P1"),),
        add_engineers=(AddEngineer("R&D-Greece", fte=0.5),),
    )
    si = build_scenario_input(base, sc)
    new = next(p for p in si.projects if p.project_id.startswith("whatif-p"))
    assert new.leader_engineer_id == "whatif-eng-001"
    out = run_greedy_sgs(si)
    o = next(o for o in out.project_outcomes if o.project_id == new.project_id)
    design = [s for s in o.steps if s.kind == "design" and not s.skipped]
    assert design and all(s.end_week - s.start_week + 1 == 2 * s.duration_weeks for s in design)
    assert validate_invariants(si, out, check_determinism=False) == ()


def test_whatif_never_picks_a_zero_fte_leader() -> None:
    base = portfolio_baseline()
    engs = tuple(
        dataclasses.replace(e, fte=0.0) if e.engineer_id == "eng-R&D-Greece-0" else e
        for e in base.schedule.engineers
    )
    base = dataclasses.replace(base, schedule=dataclasses.replace(base.schedule, engineers=engs))
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "C", count=3),))
    si = build_scenario_input(base, sc)  # must not divide by zero
    leaders = {p.leader_engineer_id for p in si.projects if p.project_id.startswith("whatif-p")}
    assert "eng-R&D-Greece-0" not in leaders


def test_whatif_unattainable_is_judged_at_the_fastest_designer_speed() -> None:
    """At W31 a PDD / B project (critical path 18 effort weeks, design A1 D1
    E4 J1 K2 M1) ends W48 at 1.0 FTE: attainable, because an added 1.0 FTE
    designer can lead it, even though the hub's own designers are 0.5 / 0.8.
    If the solver may only add 0.5 FTE designers, the fastest is the hub's 0.8:
    spans 2 2 5 2 3 2 = 16 vs 10 effort -> 24 weeks from W31 = W54 > W52, so
    the project is reported unattainable and not searched for."""

    base = _half_fte_portfolio()
    sc = Scenario(add_projects=(AddProject("R&D-Greece", "B", priority="P1"),))
    r = solve_minimum_additions(base, sc, "all_new_within_year")
    assert r.unattainable_project_ids == ()
    r_slow = solve_minimum_additions(base, sc, "all_new_within_year", designer_fte=0.5)
    assert r_slow.unattainable_project_ids == ("whatif-p001-001",)
    assert r_slow.met_attainable and not r_slow.met
