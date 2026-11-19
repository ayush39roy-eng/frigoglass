"""P53-R01 (F53-1, I58 / I9): the What-if engine result carries the live run's
not-placed diagnostics, so an empty scenario serves the same `left_out_reason`
per project as the Dashboard (`beyond_horizon` only when no data reason
applies). Also the I60 advisory: the CP-SAT pre-model walk set is exactly
frozen ∪ needs-greedy ∪ no_leader ∪ data_error.
"""

from __future__ import annotations

import dataclasses

from scheduling import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    check_i60_cp_sat_tail,
    run_cp_sat,
    run_greedy_sgs,
)
from scheduling._selftest_common import load_seed_schedule_input
from scheduling.delivery import outcome_left_out_reason
from scheduling.whatif import (
    HubCalendarInput,
    Scenario,
    WhatIfBaseline,
    simulate,
    to_jsonable,
)
from tests.scheduling._fixtures import (
    CHAMBER_GR1,
    CHAMBER_GR2,
    ENGINEER_A,
    LEAD_TIMES,
    TEMPLATE,
    base_project,
)

CP_KW: dict[str, float] = {"deterministic_time": 3.0, "earliness_deterministic_time": 1.0}
ENGINEER_ZERO = EngineerInput("eng-z", "Engineer Z", "R&D-Greece", ("A+", "A", "B", "C"), fte=0.0)
INDIA_CHAMBER = ChamberInput(
    "ch-in1", "IN-CH1", "India", max_concurrent=1, allowed_stages=("PDD-F",)
)


def _si(*projects: ProjectInput, chambers: tuple[ChamberInput, ...] | None = None) -> ScheduleInput:
    return ScheduleInput(
        projects=projects,
        engineers=(ENGINEER_A, ENGINEER_ZERO),
        chambers=chambers if chambers is not None else (CHAMBER_GR1, CHAMBER_GR2),
        workflow_steps=TEMPLATE,
        lead_times=LEAD_TIMES,
        current_week=47,
    )


def _mixed() -> ScheduleInput:
    """One project per reason: placed, no_leader, data_error (leader FTE 0),
    and a beyond_horizon one is covered by `_full_leader` below."""

    return _si(
        base_project(project_id="ok", name="Ok"),
        base_project(project_id="nolead", name="No leader", leader_engineer_id="ghost"),
        base_project(project_id="zero", name="FTE zero", leader_engineer_id="eng-z"),
    )


def _baseline(si: ScheduleInput) -> WhatIfBaseline:
    return WhatIfBaseline(schedule=si, calendars=(HubCalendarInput("R&D-Greece", 5, 10, 0, 0, 0),))


def _assert_same_reasons(si: ScheduleInput) -> dict[str, str | None]:
    live = {o.project_id: o for o in run_greedy_sgs(si).project_outcomes}
    res = simulate(_baseline(si), Scenario())
    got: dict[str, str | None] = {}
    for p in res.projects:
        o = live[p.project_id]
        assert p.left_out == o.left_out
        assert p.no_leader == o.no_leader
        assert p.no_chamber_step_id == o.no_chamber_step_id
        assert p.data_error == o.data_error
        assert p.left_out_reason == outcome_left_out_reason(o)
        got[p.project_id] = p.left_out_reason
    assert set(got) == set(live)
    return got


def test_empty_scenario_serves_the_live_reason_for_no_leader_and_data_error() -> None:
    got = _assert_same_reasons(_mixed())
    assert got == {"ok": None, "nolead": "no_leader", "zero": "data_error"}


def test_empty_scenario_serves_no_chamber() -> None:
    si = _si(base_project(project_id="noch", name="No chamber"), chambers=(INDIA_CHAMBER,))
    assert _assert_same_reasons(si) == {"noch": "no_chamber"}


def test_beyond_horizon_only_without_a_data_reason() -> None:
    # One Greece chamber slot, H tiny: the second project cannot fit -> LEFT_OUT
    # with no diagnostic -> beyond_horizon (the only case it is served).
    si = dataclasses.replace(
        _si(
            *(base_project(project_id=f"p{i}", name=f"P{i}") for i in range(6)),
            base_project(project_id="nolead", name="No leader", leader_engineer_id="ghost"),
            chambers=(CHAMBER_GR1,),
        ),
        horizon_weeks=60,
    )
    got = _assert_same_reasons(si)
    assert got["nolead"] == "no_leader"
    assert "beyond_horizon" in got.values()
    live = {o.project_id: o for o in run_greedy_sgs(si).project_outcomes}
    for pid, reason in got.items():
        if reason == "beyond_horizon":
            o = live[pid]
            assert not o.no_leader and o.no_chamber_step_id is None and o.data_error is None


def test_empty_scenario_reasons_equal_live_on_the_seed() -> None:
    seed = load_seed_schedule_input()
    _assert_same_reasons(seed)


def test_added_fields_do_not_change_placements_or_other_fields() -> None:
    si = _mixed()
    res = to_jsonable(simulate(_baseline(si), Scenario()))
    added = {"left_out", "no_leader", "no_chamber_step_id", "data_error", "left_out_reason"}
    assert isinstance(res, dict)
    live = {o.project_id: o for o in run_greedy_sgs(si).project_outcomes}
    for p in res["projects"]:
        assert added <= set(p)
        o = live[p["project_id"]]
        assert p["finish_week"] == o.projected_end_week
        assert p["within_year"] == o.within_year
    # Deterministic (I8).
    assert to_jsonable(simulate(_baseline(si), Scenario())) == res


# =====================================================================================
# I60 advisory: the pre-model walk set
# =====================================================================================


def test_i60_pre_model_set_is_frozen_needs_greedy_no_leader_data_error() -> None:
    si = _si(
        base_project(project_id="ok", name="Ok"),
        base_project(project_id="nolead", name="No leader", leader_engineer_id="ghost"),
        base_project(project_id="zero", name="FTE zero", leader_engineer_id="eng-z"),
        base_project(project_id="frz", name="Frozen", frozen=True, actual_start_week=40),
    )
    out, info = run_cp_sat(si, **CP_KW)
    assert set(info.pre_model_project_ids) == {"nolead", "zero", "frz"}
    assert info.pre_model_project_ids[0] == "frz"  # frozen walked first
    assert check_i60_cp_sat_tail(si, out, info) == ()
    # Forged: a project dropped from / added to the pre-model set is flagged.
    for bad in (
        tuple(p for p in info.pre_model_project_ids if p != "nolead"),
        (*info.pre_model_project_ids, "ok"),
    ):
        forged = dataclasses.replace(info, pre_model_project_ids=bad)
        assert {v.invariant for v in check_i60_cp_sat_tail(si, out, forged)} == {"I60"}


def test_i60_pre_model_set_on_the_seed() -> None:
    seed = load_seed_schedule_input()
    out, info = run_cp_sat(seed, **CP_KW)
    assert check_i60_cp_sat_tail(seed, out, info) == ()
    assert not set(info.pre_model_project_ids) & set(info.model_project_ids)
    frozen = {p.project_id for p in seed.projects if p.frozen}
    assert frozen <= set(info.pre_model_project_ids)
