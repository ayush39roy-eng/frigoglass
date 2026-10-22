"""ADR 0040 — a VIP project schedules before every non-VIP one.

DOMAIN_RULES "Scheduling order" (amended 2026-10-22): (1) `frozen` desc,
(2) `is_vip` desc, (3) priority P1 -> Q, (4) status, (5) category, then the
`project_id` tiebreak. The CP-SAT objective gains the matching VIP tier
(`cp_sat.objective_weights`). `ProjectInput.is_vip` defaults to `False`, so
every pre-ADR-0040 fixture and golden file is unchanged (asserted below too).

Fixture arithmetic (tests/scheduling/_fixtures.py TEMPLATE / LEAD_TIMES):
PDD-A design 2 weeks on the leader -> PDD-F lab 3 weeks on a chamber.
Pure, in-process; no DB.
"""

from __future__ import annotations

import dataclasses

from scheduling import (
    ProjectInput,
    ScheduleInput,
    run_cp_sat,
    run_greedy_sgs,
    validate_invariants,
)
from scheduling._selftest_common import load_seed_schedule_input
from scheduling.cp_sat import PRIORITY_OBJECTIVE_WEIGHT, objective_weights
from scheduling.greedy import _sort_key
from tests.scheduling._fixtures import (
    CHAMBER_GR1,
    ENGINEER_A,
    ENGINEER_B,
    LEAD_TIMES,
    TEMPLATE,
    base_project,
)


def _by_id(out):
    return {o.project_id: o for o in out.project_outcomes}


def _step(outcome, step_id: str):
    return next(s for s in outcome.steps if s.step_id == step_id)


def _input(*projects: ProjectInput, **kw) -> ScheduleInput:
    return ScheduleInput(
        projects=projects,
        engineers=(ENGINEER_A, ENGINEER_B),
        chambers=(CHAMBER_GR1,),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_TIMES,
        **kw,
    )


def test_is_vip_defaults_false():
    assert base_project().is_vip is False
    assert ProjectInput.__dataclass_fields__["is_vip"].default is False


def test_sort_key_vip_between_frozen_and_priority():
    frozen_p4 = base_project(project_id="a", priority="P4", frozen=True, actual_start_week=1)
    vip_p4 = base_project(project_id="b", priority="P4", is_vip=True)
    vip_p2 = base_project(project_id="c", priority="P2", is_vip=True)
    p1 = base_project(project_id="d", priority="P1")
    order = [p.project_id for p in sorted([p1, vip_p4, vip_p2, frozen_p4], key=_sort_key)]
    assert order == ["a", "c", "b", "d"]


def test_vip_p4_beats_non_vip_p1_on_shared_leader():
    """Both projects are led by eng-a. Without VIP the P1 project books eng-a
    first; with the P4 project pinned VIP it books first and P1 waits."""

    p1 = base_project(project_id="p-p1", name="P1", priority="P1")
    p4 = base_project(project_id="p-p4", name="P4", priority="P4")

    base_si = _input(p1, p4)
    base_out = run_greedy_sgs(base_si)
    assert base_out.scheduling_order == ("p-p1", "p-p4")
    b = _by_id(base_out)
    assert _step(b["p-p1"], "PDD-A").start_week < _step(b["p-p4"], "PDD-A").start_week

    vip_si = _input(p1, dataclasses.replace(p4, is_vip=True))
    vip_out = run_greedy_sgs(vip_si)
    assert vip_out.scheduling_order == ("p-p4", "p-p1")
    v = _by_id(vip_out)
    vip_design = _step(v["p-p4"], "PDD-A")
    p1_design = _step(v["p-p1"], "PDD-A")
    assert vip_design.start_week == _step(b["p-p1"], "PDD-A").start_week
    assert p1_design.start_week > vip_design.end_week
    assert not v["p-p1"].eng_conflict and not v["p-p4"].eng_conflict
    assert validate_invariants(vip_si, vip_out) == ()


def test_vip_p4_beats_non_vip_p1_on_shared_chamber():
    """Different leaders, one chamber (max_concurrent=1): the VIP P4 project's
    lab step gets the chamber first."""

    p1 = base_project(project_id="p-p1", name="P1", priority="P1", leader_engineer_id="eng-a")
    p4 = base_project(
        project_id="p-p4", name="P4", priority="P4", leader_engineer_id="eng-b", is_vip=True
    )
    si = _input(p1, p4)
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("p-p4", "p-p1")
    o = _by_id(out)
    vip_lab = _step(o["p-p4"], "PDD-F")
    p1_lab = _step(o["p-p1"], "PDD-F")
    assert vip_lab.assigned_chamber_id == p1_lab.assigned_chamber_id == "ch-gr1"
    assert p1_lab.start_week > vip_lab.end_week
    assert not o["p-p1"].overlap and not o["p-p4"].overlap
    assert validate_invariants(si, out) == ()


def test_frozen_still_beats_vip():
    """A frozen non-VIP P4 project keeps its locked dates; a VIP P1 project on
    the same leader routes around it."""

    frozen = base_project(
        project_id="p-frozen",
        name="Frozen",
        priority="P4",
        frozen=True,
        actual_start_week=10,
    )
    vip = base_project(project_id="p-vip", name="VIP", priority="P1", is_vip=True)
    si = _input(frozen, vip, current_week=10)
    out = run_greedy_sgs(si)
    assert out.scheduling_order == ("p-frozen", "p-vip")
    o = _by_id(out)
    f_design = _step(o["p-frozen"], "PDD-A")
    v_design = _step(o["p-vip"], "PDD-A")
    assert f_design.start_week == 10
    assert v_design.start_week > f_design.end_week
    assert validate_invariants(si, out) == ()


def test_no_vip_is_byte_identical_on_seed():
    """Explicit `is_vip=False` on every project gives exactly the default
    output (the golden-file suite covers the default path itself)."""

    si = load_seed_schedule_input()
    explicit = dataclasses.replace(
        si, projects=tuple(dataclasses.replace(p, is_vip=False) for p in si.projects)
    )
    assert repr(run_greedy_sgs(si)) == repr(run_greedy_sgs(explicit))


def test_seed_with_vip_validates_invariants():
    """Pinning a low-priority seed project still yields an I1-I10-clean
    schedule, and that project moves to the front of the non-frozen order."""

    si = load_seed_schedule_input()
    base = run_greedy_sgs(si)
    non_frozen = [pid for pid in base.scheduling_order if not _frozen(si, pid)]
    target = non_frozen[-1]
    vip_si = dataclasses.replace(
        si,
        projects=tuple(
            dataclasses.replace(p, is_vip=True) if p.project_id == target else p
            for p in si.projects
        ),
    )
    out = run_greedy_sgs(vip_si)
    n_frozen = len(base.scheduling_order) - len(non_frozen)
    assert out.scheduling_order[n_frozen] == target
    assert validate_invariants(vip_si, out) == ()


def _frozen(si: ScheduleInput, pid: str) -> bool:
    return next(p for p in si.projects if p.project_id == pid).frozen


# --- CP-SAT ----------------------------------------------------------------


def test_objective_weights_plain_bands_without_vip():
    projects = [
        base_project(project_id=f"p{i}", priority=b)
        for i, b in enumerate(("P1", "P2", "P3", "P4", "Q"))
    ]
    w = objective_weights(projects)
    assert w == {p.project_id: PRIORITY_OBJECTIVE_WEIGHT[p.priority] for p in projects}


def test_objective_weights_vip_tier_dominates():
    projects = [
        base_project(project_id="a", priority="P1"),
        base_project(project_id="b", priority="P1"),
        base_project(project_id="c", priority="Q", is_vip=True),
        base_project(project_id="d", priority="P4", is_vip=True),
    ]
    w = objective_weights(projects)
    assert w["c"] > w["a"] + w["b"]
    assert w["d"] > w["c"]  # band still orders VIP projects among themselves


def test_cp_sat_prefers_vip_p4_within_year():
    """Two projects on eng-a; only the first one placed can finish by the
    within-year week (design 2 + lab 3 = 5 weeks; the second ends 2 weeks
    later). CP-SAT puts the P1 project in the year without VIP and the VIP P4
    project in the year when it is pinned."""

    cw = 10
    p1 = base_project(project_id="p-p1", name="P1", priority="P1")
    p4 = base_project(project_id="p-p4", name="P4", priority="P4")
    kw = dict(current_week=cw, within_year_week=cw + 5)

    base_si = _input(p1, p4, **kw)
    base_out, _ = run_cp_sat(base_si, deterministic_time=2.0, earliness_deterministic_time=1.0)
    b = _by_id(base_out)
    assert b["p-p1"].within_year and not b["p-p4"].within_year

    vip_si = _input(p1, dataclasses.replace(p4, is_vip=True), **kw)
    vip_out, info = run_cp_sat(vip_si, deterministic_time=2.0, earliness_deterministic_time=1.0)
    v = _by_id(vip_out)
    assert v["p-p4"].within_year and not v["p-p1"].within_year
    assert vip_out.scheduling_order == ("p-p4", "p-p1")
    assert info.objective_value == objective_weights(vip_si.projects)["p-p4"]
    assert validate_invariants(vip_si, vip_out, check_determinism=False) == ()
